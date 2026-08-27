const PTApi = (() => {
  const OAUTH_PLACEHOLDER = 'REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com';

  async function settings() {
    return chrome.storage.sync.get({
      webAppUrl: '',
      apiDeploymentId: ''
    });
  }

  function normalizeUrl(url) {
    return String(url || '').trim().replace(/[?#].*$/, '');
  }

  function oauthConfigured() {
    const oauth = chrome.runtime.getManifest().oauth2 || {};
    return !!oauth.client_id && oauth.client_id !== OAUTH_PLACEHOLDER && !/^REPLACE_WITH_/i.test(oauth.client_id);
  }

  function extensionId() {
    return chrome.runtime.id;
  }

  async function token(interactive = false) {
    if (!oauthConfigured()) {
      throw new Error('OAuth setup is not finished. Open Settings and complete the one-time Google connection setup.');
    }
    const result = await chrome.identity.getAuthToken({ interactive });
    const value = typeof result === 'string' ? result : result && result.token;
    if (!value) throw new Error('Google did not return an authorization token.');
    return value;
  }

  async function clearToken(value) {
    if (!value) return;
    try { await chrome.identity.removeCachedAuthToken({ token: value }); } catch (e) {}
  }

  function executionErrorMessage(data, fallback) {
    if (!data) return fallback || 'Project Tracker did not respond.';
    if (data.error) {
      const details = Array.isArray(data.error.details) ? data.error.details : [];
      const execution = details.find(x => x && (x.errorMessage || x.scriptStackTraceElements));
      return (execution && execution.errorMessage) || data.error.message || fallback || 'Project Tracker execution failed.';
    }
    return fallback || 'Project Tracker execution failed.';
  }

  async function run(action, payload = {}, interactive = false, allowRetry = true) {
    const s = await settings();
    const deployment = String(s.apiDeploymentId || '').trim();
    if (!deployment) throw new Error('Project Tracker API is not configured. Open Settings and paste the API executable deployment ID.');
    let authToken = await token(interactive);
    const response = await fetch(`https://script.googleapis.com/v1/scripts/${encodeURIComponent(deployment)}:run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        function: 'extensionApiRun',
        parameters: [String(action || ''), payload || {}],
        devMode: false
      })
    });

    let data = null;
    try { data = await response.json(); } catch (e) {}

    if ((response.status === 401 || response.status === 403) && allowRetry) {
      await clearToken(authToken);
      if (!interactive) throw new Error('Project Tracker needs Google authorization. Click Connect and approve access once.');
      authToken = await token(true);
      return run(action, payload, true, false);
    }
    if (!response.ok) {
      const msg = executionErrorMessage(data, `Google returned HTTP ${response.status}.`);
      if (/same cloud|permission_denied|caller does not have permission/i.test(msg)) {
        throw new Error('The extension OAuth client and Project Tracker API executable must use the same Google Cloud project. Check Settings setup instructions.');
      }
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(executionErrorMessage(data));
    const result = data && data.response ? data.response.result : null;
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function connect() {
    const t = await token(true);
    try {
      return await run('bootstrap', {}, true, false);
    } catch (e) {
      await clearToken(t);
      throw e;
    }
  }

  async function disconnect() {
    try {
      const t = await token(false);
      await clearToken(t);
      try { await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(t)}`); } catch (e) {}
    } catch (e) {}
  }

  return {
    bootstrap: () => run('bootstrap'),
    search: q => run('search', { q }),
    capture: payload => run('capture', payload),
    create: payload => run('create', payload),
    connect,
    disconnect,
    settings,
    normalizeUrl,
    oauthConfigured,
    extensionId
  };
})();
