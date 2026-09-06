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
let lastPlaylistTitleSentByUrlKey = new Map();
/** 房主跟随标签 URL 变更后合并再发 navigate，过小易在 SPA 连续 push 时重复广播 */
const HOST_FOLLOW_TAB_NAV_DEBOUNCE_MS = 120;
/** @type {ReturnType<typeof setTimeout> | null} */
let hostFollowTabNavDebounceTimer = null;
const MAX_PLAYLIST_TITLE_CACHE_ENTRIES = 256;
const STATE_BROADCAST_DEBOUNCE_MS = 100;
let stateBroadcastTimer = null;
let pendingStateExtra = null;
let pendingStateHints = null;
let rosterPushTimer = null;

function rememberPlaylistTitle(key, title) {
  if (lastPlaylistTitleSentByUrlKey.get(key) === title) return false;
  lastPlaylistTitleSentByUrlKey.delete(key);
  lastPlaylistTitleSentByUrlKey.set(key, title);
  while (lastPlaylistTitleSentByUrlKey.size > MAX_PLAYLIST_TITLE_CACHE_ENTRIES) {
    const oldestKey = lastPlaylistTitleSentByUrlKey.keys().next().value;
    lastPlaylistTitleSentByUrlKey.delete(oldestKey);
  }
  return true;
}

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
function clearSessionTimers() {
  if (playlistReadSyncDebounceTimer != null) {
    clearTimeout(playlistReadSyncDebounceTimer);
    playlistReadSyncDebounceTimer = null;
  }
  if (hostFollowTabNavDebounceTimer != null) {
    clearTimeout(hostFollowTabNavDebounceTimer);
    hostFollowTabNavDebounceTimer = null;
  }
  if (rosterPushTimer != null) {
    clearTimeout(rosterPushTimer);
    rosterPushTimer = null;
  }
}
function buildNavigatePayload(url, title, skipPlaylistInsert, roomSyncNavigate) {
  const payload = { type: 'navigate', url };
  if (title != null) payload.title = title;
  if (skipPlaylistInsert) payload.skipPlaylistInsert = true;
  if (roomSyncNavigate) payload.roomSyncNavigate = true;
  return payload;
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
  const payload = buildNavigatePayload(
    trimmed,
    navigateAckTitle,
    navigateAckSkipPlaylistInsert,
    navigateAckRoomSync
  );
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
      const retry = buildNavigatePayload(
        navigateAckUrl,
        navigateAckTitle,
        navigateAckSkipPlaylistInsert,
        navigateAckRoomSync
      );
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
