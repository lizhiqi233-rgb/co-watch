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

const DEFAULT_WS = 'ws://127.0.0.1:15777';

/** @type {WebSocket | null} */
let socket = null;
let connectionGeneration = 0;
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
/** @type {Array<{ id: string, url: string, title: string, addedBy?: string }>} */
let playlistItems = [];
/** 服务端 playlist_state.currentId（房主点「播放」等）；UI 高亮优先用跟随标签标题与列表标题匹配 */
/** @type {string | null} */
let playlistCurrentIdFromServer = null;
/** 服务端 playlist 已看过条数，用于悬浮窗隐藏「已播放」 */
let playlistWatchedCountFromServer = 0;
/** 加入队列成功后待关闭的标签 id（收到 playlist_add_ack 后关闭） */
/** @type {number | null} */
let tabToCloseAfterPlaylistAddAck = null;
/** 抢房主机制的全房间冷却截止时间（毫秒时间戳，来自 room_roster） */
/** @type {number | null} */
let claimHostCooldownUntil = null;

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
      const it = /** @type {{ id: string, url: string, title?: string, addedBy?: unknown, readStatus?: unknown }} */ (x);
      return {
        id: it.id,
        url: it.url,
        title: typeof it.title === 'string' ? it.title : '',
        addedBy: typeof it.addedBy === 'string' ? it.addedBy.trim().slice(0, 32) : '',
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
