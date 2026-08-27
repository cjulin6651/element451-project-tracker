/**
 * Project Tracker — ticket logic
 * All business rules live here. Reads and writes go through Repo.
 */

const Tickets = (function () {

  const INDEX_FIELDS = [
    'ticket_id', 'title', 'description', 'type', 'department',
    'status', 'substatus', 'owners', 'size', 'progress',
    'created_by', 'created_at', 'updated_at', 'last_activity_at',
    'due_date', 'completed_at', 'deleted', 'deleted_at',
    'high_priority', 'priority_by', 'priority_at'
  ];

  const MERGE_FIELDS = ['title', 'description', 'type', 'department', 'owners', 'size', 'due_date'];


  // -- creation --------------------------------------------------------------

  function create(payload) {
    const user = Repo.requireAccess('agent');
    const now = Repo.now();

    const type = payload.type || '';
    const size = payload.size || (type ? Repo.defaultSizeForType(type) : 'M');
    const owners = normalizeOwners_(payload.owners, user.email);

    const ticket = {
      ticket_id: Repo.nextTicketId(),
      title: payload.title || '(untitled)',
      description: payload.description || '',
      type: type,
      department: payload.department || '',
      status: payload.status || STATUS.IN_PROGRESS,
      substatus: '',
      owners: owners,
      size: size,
      progress: 0,
      created_by: user.email,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      due_date: toDateString_(payload.due_date),
      waiting_who: '',
      waiting_what: '',
      waiting_since: '',
      drive_folder_id: '',
      halt_reason: '',
      halt_note: '',
      completed_at: '',
      deleted: false,
      deleted_at: '',
      high_priority: false,
      priority_by: '',
      priority_at: '',
      description_markup: cleanMarkup_(payload.description_markup || payload.description || '')
    };

    Repo.append(TABS.TICKETS, ticket);

    if (payload.clips && payload.clips.length) {
      payload.clips.forEach(function (c) {
        addActivity(ticket.ticket_id, ACTIVITY_KIND.NOTE, c, '', true);
      });
    }

    if (ticket.description) notifyMentions_(ticket, ticket.description);
    notifyNewAssignments_(ticket, '', ticket.owners, user.email);
    const creationSource = String(payload && payload._creationSource || 'project_tracker').toLowerCase();
    logChange_(ticket.ticket_id, 'created this ticket', 'ptsource:' + creationSource);
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordTicketCreated(ticket, creationSource, user.email); }
      catch (studyError) { Logger.log('Workload study creation event skipped: %s', studyError.message); }
    }
    return ticket;
  }


  // -- editing ---------------------------------------------------------------

  const EDITABLE = ['title', 'description', 'description_markup', 'type', 'department', 'size',
                    'due_date', 'owners', 'waiting_who', 'waiting_what'];

  function update(ticketId, patch) {
    const user = Repo.requireAccess('agent');

    const current = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!current) throw new Error('No such ticket: ' + ticketId);

    const clean = {};
    EDITABLE.forEach(function (f) {
      if (patch[f] !== undefined) clean[f] = patch[f];
    });

    if (clean.owners !== undefined) clean.owners = normalizeOwners_(clean.owners, user.email);
    if (clean.due_date !== undefined) clean.due_date = toDateString_(clean.due_date);
    if (clean.description_markup !== undefined) clean.description_markup = cleanMarkup_(clean.description_markup);
    if (clean.description !== undefined && clean.description_markup === undefined) {
      clean.description_markup = cleanMarkup_(clean.description);
    }

    if (patch.waiting_who !== undefined || patch.waiting_what !== undefined) {
      if (!current.waiting_since && (clean.waiting_who || clean.waiting_what)) {
        clean.waiting_since = Repo.now();
      }
    }

    clean.updated_at = Repo.now();
    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, clean);

    if (clean.description !== undefined) {
      notifyNewMentions_(out, clean.description, current.description || '');
    }
    if (clean.owners !== undefined) {
      notifyNewAssignments_(out, current.owners || '', clean.owners, user.email);
      logChange_(ticketId, 'updated the owner assignment');
    }
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordTicketEdit(current, out, user.email); }
      catch (studyError) { Logger.log('Workload study edit event skipped: %s', studyError.message); }
    }

    return out;
  }

  function updateDetailsRich(ticketId, payload) {
    Repo.requireAccess('agent');
    payload = payload || {};
    const markup = cleanMarkup_(payload.markup || payload.text || '');
    const text = String(payload.text || '').trim();
    const ticket = update(ticketId, { description: text, description_markup: markup });
    let students = [], resources = [];
    try { students = RelatedStudents.syncFromTicket(ticketId).rows || RelatedStudents.list(ticketId); }
    catch (ignore) { try { students = RelatedStudents.list(ticketId); } catch (ignored) {} }
    try { resources = RelatedResources.syncFromTicket(ticketId).rows || RelatedResources.listAll(ticketId); }
    catch (ignore) { try { resources = RelatedResources.listAll(ticketId); } catch (ignored) {} }
    return { ticket: ticket, students: students, resources: resources };
  }

  function normalizeOwners_(owners, fallbackEmail) {
    let list = [];
    if (Array.isArray(owners)) list = owners;
    else if (owners) list = String(owners).split(',');

    const assignable = {};
    const agentRows = Repo.activeAgents().filter(function (a) { return String(a.role || '').toLowerCase() === 'agent'; });
    agentRows.forEach(function (a) { assignable[String(a.email || '').toLowerCase()] = true; });

    list = list.map(function (x) { return String(x).trim(); }).filter(function (email) {
      return !!assignable[String(email).toLowerCase()];
    });
    if (!list.length && fallbackEmail && assignable[String(fallbackEmail).toLowerCase()]) list = [fallbackEmail];
    if (!list.length && agentRows.length) list = [String(agentRows[0].email || '').trim()];

    const seen = {};
    return list.filter(function (email) {
      const k = email.toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    }).join(',');
  }

  function ownerKey_(owners) {
    return String(owners || '').split(',')
      .map(function (x) { return x.trim().toLowerCase(); })
      .filter(Boolean)
      .sort()
      .join(',');
  }

  function ownerList_(owners) {
    return String(owners || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function toDateString_(v) {
    if (!v) return '';
    if (v instanceof Date) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : String(v);
  }


  // -- progress --------------------------------------------------------------

  function setProgress(ticketId, n) {
    const user = Repo.requireAccess('agent');
    n = Math.max(0, Math.min(10, Number(n) || 0));

    if (n === 10) return complete(ticketId, SUBSTATUS.DONE);

    const t = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!t) throw new Error('No such ticket: ' + ticketId);
    const oldProgress = Number(t.progress) || 0;
    const patch = { progress: n, updated_at: Repo.now() };

    if (t.status === STATUS.COMPLETED) {
      patch.status = STATUS.IN_PROGRESS;
      patch.substatus = '';
      patch.completed_at = '';
      patch.halt_reason = '';
      patch.halt_note = '';
    }

    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, patch);
    if (t.status === STATUS.COMPLETED && out.status !== STATUS.COMPLETED && typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordStatusChange(t, out, user.email, 'Reopened by progress change'); }
      catch (studyError) { Logger.log('Workload study progress/reopen event skipped: %s', studyError.message); }
    }
    logChange_(ticketId, 'set progress to ' + n + ' of 10');
    if (oldProgress !== n) {
      notifyWatchers_(out, 'progress', 'Progress changed to ' + n + ' of 10.', user.email);
    }
    return out;
  }


  // -- status ----------------------------------------------------------------

  function setStatus(ticketId, status, substatus) {
    const user = Repo.requireAccess('agent');

    const t = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!t) throw new Error('No such ticket: ' + ticketId);
    const patch = { status: status, substatus: substatus || '', updated_at: Repo.now() };

    if (t.status === STATUS.COMPLETED && status !== STATUS.COMPLETED) {
      patch.completed_at = '';
      patch.halt_reason = '';
      patch.halt_note = '';
      if (t.substatus === SUBSTATUS.DONE) patch.progress = 9;
    }

    if (status !== STATUS.UP_NEXT || substatus !== SUBSTATUS.ON_HOLD) {
      patch.waiting_since = '';
      patch.waiting_who = '';
      patch.waiting_what = '';
    } else if (!t.waiting_since) {
      patch.waiting_since = Repo.now();
    }

    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, patch);
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordStatusChange(t, out, user.email, 'Status changed'); }
      catch (studyError) { Logger.log('Workload study status event skipped: %s', studyError.message); }
    }
    logChange_(ticketId, 'moved this to ' + label_(status, substatus));
    return out;
  }

  function complete(ticketId, resolution, haltReason, haltNote) {
    const user = Repo.requireAccess('agent');
    const before = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!before) throw new Error('No such ticket: ' + ticketId);

    const halted = resolution === SUBSTATUS.HALTED;
    const patch = {
      status: STATUS.COMPLETED,
      substatus: halted ? SUBSTATUS.HALTED : SUBSTATUS.DONE,
      completed_at: Repo.now(),
      updated_at: Repo.now(),
      halt_reason: halted ? (haltReason || 'other') : '',
      halt_note: halted ? (haltNote || '') : '',
      waiting_who: '', waiting_what: '', waiting_since: ''
    };

    if (!halted) patch.progress = 10;

    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, patch);
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordStatusChange(before, out, user.email, halted ? 'Halted' : 'Completed'); }
      catch (studyError) { Logger.log('Workload study completion event skipped: %s', studyError.message); }
    }
    logChange_(ticketId, halted
      ? 'halted this — ' + String(haltReason || 'other').replace(/_/g, ' ')
      : 'marked this complete');

    if (!halted) {
      if ((Number(before.progress) || 0) !== 10) {
        notifyWatchers_(out, 'progress', 'Progress changed to 10 of 10.', user.email);
      }
      notifyWatchers_(out, 'complete', 'Project was marked complete.', user.email);
      if (typeof ChatTicketing !== 'undefined') {
        try { ChatTicketing.notifyTicketCompleted(out, user.email); }
        catch (chatNotifyError) { Logger.log('Google Chat completion notification skipped: %s', chatNotifyError.message); }
      }
    }
    return out;
  }

  function softDelete(ticketId) {
    const user = Repo.requireAccess('agent');
    logChange_(ticketId, 'moved this ticket to Trash');
    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, {
      deleted: true, deleted_at: Repo.now(), updated_at: Repo.now()
    });
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordTicketDeleted(out, user.email); }
      catch (studyError) { Logger.log('Workload study delete event skipped: %s', studyError.message); }
    }
    return out;
  }

  function restore(ticketId) {
    const user = Repo.requireAccess('agent');
    const current = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!current) throw new Error('No such ticket: ' + ticketId);
    if (current.deleted_at) {
      const deletedAt = new Date(current.deleted_at).getTime();
      if (!isNaN(deletedAt) && Date.now() - deletedAt > 30 * 86400000) {
        throw new Error('The 30-day restore window has expired for this ticket.');
      }
    }
    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, {
      deleted: false, deleted_at: '', updated_at: Repo.now()
    });
    if (typeof WorkloadStudy !== 'undefined') {
      try { WorkloadStudy.recordTicketRestored(out, user.email); }
      catch (studyError) { Logger.log('Workload study restore event skipped: %s', studyError.message); }
    }
    logChange_(ticketId, 'restored this ticket from Trash');
    return out;
  }


  // -- activity --------------------------------------------------------------

  function addActivity(ticketId, kind, body, ref, skipAccessCheck, parentActivityId) {
    if (!skipAccessCheck) Repo.requireAccess('agent');
    const now = Repo.now();

    if (parentActivityId) {
      const parent = Repo.findOne(TABS.ACTIVITY, 'activity_id', parentActivityId);
      if (!parent || parent.ticket_id !== ticketId || parent.kind !== ACTIVITY_KIND.NOTE) {
        throw new Error('That note is no longer available for replies.');
      }
    }

    const entry = {
      activity_id: Utilities.getUuid(),
      ticket_id: ticketId,
      timestamp: now,
      actor: Repo.me(),
      kind: kind,
      body: body || '',
      ref: ref || '',
      parent_activity_id: parentActivityId || '',
      edited_at: '',
      deleted: false,
      deleted_at: '',
      body_markup: ''
    };

    Repo.append(TABS.ACTIVITY, entry);
    Repo.update(TABS.TICKETS, 'ticket_id', ticketId, { last_activity_at: now, updated_at: now });

    if (kind === ACTIVITY_KIND.NOTE) {
      const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
      if (ticket) {
        notifyMentions_(ticket, entry.body);
        notifyWatchers_(ticket, 'note', entry.body, entry.actor);
      }
    }

    return entry;
  }

  function cleanMarkup_(markup) {
    // Markup is a data format, not HTML. The client renderer escapes all raw
    // text before interpreting our small fixed token set.
    let value = String(markup || '').replace(/\u0000/g, '');
    if (value.length > 100000) throw new Error('This rich text is too long.');
    return value;
  }

  function addRichNote(ticketId, payload, parentActivityId, activityTimestamp, options) {
    payload = payload || {};
    options = options || {};
    if (!options.skipAccessValidation) Repo.requireAccess('agent');
    const knownTicket = options.ticket || null;
    const now = Repo.now();
    let activityAt = now;
    if (activityTimestamp) {
      const parsedActivityAt = new Date(activityTimestamp);
      if (!isNaN(parsedActivityAt.getTime())) activityAt = parsedActivityAt.toISOString();
    }
    const activityId = Utilities.getUuid();
    const files = Array.isArray(payload.files) ? payload.files : [];
    let body = String(payload.text || '').trim();
    let markup = cleanMarkup_(payload.markup || body);

    if (parentActivityId) {
      const parent = Repo.findOne(TABS.ACTIVITY, 'activity_id', parentActivityId);
      if (!parent || parent.ticket_id !== ticketId || parent.kind !== ACTIVITY_KIND.NOTE) {
        throw new Error('That note is no longer available for replies.');
      }
    }

    if (!body && !files.length && !/\[imgtmp:[A-Za-z0-9_-]+\]/.test(markup)) {
      throw new Error('A note cannot be empty.');
    }

    let uploaded = { resources: [], tempMap: {} };
    try {
      if (files.length) uploaded = RelatedResources.uploadForActivity(ticketId, activityId, files, {
        fast: true,
        ticket: knownTicket,
        skipAccessValidation: true,
        skipTicketValidation: !!knownTicket
      });
      markup = RelatedResources.replaceTempImageTokens(markup, uploaded.tempMap);

      if (!body) {
        const named = uploaded.resources.filter(function (r) { return r.resource_type === 'attachment'; });
        body = named.length ? 'Attached ' + named.map(function (r) { return r.name; }).join(', ') : 'Added an image.';
      }

      const entry = {
        activity_id: activityId,
        ticket_id: ticketId,
        // Imported sources such as Gmail can supply their original event time so
        // the activity timeline stays chronological. Ticket last_activity_at still
        // uses processing time (`now`) so backfilled email does not make a ticket
        // appear artificially idle.
        timestamp: activityAt,
        actor: Repo.me(),
        kind: ACTIVITY_KIND.NOTE,
        body: body,
        ref: String(payload.ref || ''),
        parent_activity_id: parentActivityId || '',
        edited_at: '',
        deleted: false,
        deleted_at: '',
        body_markup: markup
      };

      Repo.append(TABS.ACTIVITY, entry);
      Repo.update(TABS.TICKETS, 'ticket_id', ticketId, { last_activity_at: now, updated_at: now });

      const ticket = knownTicket || ((Repo.findOneFast || Repo.findOne)(TABS.TICKETS, 'ticket_id', ticketId));
      if (ticket) {
        notifyMentions_(ticket, body);
        notifyWatchers_(ticket, 'note', body, entry.actor);
      }

      // Normal dashboard notes scan the whole ticket for pasted URLs. Gmail imports
      // use a targeted fast path in GmailTicketing so they do not repeatedly reread
      // every existing note and relationship before returning control to Gmail.
      if (!options.skipAutoSync) {
        try { RelatedStudents.syncFromTicket(ticketId); } catch (ignore) {}
        try { RelatedResources.syncFromTicket(ticketId); } catch (ignore) {}
      }

      const result = { entry: entry };
      if (!options.skipRelationLists) {
        result.students = RelatedStudents.list(ticketId);
        result.resources = RelatedResources.listAll(ticketId);
      }
      return result;
    } catch (e) {
      // uploadForActivity cleans up files when its own upload phase fails. If
      // something fails after resources were stored, remove only Project Tracker
      // relationships here; the Drive files remain recoverable rather than being
      // destructively deleted by a note-post failure.
      if (uploaded && uploaded.resources) {
        uploaded.resources.forEach(function (r) {
          try { RelatedResources.remove(ticketId, r.resource_id); } catch (ignore) {}
        });
      }
      throw e;
    }
  }

  /**
   * Adds a rich activity imported from another source while preserving the source
   * actor and timestamp. Google Chat uses this so each Chat message remains an
   * immutable, timestamp-accurate activity instead of masquerading as a normal note.
   */
  function addImportedRichActivity(ticketId, kind, payload, activityTimestamp, actor, options) {
    Repo.requireAccess('agent');
    payload = payload || {};
    options = options || {};
    if (kind !== ACTIVITY_KIND.CHAT && kind !== ACTIVITY_KIND.EMAIL) {
      throw new Error('Unsupported imported activity kind.');
    }
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);
    if (ticket.deleted === true || ticket.deleted === 'TRUE') throw new Error('Restore this ticket before importing activity.');

    const now = Repo.now();
    let activityAt = now;
    if (activityTimestamp) {
      const parsed = new Date(activityTimestamp);
      if (!isNaN(parsed.getTime())) activityAt = parsed.toISOString();
    }

    const activityId = Utilities.getUuid();
    const files = Array.isArray(payload.files) ? payload.files : [];
    let body = String(payload.text || '').trim();
    let markup = cleanMarkup_(payload.markup || body);
    if (!body && !files.length && !/\[imgtmp:[A-Za-z0-9_-]+\]/.test(markup)) {
      throw new Error('Imported activity cannot be empty.');
    }

    let uploaded = { resources: [], tempMap: {} };
    try {
      if (files.length) uploaded = RelatedResources.uploadForActivity(ticketId, activityId, files);
      markup = RelatedResources.replaceTempImageTokens(markup, uploaded.tempMap);
      if (!body) {
        const named = uploaded.resources.filter(function (r) { return r.resource_type === 'attachment'; });
        body = named.length ? 'Attached ' + named.map(function (r) { return r.name; }).join(', ') : 'Shared an image.';
      }

      const entry = {
        activity_id: activityId,
        ticket_id: ticketId,
        timestamp: activityAt,
        actor: String(actor || Repo.me()),
        kind: kind,
        body: body,
        ref: String(payload.ref || ''),
        parent_activity_id: '',
        edited_at: '',
        deleted: false,
        deleted_at: '',
        body_markup: markup
      };
      Repo.append(TABS.ACTIVITY, entry);
      Repo.update(TABS.TICKETS, 'ticket_id', ticketId, { last_activity_at: now, updated_at: now });
      if (!options.skipAutoSync) {
        try { RelatedStudents.syncFromTicket(ticketId); } catch (ignore) {}
        try { RelatedResources.syncFromTicket(ticketId); } catch (ignore) {}
      }
      const result = { entry: entry };
      if (!options.skipRelationLists) {
        result.students = RelatedStudents.list(ticketId);
        result.resources = RelatedResources.listAll(ticketId);
      }
      return result;
    } catch (e) {
      if (uploaded && uploaded.resources) {
        uploaded.resources.forEach(function (r) {
          try { RelatedResources.remove(ticketId, r.resource_id); } catch (ignore) {}
        });
      }
      throw e;
    }
  }

  function editNoteRich(activityId, payload) {
    Repo.requireAccess('agent');
    payload = payload || {};
    const note = Repo.findOne(TABS.ACTIVITY, 'activity_id', activityId);
    if (!note || note.kind !== ACTIVITY_KIND.NOTE) throw new Error('Note not found.');
    if (note.deleted === true || note.deleted === 'TRUE') throw new Error('Deleted notes cannot be edited.');

    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', note.ticket_id);
    if (!ticket) throw new Error('Ticket not found.');

    const body = String(payload.text || '').trim();
    const markup = cleanMarkup_(payload.markup || body);
    if (!body && !/\[img:[A-Za-z0-9_-]+\]/.test(markup)) throw new Error('A note cannot be empty.');

    const now = Repo.now();
    const out = Repo.update(TABS.ACTIVITY, 'activity_id', activityId, {
      body: body,
      body_markup: markup,
      edited_at: now
    });
    Repo.update(TABS.TICKETS, 'ticket_id', note.ticket_id, { last_activity_at: now, updated_at: now });
    notifyNewMentions_(ticket, body, note.body || '');
    logChange_(note.ticket_id, 'edited a note');
    let students = [], resources = [];
    try { students = RelatedStudents.syncFromTicket(note.ticket_id).rows || RelatedStudents.list(note.ticket_id); } catch (ignore) { try { students = RelatedStudents.list(note.ticket_id); } catch (ignored) {} }
    try { resources = RelatedResources.syncFromTicket(note.ticket_id).rows || RelatedResources.listAll(note.ticket_id); } catch (ignore) { try { resources = RelatedResources.listAll(note.ticket_id); } catch (ignored) {} }
    return { entry: out, students: students, resources: resources };
  }

  function editNote(activityId, body) {
    Repo.requireAccess('agent');
    const note = Repo.findOne(TABS.ACTIVITY, 'activity_id', activityId);
    if (!note || note.kind !== ACTIVITY_KIND.NOTE) throw new Error('Note not found.');
    if (note.deleted === true || note.deleted === 'TRUE') throw new Error('Deleted notes cannot be edited.');

    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', note.ticket_id);
    if (!ticket) throw new Error('Ticket not found.');

    const now = Repo.now();
    const cleanBody = String(body || '').trim();
    if (!cleanBody) throw new Error('A note cannot be empty.');

    const out = Repo.update(TABS.ACTIVITY, 'activity_id', activityId, {
      body: cleanBody,
      body_markup: cleanBody,
      edited_at: now
    });
    Repo.update(TABS.TICKETS, 'ticket_id', note.ticket_id, { last_activity_at: now, updated_at: now });
    notifyNewMentions_(ticket, cleanBody, note.body || '');
    logChange_(note.ticket_id, 'edited a note');
    return out;
  }

  function deleteNote(activityId) {
    Repo.requireAccess('agent');
    const note = Repo.findOne(TABS.ACTIVITY, 'activity_id', activityId);
    if (!note || note.kind !== ACTIVITY_KIND.NOTE) throw new Error('Note not found.');
    if (note.deleted === true || note.deleted === 'TRUE') return note;

    const now = Repo.now();
    const out = Repo.update(TABS.ACTIVITY, 'activity_id', activityId, {
      deleted: true,
      deleted_at: now
    });
    Repo.update(TABS.TICKETS, 'ticket_id', note.ticket_id, { updated_at: now });
    logChange_(note.ticket_id, 'deleted a note');
    return out;
  }

  function deleteChatActivity(activityId) {
    Repo.requireAccess('agent');
    const entry = Repo.findOne(TABS.ACTIVITY, 'activity_id', activityId);
    if (!entry || entry.kind !== ACTIVITY_KIND.CHAT) throw new Error('Chat message not found.');
    if (entry.deleted === true || entry.deleted === 'TRUE') return entry;

    const now = Repo.now();
    const out = Repo.update(TABS.ACTIVITY, 'activity_id', activityId, {
      deleted: true,
      deleted_at: now
    });
    Repo.update(TABS.TICKETS, 'ticket_id', entry.ticket_id, { updated_at: now });
    logChange_(entry.ticket_id, 'deleted a Google Chat message from the project');
    return out;
  }

  function chatBatchKey_(entry) {
    const raw = String(entry && entry.ref || '');
    if (raw.indexOf('gchat:') !== 0) return 'activity:' + String(entry && entry.activity_id || '');
    try {
      const meta = JSON.parse(raw.substring(6)) || {};
      if (meta.batch_id) return 'batch:' + String(meta.batch_id);
      if (meta.thread_name) return 'thread:' + String(meta.thread_name);
      if (meta.space_name) return 'space:' + String(meta.space_name);
    } catch (ignore) {}
    return 'activity:' + String(entry && entry.activity_id || '');
  }

  function deleteChatBatch(activityId) {
    Repo.requireAccess('agent');
    const seed = Repo.findOne(TABS.ACTIVITY, 'activity_id', activityId);
    if (!seed || seed.kind !== ACTIVITY_KIND.CHAT) throw new Error('Chat note not found.');

    const batchKey = chatBatchKey_(seed);
    const rows = Repo.findAll(TABS.ACTIVITY, 'ticket_id', seed.ticket_id).filter(function (entry) {
      return entry.kind === ACTIVITY_KIND.CHAT &&
        entry.deleted !== true && entry.deleted !== 'TRUE' &&
        chatBatchKey_(entry) === batchKey;
    });
    if (!rows.length) return { deletedIds: [], count: 0, deletedAt: '' };

    const now = Repo.now();
    const patches = {};
    rows.forEach(function (entry) { patches[String(entry.activity_id)] = { deleted: true, deleted_at: now }; });
    Repo.updateMany(TABS.ACTIVITY, 'activity_id', patches);
    Repo.update(TABS.TICKETS, 'ticket_id', seed.ticket_id, { updated_at: now });
    logChange_(seed.ticket_id, 'deleted an imported Google Chat conversation from the project');
    return {
      deletedIds: rows.map(function (entry) { return String(entry.activity_id); }),
      count: rows.length,
      deletedAt: now
    };
  }

  function logChange_(ticketId, text, ref) {
    try {
      const entry = {
        activity_id: Utilities.getUuid(),
        ticket_id: ticketId,
        timestamp: Repo.now(),
        actor: Repo.me(),
        kind: ACTIVITY_KIND.CHANGE,
        body: text,
        ref: String(ref || ''),
        parent_activity_id: '',
        edited_at: '',
        deleted: false,
        deleted_at: '',
        body_markup: ''
      };
      Repo.append(TABS.ACTIVITY, entry);
      return entry;
    } catch (e) {
      Logger.log('change log failed: %s', e.message);
      return null;
    }
  }

  function activityFor(ticketId, opts) {
    opts = opts || {};
    const rows = opts.fast && Repo.findAllFast
      ? Repo.findAllFast(TABS.ACTIVITY, 'ticket_id', ticketId)
      : Repo.findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
    return rows.sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  }

  // -- watches ---------------------------------------------------------------

  function bool_(v) {
    return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
  }

  function watchRowFromRows_(rows, email) {
    const key = String(email || '').toLowerCase();
    return (rows || []).filter(function (w) {
      return String(w.user_email || '').toLowerCase() === key;
    })[0] || null;
  }

  function watchRowFor_(ticketId, email) {
    return watchRowFromRows_(Repo.findAll(TABS.WATCHES, 'ticket_id', ticketId), email);
  }

  function watchSettingsFromRows_(rows, email) {
    const row = watchRowFromRows_(rows, email);
    return {
      watching: !!row && (bool_(row.on_complete) || bool_(row.on_note) || bool_(row.on_progress) || bool_(row.chat_on_complete)),
      on_complete: !!row && bool_(row.on_complete),
      on_note: !!row && bool_(row.on_note),
      on_progress: !!row && bool_(row.on_progress),
      chat_on_complete: !!row && bool_(row.chat_on_complete)
    };
  }

  function watchSettingsFor_(ticketId, email) {
    return watchSettingsFromRows_(Repo.findAll(TABS.WATCHES, 'ticket_id', ticketId), email);
  }

  function watchersCacheKey_(ticketId) {
    return 'watchers_' + String(ticketId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function watchersFromRows_(sourceRows) {
    const seen = {};
    return (sourceRows || []).filter(function (w) {
      return bool_(w.on_complete) || bool_(w.on_note) || bool_(w.on_progress) || bool_(w.chat_on_complete);
    }).filter(function (w) {
      const key = String(w.user_email || '').toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    }).map(function (w) {
      return {
        email: w.user_email,
        on_complete: bool_(w.on_complete),
        on_note: bool_(w.on_note),
        on_progress: bool_(w.on_progress),
        chat_on_complete: bool_(w.chat_on_complete)
      };
    });
  }

  function watchersFor_(ticketId) {
    const cacheKey = watchersCacheKey_(ticketId);
    const cached = Repo.cacheGet(cacheKey);
    if (cached) return cached;
    const finder = Repo.findAllFast || Repo.findAll;
    const rows = watchersFromRows_(finder(TABS.WATCHES, 'ticket_id', ticketId));
    Repo.cachePut(cacheKey, rows, 60);
    return rows;
  }

  function watchBundleFor_(ticketId, email, fast) {
    const sourceRows = fast && Repo.findAllFast
      ? Repo.findAllFast(TABS.WATCHES, 'ticket_id', ticketId)
      : Repo.findAll(TABS.WATCHES, 'ticket_id', ticketId);
    const watchers = watchersFromRows_(sourceRows);
    Repo.cachePut(watchersCacheKey_(ticketId), watchers, 60);
    return {
      watch: watchSettingsFromRows_(sourceRows, email),
      watchers: watchers
    };
  }

  function watchers(ticketId) {
    Repo.requireAccess('agent');
    const wanted = String(ticketId);
    const exists = ticketIndex_().some(function (ticket) { return String(ticket.ticket_id) === wanted; });
    if (!exists) throw new Error('No such ticket: ' + ticketId);
    return watchersFor_(ticketId);
  }

  function watchSettings(ticketId) {
    const user = Repo.requireAccess('agent');
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);
    return watchSettingsFor_(ticketId, user.email);
  }

  function setWatch(ticketId, settings) {
    const user = Repo.requireAccess('agent');
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);
    if (ticket.deleted === true || ticket.deleted === 'TRUE') {
      throw new Error('Restore this ticket before changing watch settings.');
    }

    settings = settings || {};
    const next = {
      on_complete: bool_(settings.on_complete),
      on_note: bool_(settings.on_note),
      on_progress: bool_(settings.on_progress),
      chat_on_complete: bool_(settings.chat_on_complete)
    };
    const any = next.on_complete || next.on_note || next.on_progress || next.chat_on_complete;
    if (next.chat_on_complete && typeof ChatTicketing !== 'undefined') {
      ChatTicketing.assertWatcherDmAvailable(user.email);
    }
    const existing = watchRowFor_(ticketId, user.email);
    const now = Repo.now();

    if (!any) {
      if (existing) Repo.remove(TABS.WATCHES, 'watch_id', existing.watch_id);
      Repo.cacheRemove(watchersCacheKey_(ticketId));
      return { watching: false, on_complete: false, on_note: false, on_progress: false, chat_on_complete: false };
    }

    if (existing) {
      Repo.update(TABS.WATCHES, 'watch_id', existing.watch_id, {
        on_complete: next.on_complete,
        on_note: next.on_note,
        on_progress: next.on_progress,
        chat_on_complete: next.chat_on_complete,
        updated_at: now
      });
    } else {
      Repo.append(TABS.WATCHES, {
        watch_id: Utilities.getUuid(),
        ticket_id: ticketId,
        user_email: user.email,
        on_complete: next.on_complete,
        on_note: next.on_note,
        on_progress: next.on_progress,
        chat_on_complete: next.chat_on_complete,
        created_at: now,
        updated_at: now
      });
    }

    Repo.cacheRemove(watchersCacheKey_(ticketId));
    return {
      watching: true,
      on_complete: next.on_complete,
      on_note: next.on_note,
      on_progress: next.on_progress,
      chat_on_complete: next.chat_on_complete
    };
  }

  function notifyWatchers_(ticket, eventName, body, actor) {
    if (!ticket) return;
    const field = eventName === 'complete' ? 'on_complete' :
                  eventName === 'note' ? 'on_note' :
                  eventName === 'progress' ? 'on_progress' : '';
    if (!field) return;

    const kind = 'watch_' + eventName;
    const mentioned = {};
    if (eventName === 'note') {
      mentionEmails_(body).forEach(function (email) { mentioned[String(email).toLowerCase()] = true; });
    }

    Repo.findAll(TABS.WATCHES, 'ticket_id', ticket.ticket_id).forEach(function (w) {
      if (!bool_(w[field])) return;
      if (mentioned[String(w.user_email || '').toLowerCase()]) return; // mention notification already covers it
      createNotification_(w.user_email, ticket, kind, body, actor || Repo.me());
    });
  }

  // -- notifications ---------------------------------------------------------

  function mentionEmails_(text) {
    text = String(text || '');
    if (!text) return [];

    const out = [];
    const seen = {};

    Repo.activeAgents().filter(function (a) { return String(a.role || '').toLowerCase() !== 'viewer'; }).forEach(function (a) {
      const display = String(a.display_name || '').trim();
      const first = display.split(/\s+/)[0];
      const aliases = [first, display, display.replace(/\s+/g, ''), display.replace(/\s+/g, '.')]
        .filter(Boolean);

      const hit = aliases.some(function (alias) {
        const safe = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return new RegExp('(^|\\s|[\\(\\[,{])@' + safe + '(?=$|\\s|[.,!?:;\\)\\]}])', 'i').test(text);
      });

      if (hit) {
        const email = String(a.email).toLowerCase();
        if (!seen[email]) {
          seen[email] = true;
          out.push(a.email);
        }
      }
    });

    return out;
  }

  function notificationCacheKey_(email) {
    return 'notice_summary_' + String(email).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }

  function mentionedCacheKey_(email) {
    return 'mentioned_tickets_' + String(email).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }

  function createNotification_(email, ticket, kind, body, actor) {
    if (!email || !ticket) return null;
    actor = actor || Repo.me();
    if (String(email).toLowerCase() === String(actor).toLowerCase()) return null;

    const row = {
      notification_id: Utilities.getUuid(),
      user_email: email,
      ticket_id: ticket.ticket_id,
      timestamp: Repo.now(),
      actor: actor,
      kind: kind,
      body: String(body || '').replace(/\s+/g, ' ').trim().substring(0, 220),
      read_at: '',
      title: ticket.title || ticket.ticket_id,
      archived_at: ''
    };

    try {
      Repo.append(TABS.NOTIFICATIONS, row);
      Repo.cacheRemove(notificationCacheKey_(email));
      if (kind === 'mention') Repo.cacheRemove(mentionedCacheKey_(email));
      return row;
    } catch (e) {
      Logger.log('notification failed: %s', e.message);
      return null;
    }
  }

  function notifyNewMentions_(ticket, newText, oldText) {
    const oldSet = {};
    mentionEmails_(oldText).forEach(function (email) { oldSet[String(email).toLowerCase()] = true; });
    const fresh = mentionEmails_(newText).filter(function (email) {
      return !oldSet[String(email).toLowerCase()];
    });
    notifyMentions_(ticket, newText, fresh);
  }

  function notifyMentions_(ticket, text, onlyEmails) {
    const actor = Repo.me();
    const emails = onlyEmails || mentionEmails_(text);
    if (!emails.length) return;

    emails.forEach(function (email) {
      createNotification_(email, ticket, 'mention', text, actor);
    });
  }

  function notifyNewAssignments_(ticket, oldOwners, newOwners, actor) {
    const oldSet = {};
    ownerList_(oldOwners).forEach(function (email) { oldSet[email.toLowerCase()] = true; });
    ownerList_(newOwners).forEach(function (email) {
      const key = email.toLowerCase();
      if (!oldSet[key] && key !== String(actor).toLowerCase()) {
        createNotification_(email, ticket, 'assignment', 'You were assigned to this ticket.', actor);
      }
    });
  }

  function viewerShareKey_(ticketId) {
    return 'VIEW_SHARE_' + String(ticketId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function viewerShareToken_(ticketId) {
    const props = PropertiesService.getScriptProperties();
    const key = viewerShareKey_(ticketId);
    let token = String(props.getProperty(key) || '');
    if (!token) {
      token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
      props.setProperty(key, token);
    }
    return token;
  }

  function safeTokenEquals_(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /**
   * Agents/editors can read any ticket. Viewers need the per-ticket signed URL
   * token. This is enforced server-side so changing TKT-#### in the address bar
   * cannot expose a different project.
   */
  function assertReadAccess(ticketId, shareToken) {
    const user = Repo.requireAccess('viewer');
    if (user.role !== 'viewer') return user;
    const expected = String(PropertiesService.getScriptProperties().getProperty(viewerShareKey_(ticketId)) || '');
    if (!expected || !safeTokenEquals_(expected, shareToken)) {
      throw new Error('This viewer account can only open a valid shared project link.');
    }
    return user;
  }

  function viewerSharePayload(ticketId) {
    Repo.requireAccess('agent');
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);
    return { ticketId: String(ticketId), shareToken: viewerShareToken_(ticketId) };
  }

  function viewerShareUrl(ticketId) {
    const payload = viewerSharePayload(ticketId);
    const base = String(ScriptApp.getService().getUrl() || '').split('?')[0];
    if (!base) throw new Error('Could not determine the Project Tracker web app URL.');
    return base + '?ticket=' + encodeURIComponent(payload.ticketId) + '&share=' + encodeURIComponent(payload.shareToken);
  }

  function canSetPriority() {
    const user = Repo.requireAccess('viewer');
    return user.role === 'editor';
  }

  function setHighPriority(ticketId, on) {
    const user = Repo.requireAccess('editor');

    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);
    if (ticket.deleted === true || ticket.deleted === 'TRUE') throw new Error('Restore this ticket before changing priority.');

    const enabled = on === true || on === 'true' || on === 'TRUE';
    const wasEnabled = ticket.high_priority === true || ticket.high_priority === 'TRUE';
    if (enabled === wasEnabled) return ticket;

    const now = Repo.now();
    const out = Repo.update(TABS.TICKETS, 'ticket_id', ticketId, {
      high_priority: enabled,
      priority_by: enabled ? user.email : '',
      priority_at: enabled ? now : '',
      updated_at: now
    });

    logChange_(ticketId, enabled ? 'flagged this ticket as high priority' : 'removed the high priority flag');

    if (enabled) {
      Repo.activeAgents().filter(function (a) { return a.role === 'agent'; }).forEach(function (a) {
        createNotification_(a.email, out, 'priority', 'This ticket was marked high priority.', user.email);
      });
    }

    return out;
  }

  function notifyClosedEmailReply(ticketId, count, subject, sender) {
    const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket || ticket.status !== STATUS.COMPLETED || ticket.deleted === true || ticket.deleted === 'TRUE') return [];
    const n = Math.max(1, Number(count) || 1);
    const body = (n === 1 ? 'A new email reply arrived' : n + ' new email replies arrived') +
      ' on the watched thread' + (subject ? ' "' + subject + '"' : '') +
      (sender ? ' from ' + sender : '') + '. Open the ticket to review it and reopen the project if needed.';
    const actor = 'gmail-watch@projecttracker.local';
    const created = [];
    ownerList_(ticket.owners).forEach(function (email) {
      const row = createNotification_(email, ticket, 'watch_email_closed', body, actor);
      if (row) created.push(row);
    });
    return created;
  }

  function decoratedNotifications_(email) {
    const cutoff = Date.now() - CONFIG.NOTIFICATION_ARCHIVE_DAYS * 86400000;
    const titleMap = {};
    ticketIndex_().forEach(function (t) { titleMap[t.ticket_id] = t.title; });

    const finder = Repo.findAllFast || Repo.findAll;
    return finder(TABS.NOTIFICATIONS, 'user_email', email).map(function (n) {
      const ts = new Date(n.timestamp).getTime();
      const archived = !!n.archived_at || (!isNaN(ts) && ts < cutoff);
      n.title = titleMap[n.ticket_id] || n.title || n.ticket_id;
      n.archived = archived;
      return n;
    });
  }

  function notificationSummary() {
    const user = Repo.requireAccess('agent');
    const key = notificationCacheKey_(user.email);
    const cached = Repo.cacheGet(key);
    if (cached) return cached;

    const active = decoratedNotifications_(user.email)
      .filter(function (n) { return !n.archived; })
      .sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });

    const unread = active.filter(function (n) { return !n.read_at; }).slice(0, 30);
    const recentRead = active.filter(function (n) { return !!n.read_at; }).slice(0, CONFIG.NOTIFICATION_RECENT_READ);
    const out = { unread: unread, recentRead: recentRead, unreadCount: active.filter(function (n) { return !n.read_at; }).length };
    Repo.cachePut(key, out, CONFIG.NOTIFICATION_CACHE_SECONDS);
    return out;
  }

  function notificationInbox(opts) {
    const user = Repo.requireAccess('agent');
    opts = opts || {};
    const q = String(opts.q || '').toLowerCase().trim();
    const scope = opts.scope || 'all';
    const kind = opts.kind || 'all';
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));

    let rows = decoratedNotifications_(user.email)
      .sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });

    if (scope === 'active') rows = rows.filter(function (n) { return !n.archived; });
    if (scope === 'archived') rows = rows.filter(function (n) { return n.archived; });
    if (kind === 'watch') rows = rows.filter(function (n) { return String(n.kind).indexOf('watch_') === 0; });
    else if (kind !== 'all') rows = rows.filter(function (n) { return n.kind === kind; });
    if (q) {
      rows = rows.filter(function (n) {
        return String(n.title).toLowerCase().indexOf(q) >= 0 ||
               String(n.body).toLowerCase().indexOf(q) >= 0 ||
               String(n.ticket_id).toLowerCase().indexOf(q) >= 0;
      });
    }

    return {
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset: offset,
      limit: limit,
      hasMore: offset + limit < rows.length
    };
  }

  function markNotificationRead(notificationId) {
    const user = Repo.requireAccess('agent');
    const n = Repo.findOne(TABS.NOTIFICATIONS, 'notification_id', notificationId);
    if (!n) throw new Error('Notification not found.');
    if (String(n.user_email).toLowerCase() !== String(user.email).toLowerCase()) {
      throw new Error('That notification belongs to another user.');
    }
    if (n.read_at) return n;
    const out = Repo.update(TABS.NOTIFICATIONS, 'notification_id', notificationId, { read_at: Repo.now() });
    Repo.cacheRemove(notificationCacheKey_(user.email));
    return out;
  }

  function mentionedTicketIds_(email) {
    const key = mentionedCacheKey_(email);
    const cached = Repo.cacheGet(key);
    if (cached) return cached;

    const ids = {};
    const finder = Repo.findAllFast || Repo.findAll;
    finder(TABS.NOTIFICATIONS, 'user_email', email).forEach(function (n) {
      if (n.kind === 'mention') ids[n.ticket_id] = true;
    });
    Repo.cachePut(key, ids, 300);
    return ids;
  }


  // -- presence --------------------------------------------------------------

  function presence(ticketId) {
    const user = Repo.requireAccess('agent');
    const key = 'presence_' + String(ticketId).replace(/[^A-Za-z0-9_-]/g, '_');
    const now = Date.now();
    const cutoff = now - CONFIG.PRESENCE_ACTIVE_MS;
    const map = Repo.cacheGet(key) || {};

    Object.keys(map).forEach(function (email) {
      if (Number(map[email]) < cutoff) delete map[email];
    });
    map[user.email] = now;
    Repo.cachePut(key, map, CONFIG.PRESENCE_CACHE_SECONDS);

    return Object.keys(map)
      .filter(function (email) {
        return email.toLowerCase() !== user.email.toLowerCase() && Number(map[email]) >= cutoff;
      })
      .map(function (email) { return { email: email }; });
  }


  // -- ticket links ----------------------------------------------------------

  function rawLinksFor_(ticketId, fast) {
    const finder = fast && Repo.findAllFast ? Repo.findAllFast : Repo.findAll;
    const byA = finder(TABS.LINKS, 'ticket_a', ticketId);
    const byB = finder(TABS.LINKS, 'ticket_b', ticketId);
    const seen = {};
    return byA.concat(byB).filter(function (l) {
      if (seen[l.link_id]) return false;
      seen[l.link_id] = true;
      return true;
    });
  }

  function linksFor(ticketId, opts) {
    opts = opts || {};
    if (!opts.skipAccessValidation) Repo.requireAccess('viewer');
    const rows = rawLinksFor_(ticketId, !!opts.fast);

    if (opts.fast) {
      const ticketMap = {};
      ticketIndex_().forEach(function (ticket) { ticketMap[String(ticket.ticket_id)] = ticket; });
      return rows.map(function (l) {
        const otherId = l.ticket_a === ticketId ? l.ticket_b : l.ticket_a;
        const other = ticketMap[String(otherId)] || null;
        return {
          link_id: l.link_id,
          relation: l.relation,
          other_ticket_id: otherId,
          title: other ? other.title : otherId,
          status: other ? other.status : '',
          deleted: other ? other.deleted : false
        };
      }).sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    }

    return rows.map(function (l) {
      const otherId = l.ticket_a === ticketId ? l.ticket_b : l.ticket_a;
      const other = Repo.findOne(TABS.TICKETS, 'ticket_id', otherId);
      return {
        link_id: l.link_id,
        relation: l.relation,
        other_ticket_id: otherId,
        title: other ? other.title : otherId,
        status: other ? other.status : '',
        deleted: other ? other.deleted : false
      };
    }).sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
  }

  function hasLink_(a, b) {
    return rawLinksFor_(a).some(function (l) {
      return (l.ticket_a === a && l.ticket_b === b) || (l.ticket_a === b && l.ticket_b === a);
    });
  }

  function linkTickets(ticketId, otherId, relation) {
    Repo.requireAccess('agent');
    if (!ticketId || !otherId || ticketId === otherId) throw new Error('Choose a different ticket to link.');
    const a = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    const b = Repo.findOne(TABS.TICKETS, 'ticket_id', otherId);
    if (!a || !b) throw new Error('One of those tickets no longer exists.');
    if (!hasLink_(ticketId, otherId)) {
      Repo.append(TABS.LINKS, {
        link_id: Utilities.getUuid(),
        ticket_a: ticketId,
        ticket_b: otherId,
        relation: relation || 'related',
        created_at: Repo.now()
      });
      logChange_(ticketId, 'linked this ticket to ' + otherId);
      logChange_(otherId, 'linked this ticket to ' + ticketId);
    }
    return linksFor(ticketId);
  }

  function unlinkTicket(linkId, ticketId) {
    Repo.requireAccess('agent');
    const l = Repo.findOne(TABS.LINKS, 'link_id', linkId);
    if (!l) return linksFor(ticketId);
    Repo.remove(TABS.LINKS, 'link_id', linkId);
    logChange_(ticketId, 'removed a ticket link');
    return linksFor(ticketId);
  }

  function searchTickets(q, excludeId) {
    Repo.requireAccess('agent');
    const raw = String(q || '').trim();
    let directId = '';
    const routeMatch = raw.match(/[?&]ticket=(TKT-\d+)/i);
    const idMatch = raw.match(/\b(TKT-\d+)\b/i);
    if (routeMatch) directId = routeMatch[1].toUpperCase();
    else if (/^https?:\/\//i.test(raw) && idMatch) directId = idMatch[1].toUpperCase();
    q = (directId || raw).toLowerCase();
    if (!q) return [];

    return ticketIndex_().filter(function (t) {
      return !(t.deleted === true || t.deleted === 'TRUE') && t.ticket_id !== excludeId &&
        (String(t.ticket_id).toLowerCase().indexOf(q) >= 0 || String(t.title).toLowerCase().indexOf(q) >= 0);
    }).slice(0, CONFIG.LINK_SEARCH_LIMIT);
  }


  // -- global search --------------------------------------------------------

  function activeBool_(v) { return !(v === true || String(v).toUpperCase() === 'TRUE'); }

  function ownerContains_(owners, email) {
    email = String(email || '').trim().toLowerCase();
    if (!email) return true;
    return ownerList_(owners).some(function (x) { return String(x).toLowerCase() === email; });
  }

  /**
   * Cross-project search used by the header search bar. Unlike the status-page
   * list filter, this searches all active statuses and can optionally include
   * soft-deleted/archived tickets. It also indexes activity text plus the
   * active Related Students and Related Resources sidebar relationships.
   */
  function globalSearch(opts) {
    Repo.requireAccess('agent');
    opts = opts || {};
    const raw = String(opts.q || '').trim();
    const includeArchived = opts.includeArchived === true || String(opts.includeArchived).toUpperCase() === 'TRUE';
    const status = String(opts.status || '').trim();
    const type = String(opts.type || '').trim();
    const owner = String(opts.owner || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 100));
    if (!raw) return { rows: [], total: 0 };

    // Search normalization intentionally makes names/content forgiving without
    // turning IDs into fuzzy matches. It is case-insensitive, accent-insensitive,
    // punctuation-insensitive and treats multiple words as AND terms.
    function normalize_(value) {
      let s = String(value == null ? '' : value);
      try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
      return s.toLowerCase()
        .replace(/\[(?:\/?b|\/?i|\/?u)\]/g, ' ')
        .replace(/\[(?:stu|res|img|imgtmp):[^\]]+\]/g, ' ')
        .replace(/[^a-z0-9@._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function queryTerms_(value) {
      const normalized = normalize_(value);
      return normalized ? normalized.split(' ').filter(Boolean) : [];
    }
    const q = normalize_(raw);
    const terms = queryTerms_(raw);
    if (!terms.length) return { rows: [], total: 0 };
    function hasAllTerms_(value) {
      const text = normalize_(value);
      return !!text && terms.every(function (term) { return text.indexOf(term) >= 0; });
    }
    function hasAnyTerm_(value) {
      const text = normalize_(value);
      return !!text && terms.some(function (term) { return text.indexOf(term) >= 0; });
    }
    function snippet_(value) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const low = normalize_(text);
      let at = -1;
      terms.some(function (term) { at = low.indexOf(term); return at >= 0; });
      if (at < 0) return text.slice(0, 160);
      // Normalization can slightly change character positions for accents; this
      // is only a display hint, so a close approximation is sufficient.
      const start = Math.max(0, at - 55), end = Math.min(text.length, at + Math.max(raw.length, 12) + 95);
      return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }

    const activitiesByTicket = {};
    Repo.readAll(TABS.ACTIVITY).forEach(function (a) {
      const deleted = a.deleted === true || String(a.deleted).toUpperCase() === 'TRUE';
      if (deleted) return;
      const id = String(a.ticket_id || '');
      if (!id) return;
      (activitiesByTicket[id] || (activitiesByTicket[id] = [])).push(a);
    });

    const studentsByTicket = {};
    Repo.readAll(TABS.RELATED_STUDENTS).forEach(function (r) {
      if (r.removed === true || String(r.removed).toUpperCase() === 'TRUE') return;
      const id = String(r.ticket_id || '');
      if (!id) return;
      (studentsByTicket[id] || (studentsByTicket[id] = [])).push(r);
    });

    const resourcesByTicket = {};
    Repo.readAll(TABS.RELATED_RESOURCES).forEach(function (r) {
      if (r.removed === true || String(r.removed).toUpperCase() === 'TRUE') return;
      const id = String(r.ticket_id || '');
      if (!id) return;
      (resourcesByTicket[id] || (resourcesByTicket[id] = [])).push(r);
    });

    function source_(kind, label, values, score) {
      const joined = values.filter(function (x) { return x !== null && x !== undefined && String(x).trim(); }).join(' ');
      return { kind: kind, label: label, text: joined, score: score || 0 };
    }
    function scoreSource_(src) {
      const text = normalize_(src.text);
      if (!text) return -1;
      if (!terms.every(function (term) { return text.indexOf(term) >= 0; })) return -1;
      let score = src.score;
      if (text === q) score += 45;
      else if (text.indexOf(q) === 0) score += 28;
      else if (q && text.indexOf(q) >= 0) score += 18;
      terms.forEach(function (term) {
        if (text === term) score += 10;
        else if (text.indexOf(term) === 0) score += 5;
      });
      return score;
    }

    const matches = [];
    ticketIndex_().forEach(function (t) {
      const archived = t.deleted === true || String(t.deleted).toUpperCase() === 'TRUE';
      if (archived && !includeArchived) return;
      if (status && t.status !== status) return;
      if (type && t.type !== type) return;
      if (owner && !ownerContains_(t.owners, owner)) return;

      const sources = [];
      sources.push(source_('Ticket', 'Ticket title', [t.title], 120));
      sources.push(source_('Ticket', 'Ticket ID', [t.ticket_id], 125));
      sources.push(source_('Ticket', 'Project details', [t.description, t.description_markup], 75));
      sources.push(source_('Ticket', 'Ticket fields', [t.type, t.department, t.owners, t.size, t.status, t.substatus], 55));

      (studentsByTicket[t.ticket_id] || []).forEach(function (r) {
        const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
        // Keep first and last name together in one source so searches for either
        // surname alone or "First Last" work exactly like users expect from the
        // Related Students card.
        sources.push(source_('Related student', fullName || r.element_id || 'Student', [
          fullName, r.first_name, r.last_name, r.element_id, r.profile_url
        ], 105));
      });

      (resourcesByTicket[t.ticket_id] || []).forEach(function (r) {
        sources.push(source_('Related resource', r.name || r.external_id || r.url || 'Resource', [
          r.name, r.external_id, r.url, r.drive_file_id, r.resource_type, r.mime_type
        ], 95));
      });

      (activitiesByTicket[t.ticket_id] || []).forEach(function (a) {
        const kind = a.kind === ACTIVITY_KIND.EMAIL ? 'Email' : a.kind === ACTIVITY_KIND.CHAT ? 'Chat' : 'Note / activity';
        sources.push(source_(kind, kind, [a.body, a.body_markup, a.actor, a.ref], 65));
      });

      // First try to satisfy all query terms inside one logical source. If a
      // user searches across concepts (e.g. "Smith Department"), allow the terms to be
      // satisfied across the ticket's aggregate searchable content too.
      let best = null, bestScore = -1;
      sources.forEach(function (src) {
        const score = scoreSource_(src);
        if (score > bestScore) { best = src; bestScore = score; }
      });
      if (!best) {
        const aggregate = sources.map(function (src) { return src.text; }).join(' ');
        if (hasAllTerms_(aggregate)) {
          // Pick the most useful source containing any term as the explanation.
          sources.forEach(function (src) {
            if (!hasAnyTerm_(src.text)) return;
            const score = src.score + (normalize_(src.text).indexOf(q) >= 0 ? 15 : 0);
            if (score > bestScore) { best = src; bestScore = score; }
          });
        }
      }
      if (!best) return;

      const row = {};
      INDEX_FIELDS.forEach(function (f) { row[f] = t[f]; });
      row.archived = archived;
      row.match_kind = best.kind;
      row.match_text = best.label && best.label !== best.kind ? best.label : snippet_(best.text);
      row.search_score = bestScore;
      matches.push(row);
    });

    matches.sort(function (a, b) {
      if (Number(a.search_score || 0) !== Number(b.search_score || 0)) return Number(b.search_score || 0) - Number(a.search_score || 0);
      return String(b.last_activity_at || b.updated_at || '').localeCompare(String(a.last_activity_at || a.updated_at || ''));
    });

    return { rows: matches.slice(0, limit), total: matches.length };
  }


  // -- personal dashboard ---------------------------------------------------

  function dashboardDate_(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).substring(0, 10);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function dashboardHour_(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 0;
    return Number(Utilities.formatDate(d, Session.getScriptTimeZone(), 'H')) || 0;
  }

  function dashboardPeriod_(mode, anchor) {
    mode = ['day','week','month','all'].indexOf(mode) >= 0 ? mode : 'month';
    const m = String(anchor || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const now = new Date();
    const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : now;
    function fmt(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
    function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
    if (mode === 'all') return { mode: mode, start: '', end: '', previousStart: '', previousEnd: '', label: 'All time' };
    if (mode === 'day') {
      const start = fmt(base), prev = fmt(addDays(base, -1));
      return { mode: mode, start: start, end: start, previousStart: prev, previousEnd: prev,
        label: Utilities.formatDate(base, Session.getScriptTimeZone(), 'MMM d, yyyy') };
    }
    if (mode === 'week') {
      const jsDay = base.getDay();
      const startD = addDays(base, jsDay === 0 ? -6 : 1 - jsDay), endD = addDays(startD, 6);
      const prevStart = addDays(startD, -7), prevEnd = addDays(endD, -7);
      return { mode: mode, start: fmt(startD), end: fmt(endD), previousStart: fmt(prevStart), previousEnd: fmt(prevEnd),
        label: Utilities.formatDate(startD, Session.getScriptTimeZone(), 'MMM d') + ' – ' + Utilities.formatDate(endD, Session.getScriptTimeZone(), 'MMM d, yyyy') };
    }
    const startD = new Date(base.getFullYear(), base.getMonth(), 1, 12, 0, 0);
    const endD = new Date(base.getFullYear(), base.getMonth() + 1, 0, 12, 0, 0);
    const prevStart = new Date(base.getFullYear(), base.getMonth() - 1, 1, 12, 0, 0);
    const prevEnd = new Date(base.getFullYear(), base.getMonth(), 0, 12, 0, 0);
    return { mode: mode, start: fmt(startD), end: fmt(endD), previousStart: fmt(prevStart), previousEnd: fmt(prevEnd),
      label: Utilities.formatDate(base, Session.getScriptTimeZone(), 'MMMM yyyy') };
  }

  function dashboardData(opts) {
    const user = Repo.requireAccess('agent');
    opts = opts || {};
    const period = dashboardPeriod_(opts.period || 'month', opts.anchor || '');
    let selectedOwners = Array.isArray(opts.owners) ? opts.owners : String(opts.owners || '').split(',');
    selectedOwners = selectedOwners.map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
    if (!selectedOwners.length) selectedOwners = [String(user.email || '').toLowerCase()];

    function ownerMatches(t) {
      return selectedOwners.some(function (email) { return ownerContains_(t.owners, email); });
    }
    function inRange(dateValue, start, end) {
      if (!start && !end) return true;
      const d = dashboardDate_(dateValue);
      return !!d && d >= start && d <= end;
    }
    function isArchived(t) { return t.deleted === true || String(t.deleted).toUpperCase() === 'TRUE'; }
    function isDone(t) { return t.status === STATUS.COMPLETED && t.substatus !== SUBSTATUS.HALTED; }
    function activeTouched(t, start, end) {
      return t.status === STATUS.IN_PROGRESS && inRange(t.last_activity_at || t.updated_at || t.created_at, start, end);
    }

    // Reuse the already-cached ticket index for both the normal dashboard and
    // today's live workload-flow overlay. No second ticket read/API call.
    const allTickets = ticketIndex_();
    const base = allTickets.filter(function (t) { return !isArchived(t) && ownerMatches(t); });
    const completed = base.filter(function (t) { return isDone(t) && inRange(t.completed_at, period.start, period.end); });
    const progress = base.filter(function (t) { return activeTouched(t, period.start, period.end); });
    const previousCompleted = period.mode === 'all' ? [] : base.filter(function (t) { return isDone(t) && inRange(t.completed_at, period.previousStart, period.previousEnd); });
    const previousProgress = period.mode === 'all' ? [] : base.filter(function (t) { return activeTouched(t, period.previousStart, period.previousEnd); });

    const workedMap = {};
    completed.concat(progress).forEach(function (t) { workedMap[t.ticket_id] = t; });
    const worked = Object.keys(workedMap).map(function (id) { return workedMap[id]; });

    function summaryRow(t) {
      return {
        ticket_id: t.ticket_id, title: t.title, type: t.type, department: t.department,
        owners: t.owners, size: t.size, progress: t.progress, due_date: t.due_date,
        completed_at: t.completed_at, created_at: t.created_at, last_activity_at: t.last_activity_at,
        status: t.status, substatus: t.substatus
      };
    }
    function dist(field) {
      const counts = {};
      worked.forEach(function (t) {
        const key = String(t[field] || 'Unspecified').trim() || 'Unspecified';
        counts[key] = (counts[key] || 0) + 1;
      });
      return Object.keys(counts).map(function (name) { return { name: name, count: counts[name] }; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
    }
    // Ticket-source reporting is deliberately built from one Activity-tab read.
    // The first version queried the Activity sheet once per ticket; that scaled
    // poorly as Month/All-time included more tickets and could leave the source
    // chart without usable data even while the rest of the dashboard loaded.
    const sourceActivitiesByTicket = {};
    Repo.readAll(TABS.ACTIVITY).forEach(function (a) {
      const id = String(a.ticket_id || '').trim();
      if (!id) return;
      (sourceActivitiesByTicket[id] || (sourceActivitiesByTicket[id] = [])).push(a);
    });
    Object.keys(sourceActivitiesByTicket).forEach(function (id) {
      sourceActivitiesByTicket[id].sort(function (a, b) {
        return Number(a._row || 0) - Number(b._row || 0);
      });
    });

    function creationSource_(t) {
      const rows = sourceActivitiesByTicket[t.ticket_id] || [];
      // New tickets carry an explicit source marker on their creation activity.
      // Search a small opening window rather than assuming a fixed row position.
      for (let i = 0; i < Math.min(rows.length, 8); i++) {
        const ref = String(rows[i].ref || '');
        const marker = ref.match(/(?:^|[|;\s])ptsource:(gmail|google_chat|chat|project_tracker)(?:$|[|;\s])/i);
        if (!marker) continue;
        const raw = marker[1].toLowerCase();
        if (raw === 'gmail') return 'Gmail';
        if (raw === 'google_chat' || raw === 'chat') return 'Google Chat';
        return 'Project Tracker';
      }

      // Legacy tickets predate explicit source stamping. Look only at the opening
      // activities so later-added email/chat content does not relabel a ticket.
      // Gmail/Chat creation normally imports the source immediately after creation.
      const opening = rows.slice(0, 6);
      const createdIndex = opening.findIndex(function (a) {
        return a.kind === ACTIVITY_KIND.CHANGE && /created this ticket/i.test(String(a.body || ''));
      });
      if (createdIndex >= 0) {
        for (let i = createdIndex + 1; i < opening.length; i++) {
          if (opening[i].kind === ACTIVITY_KIND.EMAIL) return 'Gmail';
          if (opening[i].kind === ACTIVITY_KIND.CHAT) return 'Google Chat';
          // Stop once normal Project Tracker work begins.
          if (opening[i].kind === ACTIVITY_KIND.NOTE || opening[i].kind === ACTIVITY_KIND.CHANGE) break;
        }
      }
      return 'Project Tracker';
    }
    function sourceDist_() {
      const counts = { 'Gmail': 0, 'Google Chat': 0, 'Project Tracker': 0 };
      worked.forEach(function (t) {
        const key = creationSource_(t);
        counts[key] = (counts[key] || 0) + 1;
      });
      return ['Gmail','Google Chat','Project Tracker'].map(function (name) {
        return { name: name, count: Number(counts[name] || 0) };
      });
    }
    function trend_() {
      const map = {}, labels = [];
      if (period.mode === 'day') {
        ['12a','4a','8a','12p','4p','8p'].forEach(function (x) { labels.push(x); map[x] = 0; });
        completed.forEach(function (t) { const h = dashboardHour_(t.completed_at), idx = Math.min(5, Math.floor(h / 4)); map[labels[idx]]++; });
      } else if (period.mode === 'week') {
        let d = new Date(period.start + 'T12:00:00');
        for (let i = 0; i < 7; i++) { const key = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); labels.push(key); map[key] = 0; d.setDate(d.getDate() + 1); }
        completed.forEach(function (t) { const key = dashboardDate_(t.completed_at); if (map[key] !== undefined) map[key]++; });
      } else if (period.mode === 'month') {
        let d = new Date(period.start + 'T12:00:00'), end = period.end;
        while (Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') <= end) { const key = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); labels.push(key); map[key] = 0; d.setDate(d.getDate() + 1); }
        completed.forEach(function (t) { const key = dashboardDate_(t.completed_at); if (map[key] !== undefined) map[key]++; });
      } else {
        const completedAll = base.filter(isDone).filter(function (t) { return !!dashboardDate_(t.completed_at); });
        const dates = completedAll.map(function (t) { return dashboardDate_(t.completed_at); }).sort();
        if (!dates.length) return [];
        const first = new Date(dates[0] + 'T12:00:00'), last = new Date(dates[dates.length - 1] + 'T12:00:00');
        const spanDays = Math.max(0, Math.round((last.getTime() - first.getTime()) / 86400000));
        if (spanDays <= 62) {
          let d = new Date(first.getTime());
          while (d <= last) {
            const key = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
            labels.push(key); map[key] = 0; d.setDate(d.getDate() + 1);
          }
          completedAll.forEach(function (t) { const key = dashboardDate_(t.completed_at); if (map[key] !== undefined) map[key]++; });
        } else if (spanDays <= 1095) {
          let d = new Date(first.getFullYear(), first.getMonth(), 1, 12, 0, 0);
          const end = new Date(last.getFullYear(), last.getMonth(), 1, 12, 0, 0);
          while (d <= end) {
            const key = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
            labels.push(key); map[key] = 0; d.setMonth(d.getMonth() + 1);
          }
          completedAll.forEach(function (t) { const key = dashboardDate_(t.completed_at).substring(0, 7); if (map[key] !== undefined) map[key]++; });
        } else {
          for (let y = first.getFullYear(); y <= last.getFullYear(); y++) { const key = String(y); labels.push(key); map[key] = 0; }
          completedAll.forEach(function (t) { const key = dashboardDate_(t.completed_at).substring(0, 4); if (map[key] !== undefined) map[key]++; });
        }
      }
      return labels.map(function (label) { return { label: label, count: map[label] || 0 }; });
    }
    function delta(current, previous) {
      if (period.mode === 'all') return null;
      if (!previous) return current ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    }

    let workloadFlow = null;
    try {
      if (typeof WorkloadStudy !== 'undefined' && WorkloadStudy.dashboardFlow) {
        workloadFlow = WorkloadStudy.dashboardFlow(selectedOwners, period, allTickets);
      }
    } catch (flowError) {
      Logger.log('Dashboard workload flow unavailable: %s', flowError && (flowError.stack || flowError.message) || flowError);
      workloadFlow = { available: false, reason: 'Workload flow could not be loaded.' };
    }

    return {
      period: period,
      owners: selectedOwners,
      workloadFlow: workloadFlow,
      completedCount: completed.length,
      inProgressCount: progress.length,
      completedDelta: delta(completed.length, previousCompleted.length),
      inProgressDelta: delta(progress.length, previousProgress.length),
      completed: completed.slice().sort(function (a, b) { return String(b.completed_at).localeCompare(String(a.completed_at)); }).slice(0, 12).map(summaryRow),
      inProgress: progress.slice().sort(function (a, b) { return String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || String(b.last_activity_at).localeCompare(String(a.last_activity_at)); }).slice(0, 12).map(summaryRow),
      byDepartment: dist('department'),
      byType: dist('type'),
      bySize: dist('size'),
      bySource: sourceDist_(),
      trend: trend_(),
      workedCount: worked.length
    };
  }


  // -- merge -----------------------------------------------------------------

  function merge(primaryId, secondaryId, selections, deleteSecondary) {
    const user = Repo.requireAccess('agent');
    if (!primaryId || !secondaryId || primaryId === secondaryId) throw new Error('Choose two different tickets.');

    const primary = Repo.findOne(TABS.TICKETS, 'ticket_id', primaryId);
    const secondary = Repo.findOne(TABS.TICKETS, 'ticket_id', secondaryId);
    if (!primary || !secondary) throw new Error('One of those tickets no longer exists.');
    if (primary.deleted === true || primary.deleted === 'TRUE') throw new Error('The primary ticket is in Trash. Restore it first.');

    selections = selections || {};
    const patch = { updated_at: Repo.now() };

    // Merge fields are deliberately single-value. The ticket title, type,
    // department, owner assignment, size, due date, and project details each
    // resolve to one surviving value. Notes are handled separately below.
    MERGE_FIELDS.forEach(function (field) {
      const choice = selections[field] || 'primary';
      if (choice === 'secondary') patch[field] = secondary[field];
    });
    if ((selections.description || 'primary') === 'secondary') {
      patch.description_markup = secondary.description_markup || secondary.description || '';
    }

    if (selections.status_bundle === 'secondary') {
      ['status','substatus','progress','completed_at','halt_reason','halt_note','waiting_who','waiting_what','waiting_since']
        .forEach(function (field) { patch[field] = secondary[field]; });
    } else if (selections.status_bundle === 'custom') {
      const custom = selections.status_custom || {};
      const allowed = [STATUS.WISH, STATUS.UP_NEXT, STATUS.IN_PROGRESS, STATUS.COMPLETED];
      let status = allowed.indexOf(custom.status) >= 0 ? custom.status : STATUS.IN_PROGRESS;
      let substatus = custom.substatus === SUBSTATUS.ON_HOLD && status === STATUS.UP_NEXT ? SUBSTATUS.ON_HOLD : '';
      let progress = Math.max(0, Math.min(10, Number(custom.progress) || 0));

      if (status === STATUS.COMPLETED) {
        substatus = SUBSTATUS.DONE;
        progress = 10;
      } else if (progress === 10) {
        progress = 9;
      }

      patch.status = status;
      patch.substatus = substatus;
      patch.progress = progress;
      patch.completed_at = status === STATUS.COMPLETED ? Repo.now() : '';
      patch.halt_reason = '';
      patch.halt_note = '';
      if (substatus === SUBSTATUS.ON_HOLD) {
        patch.waiting_since = primary.waiting_since || Repo.now();
      } else {
        patch.waiting_who = '';
        patch.waiting_what = '';
        patch.waiting_since = '';
      }
    }

    if (patch.due_date !== undefined) patch.due_date = toDateString_(patch.due_date);
    if (patch.owners !== undefined) patch.owners = normalizeOwners_(patch.owners, user.email);

    const oldOwners = primary.owners || '';
    const updatedPrimary = Repo.update(TABS.TICKETS, 'ticket_id', primaryId, patch);
    if (patch.owners !== undefined) notifyNewAssignments_(updatedPrimary, oldOwners, patch.owners, user.email);

    // If requested, preserve the project details that did not survive as a note.
    if (selections.details_to_note === true || selections.details_to_note === 'true') {
      const descriptionChoice = selections.description || 'primary';
      const discardedTicket = descriptionChoice === 'secondary' ? primary : secondary;
      const discarded = String(discardedTicket.description || '').trim();
      const kept = String((descriptionChoice === 'secondary' ? secondary.description : primary.description) || '').trim();
      if (discarded && discarded !== kept) {
        Repo.append(TABS.ACTIVITY, {
          activity_id: Utilities.getUuid(),
          ticket_id: primaryId,
          timestamp: Repo.now(),
          actor: user.email,
          kind: ACTIVITY_KIND.NOTE,
          body: 'Project Details preserved from "' + discardedTicket.title + '" (' + discardedTicket.ticket_id + '):\n\n' + discarded,
          ref: ''
        });
      }
    }

    // Carry Related Students and Related Resources into the surviving ticket.
    RelatedStudents.mergeTickets(primaryId, secondaryId);
    const resourceTokenMap = RelatedResources.mergeTickets(primaryId, secondaryId);
    if (typeof GmailTicketing !== 'undefined') GmailTicketing.mergeTickets(primaryId, secondaryId);
    if (typeof ChatTicketing !== 'undefined') ChatTicketing.mergeTickets(primaryId, secondaryId);

    // Activity is intentionally non-destructive. Non-note activity from the
    // secondary is always copied. Secondary note threads are copied when the
    // user chooses Both or Other, with parent IDs remapped so threads survive.
    const notePolicy = selections.notes || 'both';
    const sourceActivity = activityFor(secondaryId).filter(function (a) {
      if (a.kind !== ACTIVITY_KIND.NOTE) return true;
      return notePolicy !== 'primary';
    });
    const copiedIds = {};
    sourceActivity.forEach(function (a) { copiedIds[a.activity_id] = Utilities.getUuid(); });
    const activityCopies = sourceActivity.map(function (a) {
      return {
        activity_id: copiedIds[a.activity_id],
        ticket_id: primaryId,
        timestamp: a.timestamp,
        actor: a.actor,
        kind: a.kind,
        body: a.body,
        ref: a.ref,
        parent_activity_id: a.parent_activity_id && copiedIds[a.parent_activity_id] ? copiedIds[a.parent_activity_id] : '',
        edited_at: a.edited_at || '',
        deleted: a.deleted === true || a.deleted === 'TRUE',
        deleted_at: a.deleted_at || '',
        body_markup: RelatedResources.rewriteMarkupTokens(a.body_markup || '', resourceTokenMap)
      };
    });
    if (activityCopies.length) Repo.appendMany(TABS.ACTIVITY, activityCopies);
    RelatedResources.remapActivityIds(primaryId, copiedIds);

    // Copy links across without creating self-links or duplicates.
    rawLinksFor_(secondaryId).forEach(function (l) {
      const otherId = l.ticket_a === secondaryId ? l.ticket_b : l.ticket_a;
      if (otherId === primaryId || hasLink_(primaryId, otherId)) return;
      Repo.append(TABS.LINKS, {
        link_id: Utilities.getUuid(),
        ticket_a: primaryId,
        ticket_b: otherId,
        relation: l.relation || 'related',
        created_at: Repo.now()
      });
    });

    logChange_(primaryId, 'merged "' + secondary.title + '" (' + secondaryId + ') into this ticket');

    if (deleteSecondary !== false) {
      Repo.update(TABS.TICKETS, 'ticket_id', secondaryId, {
        deleted: true,
        deleted_at: Repo.now(),
        updated_at: Repo.now()
      });
      logChange_(secondaryId, 'merged into "' + updatedPrimary.title + '" (' + primaryId + ') and moved to Trash');
    } else if (!hasLink_(primaryId, secondaryId)) {
      Repo.append(TABS.LINKS, {
        link_id: Utilities.getUuid(),
        ticket_a: primaryId,
        ticket_b: secondaryId,
        relation: 'duplicate',
        created_at: Repo.now()
      });
    }

    return get(primaryId);
  }


  // -- listing ---------------------------------------------------------------

  function ticketIndex_() {
    const cached = Repo.cacheGet('tickets_idx');
    if (cached) return cached;

    const rows = Repo.readAll(TABS.TICKETS).map(function (t) {
      const x = {};
      INDEX_FIELDS.forEach(function (f) { x[f] = t[f]; });
      return x;
    });

    Repo.cachePut('tickets_idx', rows);
    return rows;
  }

  function filtered_(status, opts, includeDeleted) {
    opts = opts || {};
    const user = Repo.requireAccess('agent');

    let rows = ticketIndex_().filter(function (t) {
      const deleted = t.deleted === true || t.deleted === 'TRUE';
      return includeDeleted ? deleted : !deleted;
    });

    if (status) rows = rows.filter(function (t) { return t.status === status; });

    if (opts.owner) {
      const wantedOwnerKey = ownerKey_(opts.owner);
      rows = rows.filter(function (t) { return ownerKey_(t.owners) === wantedOwnerKey; });
    }
    if (opts.size) rows = rows.filter(function (t) { return t.size === opts.size; });
    if (opts.type) rows = rows.filter(function (t) { return t.type === opts.type; });
    if (opts.mentioned) {
      const mentioned = mentionedTicketIds_(user.email);
      rows = rows.filter(function (t) { return !!mentioned[t.ticket_id]; });
    }

    if (opts.q) {
      const q = String(opts.q).toLowerCase();
      rows = rows.filter(function (t) {
        return String(t.title).toLowerCase().indexOf(q) >= 0 ||
               String(t.description).toLowerCase().indexOf(q) >= 0 ||
               String(t.ticket_id).toLowerCase().indexOf(q) >= 0;
      });
    }

    return sort_(rows, opts.sort || (includeDeleted ? 'deleted_desc' : 'due_asc'));
  }

  function listPage(status, opts) {
    opts = opts || {};
    const rows = filtered_(status, opts, false);
    return page_(rows, opts);
  }

  function trashPage(opts) {
    opts = opts || {};
    const rows = filtered_('', opts, true);
    return page_(rows, opts);
  }

  function page_(rows, opts) {
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || CONFIG.LIST_PAGE_SIZE));
    return {
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset: offset,
      limit: limit,
      hasMore: offset + limit < rows.length
    };
  }

  function priorityRank_(t) {
    return (t.high_priority === true || t.high_priority === 'TRUE') ? 1 : 0;
  }

  function sortWithPriority_(rows, compare) {
    return rows.sort(function (a, b) {
      const priority = priorityRank_(b) - priorityRank_(a);
      return priority || compare(a, b);
    });
  }

  function sort_(rows, mode) {
    const sizeRank = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };

    if (mode === 'size') {
      return sortWithPriority_(rows, function (a, b) { return (sizeRank[b.size] || 0) - (sizeRank[a.size] || 0); });
    }
    if (mode === 'owner') {
      return sortWithPriority_(rows, function (a, b) { return String(a.owners).localeCompare(String(b.owners)); });
    }
    if (mode === 'type') {
      return sortWithPriority_(rows, function (a, b) { return String(a.type).localeCompare(String(b.type)); });
    }
    if (mode === 'created_asc') {
      return sortWithPriority_(rows, function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    }
    if (mode === 'created_desc') {
      return sortWithPriority_(rows, function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    }
    if (mode === 'completed_asc') {
      return sortWithPriority_(rows, function (a, b) { return String(a.completed_at).localeCompare(String(b.completed_at)); });
    }
    if (mode === 'completed_desc') {
      return sortWithPriority_(rows, function (a, b) { return String(b.completed_at).localeCompare(String(a.completed_at)); });
    }
    if (mode === 'deleted_desc') {
      return sortWithPriority_(rows, function (a, b) { return String(b.deleted_at).localeCompare(String(a.deleted_at)); });
    }
    if (mode === 'deleted_asc') {
      return sortWithPriority_(rows, function (a, b) { return String(a.deleted_at).localeCompare(String(b.deleted_at)); });
    }
    if (mode === 'due_desc') {
      return sortWithPriority_(rows, function (a, b) { return dateSort_(a, b, -1); });
    }

    // due_asc: dated first ascending; undated below by recent activity.
    return sortWithPriority_(rows, function (a, b) { return dateSort_(a, b, 1); });
  }

  function dateSort_(a, b, direction) {
    const ad = a.due_date ? 1 : 0;
    const bd = b.due_date ? 1 : 0;
    if (ad !== bd) return bd - ad;
    if (ad === 1) return direction * String(a.due_date).localeCompare(String(b.due_date));
    return String(b.last_activity_at).localeCompare(String(a.last_activity_at));
  }

  function bulkAction(ticketIds, action, payload) {
    Repo.requireAccess('agent');
    payload = payload || {};
    const seen = {};
    const ids = (ticketIds || []).map(String).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
    if (!ids.length) throw new Error('Select at least one ticket.');
    if (ids.length > 100) throw new Error('Mass Actions are limited to 100 tickets at a time.');

    ids.forEach(function (ticketId) {
      const t = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
      if (!t || t.deleted === true || t.deleted === 'TRUE') return;

      if (action === 'reassign') {
        update(ticketId, { owners: payload.owners || '' });
      } else if (action === 'status') {
        setStatus(ticketId, payload.status || STATUS.UP_NEXT, payload.substatus || '');
      } else if (action === 'complete') {
        complete(ticketId, SUBSTATUS.DONE);
      } else if (action === 'delete') {
        softDelete(ticketId);
      } else {
        throw new Error('Unknown Mass Action.');
      }
    });

    return { ok: true, processed: ids.length };
  }

  function counts() {
    Repo.requireAccess('agent');
    const rows = ticketIndex_();
    const active = rows.filter(function (t) { return !(t.deleted === true || t.deleted === 'TRUE'); });
    const out = {};
    Object.keys(STATUS).forEach(function (k) { out[STATUS[k]] = 0; });
    active.forEach(function (t) { if (out[t.status] !== undefined) out[t.status]++; });
    out.on_hold = active.filter(function (t) { return t.substatus === SUBSTATUS.ON_HOLD; }).length;
    out.trash = rows.filter(function (t) { return t.deleted === true || t.deleted === 'TRUE'; }).length;
    return out;
  }

  function readTicketForDetail_(ticketId) {
    const t = Repo.findOneFast
      ? Repo.findOneFast(TABS.TICKETS, 'ticket_id', ticketId)
      : Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!t) throw new Error('No such ticket: ' + ticketId);
    return t;
  }

  function supplementalForDetail_(ticketId, user) {
    // Keep the initial ticket shell independent from the heavier activity and
    // sidebar reads. The dashboard can request this in parallel with getCore()
    // and render as soon as the ticket row arrives.
    let students = [], resources = [], studentTokens = [], resourceTokens = [];
    try {
      const relatedStudents = RelatedStudents.snapshot(ticketId, {
        fast: true, skipTicketValidation: true, skipAccessValidation: true
      });
      students = relatedStudents.students || [];
      studentTokens = relatedStudents.studentTokens || [];
    } catch (e) { Logger.log('Related Students list skipped: %s', e.message); }
    try {
      const relatedResources = RelatedResources.snapshot(ticketId, {
        fast: true, skipTicketValidation: true, skipAccessValidation: true
      });
      resources = relatedResources.resources || [];
      resourceTokens = relatedResources.resourceTokens || [];
    } catch (e) { Logger.log('Related Resources list skipped: %s', e.message); }

    const viewerOnly = user.role === 'viewer';
    const watchBundle = viewerOnly
      ? { watch: { watching: false, on_complete: false, on_note: false, on_progress: false, chat_on_complete: false }, watchers: [] }
      : watchBundleFor_(ticketId, user.email, true);

    return {
      activity: activityFor(ticketId, { fast: true }),
      // URL-only viewers are intentionally not shown other Project Tracker
      // projects, watcher identities, or Gmail thread links.
      links: viewerOnly ? [] : linksFor(ticketId, { fast: true, skipAccessValidation: true }),
      watch: watchBundle.watch,
      watchers: watchBundle.watchers,
      students: students,
      resources: resources,
      studentTokens: studentTokens,
      resourceTokens: resourceTokens,
      emailWatches: viewerOnly ? [] : (typeof GmailTicketing !== 'undefined' ? GmailTicketing.listWatches(ticketId, { fast: true, skipAccessValidation: true }) : [])
    };
  }

  function getCore(ticketId, shareToken) {
    assertReadAccess(ticketId, shareToken);
    return { ticket: readTicketForDetail_(ticketId) };
  }

  function getSupplemental(ticketId, shareToken) {
    const user = assertReadAccess(ticketId, shareToken);
    return supplementalForDetail_(ticketId, user);
  }

  function get(ticketId, shareToken) {
    const user = assertReadAccess(ticketId, shareToken);
    const t = readTicketForDetail_(ticketId);
    const out = supplementalForDetail_(ticketId, user);
    out.ticket = t;
    return out;
  }

  function label_(status, substatus) {
    const names = {
      wish_list: 'Wish list', up_next: 'Up next',
      in_progress: 'In progress', completed: 'Completed'
    };
    let s = names[status] || status;
    if (substatus === SUBSTATUS.ON_HOLD) s += ' (on hold)';
    if (substatus === SUBSTATUS.HALTED) s = 'Halted';
    return s;
  }


  return {
    create: create,
    update: update,
    updateDetailsRich: updateDetailsRich,
    get: get,
    getCore: getCore,
    getSupplemental: getSupplemental,
    listPage: listPage,
    trashPage: trashPage,
    counts: counts,
    setProgress: setProgress,
    setStatus: setStatus,
    complete: complete,
    softDelete: softDelete,
    restore: restore,
    addActivity: addActivity,
    addRichNote: addRichNote,
    addImportedRichActivity: addImportedRichActivity,
    editNote: editNote,
    editNoteRich: editNoteRich,
    deleteNote: deleteNote,
    deleteChatActivity: deleteChatActivity,
    deleteChatBatch: deleteChatBatch,
    activityFor: activityFor,
    notificationSummary: notificationSummary,
    notificationInbox: notificationInbox,
    notifyClosedEmailReply: notifyClosedEmailReply,
    markNotificationRead: markNotificationRead,
    canSetPriority: canSetPriority,
    setHighPriority: setHighPriority,
    assertReadAccess: assertReadAccess,
    viewerSharePayload: viewerSharePayload,
    viewerShareUrl: viewerShareUrl,
    watchSettings: watchSettings,
    watchers: watchers,
    setWatch: setWatch,
    bulkAction: bulkAction,
    presence: presence,
    linksFor: linksFor,
    linkTickets: linkTickets,
    unlinkTicket: unlinkTicket,
    searchTickets: searchTickets,
    globalSearch: globalSearch,
    dashboardData: dashboardData,
    merge: merge
  };

})();
