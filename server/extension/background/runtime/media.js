chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action } = request || {};

  if (action === 'forwardVideoSync') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId == null || !currentRoomId) {
      sendResponse({ ok: false });
      return false;
    }
    getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
      if (data[STORAGE_KEYS.followedTabId] !== tabId) {
        sendResponse({ ok: false });
        return;
      }
      const p = request.payload || {};
      if (resolveEffectiveRole(data[STORAGE_KEYS.role]) !== 'host') {
        sendResponse({ ok: false });
        return;
      }
      const syncPayload = {
        type: 'video_sync',
        action: p.action,
        currentTime: p.currentTime,
        playbackRate: p.playbackRate,
      };
      if (typeof p.playing === 'boolean') {
        syncPayload.playing = p.playing;
      }
      const ok = sendRaw(syncPayload);
      sendResponse({ ok: !!ok });
    });
    return true;
  }

  if (action === 'playlistAdd') {
    const url = String(request.url || '').trim();
    const closeAfter = !!request.closeTabAfter;
    const senderTabId = _sender.tab && _sender.tab.id;
    if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: '未在房间中' });
      return false;
    }
    if (!isAllowedHttpUrl(url)) {
      sendResponse({ ok: false, error: '仅支持 http(s) 网址' });
      return false;
    }
    if (closeAfter && typeof senderTabId === 'number') {
      tabToCloseAfterPlaylistAddAck = senderTabId;
    }
    const title = normalizePlaylistTitle(request.title != null ? String(request.title) : '');
    const ok = sendRaw({ type: 'playlist_add', url, title });
    if (!ok) {
      if (tabToCloseAfterPlaylistAddAck === senderTabId) {
        tabToCloseAfterPlaylistAddAck = null;
      }
      sendResponse({ ok: false, error: '未连接到房间服务' });
      return false;
    }
    sendResponse({ ok: true });
    return false;
  }

  /** 侧栏「全员跳转」：与右键「发送到协同浏览」同逻辑，任意已连接房间的标签页可点 */

  if (action === 'sendToCoWatchFromFollowedStrip') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: '未在房间中' });
      return false;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ ok: false });
        return;
      }
      const url = getTabUrl(tab);
      const allowUrl = !!(url && isAllowedHttpUrl(url));
      getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
        const oldFollowId = data[STORAGE_KEYS.followedTabId];
        if (oldFollowId == null) {
          contextMenuReconnectAndEnterRoom(tabId);
          sendResponse({ ok: true });
          return;
        }
        if (!allowUrl) {
          broadcastState({ lastError: '仅支持 http/https 页面' });
          sendResponse({ ok: false, error: '仅支持 http/https 页面' });
          return;
        }
        runSendToCoWatchSameAsContextMenu(tabId, sendResponse);
      });
    });
    return true;
  }

  return false;
});
