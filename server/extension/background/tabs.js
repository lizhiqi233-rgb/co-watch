/**
 * changeInfo.url 常先于 document.title（B 站合集、YouTube、多数 SPA）；title 更新后补发 skip navigate，仅更新列表项标题、不重复插入。
 */
function maybeSendPlaylistTitleRefreshFromFollowedTab(tabId) {
  chrome.tabs.get(tabId, (t) => {
    if (chrome.runtime.lastError || !t || !t.url) return;
    const url = String(t.url).trim();
    if (!isAllowedHttpUrl(url)) return;
    const title = (t.title || '').trim();
    if (!title) return;
    getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
      if (data[STORAGE_KEYS.followedTabId] !== tabId) return;
      if (resolveEffectiveRole(data[STORAGE_KEYS.role]) !== 'host') return;
      if (!isSocketConnected() || !currentRoomId) return;
      const key = normalizeUrlKeyForCoWatch(url);
      // 须在本机已对该 URL 发过跟标签 navigate 之后，避免 title 早于 URL 插入抢跑把 skip 当成「未入库」
      if (key !== lastHostFollowBroadcastKey) return;
      if (!rememberPlaylistTitle(key, title)) return;
      sendNavigateReliable(url, title.slice(0, 300), { skipPlaylistInsert: true });
    });
  });
}
function updateFollowedTabUrl(tabId, url, onFail) {
  chrome.tabs.update(tabId, { url }, () => {
    if (chrome.runtime.lastError) onFail();
  });
}

/**
 * 跟随标签打开目标 URL。
 * @param {{ broadcastNavigate?: boolean }} [opts] broadcastNavigate: server-wide navigate broadcast; normalized same-URL navigation does not reload, preventing member-page churn from duplicate broadcasts or reliable retries.
 */
function openFollowedTabAtUrl(tabId, url, opts) {
  if (!isAllowedHttpUrl(url) || typeof tabId !== 'number') return;
  const urlKey = normalizeUrlKeyForCoWatch(url);
  const broadcast = !!(opts && opts.broadcastNavigate);
  dbg('openFollowedTabAtUrl', { tabId, broadcast, url: url.slice(0, 160) });
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      setStorage({ [STORAGE_KEYS.followedTabId]: null });
      return;
    }
    const onFail = () => {
      setStorage({ [STORAGE_KEYS.followedTabId]: null });
    };
    const tabKey = tab.url ? normalizeUrlKeyForCoWatch(tab.url) : '';
    const sameKey = !!(tab.url && tabKey === urlKey);

    if (broadcast) {
      if (sameKey) {
        dbg('skip same followed tab URL', { tabId, url: url.slice(0, 160) });
        return;
      }
      updateFollowedTabUrl(tabId, url, onFail);
      return;
    }

    if (!sameKey) {
      updateFollowedTabUrl(tabId, url, onFail);
    }
  });
}

/**
 * @param {string} wsUrlStr
 */
function wsUrlToHttpOrigin(wsUrlStr) {
  try {
    const u = new URL(wsUrlStr);
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch {
    return '';
  }
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function setStorage(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}
