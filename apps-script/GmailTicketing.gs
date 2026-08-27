/**
 * Project Tracker — Gmail capture + watched thread processing.
 *
 * The Gmail add-on calls this module to create tickets or append email notes.
 * Watched threads are polled by a per-user installable trigger so each mailbox
 * is read only under the account that explicitly enabled watching.
 */
const GmailTicketing = (function () {

  const EMAIL_ENRICH_QUEUE_PREFIX = 'PROJECT_TRACKER_GMAIL_ENRICH_V1_';

  function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

  function timing_(startedAt, label) {
    try { Logger.log('Gmail capture timing · %s · %sms', label, Date.now() - startedAt); } catch (ignore) {}
  }

  function mailboxUser_() {
    const effective = String(Session.getEffectiveUser().getEmail() || '').trim();
    const active = String(Session.getActiveUser().getEmail() || '').trim();
    return (effective || active || Repo.me()).toLowerCase();
  }

  function requireAgent_() {
    const user = Repo.requireAccess('agent');
    return { email: String(user.email || mailboxUser_()).toLowerCase(), role: user.role };
  }

  function publicWatch_(r) {
    return {
      watch_id: r.watch_id,
      ticket_id: r.ticket_id,
      thread_id: r.thread_id,
      thread_url: r.thread_url,
      subject: r.subject,
      mailbox_user: r.mailbox_user,
      active: bool_(r.active),
      last_message_id: r.last_message_id,
      last_message_at: r.last_message_at,
      last_message_count: Number(r.last_message_count) || 0,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }

  function listWatches(ticketId, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('agent');
    const rows = opts.fast && Repo.findAllFast
      ? Repo.findAllFast(TABS.EMAIL_WATCHES, 'ticket_id', ticketId)
      : Repo.findAll(TABS.EMAIL_WATCHES, 'ticket_id', ticketId);
    return rows
      .filter(function (r) { return bool_(r.active); })
      .sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); })
      .map(publicWatch_);
  }

  function findThreadWatch_(ticketId, threadId, mailbox) {
    const finder = Repo.findAllFast || Repo.findAll;
    return finder(TABS.EMAIL_WATCHES, 'ticket_id', ticketId).filter(function (r) {
      return String(r.thread_id) === String(threadId) &&
        String(r.mailbox_user || '').toLowerCase() === String(mailbox || '').toLowerCase();
    })[0] || null;
  }

  function activeMailboxWatches_(mailbox) {
    mailbox = String(mailbox || mailboxUser_()).toLowerCase();
    return Repo.readAll(TABS.EMAIL_WATCHES).filter(function (r) {
      return bool_(r.active) && String(r.mailbox_user || '').toLowerCase() === mailbox;
    });
  }

  function ensureWatch_(ticketId, thread, messages, options) {
    options = options || {};
    const user = options.skipAccessValidation
      ? { email: String(Repo.me() || mailboxUser_()).toLowerCase(), role: 'agent' }
      : requireAgent_();
    messages = Array.isArray(messages) ? messages : thread.getMessages();
    const last = messages[messages.length - 1];
    const existing = findThreadWatch_(ticketId, thread.getId(), user.email);
    const now = Repo.now();
    const patch = {
      thread_url: safeThreadPermalink_(thread),
      subject: thread.getFirstMessageSubject() || '(no subject)',
      mailbox_user: user.email,
      active: true,
      last_message_id: last ? last.getId() : '',
      last_message_at: last ? last.getDate().toISOString() : now,
      last_message_count: messages.length,
      updated_at: now
    };

    let row;
    if (existing) {
      row = Repo.update(TABS.EMAIL_WATCHES, 'watch_id', existing.watch_id, patch);
    } else {
      row = Object.assign({
        watch_id: Utilities.getUuid(),
        ticket_id: ticketId,
        thread_id: thread.getId(),
        created_by: user.email,
        created_at: now
      }, patch);
      Repo.append(TABS.EMAIL_WATCHES, row);
    }
    ensureWatchTrigger_();
    return publicWatch_(row);
  }

  function stopWatch(watchId) {
    const user = requireAgent_();
    const row = Repo.findOne(TABS.EMAIL_WATCHES, 'watch_id', watchId);
    if (!row) throw new Error('Email watch not found.');
    if (String(row.mailbox_user || '').toLowerCase() !== user.email) {
      throw new Error('Only the Gmail user who started this watch can stop it.');
    }
    Repo.update(TABS.EMAIL_WATCHES, 'watch_id', watchId, { active: false, updated_at: Repo.now() });
    cleanupWatchTrigger_();
    return { ok: true };
  }

  function ensureWatchTrigger_() {
    // Gmail watches and Chat completion callbacks share one add-on-owned
    // hourly trigger. Creating a second add-on time trigger can hit Google's
    // per-user/add-on trigger restriction.
    return ensureProjectTrackerHourlyTrigger_();
  }

  function cleanupWatchTrigger_() {
    const mailbox = mailboxUser_();
    if (activeMailboxWatches_(mailbox).length) return;
    if (hasPendingEmailEnrichments_()) return;
    if (projectTrackerHasChatCompletionWorkForCurrentUser_()) return;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      const h = t.getHandlerFunction();
      if (h === 'processWatchedEmailThreads' || h === 'processProjectTrackerChatCompletions' || h === 'processProjectTrackerHourlyJobs') {
        ScriptApp.deleteTrigger(t);
      }
    });
  }

  function emailEnrichQueueKey_(activityId) {
    return EMAIL_ENRICH_QUEUE_PREFIX + String(activityId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function hasPendingEmailEnrichments_() {
    try {
      const props = PropertiesService.getUserProperties().getProperties() || {};
      return Object.keys(props).some(function (key) { return key.indexOf(EMAIL_ENRICH_QUEUE_PREFIX) === 0; });
    } catch (e) {
      return false;
    }
  }

  function queueEmailEnrichment_(ticketId, activityId) {
    ticketId = String(ticketId || '').trim();
    activityId = String(activityId || '').trim();
    if (!ticketId || !activityId) return { queued: false };
    const row = { ticket_id: ticketId, activity_id: activityId, queued_at: Repo.now() };
    PropertiesService.getUserProperties().setProperty(emailEnrichQueueKey_(activityId), JSON.stringify(row));
    // Reuse the existing unified Gmail/Chat worker. Add-ons may only install
    // relatively infrequent time triggers, so dashboard opens also opportunistically
    // drain this queue below.
    try { ensureProjectTrackerHourlyTrigger_(); } catch (ignore) {}
    return { queued: true, activity_id: activityId };
  }

  function pendingEmailEnrichments_(ticketId) {
    const props = PropertiesService.getUserProperties().getProperties() || {};
    const out = [];
    Object.keys(props).forEach(function (key) {
      if (key.indexOf(EMAIL_ENRICH_QUEUE_PREFIX) !== 0) return;
      try {
        const row = JSON.parse(props[key] || '{}') || {};
        if (!row.ticket_id || !row.activity_id) return;
        if (ticketId && String(row.ticket_id) !== String(ticketId)) return;
        row._key = key;
        out.push(row);
      } catch (ignore) {}
    });
    return out.sort(function (a, b) { return String(a.queued_at || '').localeCompare(String(b.queued_at || '')); });
  }

  function processPendingEnrichments_(limit, ticketId, context) {
    context = context || {};
    limit = Math.max(1, Math.min(25, Number(limit) || 10));
    if (!context.skipAccessValidation) requireAgent_();
    const jobs = pendingEmailEnrichments_(ticketId).slice(0, limit);
    if (!jobs.length) return { checked: 0, processed: 0, errors: [] };

    const props = PropertiesService.getUserProperties();
    const findOne = Repo.findOneFast || Repo.findOne;
    const activityById = {};
    (context.activityRows || []).forEach(function (row) {
      if (row && row.activity_id) activityById[String(row.activity_id)] = row;
    });
    let processed = 0;
    const errors = [];

    jobs.forEach(function (job) {
      try {
        let entry = activityById[String(job.activity_id)] || null;
        if (!entry) entry = findOne(TABS.ACTIVITY, 'activity_id', job.activity_id);
        if (!entry || String(entry.ticket_id) !== String(job.ticket_id) ||
            entry.deleted === true || entry.deleted === 'TRUE') {
          props.deleteProperty(job._key);
          return;
        }

        const text = String(entry.body || '');
        const enrichment = enrichEmail_(job.ticket_id, [], text, {
          fast: true, skipAccessValidation: true, skipTicketValidation: true
        });
        decorateEmailNote_(job.ticket_id, entry, enrichment.studentRefs || [], { fast: true });
        props.deleteProperty(job._key);
        processed++;
      } catch (e) {
        errors.push({ ticket_id: job.ticket_id, activity_id: job.activity_id, message: e.message });
      }
    });

    try { cleanupWatchTrigger_(); } catch (ignore) {}
    return { checked: jobs.length, processed: processed, errors: errors };
  }

  function safeThreadPermalink_(thread) {
    try { return thread.getPermalink() || ''; }
    catch (e) { return ''; }
  }

  function forwardedBoundaryIndex_(text) {
    text = String(text || '');
    const patterns = [
      /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
      /^\s*Begin forwarded message:\s*$/im,
      /^\s*Forwarded message:\s*$/im
    ];
    let at = -1;
    patterns.forEach(function (re) {
      const m = re.exec(text);
      if (m && (at < 0 || m.index < at)) at = m.index;
    });
    return at;
  }

  function stripPlainQuotedHistory_(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    // A manually-forwarded email is content the user intentionally chose to log,
    // not stale reply history. Gmail's forwarded block contains From/Date/Subject
    // lines that look exactly like our normal quoted-history markers, so never use
    // a marker that occurs after the forwarded-message boundary as a trim point.
    const forwardAt = forwardedBoundaryIndex_(text);
    const markers = [
      /^On .+ wrote:\s*$/im,
      /^-----Original Message-----\s*$/im,
      /^_{8,}\s*$/im,
      /^From:\s.+\nSent:\s.+\nTo:\s.+/im,
      /^From:\s.+\nDate:\s.+\nSubject:\s.+/im
    ];
    let cut = -1;
    markers.forEach(function (re) {
      const m = re.exec(text);
      if (!m || m.index <= 0) return;
      if (forwardAt >= 0 && m.index > forwardAt) return;
      if (cut < 0 || m.index < cut) cut = m.index;
    });
    if (cut >= 0) text = text.substring(0, cut);
    const lines = text.split('\n');
    while (lines.length && /^\s*>/.test(lines[lines.length - 1])) lines.pop();
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function decodeHtmlEntities_(value) {
    return String(value || '')
      .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
        const n = parseInt(hex, 16);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&#(\d+);/g, function (_, dec) {
        const n = parseInt(dec, 10);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }

  function htmlTextFragment_(html) {
    return decodeHtmlEntities_(String(html || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
  }

  function safeEmailHref_(href) {
    href = decodeHtmlEntities_(String(href || '').trim());
    if (/^https?:\/\//i.test(href)) return href;
    if (/^mailto:/i.test(href)) return href.substring(7).split('?')[0];
    return '';
  }

  function forwardedHtmlMarkup_(html) {
    let value = String(html || '');
    if (!value) return '';

    // Gmail HTML is untrusted external content. Convert it into Project Tracker's
    // tiny data-markup language rather than storing/rendering raw HTML.
    value = value
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');

    // Preserve useful links as visible text plus the destination. This avoids
    // allowing arbitrary HTML while keeping CTA and reference URLs usable.
    value = value.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      function (_, href, inner) {
        const label = htmlTextFragment_(inner);
        const url = safeEmailHref_(href);
        if (!url) return label;
        if (!label || label === url) return url;
        return label + ' (' + url + ')';
      });

    // Images embedded as Gmail attachments are still uploaded separately by
    // emailFilePayloads_. For remote marketing images, retain useful alt text.
    value = value.replace(/<img\b([^>]*)>/gi, function (_, attrs) {
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs || '');
      const text = alt ? decodeHtmlEntities_(alt[1]).trim() : '';
      return text ? '\n[Image: ' + text + ']\n' : '\n';
    });

    // Convert the formatting Project Tracker already understands.
    value = value
      .replace(/<(strong|b)\b[^>]*>/gi, '[b]')
      .replace(/<\/(strong|b)>/gi, '[/b]')
      .replace(/<(em|i)\b[^>]*>/gi, '[i]')
      .replace(/<\/(em|i)>/gi, '[/i]')
      .replace(/<u\b[^>]*>/gi, '[u]')
      .replace(/<\/u>/gi, '[/u]')
      .replace(/<h[1-6]\b[^>]*>/gi, '\n[b]')
      .replace(/<\/h[1-6]>/gi, '[/b]\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|tr|table|section|article|header|footer|blockquote)>/gi, '\n')
      .replace(/<(p|div|tr|table|section|article|header|footer|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');

    value = decodeHtmlEntities_(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    // Avoid persisting malformed formatting tokens if an unusually large HTML
    // newsletter would exceed the rich-note limit. The plain body is still saved.
    if (value.length > 88000) return '';
    return value;
  }

  function emailAddressName_(value) {
    value = String(value || '').trim();
    const m = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
    return m ? m[1].trim() : '';
  }

  function signatureLine_(line) {
    return String(line || '')
      .replace(/\[(?:\/?b|\/?i|\/?u)\]/gi, '')
      .replace(/^[\s*_~]+|[\s*_~]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripSignatureSegment_(text, from) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !signatureLine_(lines[lines.length - 1])) lines.pop();
    if (lines.length < 2) return lines.join('\n').trim();

    let cut = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = signatureLine_(lines[i]);
      if (/^--\s*$/.test(line) || /^Sent from my (?:iPhone|iPad|Android|mobile device)/i.test(line)) {
        cut = i;
        break;
      }
    }

    const sender = normalizedName_(emailAddressName_(from));
    if (cut < 0 && sender) {
      for (let i = lines.length - 1; i >= Math.max(1, lines.length - 22); i--) {
        if (normalizedName_(signatureLine_(lines[i])) !== sender) continue;
        const tail = lines.slice(i).map(signatureLine_).join(' | ');
        const signal = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b|\b\d{5}(?:-\d{4})?\b|\b(?:director|manager|specialist|coordinator|counselor|admissions|operations|office|department|college|university|school)\b)/i.test(tail);
        if (signal) {
          cut = i;
          break;
        }
      }
    }

    if (cut > 0) {
      let prev = cut - 1;
      while (prev >= 0 && !signatureLine_(lines[prev])) prev--;
      if (prev >= 0 && /^(?:thanks|thank you|many thanks|best|best regards|regards|kind regards|sincerely|warmly|take care|god bless(?: and .*)?|have a (?:great|good|wonderful|fantastic) day)[!,. ]*$/i.test(signatureLine_(lines[prev]))) cut = prev;
      while (cut > 0 && !signatureLine_(lines[cut - 1])) cut--;
      return lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return lines.join('\n').trim();
  }

  function stripEmailSignature_(text, from) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const forwardAt = forwardedBoundaryIndex_(text);
    if (forwardAt < 0) return stripSignatureSegment_(text, from);
    const before = stripSignatureSegment_(text.substring(0, forwardAt), from);
    const after = text.substring(forwardAt).trim();
    return [before, after].filter(Boolean).join('\n\n');
  }

  function headerDisplayNames_(value) {
    return String(value || '').split(',').map(emailAddressName_).filter(Boolean);
  }

  function messageSnapshot_(gm, trimQuotes) {
    if (gm && gm._projectTrackerGmailSnapshot) return gm;
    const rawPlain = gm.getPlainBody() || '';
    const hasForwardedContent = forwardedBoundaryIndex_(rawPlain) >= 0;
    let body = rawPlain;
    if (trimQuotes) body = stripPlainQuotedHistory_(body);
    body = stripEmailSignature_(body, gm.getFrom() || '');

    let bodyMarkup = body.trim();
    // Normal replies keep the existing plain-text behavior so we do not revive
    // hidden quoted history. For an explicit forwarded message, however, the HTML
    // is part of the selected message itself and is safe to convert to our fixed
    // markup format. This preserves basic bold/italic/underline, structure, links,
    // and image labels from newsletters/marketing email instead of dropping them.
    if (hasForwardedContent) {
      try {
        const converted = forwardedHtmlMarkup_(gm.getBody() || '');
        if (converted) bodyMarkup = stripEmailSignature_(converted, gm.getFrom() || '');
      } catch (ignore) {}
    }

    return {
      _projectTrackerGmailSnapshot: true,
      gmailMessage: gm,
      id: String(gm.getId() || ''),
      date: gm.getDate(),
      from: gm.getFrom() || '',
      to: gm.getTo() || '',
      cc: gm.getCc() || '',
      body: body.trim() || '(no readable body)',
      body_markup: bodyMarkup || body.trim() || '(no readable body)'
    };
  }

  function messageBody_(gm, trimQuotes) {
    return messageSnapshot_(gm, trimQuotes).body;
  }

  function messageSection_(gm, index, total, trimQuotes) {
    const snapshot = messageSnapshot_(gm, trimQuotes);
    const date = Utilities.formatDate(snapshot.date, Session.getScriptTimeZone(), 'EEE MMM d, yyyy h:mm a');
    const lines = [
      'EMAIL ' + index + ' OF ' + total,
      'From: ' + snapshot.from,
      'To: ' + snapshot.to,
      snapshot.cc ? 'Cc: ' + snapshot.cc : '',
      'Date: ' + date,
      '',
      snapshot.body
    ];
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function messageSectionMarkup_(gm, index, total, trimQuotes) {
    const snapshot = messageSnapshot_(gm, trimQuotes);
    const date = Utilities.formatDate(snapshot.date, Session.getScriptTimeZone(), 'EEE MMM d, yyyy h:mm a');
    const lines = [
      '[b]EMAIL ' + index + ' OF ' + total + '[/b]',
      'From: ' + snapshot.from,
      'To: ' + snapshot.to,
      snapshot.cc ? 'Cc: ' + snapshot.cc : '',
      'Date: ' + date,
      '',
      snapshot.body_markup || snapshot.body
    ];
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function buildNoteText_(thread, selected, mode) {
    const subject = thread.getFirstMessageSubject() || '(no subject)';
    const normalizedMode = String(mode || '').toLowerCase();
    const intro = normalizedMode === 'full'
      ? 'EMAIL THREAD · ' + selected.length + ' message' + (selected.length === 1 ? '' : 's')
      : (normalizedMode === 'current' ? 'EMAIL · selected message' : 'EMAIL · most recent message');
    // Gmail reply bodies commonly contain the entire quoted conversation.
    // Strip that quoted history from every selected message, including
    // latest-only imports, so one Gmail message becomes one Project Tracker
    // email note instead of silently re-importing the whole thread. Explicitly
    // forwarded content is preserved by stripPlainQuotedHistory_.
    const sections = selected.map(function (gm, i) {
      return messageSection_(gm, i + 1, selected.length, true);
    });
    let text = intro + '\nSubject: ' + subject + '\n\n' + sections.join('\n\n------------------------------\n\n');
    const max = Math.max(20000, Number(CONFIG.EMAIL_NOTE_MAX_CHARS) || 90000);
    if (text.length > max) {
      text = text.substring(0, max - 120) + '\n\n[Email content trimmed because the thread exceeded the Project Tracker note limit.]';
    }
    return text;
  }

  function buildNoteMarkup_(thread, selected, mode, plainFallback) {
    const subject = thread.getFirstMessageSubject() || '(no subject)';
    const normalizedMode = String(mode || '').toLowerCase();
    const intro = normalizedMode === 'full'
      ? 'EMAIL THREAD · ' + selected.length + ' message' + (selected.length === 1 ? '' : 's')
      : (normalizedMode === 'current' ? 'EMAIL · selected message' : 'EMAIL · most recent message');
    const sections = selected.map(function (gm, i) {
      return messageSectionMarkup_(gm, i + 1, selected.length, true);
    });
    let markup = '[b]' + intro + '[/b]\nSubject: ' + subject + '\n\n' + sections.join('\n\n------------------------------\n\n');
    const max = Math.max(20000, Number(CONFIG.EMAIL_NOTE_MAX_CHARS) || 90000);
    if (markup.length > max) return String(plainFallback || '').trim();
    return markup;
  }

  function escapeRegex_(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function emailFilePayloads_(messages) {
    const files = [], skipped = [], inlineRefs = [], seen = {};
    let total = 0;

    function addBlob_(blob, inline) {
      const name = blob.getName() || (inline ? 'inline-image.png' : 'attachment');
      const mime = blob.getContentType() || 'application/octet-stream';
      let bytes = null;
      let size = -1;

      // GmailAttachment.getSize() is substantially cheaper than getBytes().length
      // and does not consume Gmail read quota. Use it to reject large/duplicate
      // files before downloading their contents into the add-on execution.
      try {
        if (typeof blob.getSize === 'function') size = Number(blob.getSize());
      } catch (ignore) {}
      if (!isFinite(size) || size < 0) {
        bytes = blob.getBytes();
        size = bytes.length;
      }

      const key = [inline ? 'inline' : 'attachment', name.toLowerCase(), size, mime].join('|');
      if (seen[key]) {
        if (inline) inlineRefs.push({ temp_id: seen[key], name: name });
        return;
      }
      if (size > CONFIG.MAX_ATTACHMENT_FILE_BYTES) {
        skipped.push(name + ' (larger than ' + Math.round(CONFIG.MAX_ATTACHMENT_FILE_BYTES / 1048576) + ' MB)');
        return;
      }
      if (total + size > CONFIG.MAX_TOTAL_INLINE_BYTES) {
        skipped.push(name + ' (email files exceeded the per-note upload limit)');
        return;
      }

      if (!bytes) bytes = blob.getBytes();
      // Preserve the original byte-based limits in the unlikely event a provider
      // reports a size different from the materialized blob length.
      const actualSize = bytes.length;
      if (actualSize > CONFIG.MAX_ATTACHMENT_FILE_BYTES) {
        skipped.push(name + ' (larger than ' + Math.round(CONFIG.MAX_ATTACHMENT_FILE_BYTES / 1048576) + ' MB)');
        return;
      }
      if (total + actualSize > CONFIG.MAX_TOTAL_INLINE_BYTES) {
        skipped.push(name + ' (email files exceeded the per-note upload limit)');
        return;
      }

      total += actualSize;
      const tempId = 'gmail_' + Utilities.getUuid();
      seen[key] = tempId;
      files.push({
        temp_id: tempId,
        name: name,
        original_name: name,
        mime_type: mime,
        inline: !!inline,
        base64: Utilities.base64Encode(bytes)
      });
      if (inline) inlineRefs.push({ temp_id: tempId, name: name });
    }

    messages.forEach(function (message) {
      const gm = message && message._projectTrackerGmailSnapshot ? message.gmailMessage : message;
      let regular = [], inline = [];
      try { regular = gm.getAttachments({ includeInlineImages: false, includeAttachments: true }) || []; }
      catch (e) { regular = gm.getAttachments() || []; }
      try { inline = gm.getAttachments({ includeInlineImages: true, includeAttachments: false }) || []; }
      catch (e) { inline = []; }
      regular.forEach(function (blob) { addBlob_(blob, false); });
      inline.forEach(function (blob) { addBlob_(blob, true); });
    });
    return { files: files, skipped: skipped, inlineRefs: inlineRefs };
  }

  function inlineMarkup_(text, inlineRefs) {
    let markup = String(text || '');
    const unmatched = [];
    (inlineRefs || []).forEach(function (img) {
      const token = '[imgtmp:' + img.temp_id + ']';
      const name = String(img.name || '').trim();
      let replaced = false;
      if (name) {
        const re = new RegExp('\\[image\\s*:\\s*' + escapeRegex_(name) + '\\s*\\]', 'i');
        if (re.test(markup)) {
          markup = markup.replace(re, token);
          replaced = true;
        }
      }
      if (!replaced) unmatched.push(token);
    });
    if (unmatched.length) markup += '\n\n' + unmatched.join('\n\n');
    return markup;
  }

  function normalizedName_(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function internalAgentNames_() {
    const out = {};
    try {
      Repo.activeAgents().forEach(function (a) {
        const name = normalizedName_(a.display_name || '');
        if (name) out[name] = true;
      });
    } catch (ignore) {}
    return out;
  }

  function plausibleStudentName_(name, internalNames) {
    const normalized = normalizedName_(name);
    if (!normalized || internalNames[normalized]) return false;
    const tokens = normalized.split(' ');
    const noise = {
      admissions:1, admission:1, associate:1, director:1, operations:1, operation:1,
      college:1, university:1, project:1, tracker:1, ticket:1, email:1, thread:1,
      office:1, department:1, team:1, student:1, students:1
    };
    return !tokens.some(function (t) { return !!noise[t]; });
  }

  function candidateStudentNames_(messages, text) {
    const out = [], seen = {}, internalNames = internalAgentNames_();
    function add(name) {
      name = String(name || '').replace(/\s+/g, ' ').trim();
      if (!/^[A-Z][A-Za-z'’-]{1,30}(?:\s+[A-Z][A-Za-z'’-]{1,30}){1,2}$/.test(name)) return;
      if (!plausibleStudentName_(name, internalNames)) return;
      const key = normalizedName_(name);
      if (!seen[key]) { seen[key] = true; out.push(name); }
    }
    // Header names are higher-confidence than capitalized phrases in the body.
    messages.forEach(function (gm) {
      if (gm && gm._projectTrackerGmailSnapshot) {
        add(emailAddressName_(gm.from));
        headerDisplayNames_(gm.to).forEach(add);
        headerDisplayNames_(gm.cc).forEach(add);
        return;
      }
      add(emailAddressName_(gm.getFrom()));
      headerDisplayNames_(gm.getTo()).forEach(add);
      headerDisplayNames_(gm.getCc()).forEach(add);
    });
    const body = String(text || '');
    const re = /\b([A-Z][A-Za-z'’-]{1,30}\s+[A-Z][A-Za-z'’-]{1,30}(?:\s+[A-Z][A-Za-z'’-]{1,30})?)\b/g;
    let m;
    while ((m = re.exec(body)) !== null && out.length < 20) add(m[1]);
    return out.slice(0, Math.max(1, Number(CONFIG.EMAIL_STUDENT_NAME_MAX_LOOKUPS) || 8));
  }

  function studentSearchCacheKey_(name) {
    return 'gmail_student_' + normalizedName_(name).replace(/[^a-z0-9]+/g, '_').substring(0, 70);
  }

  function cachedExactStudent_(name) {
    const key = studentSearchCacheKey_(name);
    const cached = Repo.cacheGet(key);
    if (cached && cached.state === 'exact' && cached.person) return cached.person;
    if (cached && cached.state === 'none') return null;

    const wanted = normalizedName_(name);
    const exact = Element451.searchStudents(name).filter(function (p) {
      return normalizedName_(p.name) === wanted;
    });
    const ttl = Math.max(60, Number(CONFIG.EMAIL_STUDENT_SEARCH_CACHE_SECONDS) || 21600);
    if (exact.length === 1) {
      const person = exact[0];
      Repo.cachePut(key, { state: 'exact', person: person }, ttl);
      return person;
    }
    Repo.cachePut(key, { state: 'none' }, ttl);
    return null;
  }

  function studentState_(ticketId, options) {
    options = options || {};
    const state = { byId: {}, byName: {} };
    try {
      const snapshot = RelatedStudents.snapshot(ticketId, {
        fast: !!options.fast,
        skipAccessValidation: !!options.skipAccessValidation,
        skipTicketValidation: !!options.skipTicketValidation
      });
      (snapshot.students || []).forEach(function (student) {
        const id = String(student.element_id || '').toLowerCase();
        if (id) state.byId[id] = student;
        const nameKey = normalizedName_(student.name || [student.first_name, student.last_name].filter(Boolean).join(' '));
        if (nameKey) state.byName[nameKey] = student;
      });
    } catch (ignore) {}
    return state;
  }

  function rememberStudent_(state, person) {
    if (!person) return;
    const id = String(person.element_id || '').toLowerCase();
    if (!id) return;
    const display = person.name || [person.first_name, person.last_name].filter(Boolean).join(' ');
    state.byId[id] = person;
    const key = normalizedName_(display);
    if (key) state.byName[key] = person;
  }

  function studentRef_(literal, person, source) {
    const id = String(person && person.element_id || '').toLowerCase();
    literal = String(literal || '').trim();
    if (!literal || !id) return null;
    return { literal: literal, element_id: id, source: source || '' };
  }

  function autoMatchStudents_(ticketId, messages, text, studentState, maxLookups, pendingStudents) {
    const refs = [];
    const state = studentState || studentState_(ticketId);
    const pending = pendingStudents || [];
    const candidates = candidateStudentNames_(messages, text);
    const limit = Math.max(0, Math.min(candidates.length, Number(maxLookups === undefined ? candidates.length : maxLookups)));
    const selected = candidates.slice(0, limit);
    const resolved = {}, unresolved = [];
    const ttl = Math.max(60, Number(CONFIG.EMAIL_STUDENT_SEARCH_CACHE_SECONDS) || 21600);

    selected.forEach(function (name) {
      const nameKey = normalizedName_(name);
      if (state.byName[nameKey]) { resolved[name] = state.byName[nameKey]; return; }
      const cached = Repo.cacheGet(studentSearchCacheKey_(name));
      if (cached && cached.state === 'exact' && cached.person) resolved[name] = cached.person;
      else if (!(cached && cached.state === 'none')) unresolved.push(name);
    });

    if (unresolved.length) {
      let matches = {};
      try { matches = Element451.searchStudentsManyExact(unresolved) || {}; } catch (ignore) {}
      unresolved.forEach(function (name) {
        if (matches[name]) {
          resolved[name] = matches[name];
          Repo.cachePut(studentSearchCacheKey_(name), { state: 'exact', person: matches[name] }, ttl);
        } else {
          Repo.cachePut(studentSearchCacheKey_(name), { state: 'none' }, ttl);
        }
      });
    }

    selected.forEach(function (name) {
      const person = resolved[name];
      const id = person && String(person.element_id || '').toLowerCase();
      if (!id) return;
      if (!state.byId[id]) pending.push({ person: person, source: 'email_name_match' });
      rememberStudent_(state, person);
      const ref = studentRef_(name, person, 'name');
      if (ref) refs.push(ref);
    });
    return refs;
  }

  function configuredStudentIdentityRegex_(kind, flags, anchored) {
    try { return projectTrackerStudentIdentityRegex_(kind, flags, anchored); }
    catch (e) { return null; }
  }

  function configuredStudentIdentityScanRegex_(kind) {
    const cfg = projectTrackerStudentIdentityConfig_(kind);
    if (!cfg.enabled || !cfg.tokenPattern) return null;
    try { return new RegExp('(?:^|[^A-Za-z0-9_-])(' + cfg.tokenPattern + ')(?=$|[^A-Za-z0-9_-])', 'ig'); }
    catch (e) { return null; }
  }

  function enabledStudentIdentityKinds_() {
    return ['spark', 'school'].filter(function (kind) { return projectTrackerStudentIdentityEnabled_(kind); });
  }

  function candidateStudentIdentifiers_(text) {
    const body = String(text || '').replace(/https?:\/\/[^\s<>\"]+/ig, ' ');
    const out = [], seen = {}, externalKinds = enabledStudentIdentityKinds_();
    function add(kind, literal) {
      kind = String(kind || '').toLowerCase();
      if ((kind === 'spark' || kind === 'school') && !projectTrackerStudentIdentityEnabled_(kind)) return;
      literal = String(literal || '').trim().replace(/^[,;]+|[,;]+$/g, '');
      if (!literal) return;
      const key = kind + '|' + literal.toLowerCase();
      if (!seen[key] && out.length < 60) { seen[key] = true; out.push({ kind: kind, literal: literal }); }
    }
    function classifyUnlabeled_(literal) {
      literal = String(literal || '').trim();
      if (!literal) return;
      if (/^[a-f0-9]{24}$/i.test(literal)) { add('element', literal); return; }
      externalKinds.some(function (kind) {
        const re = configuredStudentIdentityRegex_(kind, 'i', true);
        if (re && re.test(literal)) { add(kind, literal); return true; }
        return false;
      });
    }
    function addList_(kind, value) {
      String(value || '').split(/[\s,;|]+/).forEach(function (token) {
        token = token.trim();
        if (!token) return;
        if (kind === 'element') {
          if (/^[a-f0-9]{24}$/i.test(token)) add('element', token);
          return;
        }
        if (externalKinds.indexOf(kind) >= 0) { add(kind, token); return; }
        classifyUnlabeled_(token);
      });
    }
    function escapeRegex_(value) {
      return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function explicitExternalMatch_(line) {
      for (let i = 0; i < externalKinds.length; i++) {
        const kind = externalKinds[i];
        const label = projectTrackerStudentIdentityLabel_(kind);
        if (!label) continue;
        const re = new RegExp('^' + escapeRegex_(label) + 's?\\s*[:#=-]?\\s*(.*)$', 'i');
        const m = line.match(re);
        if (m) return { kind: kind, rest: m[1] || '' };
      }
      return null;
    }
    function tokenFitsList_(kind, token) {
      if (kind === 'element') return /^[a-f0-9]{24}$/i.test(token);
      const re = configuredStudentIdentityRegex_(kind, 'i', true);
      if (re) return re.test(token);
      // Continuation is allowed only after an explicit configured label. This
      // conservative shape check avoids inferring arbitrary prose as an ID.
      return /^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(token) && /\d/.test(token);
    }

    const lines = body.split(/\r?\n/);
    let listMode = '';
    lines.forEach(function (rawLine) {
      let line = String(rawLine || '').trim();
      line = line.replace(/^(?:[-*]|>{1,3})\s*/, '');
      if (!line) { listMode = ''; return; }

      let m;
      // Element ID is universal to the Element451 integration.
      if ((m = line.match(/^element\s*ids?\s*[:#=-]?\s*(.*)$/i))) {
        listMode = 'element'; if (m[1]) addList_('element', m[1]); return;
      }

      // Additional identifier labels come entirely from institution config.
      const explicit = explicitExternalMatch_(line);
      if (explicit) {
        listMode = explicit.kind;
        if (explicit.rest) addList_(explicit.kind, explicit.rest);
        return;
      }

      // A generic "Student ID" label is not enough to decide which external
      // identity type it means. Only classify it when a configured pattern or
      // the native Element-ID shape makes the value unambiguous.
      if ((m = line.match(/^student\s*id\s*[:#=-]?\s*([A-Za-z0-9_.-]{3,40})\b/i))) {
        classifyUnlabeled_(m[1]); return;
      }

      // Continue an explicitly labeled list across subsequent lines.
      if (listMode) {
        const tokens = line.split(/[\s,;|]+/).filter(Boolean);
        const allIdLike = tokens.length > 0 && tokens.length <= 20 && tokens.every(function (t) {
          return tokenFitsList_(listMode, t);
        });
        if (allIdLike) { addList_(listMode, line); return; }
        listMode = '';
      }

      // Automatic recognition is opt-in per external identifier type and only
      // runs when that type has a verified tokenPattern.
      externalKinds.forEach(function (kind) {
        const re = configuredStudentIdentityScanRegex_(kind);
        if (!re) return;
        let match;
        while ((match = re.exec(line)) !== null && out.length < 60) add(kind, match[1]);
      });

      // Native Element IDs are unambiguous 24-character hex values.
      const elementRe = /(?:^|[^A-Za-z0-9])([a-f0-9]{24})(?=$|[^A-Za-z0-9])/ig;
      while ((m = elementRe.exec(line)) !== null && out.length < 60) add('element', m[1]);
    });
    return out;
  }

  function studentUrlCandidates_(text) {
    const out = [], seen = {}, re = /https?:\/\/[^\s<>\"]+/ig;
    let m;
    while ((m = re.exec(String(text || ''))) !== null && out.length < 40) {
      const literal = String(m[0] || '').replace(/[),.;!?]+$/g, '');
      const id = element451ExtractPersonId_(literal);
      const key = literal.toLowerCase();
      if (id && !seen[key]) { seen[key] = true; out.push({ literal: literal, element_id: id }); }
    }
    return out;
  }

  function addResolvedStudent_(ticketId, state, person, literal, source, refs, pendingStudents) {
    const id = person && String(person.element_id || '').toLowerCase();
    if (!id) return;
    if (!state.byId[id]) (pendingStudents || []).push({ person: person, source: 'email_' + source + '_match' });
    rememberStudent_(state, person);
    const ref = studentRef_(literal, person, source);
    if (ref) refs.push(ref);
  }

  function autoMatchStudentReferences_(ticketId, text, studentState, pendingStudents) {
    const refs = [], state = studentState || studentState_(ticketId);
    const urlCandidates = studentUrlCandidates_(text);
    const idCandidates = candidateStudentIdentifiers_(text);
    if (!urlCandidates.length && !idCandidates.length) return refs;

    // Build one combined request set. URL candidates use their Element ID for
    // lookup but keep the original URL as the literal that will be replaced by
    // a #Student token in the note.
    const lookupRefs = [];
    urlCandidates.forEach(function (candidate) {
      lookupRefs.push({ kind: 'element', literal: candidate.element_id });
    });
    idCandidates.forEach(function (candidate) {
      lookupRefs.push({ kind: candidate.kind, literal: candidate.literal });
    });

    let people = { spark: {}, school: {}, element: {} };
    try { people = Element451.lookupManyStudentIdentifiers(lookupRefs) || people; }
    catch (ignore) { return refs; }

    urlCandidates.forEach(function (candidate) {
      const person = (people.element || {})[String(candidate.element_id || '').toLowerCase()];
      if (person) addResolvedStudent_(ticketId, state, person, candidate.literal, 'url', refs, pendingStudents);
    });

    idCandidates.forEach(function (candidate) {
      let person = null;
      if (candidate.kind === 'spark') person = (people.spark || {})[candidate.literal];
      else if (candidate.kind === 'school') person = (people.school || {})[candidate.literal];
      else if (candidate.kind === 'element') person = (people.element || {})[String(candidate.literal || '').toLowerCase()];
      if (person) addResolvedStudent_(ticketId, state, person, candidate.literal, candidate.kind, refs, pendingStudents);
    });
    return refs;
  }

  function extractedUrls_(text) {
    const out = [], seen = {};
    const re = /https?:\/\/[^\s<>\"]+/ig;
    let m;
    while ((m = re.exec(String(text || ''))) !== null && out.length < 40) {
      let url = m[0].replace(/[),.;!?]+$/g, '');
      if (!seen[url]) { seen[url] = true; out.push(url); }
    }
    return out;
  }

  function matchEmailUrls_(ticketId, text, options) {
    options = options || {};
    const urls = extractedUrls_(text).filter(function (url) {
      // Student URLs are resolved in one batch by autoMatchStudentReferences_.
      return !element451ExtractPersonId_(url);
    });
    if (!urls.length) return { added: 0, resources: [] };
    try {
      if (RelatedResources.addUrlsBatch) {
        return RelatedResources.addUrlsBatch(ticketId, urls, {
          source: 'email_url',
          fast: !!options.fast,
          skipAccessValidation: !!options.skipAccessValidation,
          skipTicketValidation: !!options.skipTicketValidation
        });
      }
      urls.forEach(function (url) { try { RelatedResources.addUrl(ticketId, url); } catch (ignore) {} });
    } catch (ignore) {}
    return { added: 0, resources: [] };
  }

  function dedupeStudentRefs_(refs) {
    const out = [], seen = {};
    (refs || []).forEach(function (ref) {
      const literal = String(ref && ref.literal || '').trim();
      const id = String(ref && ref.element_id || '').toLowerCase();
      if (!literal || !id) return;
      const key = literal.toLowerCase() + '|' + id;
      if (!seen[key]) { seen[key] = true; out.push({ literal: literal, element_id: id, source: ref.source || '' }); }
    });
    return out;
  }

  function enrichEmail_(ticketId, messages, text, options) {
    options = options || {};
    // Mirror every manual Add Student path: Element URL, raw Element ID,
    // Configured external IDs, Element IDs, and exact-name search. Resolve first, then write all
    // new Related Students in one spreadsheet operation.
    const refs = [];
    const pendingStudents = [];
    const state = studentState_(ticketId, options);

    try { Array.prototype.push.apply(refs, autoMatchStudentReferences_(ticketId, text, state, pendingStudents)); } catch (ignore) {}
    try { matchEmailUrls_(ticketId, text, options); } catch (ignore) {}

    // Keep exact-name matching available, but identifiers are stronger evidence.
    const nameBudget = refs.length ? 0 : Math.min(5, Number(CONFIG.EMAIL_STUDENT_NAME_MAX_LOOKUPS) || 5);
    try { Array.prototype.push.apply(refs, autoMatchStudents_(ticketId, messages, text, state, nameBudget, pendingStudents)); } catch (ignore) {}

    try {
      RelatedStudents.addResolvedPeople(ticketId, pendingStudents, {
        fast: !!options.fast,
        skipAccessValidation: !!options.skipAccessValidation,
        skipTicketValidation: !!options.skipTicketValidation
      });
    } catch (ignore) {}
    try {
      RelatedResources.matchKnownNames(ticketId, text, {
        fast: !!options.fast,
        skipAccessValidation: !!options.skipAccessValidation,
        skipTicketValidation: !!options.skipTicketValidation,
        returnList: false
      });
    } catch (ignore) {}
    return { studentRefs: dedupeStudentRefs_(refs) };
  }

  function replaceLiteral_(text, literal, replacement) {
    literal = String(literal || '');
    if (!literal) return String(text || '');
    return String(text || '').replace(new RegExp(escapeRegex_(literal), 'g'), replacement);
  }

  function resourceRefFromUrl_(url) {
    url = String(url || '');
    const elementRef = element451ParseResourceUrl_(url);
    if (elementRef) return elementRef;
    let m;
    if ((m = url.match(/^https?:\/\/docs\.google\.com\/(spreadsheets|document)\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i))) return { type: m[1] === 'spreadsheets' ? 'google_sheet' : 'google_doc', external_id: m[2] };
    if ((m = url.match(/^https?:\/\/script\.google\.com\/home\/projects\/([A-Za-z0-9_-]+)(?:\/edit)?(?:[/?#]|$)/i))) return { type: 'google_apps_script', external_id: m[1] };
    return null;
  }

  function resourceLookupKey_(type, externalId) {
    type = String(type || '').toLowerCase();
    externalId = String(externalId || '');
    // Google Drive/Apps Script IDs are case-sensitive; Element451 GUID-style
    // identifiers are normalized for reliable matching.
    const preserveCase = type === 'google_doc' || type === 'google_sheet' || type === 'google_apps_script';
    return type + '|' + (preserveCase ? externalId : externalId.toLowerCase());
  }

  function replaceStudentLiteralOutsideTokens_(text, literal, elementId) {
    literal = String(literal || '').trim();
    elementId = String(elementId || '').toLowerCase();
    if (!literal || !elementId) return String(text || '');
    const parts = String(text || '').split(/(\[(?:stu|res|img|imgtmp):[^\]]+\])/g);
    const re = new RegExp('(^|[^A-Za-z0-9_-])' + escapeRegex_(literal) + '(?=$|[^A-Za-z0-9_-])', 'gi');
    return parts.map(function (part) {
      if (/^\[(?:stu|res|img|imgtmp):[^\]]+\]$/.test(part)) return part;
      return part.replace(re, function (_, prefix) { return prefix + '[stu:' + elementId + ']'; });
    }).join('');
  }

  function tokenizeEmailReferences_(ticketId, markup, studentRefs, options) {
    options = options || {};
    let out = String(markup || '');
    let students = [], resources = [];
    try {
      students = (RelatedStudents.snapshot(ticketId, { fast: !!options.fast, skipAccessValidation: true, skipTicketValidation: true }).students || []);
    } catch (ignore) {}
    try {
      resources = (RelatedResources.snapshot(ticketId, { fast: !!options.fast, skipAccessValidation: true, skipTicketValidation: true }).resources || []);
    } catch (ignore) {}

    const studentById = {};
    students.forEach(function (s) {
      const id = String(s.element_id || '').toLowerCase();
      if (id) studentById[id] = s;
    });

    const resourceByKey = {};
    resources.forEach(function (r) {
      const type = String(r.resource_type || '').toLowerCase();
      // Preserve the original case here. resourceLookupKey_() normalizes
      // Element451 identifiers while intentionally keeping Google Drive and
      // Apps Script IDs case-sensitive. Lowercasing before that helper made
      // mixed-case Google Docs/Sheets IDs impossible to match back to their
      // Related Resource records for note-token rendering.
      const external = String(r.external_id || '');
      if (type && external) resourceByKey[resourceLookupKey_(type, external)] = r;
    });

    // Replace the exact URLs present in the email with Project Tracker tokens.
    // The note renderer then shows the same #Student / $Resource chips used by
    // manually-authored rich notes, while the plain body remains unchanged for
    // search/audit purposes.
    extractedUrls_(out).forEach(function (url) {
      const studentId = element451ExtractPersonId_(url);
      if (studentId) {
        const id = studentId;
        if (studentById[id]) out = replaceLiteral_(out, url, '[stu:' + id + ']');
        return;
      }
      const ref = resourceRefFromUrl_(url);
      if (!ref) return;
      const r = resourceByKey[resourceLookupKey_(ref.type, ref.external_id)];
      if (r && r.resource_id) out = replaceLiteral_(out, url, '[res:' + r.resource_id + ']');
    });

    // Also turn standalone Element IDs into student tags once that student has
    // been safely resolved and related to this ticket. The prefix rule prevents
    // IDs already inside [stu:...] tokens from being re-tokenized.
    Object.keys(studentById).forEach(function (id) {
      const re = new RegExp('(^|[^A-Za-z0-9:_-])' + escapeRegex_(id) + '(?=$|[^A-Za-z0-9_-])', 'gi');
      out = out.replace(re, function (_, prefix) { return prefix + '[stu:' + id + ']'; });
    });

    // Mirror Search-by-name display behavior for students that are now related.
    // This is local string replacement only; it does not trigger more API calls.
    students.forEach(function (student) {
      const id = String(student.element_id || '').toLowerCase();
      const name = String(student.name || [student.first_name, student.last_name].filter(Boolean).join(' ')).trim();
      if (id && name) out = replaceStudentLiteralOutsideTokens_(out, name, id);
    });

    // External identifier literals are not stored on the RelatedStudents row, so carry
    // the exact literals resolved during this email enrichment into tokenization.
    (studentRefs || []).slice().sort(function (a, b) {
      return String(b.literal || '').length - String(a.literal || '').length;
    }).forEach(function (ref) {
      if (studentById[String(ref.element_id || '').toLowerCase()]) {
        out = replaceStudentLiteralOutsideTokens_(out, ref.literal, ref.element_id);
      }
    });
    return out;
  }

  // Shared enrichment helpers for imported conversation sources such as Google Chat.
  // This deliberately reuses the Gmail identifier/resource pipeline so Chat and
  // email produce the same #Student and $Resource relationships/tokens.
  function enrichImportedText(ticketId, text) {
    return enrichEmail_(ticketId, [], String(text || ''));
  }

  function tokenizeImportedReferences(ticketId, markup, studentRefs) {
    return tokenizeEmailReferences_(ticketId, String(markup || ''), studentRefs || []);
  }

  function decorateEmailNote_(ticketId, entry, studentRefs, options) {
    if (!entry || !entry.activity_id) return entry;
    const current = String(entry.body_markup || entry.body || '');
    const tagged = tokenizeEmailReferences_(ticketId, current, studentRefs || [], options || {});
    if (tagged === current) return entry;
    const updated = Repo.update(TABS.ACTIVITY, 'activity_id', entry.activity_id, { body_markup: tagged });
    return updated || Object.assign(entry, { body_markup: tagged });
  }

  function selectedMessages_(allMessages, mode, currentMessage) {
    const all = Array.isArray(allMessages) ? allMessages : [];
    if (!all.length) throw new Error('This Gmail thread has no messages.');
    const normalized = String(mode || '').toLowerCase();
    if (normalized === 'current') return [currentMessage];
    if (normalized === 'latest') return [all[all.length - 1]];
    return all;
  }

  function existingThreadNote_(ticketId, threadRef) {
    const finder = Repo.findAllFast || Repo.findAll;
    const rows = finder(TABS.ACTIVITY, 'ticket_id', ticketId);
    return rows.filter(function (entry) {
      return String(entry.ref || '') === String(threadRef || '') &&
        entry.kind === ACTIVITY_KIND.NOTE &&
        entry.deleted !== true && entry.deleted !== 'TRUE';
    }).sort(function (a, b) {
      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    })[0] || null;
  }

  function logEmail_(ticketId, messageId, mode, watch, options) {
    options = options || {};
    const startedAt = Date.now();
    if (!options.skipAccessValidation) requireAgent_();

    const message = GmailApp.getMessageById(messageId);
    if (!message) throw new Error('The selected Gmail message could not be read.');
    const thread = message.getThread();
    const allMessages = thread.getMessages();
    const normalizedMode = String(mode || '').toLowerCase();
    const selected = selectedMessages_(allMessages, normalizedMode, message);
    const selectedSnapshots = selected.map(function (gm) { return messageSnapshot_(gm, true); });
    const threadRef = 'gmail-thread:' + thread.getId();
    timing_(startedAt, 'message/thread snapshot');

    // A host timeout can happen after the email note was committed but before
    // Gmail received the response. On a resumed new-ticket flow, reuse that note
    // instead of importing the same thread again.
    if (options.dedupeThread) {
      const existingNote = existingThreadNote_(ticketId, threadRef);
      if (existingNote) {
        const recoveredWatch = watch ? ensureWatch_(ticketId, thread, allMessages, { skipAccessValidation: true }) : null;
        const ticketFinder = Repo.findOneFast || Repo.findOne;
        timing_(startedAt, 'recovered prior committed note');
        return {
          ticket: ticketFinder(TABS.TICKETS, 'ticket_id', ticketId),
          note: existingNote,
          watch: recoveredWatch,
          projectUrl: projectUrl_(ticketId),
          recovered: true
        };
      }
    }

    let noteText = buildNoteText_(thread, selectedSnapshots, normalizedMode);
    let noteMarkupBase = buildNoteMarkup_(thread, selectedSnapshots, normalizedMode, noteText);
    timing_(startedAt, 'note text');
    const attachmentSet = emailFilePayloads_(selectedSnapshots);
    timing_(startedAt, 'attachments materialized');
    if (attachmentSet.skipped.length) {
      const skippedText = '\n\nAttachments not uploaded:\n- ' + attachmentSet.skipped.join('\n- ');
      noteText += skippedText;
      noteMarkupBase += skippedText;
    }

    const noteMarkup = inlineMarkup_(noteMarkupBase, attachmentSet.inlineRefs);
    const sourceTimestamp = selectedSnapshots[selectedSnapshots.length - 1].date.toISOString();
    const out = Tickets.addRichNote(ticketId, {
      text: noteText,
      markup: noteMarkup,
      files: attachmentSet.files,
      ref: threadRef
    }, '', sourceTimestamp, {
      skipAutoSync: true,
      skipRelationLists: true,
      skipAccessValidation: true,
      ticket: options.ticket || null
    });
    timing_(startedAt, 'note + files committed');

    // Commit the user's watch choice before optional metadata enrichment. The note
    // itself is already durable at this point, so a slow Element/relationship
    // lookup must not prevent Gmail from receiving a successful action response.
    const watchRow = watch ? ensureWatch_(ticketId, thread, allMessages, { skipAccessValidation: true }) : null;
    timing_(startedAt, 'watch committed');

    // Full threads can contain many names/URLs and therefore trigger multiple
    // external enrichment calls. Once the critical email record is safely stored,
    // defer that optional tagging work when the thread is large or the callback has
    // already consumed a meaningful part of its host execution budget.
    const elapsedBeforeEnrichment = Date.now() - startedAt;
    const deferEnrichment = (normalizedMode === 'full' && selectedSnapshots.length > 5) || elapsedBeforeEnrichment > 12000;
    if (deferEnrichment) {
      queueEmailEnrichment_(ticketId, out.entry.activity_id);
      timing_(startedAt, 'enrichment queued');
    } else {
      const enrichment = enrichEmail_(ticketId, selectedSnapshots, noteText, { fast: true, skipAccessValidation: true, skipTicketValidation: true });
      timing_(startedAt, 'student/resource enrichment');
      out.entry = decorateEmailNote_(ticketId, out.entry, enrichment.studentRefs || [], { fast: true });
      timing_(startedAt, 'note tokenization');
    }

    const ticketFinder = Repo.findOneFast || Repo.findOne;
    timing_(startedAt, 'complete');
    return {
      ticket: options.ticket || ticketFinder(TABS.TICKETS, 'ticket_id', ticketId),
      note: out.entry,
      watch: watchRow,
      projectUrl: projectUrl_(ticketId),
      enrichmentDeferred: deferEnrichment
    };
  }

  function createFromEmail(payload, messageId, mode, watch) {
    requireAgent_();
    payload = Object.assign({}, payload || {}, { _creationSource: 'gmail' });
    const ticket = Tickets.create(payload);
    return logEmail_(ticket.ticket_id, messageId, mode, watch, { skipAccessValidation: true });
  }

  function addToExisting(ticketId, messageId, mode, watch, options) {
    options = options || {};
    if (!options.skipAccessValidation) requireAgent_();
    const finder = Repo.findOneFast || Repo.findOne;
    const ticket = finder(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('Ticket not found.');
    if (ticket.deleted === true || ticket.deleted === 'TRUE') throw new Error('Restore this ticket before adding email to it.');
    return logEmail_(ticketId, messageId, mode, watch, Object.assign({}, options, {
      skipAccessValidation: true,
      ticket: ticket
    }));
  }

  function projectUrl_(ticketId) {
    const base = String(ScriptApp.getService().getUrl() || '').split('?')[0];
    return base ? base + '?ticket=' + encodeURIComponent(ticketId) : '';
  }

  function searchTickets(query) {
    requireAgent_();
    return Tickets.searchTickets(query, '').slice(0, 10);
  }

  function newMessages_(messages, watch) {
    const lastId = String(watch.last_message_id || '');
    let at = -1;
    messages.some(function (m, i) {
      if (String(m.getId()) === lastId) { at = i; return true; }
      return false;
    });
    if (at >= 0) return messages.slice(at + 1);
    const lastTs = new Date(watch.last_message_at || 0).getTime();
    if (!isNaN(lastTs) && lastTs > 0) {
      return messages.filter(function (m) { return m.getDate().getTime() > lastTs; });
    }
    return messages.slice(Math.max(0, Number(watch.last_message_count) || 0));
  }

  function senderAddress_(value) {
    const s = String(value || '').trim();
    const bracket = s.match(/<([^>]+)>/);
    const raw = bracket ? bracket[1] : s;
    const m = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return (m ? m[0] : raw).trim().toLowerCase();
  }

  function mergeTickets(primaryId, secondaryId) {
    const rows = Repo.findAll(TABS.EMAIL_WATCHES, 'ticket_id', secondaryId);
    rows.forEach(function (row) {
      const duplicate = Repo.findAll(TABS.EMAIL_WATCHES, 'ticket_id', primaryId).some(function (x) {
        return bool_(x.active) && bool_(row.active) &&
          String(x.thread_id) === String(row.thread_id) &&
          String(x.mailbox_user || '').toLowerCase() === String(row.mailbox_user || '').toLowerCase();
      });
      if (duplicate) {
        Repo.update(TABS.EMAIL_WATCHES, 'watch_id', row.watch_id, { active: false, updated_at: Repo.now() });
      } else {
        Repo.update(TABS.EMAIL_WATCHES, 'watch_id', row.watch_id, { ticket_id: primaryId, updated_at: Repo.now() });
      }
    });
    return rows.length;
  }

  function processWatch_(watch) {
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', watch.ticket_id);
    if (!ticket || ticket.deleted === true || ticket.deleted === 'TRUE') {
      Repo.update(TABS.EMAIL_WATCHES, 'watch_id', watch.watch_id, { active: false, updated_at: Repo.now() });
      return { logged: 0, stopped: true };
    }

    const thread = GmailApp.getThreadById(watch.thread_id);
    if (!thread) return { logged: 0, missing: true };
    const messages = thread.getMessages();
    const fresh = newMessages_(messages, watch);
    if (!fresh.length) return { logged: 0 };

    let logged = 0, externalReplies = 0, postCloseExternalReplies = 0, latestSender = '';
    const enrichmentTexts = [], savedEntries = [];
    const mailbox = String(watch.mailbox_user || mailboxUser_()).toLowerCase();
    const completedAtMs = ticket.status === STATUS.COMPLETED && ticket.completed_at
      ? new Date(ticket.completed_at).getTime()
      : NaN;

    fresh.forEach(function (gm) {
      const snapshot = messageSnapshot_(gm, true);
      let noteText = 'EMAIL REPLY · watched thread\nSubject: ' + (thread.getFirstMessageSubject() || '(no subject)') + '\n\n' +
        messageSection_(snapshot, 1, 1, true);
      let noteMarkupBase = '[b]EMAIL REPLY · watched thread[/b]\nSubject: ' + (thread.getFirstMessageSubject() || '(no subject)') + '\n\n' +
        messageSectionMarkup_(snapshot, 1, 1, true);
      const attachmentSet = emailFilePayloads_([snapshot]);
      if (attachmentSet.skipped.length) {
        const skippedText = '\n\nAttachments not uploaded:\n- ' + attachmentSet.skipped.join('\n- ');
        noteText += skippedText;
        noteMarkupBase += skippedText;
      }
      const noteMarkup = inlineMarkup_(noteMarkupBase, attachmentSet.inlineRefs);
      const sourceTimestamp = gm.getDate().toISOString();
      const saved = Tickets.addRichNote(watch.ticket_id, {
        text: noteText,
        markup: noteMarkup,
        files: attachmentSet.files,
        ref: 'gmail-thread:' + thread.getId()
      }, '', sourceTimestamp, { skipAutoSync: true, skipRelationLists: true });
      if (saved && saved.entry) savedEntries.push(saved.entry);
      enrichmentTexts.push(noteText);

      const sender = gm.getFrom() || '';
      const senderAddress = senderAddress_(sender);
      const isExternal = !!senderAddress && senderAddress !== mailbox;
      if (isExternal) {
        externalReplies++;
        // Reopen notifications are based on when Gmail says the message
        // actually arrived, not when the hourly watcher happened to run.
        // This prevents a reply received before closure from generating a
        // false reopen prompt simply because it was logged after closure.
        const messageAtMs = gm.getDate().getTime();
        if (!isNaN(completedAtMs) && messageAtMs > completedAtMs) {
          postCloseExternalReplies++;
          latestSender = sender;
        }
      }
      logged++;
    });

    if (enrichmentTexts.length) {
      const enrichment = enrichEmail_(watch.ticket_id, fresh, enrichmentTexts.join('\n\n'));
      savedEntries.forEach(function (entry) {
        try { decorateEmailNote_(watch.ticket_id, entry, enrichment.studentRefs || []); } catch (ignore) {}
      });
    }

    const last = messages[messages.length - 1];
    Repo.update(TABS.EMAIL_WATCHES, 'watch_id', watch.watch_id, {
      thread_url: safeThreadPermalink_(thread),
      subject: thread.getFirstMessageSubject() || watch.subject,
      last_message_id: last ? last.getId() : watch.last_message_id,
      last_message_at: last ? last.getDate().toISOString() : Repo.now(),
      last_message_count: messages.length,
      updated_at: Repo.now()
    });

    if (ticket.status === STATUS.COMPLETED && postCloseExternalReplies > 0) {
      Tickets.notifyClosedEmailReply(watch.ticket_id, postCloseExternalReplies, thread.getFirstMessageSubject() || watch.subject, latestSender);
    }
    return {
      logged: logged,
      externalReplies: externalReplies,
      postCloseExternalReplies: postCloseExternalReplies
    };
  }

  function processWatchedThreads() {
    const mailbox = mailboxUser_();
    if (!mailbox) return { checked: 0, logged: 0, errors: [{ message: 'Could not identify the mailbox user.' }] };
    const watches = activeMailboxWatches_(mailbox);
    let logged = 0;
    const errors = [];
    watches.forEach(function (watch) {
      try { logged += Number(processWatch_(watch).logged) || 0; }
      catch (e) { errors.push({ watch_id: watch.watch_id, ticket_id: watch.ticket_id, message: e.message }); }
    });
    cleanupWatchTrigger_();
    return { checked: watches.length, logged: logged, errors: errors };
  }

  function installWatchTrigger() {
    requireAgent_();
    ensureWatchTrigger_();
    return { ok: true, mailbox_user: mailboxUser_() };
  }

  return {
    listWatches: listWatches,
    stopWatch: stopWatch,
    createFromEmail: createFromEmail,
    addToExisting: addToExisting,
    searchTickets: searchTickets,
    mergeTickets: mergeTickets,
    processWatchedThreads: processWatchedThreads,
    processPendingEnrichments: function (limit) { return processPendingEnrichments_(limit, '', {}); },
    processPendingEnrichmentsForTicket: function (ticketId, context) {
      context = Object.assign({}, context || {}, { skipAccessValidation: true });
      return processPendingEnrichments_(5, ticketId, context);
    },
    installWatchTrigger: installWatchTrigger,
    enrichImportedText: enrichImportedText,
    tokenizeImportedReferences: tokenizeImportedReferences
  };
})();

function projectTrackerHasChatCompletionWorkForCurrentUser_() {
  try {
    if (!TABS.CHAT_LINKS) return false;
    const me = String(Repo.me() || Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
    if (!me) return false;
    return Repo.readAll(TABS.CHAT_LINKS).some(function (row) {
      const enabled = row.notify_on_complete === true || row.notify_on_complete === 'TRUE' || row.notify_on_complete === 'true';
      return enabled && String(row.originator_email || '').toLowerCase().trim() === me;
    });
  } catch (e) {
    return false;
  }
}

function ensureProjectTrackerHourlyTrigger_() {
  const unified = 'processProjectTrackerHourlyJobs';
  const legacy = { processWatchedEmailThreads: true, processProjectTrackerChatCompletions: true };
  let triggers = ScriptApp.getProjectTriggers();
  let existing = triggers.filter(function (t) { return t.getHandlerFunction() === unified; })[0] || null;

  // Once the unified handler exists, remove our old single-purpose triggers.
  // If it doesn't exist yet, remove the known legacy trigger first so the
  // add-on has room to create the replacement.
  triggers.forEach(function (t) {
    if (legacy[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });

  if (!existing) {
    existing = ScriptApp.newTrigger(unified)
      .timeBased()
      .everyHours(Math.max(1, Number(CONFIG.EMAIL_WATCH_POLL_HOURS) || 1, Number(CONFIG.CHAT_COMPLETION_POLL_HOURS) || 1))
      .create();
  }
  return { ok: true, installed: true, handler: unified, user: String(Repo.me() || '').toLowerCase() };
}

function processProjectTrackerHourlyJobs() {
  const out = { gmail: null, gmailEnrichment: null, chat: null, chatAnnouncements: null, chatImports: null, errors: [] };
  try { out.gmail = GmailTicketing.processWatchedThreads(); }
  catch (e) { out.errors.push({ job: 'gmail', message: e.message }); Logger.log('Hourly Gmail job failed: %s', e.stack || e.message); }
  try { out.gmailEnrichment = GmailTicketing.processPendingEnrichments(10); }
  catch (e) { out.errors.push({ job: 'gmailEnrichment', message: e.message }); Logger.log('Hourly Gmail enrichment job failed: %s', e.stack || e.message); }
  try {
    if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processPendingImports) {
      out.chatImports = ChatTicketing.processPendingImports(30);
    }
  } catch (e) { out.errors.push({ job: 'chatImports', message: e.message }); Logger.log('Hourly Chat import job failed: %s', e.stack || e.message); }
  try {
    if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processMyCreationAnnouncements) {
      out.chatAnnouncements = ChatTicketing.processMyCreationAnnouncements();
    }
  } catch (e) { out.errors.push({ job: 'chatAnnouncements', message: e.message }); Logger.log('Hourly Chat creation-announcement job failed: %s', e.stack || e.message); }
  try {
    if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processMyCompletionNotifications) {
      out.chat = ChatTicketing.processMyCompletionNotifications();
    }
  } catch (e) { out.errors.push({ job: 'chat', message: e.message }); Logger.log('Hourly Chat job failed: %s', e.stack || e.message); }
  return out;
}

// Manual/test entry points remain available.
function processWatchedEmailThreads() {
  return GmailTicketing.processWatchedThreads();
}

function processPendingChatSharing() {
  const out = { announcements: null, completions: null, errors: [] };
  try {
    if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processMyCreationAnnouncements) out.announcements = ChatTicketing.processMyCreationAnnouncements();
  } catch (e) { out.errors.push({ job: 'announcements', message: e.message }); }
  try {
    if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processMyCompletionNotifications) out.completions = ChatTicketing.processMyCompletionNotifications();
  } catch (e) { out.errors.push({ job: 'completions', message: e.message }); }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function installMyGmailWatchTrigger() {
  return GmailTicketing.installWatchTrigger();
}

/**
 * One-time migration/repair helper for the shared Project Tracker hourly job.
 * It removes only Project Tracker's known legacy hourly handlers and replaces
 * them with the unified Gmail + Chat handler.
 */
function repairProjectTrackerHourlyTrigger() {
  Repo.requireAccess('agent');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === 'processWatchedEmailThreads' || h === 'processProjectTrackerChatCompletions' || h === 'processProjectTrackerHourlyJobs') {
      ScriptApp.deleteTrigger(t);
    }
  });
  return ensureProjectTrackerHourlyTrigger_();
}

function repairEmailWatchTrigger() {
  return repairProjectTrackerHourlyTrigger();
}
