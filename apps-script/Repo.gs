/**
 * Project Tracker — data access
 * The only module that touches SpreadsheetApp. Everything else calls Repo.
 * Swapping the Sheet for a real database later means rewriting this file only.
 */

const Repo = (function () {

  let _ss = null;

  function ss_() {
    if (_ss) return _ss;
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('No spreadsheet — run setup() first.');
    _ss = SpreadsheetApp.openById(id);
    return _ss;
  }

  function sheet_(tabName) {
    const s = ss_().getSheetByName(tabName);
    if (!s) throw new Error('Missing tab: ' + tabName);
    return s;
  }

  function nowIso_() {
    return new Date().toISOString();
  }

  function me_() {
    return Session.getActiveUser().getEmail();
  }


  // -- reading ---------------------------------------------------------------

  /** Every row of a tab as objects keyed by header. */
  function readAll(tabName) {
    const sheet = sheet_(tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const headers = SCHEMA[tabName];
    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

    return values.map(function (row, i) {
      const obj = { _row: i + 2 };
      headers.forEach(function (h, c) { obj[h] = row[c]; });
      return obj;
    });
  }

  function findRow_(tabName, idField, idValue) {
    const headers = SCHEMA[tabName];
    const col = headers.indexOf(idField) + 1;
    if (col === 0) throw new Error('No such field: ' + idField);

    const sheet = sheet_(tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return -1;

    const ids = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(idValue)) return i + 2;
    }
    return -1;
  }

  function findOne(tabName, idField, idValue) {
    const row = findRow_(tabName, idField, idValue);
    if (row === -1) return null;

    const headers = SCHEMA[tabName];
    const values = sheet_(tabName).getRange(row, 1, 1, headers.length).getValues()[0];

    const obj = { _row: row };
    headers.forEach(function (h, c) { obj[h] = values[c]; });
    return obj;
  }

  /**
   * Exact single-row lookup that lets Sheets locate the ID instead of first
   * downloading the entire ID column into Apps Script. Existing findOne() is
   * intentionally left unchanged; this is used only on latency-sensitive read
   * paths that use stable string IDs (for example ticket_id).
   */
  function findOneFast(tabName, idField, idValue) {
    const headers = SCHEMA[tabName];
    const col = headers.indexOf(idField) + 1;
    if (col === 0) throw new Error('No such field: ' + idField);

    const sheet = sheet_(tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const cell = sheet.getRange(2, col, lastRow - 1, 1)
      .createTextFinder(String(idValue))
      .matchEntireCell(true)
      .matchCase(true)
      .findNext();
    if (!cell) return null;

    const rowNum = cell.getRow();
    const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    const obj = { _row: rowNum };
    headers.forEach(function (h, c) { obj[h] = values[c]; });
    return obj;
  }

  /**
   * Exact multi-row lookup optimized for read-heavy detail views. TextFinder
   * still identifies the matching rows, but nearby matches are fetched in a
   * small number of contiguous blocks instead of one getValues() call per row.
   * Existing findAll() remains unchanged so unrelated code paths keep their
   * current behavior while the optimization is proven in production.
   */
  function findAllFast(tabName, idField, idValue) {
    const headers = SCHEMA[tabName];
    const col = headers.indexOf(idField) + 1;
    if (col === 0) throw new Error('No such field: ' + idField);

    const sheet = sheet_(tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const matches = sheet.getRange(2, col, lastRow - 1, 1)
      .createTextFinder(String(idValue))
      .matchEntireCell(true)
      .matchCase(true)
      .findAll();
    if (!matches.length) return [];

    const seenRows = {};
    const rowNums = matches.map(function (cell) { return cell.getRow(); })
      .filter(function (rowNum) {
        if (seenRows[rowNum]) return false;
        seenRows[rowNum] = true;
        return true;
      })
      .sort(function (a, b) { return a - b; });

    // Batch nearby matches without turning a handful of sparse matches into a
    // giant sheet transfer. The density guard keeps a block only when its span
    // is reasonably small relative to the number of rows we actually need.
    const MAX_BLOCK_ROWS = 2500;
    const MAX_ROWS_PER_MATCH = 200;
    const blocks = [];
    rowNums.forEach(function (rowNum) {
      const last = blocks.length ? blocks[blocks.length - 1] : null;
      const nextCount = last ? last.count + 1 : 1;
      const nextSpan = last ? rowNum - last.start + 1 : 1;
      if (!last || nextSpan > MAX_BLOCK_ROWS || nextSpan > nextCount * MAX_ROWS_PER_MATCH) {
        blocks.push({ start: rowNum, end: rowNum, count: 1 });
      } else {
        last.end = rowNum;
        last.count = nextCount;
      }
    });

    const wanted = String(idValue);
    const out = [];
    blocks.forEach(function (block) {
      const values = sheet.getRange(block.start, 1, block.end - block.start + 1, headers.length).getValues();
      values.forEach(function (row, offset) {
        if (String(row[col - 1]) !== wanted) return;
        const obj = { _row: block.start + offset };
        headers.forEach(function (h, c) { obj[h] = row[c]; });
        out.push(obj);
      });
    });
    return out;
  }

  /** Exact-match lookup for every row sharing one field value. */
  function findAll(tabName, idField, idValue) {
    const headers = SCHEMA[tabName];
    const col = headers.indexOf(idField) + 1;
    if (col === 0) throw new Error('No such field: ' + idField);

    const sheet = sheet_(tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const matches = sheet.getRange(2, col, lastRow - 1, 1)
      .createTextFinder(String(idValue))
      .matchEntireCell(true)
      .findAll();

    if (!matches.length) return [];

    return matches.map(function (cell) {
      const rowNum = cell.getRow();
      const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      const obj = { _row: rowNum };
      headers.forEach(function (h, c) { obj[h] = values[c]; });
      return obj;
    });
  }



  /** Read a range from an explicitly configured external spreadsheet.
   *  Used for server-side credential lookup so other modules never call SpreadsheetApp.
   */
  function readExternalRange(spreadsheetId, sheetName, a1Notation) {
    const id = String(spreadsheetId || '').trim();
    const tab = String(sheetName || '').trim();
    const range = String(a1Notation || '').trim();
    if (!id || !tab || !range) throw new Error('External spreadsheet lookup is not configured.');
    const book = SpreadsheetApp.openById(id);
    const sheet = book.getSheetByName(tab);
    if (!sheet) throw new Error('Missing credential sheet: ' + tab);
    return sheet.getRange(range).getValues();
  }

  // -- writing ---------------------------------------------------------------

  function append(tabName, obj) {
    return withLock_(function () {
      const headers = SCHEMA[tabName];
      const row = headers.map(function (h) {
        return obj[h] === undefined || obj[h] === null ? '' : obj[h];
      });
      sheet_(tabName).appendRow(row);
      invalidate_(tabName);
      return obj;
    });
  }

  function appendMany(tabName, objects) {
    objects = objects || [];
    if (!objects.length) return [];

    return withLock_(function () {
      const headers = SCHEMA[tabName];
      const rows = objects.map(function (obj) {
        return headers.map(function (h) {
          return obj[h] === undefined || obj[h] === null ? '' : obj[h];
        });
      });
      const sheet = sheet_(tabName);
      const start = sheet.getLastRow() + 1;
      sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
      invalidate_(tabName);
      return objects;
    });
  }

  function update(tabName, idField, idValue, patch) {
    return withLock_(function () {
      const rowNum = findRow_(tabName, idField, idValue);
      if (rowNum === -1) throw new Error('Not found: ' + idValue + ' in ' + tabName);

      const headers = SCHEMA[tabName];
      const sheet = sheet_(tabName);
      const current = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

      headers.forEach(function (h, c) {
        if (patch[h] !== undefined) current[c] = patch[h] === null ? '' : patch[h];
      });

      sheet.getRange(rowNum, 1, 1, headers.length).setValues([current]);
      invalidate_(tabName);

      const obj = { _row: rowNum };
      headers.forEach(function (h, c) { obj[h] = current[c]; });
      return obj;
    });
  }

  /** Apply different patches to multiple rows in one locked sheet write. */
  function updateMany(tabName, idField, patchesById) {
    patchesById = patchesById || {};
    const ids = Object.keys(patchesById);
    if (!ids.length) return [];
    return withLock_(function () {
      const headers = SCHEMA[tabName];
      const idCol = headers.indexOf(idField);
      if (idCol < 0) throw new Error('No such field: ' + idField);
      const sheet = sheet_(tabName);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];
      const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      const wanted = {};
      ids.forEach(function (id) { wanted[String(id)] = patchesById[id]; });
      const updated = [];
      values.forEach(function (row, i) {
        const key = String(row[idCol]);
        const patch = wanted[key];
        if (!patch) return;
        headers.forEach(function (h, c) {
          if (patch[h] !== undefined) row[c] = patch[h] === null ? '' : patch[h];
        });
        const obj = { _row: i + 2 };
        headers.forEach(function (h, c) { obj[h] = row[c]; });
        updated.push(obj);
      });
      if (updated.length) {
        sheet.getRange(2, 1, values.length, headers.length).setValues(values);
        invalidate_(tabName);
      }
      return updated;
    });
  }

  function remove(tabName, idField, idValue) {
    return withLock_(function () {
      const rowNum = findRow_(tabName, idField, idValue);
      if (rowNum === -1) return false;
      sheet_(tabName).deleteRow(rowNum);
      invalidate_(tabName);
      return true;
    });
  }

  /** Concurrent writes from multiple clients will clobber each other without this. */
  function withLock_(fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      throw new Error('Timed out waiting for the lock — try again.');
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }


  // -- ticket ids ------------------------------------------------------------

  function nextTicketId() {
    return withLock_(function () {
      const sheet = sheet_(TABS.META);
      const row = findRow_(TABS.META, 'key', 'next_ticket_number');
      if (row === -1) throw new Error('Meta row missing — re-run setup().');

      const n = Number(sheet.getRange(row, 2).getValue()) || 1;
      sheet.getRange(row, 2).setValue(n + 1);
      return format_(n);
    });
  }

  function peekNextTicketId() {
    const row = findRow_(TABS.META, 'key', 'next_ticket_number');
    if (row === -1) return CONFIG.TICKET_PREFIX + '????';
    const n = Number(sheet_(TABS.META).getRange(row, 2).getValue()) || 1;
    return format_(n);
  }

  function format_(n) {
    let s = String(n);
    while (s.length < CONFIG.TICKET_PAD) s = '0' + s;
    return CONFIG.TICKET_PREFIX + s;
  }


  // -- config lookups --------------------------------------------------------

  function activeTypes() {
    return readAll(TABS.TYPES)
      .filter(function (t) { return t.active === true || t.active === 'TRUE'; })
      .sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function activeDepartments() {
    return readAll(TABS.DEPARTMENTS)
      .filter(function (d) { return d.active === true || d.active === 'TRUE'; })
      .sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function sizes() {
    return readAll(TABS.SIZES).sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function activeAgents() {
    const cached = cacheGet('active_agents');
    if (cached) return cached;

    const rows = readAll(TABS.AGENTS)
      .filter(function (a) { return a.active === true || a.active === 'TRUE'; });
    cachePut('active_agents', rows, CONFIG.AGENT_CACHE_SECONDS);
    return rows;
  }

  function defaultSizeForType(typeName) {
    const t = activeTypes().filter(function (x) { return x.type_name === typeName; })[0];
    return t ? t.default_size : 'M';
  }

  /** Single source of truth for permissions. */
  function roleOf(email) {
    const a = activeAgents().filter(function (x) {
      return String(x.email).toLowerCase() === String(email).toLowerCase();
    })[0];
    return a ? a.role : null;
  }

  function requireAccess(minRole) {
    const email = me_();
    const role = String(roleOf(email) || '').toLowerCase();
    if (!role) throw new Error('Not authorized: ' + email);

    // "agent" is the historical write-access gate used throughout the app.
    // Editors intentionally pass it, but remain excluded from assignment lists
    // because assignment UIs filter for role === 'agent'.
    if (minRole === 'agent' && role !== 'agent' && role !== 'editor') {
      throw new Error('Read-only access: ' + email);
    }
    if (minRole === 'editor' && role !== 'editor') {
      throw new Error('Editor access required: ' + email);
    }
    return { email: email, role: role };
  }


  // -- cache -----------------------------------------------------------------
  // Chunked because CacheService caps a single value at 100KB.

  function cacheGet(key) {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(key + '_meta');
    if (!meta) return null;

    const count = Number(meta);
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(key + '_' + i);

    const parts = cache.getAll(keys);
    let joined = '';
    for (let i = 0; i < count; i++) {
      if (!parts[key + '_' + i]) return null;
      joined += parts[key + '_' + i];
    }

    try {
      return JSON.parse(joined);
    } catch (e) {
      return null;
    }
  }

  function cachePut(key, value, expirationSeconds) {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(value);
    const size = 90000;
    const chunks = [];

    for (let i = 0; i < json.length; i += size) chunks.push(json.substring(i, i + size));
    if (chunks.length > 20) return;

    const map = {};
    chunks.forEach(function (c, i) { map[key + '_' + i] = c; });
    map[key + '_meta'] = String(chunks.length);

    cache.putAll(map, expirationSeconds || CONFIG.CACHE_SECONDS);
  }

  function cacheRemove(key) {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(key + '_meta');
    const keys = [key + '_meta'];
    const count = Number(meta) || 0;
    for (let i = 0; i < count; i++) keys.push(key + '_' + i);
    cache.removeAll(keys);
  }

  function invalidate_(tabName) {
    if (tabName === TABS.TICKETS || tabName === TABS.ACTIVITY || tabName === TABS.LINKS) {
      cacheRemove('tickets_idx');
    }
    if (tabName === TABS.AGENTS) cacheRemove('active_agents');
  }

  function invalidateAll() {
    cacheRemove('tickets_idx');
    cacheRemove('active_agents');
  }


  return {
    readAll: readAll,
    readExternalRange: readExternalRange,
    findOne: findOne,
    findOneFast: findOneFast,
    findAll: findAll,
    findAllFast: findAllFast,
    append: append,
    appendMany: appendMany,
    update: update,
    updateMany: updateMany,
    remove: remove,
    nextTicketId: nextTicketId,
    peekNextTicketId: peekNextTicketId,
    activeTypes: activeTypes,
    activeDepartments: activeDepartments,
    sizes: sizes,
    activeAgents: activeAgents,
    defaultSizeForType: defaultSizeForType,
    roleOf: roleOf,
    requireAccess: requireAccess,
    cacheGet: cacheGet,
    cachePut: cachePut,
    cacheRemove: cacheRemove,
    invalidateAll: invalidateAll,
    now: nowIso_,
    me: me_
  };

})();
