/**
 * Project Tracker — step 1 prototype
 * Archives a Gmail thread to the shared drive as a readable Google Doc
 * with inline images preserved, plus raw .eml files and extracted attachments.
 *
 * Requires advanced services: Gmail, Drive (v3)
 */



// ---------------------------------------------------------------------------
// RUN THIS. Edit the query, pick Run > testArchive, then check the execution log.
// ---------------------------------------------------------------------------

function testArchive() {
  const query = 'has:attachment';   // <-- EDIT ME

  const threads = GmailApp.search(query, 0, 1);
  if (!threads.length) {
    Logger.log('No thread matched: ' + query);
    return;
  }

  Logger.log('Matched: "%s"', threads[0].getFirstMessageSubject());
  const result = archiveThread(threads[0].getId(), 'TEST-0001');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('\nOpen the doc: https://docs.google.com/document/d/' + result.docId);
}


// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function archiveThread(threadId, ticketId) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('Thread not found: ' + threadId);

  const folderId = ensureFolder(CONFIG.TICKETS_FOLDER_ID, ticketId);
  const gmailMessages = thread.getMessages();
  const subject = thread.getFirstMessageSubject() || '(no subject)';
  const slug = makeSlug(subject);

  const report = {
    ticketId: ticketId,
    subject: subject,
    messageCount: gmailMessages.length,
    folderId: folderId,
    inlineImages: 0,
    inlineBytes: 0,
    attachments: [],
    skipped: [],
    remoteImages: 0,
    trimmedChars: 0
  };

  const sections = [];

  for (let i = 0; i < gmailMessages.length; i++) {
    const gm = gmailMessages[i];
    const messageId = gm.getId();

    const full = Gmail.Users.Messages.get('me', messageId, { format: 'full' });
    const parts = flattenParts(full.payload, []);

    let html = extractBody(messageId, parts);

    // The first message is never a reply, so anything quoted inside it is
    // a forward — that content is the substance and must be kept.
    if (i > 0) {
      const stripped = stripQuotedHistory(html);
      html = stripped.html;
      report.trimmedChars += stripped.trimmed;
    }

    const cidMap = collectInlineImages(messageId, parts, report);
    html = rewriteCidRefs(html, cidMap, report);
    report.remoteImages += countRemoteImages(html);

    sections.push(buildMessageSection(gm, html, i + 1, gmailMessages.length));

    saveRaw(folderId, gm, slug, i + 1);
    saveAttachments(folderId, messageId, parts, report);
  }

  const docHtml = wrapDocument(subject, sections.join('\n<hr/>\n'));
  report.docBytes = Utilities.newBlob(docHtml).getBytes().length;
  report.docId = createDoc(folderId, slug, docHtml);

  return report;
}


// ---------------------------------------------------------------------------
// MIME walking
// ---------------------------------------------------------------------------

function flattenParts(part, out) {
  if (!part) return out;
  out.push(part);
  if (part.parts) part.parts.forEach(function (p) { flattenParts(p, out); });
  return out;
}

function getHeader(part, name) {
  if (!part.headers) return '';
  const lower = name.toLowerCase();
  for (let i = 0; i < part.headers.length; i++) {
    if (part.headers[i].name.toLowerCase() === lower) return part.headers[i].value;
  }
  return '';
}

/** Body data can live inline or behind an attachmentId when it's large. */
function decodeB64(data) {
  if (!data) return null;

  // The advanced Gmail service auto-decodes byte fields, so this is
  // usually already a byte array. Only strings need decoding.
  if (typeof data !== 'string') return data;

  var s = data.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  var rem = s.length % 4;
  if (rem === 2) s += '==';
  else if (rem === 3) s += '=';

  try {
    return Utilities.base64Decode(s);
  } catch (e) {
    Logger.log('decode failed on %s chars', s.length);
    return null;
  }
}

function inspectThread() {
  var threadId = 'PASTE_ID_HERE';   // same ID you used before

  var msgs = GmailApp.getThreadById(threadId).getMessages();
  Logger.log('%s messages', msgs.length);

  msgs.forEach(function (gm, i) {
    var full = Gmail.Users.Messages.get('me', gm.getId(), { format: 'full' });
    var parts = flattenParts(full.payload, []);
    Logger.log('--- message %s: %s parts', i + 1, parts.length);

    parts.forEach(function (p) {
      var d = (p.body && p.body.data) || '';
      var dLen = d.length || 0;
      var dKind = typeof d === 'string' ? 'string' : (dLen ? 'bytes' : '-');
      var hasAtt = (p.body && p.body.attachmentId) ? ' [attachmentId]' : '';

      Logger.log('  %s | file=%s | size=%s | cid=%s | %s %s%s',
        p.mimeType,
        p.filename || '-',
        (p.body && p.body.size) || 0,
        getHeader(p, 'Content-ID') || '-',
        dLen,
        dKind,
        hasAtt);
    });
  });
}

function stripQuotedHistory(html) {
  var markers = [
    '<div class="gmail_quote',
    '<blockquote class="gmail_quote',
    '<div id="divRplyFwdMsg"',
    '<div id="mail-editor-reference-message-container"',
    '<div class="moz-cite-prefix"',
    '<div class="yahoo_quoted',
    '<blockquote type="cite"',
    '-----Original Message-----',
    '________________________________'
  ];

  var cut = -1;
  var lower = html.toLowerCase();

  for (var i = 0; i < markers.length; i++) {
    var at = lower.indexOf(markers[i].toLowerCase());
    if (at > 0 && (cut === -1 || at < cut)) cut = at;
  }

  if (cut === -1) return { html: html, trimmed: 0 };

  return {
    html: html.substring(0, cut) +
          '<p style="font-size:8pt;color:#999">[earlier messages trimmed — see the messages above]</p>',
    trimmed: html.length - cut
  };
}

function readPartBytes(messageId, part) {
  if (part.body && part.body.data) {
    return decodeB64(part.body.data);
  }
  if (part.body && part.body.attachmentId) {
    var att = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId);
    return decodeB64(att.data);
  }
  return null;
}

function extractBody(messageId, parts) {
  let htmlPart = null;
  let textPart = null;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.filename) continue;
    if (p.mimeType === 'text/html' && !htmlPart) htmlPart = p;
    if (p.mimeType === 'text/plain' && !textPart) textPart = p;
  }

  if (htmlPart) {
    const bytes = readPartBytes(messageId, htmlPart);
    if (bytes) return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
  if (textPart) {
    const bytes = readPartBytes(messageId, textPart);
    if (bytes) {
      const text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
      return '<pre style="white-space:pre-wrap;font-family:inherit">' + escapeHtml(text) + '</pre>';
    }
  }
  return '<p><em>(no readable body)</em></p>';
}


// ---------------------------------------------------------------------------
// Inline images
// ---------------------------------------------------------------------------

function collectInlineImages(messageId, parts, report) {
  const map = {};

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.mimeType || p.mimeType.indexOf('image/') !== 0) continue;

    const cidRaw = getHeader(p, 'Content-ID');
    const disposition = getHeader(p, 'Content-Disposition');
    const isInline = cidRaw || disposition.toLowerCase().indexOf('inline') === 0;
    if (!isInline) continue;

    const size = (p.body && p.body.size) || 0;
    if (report.inlineBytes + size > CONFIG.MAX_TOTAL_INLINE_BYTES) {
      report.skipped.push({ reason: 'inline budget exceeded', name: p.filename, bytes: size });
      continue;
    }

    const bytes = readPartBytes(messageId, p);
    if (!bytes) continue;

    const dataUri = 'data:' + p.mimeType + ';base64,' + Utilities.base64Encode(bytes);
    const cid = cidRaw.replace(/^<|>$/g, '').trim();

    if (cid) map[cid] = dataUri;
    if (p.filename) map['@name:' + p.filename] = dataUri;

    report.inlineImages++;
    report.inlineBytes += bytes.length;
  }

  return map;
}

function rewriteCidRefs(html, cidMap, report) {
  return html.replace(/src\s*=\s*(["'])cid:([^"']+)\1/gi, function (match, quote, cid) {
    const key = decodeURIComponent(cid).trim();
    if (cidMap[key]) return 'src=' + quote + cidMap[key] + quote;
    report.skipped.push({ reason: 'unmatched cid', cid: key });
    return match;
  });
}

function countRemoteImages(html) {
  const matches = html.match(/<img[^>]+src\s*=\s*["']https?:/gi);
  return matches ? matches.length : 0;
}


// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function buildMessageSection(gm, bodyHtml, index, total) {
  const meta =
    '<p style="font-size:9pt;color:#666;margin:0 0 2pt 0">' +
    '<b>' + escapeHtml(gm.getFrom()) + '</b><br/>' +
    'To: ' + escapeHtml(gm.getTo()) + '<br/>' +
    escapeHtml(Utilities.formatDate(gm.getDate(), Session.getScriptTimeZone(), 'EEE d MMM yyyy, h:mm a')) +
    ' &nbsp;·&nbsp; message ' + index + ' of ' + total +
    '</p>';
  return meta + '<div>' + bodyHtml + '</div>';
}

function wrapDocument(subject, inner) {
  return '<html><head><meta charset="utf-8"></head><body>' +
    '<h2>' + escapeHtml(subject) + '</h2>' +
    inner +
    '</body></html>';
}

function createDoc(folderId, slug, html) {
  const blob = Utilities.newBlob(html, 'text/html', slug + '.html');
  const file = Drive.Files.create(
    { name: slug, mimeType: 'application/vnd.google-apps.document', parents: [folderId] },
    blob,
    { supportsAllDrives: true }
  );
  return file.id;
}


// ---------------------------------------------------------------------------
// Raw messages and attachments
// ---------------------------------------------------------------------------

function saveRaw(folderId, gm, slug, index) {
  const raw = gm.getRawContent();
  const blob = Utilities.newBlob(raw, 'message/rfc822', slug + '-' + pad(index) + '.eml');
  Drive.Files.create(
    { name: blob.getName(), parents: [folderId] },
    blob,
    { supportsAllDrives: true }
  );
}

function saveAttachments(folderId, messageId, parts, report) {
  const attFolderId = ensureFolder(folderId, 'attachments');

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.filename) continue;
    if (getHeader(p, 'Content-ID')) continue;   // inline, already embedded

    const bytes = readPartBytes(messageId, p);
    if (!bytes) continue;

    const blob = Utilities.newBlob(bytes, p.mimeType || 'application/octet-stream', p.filename);
    Drive.Files.create(
      { name: p.filename, parents: [attFolderId] },
      blob,
      { supportsAllDrives: true }
    );
    report.attachments.push({ name: p.filename, bytes: bytes.length, type: p.mimeType });
  }
}


// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

function ensureFolder(parentId, name) {
  const q = "name = '" + name.replace(/'/g, "\\'") + "'" +
    " and '" + parentId + "' in parents" +
    " and mimeType = 'application/vnd.google-apps.folder'" +
    " and trashed = false";

  const res = Drive.Files.list({
    q: q,
    corpora: 'allDrives',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id,name)'
  });

  if (res.files && res.files.length) return res.files[0].id;

  const created = Drive.Files.create(
    { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    null,
    { supportsAllDrives: true }
  );
  return created.id;
}


// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function makeSlug(subject) {
  const cleaned = subject
    .replace(/^(re|fwd|fw)\s*:\s*/gi, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return (cleaned || 'thread').substring(0, 60);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function listRecentThreads() {
  const threads = GmailApp.getInboxThreads(0, 15);
  threads.forEach(function (t) {
    Logger.log('%s  |  %s  |  %s',
      t.getId(),
      Utilities.formatDate(t.getLastMessageDate(), Session.getScriptTimeZone(), 'd MMM'),
      t.getFirstMessageSubject());
  });
}

function archiveSpecificThread() {
  const threadId = '19fda54835dca7de';   // <-- from listRecentThreads

  const result = archiveThread(threadId, 'TEST-0001');
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('Doc: https://docs.google.com/document/d/' + result.docId);
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}
