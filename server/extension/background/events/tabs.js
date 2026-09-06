chrome.tabs.onRemoved.addListener((tabId) => {
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    if (data[STORAGE_KEYS.followedTabId] !== tabId) return;
    // 关闭跟随标签：不断开房间，仅解除已失效的标签绑定（避免指向已关闭标签 id）
    setStorage({ [STORAGE_KEYS.followedTabId]: null }).then(() => {
      broadcastState({ lastError: null }, { followedTabId: null });
    });
  });
});

/**
 * 房主在跟随标签内前进/后退/点链或 SPA 换址时，实时向房间广播 navigate，便于成员同一套 URL 链路上自动连播对齐。
 * 与弹窗/右键发出的 navigate 共用 lastHostFollowBroadcastKey 去重。
 */
function scheduleHostFollowTabNavigateBroadcast(tab) {
  if (!tab || tab.id == null || tab.url == null) return;
  const url = String(tab.url).trim();
  if (!isAllowedHttpUrl(url)) return;

  if (hostFollowTabNavDebounceTimer != null) {
    clearTimeout(hostFollowTabNavDebounceTimer);
    hostFollowTabNavDebounceTimer = null;
  }
  const scheduledTabId = tab.id;
  hostFollowTabNavDebounceTimer = setTimeout(() => {
    hostFollowTabNavDebounceTimer = null;
    chrome.tabs.get(scheduledTabId, (t) => {
      if (chrome.runtime.lastError || !t || !t.url) return;
      const urlNow = String(t.url).trim();
      if (!isAllowedHttpUrl(urlNow)) return;

      getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
        if (data[STORAGE_KEYS.followedTabId] !== scheduledTabId) return;
        if (resolveEffectiveRole(data[STORAGE_KEYS.role]) !== 'host') return;
        if (!isSocketConnected() || !currentRoomId) return;

        const key = normalizeUrlKeyForCoWatch(urlNow);
        if (key === lastHostFollowBroadcastKey) return;

        dbg('followTab url change → navigate', urlNow.slice(0, 160));
        const ok = sendNavigateReliable(urlNow, t.title || '');
        if (ok) {
          rememberPlaylistTitle(normalizeUrlKeyForCoWatch(urlNow), (t.title || '').trim());
        }
      });
    });
  }, HOST_FOLLOW_TAB_NAV_DEBOUNCE_MS);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    currentRoomId &&
    (changeInfo.title != null || changeInfo.url != null)
  ) {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      if (data[STORAGE_KEYS.followedTabId] === tabId) {
        pendingJumpRoundReset = true;
      }
    });
  }
  if (changeInfo.title != null && currentRoomId) {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      if (data[STORAGE_KEYS.followedTabId] === tabId) {
        broadcastState();
        maybeSendPlaylistTitleRefreshFromFollowedTab(tabId);
      }
    });
  }
  if (!tab || tab.url == null) return;
  if (!isAllowedHttpUrl(String(tab.url).trim())) return;
  // SPA / History API：仅有 changeInfo.url；普通整页导航：多为 status complete
  if (changeInfo.url) {
    scheduleHostFollowTabNavigateBroadcast(tab);
    return;
  }
  if (changeInfo.status === 'complete') {
    scheduleHostFollowTabNavigateBroadcast(tab);
  }
});
