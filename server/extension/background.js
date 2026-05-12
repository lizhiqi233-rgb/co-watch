importScripts('wsNormalize.js');

const STORAGE_KEYS = {
  serverWsUrl: 'serverWsUrl',
  roomId: 'roomId',
  role: 'role',
  followedTabId: 'followedTabId',
  /** 上次成功进入的房间密码（离开房间后仍保留，便于再次输入） */
  lastRoomKey: 'lastRoomKey',
  /** 在房间内展示的名称，1～32 字 */
  displayName: 'displayName',
  /** 后进房待对齐的房间当前页 URL（持久化，避免 SW 休眠丢失；navigate 广播时同步更新） */
  joinReplayUrl: 'joinReplayUrl',
  /** 服务端 joined.resumeVideo：房主侧播放快照，供成员跟随页对齐进度/尝试开播 */
  joinResumeVideo: 'joinResumeVideo',
  /** 为 true 时在 Service Worker 控制台输出 [co-watch] 调试日志 */
  coWatchDebug: 'coWatchDebug',
};

/** 与 chrome.storage 同步；弹窗可开关 */
let coWatchDebug = false;

function dbg(...args) {
  if (!coWatchDebug) return;
  console.log('[co-watch]', new Date().toISOString(), ...args);
}

function loadCoWatchDebugFlag() {
  return getStorage([STORAGE_KEYS.coWatchDebug]).then((data) => {
    coWatchDebug = !!data[STORAGE_KEYS.coWatchDebug];
  });
}

/** @type {WebSocket | null} */
let socket = null;
/** @type {string | null} */
let currentRoomId = null;
/** @type {'host' | 'member' | null} */
let currentRole = null;
/** @type {string | null} */
let clientId = null;
/** @type {string | null} */
let lastError = null;
/** 连接房间成功后要绑定的标签（由 enterRoom 传入，收到 room_created/joined 后消费） */
/** @type {number | null} */
let pendingFollowTabId = null;
/** SW 休眠后重连成功前要补发的全员跳转 URL（仅内存） */
/** @type {string | null} */
let pendingNavigateUrl = null;
/** @type {Array<{ clientId: string, role: string, displayName: string }>} */
let roomMembers = [];

/** 房间播放列表（仅内存，会话内有效；与服务端 playlist_state 同步） */
/** @type {Array<{ id: string, url: string, title: string }>} */
let playlistItems = [];
/** 服务端 playlist_state.currentId（房主点「播放」等）；UI 高亮优先用跟随标签标题与列表标题匹配 */
/** @type {string | null} */
let playlistCurrentIdFromServer = null;
/** 服务端 playlist 已看过条数，用于悬浮窗隐藏「已播放」 */
let playlistWatchedCountFromServer = 0;
/** 加入队列成功后待关闭的标签 id（收到 playlist_add_ack 后关闭） */
/** @type {number | null} */
let tabToCloseAfterPlaylistAddAck = null;

/**
 * 与服务端 index.js 中 normalizeReadStatus 一致。
 * @param {unknown} s
 * @returns {'unread' | 'reading' | 'read'}
 */
function normalizeReadStatus(s) {
  if (s === 'reading' || s === 'read' || s === 'unread') return s;
  return 'unread';
}

function applyPlaylistFromServer(p) {
  if (!p || typeof p !== 'object') {
    playlistItems = [];
    playlistCurrentIdFromServer = null;
    playlistWatchedCountFromServer = 0;
    return;
  }
  const o = /** @type {{ items?: unknown, currentId?: unknown, watchedCount?: unknown }} */ (p);
  const raw = Array.isArray(o.items) ? o.items : [];
  playlistItems = raw
    .filter(
      (x) =>
        x &&
        typeof x === 'object' &&
        typeof /** @type {{ id?: unknown, url?: unknown, title?: unknown }} */ (x).id === 'string' &&
        typeof /** @type {{ id?: unknown, url?: unknown, title?: unknown }} */ (x).url === 'string'
    )
    .map((x) => {
      const it = /** @type {{ id: string, url: string, title?: string, readStatus?: unknown }} */ (x);
      return {
        id: it.id,
        url: it.url,
        title: typeof it.title === 'string' ? it.title : '',
        readStatus: normalizeReadStatus(it.readStatus),
      };
    });
  playlistCurrentIdFromServer =
    typeof o.currentId === 'string' && o.currentId.trim() ? o.currentId.trim() : null;
  let wc = 0;
  if (typeof o.watchedCount === 'number' && !isNaN(o.watchedCount) && o.watchedCount >= 0) {
    wc = Math.floor(o.watchedCount);
  }
  playlistWatchedCountFromServer = Math.min(wc, playlistItems.length);
}

/**
 * 标题宽松规范化，仅用于与跟随标签标题比对（无 200 字截断、无默认「无标题」）。
 * 与服务端 normalizePlaylistTitle 的 trim/空白折叠步骤一致。
 * @param {unknown} s
 * @returns {string}
 */
function normalizePlaylistTitleCompare(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {typeof playlistItems} items
 * @param {string | null | undefined} tabUrl 跟随标签页 URL
 */
function matchPlaylistIdByFollowedTabUrl(items, tabUrl) {
  if (!items || !items.length) return null;
  const u = tabUrl != null ? String(tabUrl).trim() : '';
  if (!u || !isAllowedHttpUrl(u)) return null;
  const k = normalizeUrlKeyForCoWatch(u);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.id !== 'string' || typeof it.url !== 'string') continue;
    if (normalizeUrlKeyForCoWatch(it.url) === k) return it.id;
  }
  return null;
}

/**
 * @param {typeof playlistItems} items
 * @param {string | null | undefined} tabTitle 跟随标签的 document/tab 标题
 */
function matchPlaylistIdByFollowedTabTitle(items, tabTitle) {
  if (!items || !items.length) return null;
  const t = normalizePlaylistTitleCompare(tabTitle);
  if (!t) return null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.id !== 'string') continue;
    if (normalizePlaylistTitleCompare(it.title) === t) return it.id;
  }
  return null;
}

/**
 * 展示用 currentId：优先跟随标签 URL 与列表项 url 一致；其次标题一致；最后用服务端 currentId
 * @param {string | null | undefined} followedTabTitle
 * @param {string | null | undefined} followedTabUrl
 * @param {string | null} serverId
 */
function resolvePlaylistCurrentIdForUi(followedTabTitle, followedTabUrl, serverId) {
  const byUrl = matchPlaylistIdByFollowedTabUrl(playlistItems, followedTabUrl);
  if (byUrl != null) return byUrl;
  const byTitle = matchPlaylistIdByFollowedTabTitle(playlistItems, followedTabTitle);
  if (byTitle != null) return byTitle;
  return typeof serverId === 'string' && serverId.trim() ? serverId.trim() : null;
}

/**
 * 仅跟随标签 URL/标题与列表匹配（不含服务端 currentId 回退），与 UI 高亮一致，用于已读分界同步。
 * @param {string | null | undefined} tabTitle
 * @param {string | null | undefined} tabUrl
 * @returns {string | null}
 */
function matchPlaylistIdFromTabForReadSync(tabTitle, tabUrl) {
  const byUrl = matchPlaylistIdByFollowedTabUrl(playlistItems, tabUrl);
  if (byUrl != null) return byUrl;
  const byTitle = matchPlaylistIdByFollowedTabTitle(playlistItems, tabTitle);
  return byTitle != null ? byTitle : null;
}

/**
 * 房主跟随页与列表项对齐后，上报 playlist_current_match（服务端 applyReadingFocus）；已与 reading 对齐则跳过。
 * @type {ReturnType<typeof setTimeout> | null}
 */
let playlistReadSyncDebounceTimer = null;
/** 跟随页 URL/标题抖动时合并后再尝试 playlist_current_match，过小易重复上报 */
const PLAYLIST_READ_SYNC_DEBOUNCE_MS = 180;

/**
 * @param {string} tabTitle
 * @param {string} tabUrl
 * @param {string | null | undefined} storedRole
 */
function tryPlaylistReadSyncFromFollowedTab(tabTitle, tabUrl, storedRole) {
  if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (resolveEffectiveRole(storedRole) !== 'host') return;
  const matchedId = matchPlaylistIdFromTabForReadSync(tabTitle, tabUrl);
  if (matchedId == null) return;
  const it = playlistItems.find((x) => x && x.id === matchedId);
  if (
    it &&
    normalizeReadStatus(it.readStatus) === 'reading' &&
    playlistCurrentIdFromServer === matchedId
  ) {
    return;
  }
  sendRaw({ type: 'playlist_current_match', id: matchedId });
}

/**
 * @param {number} fid
 * @param {string | null | undefined} storedRole
 */
function queuePlaylistReadSyncFromFollowedTab(fid, storedRole) {
  if (playlistReadSyncDebounceTimer != null) {
    clearTimeout(playlistReadSyncDebounceTimer);
    playlistReadSyncDebounceTimer = null;
  }
  playlistReadSyncDebounceTimer = setTimeout(() => {
    playlistReadSyncDebounceTimer = null;
    chrome.tabs.get(fid, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      tryPlaylistReadSyncFromFollowedTab(tab.title || '', tab.url || '', storedRole);
    });
  }, PLAYLIST_READ_SYNC_DEBOUNCE_MS);
}

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

/** 当前 WebSocket 使用的地址（用于由 ws 推导 HTTP 下载扩展包） */
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

/**
 * pong 后调用：上报本机 RTT 与跟随标签页 URL，与服务端房间 canonical 页比对（room_roster 带 jumpSynced）。
 * @param {number | null} rttMs
 */
function sendSyncStatusReport(rttMs) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !currentRoomId) return;
  const sock = socket;
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    if (!sock || sock.readyState !== WebSocket.OPEN || !currentRoomId) return;
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
      try {
        sock.send(JSON.stringify(payload));
      } catch (_) {}
      return;
    }
    chrome.tabs.get(tid, (tab) => {
      if (!sock || sock.readyState !== WebSocket.OPEN || !currentRoomId) return;
      if (chrome.runtime.lastError || !tab || !tab.url) {
        try {
          sock.send(JSON.stringify(payload));
        } catch (_) {}
        return;
      }
      const u = tab.url;
      payload.followUrl = isAllowedHttpUrl(u) ? u : '';
      try {
        sock.send(JSON.stringify(payload));
      } catch (_) {}
    });
  });
}

/**
 * 心跳判定失败（发 ping 抛错或超时未收到 pong）：先通知跟随页展开悬浮窗并记下收起状态，再关连接并由 onclose 自动重连。
 */
function closeSocketForHeartbeatFailure() {
  reconnectAfterHeartbeat = true;
  pendingDisconnectBanner = null;
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const tid = data[STORAGE_KEYS.followedTabId];
    if (tid == null) {
      try {
        if (socket) socket.close();
      } catch (_) {}
      return;
    }
    chrome.tabs.sendMessage(tid, { type: 'CO_WATCH_PREPARE_HEARTBEAT_RECONNECT' }, () => {
      void chrome.runtime.lastError;
      try {
        if (socket) socket.close();
      } catch (_) {}
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
  try {
    socket.send(JSON.stringify({ type: 'ping', t }));
  } catch (_) {
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

/** 全员跳转：等待服务端 navigate_ack，超时则重发（弱网丢包/半开连接） */
const NAVIGATE_ACK_TIMEOUT_MS = 4000;
const NAVIGATE_MAX_SENDS = 3;
/** @type {ReturnType<typeof setTimeout> | null} */
let navigateAckTimer = null;
/** @type {string | null} */
let navigateAckUrl = null;
/** @type {string | null} */
let navigateAckTitle = null;
/** 右键/侧栏发协同：跳过一次播放列表插入，避免与跟随标签 onUpdated 再次 navigate 重复写库 */
let navigateAckSkipPlaylistInsert = false;
/** 与 skip 并列：服务端按房主规则更新播放列表（任意成员发起「全员跳转/发送到协同」时亦同） */
let navigateAckRoomSync = false;
let navigateSendCount = 0;
/** 最近一次已成功发出的全员跳转规范化键；用于房主跟标签 onUpdated 去重，及与弹窗/右键发送协同 */
let lastHostFollowBroadcastKey = '';
/** 跟随页某 URL 键已随 navigate 上报过的 tab 标题；title 晚于 URL 更新时再发 skip 补标题 */
let lastPlaylistTitleSentByUrlKey = {};
/** 房主跟随标签 URL 变更后合并再发 navigate，过小易在 SPA 连续 push 时重复广播 */
const HOST_FOLLOW_TAB_NAV_DEBOUNCE_MS = 120;
/** @type {ReturnType<typeof setTimeout> | null} */
let hostFollowTabNavDebounceTimer = null;

function clearNavigateAckState() {
  if (navigateAckTimer != null) {
    clearTimeout(navigateAckTimer);
    navigateAckTimer = null;
  }
  navigateAckUrl = null;
  navigateAckTitle = null;
  navigateAckSkipPlaylistInsert = false;
  navigateAckRoomSync = false;
  navigateSendCount = 0;
}

function navigateUrlsMatch(a, b) {
  if (!a || !b) return false;
  return normalizeUrlKeyForCoWatch(a) === normalizeUrlKeyForCoWatch(b);
}

/**
 * 发送 navigate 并在未收到 navigate_ack 前按超时重发若干次；收到 ack 则立即停止。
 * 旧版无 ack 的服务端：仅多播几次同 URL，跟随端同址会跳过，兼容不报错。
 * @param {string} [titleOpt] 可选页面标题，供服务端插入播放列表时展示
 * @param {{ skipPlaylistInsert?: boolean, roomSyncNavigate?: boolean }} [opts] skip：首跳不插入；roomSyncNavigate：服务端按房主浏览规则更新列表与已看历史（成员亦适用）
 */
function sendNavigateReliable(url, titleOpt, opts) {
  clearNavigateAckState();
  const trimmed = String(url || '').trim();
  if (!isAllowedHttpUrl(trimmed)) return false;

  navigateAckUrl = trimmed;
  navigateAckTitle =
    titleOpt != null && typeof titleOpt === 'string' && titleOpt.length > 0
      ? titleOpt.slice(0, 300)
      : null;
  navigateAckSkipPlaylistInsert = !!(opts && opts.skipPlaylistInsert);
  navigateAckRoomSync = !!(opts && opts.roomSyncNavigate);
  navigateSendCount = 1;
  dbg('sendNavigateReliable', {
    url: trimmed.slice(0, 160),
    skipPlaylistInsert: navigateAckSkipPlaylistInsert,
    roomSyncNavigate: navigateAckRoomSync,
  });
  const payload = { type: 'navigate', url: trimmed };
  if (navigateAckTitle != null) {
    payload.title = navigateAckTitle;
  }
  if (navigateAckSkipPlaylistInsert) {
    payload.skipPlaylistInsert = true;
  }
  if (navigateAckRoomSync) {
    payload.roomSyncNavigate = true;
  }
  if (!sendRaw(payload)) {
    clearNavigateAckState();
    return false;
  }
  // skip 的首跳不写键，否则跟随标签 onUpdated 会因同键去重不再发 navigate，播放列表无法补写
  if (!navigateAckSkipPlaylistInsert) {
    lastHostFollowBroadcastKey = normalizeUrlKeyForCoWatch(trimmed);
  }

  function armTimer() {
    navigateAckTimer = setTimeout(() => {
      navigateAckTimer = null;
      if (!navigateAckUrl) return;
      if (navigateSendCount >= NAVIGATE_MAX_SENDS) {
        clearNavigateAckState();
        // 无 ack 时此前可能已发出多次 navigate；仅提示「可能未确认」，避免完全静默（弱网/半开连接）
        broadcastState({
          lastError: '全员跳转未收到服务器确认，若对方页面未更新请再试一次',
        });
        return;
      }
      navigateSendCount += 1;
      const retry = { type: 'navigate', url: navigateAckUrl };
      if (navigateAckTitle != null) {
        retry.title = navigateAckTitle;
      }
      if (navigateAckSkipPlaylistInsert) {
        retry.skipPlaylistInsert = true;
      }
      if (navigateAckRoomSync) {
        retry.roomSyncNavigate = true;
      }
      if (!sendRaw(retry)) {
        clearNavigateAckState();
        return;
      }
      armTimer();
    }, NAVIGATE_ACK_TIMEOUT_MS);
  }
  armTimer();
  return true;
}

/**
 * 右键/侧栏发协同时使用 skip 首跳；若跟随页已在目标 URL，handleServerMessage(navigate) 不会 tabs.update，
 * 也就没有 onUpdated → 播放列表永远不会补写。此时再发一次完整 navigate 写入列表（服务端 URL 已存在则只对齐指针）。
 * @param {number} tabId
 * @param {string} url
 */
function maybePlaylistNavigateAfterSkipCoWatch(tabId, url) {
  const ukey = normalizeUrlKeyForCoWatch(url);
  chrome.tabs.get(tabId, (t) => {
    if (chrome.runtime.lastError || !t || !t.url) return;
    if (!isAllowedHttpUrl(t.url)) return;
    if (normalizeUrlKeyForCoWatch(t.url) !== ukey) return;
    sendNavigateReliable(url, (t.title || '').slice(0, 300), { roomSyncNavigate: true });
  });
}

/**
 * 连接前校验 URL 格式。建立连接时，明文 ws:// 且主机为域名时，会经国内 DoH 查 A 记录优先用 IPv4（见 preferIpv4WsUrl）。
 * @param {string} wsUrlString
 */
function assertValidWsUrl(wsUrlString) {
  let u;
  try {
    u = new URL(wsUrlString);
  } catch {
    throw new Error('服务地址格式无效');
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('仅支持 ws:// 或 wss://');
  }
  if (!u.hostname) {
    throw new Error('服务地址缺少主机名（请填写域名或 IP）');
  }
}

/** 是否为 IPv4 字面量或 IPv6 字面量（避免对已是 IP 的地址再做 DoH） */
function isIpLiteralHost(host) {
  if (!host) return true;
  if (host.includes(':')) {
    return true;
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * 通过 DNS over HTTPS 查询 A 记录（仅 IPv4）。
 * 使用国内一般可直接访问的 JSON DoH（阿里 AliDNS、DNSPod），避免依赖境外 DoH。
 * 失败时返回 null，由调用方回退为原始域名连接。
 */
async function resolveHostnameToIpv4ViaDoh(hostname) {
  const endpoints = [
    () => {
      const q = new URL('https://dns.alidns.com/resolve');
      q.searchParams.set('name', hostname);
      q.searchParams.set('type', 'A');
      return q.toString();
    },
    () => {
      const q = new URL('https://dns.pub/resolve');
      q.searchParams.set('name', hostname);
      q.searchParams.set('type', 'A');
      return q.toString();
    },
  ];
  for (let e = 0; e < endpoints.length; e++) {
    try {
      const r = await fetch(endpoints[e](), {
        headers: { Accept: 'application/dns-json' },
        cache: 'no-store',
      });
      if (!r.ok) continue;
      const j = await r.json();
      const answers = j.Answer || [];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        if (a && a.type === 1 && typeof a.data === 'string') {
          const ip = a.data.replace(/^"|"$/g, '').trim();
          if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
            return ip;
          }
        }
      }
    } catch (_) {
      /* try next endpoint */
    }
  }
  return null;
}

/**
 * 明文 ws:// 时：将域名解析为 IPv4 再连接，避免系统优先走不可达/错误的 IPv6（AAAA）导致 1006。
 * wss:// 不改写主机名，以免与证书域名不一致导致 TLS 失败。
 */
async function preferIpv4WsUrl(wsUrlString) {
  let u;
  try {
    u = new URL(wsUrlString);
  } catch {
    return wsUrlString;
  }
  if (u.protocol !== 'ws:') {
    return wsUrlString;
  }
  const host = u.hostname;
  if (!host || isIpLiteralHost(host)) {
    return wsUrlString;
  }
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return wsUrlString;
  }
  const ipv4 = await resolveHostnameToIpv4ViaDoh(host);
  if (!ipv4) {
    return wsUrlString;
  }
  u.hostname = ipv4;
  return u.toString();
}

function isAllowedHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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
      if (lastPlaylistTitleSentByUrlKey[key] === title) return;
      lastPlaylistTitleSentByUrlKey[key] = title;
      sendNavigateReliable(url, title.slice(0, 300), { skipPlaylistInsert: true });
    });
  });
}

function normalizeUrlKeyForCoWatch(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase();
    if (
      h === 'bilibili.com' ||
      h === 'www.bilibili.com' ||
      h === 'm.bilibili.com' ||
      h.endsWith('.bilibili.com')
    ) {
      const pathOnly = x.pathname.replace(/\/+$/, '') || '/';
      const m = pathOnly.match(/^\/video\/(BV[a-zA-Z0-9]+)$/i);
      if (m) {
        const bv = m[1];
        const p = x.searchParams.get('p');
        const part = p && /^\d+$/.test(String(p)) ? `?p=${p}` : '';
        return `https://www.bilibili.com/video/${bv}${part}`;
      }
    }
    let path = x.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return x.origin + path + x.search;
  } catch {
    return String(u || '').trim();
  }
}

/**
 * 跟随标签打开目标 URL。
 * @param {{ broadcastNavigate?: boolean }} [opts] broadcastNavigate：服务端全员 navigate 广播；不可仅因「规范化同址」静默跳过（右键发当前页 tab.url 常与成员页同键），同字符串时 reload 以对齐 SPA。
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
      if (tab.url === url) {
        chrome.tabs.reload(tabId, {}, () => {
          if (chrome.runtime.lastError) onFail();
        });
        return;
      }
      chrome.tabs.update(tabId, { url }, () => {
        if (chrome.runtime.lastError) onFail();
      });
      return;
    }

    if (!sameKey) {
      chrome.tabs.update(tabId, { url }, () => {
        if (chrome.runtime.lastError) onFail();
      });
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

/**
 * 与服务端 index.js 中 normalizeDisplayName 一致（trim、合并空白、最长 32）。
 * @param {unknown} s
 * @returns {string}
 */
function normalizeDisplayName(s) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 32);
  return t;
}

/**
 * 入队/上报标题：与服务端 index.js 中 normalizePlaylistTitle 行为对齐（截断 200、空为「（无标题）」）。
 * @param {unknown} s
 * @returns {string}
 */
function normalizePlaylistTitle(s) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return t || '（无标题）';
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

function closeSocket() {
  stopHeartbeat();
  clearNavigateAckState();
  activeWsUrl = null;
  serverExtensionVersion = null;
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
  socket = null;
  activeWsUrl = null;
  serverExtensionVersion = null;
  extensionUpdateAvailable = false;
  extensionDownloadUrl = '';
  roomMembers = [];
  playlistItems = [];
  playlistCurrentIdFromServer = null;
  playlistWatchedCountFromServer = 0;
  tabToCloseAfterPlaylistAddAck = null;
  currentRoomId = null;
  currentRole = null;
  clientId = null;
  pendingJumpRoundReset = false;
}

/**
 * 心跳失败关闭后：用上次房间密码与显示名再次 enter_room（与手动连接相同路径）。
 */
function tryReconnectAfterHeartbeatFailure() {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.displayName]).then((data) => {
    const roomKey = String(data[STORAGE_KEYS.lastRoomKey] || '').trim();
    if (!roomKey) {
      lastError = '连接无响应且未保存房间密码，请手动连接';
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
    const hint =
      '连接无响应，正在自动重连（' +
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
  if (playlistReadSyncDebounceTimer != null) {
    clearTimeout(playlistReadSyncDebounceTimer);
    playlistReadSyncDebounceTimer = null;
  }
  closeSocket();
  roomMembers = [];
  playlistItems = [];
  playlistCurrentIdFromServer = null;
  playlistWatchedCountFromServer = 0;
  tabToCloseAfterPlaylistAddAck = null;
  currentRoomId = null;
  currentRole = null;
  clientId = null;
  lastError = null;
  pendingNavigateUrl = null;
  lastHostFollowBroadcastKey = '';
  lastPlaylistTitleSentByUrlKey = {};
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

/** 名单中是否存在「除指定客户端外」的房主（用于判断房主转让是否已在名单上体现） */
function rosterHasOtherHost(excludeClientId) {
  if (!excludeClientId || !Array.isArray(roomMembers)) return false;
  return roomMembers.some(
    (m) => m && m.clientId && m.clientId !== excludeClientId && m.role === 'host'
  );
}

/**
 * 从房间成员列表同步本机角色。
 * 旧房主掉线后，若先收到 promoted 已为 host，再收到仍把本机标成 member、且名单中尚无其他房主的陈旧 room_roster，
 * 则不应把 currentRole 从 host 覆盖回 member，否则房主无法转发 video_sync，全员各播各的。
 */
function syncRoleFromRosterMembers() {
  if (!clientId || !Array.isArray(roomMembers) || roomMembers.length === 0) return;
  const self = roomMembers.find((m) => m && m.clientId === clientId);
  if (!self) return;
  const r = self.role;
  if (r !== 'host' && r !== 'member') return;
  if (currentRole === r) return;
  if (currentRole === 'host' && r === 'member' && !rosterHasOtherHost(clientId)) {
    return;
  }
  currentRole = r;
  setStorage({ [STORAGE_KEYS.role]: currentRole });
}

/**
 * 播放同步等权限判断：综合 roomMembers、内存中的 currentRole（含 promoted）与 storage。
 * 当名单滞后于 promoted 时，不得以陈旧 member 条目否定本机房主身份。
 * @param {string | null | undefined} storedRole chrome.storage 中的 role
 */
function resolveEffectiveRole(storedRole) {
  if (clientId && roomMembers.length) {
    const self = roomMembers.find((m) => m && m.clientId === clientId);
    if (self && (self.role === 'host' || self.role === 'member')) {
      if (self.role === 'member' && currentRole === 'host' && !rosterHasOtherHost(clientId)) {
        return 'host';
      }
      return self.role;
    }
  }
  if (currentRole === 'host' || currentRole === 'member') return currentRole;
  if (storedRole === 'host' || storedRole === 'member') return storedRole;
  return null;
}

function handleServerMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (coWatchDebug && msg && msg.type && msg.type !== 'pong' && msg.type !== 'video_sync') {
    if (msg.type === 'navigate') dbg('ws←', msg.type, msg.url);
    else dbg('ws←', msg.type);
  }
  if (msg.type === 'pong') {
    if (pongWaitTimer != null) {
      clearTimeout(pongWaitTimer);
      pongWaitTimer = null;
    }
    const t0 = typeof msg.t === 'number' ? msg.t : null;
    const rttMs = t0 != null ? Math.max(0, Date.now() - t0) : null;
    sendSyncStatusReport(rttMs);
    return;
  }
  if (msg.type === 'extension_version') {
    const serverV = typeof msg.version === 'string' ? msg.version.trim() : '';
    const localV = String((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '').trim();
    serverExtensionVersion = serverV || null;
    if (serverV && localV && serverV !== localV) {
      extensionUpdateAvailable = true;
      const origin = activeWsUrl ? wsUrlToHttpOrigin(activeWsUrl) : '';
      // 与服务端 /extension-{版本}.zip 对齐，避免多次下载同名 extension.zip 覆盖
      extensionDownloadUrl = origin
        ? `${origin}/extension-${encodeURIComponent(serverV)}.zip`
        : '';
    } else {
      extensionUpdateAvailable = false;
      extensionDownloadUrl = '';
    }
    broadcastState();
    return;
  }
  if (msg.type === 'room_created') {
    enterRoomPending = false;
    heartbeatReconnectAttempts = 0;
    currentRoomId = msg.roomId;
    currentRole = msg.role;
    clientId = msg.clientId;
    applyPlaylistFromServer(msg.playlist);
    if (Array.isArray(msg.members) && msg.members.length) {
      roomMembers = msg.members;
      syncRoleFromRosterMembers();
    }
    lastError = null;
    setStorage({
      [STORAGE_KEYS.roomId]: currentRoomId,
      [STORAGE_KEYS.role]: currentRole,
      [STORAGE_KEYS.lastRoomKey]: currentRoomId,
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    }).then(() => applyPendingFollowTab()).then(() => {
      broadcastState({ lastError: null });
      pushRosterToFollowedTab();
      notifyFloaterReconnectComplete();
      flushPendingNavigate();
    });
    return;
  }
  if (msg.type === 'joined') {
    enterRoomPending = false;
    heartbeatReconnectAttempts = 0;
    currentRoomId = msg.roomId;
    currentRole = msg.role;
    clientId = msg.clientId;
    applyPlaylistFromServer(msg.playlist);
    if (Array.isArray(msg.members) && msg.members.length) {
      roomMembers = msg.members;
      syncRoleFromRosterMembers();
    }
    lastError = null;
    const replayUrl =
      typeof msg.lastNavigateUrl === 'string' ? msg.lastNavigateUrl.trim() : '';
    const joinReplayStored =
      replayUrl && isAllowedHttpUrl(replayUrl) ? replayUrl : null;
    let joinResumeStored = null;
    if (msg.resumeVideo && typeof msg.resumeVideo === 'object') {
      const rv = msg.resumeVideo;
      const ct = rv.currentTime;
      if (typeof ct === 'number' && !isNaN(ct) && ct >= 0) {
        joinResumeStored = {
          currentTime: ct,
          playbackRate:
            typeof rv.playbackRate === 'number' && rv.playbackRate > 0 && rv.playbackRate <= 4
              ? rv.playbackRate
              : 1,
          playing: !!rv.playing,
        };
      }
    }
    setStorage({
      [STORAGE_KEYS.roomId]: currentRoomId,
      [STORAGE_KEYS.role]: currentRole,
      [STORAGE_KEYS.lastRoomKey]: currentRoomId,
      [STORAGE_KEYS.joinReplayUrl]: joinReplayStored,
      [STORAGE_KEYS.joinResumeVideo]: joinResumeStored,
    }).then(() => applyPendingFollowTab()).then((boundTid) => {
      broadcastState({ lastError: null });
      pushRosterToFollowedTab();
      maybeApplyJoinReplay(boundTid != null ? boundTid : undefined);
      flushPendingNavigate();
      /** 有后进房重放 URL 时会导航跟随页，延后通知以便新文档中的 content 收到并读回 sessionStorage */
      const delayMs = joinReplayStored ? 900 : 0;
      setTimeout(() => notifyFloaterReconnectComplete(), delayMs);
    });
    return;
  }
  if (msg.type === 'promoted') {
    currentRole = msg.role || 'host';
    setStorage({ [STORAGE_KEYS.role]: currentRole });
    if (clientId && Array.isArray(roomMembers)) {
      const idx = roomMembers.findIndex((m) => m && m.clientId === clientId);
      if (idx >= 0) {
        roomMembers[idx] = { ...roomMembers[idx], role: currentRole };
      }
    }
    pushRosterToFollowedTab();
    broadcastState();
    return;
  }
  if (msg.type === 'navigate' && msg.url) {
    const nav = String(msg.url).trim();
    if (!isAllowedHttpUrl(nav)) return;
    const navKey = normalizeUrlKeyForCoWatch(nav);
    // 服务端广播的 navigate 不经 sendNavigateReliable，若不同步键，跟随页 onUpdated 会再发 ws→ navigate，造成重复插入与循环
    lastHostFollowBroadcastKey = navKey;
    getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
      const tid = data[STORAGE_KEYS.followedTabId];
      const role = resolveEffectiveRole(data[STORAGE_KEYS.role]);

      const applyNavigateToFollowedTab = () => {
        setStorage({
          [STORAGE_KEYS.joinReplayUrl]: nav,
          [STORAGE_KEYS.joinResumeVideo]: null,
        }).then(() => {
          applyOpenFollowedUrl(
            nav,
            typeof tid === 'number' && tid >= 0 ? tid : undefined,
            { broadcastNavigate: true }
          );
        });
      };

      // 房主也会收到自己发出的 navigate 广播：跟随页已是该地址时勿 update/reload，否则整页重载或打断自动连播
      if (role === 'host' && typeof tid === 'number' && tid >= 0) {
        chrome.tabs.get(tid, (tab) => {
          if (chrome.runtime.lastError || !tab || !tab.url) {
            applyNavigateToFollowedTab();
            return;
          }
          if (!isAllowedHttpUrl(tab.url)) {
            applyNavigateToFollowedTab();
            return;
          }
          if (normalizeUrlKeyForCoWatch(tab.url) === navKey) {
            setStorage({
              [STORAGE_KEYS.joinReplayUrl]: nav,
              [STORAGE_KEYS.joinResumeVideo]: null,
            });
            return;
          }
          applyNavigateToFollowedTab();
        });
        return;
      }

      applyNavigateToFollowedTab();
    });
    return;
  }
  if (msg.type === 'navigate_ack') {
    const u = typeof msg.url === 'string' ? msg.url.trim() : '';
    if (navigateAckUrl && navigateUrlsMatch(u, navigateAckUrl)) {
      clearNavigateAckState();
      broadcastState({ lastError: null });
    }
    return;
  }
  if (msg.type === 'playlist_add_ack') {
    if (tabToCloseAfterPlaylistAddAck != null) {
      const tid = tabToCloseAfterPlaylistAddAck;
      tabToCloseAfterPlaylistAddAck = null;
      try {
        chrome.tabs.remove(tid, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
    return;
  }
  if (msg.type === 'server_notice') {
    lastError = typeof msg.message === 'string' ? msg.message : '';
    if (msg.code === 'playlist_add' && tabToCloseAfterPlaylistAddAck != null) {
      tabToCloseAfterPlaylistAddAck = null;
    }
    broadcastState();
    return;
  }
  if (msg.type === 'error') {
    enterRoomPending = false;
    pendingFollowTabId = null;
    pendingNavigateUrl = null;
    setStorage({
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    });
    clearNavigateAckState();
    broadcastState({ lastError: msg.message || '未知错误' });
    return;
  }
  if (msg.type === 'room_roster') {
    roomMembers = Array.isArray(msg.members) ? msg.members : [];
    syncRoleFromRosterMembers();
    pushRosterToFollowedTab();
    broadcastState();
    return;
  }
  if (msg.type === 'playlist_state') {
    applyPlaylistFromServer(msg);
    broadcastState();
    return;
  }
  if (msg.type === 'video_sync') {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      const tabId = data[STORAGE_KEYS.followedTabId];
      if (tabId == null) return;
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'CO_WATCH_APPLY',
          action: msg.action,
          currentTime: msg.currentTime,
          playbackRate: msg.playbackRate,
          ...(typeof msg.playing === 'boolean' ? { playing: msg.playing } : {}),
        },
        () => void chrome.runtime.lastError
      );
    });
    return;
  }
}

/**
 * @param {object} [extra]
 * @param {{ followedTabId?: number | null }} [stateHints] 覆盖刚从 storage 写入的值（Edge 上 set 后立即 get 可能仍为旧值，右键菜单会卡在「发送到协同浏览」）
 */
function broadcastState(extra, stateHints) {
  if (extra && 'lastError' in extra) {
    lastError = extra.lastError;
  }
  const connected = !!(socket && socket.readyState === WebSocket.OPEN);
  const payload = {
    type: 'state',
    connected,
    enterRoomPending,
    roomId: connected ? currentRoomId : null,
    followedTabId: null,
    roomMembers: connected ? roomMembers : [],
    roomConnected: !!(connected && currentRoomId),
    playlistItems: connected && currentRoomId ? playlistItems : [],
    playlistCurrentId: null,
    playlistWatchedCount: connected && currentRoomId ? playlistWatchedCountFromServer : 0,
    ...(extra || {}),
    lastError,
  };
  getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
    let fid = data[STORAGE_KEYS.followedTabId];
    if (stateHints && Object.prototype.hasOwnProperty.call(stateHints, 'followedTabId')) {
      fid = stateHints.followedTabId;
    }
    payload.followedTabId = connected ? (fid ?? null) : null;
    payload.role = connected ? resolveEffectiveRole(data[STORAGE_KEYS.role]) : null;
    const applyPlaylistId = (tabTitle, tabUrl) => {
      payload.playlistCurrentId =
        connected && currentRoomId
          ? resolvePlaylistCurrentIdForUi(tabTitle, tabUrl, playlistCurrentIdFromServer)
          : null;
      chrome.runtime.sendMessage(payload).catch(() => {});
    };
    if (fid == null || !connected || !currentRoomId) {
      applyPlaylistId(null, null);
      return;
    }
    chrome.tabs.get(fid, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        applyPlaylistId(null, null);
        return;
      }
      applyPlaylistId(tab.title || '', tab.url || '');
      queuePlaylistReadSyncFromFollowedTab(fid, data[STORAGE_KEYS.role]);
    });
  });
  refreshContextMenuTitle(stateHints);
}

function connectAnd(run) {
  getStorage([STORAGE_KEYS.serverWsUrl]).then(async (data) => {
    try {
      let wsUrl = normalizeWsUrl(data[STORAGE_KEYS.serverWsUrl]);
      try {
        assertValidWsUrl(wsUrl);
      } catch (e) {
        enterRoomPending = false;
        broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
        return;
      }
      try {
        wsUrl = await preferIpv4WsUrl(wsUrl);
      } catch (_) {
        /* 解析失败则仍用原始 URL */
      }
      closeSocket();
      try {
        socket = new WebSocket(wsUrl);
        activeWsUrl = wsUrl;
      } catch (e) {
        activeWsUrl = null;
        enterRoomPending = false;
        broadcastState({ lastError: '无法连接：' + (e && e.message) });
        return;
      }
      socket.onopen = () => {
        lastError = null;
        pendingDisconnectBanner = null;
        broadcastState({ lastError: null });
        startHeartbeat();
        if (typeof run === 'function') run();
      };
      socket.onmessage = (ev) => handleServerMessage(ev.data);
      socket.onclose = (ev) => {
        const hadSession = !!currentRoomId;
        stopHeartbeat();
        if (enterRoomPending) {
          enterRoomPending = false;
        }
        if (reconnectAfterHeartbeat) {
          reconnectAfterHeartbeat = false;
          pendingDisconnectBanner = null;
          clearWsSessionStateAfterClose();
          tryReconnectAfterHeartbeatFailure();
          return;
        }
        clearWsSessionStateAfterClose();
        let banner = pendingDisconnectBanner;
        pendingDisconnectBanner = null;
        if (!banner) {
          if (!hadSession) {
            if (ev.code === 1006 || ev.code === 1002) {
              banner =
                '无法建立 WebSocket（关闭码 ' +
                ev.code +
                '）。请核对：服务端口与 ws/wss 是否一致、防火墙是否放行。若仅 IP 能连而域名不能，多为 IPv6(AAAA) 或 DNS：明文 ws:// 已尝试优先 IPv4；仍失败可修正域名 AAAA 记录，或暂用 IP。wss 须证书匹配域名，无法自动改 IP。';
            } else {
              banner =
                '无法连接房间服务（关闭码 ' +
                ev.code +
                (ev.reason ? '：' + ev.reason : '') +
                '）。';
            }
          } else if (!ev.wasClean || (ev.code !== 1000 && ev.code !== 1001)) {
            banner = '连接已断开（码 ' + ev.code + (ev.reason ? '：' + ev.reason : '') + '）';
          } else {
            banner = '连接已断开';
          }
        }
        lastError = banner;
        broadcastState({ lastError: banner });
      };
      socket.onerror = () => {
        enterRoomPending = false;
      };
    } catch (e) {
      enterRoomPending = false;
      broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
    }
  }).catch((e) => {
    enterRoomPending = false;
    broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
  });
}

function sendRaw(obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (enterRoomPending) enterRoomPending = false;
    broadcastState({ lastError: '未连接到房间服务' });
    return false;
  }
  if (coWatchDebug && obj && typeof obj === 'object' && obj.type) {
    const t = obj.type;
    if (t === 'ping' || t === 'video_sync') {
      /* 高频：不记日志 */
    } else if (t === 'navigate') dbg('ws→', t, /** @type {{ url?: string }} */ (obj).url);
    else dbg('ws→', t);
  }
  socket.send(JSON.stringify(obj));
  return true;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action } = request || {};

  if (action === 'setCoWatchDebug') {
    const on = !!request.enabled;
    setStorage({ [STORAGE_KEYS.coWatchDebug]: on }).then(() => {
      coWatchDebug = on;
      console.log('[co-watch]', new Date().toISOString(), 'debug logging', on ? 'on' : 'off');
      sendResponse({ ok: true, coWatchDebug: on });
    });
    return true;
  }

  if (action === 'getState') {
    Promise.all([
      getStorage([
        STORAGE_KEYS.serverWsUrl,
        STORAGE_KEYS.roomId,
        STORAGE_KEYS.role,
        STORAGE_KEYS.followedTabId,
        STORAGE_KEYS.lastRoomKey,
        STORAGE_KEYS.displayName,
      ]),
    ]).then(([data]) => {
      const connected = !!(socket && socket.readyState === WebSocket.OPEN);
      const fid = connected ? (data[STORAGE_KEYS.followedTabId] ?? null) : null;
      const base = {
        serverWsUrl: data[STORAGE_KEYS.serverWsUrl] || DEFAULT_WS,
        roomId: connected ? (currentRoomId || data[STORAGE_KEYS.roomId] || null) : null,
        role: connected ? resolveEffectiveRole(data[STORAGE_KEYS.role]) : null,
        followedTabId: fid,
        lastRoomKey: data[STORAGE_KEYS.lastRoomKey] ?? null,
        displayName: data[STORAGE_KEYS.displayName] ?? '',
        roomMembers: connected ? roomMembers : [],
        roomConnected: !!(connected && currentRoomId),
        playlistItems: connected && currentRoomId ? playlistItems : [],
        playlistWatchedCount: connected && currentRoomId ? playlistWatchedCountFromServer : 0,
        connected,
        clientId: connected ? clientId : null,
        lastError,
        enterRoomPending,
        localExtensionVersion: String(
          (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
        ),
        serverExtensionVersion,
        extensionUpdateAvailable,
        extensionDownloadUrl,
        coWatchDebug,
      };
      const finish = (tabTitle, tabUrl) => {
        sendResponse({
          ...base,
          playlistCurrentId:
            connected && currentRoomId
              ? resolvePlaylistCurrentIdForUi(tabTitle, tabUrl, playlistCurrentIdFromServer)
              : null,
        });
      };
      if (fid == null || !connected || !currentRoomId) {
        finish(null, null);
        return;
      }
      chrome.tabs.get(fid, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          finish(null, null);
          return;
        }
        finish(tab.title || '', tab.url || '');
      });
    });
    return true;
  }

  if (action === 'setServerUrl') {
    const url = normalizeWsUrl(request.url);
    setStorage({ [STORAGE_KEYS.serverWsUrl]: url }).then(() => {
      sendResponse({ ok: true, serverWsUrl: url });
    });
    return true;
  }

  if (action === 'downloadExtensionUpdate') {
    const url = extensionDownloadUrl;
    const ver = serverExtensionVersion || 'update';
    if (!url) {
      sendResponse({ ok: false, error: '无可用的下载地址，请先连接到房间服务' });
      return false;
    }
    const safeVer = String(ver).replace(/[^\w.\-+]/g, '_');
    // saveAs: false：使用浏览器默认下载目录与内置下载流程，不弹出系统「另存为」
    // 版本紧贴 .zip 前，与服务端 Content-Disposition co-watch-extension-{ver}.zip 一致
    chrome.downloads.download(
      {
        url,
        filename: `co-watch-extension-${safeVer}.zip`,
        saveAs: false,
      },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message || '下载失败' });
          return;
        }
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  if (action === 'enterRoom') {
    const roomKey = String(request.roomKey || '').trim();
    if (roomKey.length < 1 || roomKey.length > 128) {
      sendResponse({ ok: false, error: '房间密码需为 1～128 个字符' });
      return false;
    }
    const ft = request.followTabId;
    pendingFollowTabId = typeof ft === 'number' && ft >= 0 ? ft : null;
    enterRoomPending = true;
    broadcastState({ lastError: null });
    getStorage([STORAGE_KEYS.displayName]).then((data) => {
      const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
      connectAnd(() => {
        sendRaw({ type: 'enter_room', roomKey, displayName });
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (action === 'setDisplayName') {
    const displayName = normalizeDisplayName(request.displayName);
    setStorage({ [STORAGE_KEYS.displayName]: displayName }).then(() => {
      if (currentRoomId && socket && socket.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'set_display_name', displayName });
      }
      broadcastState();
      sendResponse({ ok: true, displayName });
    });
    return true;
  }

  if (action === 'syncContext') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId == null) {
      sendResponse({
        syncActive: false,
        roomConnected: false,
        isFollowedTab: false,
        isHost: false,
        isMember: false,
        lastRoomKey: null,
        clientId: null,
        roomMembers: [],
        playlistItems: [],
        playlistCurrentId: null,
        /** 与服务端 playlist_state.currentId 一致，供房主自动连播算「下一集」；与 UI 用 resolve 的 playlistCurrentId 分离 */
        playlistCurrentIdForAdvance: null,
        playlistWatchedCount: 0,
        localExtensionVersion: String(
          (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
        ),
        serverExtensionVersion: null,
        extensionUpdateAvailable: false,
        extensionDownloadUrl: '',
      });
      return false;
    }
    getStorage([
      STORAGE_KEYS.followedTabId,
      STORAGE_KEYS.lastRoomKey,
      STORAGE_KEYS.role,
    ]).then((data) => {
      const followed = data[STORAGE_KEYS.followedTabId];
      const connected = !!(socket && socket.readyState === WebSocket.OPEN);
      const roomConnected = !!(currentRoomId && connected);
      const isFollowedTab = followed === tabId;
      const syncActive = roomConnected && isFollowedTab;
      const role = resolveEffectiveRole(data[STORAGE_KEYS.role]);
      const localExtensionVersion = String(
        (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
      );
      const respond = (followedTabTitle, followedTabUrl) => {
        sendResponse({
          syncActive: !!syncActive,
          roomConnected: !!roomConnected,
          isFollowedTab: !!isFollowedTab,
          isHost: !!(roomConnected && role === 'host'),
          isMember: !!(roomConnected && role === 'member'),
          lastRoomKey: data[STORAGE_KEYS.lastRoomKey] ?? null,
          clientId,
          roomMembers,
          playlistItems: roomConnected ? playlistItems : [],
          playlistCurrentId: roomConnected
            ? resolvePlaylistCurrentIdForUi(
                followedTabTitle,
                followedTabUrl,
                playlistCurrentIdFromServer
              )
            : null,
          playlistCurrentIdForAdvance: roomConnected
            ? typeof playlistCurrentIdFromServer === 'string' && playlistCurrentIdFromServer.trim()
              ? playlistCurrentIdFromServer.trim()
              : resolvePlaylistCurrentIdForUi(followedTabTitle, followedTabUrl, null)
            : null,
          playlistWatchedCount: roomConnected ? playlistWatchedCountFromServer : 0,
          localExtensionVersion,
          serverExtensionVersion,
          extensionUpdateAvailable: !!(
            extensionUpdateAvailable &&
            extensionDownloadUrl &&
            typeof extensionDownloadUrl === 'string' &&
            extensionDownloadUrl.length > 0
          ),
          extensionDownloadUrl: extensionDownloadUrl || '',
        });
      };
      if (!roomConnected || followed == null) {
        respond(null, null);
        return;
      }
      chrome.tabs.get(followed, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          respond(null, null);
          return;
        }
        respond(tab.title || '', tab.url || '');
      });
    });
    return true;
  }

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
          lastPlaylistTitleSentByUrlKey[normalizeUrlKeyForCoWatch(urlNow)] = (t.title || '').trim();
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

// ---- 右键菜单：一键开始/发送到协同浏览 ----
const CONTEXT_MENU_ID = 'co_watch_context';

function isSocketConnected() {
  return !!(socket && socket.readyState === WebSocket.OPEN);
}

function getTabUrl(tab) {
  try {
    return (tab && tab.url ? String(tab.url) : '').trim();
  } catch {
    return '';
  }
}

/**
 * 右键「开始协同浏览」：先断开 WebSocket 并清空房间内存与 storage 中的房间字段，再按上次房间密码重连并绑定 tabId 为跟随页。
 */
function contextMenuReconnectAndEnterRoom(tabId) {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.displayName]).then((data) => {
    const roomKey = String(data[STORAGE_KEYS.lastRoomKey] || '').trim();
    const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
    if (!roomKey) {
      broadcastState({ lastError: '需先在弹窗中保存过房间密码' });
      return;
    }
    enterRoomPending = true;
    broadcastState({ lastError: null });
    pendingFollowTabId = tabId;
    disconnectSocketAndClearRoomMemory();
    setStorage({
      [STORAGE_KEYS.roomId]: null,
      [STORAGE_KEYS.role]: null,
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    }).then(() => {
      connectAnd(() => {
        sendRaw({ type: 'enter_room', roomKey, displayName });
      });
    });
  });
}

function updateContextMenuTitle(enabled, title) {
  // contextMenus.update 在 SW 被唤醒后可用；如果尚未创建菜单，会抛错，因此只在已创建后调用。
  try {
    chrome.contextMenus.update(CONTEXT_MENU_ID, { enabled: !!enabled, title: String(title || '') });
  } catch (e) {
    // ignore
  }
}

/**
 * 根据当前连接状态与 storage 刷新右键菜单启用状态与标题。
 * broadcastState 与 contextMenus.onShown 均调用此函数；部分环境 onShown 不可靠，故状态变化时也必须走此处。
 * @param {{ followedTabId?: number | null }} [hints] 已知有效绑定时传入，避免 storage 读回滞后（尤其 Edge）
 */
function refreshContextMenuTitle(hints) {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.followedTabId]).then((data) => {
    const roomKey = data[STORAGE_KEYS.lastRoomKey];
    let followed = data[STORAGE_KEYS.followedTabId];
    if (hints && Object.prototype.hasOwnProperty.call(hints, 'followedTabId')) {
      followed = hints.followedTabId;
    }
    const connected = isSocketConnected();
    if (connected) {
      if (followed != null) {
        updateContextMenuTitle(true, '发送到协同浏览');
      } else {
        updateContextMenuTitle(true, '开始协同浏览');
      }
      return;
    }
    if (!roomKey) {
      updateContextMenuTitle(false, '开始协同浏览（需先设置房间密码）');
      return;
    }
    updateContextMenuTitle(true, '开始协同浏览');
  });
}

/** Chrome API 要求 create(createProperties)，id 必须写在对象里；原先两参数写法无效，菜单不会出现 */
function ensureContextMenu() {
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: '协同浏览',
      contexts: ['page'],
    },
    () => {
      void chrome.runtime.lastError;
      refreshContextMenuTitle();
    }
  );
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  enterRoomPending = false;
  disconnectSocketAndClearRoomMemory();
  clearPersistedRoomSessionFromStorage().then(() => {
    broadcastState({ lastError: null }, { followedTabId: null });
  });
});

// MV3：浏览器重启后 onInstalled 不会触发，需在 Service Worker 启动时确保菜单存在
ensureContextMenu();

if (chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener(() => {
    refreshContextMenuTitle();
  });
}

/**
 * 与右键「发送到协同浏览」一致：先绑定跟随标签再 sendNavigateReliable，必要时关闭旧跟随标签。
 * @param {number} tabId
 * @param {(r?: object) => void} [sendResponse]
 */
function runSendToCoWatchSameAsContextMenu(tabId, sendResponse) {
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const oldFollowId = data[STORAGE_KEYS.followedTabId];
    if (oldFollowId == null) {
      if (sendResponse) sendResponse({ ok: false, error: '未设置跟随页' });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        if (sendResponse) sendResponse({ ok: false });
        return;
      }
      const url = getTabUrl(tab);
      if (!url || !isAllowedHttpUrl(url)) {
        broadcastState({ lastError: '仅支持 http/https 页面' });
        if (sendResponse) sendResponse({ ok: false, error: '仅支持 http/https 页面' });
        return;
      }
      setStorage({ [STORAGE_KEYS.followedTabId]: tabId }).then(() => {
        const ok = sendNavigateReliable(url, tab.title || '', {
          skipPlaylistInsert: true,
          roomSyncNavigate: true,
        });
        if (!ok) {
          setStorage({ [STORAGE_KEYS.followedTabId]: oldFollowId }).then(() => {
            broadcastState(
              { lastError: '未连接到房间服务' },
              oldFollowId != null ? { followedTabId: oldFollowId } : { followedTabId: null }
            );
          });
          if (sendResponse) sendResponse({ ok: false });
          return;
        }
        maybePlaylistNavigateAfterSkipCoWatch(tabId, url);
        notifyFloater(tabId, true);
        if (oldFollowId != null && oldFollowId !== tabId) {
          notifyFloater(oldFollowId, false);
        }
        pushRosterToFollowedTab();
        broadcastState(undefined, { followedTabId: tabId });
        if (oldFollowId != null && oldFollowId !== tabId) {
          chrome.tabs.remove(oldFollowId, () => void chrome.runtime.lastError);
        }
        if (sendResponse) sendResponse({ ok: true });
      });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  const tabId = tab.id;
  const url = getTabUrl(tab);
  const allowUrl = !!(url && isAllowedHttpUrl(url));

  if (isSocketConnected()) {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      const oldFollowId = data[STORAGE_KEYS.followedTabId];
      if (oldFollowId == null) {
        // 已连接但未设跟随页：先断开再重连，与未连接时「开始协同浏览」一致，避免半开连接/陈旧状态
        contextMenuReconnectAndEnterRoom(tabId);
        return;
      }
      if (!allowUrl) {
        broadcastState({ lastError: '仅支持 http/https 页面' });
        return;
      }
      runSendToCoWatchSameAsContextMenu(tabId);
    });
    return;
  }

  // 未连接「开始协同浏览」：先断开再连接（与已连接但未设跟随时同一路径）
  contextMenuReconnectAndEnterRoom(tabId);
});

loadCoWatchDebugFlag().catch(() => {});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.coWatchDebug]) return;
    coWatchDebug = !!changes[STORAGE_KEYS.coWatchDebug].newValue;
  });
} catch (_) {
  /* ignore */
}
