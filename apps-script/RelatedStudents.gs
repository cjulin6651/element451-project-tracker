/** Project Tracker — Related Students */
const RelatedStudents = (function () {

  function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

  function ticket_(ticketId) {
    const t = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!t) throw new Error('No such ticket: ' + ticketId);
    return t;
  }

  function allRows_(ticketId, fast) {
    return fast && Repo.findAllFast
      ? Repo.findAllFast(TABS.RELATED_STUDENTS, 'ticket_id', ticketId)
      : Repo.findAll(TABS.RELATED_STUDENTS, 'ticket_id', ticketId);
  }

  function uniqueByElementId_(rows, includeRemoved) {
    const out = [], seen = {};
    (rows || []).forEach(function (r) {
      if (!includeRemoved && bool_(r.removed)) return;
      const id = String(r.element_id || '').trim().toLowerCase();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(r);
    });
    return out;
  }

  function activeRows_(ticketId) {
    return uniqueByElementId_(allRows_(ticketId), false);
  }

  function public_(r) {
    return {
      relation_id: r.relation_id,
      ticket_id: r.ticket_id,
      element_id: r.element_id,
      first_name: r.first_name,
      last_name: r.last_name,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.element_id,
      profile_url: r.profile_url
    };
  }

  function snapshotFromRows_(rows) {
    const students = uniqueByElementId_(rows, false).sort(function (a, b) {
      return (String(a.last_name) + ' ' + String(a.first_name)).localeCompare(String(b.last_name) + ' ' + String(b.first_name));
    }).map(public_);

    const tokenRows = (rows || []).filter(function (r) {
      return !!String(r.element_id || '').trim();
    }).slice().sort(function (a, b) {
      // Prefer the active copy if a historical race created duplicate rows.
      return Number(bool_(a.removed)) - Number(bool_(b.removed));
    });

    return { students: students, studentTokens: uniqueByElementId_(tokenRows, true).map(public_) };
  }

  /** Read related-student rows once and derive both current and historical-token views. */
  function snapshot(ticketId, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('viewer');
    if (!opts.skipTicketValidation) ticket_(ticketId);
    return snapshotFromRows_(allRows_(ticketId, !!opts.fast));
  }

  function list(ticketId) {
    return snapshot(ticketId).students;
  }

  /** Includes soft-removed rows so historical note tokens keep their labels. */
  function listForTokens(ticketId) {
    return snapshot(ticketId).studentTokens;
  }

  function upsert_(ticketId, person, source, manual) {
    ticket_(ticketId);
    const id = String(person && person.element_id || '').trim().toLowerCase();
    if (!id) throw new Error('Element451 did not return an Element ID.');

    // Chat post-processing can be kicked off by both the dashboard and the
    // hourly job. Serialize the tiny read/write section so two enrichers cannot
    // append the same student at the same time.
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const existing = allRows_(ticketId).filter(function (r) {
        return String(r.element_id || '').trim().toLowerCase() === id;
      })[0];

      if (existing) {
        if (bool_(existing.removed) && manual) {
          const restored = Repo.update(TABS.RELATED_STUDENTS, 'relation_id', existing.relation_id, {
            first_name: person.first_name || existing.first_name,
            last_name: person.last_name || existing.last_name,
            profile_url: Element451.profileUrl(id),
            removed: false,
            removed_at: ''
          });
          return { student: public_(restored), added: true };
        }
        return { student: public_(existing), added: false, suppressed: bool_(existing.removed) };
      }

      const row = {
        relation_id: Utilities.getUuid(),
        ticket_id: ticketId,
        element_id: id,
        first_name: String(person.first_name || '').trim(),
        last_name: String(person.last_name || '').trim(),
        profile_url: Element451.profileUrl(id),
        source: source || 'manual',
        added_by: Repo.me(),
        created_at: Repo.now(),
        removed: false,
        removed_at: ''
      };
      Repo.append(TABS.RELATED_STUDENTS, row);
      return { student: public_(row), added: true };
    } finally {
      lock.releaseLock();
    }
  }

  function addByUrl(ticketId, url) {
    Repo.requireAccess('agent');
    const id = Element451.extractElementIdFromUrl(url);
    return upsert_(ticketId, Element451.lookupByElementId(id), 'manual_url', true);
  }

  function addBySparkId(ticketId, value) {
    Repo.requireAccess('agent');
    if (!projectTrackerStudentIdentityEnabled_('spark')) {
      throw new Error(projectTrackerStudentIdentityLabel_('spark') + ' lookup is not enabled for this institution.');
    }
    return upsert_(ticketId, Element451.lookupBySparkId(value), 'additional_id_spark', true);
  }

  function addBySchoolId(ticketId, value) {
    Repo.requireAccess('agent');
    if (!projectTrackerStudentIdentityEnabled_('school')) {
      throw new Error(projectTrackerStudentIdentityLabel_('school') + ' lookup is not enabled for this institution.');
    }
    return upsert_(ticketId, Element451.lookupBySchoolId(value), 'additional_id_school', true);
  }

  function addSearchResult(ticketId, elementId) {
    Repo.requireAccess('agent');
    return upsert_(ticketId, Element451.lookupByElementId(elementId), 'search', true);
  }

  /** Adds an already-resolved Element451 person without making a second API lookup. */
  function addResolvedPerson(ticketId, person, source) {
    Repo.requireAccess('agent');
    return upsert_(ticketId, person, source || 'resolved_person', false);
  }


  /**
   * Adds several already-resolved Element451 people with one spreadsheet write.
   * Used by Gmail enrichment so a long list of student IDs does not append one
   * RelatedStudents row at a time.
   */
  function addResolvedPeople(ticketId, entries, options) {
    options = options || {};
    if (!options.skipAccessValidation) Repo.requireAccess('agent');
    if (!options.skipTicketValidation) ticket_(ticketId);
    entries = entries || [];
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const existingRows = allRows_(ticketId, !!options.fast);
      const existing = {};
      existingRows.forEach(function (row) {
        const id = String(row.element_id || '').trim().toLowerCase();
        if (id) existing[id] = row;
      });

      const pending = [], seen = {};
      entries.forEach(function (entry) {
        const person = entry && (entry.person || entry);
        const id = String(person && person.element_id || '').trim().toLowerCase();
        if (!id || seen[id]) return;
        seen[id] = true;
        if (existing[id]) return; // Auto-enrichment never restores a manually removed relation.
        const row = {
          relation_id: Utilities.getUuid(),
          ticket_id: ticketId,
          element_id: id,
          first_name: String(person.first_name || '').trim(),
          last_name: String(person.last_name || '').trim(),
          profile_url: Element451.profileUrl(id),
          source: String(entry && entry.source || 'resolved_people'),
          added_by: Repo.me(),
          created_at: Repo.now(),
          removed: false,
          removed_at: ''
        };
        pending.push(row);
        existing[id] = row;
      });

      if (pending.length) Repo.appendMany(TABS.RELATED_STUDENTS, pending);
      return { added: pending.length };
    } finally {
      lock.releaseLock();
    }
  }

  function search(ticketId, query) {
    Repo.requireAccess('agent');
    ticket_(ticketId);
    const active = {};
    activeRows_(ticketId).forEach(function (r) { active[String(r.element_id).toLowerCase()] = true; });
    return Element451.searchStudents(query).map(function (p) {
      p.already_related = !!active[String(p.element_id).toLowerCase()];
      return p;
    });
  }

  function remove(ticketId, relationId) {
    Repo.requireAccess('agent');
    const row = Repo.findOne(TABS.RELATED_STUDENTS, 'relation_id', relationId);
    if (!row || row.ticket_id !== ticketId) throw new Error('Related student not found.');
    Repo.update(TABS.RELATED_STUDENTS, 'relation_id', relationId, { removed: true, removed_at: Repo.now() });
    return list(ticketId);
  }

  function removeMany(ticketId, relationIds) {
    Repo.requireAccess('agent');
    ticket_(ticketId);
    relationIds = (relationIds || []).map(String).filter(Boolean);
    if (!relationIds.length) return list(ticketId);
    const wanted = {}, patches = {}, now = Repo.now();
    relationIds.forEach(function (id) { wanted[id] = true; });
    allRows_(ticketId).forEach(function (row) {
      const id = String(row.relation_id || '');
      if (wanted[id] && !bool_(row.removed)) patches[id] = { removed: true, removed_at: now };
    });
    Repo.updateMany(TABS.RELATED_STUDENTS, 'relation_id', patches);
    return list(ticketId);
  }

  function syncFromTicket(ticketId, context) {
    context = context || {};
    if (!context.skipAccessValidation) Repo.requireAccess('agent');
    const contextTicket = context && context.ticket && String(context.ticket.ticket_id) === String(ticketId) ? context.ticket : null;
    const ticket = contextTicket || ticket_(ticketId);
    const activityRows = context && Array.isArray(context.activityRows) ? context.activityRows : Repo.findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
    const notes = activityRows.filter(function (a) {
      return a.kind === ACTIVITY_KIND.NOTE && !bool_(a.deleted);
    });

    const texts = [String(ticket.description || '')].concat(notes.map(function (a) { return String(a.body || ''); }));
    const relationshipRows = Array.isArray(context.studentRows) ? context.studentRows : allRows_(ticketId, !!context.fast);
    const existing = {};
    relationshipRows.forEach(function (r) { existing[String(r.element_id || '').toLowerCase()] = true; });

    const ids = [], seen = {};
    texts.forEach(function (text) {
      const re = /https?:\/\/[^\s<>"]+/ig;
      let match;
      while ((match = re.exec(String(text || ''))) !== null && ids.length < (ELEMENT451_CONFIG.NOTE_SCAN_MAX_URLS || 30)) {
        const id = element451ExtractPersonId_(match[0].replace(/[),.;!?]+$/g, ''));
        if (id && !existing[id] && !seen[id]) { seen[id] = true; ids.push(id); }
      }
    });

    const errors = [];
    let added = 0;
    ids.forEach(function (id) {
      try {
        const result = upsert_(ticketId, Element451.lookupByElementId(id), 'ticket_url', false);
        if (result && result.added) added++;
      }
      catch (e) { errors.push({ element_id: id, message: e.message }); }
    });
    const finalRows = ids.length ? allRows_(ticketId, !!context.fast) : relationshipRows;
    const related = snapshotFromRows_(finalRows);
    return { rows: related.students, studentTokens: related.studentTokens, errors: errors, added: added, changed: added > 0 };
  }

  function dedupeTicket(ticketId, includeRows, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('agent');
    if (!opts.skipTicketValidation) ticket_(ticketId);
    const rows = Array.isArray(opts.rows) ? opts.rows : allRows_(ticketId, !!opts.fast);
    const keep = {}, duplicateIds = [], now = Repo.now();
    rows.forEach(function (r) {
      if (bool_(r.removed)) return;
      const id = String(r.element_id || '').trim().toLowerCase();
      if (!id) return;
      if (!keep[id]) { keep[id] = r; return; }
      duplicateIds.push(String(r.relation_id || ''));
    });
    const patches = {};
    duplicateIds.filter(Boolean).forEach(function (id) {
      patches[id] = { removed: true, removed_at: now };
    });
    if (Object.keys(patches).length) Repo.updateMany(TABS.RELATED_STUDENTS, 'relation_id', patches);
    const out = { removedDuplicates: Object.keys(patches).length };
    if (includeRows !== false) out.rows = list(ticketId);
    return out;
  }

  function mergeTickets(primaryId, secondaryId) {
    allRows_(secondaryId).forEach(function (r) {
      const duplicate = allRows_(primaryId).filter(function (p) {
        return String(p.element_id || '').toLowerCase() === String(r.element_id || '').toLowerCase();
      })[0];
      if (duplicate) {
        Repo.remove(TABS.RELATED_STUDENTS, 'relation_id', r.relation_id);
      } else {
        Repo.update(TABS.RELATED_STUDENTS, 'relation_id', r.relation_id, { ticket_id: primaryId });
      }
    });
  }

  return {
    list: list,
    listForTokens: listForTokens,
    snapshot: snapshot,
    addByUrl: addByUrl,
    addBySparkId: addBySparkId,
    addBySchoolId: addBySchoolId,
    addSearchResult: addSearchResult,
    addResolvedPerson: addResolvedPerson,
    addResolvedPeople: addResolvedPeople,
    search: search,
    remove: remove,
    removeMany: removeMany,
    syncFromTicket: syncFromTicket,
    dedupeTicket: dedupeTicket,
    mergeTickets: mergeTickets
  };
})();
