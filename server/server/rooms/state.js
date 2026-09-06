const {
  normalizeReadStatus,
  normalizeUrlKeyForCoWatch,
  isAllowedHttpUrl,
} = require('../../extension/shared/utils.js');

const normalizePlaylistUrlKey = normalizeUrlKeyForCoWatch;
const isHttpUrl = isAllowedHttpUrl;
const PLAYLIST_MAX_ITEMS = 100;

function defaultRoomState() {
  return {
    lastNavigateUrl: null,
    lastVideoTime: null,
    lastPlaybackRate: null,
    lastVideoPlaying: false,
    playlistItems: [],
    playlistCurrentId: null,
    playlistWatchedCount: 0,
  };
}

function normalizeRoomKey(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text.length < 1 || text.length > 128) return '';
  return text;
}

function genClientId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function genPlaylistItemId() {
  return 'pl' + genClientId();
}

function findPlaylistIndexByUrl(items, url) {
  const key = normalizePlaylistUrlKey(url);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && normalizePlaylistUrlKey(item.url) === key) return i;
  }
  return -1;
}

function applyReadingFocus(state, focusedId) {
  if (!state || !focusedId || !Array.isArray(state.playlistItems)) return;
  for (const item of state.playlistItems) {
    if (!item || !item.id) continue;
    item.readStatus = normalizeReadStatus(item.readStatus);
    if (item.readStatus === 'reading' && item.id !== focusedId) {
      item.readStatus = 'read';
    }
  }
  const focus = state.playlistItems.find((item) => item && item.id === focusedId);
  if (focus) focus.readStatus = 'reading';
  state.playlistCurrentId = focusedId;
}

function dedupePlaylistByUrl(state) {
  const items = Array.isArray(state.playlistItems) ? state.playlistItems.slice() : [];
  let currentId = typeof state.playlistCurrentId === 'string' && state.playlistCurrentId
    ? state.playlistCurrentId
    : null;
  const seen = new Map();
  const output = [];

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.url) continue;
    const key = normalizePlaylistUrlKey(item.url);
    const keepIndex = seen.get(key);
    if (keepIndex !== undefined) {
      const keepId = output[keepIndex].id;
      if (currentId === item.id) currentId = keepId;
      const keptStatus = normalizeReadStatus(output[keepIndex].readStatus);
      const duplicateStatus = normalizeReadStatus(item.readStatus);
      if (keptStatus === 'reading' || duplicateStatus === 'reading') {
        output[keepIndex].readStatus = 'reading';
      } else if (keptStatus === 'read' || duplicateStatus === 'read') {
        output[keepIndex].readStatus = 'read';
      } else {
        output[keepIndex].readStatus = 'unread';
      }
      continue;
    }
    seen.set(key, output.length);
    item.readStatus = normalizeReadStatus(item.readStatus);
    output.push(item);
  }

  state.playlistItems = output;
  state.playlistCurrentId = currentId;
  state.playlistWatchedCount = output.filter(
    (item) => item && normalizeReadStatus(item.readStatus) === 'read'
  ).length;
}

function getPlaylistPayload(state) {
  if (!state || !Array.isArray(state.playlistItems)) {
    return { items: [], currentId: null, watchedCount: 0 };
  }
  dedupePlaylistByUrl(state);
  const currentId = typeof state.playlistCurrentId === 'string' && state.playlistCurrentId
    ? state.playlistCurrentId
    : null;
  return {
    items: state.playlistItems,
    currentId,
    watchedCount: state.playlistWatchedCount,
  };
}

function getOrInitRoomState(roomState, roomId) {
  let state = roomState.get(roomId);
  if (!state) {
    state = defaultRoomState();
    roomState.set(roomId, state);
    return state;
  }
  if (!Array.isArray(state.playlistItems)) state.playlistItems = [];
  if (!('playlistCurrentId' in state)) state.playlistCurrentId = null;
  if (
    !('playlistWatchedCount' in state) ||
    typeof state.playlistWatchedCount !== 'number' ||
    state.playlistWatchedCount < 0
  ) {
    state.playlistWatchedCount = 0;
  }
  return state;
}

function mergeHostVideoSnapshot(state, action, message) {
  if (!state) return;
  const currentTime = message.currentTime;
  if (typeof currentTime === 'number' && !isNaN(currentTime) && currentTime >= 0 && currentTime < 1e12) {
    state.lastVideoTime = currentTime;
  }
  const playbackRate = message.playbackRate;
  if (typeof playbackRate === 'number' && playbackRate > 0 && playbackRate <= 4) {
    state.lastPlaybackRate = playbackRate;
  }
  if (action === 'play') state.lastVideoPlaying = true;
  else if (action === 'pause') state.lastVideoPlaying = false;
  else if (action === 'time') {
    if (message.playing === false) state.lastVideoPlaying = false;
    else if (message.playing === true) state.lastVideoPlaying = true;
    else state.lastVideoPlaying = true;
  }
}

function computeJumpSyncedDisplay(peer, canonicalUrl) {
  if (!canonicalUrl) return null;
  if (peer.jvSuccess === true) return true;
  if (peer.jvSuccess === false) return false;
  const attempts = peer.jvAttempts | 0;
  if (attempts === 0) return null;
  return false;
}

module.exports = {
  PLAYLIST_MAX_ITEMS,
  applyReadingFocus,
  computeJumpSyncedDisplay,
  defaultRoomState,
  findPlaylistIndexByUrl,
  genClientId,
  genPlaylistItemId,
  getOrInitRoomState,
  getPlaylistPayload,
  isHttpUrl,
  mergeHostVideoSnapshot,
  normalizePlaylistUrlKey,
  normalizeRoomKey,
};
