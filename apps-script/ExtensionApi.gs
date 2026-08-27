/** Project Tracker — Chrome extension bridge. */
const ExtensionApi = (function () {
  function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
  function publicTicket_(t) {
    if (!t) return null;
    return {
      ticket_id: t.ticket_id,
      title: t.title,
      status: t.status,
      substatus: t.substatus,
      owners: t.owners,
      size: t.size,
      type: t.type,
      department: t.department,
      progress: Number(t.progress) || 0,
      due_date: t.due_date || '',
      last_activity_at: t.last_activity_at || '',
      high_priority: bool_(t.high_priority)
    };
  }
  function pageRows_(status, opts) {
    const out = Tickets.listPage(status, Object.assign({ offset: 0, limit: 30, sort: 'due_asc' }, opts || {}));
    return (out.rows || []).map(publicTicket_).filter(Boolean);
  }
  function bootstrap() {
    const user = Repo.requireAccess('agent');
    const mine = pageRows_('in_progress', { owner: user.email });
    const mentioned = pageRows_('in_progress', { mentioned: true });
    return {
      me: user.email,
      role: user.role,
      appUrl: PropertiesService.getScriptProperties().getProperty('PROJECT_TRACKER_WEB_APP_URL') || ScriptApp.getService().getUrl() || '',
      mine: mine,
      mentioned: mentioned,
      agents: Repo.activeAgents().map(function (a) { return { email: a.email, name: a.display_name, role: a.role }; }),
      types: Repo.activeTypes().map(function (t) { return { name: t.type_name, defaultSize: t.default_size }; }),
      departments: Repo.activeDepartments().map(function (d) { return d.dept_name; }),
      sizes: Repo.sizes().map(function (s) { return { code: s.code, label: s.label, guidance: s.time_guidance }; })
    };
  }
  function search(q) {
    const out = Tickets.globalSearch({ q: q || '', limit: 40, includeArchived: false });
    return { rows: (out.rows || []).map(function (r) {
      return {
        ticket_id: r.ticket_id,
        title: r.title,
        status: r.status,
        owners: r.owners,
        size: r.size,
        type: r.type,
        department: r.department,
        progress: Number(r.progress) || 0,
        matchLabel: r.matchLabel || r.match_label || '',
        snippet: r.snippet || ''
      };
    }), total: Number(out.total) || 0 };
  }
  function safeUrl_(value) {
    const s = String(value || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }
  function sourceToken_(url, title) {
    url = safeUrl_(url);
    if (!url) return '';
    return '[src:' + encodeURIComponent(url) + '|' + encodeURIComponent(String(title || url).slice(0, 500)) + ']';
  }
  function quoteMarkup_(quote) {
    quote = String(quote || '').trim();
    return quote ? '[quote:' + encodeURIComponent(quote) + ']' : '';
  }
  function screenshotRows_(payload) {
    const rows = Array.isArray(payload && payload.screenshots) ? payload.screenshots.slice(0, 6) : [];
    if (!rows.length && payload && payload.screenshotDataUrl) rows.push({ dataUrl: payload.screenshotDataUrl, sourceUrl: payload.sourceUrl, sourceTitle: payload.sourceTitle });
    return rows.filter(function (x) { return x && String(x.dataUrl || '').trim(); });
  }
  function buildMarkup_(payload, shots) {
    const parts = [];
    const note = String(payload.note || '').trim();
    if (note) parts.push(note);
    const q = quoteMarkup_(payload.quote);
    if (q) parts.push(q);
    shots.forEach(function (shot, index) {
      parts.push('[imgtmp:browser_shot_' + (index + 1) + ']');
      const src = sourceToken_(shot.sourceUrl || payload.sourceUrl, shot.sourceTitle || payload.sourceTitle);
      if (src) parts.push(src);
    });
    if (!shots.length) {
      const src = sourceToken_(payload.sourceUrl, payload.sourceTitle);
      if (src) parts.push(src);
    }
    return parts.join('\n\n');
  }
  function buildPlainText_(payload, shots) {
    const parts = [];
    if (payload.note) parts.push(String(payload.note).trim());
    if (payload.quote) parts.push('Quoted from page:\n' + String(payload.quote).trim());
    shots.forEach(function (shot, index) {
      parts.push('Screenshot ' + (index + 1) + ' attached.');
      const url = safeUrl_(shot.sourceUrl || payload.sourceUrl);
      if (url) parts.push('Source: ' + String(shot.sourceTitle || payload.sourceTitle || url) + ' — ' + url);
    });
    if (!shots.length && payload.sourceUrl) parts.push('Source: ' + String(payload.sourceTitle || payload.sourceUrl) + ' — ' + String(payload.sourceUrl));
    return parts.join('\n\n').trim();
  }
  function imageFile_(shot, index) {
    const s = String(shot && shot.dataUrl || '');
    const m = s.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1];
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm-ss');
    return {
      temp_id: 'browser_shot_' + index,
      name: 'Browser screenshot ' + stamp + (index > 1 ? ' ' + index : '') + '.' + ext,
      original_name: 'browser-screenshot-' + index + '.' + ext,
      mime_type: mime,
      inline: true,
      base64: m[2]
    };
  }
  function addDetectedContext_(ticketId, url) {
    url = safeUrl_(url);
    if (!url) return { student: false, resource: false };
    const out = { student: false, resource: false };
    try {
      if (typeof Element451 !== 'undefined' && Element451.extractElementIdFromUrl) {
        const id = Element451.extractElementIdFromUrl(url);
        if (id) {
          RelatedStudents.addByUrl(ticketId, url);
          out.student = true;
          return out;
        }
      }
    } catch (ignore) {}
    try {
      RelatedResources.addUrl(ticketId, url);
      out.resource = true;
    } catch (ignore) {}
    return out;
  }
  function capture(payload) {
    Repo.requireAccess('agent');
    payload = payload || {};
    const ticketId = String(payload.ticketId || '').trim();
    if (!ticketId) throw new Error('Choose a Project Tracker ticket.');
    const shots = screenshotRows_(payload);
    const files = shots.map(function (shot, i) { return imageFile_(shot, i + 1); }).filter(Boolean);
    const markup = buildMarkup_(payload, shots);
    const text = buildPlainText_(payload, shots);
    if (!text && !markup) throw new Error('There is nothing to add to the ticket.');
    const refMeta = {
      source: 'chrome_extension',
      source_url: safeUrl_(payload.sourceUrl),
      source_title: String(payload.sourceTitle || '').slice(0, 500),
      captured_at: Repo.now(),
      screenshot_count: files.length,
      had_screenshot: files.length > 0,
      had_quote: !!String(payload.quote || '').trim(),
      screenshot_sources: shots.map(function (shot) { return { url: safeUrl_(shot.sourceUrl), title: String(shot.sourceTitle || '').slice(0, 500), captured_at: String(shot.capturedAt || '') }; })
    };
    const activity = Tickets.addRichNote(ticketId, {
      text: text,
      markup: markup,
      ref: 'browser:' + JSON.stringify(refMeta),
      files: files
    }, '', '', { skipAutoSync: true, skipRelationLists: true });
    const context = { student: false, resource: false };
    if (payload.addPageContext !== false) {
      const urls = [payload.sourceUrl].concat(shots.map(function (shot) { return shot.sourceUrl; })).filter(Boolean);
      const seen = {};
      urls.forEach(function (url) {
        url = safeUrl_(url);
        if (!url || seen[url]) return;
        seen[url] = true;
        const one = addDetectedContext_(ticketId, url);
        context.student = context.student || one.student;
        context.resource = context.resource || one.resource;
      });
    }
    return { ok: true, ticketId: ticketId, activityId: activity.activity_id, context: context, screenshotCount: files.length };
  }
  function createFromPage(payload) {
    Repo.requireAccess('agent');
    payload = payload || {};
    const ticket = Tickets.create({
      title: String(payload.title || payload.sourceTitle || '(untitled)').trim(),
      description: String(payload.description || '').trim(),
      type: String(payload.type || '').trim(),
      department: String(payload.department || '').trim(),
      size: String(payload.size || '').trim(),
      owners: payload.owners || '',
      status: 'in_progress',
      _creationSource: 'chrome_extension'
    });
    const capturePayload = Object.assign({}, payload, { ticketId: ticket.ticket_id });
    if (payload.sourceUrl || payload.note || payload.quote || payload.screenshotDataUrl || (payload.screenshots && payload.screenshots.length)) capture(capturePayload);
    return { ticket: publicTicket_(ticket) };
  }
  function handleGet(params) {
    const action = String(params.action || 'bootstrap');
    if (action === 'bootstrap') return bootstrap();
    if (action === 'search') return search(params.q || '');
    if (action === 'ping') { const user = Repo.requireAccess('agent'); return { ok: true, me: user.email }; }
    throw new Error('Unknown extension action: ' + action);
  }
  function handlePost(body) {
    const action = String(body && body.action || '');
    if (action === 'capture') return capture(body);
    if (action === 'create') return createFromPage(body);
    throw new Error('Unknown extension action: ' + action);
  }
  return { handleGet: handleGet, handlePost: handlePost, bootstrap: bootstrap, search: search, capture: capture, createFromPage: createFromPage };
})();
