/**
 * 长时间看视频后连接易被中间网络掐成「半开」：readyState 仍为 OPEN 但 navigate 已发不出去。
 * 定时 ping / 等 pong：成功则 pong 后上报 RTT（sync_status_report）；失败则关连接并尽量用 lastRoomKey 自动重连（与「测延迟」同一套心跳，不再单独一套纯断线提示）。
 */
const HEARTBEAT_INTERVAL_MS = 3000;
const PONG_DEADLINE_MS = 12000;
/** 心跳失败后的自动重连次数上限（成功进房后清零） */
const HEARTBEAT_RECONNECT_MAX_ATTEMPTS = 8;
/** @type {number} */
let heartbeatReconnectAttempts = 0;
/** 为 true 时 onclose 走自动重连，不播报普通「已断开」 */
let reconnectAfterHeartbeat = false;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let pongWaitTimer = null;
/** @type {string | null} onclose 时优先展示（相对「连接已断开」更明确） */
let pendingDisconnectBanner = null;
/** 跟随页标题或 URL 更新后下一帧 sync_status_report 带 jumpRoundReset，开启服务端新一轮跳转判定（每轮最多 5 次） */
let pendingJumpRoundReset = false;
/** 用户发起进房（或断线重连进房）后，至 room_created/joined 或失败前 */
let enterRoomPending = false;

/** User-entered WebSocket URL; preserve domain for extension downloads. */
/** @type {string | null} */
let configuredWsUrl = null;
/** Actual WebSocket URL; ws:// domains may be rewritten to IPv4. */
/** @type {string | null} */
let activeWsUrl = null;
/** 服务端 manifest 版本（连接时由 extension_version 推送） */
/** @type {string | null} */
let serverExtensionVersion = null;
/** 与本地 manifest.version 不一致时为 true */
let extensionUpdateAvailable = false;
/** @type {string} */
let extensionDownloadUrl = '';

function stopHeartbeat() {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pongWaitTimer != null) {
    clearTimeout(pongWaitTimer);
    pongWaitTimer = null;
  }
}
function sendSocketPayload(sock, payload) {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  try {
    sock.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function closeSocketQuietly(target) {
  const ws = target || socket;
  if (!ws) return;
  try {
    ws.close();
  } catch (_) {}
}

/**
 * pong 后调用：上报本机 RTT 与跟随标签页 URL，与服务端房间 canonical 页比对（room_roster 带 jumpSynced）。
 * @param {number | null} rttMs
 */
function sendSyncStatusReport(rttMs) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !currentRoomId) return;
  const sock = socket;
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    if (socket !== sock || !sock || sock.readyState !== WebSocket.OPEN || !currentRoomId) return;
    const tid = data[STORAGE_KEYS.followedTabId];
    const payload = {
      type: 'sync_status_report',
      rttMs: rttMs != null && !isNaN(rttMs) ? Math.max(0, Math.round(rttMs)) : null,
      followUrl: '',
    };
    if (pendingJumpRoundReset) {
      payload.jumpRoundReset = true;
      pendingJumpRoundReset = false;
    }
    if (tid == null) {
      sendSocketPayload(sock, payload);
      return;
    }
    chrome.tabs.get(tid, (tab) => {
      if (socket !== sock || !sock || sock.readyState !== WebSocket.OPEN || !currentRoomId) return;
      if (chrome.runtime.lastError || !tab || !tab.url) {
        sendSocketPayload(sock, payload);
        return;
      }
      const u = tab.url;
      payload.followUrl = isAllowedHttpUrl(u) ? u : '';
      sendSocketPayload(sock, payload);
    });
  });
}

/**
 * 心跳判定失败（发 ping 抛错或超时未收到 pong）：先通知跟随页展开悬浮窗并记下收起状态，再关连接并由 onclose 自动重连。
 */
function closeSocketForHeartbeatFailure() {
  const failedSocket = socket;
  reconnectAfterHeartbeat = true;
  pendingDisconnectBanner = null;
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const tid = data[STORAGE_KEYS.followedTabId];
    if (tid == null) {
      if (socket === failedSocket) closeSocketQuietly(failedSocket);
      return;
    }
    chrome.tabs.sendMessage(tid, { type: 'CO_WATCH_PREPARE_HEARTBEAT_RECONNECT' }, () => {
      void chrome.runtime.lastError;
      if (socket === failedSocket) closeSocketQuietly(failedSocket);
    });
  });
}

function sendHeartbeatPing() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    stopHeartbeat();
    return;
  }
  if (pongWaitTimer != null) {
    clearTimeout(pongWaitTimer);
    pongWaitTimer = null;
  }
  const t = Date.now();
  if (!sendSocketPayload(socket, { type: 'ping', t })) {
    closeSocketForHeartbeatFailure();
    return;
  }
  pongWaitTimer = setTimeout(() => {
    pongWaitTimer = null;
    closeSocketForHeartbeatFailure();
  }, PONG_DEADLINE_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeatPing();
  heartbeatTimer = setInterval(sendHeartbeatPing, HEARTBEAT_INTERVAL_MS);
}
