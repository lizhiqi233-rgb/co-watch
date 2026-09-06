chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action } = request || {};

  if (action === 'playlistRemove') {
    const id = String(request.id || '').trim();
    if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: '未在房间中' });
      return false;
    }
    if (!id) {
      sendResponse({ ok: false, error: '无效项' });
      return false;
    }
    const ok = sendRaw({ type: 'playlist_remove', id });
    sendResponse({ ok: !!ok });
    return false;
  }

  if (action === 'playlistSelect') {
    const id = String(request.id || '').trim();
    if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: '未在房间中' });
      return false;
    }
    if (!id) {
      sendResponse({ ok: false, error: '无效项' });
      return false;
    }
    getStorage([STORAGE_KEYS.role]).then((data) => {
      if (resolveEffectiveRole(data[STORAGE_KEYS.role]) !== 'host') {
        sendResponse({ ok: false, error: '仅房主可选定播放' });
        return;
      }
      const ok = sendRaw({ type: 'playlist_select', id });
      sendResponse({ ok: !!ok });
    });
    return true;
  }

  if (action === 'navigate') {
    const url = String(request.url || '').trim();
    if (!isAllowedHttpUrl(url)) {
      sendResponse({ ok: false, error: '请输入以 http:// 或 https:// 开头的网址' });
      return false;
    }
    getStorage([
      STORAGE_KEYS.roomId,
      STORAGE_KEYS.lastRoomKey,
      STORAGE_KEYS.displayName,
    ]).then((data) => {
      const roomFromStorage = data[STORAGE_KEYS.roomId] || data[STORAGE_KEYS.lastRoomKey];
      const inRoom = !!(currentRoomId || roomFromStorage);
      if (!inRoom) {
        sendResponse({ ok: false, error: '请先连接房间' });
        return;
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        const ok = sendNavigateReliable(url, undefined, { roomSyncNavigate: true });
        sendResponse({ ok: !!ok });
        return;
      }
      const roomKey = String(roomFromStorage || '').trim();
      if (!roomKey) {
        sendResponse({ ok: false, error: '请先连接房间' });
        return;
      }
      pendingNavigateUrl = url;
      enterRoomPending = true;
      broadcastState({ lastError: null });
      const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
      connectAnd(() => {
        sendRaw({ type: 'enter_room', roomKey, displayName });
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (action === 'bindTab') {
    const tabId = request.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: '无效标签' });
      return false;
    }
    setStorage({ [STORAGE_KEYS.followedTabId]: tabId }).then(() => {
      notifyFloater(tabId, true);
      pushRosterToFollowedTab();
      broadcastState();
      maybeApplyJoinReplay(tabId);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (action === 'unbindTab') {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      const tid = data[STORAGE_KEYS.followedTabId];
      setStorage({ [STORAGE_KEYS.followedTabId]: null }).then(() => {
        notifyFloater(tid, false);
        broadcastState(undefined, { followedTabId: null });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (action === 'leaveRoom') {
    enterRoomPending = false;
    disconnectSocketAndClearRoomMemory();
    setStorage({
      [STORAGE_KEYS.roomId]: null,
      [STORAGE_KEYS.role]: null,
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    }).then(() => {
      // 不 notifyFloater(false)：保留页面内悬浮窗，由 content 轮询/刷新为「未连接」状态
      broadcastState({ lastError: null });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (action === 'consumeJoinResume') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId == null) {
      sendResponse({ resume: null });
      return false;
    }
    getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.joinResumeVideo]).then((data) => {
      if (data[STORAGE_KEYS.followedTabId] !== tabId) {
        sendResponse({ resume: null });
        return;
      }
      const rv = data[STORAGE_KEYS.joinResumeVideo];
      if (!rv || typeof rv !== 'object') {
        sendResponse({ resume: null });
        return;
      }
      setStorage({ [STORAGE_KEYS.joinResumeVideo]: null }).then(() => {
        sendResponse({ resume: rv });
      });
    });
    return true;
  }

  return false;
});
