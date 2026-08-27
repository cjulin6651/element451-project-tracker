/**
 * Project Tracker — Element451 integration configuration
 *
 * REQUIRED: customize this file before deployment.
 * Never put API keys or tokens in source control. Credentials are read server-side
 * from the Google Sheet configured below.
 *
 * Credential sheet default layout (Sheet1):
 *   B1 = Element451 API key / bearer key
 *   B2 = unused
 *   B3 = Element451 Feature token
 *   B4 = Element451 Analytics token (optional on most endpoints)
 */
const ELEMENT451_CONFIG = Object.freeze({
  CREDENTIALS_SPREADSHEET_ID: 'PASTE_GOOGLE_SHEET_ID_HERE',
  CREDENTIALS_SHEET_NAME: 'Sheet1',
  CREDENTIAL_RANGE: 'B1:B4',

  // Usually the tenant/client subdomain from https://CLIENT.element451.io/.
  CLIENT: 'YOUR_ELEMENT451_CLIENT',
  API: 'api.451.io',
  // Usually the same as CLIENT. Override only if your Element resource IDs use a different prefix.
  RESOURCE_ID_PREFIX: 'YOUR_ELEMENT451_CLIENT',

  SEARCH_LIMIT: 10,
  LOOKUP_CACHE_SECONDS: 600,
  CREDENTIAL_CACHE_SECONDS: 300,
  NOTE_SCAN_MAX_URLS: 30
});

function element451RegexEscape_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function element451Client_() {
  return String(ELEMENT451_CONFIG.CLIENT || '').trim();
}

function element451WebHost_() {
  const client = element451Client_();
  return client ? client + '.element451.io' : '';
}

function element451WebBaseUrl_() {
  const host = element451WebHost_();
  return host ? 'https://' + host : '';
}

function element451ProfileUrl_(elementId) {
  return element451WebBaseUrl_() + '/v2/people/' + encodeURIComponent(String(elementId || ''));
}

function element451ExtractPersonId_(value) {
  const host = element451WebHost_();
  if (!host) return '';
  const re = new RegExp('^https?://' + element451RegexEscape_(host) + '/v2/people/([a-f0-9]{24})(?:[/?#]|$)', 'i');
  const m = String(value || '').trim().match(re);
  return m ? String(m[1] || '').toLowerCase() : '';
}

function element451ResourceIdRegex_(family) {
  const prefix = String(ELEMENT451_CONFIG.RESOURCE_ID_PREFIX || ELEMENT451_CONFIG.CLIENT || '').trim();
  if (!prefix) return /$a/;
  return new RegExp('^' + element451RegexEscape_(prefix) + '\\.' + element451RegexEscape_(family) + '\\.\\d+$', 'i');
}

function element451ParseResourceUrl_(value) {
  const host = element451WebHost_();
  if (!host) return null;
  const v = String(value || '').trim();
  const h = element451RegexEscape_(host);
  const prefix = element451RegexEscape_(String(ELEMENT451_CONFIG.RESOURCE_ID_PREFIX || ELEMENT451_CONFIG.CLIENT || '').trim());
  if (!prefix) return null;
  const patterns = [
    ['rule', new RegExp('^https?://' + h + '/v2/workflows/rules/(' + prefix + '\\.workflow\\.\\d+)(?:[/?#]|$)', 'i')],
    ['workflow', new RegExp('^https?://' + h + '/v2/workflows/(' + prefix + '\\.workflow\\.\\d+)(?:[/?#]|$)', 'i')],
    ['segment', new RegExp('^https?://' + h + '/v2/people\\?[^#]*\\bsegment=(' + prefix + '\\.segments\\.\\d+)', 'i')],
    ['form', new RegExp('^https?://' + h + '/v2/forms/(' + prefix + '\\.forms\\.\\d+)(?:[/?#]|$)', 'i')],
    ['campaign', new RegExp('^https?://' + h + '/v2/campaigns/communications/(' + prefix + '\\.communications\\.\\d+)(?:[/?#]|$)', 'i')],
    ['import', new RegExp('^https?://' + h + '/v2/import-export/imports\\?[^#]*\\btask=(' + prefix + '\\.task\\.\\d+)', 'i')],
    ['export', new RegExp('^https?://' + h + '/v2/import-export/exports\\?[^#]*\\btask=(' + prefix + '\\.task\\.\\d+)', 'i')],
    ['event', new RegExp('^https?://' + h + '/v2/events/(' + prefix + '\\.events\\.\\d+)(?:[/?#]|$)', 'i')]
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = v.match(patterns[i][1]);
    if (m) return { type: patterns[i][0], external_id: m[1] };
  }
  return null;
}
