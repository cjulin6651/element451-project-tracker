/**
 * Project Tracker — web app
 * Serves the dashboard and exposes the API the page calls via google.script.run.
 *
 * Everything crosses the wire as a JSON string. Apps Script's object serializer
 * returns null without explanation when a value doesn't survive the trip.
 */

var PROJECT_TRACKER_FAVICON_URL = ''; // Optional override; otherwise CONFIG.BRAND_FAVICON_URL is used.

function extensionJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(plain_(value)))
    .setMimeType(ContentService.MimeType.JSON);
}

function extensionErrorJson_(error) {
  Logger.log('Extension API error: %s\n%s', error.message, error.stack);
  return extensionJson_({ __error: error.message || String(error) });
}

function doGet(e) {
  if (e && e.parameter && e.parameter.ptExtensionApi === '1') {
    try { return extensionJson_(ExtensionApi.handleGet(e.parameter || {})); }
    catch (extensionError) { return extensionErrorJson_(extensionError); }
  }
  var output = HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Project Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  // Favicon is optional. If Google cannot serve the Drive image as a favicon,
  // the dashboard still loads normally. The #.png suffix satisfies Apps
  // Script's image-extension check while the browser requests the underlying
  // googleusercontent image URL.
  try {
    output.setFaviconUrl(PROJECT_TRACKER_FAVICON_URL || CONFIG.BRAND_FAVICON_URL);
  } catch (e) {
    Logger.log('Project Tracker favicon skipped: %s', e.message);
  }

  return output;
}

function doPost(e) {
  if (e && e.parameter && e.parameter.ptExtensionApi === '1') {
    try {
      var body = {};
      if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
      return extensionJson_(ExtensionApi.handlePost(body || {}));
    } catch (extensionError) {
      return extensionErrorJson_(extensionError);
    }
  }
  return extensionErrorJson_(new Error('Unsupported POST request.'));
}


function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/** Wraps a handler so it always returns a JSON string, errors included. */
function respond_(fn) {
  try {
    return JSON.stringify(plain_(fn()));
  } catch (e) {
    Logger.log('API error: %s\n%s', e.message, e.stack);
    return JSON.stringify({ __error: e.message });
  }
}

/** Flattens Sheet values into JSON-safe primitives. */
function plain_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain_);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = plain_(v[k]); });
    return out;
  }
  return v;
}


// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function api_bootstrap(ticketId, shareToken) {
  return respond_(function () {
    const user = Repo.requireAccess('viewer');
    const viewerOnly = user.role === 'viewer';
    if (viewerOnly) Tickets.assertReadAccess(ticketId, shareToken);
    return {
      me: user.email,
      role: user.role,
      viewerOnly: viewerOnly,
      appUrl: ScriptApp.getService().getUrl() || '',
      agents: Repo.activeAgents().map(function (a) {
        return { email: a.email, name: a.display_name, role: a.role };
      }),
      types: Repo.activeTypes().map(function (t) {
        return { name: t.type_name, defaultSize: t.default_size };
      }),
      departments: Repo.activeDepartments().map(function (d) { return d.dept_name; }),
      sizes: Repo.sizes().map(function (s) {
        return { code: s.code, label: s.label, guidance: s.time_guidance };
      }),
      counts: viewerOnly ? {} : Tickets.counts(),
      canSetPriority: viewerOnly ? false : Tickets.canSetPriority(),
      threadPreviewReplies: CONFIG.THREAD_PREVIEW_REPLIES,
      listPageSize: CONFIG.LIST_PAGE_SIZE,
      notificationArchiveDays: CONFIG.NOTIFICATION_ARCHIVE_DAYS,
      elementClient: String(ELEMENT451_CONFIG.CLIENT || ''),
      elementWebHost: element451WebHost_(),
      studentIdentityTypes: ['spark', 'school'].filter(function (kind) {
        return projectTrackerStudentIdentityEnabled_(kind);
      }).map(function (kind) {
        return { kind: kind, label: projectTrackerStudentIdentityLabel_(kind) };
      })
    };
  });
}

function api_list(status, opts) {
  return respond_(function () {
    const page = Tickets.listPage(status, opts || {});
    page.counts = Tickets.counts();
    return page;
  });
}

function api_trash(opts) {
  return respond_(function () {
    const page = Tickets.trashPage(opts || {});
    page.counts = Tickets.counts();
    return page;
  });
}

function api_get(ticketId, shareToken) {
  return respond_(function () { return Tickets.get(ticketId, shareToken); });
}

// Dashboard detail view uses these two endpoints in parallel. api_get remains
// intact for compatibility with any existing caller that expects one payload.
function api_getCore(ticketId, shareToken) {
  return respond_(function () { return Tickets.getCore(ticketId, shareToken); });
}

function api_getSupplemental(ticketId, shareToken) {
  return respond_(function () { return Tickets.getSupplemental(ticketId, shareToken); });
}

function api_processPendingChatImportsForTicket(ticketId) {
  return respond_(function () {
    Repo.requireAccess('agent');
    if (typeof ChatTicketing === 'undefined' || !ChatTicketing.processPendingImportsForTicket) {
      return { checked: 0, processed: 0, errors: [] };
    }
    const out = ChatTicketing.processPendingImportsForTicket(ticketId, 30);
    if (!out.checked) return out;
    const detail = Tickets.get(ticketId, '');
    out.activity = detail.activity || [];
    out.students = detail.students || [];
    out.resources = detail.resources || [];
    out.studentTokens = detail.studentTokens || [];
    out.resourceTokens = detail.resourceTokens || [];
    return out;
  });
}

function api_getViewerShareLink(ticketId) {
  return respond_(function () { return Tickets.viewerSharePayload(ticketId); });
}

function api_create(payload) {
  return respond_(function () { return Tickets.create(payload || {}); });
}

function api_update(ticketId, patch) {
  return respond_(function () { return Tickets.update(ticketId, patch || {}); });
}

function api_updateDetailsRich(ticketId, payload) {
  return respond_(function () { return Tickets.updateDetailsRich(ticketId, payload || {}); });
}

function api_addNoteRich(ticketId, payload, parentActivityId) {
  return respond_(function () {
    return Tickets.addRichNote(ticketId, payload || {}, parentActivityId || '');
  });
}

function api_addNote(ticketId, body, parentActivityId) {
  return respond_(function () {
    return Tickets.addActivity(ticketId, ACTIVITY_KIND.NOTE, body, '', false, parentActivityId || '');
  });
}

function api_editNoteRich(activityId, payload) {
  return respond_(function () { return Tickets.editNoteRich(activityId, payload || {}); });
}

function api_editNote(activityId, body) {
  return respond_(function () { return Tickets.editNote(activityId, body); });
}

function api_deleteNote(activityId) {
  return respond_(function () { return Tickets.deleteNote(activityId); });
}

function api_deleteChatActivity(activityId) {
  return respond_(function () { return Tickets.deleteChatActivity(activityId); });
}

function api_deleteChatBatch(activityId) {
  return respond_(function () { return Tickets.deleteChatBatch(activityId); });
}


function api_setProgress(ticketId, n) {
  return respond_(function () { return Tickets.setProgress(ticketId, n); });
}

function api_setStatus(ticketId, status, substatus) {
  return respond_(function () { return Tickets.setStatus(ticketId, status, substatus); });
}

function api_complete(ticketId, resolution, haltReason, haltNote) {
  return respond_(function () { return Tickets.complete(ticketId, resolution, haltReason, haltNote); });
}

function api_delete(ticketId) {
  return respond_(function () {
    Tickets.softDelete(ticketId);
    return { ok: true, counts: Tickets.counts() };
  });
}

function api_restore(ticketId) {
  return respond_(function () {
    const ticket = Tickets.restore(ticketId);
    return { ticket: ticket, counts: Tickets.counts() };
  });
}

function api_notificationSummary() {
  return respond_(function () { return Tickets.notificationSummary(); });
}

function api_notificationInbox(opts) {
  return respond_(function () { return Tickets.notificationInbox(opts || {}); });
}

function api_markNotificationRead(notificationId) {
  return respond_(function () {
    Tickets.markNotificationRead(notificationId);
    return Tickets.notificationSummary();
  });
}

function api_setHighPriority(ticketId, on) {
  return respond_(function () {
    return { ticket: Tickets.setHighPriority(ticketId, on), counts: Tickets.counts() };
  });
}

function api_setWatch(ticketId, settings) {
  return respond_(function () {
    return {
      watch: Tickets.setWatch(ticketId, settings || {}),
      watchers: Tickets.watchers(ticketId)
    };
  });
}

function api_bulkAction(ticketIds, action, payload) {
  return respond_(function () {
    const out = Tickets.bulkAction(ticketIds || [], action, payload || {});
    out.counts = Tickets.counts();
    return out;
  });
}

function api_presence(ticketId) {
  return respond_(function () {
    return { viewers: Tickets.presence(ticketId), watchers: Tickets.watchers(ticketId) };
  });
}

function api_emailWatches(ticketId) {
  return respond_(function () { return { rows: GmailTicketing.listWatches(ticketId) }; });
}

function api_stopEmailWatch(watchId, ticketId) {
  return respond_(function () {
    GmailTicketing.stopWatch(watchId);
    return { rows: GmailTicketing.listWatches(ticketId) };
  });
}

function api_searchTickets(q, excludeId) {
  return respond_(function () {
    return { rows: Tickets.searchTickets(q, excludeId) };
  });
}

function api_globalSearch(opts) {
  return respond_(function () { return Tickets.globalSearch(opts || {}); });
}

function api_dashboard(opts) {
  return respond_(function () { return Tickets.dashboardData(opts || {}); });
}

function api_link(ticketId, otherId, relation) {
  return respond_(function () {
    return { links: Tickets.linkTickets(ticketId, otherId, relation || 'related') };
  });
}

function api_unlink(linkId, ticketId) {
  return respond_(function () {
    return { links: Tickets.unlinkTicket(linkId, ticketId) };
  });
}

function api_merge(primaryId, secondaryId, selections, deleteSecondary) {
  return respond_(function () {
    const out = Tickets.merge(primaryId, secondaryId, selections || {}, deleteSecondary !== false);
    out.counts = Tickets.counts();
    return out;
  });
}


// ---------------------------------------------------------------------------
// Related Students
// ---------------------------------------------------------------------------

function api_searchStudents(ticketId, query) {
  return respond_(function () { return { rows: RelatedStudents.search(ticketId, query) }; });
}

function api_addStudentByUrl(ticketId, url) {
  return respond_(function () {
    RelatedStudents.addByUrl(ticketId, url);
    return { students: RelatedStudents.list(ticketId) };
  });
}

function api_addStudentBySparkId(ticketId, value) {
  return respond_(function () {
    RelatedStudents.addBySparkId(ticketId, value);
    return { students: RelatedStudents.list(ticketId) };
  });
}

function api_addStudentBySchoolId(ticketId, value) {
  return respond_(function () {
    RelatedStudents.addBySchoolId(ticketId, value);
    return { students: RelatedStudents.list(ticketId) };
  });
}

function api_addStudentSearchResult(ticketId, elementId) {
  return respond_(function () {
    RelatedStudents.addSearchResult(ticketId, elementId);
    return { students: RelatedStudents.list(ticketId) };
  });
}

function api_removeStudent(ticketId, relationId) {
  return respond_(function () {
    return { students: RelatedStudents.remove(ticketId, relationId), studentTokens: RelatedStudents.listForTokens(ticketId) };
  });
}

function api_removeStudents(ticketId, relationIds) {
  return respond_(function () {
    return { students: RelatedStudents.removeMany(ticketId, relationIds || []), studentTokens: RelatedStudents.listForTokens(ticketId) };
  });
}


// ---------------------------------------------------------------------------
// Related Resources
// ---------------------------------------------------------------------------

function api_addResourceUrl(ticketId, url) {
  return respond_(function () {
    RelatedResources.addUrl(ticketId, url);
    return { resources: RelatedResources.listAll(ticketId) };
  });
}

function api_syncRelated(ticketId) {
  return respond_(function () {
    // This endpoint is intentionally background-only. Authenticate once, then
    // reuse one set of ticket/activity/relationship snapshots throughout the
    // repair + sync pass instead of repeatedly crossing the Sheets service.
    Repo.requireAccess('agent');
    const findOne = Repo.findOneFast || Repo.findOne;
    const findAll = Repo.findAllFast || Repo.findAll;
    const ticket = findOne(TABS.TICKETS, 'ticket_id', ticketId);
    if (!ticket) throw new Error('No such ticket: ' + ticketId);

    let activityRows = findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
    let studentRows = findAll(TABS.RELATED_STUDENTS, 'ticket_id', ticketId);
    let resourceRows = findAll(TABS.RELATED_RESOURCES, 'ticket_id', ticketId);
    let gmailResult = null;
    let chatResult = null;

    // Gmail add-on callbacks prioritize committing the email itself. If a large
    // thread had to defer optional student/resource tagging to stay under the host
    // callback deadline, opening the ticket drains that tiny enrichment queue here.
    try {
      if (typeof GmailTicketing !== 'undefined' && GmailTicketing.processPendingEnrichmentsForTicket) {
        gmailResult = GmailTicketing.processPendingEnrichmentsForTicket(ticketId, {
          activityRows: activityRows
        }) || null;
      }
    } catch (e) { Logger.log('Pending Gmail enrichment failed for %s: %s', ticketId, e.message); }

    const gmailChanged = !!(gmailResult && Number(gmailResult.processed || 0) > 0);
    if (gmailChanged) {
      activityRows = findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
      studentRows = findAll(TABS.RELATED_STUDENTS, 'ticket_id', ticketId);
      resourceRows = findAll(TABS.RELATED_RESOURCES, 'ticket_id', ticketId);
    }

    // Finish any Chat images/resources/tokenization outside the short-lived Chat
    // dialog callback. ChatTicketing can reuse the snapshots above, avoiding its
    // historical multiple rereads of Activity/relationships when nothing is pending.
    try {
      if (typeof ChatTicketing !== 'undefined' && ChatTicketing.processPendingImportsForTicket) {
        chatResult = ChatTicketing.processPendingImportsForTicket(ticketId, 30, {
          activityRows: activityRows,
          studentRows: studentRows,
          resourceRows: resourceRows
        }) || null;
      }
    } catch (e) { Logger.log('Pending Chat post-process failed for %s: %s', ticketId, e.message); }

    const chatChanged = !!(chatResult && (
      Number(chatResult.processed || 0) > 0 ||
      Number(chatResult.studentUrlsResolved || 0) > 0 ||
      Number(chatResult.studentChatRowsRetagged || 0) > 0 ||
      Number(chatResult.duplicateAttachmentsRemoved || 0) > 0
    ));
    if (chatChanged) {
      // Chat processing can mutate all three datasets. Refresh once only when it
      // actually changed something; the common no-op open keeps the first snapshot.
      activityRows = findAll(TABS.ACTIVITY, 'ticket_id', ticketId);
      studentRows = findAll(TABS.RELATED_STUDENTS, 'ticket_id', ticketId);
      resourceRows = findAll(TABS.RELATED_RESOURCES, 'ticket_id', ticketId);
    }

    // One post-processing dedupe is enough to close the historical Chat race.
    // The old path performed the same student/resource dedupe both before and
    // after Chat processing, which doubled relationship reads on every ticket open.
    let studentDedupe = { removedDuplicates: 0 };
    let resourceDedupe = { removedDuplicates: 0 };
    try {
      if (RelatedStudents.dedupeTicket) studentDedupe = RelatedStudents.dedupeTicket(ticketId, false, {
        rows: studentRows, fast: true, skipAccessValidation: true, skipTicketValidation: true
      }) || studentDedupe;
    } catch (e) { Logger.log('Related Student dedupe failed for %s: %s', ticketId, e.message); }
    try {
      if (RelatedResources.dedupeTicket) resourceDedupe = RelatedResources.dedupeTicket(ticketId, false, {
        rows: resourceRows, fast: true, skipAccessValidation: true, skipTicketValidation: true
      }) || resourceDedupe;
    } catch (e) { Logger.log('Related Resource dedupe failed for %s: %s', ticketId, e.message); }

    if (Number(studentDedupe.removedDuplicates || 0) > 0) studentRows = findAll(TABS.RELATED_STUDENTS, 'ticket_id', ticketId);
    if (Number(resourceDedupe.removedDuplicates || 0) > 0) resourceRows = findAll(TABS.RELATED_RESOURCES, 'ticket_id', ticketId);

    let students = [], resources = [], studentTokens = [], resourceTokens = [];
    let studentSyncChanged = false, resourceSyncChanged = false;
    const syncContext = {
      ticket: ticket,
      activityRows: activityRows,
      studentRows: studentRows,
      resourceRows: resourceRows,
      fast: true,
      skipAccessValidation: true
    };

    try {
      const studentSync = RelatedStudents.syncFromTicket(ticketId, syncContext);
      students = studentSync.rows || [];
      studentTokens = studentSync.studentTokens || students;
      studentSyncChanged = !!studentSync.changed;
    } catch (e) {
      const relatedStudents = RelatedStudents.snapshot(ticketId, { fast: true, skipAccessValidation: true, skipTicketValidation: true });
      students = relatedStudents.students || [];
      studentTokens = relatedStudents.studentTokens || students;
    }
    try {
      const resourceSync = RelatedResources.syncFromTicket(ticketId, syncContext);
      resources = resourceSync.rows || [];
      resourceTokens = resourceSync.resourceTokens || resources;
      resourceSyncChanged = !!resourceSync.changed;
    } catch (e) {
      const relatedResources = RelatedResources.snapshot(ticketId, { fast: true, skipAccessValidation: true, skipTicketValidation: true });
      resources = relatedResources.resources || [];
      resourceTokens = relatedResources.resourceTokens || resources;
    }

    const activity = activityRows.slice().sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
    return {
      students: students,
      studentTokens: studentTokens,
      resources: resources,
      resourceTokens: resourceTokens,
      activity: activity,
      changed: gmailChanged || chatChanged || studentSyncChanged || resourceSyncChanged || Number(studentDedupe.removedDuplicates || 0) > 0 || Number(resourceDedupe.removedDuplicates || 0) > 0
    };
  });
}

function api_removeResource(ticketId, resourceId) {
  return respond_(function () {
    return { resources: RelatedResources.remove(ticketId, resourceId), resourceTokens: RelatedResources.listForTokens(ticketId) };
  });
}

function api_removeResources(ticketId, resourceIds) {
  return respond_(function () {
    return { resources: RelatedResources.removeMany(ticketId, resourceIds || []), resourceTokens: RelatedResources.listForTokens(ticketId) };
  });
}

function api_renameAttachment(ticketId, resourceId, name) {
  return respond_(function () {
    RelatedResources.renameAttachment(ticketId, resourceId, name);
    return { resources: RelatedResources.listAll(ticketId) };
  });
}

function api_moveResource(ticketId, resourceId, parentId) {
  return respond_(function () { return { resources: RelatedResources.moveUnder(ticketId, resourceId, parentId) }; });
}

function api_moveResourceUp(ticketId, resourceId) {
  return respond_(function () { return { resources: RelatedResources.moveUpLevel(ticketId, resourceId) }; });
}

function api_unnestResource(ticketId, resourceId) {
  return respond_(function () { return { resources: RelatedResources.unnest(ticketId, resourceId) }; });
}

function api_inlineImages(ticketId, resourceIds, shareToken) {
  return respond_(function () {
    Tickets.assertReadAccess(ticketId, shareToken);
    return RelatedResources.inlineImages(ticketId, resourceIds || []);
  });
}


// ---------------------------------------------------------------------------
// Diagnostics — run these from the editor, not the page
// ---------------------------------------------------------------------------

function debugList() {
  const raw = api_list('in_progress', { limit: 50, offset: 0 });
  Logger.log('Returned %s chars', raw.length);
  Logger.log(raw.substring(0, 1500));
}

function debugBootstrap() {
  Logger.log(api_bootstrap());
}

function debugNotifications() {
  Logger.log(api_notificationSummary());
}

// ---------------------------------------------------------------------------
// Chrome extension RPC bridge
// Uses the same authenticated google.script.run channel as the dashboard.
// ---------------------------------------------------------------------------
function api_extensionBootstrap() {
  return respond_(function () { return ExtensionApi.bootstrap(); });
}

function api_extensionSearch(q) {
  return respond_(function () { return ExtensionApi.search(q || ''); });
}

function api_extensionCapture(payload) {
  return respond_(function () { return ExtensionApi.capture(payload || {}); });
}

function api_extensionCreate(payload) {
  return respond_(function () { return ExtensionApi.createFromPage(payload || {}); });
}

// ---------------------------------------------------------------------------
// Chrome extension direct OAuth / Apps Script API executable entry point.
// Called by scripts.run from the Chrome extension. Returns plain JSON-safe data.
// ---------------------------------------------------------------------------
function extensionApiRun(action, payload) {
  action = String(action || '').trim().toLowerCase();
  payload = payload || {};
  if (action === 'bootstrap') return ExtensionApi.bootstrap();
  if (action === 'search') return ExtensionApi.search(String(payload.q || ''));
  if (action === 'capture') return ExtensionApi.capture(payload);
  if (action === 'create') return ExtensionApi.createFromPage(payload);
  throw new Error('Unknown Project Tracker extension action: ' + action);
}
