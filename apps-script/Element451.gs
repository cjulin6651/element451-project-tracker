/**
 * Project Tracker — Element451 API client
 *
 * Security rules:
 * - credentials are read only on the server from the configured Google Sheet;
 * - credentials are never returned to Index.html;
 * - secrets and raw production payloads are never logged;
 * - every request uses Bearer authentication over HTTPS.
 *
 * Spreadsheet access is delegated to Repo.gs so Repo remains the only module
 * that calls SpreadsheetApp.
 *
 * IMPORTANT: Do NOT paste the credential spreadsheet ID into this file.
 * Element451.gs reads it from ELEMENT451_CONFIG.CREDENTIALS_SPREADSHEET_ID.
 */
const Element451 = (function () {

  const SLUGS = Object.freeze({
    ELEMENT_ID: 'user-elementid',
    FIRST_NAME: 'user-first-name',
    LAST_NAME: 'user-last-name',
    PROFILE_TYPE: 'user-profile-type',
    SPARK_ID: 'user-identities-sparkid',
    SCHOOL_ID: 'user-identities-schoolid'
  });

  function credentials_() {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'element451_credentials_v2';
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const spreadsheetId = String(ELEMENT451_CONFIG.CREDENTIALS_SPREADSHEET_ID || '').trim();
    if (!spreadsheetId || spreadsheetId === 'PASTE_GOOGLE_SHEET_ID_HERE') {
      throw new Error('Element451 credential spreadsheet ID is not configured in ElementConfig.gs.');
    }

    const values = Repo.readExternalRange(
      spreadsheetId,
      ELEMENT451_CONFIG.CREDENTIALS_SHEET_NAME || 'Sheet1',
      ELEMENT451_CONFIG.CREDENTIAL_RANGE || 'B1:B4'
    );

    const rawKey = String(values[0] && values[0][0] || '').trim();
    const feature = String(values[2] && values[2][0] || '').trim(); // B3
    const analytics = String(values[3] && values[3][0] || '').trim(); // B4

    if (!rawKey) throw new Error('Element451 API key is missing from Sheet1!B1.');
    if (!feature) throw new Error('Element451 Feature token is missing from Sheet1!B3.');

    let token = rawKey.replace(/^Bearer\s+/i, '').trim();
    if (token.indexOf('E451.') !== 0) token = 'E451.' + token;

    const out = { token: token, feature: feature, analytics: analytics };
    cache.put(cacheKey, JSON.stringify(out), ELEMENT451_CONFIG.CREDENTIAL_CACHE_SECONDS || 300);
    return out;
  }

  function baseUrl_() {
    const client = String(ELEMENT451_CONFIG.CLIENT || '').trim();
    const api = String(ELEMENT451_CONFIG.API || '').trim();
    if (!client || !api) throw new Error('Element451 CLIENT/API are not configured.');
    return 'https://' + client + '.' + api;
  }

  function queryString_(params) {
    const parts = [];
    Object.keys(params || {}).forEach(function (key) {
      const value = params[key];
      // Preserve an explicit empty string so endpoints that require a key such
      // as embed[all]= can receive it exactly as documented/supplied.
      if (value === null || value === undefined) return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function request_(path, method, body, extraParams, requestOptions) {
    const c = credentials_();
    const params = Object.assign({ feature: c.feature }, extraParams || {});
    if (c.analytics) params.analytics = c.analytics;
    // A small number of legacy/current Element endpoints still expect the token
    // as a query parameter in addition to Bearer auth. Keep that behavior
    // opt-in so secrets are never added to URLs for endpoints that do not need it.
    if (requestOptions && requestOptions.includeTokenQuery) params.token = c.token;

    const options = {
      method: method || 'get',
      headers: {
        Authorization: 'Bearer ' + c.token,
        Feature: c.feature,
        Accept: 'application/json'
      },
      muteHttpExceptions: true,
      followRedirects: true
    };

    if (body !== undefined && body !== null) {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(body);
    }

    const response = UrlFetchApp.fetch(baseUrl_() + path + queryString_(params), options);
    const code = response.getResponseCode();
    const text = response.getContentText() || '';
    let parsed = {};

    if (text) {
      try { parsed = JSON.parse(text); }
      catch (e) { throw new Error('Element451 returned non-JSON content (HTTP ' + code + ').'); }
    }

    if (code < 200 || code >= 300) {
      throw new Error('Element451 request failed: ' + safeError_(parsed, code));
    }
    return parsed;
  }

  /**
   * GET a public-facing Element451 resource without sending the API bearer key.
   * Feature and Analytics still come from the server-side credential Sheet.
   */
  function publicGet_(path, extraParams) {
    const c = credentials_();
    const params = Object.assign({ feature: c.feature }, extraParams || {});
    if (c.analytics) params.analytics = c.analytics;

    const options = {
      method: 'get',
      headers: { Accept: 'application/json' },
      muteHttpExceptions: true,
      followRedirects: true
    };

    const response = UrlFetchApp.fetch(baseUrl_() + path + queryString_(params), options);
    const code = response.getResponseCode();
    const text = response.getContentText() || '';
    let parsed = {};

    if (text) {
      try { parsed = JSON.parse(text); }
      catch (e) { throw new Error('Element451 returned non-JSON content (HTTP ' + code + ').'); }
    }

    if (code < 200 || code >= 300) {
      throw new Error('Element451 public request failed: ' + safeError_(parsed, code));
    }
    return parsed;
  }

  function safeError_(payload, code) {
    if (payload && typeof payload === 'object') {
      if (payload.message) return String(payload.message).substring(0, 300);
      if (typeof payload.error === 'string') return payload.error.substring(0, 300);
      if (payload.error && payload.error.message) return String(payload.error.message).substring(0, 300);
    }
    return 'HTTP ' + code;
  }

  function userTemplate_() {
    return {
      columns: [
        { field: 'Element ID', mode: 'slug', slug: SLUGS.ELEMENT_ID },
        { field: 'First Name', mode: 'slug', slug: SLUGS.FIRST_NAME },
        { field: 'Last Name', mode: 'slug', slug: SLUGS.LAST_NAME },
        { field: 'Profile Type', mode: 'slug', slug: SLUGS.PROFILE_TYPE }
      ]
    };
  }

  function exportUsers_(selection) {
    const item = Object.assign({
      template: userTemplate_(),
      options: { column_key: 'slug' },
      per_page: Math.max(1, Math.min(50, Number(selection && selection.per_page) || 10))
    }, selection || {});

    const response = request_('/v2/users/export', 'post', { item: item });
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normalizePerson_).filter(function (p) { return !!p.element_id; });
  }

  function scalar_(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.length ? scalar_(value[0]) : '';
    if (typeof value === 'object') {
      if (value.value !== undefined) return scalar_(value.value);
      if (value.label !== undefined) return scalar_(value.label);
      if (value._id !== undefined) return scalar_(value._id);
      const keys = Object.keys(value);
      if (keys.length === 1) return scalar_(value[keys[0]]);
      return '';
    }
    return String(value);
  }

  function normalizePerson_(row) {
    const elementId = scalar_(row[SLUGS.ELEMENT_ID] || row['Element ID']).trim();
    const first = scalar_(row[SLUGS.FIRST_NAME] || row['First Name']).trim();
    const last = scalar_(row[SLUGS.LAST_NAME] || row['Last Name']).trim();
    const profileType = scalar_(row[SLUGS.PROFILE_TYPE] || row['Profile Type']).trim();
    return {
      element_id: elementId,
      first_name: first,
      last_name: last,
      name: [first, last].filter(Boolean).join(' ').trim() || elementId,
      profile_type: profileType,
      profile_url: profileUrl_(elementId)
    };
  }

  function profileUrl_(elementId) {
    return element451ProfileUrl_(elementId);
  }

  function assertElementId_(value) {
    const id = String(value || '').trim();
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('That does not look like a valid Element ID.');
    return id.toLowerCase();
  }

  function identitySlugForKind_(kind) {
    const configured = projectTrackerStudentIdentityMappingSlug_(kind);
    if (configured) return configured;
    // Legacy compatibility fallback. These internal slot names are not
    // institution-facing labels and should remain disabled unless configured.
    return kind === 'school' ? SLUGS.SCHOOL_ID : SLUGS.SPARK_ID;
  }

  function identityLabelForKind_(kind) {
    return projectTrackerStudentIdentityLabel_(kind) || 'Additional ID';
  }

  function lookupByElementId(elementId) {
    const id = assertElementId_(elementId);
    const cache = CacheService.getScriptCache();
    const key = 'e451_person_' + id;
    const cached = cache.get(key);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const rows = exportUsers_({ users: [id], per_page: 1 });
    if (!rows.length) throw new Error('No Element451 person was found for that Element ID.');
    cache.put(key, JSON.stringify(rows[0]), ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 600);
    return rows[0];
  }

  /**
   * Element451 identity mappings are tenant-scoped and can change over time.
   * Resolve configured external person/student identifiers from the tenant's
   * live Mapping collection instead of assuming historic slugs will always
   * remain exportable.
   *
   * The Element451 export API documents segment filter targets as mapping
   * references. We prefer the compact <mapping:slug> form and retain the
   * older spaced form plus the raw slug as compatibility fallbacks.
   */
  function identityFilter_(target, value) {
    return {
      type: 'filter',
      target: target,
      operator: '$eq',
      value: String(value || '').trim()
    };
  }

  function mappingRowsFromResponse_(response) {
    if (!response || typeof response !== 'object') return [];
    if (Array.isArray(response)) return response;
    if (Array.isArray(response.data)) return response.data;
    if (response.data && Array.isArray(response.data.items)) return response.data.items;
    if (response.data && Array.isArray(response.data.rows)) return response.data.rows;
    if (Array.isArray(response.items)) return response.items;
    if (Array.isArray(response.rows)) return response.rows;
    if (Array.isArray(response.results)) return response.results;
    return [];
  }

  function scalarText_(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(scalarText_).join(' ');
    if (typeof value === 'object') {
      return Object.keys(value).slice(0, 20).map(function (k) { return scalarText_(value[k]); }).join(' ');
    }
    return String(value);
  }

  function mappingRangeText_(row) {
    return [row && row.range, row && row.ranges, row && row.scope, row && row.scopes]
      .map(scalarText_).join(' ').toLowerCase();
  }

  function mappingIsExportable_(row) {
    const text = mappingRangeText_(row);
    if (!text) return true; // Older response shapes do not always expose range.
    return /(^|[^a-z])(?:export|deprecated_export|root_export)(?:[^a-z]|$)/i.test(text);
  }

  function mappingSearchText_(row) {
    if (!row || typeof row !== 'object') return '';
    return [
      row.slug, row.name, row.label, row.title, row.field, row.key,
      row.description, row.notes, row.identity_type, row.identityType,
      row.data_source, row.dataSource
    ].map(scalarText_).join(' ').toLowerCase();
  }

  function identityMappingScore_(row, kind) {
    const slug = String(row && row.slug || '').trim().toLowerCase();
    if (!slug) return -1;
    const text = mappingSearchText_(row);
    const configuredSlug = String(projectTrackerStudentIdentityMappingSlug_(kind) || '').trim().toLowerCase();
    const configuredLabel = String(projectTrackerStudentIdentityLabel_(kind) || '').trim().toLowerCase();
    let score = mappingIsExportable_(row) ? 20 : -40;

    // A mapping slug explicitly supplied by the adopting institution is the
    // strongest signal and should beat all heuristic matching.
    if (configuredSlug && slug === configuredSlug) score += 400;

    // If the institution supplied a display label, use its meaningful words as
    // a generic fallback when browsing the live mapping catalog.
    if (configuredLabel && configuredLabel !== 'additional id') {
      if (text.indexOf(configuredLabel) >= 0) score += 150;
      const words = configuredLabel.split(/[^a-z0-9]+/).filter(function (w) {
        return w.length >= 3 && w !== 'identifier';
      });
      if (words.length && words.every(function (w) { return text.indexOf(w) >= 0; })) score += 80;
    }

    // Preserve the historic Element mapping names as low-priority compatibility
    // hints when an adopter intentionally enables a legacy slot without a custom
    // mapping slug. These are implementation fallbacks, not required UI labels.
    if (!configuredSlug && kind === 'school') {
      if (slug === String(SLUGS.SCHOOL_ID).toLowerCase()) score += 200;
      if (/school[-_ ]?id/.test(slug) || /school\s*id/.test(text)) score += 90;
      if (/sis[-_ ]?id/.test(slug) || /\bsis\s*id\b/.test(text)) score += 70;
      if (/spark/.test(text)) score -= 120;
    } else if (!configuredSlug && kind === 'spark') {
      if (slug === String(SLUGS.SPARK_ID).toLowerCase()) score += 200;
      if (/spark[-_ ]?id/.test(slug) || /spark\s*id/.test(text)) score += 90;
      if (/school/.test(text) && !/spark/.test(text)) score -= 70;
    }
    return score;
  }

  function liveIdentityMappingCandidates_() {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'e451_identity_mapping_candidates_v6_' + ['spark', 'school'].map(function (kind) {
      const cfg = projectTrackerStudentIdentityConfig_(kind);
      return [cfg.enabled ? '1' : '0', cfg.label, cfg.mappingSlug].join('_').toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 60);
    }).join('__');
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const limit = 50;
    const maxPages = 20;
    const rows = [];
    const seenSlug = {};

    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      const response = request_('/v2/mappings', 'get', null, {
        'embed[scopes]': 1,
        limit: limit,
        offset: offset
      });
      const batch = mappingRowsFromResponse_(response);
      if (!batch.length) break;

      batch.forEach(function (row) {
        const slug = String(row && row.slug || '').trim();
        if (!slug || seenSlug[slug]) return;
        seenSlug[slug] = true;
        rows.push(row);
      });
      if (batch.length < limit) break;
    }

    function candidates(kind, legacySlug) {
      const scored = rows.map(function (row) {
        return {
          slug: String(row && row.slug || '').trim(),
          score: identityMappingScore_(row, kind),
          label: String(row && (row.label || row.name || row.title) || '').trim(),
          range: mappingRangeText_(row)
        };
      }).filter(function (x) { return x.slug && x.score >= 35; })
        .sort(function (a, b) { return b.score - a.score || a.slug.localeCompare(b.slug); })
        .slice(0, 12);

      // Always retain the historic slug as a final compatibility fallback.
      if (!scored.some(function (x) { return x.slug.toLowerCase() === String(legacySlug).toLowerCase(); })) {
        scored.push({ slug: legacySlug, score: 0, label: 'Legacy fallback', range: '' });
      }
      return scored;
    }

    const out = {
      school: candidates('school', identitySlugForKind_('school')),
      spark: candidates('spark', identitySlugForKind_('spark'))
    };
    // Keep the cached payload intentionally small: no full mapping catalog.
    try { cache.put(cacheKey, JSON.stringify(out), 21600); } catch (e) {}
    return out;
  }

  function identityTargetsForSlug_(slug) {
    slug = String(slug || '').trim();
    if (!slug) return [];
    // The Project Tracker historically used the spaced mapping syntax. Keep it
    // first because some Element451 segment compiler paths still behave
    // differently even though both spaced and compact forms are documented.
    return [
      '<mapping: ' + slug + '>',
      '<mapping:' + slug + '>',
      slug
    ];
  }

  function regexEscape_(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function identityValueVariants_(value) {
    const raw = String(value || '').trim();
    const out = [];
    function add(v) {
      v = String(v || '').trim();
      if (v && out.indexOf(v) < 0) out.push(v);
    }
    add(raw);
    // Identity values are usually case-stable, but imported SIS values are not
    // guaranteed to be. Exact variants are safe because a match still must be
    // unique before we return a student.
    add(raw.toUpperCase());
    add(raw.toLowerCase());
    return out;
  }

  function identityFilterStrategies_(target, value) {
    const escaped = regexEscape_(value);
    return [
      { name: 'eq', filter: { type: 'filter', target: target, operator: '$eq', value: value } },
      { name: 'in', filter: { type: 'filter', target: target, operator: '$in', value: [value] } },
      { name: 'regex', filter: { type: 'filter', target: target, operator: 'regex', value: '^' + escaped + '$' } }
    ];
  }

  function identityConfigKeySuffix_(kind) {
    return String(identitySlugForKind_(kind) || 'none').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').substring(0, 48) || 'none';
  }

  function identityCacheKey_(kind, value) {
    return 'e451_identity_' + String(kind || '').toLowerCase() + '_' + identityConfigKeySuffix_(kind) + '_' +
      String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 70);
  }

  function cachedIdentityPerson_(kind, value) {
    const raw = CacheService.getScriptCache().get(identityCacheKey_(kind, value));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.state === 'exact' && parsed.person) return parsed.person;
      if (parsed && parsed.state === 'none') return null;
    } catch (ignore) {}
    return undefined;
  }

  function cacheIdentityPerson_(kind, value, person, ttl) {
    try {
      CacheService.getScriptCache().put(
        identityCacheKey_(kind, value),
        JSON.stringify(person ? { state: 'exact', person: person } : { state: 'none' }),
        Math.max(60, Number(ttl) || 21600)
      );
    } catch (ignore) {}
  }

  function identityRecipeKey_(kind) {
    return 'PT_IDENTITY_RECIPE_' + String(kind || '').toUpperCase() + '_' + identityConfigKeySuffix_(kind).toUpperCase();
  }

  function savedIdentityRecipe_(kind) {
    try {
      const raw = PropertiesService.getScriptProperties().getProperty(identityRecipeKey_(kind));
      return raw ? JSON.parse(raw) : null;
    } catch (ignore) { return null; }
  }

  function saveIdentityRecipe_(kind, recipe) {
    try {
      PropertiesService.getScriptProperties().setProperty(identityRecipeKey_(kind), JSON.stringify(recipe));
    } catch (ignore) {}
  }

  function targetFromRecipe_(slug, form) {
    if (form === 'compact') return '<mapping:' + slug + '>';
    if (form === 'raw') return slug;
    return '<mapping: ' + slug + '>';
  }

  function strategyByName_(target, value, name) {
    const escaped = regexEscape_(value);
    if (name === 'in') return { type: 'filter', target: target, operator: '$in', value: [value] };
    if (name === 'regex') return { type: 'filter', target: target, operator: 'regex', value: '^' + escaped + '$' };
    return { type: 'filter', target: target, operator: '$eq', value: value };
  }

  function tryIdentityRecipe_(recipe, value) {
    if (!recipe || !recipe.slug) return [];
    const target = targetFromRecipe_(recipe.slug, recipe.form || 'spaced');
    return exportUsers_({
      segment: { users: { filters: strategyByName_(target, value, recipe.strategy || 'eq') } },
      per_page: 3
    });
  }

  function resolveIdentityRows_(rows, label) {
    const people = {};
    (rows || []).forEach(function (person) {
      if (person && person.element_id) people[String(person.element_id).toLowerCase()] = person;
    });
    const ids = Object.keys(people);
    if (ids.length > 1) throw new Error('More than one student matched that ' + label + '. Use Search instead.');
    return ids.length === 1 ? people[ids[0]] : null;
  }

  function lookupByIdentityKind_(kind, value, label) {
    const v = String(value || '').trim();
    if (!v) throw new Error((label || 'ID') + ' is required.');

    // Most lookups should be one API request. Cache the exact identity result,
    // and remember whichever filter recipe most recently worked for this tenant.
    const cached = cachedIdentityPerson_(kind, v);
    if (cached !== undefined) {
      if (cached) return cached;
      throw new Error('No student matched that ' + label + '.');
    }

    const values = identityValueVariants_(v);
    const learned = savedIdentityRecipe_(kind);
    if (learned) {
      for (let i = 0; i < values.length; i++) {
        try {
          const person = resolveIdentityRows_(tryIdentityRecipe_(learned, values[i]), label);
          if (person) {
            cacheIdentityPerson_(kind, v, person, ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 21600);
            return person;
          }
        } catch (e) {
          if (/More than one student matched/.test(String(e && e.message || e))) throw e;
          // A stale recipe is harmless; continue to the known-slug fast path.
        }
      }
    }

    // Fast path: the configured identity slugs. This intentionally runs
    // before loading /v2/mappings, because paging through the mapping catalog
    // was the main source of the slow Add Student experience in v8.1.6/8.1.7.
    const legacySlug = identitySlugForKind_(kind);
    const fastRecipes = [
      { slug: legacySlug, form: 'spaced', strategy: 'eq' },
      { slug: legacySlug, form: 'spaced', strategy: 'in' },
      { slug: legacySlug, form: 'spaced', strategy: 'regex' },
      { slug: legacySlug, form: 'compact', strategy: 'eq' }
    ];
    for (let r = 0; r < fastRecipes.length; r++) {
      for (let i = 0; i < values.length; i++) {
        try {
          const person = resolveIdentityRows_(tryIdentityRecipe_(fastRecipes[r], values[i]), label);
          if (person) {
            saveIdentityRecipe_(kind, fastRecipes[r]);
            cacheIdentityPerson_(kind, v, person, ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 21600);
            return person;
          }
        } catch (e) {
          if (/More than one student matched/.test(String(e && e.message || e))) throw e;
        }
      }
    }

    // Compatibility fallback: if the tenant mapping ever changes, consult the
    // live catalog and exhaust the supported target/operator forms. A successful
    // recipe is persisted so the next lookup returns to the fast path.
    const catalog = liveIdentityMappingCandidates_();
    const candidates = (catalog[kind] || []).slice();
    const people = {};
    const attempts = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const targetSpecs = [
        { target: '<mapping: ' + candidate.slug + '>', form: 'spaced' },
        { target: '<mapping:' + candidate.slug + '>', form: 'compact' },
        { target: candidate.slug, form: 'raw' }
      ];
      for (let j = 0; j < targetSpecs.length; j++) {
        const targetSpec = targetSpecs[j];
        for (let k = 0; k < values.length; k++) {
          const testValue = values[k];
          const strategies = identityFilterStrategies_(targetSpec.target, testValue);
          for (let s = 0; s < strategies.length; s++) {
            const strategy = strategies[s];
            try {
              const rows = exportUsers_({
                segment: { users: { filters: strategy.filter } },
                per_page: 3
              });
              attempts.push({ slug: candidate.slug, target: targetSpec.target, strategy: strategy.name, ok: true, matches: rows.length });
              rows.forEach(function (person) {
                if (person && person.element_id) people[String(person.element_id).toLowerCase()] = person;
              });
              const ids = Object.keys(people);
              if (ids.length === 1) {
                const person = people[ids[0]];
                saveIdentityRecipe_(kind, { slug: candidate.slug, form: targetSpec.form, strategy: strategy.name });
                cacheIdentityPerson_(kind, v, person, ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 21600);
                return person;
              }
              if (ids.length > 1) throw new Error('More than one student matched that ' + label + '. Use Search instead.');
            } catch (e) {
              const message = String(e && e.message || e);
              if (/More than one student matched/.test(message)) throw e;
              attempts.push({ slug: candidate.slug, target: targetSpec.target, strategy: strategy.name, ok: false, error: message.substring(0, 180) });
            }
          }
        }
      }
    }

    const candidateNames = candidates.slice(0, 5).map(function (x) { return x.slug; }).join(', ');
    const successfulAttempts = attempts.filter(function (x) { return x.ok; }).length;
    throw new Error(
      'No student matched that ' + label + '. ' +
      (candidateNames ? 'Checked current Element451 identity mappings: ' + candidateNames + '. ' : '') +
      'Tried the fast identity lookup plus current mapping fallbacks' +
      (successfulAttempts ? ' (' + successfulAttempts + ' accepted fallback queries).' : '.') +
      ' If this ID is known to exist, run diagnoseElement451IdentityMappings() and send the execution result.'
    );
  }

  /**
   * Fast bulk identity resolution for Gmail enrichment.
   *
   * Gmail add-on actions have a short execution window. Calling the durable
   * single-ID resolver for every identifier in a long email can exhaust that
   * window because each resolver may try several compatibility filters. Bulk
   * resolution uses one export request for a whole set of identifiers and
   * returns only exact values that Element451 actually reports in the identity
   * column. The slower single-ID resolver remains unchanged for the manual Add
   * Student dialog where a detailed error is preferable to a timeout.
   */
  function identityTemplate_(slug) {
    const base = userTemplate_();
    return {
      columns: base.columns.concat([
        { field: 'Identity Match', mode: 'slug', slug: slug }
      ])
    };
  }

  function flattenScalars_(value, out) {
    out = out || [];
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
      value.forEach(function (v) { flattenScalars_(v, out); });
      return out;
    }
    if (typeof value === 'object') {
      if (value.value !== undefined) return flattenScalars_(value.value, out);
      if (value.label !== undefined) return flattenScalars_(value.label, out);
      if (value._id !== undefined) return flattenScalars_(value._id, out);
      Object.keys(value).slice(0, 20).forEach(function (k) { flattenScalars_(value[k], out); });
      return out;
    }
    const text = String(value).trim();
    if (text) out.push(text);
    return out;
  }

  function batchIdentityExport_(slug, target, strategy, values) {
    const wanted = (values || []).map(function (v) { return String(v || '').trim(); }).filter(Boolean);
    if (!wanted.length) return [];
    let filter;
    if (strategy === 'regex') {
      const parts = [];
      wanted.forEach(function (v) {
        identityValueVariants_(v).forEach(function (x) {
          const escaped = regexEscape_(x);
          if (parts.indexOf(escaped) < 0) parts.push(escaped);
        });
      });
      filter = { type: 'filter', target: target, operator: 'regex', value: '^(?:' + parts.join('|') + ')$' };
    } else {
      const expanded = [];
      wanted.forEach(function (v) {
        identityValueVariants_(v).forEach(function (x) { if (expanded.indexOf(x) < 0) expanded.push(x); });
      });
      filter = { type: 'filter', target: target, operator: '$in', value: expanded };
    }

    const item = {
      template: identityTemplate_(slug),
      options: { column_key: 'slug' },
      segment: { users: { filters: filter } },
      per_page: Math.max(1, Math.min(50, wanted.length * 2))
    };
    const response = request_('/v2/users/export', 'post', { item: item });
    return Array.isArray(response.data) ? response.data : [];
  }

  function exportUsersFetchSpec_(selection) {
    const item = Object.assign({
      template: userTemplate_(),
      options: { column_key: 'slug' },
      per_page: Math.max(1, Math.min(50, Number(selection && selection.per_page) || 10))
    }, selection || {});

    const c = credentials_();
    const params = { feature: c.feature };
    if (c.analytics) params.analytics = c.analytics;
    return {
      url: baseUrl_() + '/v2/users/export' + queryString_(params),
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + c.token,
        Feature: c.feature,
        Accept: 'application/json'
      },
      contentType: 'application/json',
      payload: JSON.stringify({ item: item }),
      muteHttpExceptions: true,
      followRedirects: true
    };
  }

  function peopleFromFetchResponse_(response) {
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) return [];
    let parsed = {};
    try { parsed = JSON.parse(response.getContentText() || '{}'); } catch (ignore) { return []; }
    const rows = Array.isArray(parsed.data) ? parsed.data : [];
    return rows.map(normalizePerson_).filter(function (p) { return !!p.element_id; });
  }

  /**
   * Resolve many identity values with the same filter recipe, in parallel.
   *
   * This deliberately sends one proven exact lookup per literal via fetchAll
   * rather than asking the export endpoint to return the identity column and
   * then trying to map a mixed batch back to the input values. The latter is
   * not reliable for every identity mapping for the configured tenant. fetchAll keeps
   * the requests concurrent, so a list of IDs costs roughly one network round
   * trip instead of one round trip per student.
   */
  function parallelIdentityRound_(values, recipe) {
    const literals = (values || []).map(function (v) { return String(v || '').trim(); }).filter(Boolean);
    if (!literals.length || !recipe || !recipe.slug) return {};
    const target = targetFromRecipe_(recipe.slug, recipe.form || 'spaced');
    const specs = literals.map(function (literal) {
      return exportUsersFetchSpec_({
        segment: { users: { filters: strategyByName_(target, literal, recipe.strategy || 'eq') } },
        per_page: 3
      });
    });
    const responses = UrlFetchApp.fetchAll(specs);
    const out = {};
    responses.forEach(function (response, i) {
      const people = peopleFromFetchResponse_(response);
      const unique = {};
      people.forEach(function (person) {
        const id = String(person.element_id || '').toLowerCase();
        if (id) unique[id] = person;
      });
      const ids = Object.keys(unique);
      if (ids.length === 1) out[literals[i]] = unique[ids[0]];
    });
    return out;
  }

  function lookupManyByIdentityKind_(kind, values) {
    const originals = [], seen = {};
    (values || []).forEach(function (value) {
      const v = String(value || '').trim();
      const key = v.toLowerCase();
      if (v && !seen[key] && originals.length < 40) { seen[key] = true; originals.push(v); }
    });

    const out = {};
    originals.forEach(function (v) {
      const cached = cachedIdentityPerson_(kind, v);
      if (cached) out[v] = cached;
    });

    function unresolved_() {
      return originals.filter(function (v) { return !out[v]; });
    }
    if (!unresolved_().length) return out;

    const legacySlug = identitySlugForKind_(kind);
    const recipes = [];
    function addRecipe(recipe) {
      if (!recipe || !recipe.slug) return;
      const key = [recipe.slug, recipe.form || 'spaced', recipe.strategy || 'eq'].join('|').toLowerCase();
      if (!recipes.some(function (x) { return x._key === key; })) {
        recipes.push(Object.assign({ _key: key }, recipe));
      }
    }

    // The durable manual resolver saves the exact recipe that works for this
    // tenant. Always try that first. The remaining recipes mirror its fast path
    // without ever loading the expensive live mapping catalog from Gmail.
    addRecipe(savedIdentityRecipe_(kind));
    addRecipe({ slug: legacySlug, form: 'spaced', strategy: 'eq' });
    addRecipe({ slug: legacySlug, form: 'spaced', strategy: 'in' });
    addRecipe({ slug: legacySlug, form: 'spaced', strategy: 'regex' });
    addRecipe({ slug: legacySlug, form: 'compact', strategy: 'eq' });

    for (let r = 0; r < recipes.length; r++) {
      const missing = unresolved_();
      if (!missing.length) break;
      let matches = {};
      try { matches = parallelIdentityRound_(missing, recipes[r]); } catch (ignore) { continue; }
      let learned = false;
      Object.keys(matches).forEach(function (literal) {
        const person = matches[literal];
        if (!person || !person.element_id) return;
        out[literal] = person;
        learned = true;
        cacheIdentityPerson_(kind, literal, person, ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 21600);
      });
      if (learned) saveIdentityRecipe_(kind, {
        slug: recipes[r].slug,
        form: recipes[r].form || 'spaced',
        strategy: recipes[r].strategy || 'eq'
      });
    }

    // Do not negative-cache misses here. The manual Add Student flow remains
    // the exhaustive fallback if a tenant-specific identity cannot be resolved
    // by the Gmail fast path.
    return out;
  }

  /**
   * Gmail-safe external-identifier resolver.
   *
   * Manual Add Student can afford exhaustive compatibility fallbacks. Gmail
   * add-on actions cannot. Resolve every plausible configured external identifier in
   * one parallel fetchAll round using the recipe already learned by the manual
   * resolver, falling back to the established spaced/$eq recipe.
   */
  function lookupManyStudentIdentifiers(refs) {
    // Gmail Workspace add-on actions have a 30-second execution cap. Resolve
    // every student identifier in ONE UrlFetchApp.fetchAll() network round:
    // one export per enabled external-ID slot and one direct user export
    // for Element IDs. Identity exports explicitly project the identity column
    // so each returned student can be mapped back to the literal in the email.
    const normalized = [], seen = {};
    (refs || []).forEach(function (ref) {
      const kind = String(ref && ref.kind || '').toLowerCase();
      let literal = String(ref && ref.literal || '').trim();
      if (kind === 'element') literal = literal.toLowerCase();
      if ((kind !== 'spark' && kind !== 'school' && kind !== 'element') || !literal) return;
      if ((kind === 'spark' || kind === 'school') && !projectTrackerStudentIdentityEnabled_(kind)) return;
      if (kind === 'element' && !/^[a-f0-9]{24}$/.test(literal)) return;
      const key = kind + '|' + literal.toLowerCase();
      if (!seen[key] && normalized.length < 80) {
        seen[key] = true;
        normalized.push({ kind: kind, literal: literal });
      }
    });

    const out = { spark: {}, school: {}, element: {} };
    if (!normalized.length) return out;

    const pending = { spark: [], school: [], element: [] };
    normalized.forEach(function (ref) {
      if (ref.kind === 'element') {
        const raw = CacheService.getScriptCache().get('e451_person_' + ref.literal);
        if (raw) {
          try { out.element[ref.literal] = JSON.parse(raw); return; } catch (ignore) {}
        }
        pending.element.push(ref.literal);
        return;
      }
      const cached = cachedIdentityPerson_(ref.kind, ref.literal);
      if (cached) out[ref.kind][ref.literal] = cached;
      else pending[ref.kind].push(ref.literal);
    });

    function recipeFor_(kind) {
      const learned = savedIdentityRecipe_(kind);
      if (learned && learned.slug) return learned;
      return {
        slug: identitySlugForKind_(kind),
        form: 'spaced',
        strategy: 'in'
      };
    }

    function expandedValues_(values) {
      const out = [], used = {};
      (values || []).forEach(function (value) {
        identityValueVariants_(value).forEach(function (variant) {
          const key = String(variant).toLowerCase();
          if (!used[key]) { used[key] = true; out.push(variant); }
        });
      });
      return out;
    }

    const specs = [], meta = [];
    ['school', 'spark'].forEach(function (kind) {
      if (!pending[kind].length) return;
      const recipe = recipeFor_(kind);
      const slug = recipe.slug || identitySlugForKind_(kind);
      const target = targetFromRecipe_(slug, recipe.form || 'spaced');
      specs.push(exportUsersFetchSpec_({
        template: identityTemplate_(slug),
        options: { column_key: 'slug' },
        segment: { users: { filters: {
          type: 'filter',
          target: target,
          operator: '$in',
          value: expandedValues_(pending[kind])
        } } },
        per_page: Math.min(50, Math.max(5, pending[kind].length * 2))
      }));
      meta.push({ kind: kind, slug: slug, literals: pending[kind].slice() });
    });

    if (pending.element.length) {
      specs.push(exportUsersFetchSpec_({
        users: pending.element.slice(0, 50),
        per_page: Math.min(50, pending.element.length)
      }));
      meta.push({ kind: 'element', literals: pending.element.slice() });
    }

    if (!specs.length) return out;

    const responses = UrlFetchApp.fetchAll(specs);
    responses.forEach(function (response, index) {
      const info = meta[index];
      const code = response.getResponseCode();
      if (code < 200 || code >= 300) return;
      let parsed = {};
      try { parsed = JSON.parse(response.getContentText() || '{}'); } catch (ignore) { return; }
      const rows = Array.isArray(parsed.data) ? parsed.data : [];

      if (info.kind === 'element') {
        rows.forEach(function (row) {
          const person = normalizePerson_(row);
          const id = String(person.element_id || '').toLowerCase();
          if (!id) return;
          out.element[id] = person;
          try { CacheService.getScriptCache().put('e451_person_' + id, JSON.stringify(person), ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 600); } catch (ignore) {}
        });
        return;
      }

      // Build a case-insensitive lookup of every requested literal and its
      // accepted value variants. The projected identity column tells us which
      // exact configured external-ID value belongs to each returned person.
      const wanted = {};
      info.literals.forEach(function (literal) {
        identityValueVariants_(literal).forEach(function (variant) {
          wanted[String(variant).trim().toLowerCase()] = literal;
        });
      });

      rows.forEach(function (row) {
        const person = normalizePerson_(row);
        if (!person.element_id) return;
        const identityRaw = row[info.slug] !== undefined ? row[info.slug] : row['Identity Match'];
        const values = flattenScalars_(identityRaw, []);
        let matchedLiteral = '';
        values.some(function (value) {
          const key = String(value || '').trim().toLowerCase();
          if (wanted[key]) { matchedLiteral = wanted[key]; return true; }
          return false;
        });
        // Some tenants wrap a single projected identity value in an unusual
        // response shape. If this export returned exactly one row for exactly
        // one requested literal, the filter itself is sufficient evidence.
        if (!matchedLiteral && rows.length === 1 && info.literals.length === 1) matchedLiteral = info.literals[0];
        if (!matchedLiteral) return;
        out[info.kind][matchedLiteral] = person;
        cacheIdentityPerson_(info.kind, matchedLiteral, person, ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 21600);
      });
    });

    return out;
  }

  function lookupManyByElementIds(values) {
    const ids = [], seen = {};
    (values || []).forEach(function (value) {
      const id = String(value || '').trim().toLowerCase();
      if (/^[a-f0-9]{24}$/.test(id) && !seen[id] && ids.length < 50) { seen[id] = true; ids.push(id); }
    });
    if (!ids.length) return {};
    const out = {};
    const missing = [];
    ids.forEach(function (id) {
      const cache = CacheService.getScriptCache();
      const raw = cache.get('e451_person_' + id);
      if (raw) {
        try { out[id] = JSON.parse(raw); return; } catch (ignore) {}
      }
      missing.push(id);
    });
    if (missing.length) {
      const rows = exportUsers_({ users: missing, per_page: Math.min(50, missing.length) });
      rows.forEach(function (person) {
        const id = String(person.element_id || '').toLowerCase();
        if (!id) return;
        out[id] = person;
        try { CacheService.getScriptCache().put('e451_person_' + id, JSON.stringify(person), ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 600); } catch (ignore) {}
      });
    }
    return out;
  }

  function lookupManyBySparkIds(values) { return lookupManyByIdentityKind_('spark', values); }
  function lookupManyBySchoolIds(values) { return lookupManyByIdentityKind_('school', values); }

  function lookupBySparkId(value) { return lookupByIdentityKind_('spark', value, identityLabelForKind_('spark')); }
  function lookupBySchoolId(value) { return lookupByIdentityKind_('school', value, identityLabelForKind_('school')); }

  function diagnoseIdentityMappings() {
    const catalog = liveIdentityMappingCandidates_();
    return {
      client: String(ELEMENT451_CONFIG.CLIENT || ''),
      additional_identifiers: {
        spark: { enabled: projectTrackerStudentIdentityEnabled_('spark'), label: identityLabelForKind_('spark'), candidates: catalog.spark || [] },
        school: { enabled: projectTrackerStudentIdentityEnabled_('school'), label: identityLabelForKind_('school'), candidates: catalog.school || [] }
      },
      note: 'Candidates come from the live /v2/mappings catalog. Internal slot keys are implementation details; no credentials or student records are included.'
    };
  }


  function normalizedPersonName_(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Resolve several exact-name searches concurrently for Gmail enrichment. */
  function searchStudentsManyExact(queries) {
    const names = [], seen = {};
    (queries || []).forEach(function (query) {
      const q = String(query || '').trim();
      const key = normalizedPersonName_(q);
      if (q.length >= 2 && key && !seen[key] && names.length < 10) { seen[key] = true; names.push(q); }
    });
    if (!names.length) return {};

    const filter = {
      type: 'filter',
      target: '<mapping: ' + SLUGS.PROFILE_TYPE + '>',
      operator: '$eq',
      value: 'student'
    };
    const specs = names.map(function (q) {
      return exportUsersFetchSpec_({
        segment: { users: { filters: filter } },
        search: q,
        per_page: Math.max(1, Math.min(50, Number(ELEMENT451_CONFIG.SEARCH_LIMIT) || 10))
      });
    });
    const responses = UrlFetchApp.fetchAll(specs);
    const out = {};
    responses.forEach(function (response, i) {
      const wanted = normalizedPersonName_(names[i]);
      const exact = peopleFromFetchResponse_(response).filter(function (person) {
        return normalizedPersonName_(person.name) === wanted;
      });
      const unique = {};
      exact.forEach(function (person) {
        const id = String(person.element_id || '').toLowerCase();
        if (id) unique[id] = person;
      });
      const ids = Object.keys(unique);
      if (ids.length === 1) out[names[i]] = unique[ids[0]];
    });
    return out;
  }

  function searchStudents(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    return exportUsers_({
      segment: {
        users: {
          filters: {
            type: 'filter',
            target: '<mapping: ' + SLUGS.PROFILE_TYPE + '>',
            operator: '$eq',
            value: 'student'
          }
        }
      },
      search: q,
      per_page: Math.max(1, Math.min(50, Number(ELEMENT451_CONFIG.SEARCH_LIMIT) || 10))
    });
  }

  function extractElementIdFromUrl(value) {
    const id = element451ExtractPersonId_(value);
    if (!id) throw new Error('Paste an Element451 person URL for the configured tenant ending in the student Element ID.');
    return id;
  }

  function lookupSegment(segmentGuid) {
    const guid = String(segmentGuid || '').trim();
    if (!element451ResourceIdRegex_('segments').test(guid)) throw new Error('Invalid Element451 segment ID.');
    const response = request_('/v2/data/segments/' + encodeURIComponent(guid), 'get');
    const item = response.data || response.item || response;
    const name = String(item && (item.name || item.label || item.title) || '').trim();
    return {
      id: guid,
      name: name || guid,
      raw_type: 'segment',
      unresolved: !name
    };
  }

  /**
   * Resolves either a workflow or rule GUID to its Element451 display name.
   *
   * The supplied production example uses the same /v2/workflows/{guid} route
   * for both workflows and rules and reads response.data.name. It also supplies
   * token, feature, analytics, and embed[all]= in the query while authenticating
   * with the Bearer header. For security, the resolver first tries Bearer authentication without the token
   * in the URL and falls back to the supplied token-query form only if needed.
   */
  function lookupAutomation(kind, guid) {
    kind = kind === 'rule' ? 'rule' : 'workflow';
    guid = String(guid || '').trim();
    if (!element451ResourceIdRegex_('workflow').test(guid)) throw new Error('Invalid Element451 workflow/rule ID.');

    const cache = CacheService.getScriptCache();
    const key = 'e451_automation_' + guid.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const path = '/v2/workflows/' + encodeURIComponent(guid);
    let response;
    try {
      // Prefer the safer Bearer-only request first. The supplied example also
      // carries the token in the query string, but that exposes a credential to
      // URL-level server logs. Only fall back to that form if this endpoint
      // rejects the Bearer-only version for the configured tenant.
      response = request_(path, 'get', null, { 'embed[all]': '' });
    } catch (bearerOnlyError) {
      response = request_(
        path,
        'get',
        null,
        { 'embed[all]': '' },
        { includeTokenQuery: true }
      );
    }
    const item = response && response.data ? response.data : (response && response.item ? response.item : response);
    const name = String(item && item.name || '').trim();
    const out = {
      id: guid,
      name: name || guid,
      raw_type: kind,
      unresolved: !name
    };

    cache.put(key, JSON.stringify(out), ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 600);
    return out;
  }


  function valueAtPath_(obj, path) {
    const parts = String(path || '').split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return '';
      cur = cur[parts[i]];
    }
    if (cur === null || cur === undefined) return '';
    if (typeof cur === 'string' || typeof cur === 'number') return String(cur).trim();
    return '';
  }

  function candidateRoots_(response) {
    const roots = [], seen = [];
    const wrapperKeys = ['data', 'item', 'result', 'payload', 'form', 'event', 'communication', 'campaign', 'task', 'settings', 'properties'];

    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 6) return;
      if (seen.indexOf(value) !== -1) return;
      seen.push(value);
      roots.push(value);

      if (Array.isArray(value)) {
        value.slice(0, 5).forEach(function (item) { visit(item, depth + 1); });
        return;
      }

      wrapperKeys.forEach(function (key) {
        if (value[key] !== undefined) visit(value[key], depth + 1);
      });
    }

    visit(response, 0);
    return roots;
  }

  function namedResponse_(response, guid, kind, paths) {
    // Element endpoints are not fully consistent about whether the resource is
    // returned as data, data.item, data.data, item, form, event, communication,
    // etc. Walk only resource-like wrapper keys so we do not accidentally use a
    // nested form-field name as the display name.
    const roots = candidateRoots_(response);
    const candidates = (paths || []).concat([
      'display_name', 'displayName', 'name', 'title', 'label',
      'settings.title', 'settings.name', 'properties.name', 'properties.title'
    ]);
    let name = '';

    roots.some(function (root) {
      if (Array.isArray(root)) root = root[0] || {};
      return candidates.some(function (path) {
        const value = valueAtPath_(root, path);
        if (value && value.toLowerCase() !== String(guid).toLowerCase()) {
          name = value;
          return true;
        }
        return false;
      });
    });

    return { id: guid, name: name || guid, raw_type: kind, unresolved: !name };
  }

  function cachedNamedLookup_(cachePrefix, guid, loader) {
    const cache = CacheService.getScriptCache();
    const key = cachePrefix + String(guid || '').toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
    const out = loader();
    // Do not keep a GUID fallback cached for ten minutes. A temporary response
    // shape/permission issue should be retried on the next ticket open.
    if (out && !out.unresolved) {
      cache.put(key, JSON.stringify(out), ELEMENT451_CONFIG.LOOKUP_CACHE_SECONDS || 600);
    }
    return out;
  }

  function lookupForm(formGuid) {
    const guid = String(formGuid || '').trim();
    if (!element451ResourceIdRegex_('forms').test(guid)) throw new Error('Invalid Element451 form ID.');

    return cachedNamedLookup_('e451_form_v4_', guid, function () {
      let response;
      try {
        // The public Form GET is documented/supplied with Feature + Analytics
        // and no bearer key. Try that request shape first.
        response = publicGet_('/v2/forms/public/' + encodeURIComponent(guid));
      } catch (publicError) {
        // Preserve support for any tenant where the form is not public.
        response = request_('/v2/forms/public/' + encodeURIComponent(guid), 'get');
      }

      const name = String(
        response && response.data && response.data.name || ''
      ).trim();

      return {
        id: guid,
        name: name || guid,
        raw_type: 'form',
        unresolved: !name
      };
    });
  }

  function lookupCampaign(campaignGuid) {
    const guid = String(campaignGuid || '').trim();
    if (!element451ResourceIdRegex_('communications').test(guid)) throw new Error('Invalid Element451 campaign ID.');
    return cachedNamedLookup_('e451_campaign_v2_', guid, function () {
      const response = request_('/v2/campaigns/communications/' + encodeURIComponent(guid), 'get');
      return namedResponse_(response, guid, 'campaign', ['settings.title', 'title', 'name', 'communication.settings.title', 'communication.title', 'item.settings.title', 'item.title', 'item.name', 'data.settings.title', 'data.item.settings.title']);
    });
  }

  function lookupEvent(eventGuid) {
    const guid = String(eventGuid || '').trim();
    if (!element451ResourceIdRegex_('events').test(guid)) throw new Error('Invalid Element451 event ID.');

    return cachedNamedLookup_('e451_event_v4_', guid, function () {
      let response;
      try {
        // The Event detail/list route can return public events without auth.
        // Try the supplied Feature + Analytics request shape first.
        response = publicGet_('/v2/events/list/' + encodeURIComponent(guid));
      } catch (publicError) {
        // Fall back to authenticated access for non-public events.
        response = request_('/v2/events/list/' + encodeURIComponent(guid), 'get');
      }

      const name = String(
        response && response.data && response.data.content &&
        response.data.content.title || ''
      ).trim();

      return {
        id: guid,
        name: name || guid,
        raw_type: 'event',
        unresolved: !name
      };
    });
  }

  /**
   * Resolves an Import or Export task GUID to its Element451 display name.
   *
   * The verified request shape used by the source project uses the same task-detail endpoint for
   * both imports and exports:
   *   GET /v2/importExport/tasks/{task_guid}
   * and reads response.data.name.
   *
   * request_ keeps the API key in the Authorization header. Feature and
   * Analytics are added from the server-side credential sheet; the API key is
   * never added to this URL or returned to the browser.
   */
  function lookupImportExportTask(kind, taskGuid) {
    const guid = String(taskGuid || '').trim();
    if (!element451ResourceIdRegex_('task').test(guid)) throw new Error('Invalid Element451 import/export task ID.');
    const rawType = kind === 'export' ? 'export' : 'import';
    return cachedNamedLookup_('e451_import_export_task_v2_', guid, function () {
      const response = request_('/v2/importExport/tasks/' + encodeURIComponent(guid), 'get');
      return namedResponse_(response, guid, rawType, ['name', 'title', 'item.name', 'task.name', 'data.name', 'data.item.name']);
    });
  }

  function safeNameShape_(response) {
    const rows = [];
    const seen = [];
    const interesting = ['guid','_id','id','form_guid','event_guid','name','title','label','display_name','displayName'];

    function walk(value, path, depth) {
      if (!value || typeof value !== 'object' || depth > 6) return;
      if (seen.indexOf(value) !== -1) return;
      seen.push(value);

      if (Array.isArray(value)) {
        value.slice(0, 5).forEach(function (item, i) { walk(item, path + '[' + i + ']', depth + 1); });
        return;
      }

      const keys = Object.keys(value);
      const fields = {};
      interesting.forEach(function (key) {
        const v = value[key];
        if (typeof v === 'string' || typeof v === 'number') fields[key] = String(v).substring(0, 200);
      });
      if (path === '$' || Object.keys(fields).length) {
        rows.push({ path: path, keys: keys.slice(0, 60), fields: fields });
      }

      keys.slice(0, 60).forEach(function (key) {
        const child = value[key];
        if (child && typeof child === 'object') walk(child, path + '.' + key, depth + 1);
      });
    }

    walk(response, '$', 0);
    return rows.slice(0, 100);
  }

  function diagnoseNameShape(kind, guid) {
    kind = String(kind || '').toLowerCase();
    guid = String(guid || '').trim();
    let path = '';
    if (kind === 'form') path = '/v2/forms/public/' + encodeURIComponent(guid);
    else if (kind === 'event') path = '/v2/events/list/' + encodeURIComponent(guid);
    else throw new Error('Diagnostic supports only form or event.');

    const response = request_(path, 'get');
    return { kind: kind, guid: guid, endpoint: path, shape: safeNameShape_(response) };
  }

  function testConnection() {
    request_('/v2/mappings', 'get', null, { limit: 1, offset: 0 });
    return { ok: true, client: ELEMENT451_CONFIG.CLIENT, api: ELEMENT451_CONFIG.API };
  }

  return {
    lookupByElementId: lookupByElementId,
    lookupBySparkId: lookupBySparkId,
    lookupBySchoolId: lookupBySchoolId,
    lookupManyByElementIds: lookupManyByElementIds,
    lookupManyBySparkIds: lookupManyBySparkIds,
    lookupManyBySchoolIds: lookupManyBySchoolIds,
    lookupManyStudentIdentifiers: lookupManyStudentIdentifiers,
    searchStudentsManyExact: searchStudentsManyExact,
    diagnoseIdentityMappings: diagnoseIdentityMappings,
    searchStudents: searchStudents,
    extractElementIdFromUrl: extractElementIdFromUrl,
    profileUrl: profileUrl_,
    lookupSegment: lookupSegment,
    lookupAutomation: lookupAutomation,
    lookupForm: lookupForm,
    lookupCampaign: lookupCampaign,
    lookupEvent: lookupEvent,
    lookupImportExportTask: lookupImportExportTask,
    diagnoseNameShape: diagnoseNameShape,
    testConnection: testConnection
  };
})();

function testElement451Connection() {
  return Element451.testConnection();
}

function diagnoseElement451IdentityMappings() {
  const out = Element451.diagnoseIdentityMappings();
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}


function diagnoseFormEventResourceNames() {
  const out = [
    Element451.diagnoseNameShape('form', 'YOUR_ELEMENT451_CLIENT.forms.12345'),
    Element451.diagnoseNameShape('event', 'YOUR_ELEMENT451_CLIENT.events.12345')
  ];
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
