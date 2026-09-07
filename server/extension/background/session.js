function closeSocket() {
  clearSessionTimers();
  stopHeartbeat();
  clearNavigateAckState();
  configuredWsUrl = null;
  activeWsUrl = null;
  extensionUpdateAvailable = false;
  extensionDownloadUrl = '';
  if (socket) {
    try {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    } catch (_) {}
    socket = null;
  }
}

/**
 * WebSocket onclose 时清空会话内存（与 disconnect 一致，但不碰 chrome.storage 的房间字段）。
 */
function clearWsSessionStateAfterClose() {
  clearSessionTimers();
  socket = null;
  configuredWsUrl = null;
  activeWsUrl = null;
  extensionUpdateAvailable = false;
  extensionDownloadUrl = '';
  roomMembers = [];
  playlistItems = [];
  playlistCurrentIdFromServer = null;
  playlistWatchedCountFromServer = 0;
  tabToCloseAfterPlaylistAddAck = null;
  claimHostCooldownUntil = null;
  currentRoomId = null;
  currentRole = null;
  clientId = null;
  lastHostFollowBroadcastKey = '';
  lastAppliedNavigateKey = '';
  navigateApplyGeneration += 1;
  lastPlaylistTitleSentByUrlKey = new Map();
  pendingJumpRoundReset = false;
}

/**
 * Rejoin the last room after a heartbeat or unexpected disconnect.
 */
function tryReconnectAfterHeartbeatFailure(reason) {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.displayName]).then((data) => {
    const roomKey = String(data[STORAGE_KEYS.lastRoomKey] || '').trim();
    if (!roomKey) {
      lastError =
        (reason === 'unexpected' ? '连接中断' : '连接无响应') +
        '且未保存房间密码，请手动连接';
      heartbeatReconnectAttempts = 0;
      broadcastState({ lastError });
      return;
    }
    if (heartbeatReconnectAttempts >= HEARTBEAT_RECONNECT_MAX_ATTEMPTS) {
      lastError =
        '已自动重连 ' +
        HEARTBEAT_RECONNECT_MAX_ATTEMPTS +
        ' 次仍失败，请检查网络或房间服务后手动连接';
      heartbeatReconnectAttempts = 0;
      broadcastState({ lastError });
      return;
    }
    heartbeatReconnectAttempts++;
    enterRoomPending = true;
    const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
    const prefix = reason === 'unexpected' ? '连接中断' : '连接无响应';
    const hint =
      prefix +
      '，正在自动重连（' +
      heartbeatReconnectAttempts +
      '/' +
      HEARTBEAT_RECONNECT_MAX_ATTEMPTS +
      '）…';
    lastError = hint;
    broadcastState({ lastError: hint });
    connectAnd(() => {
      sendRaw({ type: 'enter_room', roomKey, displayName });
    });
  });
}

function disconnectSocketAndClearRoomMemory() {
  connectionGeneration += 1;
  closeSocket();
  clearWsSessionStateAfterClose();
  lastError = null;
  pendingNavigateUrl = null;
  pendingJumpRoundReset = false;
  reconnectAfterHeartbeat = false;
  heartbeatReconnectAttempts = 0;
}

/**
 * 浏览器新会话启动时清理：WebSocket 不能跨关闭保留，但 chrome.storage 里 roomId 等会残留，
 * Chrome 下易误显「已在房间」。保留 lastRoomKey / displayName / serverWsUrl 便于再次连接。
 */
function clearPersistedRoomSessionFromStorage() {
  return setStorage({
    [STORAGE_KEYS.roomId]: null,
    [STORAGE_KEYS.role]: null,
    [STORAGE_KEYS.joinReplayUrl]: null,
    [STORAGE_KEYS.joinResumeVideo]: null,
    [STORAGE_KEYS.followedTabId]: null,
  });
}

/**
 * 后进房对齐当前页。followTabIdOverride 在「刚写入 followedTabId」时传入，避免 chrome.storage
 * 读回滞后导致仍读到 null、跳过重放（已连接后补绑跟随时偶发）。
 */
function maybeApplyJoinReplay(followTabIdOverride) {
  getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.joinReplayUrl]).then((data) => {
    var fromStorage = data[STORAGE_KEYS.followedTabId];
    var fid =
      typeof followTabIdOverride === 'number' && followTabIdOverride >= 0
        ? followTabIdOverride
        : fromStorage;
    const raw = data[STORAGE_KEYS.joinReplayUrl];
    const url = raw != null ? String(raw).trim() : '';
    if (fid == null || !url || !isAllowedHttpUrl(url)) return;
    setStorage({ [STORAGE_KEYS.joinReplayUrl]: null }).then(() => {
      applyOpenFollowedUrl(url, fid);
    });
  });
}

function flushPendingNavigate() {
  const url = pendingNavigateUrl;
  pendingNavigateUrl = null;
  if (!url || !isAllowedHttpUrl(url)) return;
  sendNavigateReliable(url, undefined, { roomSyncNavigate: true });
}

function notifyFloater(tabId, visible) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(
    tabId,
    { type: 'CO_WATCH_FLOATER', visible: !!visible },
    () => void chrome.runtime.lastError
  );
}

/** 自动重连进房成功后：让页面按心跳前记下的状态恢复悬浮窗收起/展开 */
function notifyFloaterReconnectComplete() {
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const tabId = data[STORAGE_KEYS.followedTabId];
    if (tabId == null) return;
    chrome.tabs.sendMessage(
      tabId,
      { type: 'CO_WATCH_RECONNECT_DONE' },
      () => void chrome.runtime.lastError
    );
  });
}

function pushRosterToFollowedTab() {
  if (rosterPushTimer != null) return;
  rosterPushTimer = setTimeout(() => {
    rosterPushTimer = null;
    pushRosterToFollowedTabNow();
  }, STATE_BROADCAST_DEBOUNCE_MS);
}
function pushRosterToFollowedTabNow() {
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const tabId = data[STORAGE_KEYS.followedTabId];
    if (tabId == null) return;
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'CO_WATCH_ROSTER',
        members: roomMembers,
        clientId,
        role: currentRole,
      },
      () => void chrome.runtime.lastError
    );
  });
}

/** @returns {Promise<number | null>} 本次进房新绑定的跟随标签 id，未绑定则为 null */
function applyPendingFollowTab() {
  const tid = pendingFollowTabId;
  pendingFollowTabId = null;
  if (tid == null) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.get(tid, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
        const prev = data[STORAGE_KEYS.followedTabId];
        if (prev != null && prev !== tid) {
          notifyFloater(prev, false);
        }
        return setStorage({ [STORAGE_KEYS.followedTabId]: tid }).then(() => {
          notifyFloater(tid, true);
          resolve(tid);
        });
      });
    });
  });
}

function applyOpenFollowedUrl(url, followTabIdOverride, opts) {
  if (!isAllowedHttpUrl(url)) return;
  if (typeof followTabIdOverride === 'number' && followTabIdOverride >= 0) {
    openFollowedTabAtUrl(followTabIdOverride, url, opts);
    return;
  }
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const tabId = data[STORAGE_KEYS.followedTabId];
    if (tabId == null) return;
    openFollowedTabAtUrl(tabId, url, opts);
  });
}
