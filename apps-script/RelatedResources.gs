/** Project Tracker — Related Resources, Drive uploads, and resource nesting. */
const RelatedResources = (function () {

  const TYPES = Object.freeze({
    WORKFLOW: 'workflow',
    RULE: 'rule',
    SEGMENT: 'segment',
    GOOGLE_DOC: 'google_doc',
    GOOGLE_SHEET: 'google_sheet',
    FORM: 'form',
    CAMPAIGN: 'campaign',
    IMPORT: 'import',
    EXPORT: 'export',
    EVENT: 'event',
    GOOGLE_APPS_SCRIPT: 'google_apps_script',
    ATTACHMENT: 'attachment',
    INLINE_IMAGE: 'inline_image'
  });

  function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }


  function resourceNeedsNameRefresh_(r) {
    const type = String(r && r.resource_type || '');
    const elementNamed = [
      TYPES.WORKFLOW, TYPES.RULE, TYPES.SEGMENT, TYPES.FORM,
      TYPES.CAMPAIGN, TYPES.IMPORT, TYPES.EXPORT, TYPES.EVENT
    ].indexOf(type) !== -1;
    if (!elementNamed) return false;
    const name = String(r && r.name || '').trim().toLowerCase();
    const external = String(r && r.external_id || '').trim().toLowerCase();
    return bool_(r && r.unresolved_name) || !name || (!!external && name === external);
  }

  function ticket_(ticketId, fast) {
    const finder = fast && Repo.findOneFast ? Repo.findOneFast : Repo.findOne;
    const t = finder(TABS.TICKETS, 'ticket_id', ticketId);
    if (!t) throw new Error('No such ticket: ' + ticketId);
    return t;
  }

  function allRows_(ticketId, fast) {
    return fast && Repo.findAllFast
      ? Repo.findAllFast(TABS.RELATED_RESOURCES, 'ticket_id', ticketId)
      : Repo.findAll(TABS.RELATED_RESOURCES, 'ticket_id', ticketId);
  }

  function uniqueActiveRows_(rows) {
    const out = [], seen = {};
    (rows || []).forEach(function (r) {
      if (bool_(r.removed)) return;
      const key = String(r.canonical_key || '').trim();
      if (!key) { out.push(r); return; }
      if (seen[key]) return;
      seen[key] = true;
      out.push(r);
    });
    return out;
  }

  function activeRows_(ticketId, fast) { return uniqueActiveRows_(allRows_(ticketId, !!fast)); }

  function public_(r) {
    return {
      resource_id: r.resource_id,
      ticket_id: r.ticket_id,
      resource_type: r.resource_type,
      external_id: r.external_id,
      name: r.name,
      url: r.url,
      drive_file_id: r.drive_file_id,
      mime_type: r.mime_type,
      parent_resource_id: r.parent_resource_id,
      depth: Number(r.depth) || 0,
      activity_id: r.activity_id,
      visible_in_card: bool_(r.visible_in_card),
      unresolved_name: bool_(r.unresolved_name),
      preview_url: r.drive_file_id ? drivePreviewUrl_(r.drive_file_id) : '',
      thumbnail_url: r.drive_file_id && String(r.mime_type || '').indexOf('image/') === 0 ? driveThumbnailUrl_(r.drive_file_id) : '',
      download_url: r.drive_file_id ? driveDownloadUrl_(r.drive_file_id) : ''
    };
  }

  function snapshotFromRows_(rows) {
    return {
      resources: uniqueActiveRows_(rows).map(public_),
      resourceTokens: (rows || []).map(public_)
    };
  }

  /** Read related-resource rows once and derive both current and historical-token views. */
  function snapshot(ticketId, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('viewer');
    if (!opts.skipTicketValidation) ticket_(ticketId);
    return snapshotFromRows_(allRows_(ticketId, !!opts.fast));
  }

  function listAll(ticketId) {
    return snapshot(ticketId).resources;
  }

  /** Includes soft-removed rows so historical note tokens keep names/links. */
  function listForTokens(ticketId) {
    return snapshot(ticketId).resourceTokens;
  }

  function listCard(ticketId) {
    return listAll(ticketId).filter(function (r) { return r.visible_in_card; });
  }

  function canonical_(type, externalId, url, driveId) {
    if (driveId) return 'drive:' + driveId;
    if (externalId) return 'element:' + type + ':' + String(externalId).toLowerCase();
    return 'url:' + String(url || '').trim().toLowerCase();
  }

  function driveViewUrl_(id) { return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view'; }
  function drivePreviewUrl_(id) { return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview'; }
  function driveDownloadUrl_(id) { return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id); }
  function driveThumbnailUrl_(id) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1200'; }

  function extractKnownUrls_(text) {
    text = String(text || '');
    const out = [], seen = {};
    const re = /https?:\/\/[^\s<>\"]+/ig;
    let m;
    while ((m = re.exec(text)) !== null) {
      const url = String(m[0] || '').replace(/[),.;!?]+$/g, '');
      let parsed = element451ParseResourceUrl_(url);
      if (!parsed) {
        let g;
        if ((g = url.match(/^https?:\/\/docs\.google\.com\/(spreadsheets|document)\/d\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/i))) {
          parsed = { type: g[1] === 'spreadsheets' ? TYPES.GOOGLE_SHEET : TYPES.GOOGLE_DOC, external_id: g[2], drive_id: g[2] };
        } else if ((g = url.match(/^https?:\/\/script\.google\.com\/home\/projects\/([a-zA-Z0-9_-]+)(?:\/edit)?(?:[/?#]|$)/i))) {
          parsed = { type: TYPES.GOOGLE_APPS_SCRIPT, external_id: g[1] };
        }
      }
      if (!parsed) continue;
      const key = canonical_(parsed.type, parsed.external_id, url, parsed.drive_id || '');
      if (!seen[key]) {
        seen[key] = true;
        out.push({ type: parsed.type, external_id: parsed.external_id, url: url, canonical_key: key });
      }
    }
    return out;
  }

  function resolve_(parsed) {
    if (parsed.type === TYPES.SEGMENT) {
      const x = Element451.lookupSegment(parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.WORKFLOW || parsed.type === TYPES.RULE) {
      const x = Element451.lookupAutomation(parsed.type, parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.FORM) {
      const x = Element451.lookupForm(parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.CAMPAIGN) {
      const x = Element451.lookupCampaign(parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.IMPORT || parsed.type === TYPES.EXPORT) {
      const x = Element451.lookupImportExportTask(parsed.type, parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.EVENT) {
      const x = Element451.lookupEvent(parsed.external_id);
      return { name: x.name, unresolved_name: !!x.unresolved };
    }
    if (parsed.type === TYPES.GOOGLE_DOC || parsed.type === TYPES.GOOGLE_SHEET) {
      const file = Drive.Files.get(parsed.external_id, { supportsAllDrives: true, fields: 'id,name,mimeType,webViewLink' });
      return { name: file.name || parsed.external_id, url: file.webViewLink || parsed.url, mime_type: file.mimeType || '', unresolved_name: false };
    }
    if (parsed.type === TYPES.GOOGLE_APPS_SCRIPT) {
      const file = Drive.Files.get(parsed.external_id, { supportsAllDrives: true, fields: 'id,name,mimeType' });
      return { name: file.name || parsed.external_id, url: parsed.url, mime_type: file.mimeType || 'application/vnd.google-apps.script', unresolved_name: false };
    }
    return { name: parsed.external_id || parsed.url || 'Resource', unresolved_name: false };
  }

  function upsertExternal_(ticketId, parsed, source, manual) {
    ticket_(ticketId);
    let existing = allRows_(ticketId).filter(function (r) { return r.canonical_key === parsed.canonical_key; })[0];
    if (existing) {
      if (bool_(existing.removed) && manual) {
        const restored = Repo.update(TABS.RELATED_RESOURCES, 'resource_id', existing.resource_id, { removed: false, removed_at: '' });
        return { resource: public_(restored), added: true };
      }
      return { resource: public_(existing), added: false, suppressed: bool_(existing.removed) };
    }

    let resolved;
    try { resolved = resolve_(parsed); }
    catch (e) { resolved = { name: parsed.external_id || parsed.url, unresolved_name: true }; }

    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      existing = allRows_(ticketId).filter(function (r) { return r.canonical_key === parsed.canonical_key; })[0];
      if (existing) {
        if (bool_(existing.removed) && manual) {
          const restored = Repo.update(TABS.RELATED_RESOURCES, 'resource_id', existing.resource_id, { removed: false, removed_at: '' });
          return { resource: public_(restored), added: true };
        }
        return { resource: public_(existing), added: false, suppressed: bool_(existing.removed) };
      }

      const row = {
        resource_id: Utilities.getUuid(),
        ticket_id: ticketId,
        resource_type: parsed.type,
        external_id: parsed.external_id || '',
        canonical_key: parsed.canonical_key,
        name: String(resolved.name || parsed.external_id || 'Resource').trim(),
        url: resolved.url || parsed.url || '',
        drive_file_id: (parsed.type === TYPES.GOOGLE_DOC || parsed.type === TYPES.GOOGLE_SHEET) ? parsed.external_id : '',
        mime_type: resolved.mime_type || '',
        parent_resource_id: '',
        depth: 0,
        sort_order: Date.now(),
        activity_id: '',
        visible_in_card: true,
        source: source || 'ticket_url',
        created_by: Repo.me(),
        created_at: Repo.now(),
        updated_at: Repo.now(),
        removed: false,
        removed_at: '',
        unresolved_name: !!resolved.unresolved_name
      };
      Repo.append(TABS.RELATED_RESOURCES, row);
      return { resource: public_(row), added: true };
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Add several supported URLs with one ticket/relationship read and one sheet
   * append. External name resolution still happens per distinct new resource,
   * but Gmail no longer repeats ticket validation + relationship scans for every
   * URL found in the same email thread.
   */
  function addUrlsBatch(ticketId, urls, options) {
    options = options || {};
    if (!options.skipAccessValidation) Repo.requireAccess('agent');
    if (!options.skipTicketValidation) ticket_(ticketId, !!options.fast);

    const parsed = [], parsedSeen = {};
    (urls || []).forEach(function (url) {
      extractKnownUrls_(String(url || '')).forEach(function (item) {
        if (!parsedSeen[item.canonical_key]) {
          parsedSeen[item.canonical_key] = true;
          parsed.push(item);
        }
      });
    });
    if (!parsed.length) return { added: 0, resources: [] };

    const existingRows = allRows_(ticketId, !!options.fast);
    const existing = {};
    existingRows.forEach(function (row) {
      const key = String(row.canonical_key || '').trim();
      if (key) existing[key] = row;
    });

    const candidates = [];
    parsed.forEach(function (item) {
      if (existing[item.canonical_key]) return; // Includes manually-removed rows: auto-import never restores them.
      let resolved;
      try { resolved = resolve_(item); }
      catch (e) { resolved = { name: item.external_id || item.url, unresolved_name: true }; }
      candidates.push({ parsed: item, resolved: resolved });
      existing[item.canonical_key] = true;
    });
    if (!candidates.length) return { added: 0, resources: [] };

    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const current = {};
      allRows_(ticketId, !!options.fast).forEach(function (row) {
        const key = String(row.canonical_key || '').trim();
        if (key) current[key] = true;
      });
      const now = Repo.now();
      const actor = Repo.me();
      const rows = [];
      candidates.forEach(function (candidate) {
        const item = candidate.parsed;
        const resolved = candidate.resolved || {};
        if (current[item.canonical_key]) return;
        current[item.canonical_key] = true;
        rows.push({
          resource_id: Utilities.getUuid(),
          ticket_id: ticketId,
          resource_type: item.type,
          external_id: item.external_id || '',
          canonical_key: item.canonical_key,
          name: String(resolved.name || item.external_id || 'Resource').trim(),
          url: resolved.url || item.url || '',
          drive_file_id: (item.type === TYPES.GOOGLE_DOC || item.type === TYPES.GOOGLE_SHEET) ? item.external_id : '',
          mime_type: resolved.mime_type || '',
          parent_resource_id: '',
          depth: 0,
          sort_order: Date.now() + rows.length,
          activity_id: '',
          visible_in_card: true,
          source: options.source || 'email_url',
          created_by: actor,
          created_at: now,
          updated_at: now,
          removed: false,
          removed_at: '',
          unresolved_name: !!resolved.unresolved_name
        });
      });
      if (rows.length) Repo.appendMany(TABS.RELATED_RESOURCES, rows);
      return { added: rows.length, resources: rows.map(public_) };
    } finally {
      lock.releaseLock();
    }
  }

  function syncFromTicket(ticketId, context) {
    context = context || {};
    if (!context.skipAccessValidation) Repo.requireAccess('agent');
    const contextTicket = context && context.ticket && String(context.ticket.ticket_id) === String(ticketId) ? context.ticket : null;
    const ticket = contextTicket || ticket_(ticketId);
    let relationshipRows = Array.isArray(context.resourceRows) ? context.resourceRows : allRows_(ticketId, !!context.fast);
    let relationshipsChanged = false;

    // Retry unresolved display names. This is intentionally non-destructive and
    // means a later resolver improvement can populate existing resources without
    // requiring users to remove and re-add them.
    uniqueActiveRows_(relationshipRows).filter(resourceNeedsNameRefresh_).forEach(function (r) {
      try {
        const resolved = resolve_({ type: r.resource_type, external_id: r.external_id, url: r.url, canonical_key: r.canonical_key });
        if (!resolved.unresolved_name && resolved.name && String(resolved.name).trim().toLowerCase() !== String(r.external_id || '').trim().toLowerCase()) {
          Repo.update(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id, {
            name: String(resolved.name),
            url: resolved.url || r.url,
            mime_type: resolved.mime_type || r.mime_type,
            unresolved_name: false,
            updated_at: Repo.now()
          });
          relationshipsChanged = true;
        }
      } catch (ignore) {}
    });

    const activityRows = context && Array.isArray(context.activityRows) ? context.activityRows : Repo.findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
    const notes = activityRows.filter(function (a) {
      return a.kind === ACTIVITY_KIND.NOTE && !bool_(a.deleted);
    });
    const texts = [String(ticket.description || '')].concat(notes.map(function (a) { return String(a.body || ''); }));
    const existing = {};
    relationshipRows.forEach(function (r) { existing[r.canonical_key] = true; });
    const found = {}, parsed = [];
    texts.forEach(function (text) {
      extractKnownUrls_(text).forEach(function (x) {
        if (!existing[x.canonical_key] && !found[x.canonical_key]) { found[x.canonical_key] = true; parsed.push(x); }
      });
    });
    const errors = [];
    parsed.slice(0, ELEMENT451_CONFIG.NOTE_SCAN_MAX_URLS || 30).forEach(function (x) {
      try {
        upsertExternal_(ticketId, x, 'ticket_url', false);
        relationshipsChanged = true;
      } catch (e) { errors.push({ url: x.url, message: e.message }); }
    });
    if (relationshipsChanged) relationshipRows = allRows_(ticketId, !!context.fast);
    const related = snapshotFromRows_(relationshipRows);
    return { rows: related.resources, resourceTokens: related.resourceTokens, errors: errors, changed: relationshipsChanged };
  }

  function normalizeLearnedName_(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function knownNameCatalog_() {
    const cacheKey = 'related_resource_name_catalog_v1';
    const cached = Repo.cacheGet(cacheKey);
    if (cached) return cached;
    const catalog = Repo.readAll(TABS.RELATED_RESOURCES).filter(function (r) {
      if (bool_(r.removed)) return false;
      if (r.resource_type === TYPES.ATTACHMENT || r.resource_type === TYPES.INLINE_IMAGE) return false;
      return normalizeLearnedName_(r.name).length >= 4 && !!String(r.canonical_key || '').trim();
    }).map(function (r) {
      return {
        resource_type: r.resource_type,
        external_id: r.external_id,
        canonical_key: r.canonical_key,
        name: r.name,
        url: r.url,
        drive_file_id: r.drive_file_id,
        mime_type: r.mime_type,
        unresolved_name: bool_(r.unresolved_name)
      };
    });
    // A short cache removes a complete RelatedResources-sheet read from every
    // Gmail capture while keeping newly learned names available quickly.
    Repo.cachePut(cacheKey, catalog, 120);
    return catalog;
  }

  /** Conservative bare-name matching used by Gmail capture. */
  function matchKnownNames(ticketId, text, options) {
    options = options || {};
    if (!options.skipAccessValidation) Repo.requireAccess('agent');
    if (!options.skipTicketValidation) ticket_(ticketId, !!options.fast);
    const haystack = ' ' + normalizeLearnedName_(text) + ' ';
    if (!haystack.trim()) return options.returnList === false ? { added: 0, resources: [] } : listAll(ticketId);

    const byName = {};
    knownNameCatalog_().forEach(function (r) {
      const name = normalizeLearnedName_(r.name);
      if (!byName[name]) byName[name] = { row: r, keys: {} };
      byName[name].keys[r.canonical_key] = true;
    });

    const existingRows = Array.isArray(options.rows) ? options.rows : allRows_(ticketId, !!options.fast);
    const existing = {};
    existingRows.forEach(function (r) { existing[String(r.canonical_key || '')] = true; });
    const matches = [];
    Object.keys(byName).sort(function (a, b) { return b.length - a.length; }).some(function (name) {
      if (matches.length >= 10) return true;
      const item = byName[name];
      if (Object.keys(item.keys).length !== 1) return false;
      if (haystack.indexOf(' ' + name + ' ') === -1) return false;
      const r = item.row;
      if (existing[r.canonical_key]) return false;
      existing[r.canonical_key] = true;
      matches.push(r);
      return false;
    });

    if (!matches.length) return options.returnList === false ? { added: 0, resources: [] } : listAll(ticketId);

    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    let rows = [];
    try {
      const current = {};
      allRows_(ticketId, !!options.fast).forEach(function (r) {
        const key = String(r.canonical_key || '');
        if (key) current[key] = true;
      });
      const now = Repo.now();
      const actor = Repo.me();
      matches.forEach(function (r) {
        if (current[r.canonical_key]) return;
        current[r.canonical_key] = true;
        rows.push({
          resource_id: Utilities.getUuid(),
          ticket_id: ticketId,
          resource_type: r.resource_type,
          external_id: r.external_id || '',
          canonical_key: r.canonical_key,
          name: String(r.name || r.external_id || 'Resource').trim(),
          url: r.url || '',
          drive_file_id: r.drive_file_id || '',
          mime_type: r.mime_type || '',
          parent_resource_id: '',
          depth: 0,
          sort_order: Date.now() + rows.length,
          activity_id: '',
          visible_in_card: true,
          source: 'email_name_match',
          created_by: actor,
          created_at: now,
          updated_at: now,
          removed: false,
          removed_at: '',
          unresolved_name: !!r.unresolved_name
        });
      });
      if (rows.length) Repo.appendMany(TABS.RELATED_RESOURCES, rows);
    } finally {
      lock.releaseLock();
    }
    if (options.returnList === false) return { added: rows.length, resources: rows.map(public_) };
    return listAll(ticketId);
  }

  function addUrl(ticketId, url) {
    Repo.requireAccess('agent');
    const found = extractKnownUrls_(String(url || '').trim());
    if (!found.length) throw new Error('That link is not a supported Related Resource URL.');
    return upsertExternal_(ticketId, found[0], 'manual_url', true);
  }

  function remove(ticketId, resourceId) {
    Repo.requireAccess('agent');
    const row = Repo.findOne(TABS.RELATED_RESOURCES, 'resource_id', resourceId);
    if (!row || row.ticket_id !== ticketId) throw new Error('Related resource not found.');
    Repo.update(TABS.RELATED_RESOURCES, 'resource_id', resourceId, {
      removed: true,
      removed_at: Repo.now(),
      parent_resource_id: '',
      depth: 0,
      updated_at: Repo.now()
    });
    // Children are un-nested rather than silently deleted.
    activeRows_(ticketId).filter(function (r) { return r.parent_resource_id === resourceId; }).forEach(function (child) {
      Repo.update(TABS.RELATED_RESOURCES, 'resource_id', child.resource_id, { parent_resource_id: '', depth: 0, updated_at: Repo.now() });
      recomputeDescendantDepths_(ticketId, child.resource_id, 0);
    });
    return listAll(ticketId);
  }

  function removeMany(ticketId, resourceIds) {
    Repo.requireAccess('agent');
    ticket_(ticketId);
    resourceIds = (resourceIds || []).map(String).filter(Boolean);
    if (!resourceIds.length) return listAll(ticketId);

    const selected = {}, rows = allRows_(ticketId), activeById = {}, patches = {}, now = Repo.now();
    resourceIds.forEach(function (id) { selected[id] = true; });
    rows.forEach(function (r) {
      if (!bool_(r.removed)) activeById[String(r.resource_id || '')] = r;
    });
    Object.keys(selected).forEach(function (id) {
      if (!activeById[id]) return;
      patches[id] = { removed: true, removed_at: now, parent_resource_id: '', depth: 0, updated_at: now };
    });

    rows.forEach(function (r) {
      const id = String(r.resource_id || ''), parentId = String(r.parent_resource_id || '');
      if (!id || bool_(r.removed) || selected[id]) return;
      // Preserve surviving subtrees: only direct children of removed resources are promoted.
      if (parentId && selected[parentId]) {
        patches[id] = Object.assign({}, patches[id] || {}, { parent_resource_id: '', depth: 0, updated_at: now });
      }
    });
    Repo.updateMany(TABS.RELATED_RESOURCES, 'resource_id', patches);

    // Recompute survivor depths after promotions.
    const survivors = allRows_(ticketId).filter(function (r) { return !bool_(r.removed); });
    const byId = {}, depthPatches = {};
    survivors.forEach(function (r) { byId[String(r.resource_id || '')] = r; });
    function depth_(row) {
      let d = 0, p = String(row.parent_resource_id || ''), guard = 0;
      while (p && byId[p] && guard++ < 10) { d++; p = String(byId[p].parent_resource_id || ''); }
      return Math.min(d, 3);
    }
    survivors.forEach(function (r) {
      const d = depth_(r);
      if (Number(r.depth) !== d) depthPatches[String(r.resource_id)] = { depth: d, updated_at: now };
    });
    Repo.updateMany(TABS.RELATED_RESOURCES, 'resource_id', depthPatches);
    return listAll(ticketId);
  }

  function ensureTicketResourceFolder_(ticketId, knownTicket) {
    const ticket = knownTicket || ticket_(ticketId, true);
    let ticketFolderId = String(ticket.drive_folder_id || '').trim();
    if (!ticketFolderId) {
      const folder = Drive.Files.create({
        name: ticket.ticket_id + ' - ' + String(ticket.title || 'Ticket').substring(0, 80),
        mimeType: 'application/vnd.google-apps.folder',
        parents: [CONFIG.TICKETS_FOLDER_ID]
      }, null, { supportsAllDrives: true });
      ticketFolderId = folder.id;
      Repo.update(TABS.TICKETS, 'ticket_id', ticketId, { drive_folder_id: ticketFolderId });
    }

    const key = 'resource_folder_' + ticketFolderId;
    const cached = CacheService.getScriptCache().get(key);
    if (cached) return cached;

    // Search children by exact name to avoid creating duplicates after cache expiry.
    const q = "'" + ticketFolderId.replace(/'/g, "\\'") + "' in parents and name = 'Resources' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    const listed = Drive.Files.list({ q: q, supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 10, fields: 'files(id,name)' });
    let id = listed.files && listed.files.length ? listed.files[0].id : '';
    if (!id) {
      id = Drive.Files.create({
        name: 'Resources',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [ticketFolderId]
      }, null, { supportsAllDrives: true }).id;
    }
    CacheService.getScriptCache().put(key, id, 21600);
    return id;
  }

  function normalizeUploadName_(name, originalName) {
    let n = String(name || '').trim().replace(/[\r\n\t]+/g, ' ').substring(0, 160);
    if (!n) n = String(originalName || 'Attachment').trim().substring(0, 160);
    return n || 'Attachment';
  }

  function uploadForActivity(ticketId, activityId, files, options) {
    options = options || {};
    if (!options.skipAccessValidation) Repo.requireAccess('agent');
    const knownTicket = options.ticket || null;
    if (!options.skipTicketValidation && !knownTicket) ticket_(ticketId, !!options.fast);
    files = Array.isArray(files) ? files : [];
    if (!files.length) return { resources: [], tempMap: {} };

    let total = 0;
    files.forEach(function (f) {
      const b64 = String(f.base64 || '').replace(/^data:[^;]+;base64,/, '');
      const estimated = Math.floor(b64.length * 3 / 4);
      total += estimated;
      if (estimated > CONFIG.MAX_ATTACHMENT_FILE_BYTES) throw new Error('One attachment is larger than the per-file upload limit.');
    });
    if (total > CONFIG.MAX_TOTAL_INLINE_BYTES) throw new Error('Attachments in one note exceed the total upload limit.');

    const folderId = ensureTicketResourceFolder_(ticketId, knownTicket);
    const created = [], rows = [], tempMap = {};
    try {
      files.forEach(function (f) {
        const b64 = String(f.base64 || '').replace(/^data:[^;]+;base64,/, '');
        const bytes = Utilities.base64Decode(b64);
        const mime = String(f.mime_type || 'application/octet-stream').substring(0, 120);
        const original = String(f.original_name || f.name || 'attachment').substring(0, 180);
        const display = normalizeUploadName_(f.name, original);
        const blob = Utilities.newBlob(bytes, mime, original);
        const driveFile = Drive.Files.create({ name: display, parents: [folderId] }, blob, { supportsAllDrives: true, fields: 'id,name,mimeType,webViewLink' });
        created.push(driveFile.id);

        const inline = !!f.inline;
        const resourceId = Utilities.getUuid();
        const row = {
          resource_id: resourceId,
          ticket_id: ticketId,
          resource_type: inline ? TYPES.INLINE_IMAGE : TYPES.ATTACHMENT,
          external_id: '',
          canonical_key: canonical_(inline ? TYPES.INLINE_IMAGE : TYPES.ATTACHMENT, '', '', driveFile.id),
          name: display,
          url: driveFile.webViewLink || driveViewUrl_(driveFile.id),
          drive_file_id: driveFile.id,
          mime_type: driveFile.mimeType || mime,
          parent_resource_id: '',
          depth: 0,
          sort_order: Date.now() + rows.length,
          activity_id: activityId,
          visible_in_card: !inline,
          source: inline ? 'clipboard_image' : 'note_attachment',
          created_by: Repo.me(),
          created_at: Repo.now(),
          updated_at: Repo.now(),
          removed: false,
          removed_at: '',
          unresolved_name: false
        };
        rows.push(row);
        if (f.temp_id) tempMap[String(f.temp_id)] = resourceId;
      });
      Repo.appendMany(TABS.RELATED_RESOURCES, rows);
      return { resources: rows.map(public_), tempMap: tempMap };
    } catch (e) {
      created.forEach(function (id) {
        try { Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true }); } catch (ignore) {}
      });
      rows.forEach(function (r) {
        try { Repo.remove(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id); } catch (ignore) {}
      });
      throw e;
    }
  }

  /** Link an existing Drive file to one imported activity without copying it. */
  function addExistingDriveFile(ticketId, activityId, driveFileId, source, inline) {
    Repo.requireAccess('agent');
    ticket_(ticketId);
    const id = String(driveFileId || '').trim();
    if (!id) throw new Error('Missing Drive file ID.');
    const f = Drive.Files.get(id, {
      supportsAllDrives: true,
      fields: 'id,name,mimeType,webViewLink'
    });
    inline = inline === undefined || inline === null ? /^image\//i.test(String(f.mimeType || '')) : !!inline;
    const now = Repo.now();
    const row = {
      resource_id: Utilities.getUuid(),
      ticket_id: ticketId,
      resource_type: inline ? TYPES.INLINE_IMAGE : TYPES.ATTACHMENT,
      external_id: '',
      canonical_key: canonical_(inline ? TYPES.INLINE_IMAGE : TYPES.ATTACHMENT, '', '', id) + '|activity:' + String(activityId || ''),
      name: String(f.name || 'Chat attachment').substring(0, 160),
      url: f.webViewLink || driveViewUrl_(id),
      drive_file_id: id,
      mime_type: f.mimeType || '',
      parent_resource_id: '',
      depth: 0,
      sort_order: Date.now(),
      activity_id: String(activityId || ''),
      visible_in_card: !inline,
      source: source || (inline ? 'google_chat_drive_image' : 'google_chat_drive_attachment'),
      created_by: Repo.me(),
      created_at: now,
      updated_at: now,
      removed: false,
      removed_at: '',
      unresolved_name: false
    };
    Repo.append(TABS.RELATED_RESOURCES, row);
    return public_(row);
  }

  function renameAttachment(ticketId, resourceId, newName) {
    Repo.requireAccess('agent');
    const row = Repo.findOne(TABS.RELATED_RESOURCES, 'resource_id', resourceId);
    if (!row || row.ticket_id !== ticketId || bool_(row.removed)) throw new Error('Attachment not found.');
    if (row.resource_type !== TYPES.ATTACHMENT) throw new Error('Only uploaded attachments can be renamed.');
    const name = normalizeUploadName_(newName, row.name);
    if (row.drive_file_id) Drive.Files.update({ name: name }, row.drive_file_id, null, { supportsAllDrives: true });
    const out = Repo.update(TABS.RELATED_RESOURCES, 'resource_id', resourceId, { name: name, updated_at: Repo.now() });
    return public_(out);
  }

  function rowMap_(ticketId) {
    const map = {};
    activeRows_(ticketId).forEach(function (r) { map[r.resource_id] = r; });
    return map;
  }

  function descendantMaxRelativeDepth_(map, resourceId, rel) {
    let max = rel;
    Object.keys(map).forEach(function (id) {
      if (map[id].parent_resource_id === resourceId) {
        max = Math.max(max, descendantMaxRelativeDepth_(map, id, rel + 1));
      }
    });
    return max;
  }

  function isDescendant_(map, possibleDescendantId, ancestorId) {
    let cur = map[possibleDescendantId];
    const seen = {};
    while (cur && cur.parent_resource_id && !seen[cur.resource_id]) {
      seen[cur.resource_id] = true;
      if (cur.parent_resource_id === ancestorId) return true;
      cur = map[cur.parent_resource_id];
    }
    return false;
  }

  function recomputeDescendantDepths_(ticketId, parentId, parentDepth) {
    activeRows_(ticketId).filter(function (r) { return r.parent_resource_id === parentId; }).forEach(function (child) {
      const depth = parentDepth + 1;
      Repo.update(TABS.RELATED_RESOURCES, 'resource_id', child.resource_id, { depth: depth, updated_at: Repo.now() });
      recomputeDescendantDepths_(ticketId, child.resource_id, depth);
    });
  }

  function moveUnder(ticketId, resourceId, parentId) {
    Repo.requireAccess('agent');
    if (resourceId === parentId) throw new Error('A resource cannot be nested under itself.');
    const map = rowMap_(ticketId), row = map[resourceId], parent = map[parentId];
    if (!row || !parent) throw new Error('Resource not found.');
    if (isDescendant_(map, parentId, resourceId)) throw new Error('That would create a circular resource hierarchy.');

    const parentDepth = Number(parent.depth) || 0;
    const subtreeRelMax = descendantMaxRelativeDepth_(map, resourceId, 0);
    if (parentDepth + 1 + subtreeRelMax > CONFIG.RESOURCE_MAX_DEPTH) {
      throw new Error('Resources can be nested only ' + CONFIG.RESOURCE_MAX_DEPTH + ' levels deep.');
    }

    Repo.update(TABS.RELATED_RESOURCES, 'resource_id', resourceId, {
      parent_resource_id: parentId,
      depth: parentDepth + 1,
      updated_at: Repo.now()
    });
    recomputeDescendantDepths_(ticketId, resourceId, parentDepth + 1);
    return listAll(ticketId);
  }

  function unnest(ticketId, resourceId) {
    Repo.requireAccess('agent');
    const row = Repo.findOne(TABS.RELATED_RESOURCES, 'resource_id', resourceId);
    if (!row || row.ticket_id !== ticketId || bool_(row.removed)) throw new Error('Resource not found.');
    Repo.update(TABS.RELATED_RESOURCES, 'resource_id', resourceId, { parent_resource_id: '', depth: 0, updated_at: Repo.now() });
    recomputeDescendantDepths_(ticketId, resourceId, 0);
    return listAll(ticketId);
  }

  function moveUpLevel(ticketId, resourceId) {
    Repo.requireAccess('agent');
    const map = rowMap_(ticketId), row = map[resourceId];
    if (!row) throw new Error('Resource not found.');
    if (!row.parent_resource_id) return listAll(ticketId);
    const parent = map[row.parent_resource_id];
    const grand = parent ? parent.parent_resource_id : '';
    if (!grand) return unnest(ticketId, resourceId);
    const grandRow = map[grand];
    Repo.update(TABS.RELATED_RESOURCES, 'resource_id', resourceId, {
      parent_resource_id: grand,
      depth: (Number(grandRow && grandRow.depth) || 0) + 1,
      updated_at: Repo.now()
    });
    recomputeDescendantDepths_(ticketId, resourceId, (Number(grandRow && grandRow.depth) || 0) + 1);
    return listAll(ticketId);
  }

  function replaceTempImageTokens(markup, tempMap) {
    let out = String(markup || '');
    out = out.replace(/\[imgtmp:([A-Za-z0-9_-]+)\]/g, function (all, id) {
      return tempMap && tempMap[id] ? '[img:' + tempMap[id] + ']' : '';
    });
    return out;
  }

  function dedupeTicket(ticketId, includeRows, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('agent');
    if (!opts.skipTicketValidation) ticket_(ticketId);
    const rows = Array.isArray(opts.rows) ? opts.rows : allRows_(ticketId, !!opts.fast);
    const groups = {};
    rows.forEach(function (r) {
      if (bool_(r.removed)) return;
      const key = String(r.canonical_key || '').trim();
      if (!key) return;
      (groups[key] || (groups[key] = [])).push(r);
    });

    const duplicateIds = {}, now = Repo.now();
    Object.keys(groups).forEach(function (key) {
      const group = groups[key];
      if (group.length < 2) return;
      group.sort(function (a, b) {
        function score(r) {
          let n = 0;
          if (!bool_(r.unresolved_name)) n += 8;
          if (String(r.name || '').trim() && String(r.name || '').trim().toLowerCase() !== String(r.external_id || '').trim().toLowerCase()) n += 4;
          if (String(r.activity_id || '').trim()) n += 2;
          if (bool_(r.visible_in_card)) n += 1;
          return n;
        }
        const d = score(b) - score(a);
        if (d) return d;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
      });
      const keeper = group[0];
      group.slice(1).forEach(function (r) { duplicateIds[String(r.resource_id || '')] = keeper.resource_id; });
    });

    rows.forEach(function (r) {
      const replacement = duplicateIds[String(r.parent_resource_id || '')];
      if (replacement && !bool_(r.removed)) {
        Repo.update(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id, { parent_resource_id: replacement, updated_at: now });
      }
    });

    const patches = {};
    Object.keys(duplicateIds).forEach(function (id) {
      if (!id) return;
      patches[id] = { removed: true, removed_at: now, visible_in_card: false, parent_resource_id: '', depth: 0, updated_at: now };
    });
    if (Object.keys(patches).length) Repo.updateMany(TABS.RELATED_RESOURCES, 'resource_id', patches);
    const out = { removedDuplicates: Object.keys(patches).length };
    if (includeRows !== false) out.rows = listAll(ticketId);
    return out;
  }

  function mergeTickets(primaryId, secondaryId) {
    const primaryRows = allRows_(primaryId);
    const secondaryRows = allRows_(secondaryId);
    const mapByCanonical = {};
    primaryRows.forEach(function (r) { if (!bool_(r.removed)) mapByCanonical[r.canonical_key] = r; });
    const tokenMap = {};
    const duplicateIds = {};

    // Resolve every old secondary resource ID before changing rows so child
    // relationships can be remapped even when their parent collapses into an
    // already-existing primary resource.
    secondaryRows.forEach(function (r) {
      const dupe = !bool_(r.removed) ? mapByCanonical[r.canonical_key] : null;
      if (dupe) {
        tokenMap[r.resource_id] = dupe.resource_id;
        duplicateIds[r.resource_id] = true;
      } else {
        tokenMap[r.resource_id] = r.resource_id;
        if (!bool_(r.removed)) mapByCanonical[r.canonical_key] = r;
      }
    });

    secondaryRows.forEach(function (r) {
      if (duplicateIds[r.resource_id]) {
        Repo.remove(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id);
        return;
      }
      const mappedParent = r.parent_resource_id ? (tokenMap[r.parent_resource_id] || '') : '';
      Repo.update(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id, {
        ticket_id: primaryId,
        parent_resource_id: mappedParent,
        updated_at: Repo.now()
      });
    });

    // Recalculate depths after parent remapping.
    activeRows_(primaryId).filter(function (r) { return !r.parent_resource_id; }).forEach(function (root) {
      if (Number(root.depth) !== 0) Repo.update(TABS.RELATED_RESOURCES, 'resource_id', root.resource_id, { depth: 0, updated_at: Repo.now() });
      recomputeDescendantDepths_(primaryId, root.resource_id, 0);
    });
    return tokenMap;
  }

  function remapActivityIds(ticketId, activityIdMap) {
    activeRows_(ticketId).forEach(function (r) {
      const next = activityIdMap && activityIdMap[r.activity_id];
      if (next) Repo.update(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id, { activity_id: next, updated_at: Repo.now() });
    });
  }

  function inlineImages(ticketId, resourceIds) {
    Repo.requireAccess('viewer');
    ticket_(ticketId, true);
    const wanted = {};
    (Array.isArray(resourceIds) ? resourceIds : []).slice(0, 20).forEach(function (id) {
      wanted[String(id)] = true;
    });
    const rows = activeRows_(ticketId, true).filter(function (r) {
      return wanted[String(r.resource_id)] && r.resource_type === TYPES.INLINE_IMAGE && r.drive_file_id;
    });
    const images = {}, errors = {};
    let totalBytes = 0;
    const maxTotal = CONFIG.MAX_TOTAL_INLINE_BYTES || (8 * 1024 * 1024);
    if (!rows.length) return { images: images, errors: errors };

    // Drive media requests are independent. Running them as one fetchAll batch
    // removes the N x network-latency waterfall that made image-heavy tickets
    // spend several seconds in api_inlineImages. Response order matches request
    // order, so the existing total-size cap and per-resource errors are preserved.
    const token = ScriptApp.getOAuthToken();
    const requests = rows.map(function (r) {
      return {
        url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(r.drive_file_id) + '?alt=media&supportsAllDrives=true',
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
        followRedirects: true
      };
    });

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (batchError) {
      // Keep the historical behavior as a reliability fallback if Google ever
      // rejects a batch at the transport layer.
      responses = requests.map(function (request) {
        try {
          const params = {
            method: request.method,
            headers: request.headers,
            muteHttpExceptions: request.muteHttpExceptions,
            followRedirects: request.followRedirects
          };
          return UrlFetchApp.fetch(request.url, params);
        }
        catch (e) { return { __pt_error: e }; }
      });
    }

    rows.forEach(function (r, i) {
      try {
        const resp = responses[i];
        if (!resp || resp.__pt_error) throw (resp && resp.__pt_error) || new Error('Drive did not return an image response.');
        const code = resp.getResponseCode();
        if (code < 200 || code >= 300) throw new Error('Drive returned HTTP ' + code + '.');
        const blob = resp.getBlob();
        const bytes = blob.getBytes();
        if (totalBytes + bytes.length > maxTotal) {
          errors[r.resource_id] = 'Inline image batch exceeded the preview-size limit.';
          return;
        }
        totalBytes += bytes.length;
        const mime = String(blob.getContentType() || r.mime_type || 'image/png');
        images[r.resource_id] = 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes);
      } catch (e) {
        errors[r.resource_id] = e.message || String(e);
      }
    });
    return { images: images, errors: errors };
  }

  function rewriteMarkupTokens(markup, tokenMap) {
    let out = String(markup || '');
    Object.keys(tokenMap || {}).forEach(function (oldId) {
      const next = tokenMap[oldId];
      const safe = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\[(res|img):' + safe + '\\]', 'g'), function (_, kind) { return '[' + kind + ':' + next + ']'; });
    });
    return out;
  }


  function regexEscape_(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function legacySymbolForType_(type) {
    if (type === TYPES.SEGMENT) return '%';
    if (type === TYPES.GOOGLE_DOC || type === TYPES.GOOGLE_SHEET) return '!';
    if (type === TYPES.ATTACHMENT) return '^';
    if (type === TYPES.WORKFLOW || type === TYPES.RULE) return '$';
    // v7.2 used a bullet fallback for resource types that did not yet have a
    // dedicated symbol. Include it so any early/test tags migrate cleanly.
    return '•';
  }

  function replaceLegacyResourceRefs_(value, resources, markupMode) {
    let out = String(value || '');
    if (!out) return out;

    (resources || []).slice().sort(function (a, b) {
      return String(b.name || '').length - String(a.name || '').length;
    }).forEach(function (r) {
      if (!r || r.resource_type === TYPES.INLINE_IMAGE) return;
      const id = String(r.resource_id || '').trim();
      const name = String(r.name || r.external_id || '').trim();
      if (!id || !name) return;

      const replacement = markupMode ? '[res:' + id + ']' : '$' + name;

      // Backfill historical raw URLs to the same stable resource token used by
      // new notes. This also makes old links follow attachment renames because
      // the rendered name is resolved from RelatedResources at display time.
      const url = String(r.url || '').trim();
      if (url && out.indexOf(url) !== -1) out = out.split(url).join(replacement);

      const symbols = {};
      symbols[legacySymbolForType_(r.resource_type)] = true;
      symbols['%'] = r.resource_type === TYPES.SEGMENT;
      symbols['!'] = r.resource_type === TYPES.GOOGLE_DOC || r.resource_type === TYPES.GOOGLE_SHEET;
      symbols['^'] = r.resource_type === TYPES.ATTACHMENT;
      symbols['•'] = true;

      Object.keys(symbols).forEach(function (symbol) {
        if (!symbols[symbol] || symbol === '$') return;
        const re = new RegExp('(^|[\\s(\\[{>])' + regexEscape_(symbol) + '\\s*' + regexEscape_(name) + '(?=$|[\\s.,;:!?\\)\\]}>])', 'g');
        out = out.replace(re, function (_, lead) { return lead + replacement; });
      });
    });
    return out;
  }

  /**
   * Force a safe one-time refresh of unresolved Element451 resource names.
   * This never deletes or modifies the source resource in Element451; it only
   * updates the Project Tracker display name. Failures return sanitized error
   * messages so API issues can be diagnosed without exposing credentials.
   */
  function refreshAllNames() {
    Repo.requireAccess('agent');
    const rows = Repo.readAll(TABS.RELATED_RESOURCES).filter(function (r) {
      return !bool_(r.removed) && resourceNeedsNameRefresh_(r);
    });
    let updated = 0;
    const failures = [];

    rows.forEach(function (r) {
      try {
        const resolved = resolve_({
          type: r.resource_type,
          external_id: r.external_id,
          url: r.url,
          canonical_key: r.canonical_key
        });
        const name = String(resolved && resolved.name || '').trim();
        if (!resolved || resolved.unresolved_name || !name || name.toLowerCase() === String(r.external_id || '').trim().toLowerCase()) {
          failures.push({
            type: r.resource_type,
            id: r.external_id,
            error: 'Element451 returned the resource but no display name was found.'
          });
          return;
        }
        Repo.update(TABS.RELATED_RESOURCES, 'resource_id', r.resource_id, {
          name: name,
          url: resolved.url || r.url,
          mime_type: resolved.mime_type || r.mime_type,
          unresolved_name: false,
          updated_at: Repo.now()
        });
        updated++;
      } catch (e) {
        failures.push({
          type: r.resource_type,
          id: r.external_id,
          error: String(e && e.message || e || 'Lookup failed').substring(0, 300)
        });
      }
    });

    return {
      checked: rows.length,
      updated: updated,
      unresolved: failures.length,
      failures: failures.slice(0, 50)
    };
  }

  /**
   * One-time data migration for projects created while resource types used
   * %, !, ^, or the bullet fallback. It updates both searchable plain text and
   * rich markup. Existing [res:...] tokens are already stable and are left
   * untouched; only legacy literal tags/raw URLs are converted.
   *
   * @param {boolean=} dryRun When true, report counts without writing changes.
   * @return {{dryRun:boolean, notesUpdated:number, detailsUpdated:number, ticketsScanned:number}}
   */
  function migrateLegacyTagsToDollar(dryRun) {
    Repo.requireAccess('agent');
    const preview = dryRun === true;
    const resources = Repo.readAll(TABS.RELATED_RESOURCES).filter(function (r) { return !bool_(r.removed); });
    const byTicket = {};
    resources.forEach(function (r) {
      (byTicket[r.ticket_id] || (byTicket[r.ticket_id] = [])).push(r);
    });

    let notesUpdated = 0, detailsUpdated = 0;

    Repo.readAll(TABS.ACTIVITY).forEach(function (a) {
      if (a.kind !== ACTIVITY_KIND.NOTE) return;
      const list = byTicket[a.ticket_id] || [];
      if (!list.length) return;
      const originalBody = String(a.body || '');
      const originalMarkup = String(a.body_markup || '');
      const markupSource = originalMarkup || originalBody;
      const nextBody = replaceLegacyResourceRefs_(originalBody, list, false);
      const nextMarkup = replaceLegacyResourceRefs_(markupSource, list, true);
      const bodyChanged = nextBody !== originalBody;
      const markupChanged = nextMarkup !== markupSource;
      if (!bodyChanged && !markupChanged) return;
      notesUpdated++;
      if (!preview) {
        Repo.update(TABS.ACTIVITY, 'activity_id', a.activity_id, {
          body: nextBody,
          body_markup: nextMarkup
        });
      }
    });

    const tickets = Repo.readAll(TABS.TICKETS);
    tickets.forEach(function (t) {
      const list = byTicket[t.ticket_id] || [];
      if (!list.length) return;
      const originalText = String(t.description || '');
      const originalMarkup = String(t.description_markup || '');
      const markupSource = originalMarkup || originalText;
      const nextText = replaceLegacyResourceRefs_(originalText, list, false);
      const nextMarkup = replaceLegacyResourceRefs_(markupSource, list, true);
      const textChanged = nextText !== originalText;
      const markupChanged = nextMarkup !== markupSource;
      if (!textChanged && !markupChanged) return;
      detailsUpdated++;
      if (!preview) {
        Repo.update(TABS.TICKETS, 'ticket_id', t.ticket_id, {
          description: nextText,
          description_markup: nextMarkup
        });
      }
    });

    if (!preview && (notesUpdated || detailsUpdated)) Repo.invalidateAll();
    return {
      dryRun: preview,
      notesUpdated: notesUpdated,
      detailsUpdated: detailsUpdated,
      ticketsScanned: tickets.length
    };
  }

  return {
    TYPES: TYPES,
    listAll: listAll,
    listForTokens: listForTokens,
    snapshot: snapshot,
    listCard: listCard,
    syncFromTicket: syncFromTicket,
    dedupeTicket: dedupeTicket,
    addUrl: addUrl,
    addUrlsBatch: addUrlsBatch,
    matchKnownNames: matchKnownNames,
    remove: remove,
    removeMany: removeMany,
    uploadForActivity: uploadForActivity,
    addExistingDriveFile: addExistingDriveFile,
    renameAttachment: renameAttachment,
    moveUnder: moveUnder,
    moveUpLevel: moveUpLevel,
    unnest: unnest,
    inlineImages: inlineImages,
    replaceTempImageTokens: replaceTempImageTokens,
    mergeTickets: mergeTickets,
    remapActivityIds: remapActivityIds,
    rewriteMarkupTokens: rewriteMarkupTokens,
    refreshAllNames: refreshAllNames,
    migrateLegacyTagsToDollar: migrateLegacyTagsToDollar
  };
})();


/**
 * Preview the legacy resource-tag migration without modifying any rows.
 * Safe to run first from the Apps Script editor.
 */
function previewLegacyResourceTagMigration() {
  return RelatedResources.migrateLegacyTagsToDollar(true);
}

/**
 * One-time migration: convert historical %, !, ^, and bullet resource labels
 * (plus matching raw resource URLs) to canonical $ resource tags.
 */
function migrateLegacyResourceTagsToDollar() {
  return RelatedResources.migrateLegacyTagsToDollar(false);
}

/**
 * One-time/manual repair helper for existing GUID-only Related Resources.
 * Returns only resource type/ID and sanitized errors; credentials are never
 * included in the result or logs.
 */
function refreshAllRelatedResourceNames() {
  return RelatedResources.refreshAllNames();
}

