const webInput = document.getElementById('webAppUrl');
const apiInput = document.getElementById('apiDeploymentId');
const status = document.getElementById('status');
const oauthState = document.getElementById('oauthState');
document.getElementById('extensionId').textContent = PTApi.extensionId();

(async () => {
  const s = await PTApi.settings();
  webInput.value = s.webAppUrl || '';
  apiInput.value = s.apiDeploymentId || '';
  oauthState.textContent = PTApi.oauthConfigured()
    ? 'OAuth client is configured in manifest.json.'
    : 'OAuth client is not configured yet. Complete the steps below.';
})();

async function save() {
  const webAppUrl = PTApi.normalizeUrl(webInput.value);
  let apiDeploymentId = String(apiInput.value || '').trim();
  const apiMatch = apiDeploymentId.match(/\/scripts\/([^/:?]+)(?::run)?/i);
  if (apiMatch) apiDeploymentId = apiMatch[1];
  apiInput.value = apiDeploymentId;
  if (!/^https:\/\/script\.google\.com\//i.test(webAppUrl) || !/\/exec$/i.test(webAppUrl)) {
    status.textContent = 'Paste the Ticket System 7.1 /exec web app URL.';
    return false;
  }
  if (!apiDeploymentId || apiDeploymentId.length < 20) {
    status.textContent = 'Paste the API executable deployment ID.';
    return false;
  }
  await chrome.storage.sync.set({ webAppUrl, apiDeploymentId });
  status.textContent = 'Saved.';
  return true;
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', async () => {
  if (!await save()) return;
  status.textContent = 'Connecting…';
  try {
    const out = await PTApi.connect();
    status.textContent = `Connected as ${out && out.me ? out.me : 'Project Tracker user'}.`;
  } catch (e) {
    status.textContent = e.message || String(e);
  }
});
