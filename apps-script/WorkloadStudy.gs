/**
 * Project Tracker — passive workload / capacity study
 *
 * This module intentionally logs raw facts rather than a permanent "busy score".
 * It creates three longitudinal datasets:
 *   - WorkloadSnapshots: one row per agent/team/day
 *   - TicketMetrics: one row per ticket with cycle/working-day metrics
 *   - TicketLifecycle: append-only state/dimension changes for future precision
 *
 * The daily trigger runs after midnight and captures the PREVIOUS local day so a
 * zero-activity day is explicitly preserved as a non-working day.
 */

const WorkloadStudy = (function () {

  const DAY_MS = 86400000;

  function enabled_() {
    return !!(TABS.WORKLOAD_SNAPSHOTS && TABS.TICKET_METRICS && TABS.TICKET_LIFECYCLE);
  }

  function localDate_(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function localDateTime_(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  function dateShift_(dateStr, days) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return '';
    const noon = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    noon.setDate(noon.getDate() + Number(days || 0));
    return Utilities.formatDate(noon, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function previousLocalDate_() {
    return dateShift_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), -1);
  }

  function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

  function ownerList_(owners) {
    return String(owners || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  }

  function containsOwner_(owners, email) {
    const target = String(email || '').trim().toLowerCase();
    return ownerList_(owners).indexOf(target) >= 0;
  }

  function sizeWeight_(size) {
    const code = String(size || '').trim().toUpperCase();
    const map = CONFIG.WORKLOAD_SIZE_WEIGHTS || { XS: 1, S: 2, M: 4, L: 7, XL: 10 };
    const n = Number(map[code]);
    return isNaN(n) ? 4 : n;
  }

  function sourceFromActivities_(ticketId, activities, ticketHint) {
    const rows = (activities || []).filter(function (a) { return String(a.ticket_id) === String(ticketId); })
      .sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
    for (let i = 0; i < rows.length; i++) {
      const ref = String(rows[i].ref || '').toLowerCase();
      if (ref.indexOf('ptsource:gmail') === 0) return 'gmail';
      if (ref.indexOf('ptsource:google_chat') === 0) return 'google_chat';
      if (ref.indexOf('ptsource:project_tracker') === 0) return 'project_tracker';
    }
    // Conservative historical inference: only call Gmail/Chat when creation-time
    // activity is clearly from that surface. Otherwise use Project Tracker.
    const ticket = ticketHint || Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
    const createdMs = ticket && ticket.created_at ? new Date(ticket.created_at).getTime() : NaN;
    if (!isNaN(createdMs)) {
      for (let j = 0; j < rows.length; j++) {
        const at = new Date(rows[j].timestamp).getTime();
        if (isNaN(at) || Math.abs(at - createdMs) > 10 * 60 * 1000) continue;
        if (rows[j].kind === ACTIVITY_KIND.CHAT || String(rows[j].ref || '').indexOf('gchat:') === 0) return 'google_chat';
        if (rows[j].kind === ACTIVITY_KIND.EMAIL || String(rows[j].ref || '').toLowerCase().indexOf('gmail') >= 0) return 'gmail';
      }
    }
    return 'project_tracker';
  }

  function appendLifecycle_(event) {
    if (!enabled_()) return null;
    const row = Object.assign({
      event_id: Utilities.getUuid(),
      ticket_id: '', timestamp: Repo.now(), actor: '', event_type: '',
      from_status: '', to_status: '', from_substatus: '', to_substatus: '',
      from_owners: '', to_owners: '', from_size: '', to_size: '', from_type: '', to_type: '',
      creation_source: '', note: ''
    }, event || {});
    Repo.append(TABS.TICKET_LIFECYCLE, row);
    return row;
  }

  function recordTicketCreated(ticket, creationSource, actor) {
    if (!ticket || !ticket.ticket_id || !enabled_()) return null;
    const existing = Repo.findAll(TABS.TICKET_LIFECYCLE, 'ticket_id', ticket.ticket_id)
      .some(function (e) { return e.event_type === 'created'; });
    if (existing) return null;
    return appendLifecycle_({
      ticket_id: ticket.ticket_id,
      timestamp: ticket.created_at || Repo.now(),
      actor: actor || ticket.created_by || '',
      event_type: 'created',
      to_status: ticket.status || '',
      to_substatus: ticket.substatus || '',
      to_owners: ticket.owners || '',
      to_size: ticket.size || '',
      to_type: ticket.type || '',
      creation_source: String(creationSource || 'project_tracker').toLowerCase(),
      note: 'Creation state'
    });
  }

  function recordTicketEdit(before, after, actor) {
    if (!before || !after || !enabled_()) return null;
    const changed = String(before.owners || '') !== String(after.owners || '') ||
      String(before.size || '') !== String(after.size || '') ||
      String(before.type || '') !== String(after.type || '');
    if (!changed) return null;
    return appendLifecycle_({
      ticket_id: after.ticket_id,
      actor: actor || '',
      event_type: 'attributes_changed',
      from_status: before.status || '', to_status: after.status || '',
      from_substatus: before.substatus || '', to_substatus: after.substatus || '',
      from_owners: before.owners || '', to_owners: after.owners || '',
      from_size: before.size || '', to_size: after.size || '',
      from_type: before.type || '', to_type: after.type || ''
    });
  }

  function recordStatusChange(before, after, actor, note) {
    if (!before || !after || !enabled_()) return null;
    return appendLifecycle_({
      ticket_id: after.ticket_id,
      actor: actor || '',
      event_type: 'status_changed',
      from_status: before.status || '', to_status: after.status || '',
      from_substatus: before.substatus || '', to_substatus: after.substatus || '',
      from_owners: before.owners || '', to_owners: after.owners || '',
      from_size: before.size || '', to_size: after.size || '',
      from_type: before.type || '', to_type: after.type || '',
      note: note || ''
    });
  }

  function recordTicketDeleted(ticket, actor) {
    if (!ticket || !enabled_()) return null;
    return appendLifecycle_({
      ticket_id: ticket.ticket_id, actor: actor || '', event_type: 'deleted',
      to_status: ticket.status || '', to_substatus: ticket.substatus || '',
      to_owners: ticket.owners || '', to_size: ticket.size || '', to_type: ticket.type || ''
    });
  }

  function recordTicketRestored(ticket, actor) {
    if (!ticket || !enabled_()) return null;
    return appendLifecycle_({
      ticket_id: ticket.ticket_id, actor: actor || '', event_type: 'restored',
      to_status: ticket.status || '', to_substatus: ticket.substatus || '',
      to_owners: ticket.owners || '', to_size: ticket.size || '', to_type: ticket.type || ''
    });
  }

  function backfillMissingLifecycleCreates_() {
    const tickets = Repo.readAll(TABS.TICKETS);
    const activities = Repo.readAll(TABS.ACTIVITY);
    const lifecycle = Repo.readAll(TABS.TICKET_LIFECYCLE);
    const hasCreate = {};
    lifecycle.forEach(function (e) { if (e.event_type === 'created') hasCreate[e.ticket_id] = true; });
    const rows = [];
    tickets.forEach(function (t) {
      if (hasCreate[t.ticket_id]) return;
      rows.push({
        event_id: Utilities.getUuid(), ticket_id: t.ticket_id, timestamp: t.created_at || Repo.now(),
        actor: t.created_by || '', event_type: 'created', from_status: '', to_status: t.status || '',
        from_substatus: '', to_substatus: t.substatus || '', from_owners: '', to_owners: t.owners || '',
        from_size: '', to_size: t.size || '', from_type: '', to_type: t.type || '',
        creation_source: sourceFromActivities_(t.ticket_id, activities, t), note: 'Backfilled creation state; dimensions may reflect later edits.'
      });
    });
    if (rows.length) Repo.appendMany(TABS.TICKET_LIFECYCLE, rows);
    return rows.length;
  }

  function activityIndex_(activities) {
    const byTicket = {}, byActorDate = {};
    (activities || []).forEach(function (a) {
      if (bool_(a.deleted)) return;
      (byTicket[a.ticket_id] || (byTicket[a.ticket_id] = [])).push(a);
      const actor = String(a.actor || '').trim().toLowerCase();
      const day = localDate_(a.timestamp);
      if (actor && day) {
        const key = actor + '|' + day;
        const list = byActorDate[key] || (byActorDate[key] = []);
        list.push(a);
      }
    });
    Object.keys(byTicket).forEach(function (k) {
      byTicket[k].sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
    });
    return { byTicket: byTicket, byActorDate: byActorDate };
  }

  function lifecycleIndex_(rows) {
    const out = {};
    (rows || []).forEach(function (e) { (out[e.ticket_id] || (out[e.ticket_id] = [])).push(e); });
    Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); }); });
    return out;
  }

  function dimensionsFromLifecycle_(ticket, life) {
    life = life || [];
    const created = life.filter(function (e) { return e.event_type === 'created'; })[0] || null;
    const firstProgress = life.filter(function (e) {
      return e.to_status === STATUS.IN_PROGRESS && (!e.from_status || e.from_status !== STATUS.IN_PROGRESS);
    })[0] || null;
    let completions = 0, reopens = 0;
    life.forEach(function (e) {
      if (e.to_status === STATUS.COMPLETED && e.from_status !== STATUS.COMPLETED) completions++;
      if (e.from_status === STATUS.COMPLETED && e.to_status && e.to_status !== STATUS.COMPLETED) reopens++;
    });
    if (!completions && ticket.status === STATUS.COMPLETED && ticket.substatus !== SUBSTATUS.HALTED) completions = 1;
    return {
      created: created,
      firstInProgress: firstProgress ? firstProgress.timestamp : ((created && created.to_status === STATUS.IN_PROGRESS) ? created.timestamp : ticket.created_at),
      creationSource: created && created.creation_source ? created.creation_source : '',
      ownersAtCreation: created ? created.to_owners : ticket.owners,
      typeAtCreation: created ? created.to_type : ticket.type,
      sizeAtCreation: created ? created.to_size : ticket.size,
      completionCount: completions,
      reopenCount: reopens
    };
  }

  function onHoldHours_(life, endIso) {
    let start = null, total = 0;
    (life || []).forEach(function (e) {
      const at = new Date(e.timestamp).getTime();
      if (isNaN(at)) return;
      const enters = e.to_substatus === SUBSTATUS.ON_HOLD && e.from_substatus !== SUBSTATUS.ON_HOLD;
      const leaves = e.from_substatus === SUBSTATUS.ON_HOLD && e.to_substatus !== SUBSTATUS.ON_HOLD;
      if (enters && start === null) start = at;
      if (leaves && start !== null) { total += Math.max(0, at - start); start = null; }
    });
    if (start !== null && endIso) {
      const end = new Date(endIso).getTime();
      if (!isNaN(end)) total += Math.max(0, end - start);
    }
    return total / 3600000;
  }

  function workingDayCount_(owners, startIso, endIso, byActorDate) {
    if (!startIso || !endIso) return '';
    const start = new Date(startIso).getTime(), end = new Date(endIso).getTime();
    if (isNaN(start) || isNaN(end) || end < start) return '';
    const ownerEmails = ownerList_(owners);
    if (!ownerEmails.length) return '';
    const dates = {};
    ownerEmails.forEach(function (email) {
      Object.keys(byActorDate || {}).forEach(function (key) {
        if (key.indexOf(email + '|') !== 0) return;
        const day = key.substring(email.length + 1);
        const noon = new Date(day + 'T12:00:00').getTime();
        if (!isNaN(noon) && noon >= start - DAY_MS && noon <= end + DAY_MS) dates[day] = true;
      });
    });
    return Object.keys(dates).length;
  }

  function refreshTicketMetrics() {
    if (!enabled_()) throw new Error('Workload study tabs are not installed. Run migrateWorkloadStudy().');
    backfillMissingLifecycleCreates_();
    const tickets = Repo.readAll(TABS.TICKETS);
    const activities = Repo.readAll(TABS.ACTIVITY);
    const activityIdx = activityIndex_(activities);
    const lifecycleRows = Repo.readAll(TABS.TICKET_LIFECYCLE);
    const lifeIdx = lifecycleIndex_(lifecycleRows);
    const existing = Repo.readAll(TABS.TICKET_METRICS);
    const existingMap = {}; existing.forEach(function (m) { existingMap[m.ticket_id] = m; });
    const now = Repo.now();
    const inserts = [];
    const patches = {};

    tickets.forEach(function (t) {
      const life = lifeIdx[t.ticket_id] || [];
      const dims = dimensionsFromLifecycle_(t, life);
      const completedAt = (t.status === STATUS.COMPLETED && t.substatus !== SUBSTATUS.HALTED) ? String(t.completed_at || '') : '';
      const createdMs = new Date(t.created_at).getTime();
      const completedMs = completedAt ? new Date(completedAt).getTime() : NaN;
      const cycleHours = !isNaN(createdMs) && !isNaN(completedMs) ? Math.max(0, (completedMs - createdMs) / 3600000) : '';
      const holdHours = completedAt ? onHoldHours_(life, completedAt) : onHoldHours_(life, Repo.now());
      const activeCycle = cycleHours === '' ? '' : Math.max(0, cycleHours - holdHours);
      const ownersAtCompletion = completedAt ? String(t.owners || '') : '';
      const workingDays = completedAt ? workingDayCount_(ownersAtCompletion || dims.ownersAtCreation, dims.firstInProgress || t.created_at, completedAt, activityIdx.byActorDate) : '';
      const precision = life.some(function (e) { return e.event_type === 'status_changed' || e.event_type === 'attributes_changed'; }) ? 'prospective' : 'legacy_estimate';
      const row = {
        ticket_id: t.ticket_id, created_at: t.created_at || '', completed_at: completedAt,
        current_status: t.status || '', current_substatus: t.substatus || '',
        creation_source: dims.creationSource || sourceFromActivities_(t.ticket_id, activities, t), created_by: t.created_by || '',
        owners_at_creation: dims.ownersAtCreation || t.owners || '', owners_at_completion: ownersAtCompletion, current_owners: t.owners || '',
        type_at_creation: dims.typeAtCreation || t.type || '', type_at_completion: completedAt ? (t.type || '') : '', current_type: t.type || '',
        size_at_creation: dims.sizeAtCreation || t.size || '', size_at_completion: completedAt ? (t.size || '') : '', current_size: t.size || '',
        first_in_progress_at: dims.firstInProgress || '', total_on_hold_hours: Number(holdHours.toFixed ? holdHours.toFixed(2) : holdHours) || 0,
        cycle_hours: cycleHours === '' ? '' : Number(cycleHours.toFixed(2)), active_cycle_hours: activeCycle === '' ? '' : Number(activeCycle.toFixed(2)),
        working_day_cycle_days: workingDays, reopen_count: dims.reopenCount, completion_count: dims.completionCount,
        historical_precision: precision, last_calculated_at: now
      };
      if (existingMap[t.ticket_id]) patches[t.ticket_id] = row;
      else inserts.push(row);
    });
    const updatedRows = Object.keys(patches).length ? Repo.updateMany(TABS.TICKET_METRICS, 'ticket_id', patches) : [];
    if (inserts.length) Repo.appendMany(TABS.TICKET_METRICS, inserts);
    return { tickets: tickets.length, inserted: inserts.length, updated: updatedRows.length };
  }

  function subjectRows_() {
    const agents = Repo.activeAgents().filter(function (a) { return String(a.role || '').toLowerCase() === 'agent'; });
    const rows = agents.map(function (a) {
      return { subject_key: String(a.email || '').toLowerCase(), subject_label: a.display_name || a.email, subject_type: 'agent', email: String(a.email || '').toLowerCase() };
    });
    rows.push({ subject_key: 'team', subject_label: 'Team', subject_type: 'team', email: '' });
    return rows;
  }

  function median_(values) {
    const xs = (values || []).map(Number).filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return a - b; });
    if (!xs.length) return 0;
    const m = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
  }

  function activityStatsForSubject_(subject, dateStr, activityIdx, agentEmails) {
    let rows = [];
    if (subject.subject_type === 'team') {
      (agentEmails || []).forEach(function (email) { rows = rows.concat(activityIdx.byActorDate[email + '|' + dateStr] || []); });
    } else {
      rows = activityIdx.byActorDate[subject.email + '|' + dateStr] || [];
    }
    rows.sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
    return {
      count: rows.length,
      first: rows.length ? rows[0].timestamp : '',
      last: rows.length ? rows[rows.length - 1].timestamp : '',
      worked: rows.length > 0
    };
  }

  function ticketBelongsToSubject_(owners, subject, agentEmails) {
    if (subject.subject_type === 'team') return ownerList_(owners).some(function (o) { return (agentEmails || []).indexOf(o) >= 0; });
    return containsOwner_(owners, subject.email);
  }

  function weightRemaining_(t) {
    const w = sizeWeight_(t.size);
    if (t.substatus === SUBSTATUS.ON_HOLD) return 0;
    if (t.status === STATUS.IN_PROGRESS) return w * Math.max(0, 1 - (Number(t.progress) || 0) / 10);
    if (t.status === STATUS.UP_NEXT) return w;
    return 0;
  }

  function snapshotForSubject_(subject, dateStr, tickets, metricsMap, activities, activityIdx, agentEmails) {
    const activity = activityStatsForSubject_(subject, dateStr, activityIdx, agentEmails);
    const today = dateStr;
    const baselineStart = String(CONFIG.WORKLOAD_STUDY_BASELINE_START || today);
    const active = tickets.filter(function (t) {
      if (bool_(t.deleted) || t.status === STATUS.COMPLETED || t.status === STATUS.WISH) return false;
      return ticketBelongsToSubject_(t.owners, subject, agentEmails);
    });
    const actionable = active.filter(function (t) { return t.substatus !== SUBSTATUS.ON_HOLD; });
    const created = tickets.filter(function (t) {
      const m = metricsMap[t.ticket_id] || {};
      return localDate_(t.created_at) === today && ticketBelongsToSubject_(m.owners_at_creation || t.owners, subject, agentEmails);
    });
    const completed = tickets.filter(function (t) {
      const m = metricsMap[t.ticket_id] || {};
      return t.status === STATUS.COMPLETED && t.substatus !== SUBSTATUS.HALTED && localDate_(t.completed_at) === today &&
        ticketBelongsToSubject_(m.owners_at_completion || t.owners, subject, agentEmails);
    });
    const studyCreated = tickets.filter(function (t) {
      const day = localDate_(t.created_at), m = metricsMap[t.ticket_id] || {};
      return day && day >= baselineStart && day <= today && ticketBelongsToSubject_(m.owners_at_creation || t.owners, subject, agentEmails);
    });
    const studyCompleted = tickets.filter(function (t) {
      const day = localDate_(t.completed_at), m = metricsMap[t.ticket_id] || {};
      return t.status === STATUS.COMPLETED && t.substatus !== SUBSTATUS.HALTED && day && day >= baselineStart && day <= today &&
        ticketBelongsToSubject_(m.owners_at_completion || t.owners, subject, agentEmails);
    });
    const ages = active.map(function (t) {
      const ms = new Date(t.created_at).getTime();
      const end = new Date(today + 'T23:59:59').getTime();
      return isNaN(ms) ? 0 : Math.max(0, (end - ms) / DAY_MS);
    });
    const sizeCounts = { XS: 0, S: 0, M: 0, L: 0, XL: 0 };
    active.forEach(function (t) { const s = String(t.size || '').toUpperCase(); if (sizeCounts[s] !== undefined) sizeCounts[s]++; });
    const todayEnd = new Date(today + 'T23:59:59').getTime();
    const overdue = active.filter(function (t) {
      if (!t.due_date) return false;
      const due = new Date(String(t.due_date).substring(0, 10) + 'T23:59:59').getTime();
      return !isNaN(due) && due < todayEnd;
    }).length;
    const priority = active.filter(function (t) { return bool_(t.high_priority); }).length;
    const createdWeight = created.reduce(function (s, t) { return s + sizeWeight_(t.size); }, 0);
    const completedWeight = completed.reduce(function (s, t) { return s + sizeWeight_(t.size); }, 0);
    return {
      snapshot_key: today + '|' + subject.subject_key,
      snapshot_date: today, subject_key: subject.subject_key, subject_label: subject.subject_label, subject_type: subject.subject_type,
      working_day: activity.worked, activity_count: activity.count, first_activity_at: activity.first, last_activity_at: activity.last,
      active_count: active.length, actionable_count: actionable.length,
      in_progress_count: active.filter(function (t) { return t.status === STATUS.IN_PROGRESS; }).length,
      up_next_count: active.filter(function (t) { return t.status === STATUS.UP_NEXT; }).length,
      on_hold_count: active.filter(function (t) { return t.substatus === SUBSTATUS.ON_HOLD; }).length,
      wish_list_count: tickets.filter(function (t) { return !bool_(t.deleted) && t.status === STATUS.WISH && ticketBelongsToSubject_(t.owners, subject, agentEmails); }).length,
      xs_count: sizeCounts.XS, s_count: sizeCounts.S, m_count: sizeCounts.M, l_count: sizeCounts.L, xl_count: sizeCounts.XL,
      weighted_active_load: Number(active.reduce(function (s, t) { return s + sizeWeight_(t.size); }, 0).toFixed(2)),
      weighted_remaining_load: Number(actionable.reduce(function (s, t) { return s + weightRemaining_(t); }, 0).toFixed(2)),
      overdue_count: overdue, high_priority_count: priority,
      created_today_count: created.length, created_today_weight: Number(createdWeight.toFixed(2)),
      completed_today_count: completed.length, completed_today_weight: Number(completedWeight.toFixed(2)),
      net_ticket_flow: created.length - completed.length, net_weight_flow: Number((createdWeight - completedWeight).toFixed(2)),
      study_created_total: studyCreated.length, study_completed_total: studyCompleted.length, study_net_total: studyCreated.length - studyCompleted.length,
      active_median_age_days: Number(median_(ages).toFixed(2)), oldest_active_age_days: ages.length ? Number(Math.max.apply(null, ages).toFixed(2)) : 0,
      captured_at: Repo.now()
    };
  }

  function dashboardFlow(selectedOwners, period, tickets) {
    if (!enabled_()) return { available: false, reason: 'Workload study is not installed.' };
    selectedOwners = (Array.isArray(selectedOwners) ? selectedOwners : String(selectedOwners || '').split(','))
      .map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
    period = period || {};
    tickets = Array.isArray(tickets) ? tickets : [];

    const subjects = subjectRows_();
    const agents = subjects.filter(function (s) { return s.subject_type === 'agent'; });
    const agentEmails = agents.map(function (s) { return s.email; }).sort();
    const selected = selectedOwners.slice().sort();
    let subject = null;
    if (selected.length === 1) {
      subject = agents.filter(function (s) { return s.email === selected[0]; })[0] || null;
    } else if (selected.length === agentEmails.length && selected.every(function (email, i) { return email === agentEmails[i]; })) {
      subject = subjects.filter(function (s) { return s.subject_type === 'team'; })[0] || null;
    }
    if (!subject) return { available: false, reason: 'Flow is available for one agent or the Team view.' };

    const studyStart = String(CONFIG.WORKLOAD_STUDY_BASELINE_START || '').trim();
    const today = localDate_(new Date());
    let start = period.mode === 'all' ? studyStart : String(period.start || studyStart || '');
    let end = period.mode === 'all' ? today : String(period.end || today || '');
    if (studyStart && (!start || start < studyStart)) start = studyStart;
    if (!end || end > today) end = today;
    if (!start) start = today;

    const weights = Object.assign({ XS: 1, S: 2, M: 4, L: 7, XL: 10 }, CONFIG.WORKLOAD_SIZE_WEIGHTS || {});
    if (end < start) {
      return {
        available: true, hasData: false, subjectKey: subject.subject_key, subjectLabel: subject.subject_label,
        coverageStart: start, coverageEnd: end, studyStart: studyStart, liveTodayIncluded: false,
        createdCount: 0, completedCount: 0, netCount: 0, createdWeight: 0, completedWeight: 0, netWeight: 0,
        weights: weights
      };
    }

    // WorkloadSnapshots is intentionally tiny (one row per subject/day), but the
    // dashboard may be toggled repeatedly between Month/Week/owner views. Cache
    // this raw snapshot list briefly so those UI changes do not cause another
    // Sheets read each time. Today's live overlay below remains uncached.
    const cacheKey = 'workload_dashboard_flow_snapshots_v1';
    let snapshots = Repo.cacheGet(cacheKey);
    if (!Array.isArray(snapshots)) {
      snapshots = Repo.readAll(TABS.WORKLOAD_SNAPSHOTS);
      Repo.cachePut(cacheKey, snapshots, 300);
    }

    let createdCount = 0, completedCount = 0, createdWeight = 0, completedWeight = 0, observedDays = 0;
    snapshots.forEach(function (row) {
      const day = String(row.snapshot_date || '');
      if (String(row.subject_key || '').toLowerCase() !== String(subject.subject_key || '').toLowerCase()) return;
      // Ignore a manually captured partial row for today; the live calculation
      // below is fresher and prevents double-counting.
      if (!day || day < start || day > end || day === today) return;
      createdCount += Number(row.created_today_count) || 0;
      completedCount += Number(row.completed_today_count) || 0;
      createdWeight += Number(row.created_today_weight) || 0;
      completedWeight += Number(row.completed_today_weight) || 0;
      observedDays++;
    });

    const includeToday = start <= today && end >= today;
    if (includeToday) {
      const createdToday = tickets.filter(function (t) {
        return localDate_(t.created_at) === today && ticketBelongsToSubject_(t.owners, subject, agentEmails);
      });
      const completedToday = tickets.filter(function (t) {
        return t.status === STATUS.COMPLETED && t.substatus !== SUBSTATUS.HALTED && localDate_(t.completed_at) === today &&
          ticketBelongsToSubject_(t.owners, subject, agentEmails);
      });
      createdCount += createdToday.length;
      completedCount += completedToday.length;
      createdWeight += createdToday.reduce(function (sum, t) { return sum + sizeWeight_(t.size); }, 0);
      completedWeight += completedToday.reduce(function (sum, t) { return sum + sizeWeight_(t.size); }, 0);
    }

    createdWeight = Number(createdWeight.toFixed(2));
    completedWeight = Number(completedWeight.toFixed(2));
    return {
      available: true,
      hasData: observedDays > 0 || includeToday,
      subjectKey: subject.subject_key,
      subjectLabel: subject.subject_label,
      coverageStart: start,
      coverageEnd: end,
      studyStart: studyStart,
      liveTodayIncluded: includeToday,
      observedSnapshotDays: observedDays,
      createdCount: createdCount,
      completedCount: completedCount,
      netCount: createdCount - completedCount,
      createdWeight: createdWeight,
      completedWeight: completedWeight,
      netWeight: Number((createdWeight - completedWeight).toFixed(2)),
      weights: weights,
      provisionalWeights: true
    };
  }

  function captureSnapshotForDate(dateStr) {
    if (!enabled_()) throw new Error('Workload study tabs are not installed. Run migrateWorkloadStudy().');
    dateStr = String(dateStr || '').trim() || previousLocalDate_();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Date must be YYYY-MM-DD.');
    refreshTicketMetrics();
    const tickets = Repo.readAll(TABS.TICKETS);
    const metrics = Repo.readAll(TABS.TICKET_METRICS);
    const metricsMap = {}; metrics.forEach(function (m) { metricsMap[m.ticket_id] = m; });
    const activities = Repo.readAll(TABS.ACTIVITY);
    const activityIdx = activityIndex_(activities);
    const subjects = subjectRows_();
    const agentEmails = subjects.filter(function (s) { return s.subject_type === 'agent'; }).map(function (s) { return s.email; });
    const rows = subjects.map(function (subject) { return snapshotForSubject_(subject, dateStr, tickets, metricsMap, activities, activityIdx, agentEmails); });
    rows.forEach(function (row) {
      const existing = Repo.findOne(TABS.WORKLOAD_SNAPSHOTS, 'snapshot_key', row.snapshot_key);
      if (existing) Repo.update(TABS.WORKLOAD_SNAPSHOTS, 'snapshot_key', row.snapshot_key, row);
      else Repo.append(TABS.WORKLOAD_SNAPSHOTS, row);
    });
    Repo.cacheRemove('workload_dashboard_flow_snapshots_v1');
    return { date: dateStr, rows: rows.length, subjects: rows.map(function (r) { return r.subject_label; }) };
  }

  function captureDailyWorkloadSnapshot() {
    return captureSnapshotForDate(previousLocalDate_());
  }

  function captureTodayForTesting() {
    return captureSnapshotForDate(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  }

  function installDailyTrigger() {
    const handler = 'captureDailyWorkloadSnapshot';
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger(handler).timeBased().atHour(Number(CONFIG.WORKLOAD_STUDY_SNAPSHOT_HOUR || 2)).everyDays(1).create();
    return { installed: true, handler: handler, hour: Number(CONFIG.WORKLOAD_STUDY_SNAPSHOT_HOUR || 2) };
  }

  function verify() {
    const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'captureDailyWorkloadSnapshot'; });
    const snapshots = Repo.readAll(TABS.WORKLOAD_SNAPSHOTS).sort(function (a, b) { return String(b.snapshot_date).localeCompare(String(a.snapshot_date)); });
    const metrics = Repo.readAll(TABS.TICKET_METRICS);
    const lifecycle = Repo.readAll(TABS.TICKET_LIFECYCLE);
    const completed = metrics.filter(function (m) { return !!m.completed_at; });
    const bySize = {};
    completed.forEach(function (m) {
      const s = String(m.size_at_completion || m.current_size || '').toUpperCase() || 'UNKNOWN';
      (bySize[s] || (bySize[s] = [])).push(Number(m.working_day_cycle_days));
    });
    const sizeSummary = {};
    Object.keys(bySize).forEach(function (s) {
      const vals = bySize[s].filter(function (x) { return !isNaN(x); });
      sizeSummary[s] = { samples: vals.length, medianWorkingDays: median_(vals) };
    });
    return {
      ok: true,
      triggerCount: triggers.length,
      snapshotRows: snapshots.length,
      metricRows: metrics.length,
      lifecycleRows: lifecycle.length,
      latestSnapshots: snapshots.slice(0, 6),
      completedSizeSummary: sizeSummary
    };
  }

  return {
    recordTicketCreated: recordTicketCreated,
    recordTicketEdit: recordTicketEdit,
    recordStatusChange: recordStatusChange,
    recordTicketDeleted: recordTicketDeleted,
    recordTicketRestored: recordTicketRestored,
    backfillMissingLifecycleCreates: backfillMissingLifecycleCreates_,
    refreshTicketMetrics: refreshTicketMetrics,
    dashboardFlow: dashboardFlow,
    captureSnapshotForDate: captureSnapshotForDate,
    captureDailyWorkloadSnapshot: captureDailyWorkloadSnapshot,
    captureTodayForTesting: captureTodayForTesting,
    installDailyTrigger: installDailyTrigger,
    verify: verify
  };
})();

/** Trigger/exported wrappers. */
function captureDailyWorkloadSnapshot() { return WorkloadStudy.captureDailyWorkloadSnapshot(); }
function captureWorkloadSnapshotForDate(dateStr) { return WorkloadStudy.captureSnapshotForDate(dateStr); }
function captureTodayWorkloadSnapshotForTesting() { return WorkloadStudy.captureTodayForTesting(); }
function refreshWorkloadTicketMetrics() { return WorkloadStudy.refreshTicketMetrics(); }
function verifyWorkloadStudy() { return WorkloadStudy.verify(); }
