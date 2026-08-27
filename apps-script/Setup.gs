/**
 * Project Tracker — one-time setup
 * Creates the spreadsheet, all tabs, headers, and seed config.
 * Safe to re-run: it adds what's missing and leaves existing data alone.
 */

function setup() {
  validateTemplateConfiguration_();
  const ssId = getOrCreateSpreadsheet_();
  const ss = SpreadsheetApp.openById(ssId);

  Object.keys(SCHEMA).forEach(function (tabName) {
    ensureTab_(ss, tabName, SCHEMA[tabName]);
  });

  seedIfEmpty_(ss, TABS.AGENTS, SEED.agents);
  seedIfEmpty_(ss, TABS.TYPES, SEED.types);
  seedIfEmpty_(ss, TABS.DEPARTMENTS, SEED.departments);
  seedIfEmpty_(ss, TABS.SIZES, SEED.sizes);
  seedIfEmpty_(ss, TABS.META, [['next_ticket_number', 1]]);

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) ss.deleteSheet(def);

  // Schema migrations can change fields used by the cached ticket index.
  // Clear it so the first page load sees the new columns immediately.
  Repo.invalidateAll();

  Logger.log('Setup complete.');
  Logger.log('Spreadsheet: https://docs.google.com/spreadsheets/d/' + ssId);
  return ssId;
}



function validateTemplateConfiguration_() {
  const problems = [];
  if (!CONFIG.INSTITUTION_NAME || /YOUR INSTITUTION/i.test(CONFIG.INSTITUTION_NAME)) problems.push('Set CONFIG.INSTITUTION_NAME in Config.gs.');
  if (!CONFIG.DRIVE_ID || /^PASTE_/i.test(CONFIG.DRIVE_ID)) problems.push('Set CONFIG.DRIVE_ID to the Shared Drive ID.');
  if (!CONFIG.TICKETS_FOLDER_ID || /^PASTE_/i.test(CONFIG.TICKETS_FOLDER_ID)) problems.push('Set CONFIG.TICKETS_FOLDER_ID.');
  if (!CONFIG.ARCHIVE_FOLDER_ID || /^PASTE_/i.test(CONFIG.ARCHIVE_FOLDER_ID)) problems.push('Set CONFIG.ARCHIVE_FOLDER_ID.');
  if (!(CONFIG.ALLOWED_VIEWER_DOMAINS || []).length || (CONFIG.ALLOWED_VIEWER_DOMAINS || []).some(function (d) { return /example\.edu/i.test(String(d)); })) problems.push('Set CONFIG.ALLOWED_VIEWER_DOMAINS.');
  if (!ELEMENT451_CONFIG.CLIENT || /^YOUR_/i.test(ELEMENT451_CONFIG.CLIENT)) problems.push('Set ELEMENT451_CONFIG.CLIENT in ElementConfig.gs.');
  if (!ELEMENT451_CONFIG.CREDENTIALS_SPREADSHEET_ID || /^PASTE_/i.test(ELEMENT451_CONFIG.CREDENTIALS_SPREADSHEET_ID)) problems.push('Set ELEMENT451_CONFIG.CREDENTIALS_SPREADSHEET_ID.');
  ['spark', 'school'].forEach(function (kind) {
    const cfg = projectTrackerStudentIdentityConfig_(kind);
    if (!cfg.enabled) return;
    if (!cfg.label || /^Additional ID(?:\s+\d+)?$/i.test(cfg.label)) {
      problems.push('Set a real institution-facing label for each enabled CONFIG.ADDITIONAL_STUDENT_ID_TYPES slot.');
    }
    if (!cfg.mappingSlug) {
      problems.push('Set a verified Element451 mappingSlug for enabled identifier ' + cfg.label + '.');
    }
    if (cfg.tokenPattern) {
      try { projectTrackerStudentIdentityRegex_(kind, 'i', true); }
      catch (e) { problems.push(String(e && e.message || e)); }
    }
  });
  if (problems.length) throw new Error('Template configuration is incomplete:\n- ' + problems.join('\n- '));
  return true;
}

/** Prints what setup created, without changing anything. */
function verifySetup() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) {
    Logger.log('No spreadsheet yet — run setup() first.');
    return;
  }

  const ss = SpreadsheetApp.openById(ssId);
  Logger.log('Spreadsheet: %s', ss.getName());

  Object.keys(SCHEMA).forEach(function (tabName) {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log('  %s — MISSING', tabName);
      return;
    }
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rows = Math.max(0, sheet.getLastRow() - 1);
    const match = headers.join('|') === SCHEMA[tabName].join('|');
    Logger.log('  %s — %s rows, headers %s', tabName, rows, match ? 'ok' : 'MISMATCH: ' + headers.join(', '));
  });

  Logger.log('Next ticket: %s', Repo.peekNextTicketId());
}


// ---------------------------------------------------------------------------

function getOrCreateSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('SPREADSHEET_ID');

  if (existing) {
    try {
      SpreadsheetApp.openById(existing);
      return existing;
    } catch (e) {
      Logger.log('Stored spreadsheet ID unreachable, creating a new one.');
    }
  }

  // Create in the shared drive so the team owns it, not one account.
  const file = Drive.Files.create(
    {
      name: CONFIG.SPREADSHEET_NAME,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [CONFIG.DRIVE_ID]
    },
    null,
    { supportsAllDrives: true }
  );

  props.setProperty('SPREADSHEET_ID', file.id);
  Logger.log('Created spreadsheet %s', file.id);
  return file.id;
}


function ensureTab_(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    Logger.log('Created tab: %s', tabName);
  }

  const existing = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    : [];

  if (existing.join('|') !== headers.join('|')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    Logger.log('Wrote headers: %s', tabName);
  }

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#f0f0f0');
  sheet.setFrozenRows(1);

  // Keep ISO date strings from being coerced into Sheets date values.
  const textCols = TEXT_COLUMNS[tabName] || [];
  textCols.forEach(function (colName) {
    const idx = headers.indexOf(colName);
    if (idx >= 0) {
      sheet.getRange(2, idx + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    }
  });
}


function seedIfEmpty_(ss, tabName, rows) {
  const sheet = ss.getSheetByName(tabName);
  if (sheet.getLastRow() > 1) return;
  rows = rows || [];
  if (!rows.length) {
    Logger.log('Left %s empty for manual configuration.', tabName);
    return;
  }

  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Seeded %s with %s rows', tabName, rows.length);
}


// ---------------------------------------------------------------------------
// Destructive — only for starting over during development.
// ---------------------------------------------------------------------------

function resetEverything_CAREFUL() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SPREADSHEET_ID');

  if (ssId) {
    Drive.Files.update({ trashed: true }, ssId, null, { supportsAllDrives: true });
    Logger.log('Trashed spreadsheet %s', ssId);
  }

  props.deleteProperty('SPREADSHEET_ID');
  CacheService.getScriptCache().removeAll(['tickets_idx_meta']);
  Logger.log('Reset done. Run setup() to rebuild.');
}

/**
 * One-time, migration-safe setup for the Google Chat integration.
 * Adds only the new ChatLinks tab and the appended Google Chat watch columns.
 * Existing rows and production ticket data are left untouched.
 */
function migrateGoogleChatIntegration() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('No Project Tracker spreadsheet is configured.');
  const ss = SpreadsheetApp.openById(ssId);

  let chat = ss.getSheetByName(TABS.CHAT_LINKS);
  if (!chat) {
    chat = ss.insertSheet(TABS.CHAT_LINKS);
    chat.getRange(1, 1, 1, SCHEMA.ChatLinks.length).setValues([SCHEMA.ChatLinks]);
  } else {
    const existing = chat.getLastColumn()
      ? chat.getRange(1, 1, 1, chat.getLastColumn()).getValues()[0]
      : [];
    if (!existing.length) chat.getRange(1, 1, 1, SCHEMA.ChatLinks.length).setValues([SCHEMA.ChatLinks]);
  }
  chat.getRange(1, 1, 1, SCHEMA.ChatLinks.length).setFontWeight('bold').setBackground('#f0f0f0');
  chat.setFrozenRows(1);
  (TEXT_COLUMNS.ChatLinks || []).forEach(function (name) {
    const idx = SCHEMA.ChatLinks.indexOf(name);
    if (idx >= 0 && chat.getMaxRows() > 1) chat.getRange(2, idx + 1, chat.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  const watches = ss.getSheetByName(TABS.WATCHES);
  if (!watches) throw new Error('Missing Watches tab. Run normal setup migration first.');
  const watchHeaders = watches.getRange(1, 1, 1, Math.max(1, watches.getLastColumn())).getValues()[0];
  ['chat_on_complete', 'chat_completion_notified_at'].forEach(function (header) {
    const currentHeaders = watches.getRange(1, 1, 1, Math.max(1, watches.getLastColumn())).getValues()[0];
    if (currentHeaders.indexOf(header) >= 0) return;
    const col = watches.getLastColumn() + 1;
    watches.getRange(1, col).setValue(header).setFontWeight('bold').setBackground('#f0f0f0');
  });

  Repo.invalidateAll();
  return {
    ok: true,
    chatLinksTab: TABS.CHAT_LINKS,
    watchColumns: ['chat_on_complete', 'chat_completion_notified_at']
  };
}

/**
 * One-time, migration-safe setup for the passive workload/capacity study.
 * Creates only the three study tabs, backfills ticket metrics/lifecycle creation
 * records from existing data, and installs one daily trigger. Existing Project
 * Tracker rows are not reset or rewritten.
 */
function migrateWorkloadStudy() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('No Project Tracker spreadsheet is configured.');
  const ss = SpreadsheetApp.openById(ssId);

  [TABS.WORKLOAD_SNAPSHOTS, TABS.TICKET_METRICS, TABS.TICKET_LIFECYCLE].forEach(function (tabName) {
    ensureTab_(ss, tabName, SCHEMA[tabName]);
  });

  Repo.invalidateAll();
  const lifecycleAdded = WorkloadStudy.backfillMissingLifecycleCreates();
  const metrics = WorkloadStudy.refreshTicketMetrics();
  const trigger = WorkloadStudy.installDailyTrigger();

  return {
    ok: true,
    tabs: [TABS.WORKLOAD_SNAPSHOTS, TABS.TICKET_METRICS, TABS.TICKET_LIFECYCLE],
    lifecycleCreated: lifecycleAdded,
    ticketMetrics: metrics,
    dailyTrigger: trigger,
    firstAutomaticSnapshot: 'The trigger captures the previous local day after midnight.'
  };
}
