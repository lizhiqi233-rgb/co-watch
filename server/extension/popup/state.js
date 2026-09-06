const el = (id) => document.getElementById(id);

let toastTimer = null;

function getTabTitle(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      const title = (tab.title || '').trim();
      const url = (tab.url || '').trim();
      resolve(title || url || null);
    });
  });
}

function setErrorBanner(text) {
  const box = el('statusError');
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = text;
}

function showToast(msg) {
  const t = el('statusToast');
  if (!msg) {
    t.hidden = true;
    t.textContent = '';
    clearTimeout(toastTimer);
    return;
  }
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    t.textContent = '';
  }, 3200);
}

function send(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, resolve);
  });
}

/**
 * Keep wss:// visible so refreshing the popup does not downgrade it to ws://.
 */
function formatServerUrlForDisplay(stored) {
  const s = String(stored || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      return s;
    }
    const host = u.hostname;
    const port = u.port;
    const suffix = (u.pathname && u.pathname !== '/' ? u.pathname : '') + u.search;
    if (u.protocol === 'wss:') {
      return `wss://${u.host}${suffix}`;
    }
    if (suffix) {
      return `ws://${u.host}${suffix}`;
    }
    if (!port || port === '15777') {
      return host;
    }
    return host + ':' + port;
  } catch {
    return s;
  }
}
