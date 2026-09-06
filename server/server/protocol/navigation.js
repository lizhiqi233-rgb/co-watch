const { enrichBilibiliPlaylistTitle } = require('../../extension/shared/utils.js');
const {
  applyReadingFocus,
  findPlaylistIndexByUrl,
  genPlaylistItemId,
  isHttpUrl,
  normalizePlaylistUrlKey,
} = require('../rooms/state.js');
const { getPeer, requireRoom, sendError, sendJson } = require('./context.js');

function sendNavigateAck(ctx, url) {
  sendJson(ctx, { type: 'navigate_ack', url });
}
function resolvePlaylistAddedBy(ctx, item) {
  const existing =
    item && typeof item.addedBy === 'string' ? item.addedBy.trim().slice(0, 32) : '';
  if (existing) return existing;
  const peer = getPeer(ctx);
  const displayName =
    peer && typeof peer.displayName === 'string' ? peer.displayName.trim().slice(0, 32) : '';
  return displayName || '访客';
}

function handleNavigate(ctx, message) {
  if (!requireRoom(ctx)) return;
  const url = typeof message.url === 'string' ? message.url.trim() : '';
  if (!url) {
    sendError(ctx, '缺少网址');
    return;
  }
  if (!isHttpUrl(url)) {
    sendError(ctx, '仅支持 http:// 或 https:// 网址');
    return;
  }

  const urlCanonical = normalizePlaylistUrlKey(url);
  const peer = getPeer(ctx);
  const isHost = !!(peer && peer.role === 'host');
  const roomSyncNavigate =
    message.roomSyncNavigate === true || message.roomSyncNavigate === 'true';
  const state = ctx.manager.getOrInitRoomState(ctx.clientRoom);
  const previousCanonical = state.lastNavigateUrl;
  state.lastNavigateUrl = urlCanonical;
  if (previousCanonical !== urlCanonical) {
    ctx.manager.resetJumpVerifyRound(ctx.clientRoom);
  }
  ctx.manager.resetVideoSnapshot(ctx.clientRoom);

  if (!isHost && !roomSyncNavigate) {
    const items = Array.isArray(state.playlistItems) ? state.playlistItems : [];
    const itemIndex = findPlaylistIndexByUrl(items, urlCanonical);
    state.playlistCurrentId = itemIndex >= 0 && items[itemIndex] && items[itemIndex].id
      ? items[itemIndex].id
      : null;
    ctx.manager.broadcastRoom(ctx.clientRoom, { type: 'navigate', url: urlCanonical });
    ctx.manager.broadcastPlaylistState(ctx.clientRoom);
    sendNavigateAck(ctx, urlCanonical);
    return;
  }

  const items = Array.isArray(state.playlistItems) ? state.playlistItems.slice() : [];
  const existingIndex = findPlaylistIndexByUrl(items, urlCanonical);
  const skipPlaylistInsert =
    message.skipPlaylistInsert === true || message.skipPlaylistInsert === 'true';
  ctx.debug('navigate', {
    host: isHost,
    roomSyncNavigate,
    url: ctx.dbgUrl(urlCanonical),
    existingIndex,
    skipPlaylistInsert,
    listLen: items.length,
  });

  if (existingIndex >= 0) {
    const others = items.filter((_, index) => index !== existingIndex);
    const rawTitle = message.title != null ? message.title : items[existingIndex].title;
    const title = enrichBilibiliPlaylistTitle(urlCanonical, rawTitle, others);
    items[existingIndex] = {
      ...items[existingIndex],
      url: urlCanonical,
      title,
      addedBy: resolvePlaylistAddedBy(ctx, items[existingIndex]),
    };
    applyReadingFocus(state, items[existingIndex].id);
    if (skipPlaylistInsert) {
      ctx.manager.broadcastPlaylistState(ctx.clientRoom);
      sendNavigateAck(ctx, urlCanonical);
      return;
    }
  } else if (skipPlaylistInsert) {
    state.playlistItems = items;
    state.playlistCurrentId = null;
  } else {
    if (items.length >= ctx.config.playlistMaxItems) {
      state.playlistItems = items;
      state.playlistCurrentId = null;
      ctx.manager.broadcastRoom(ctx.clientRoom, { type: 'navigate', url: urlCanonical });
      ctx.manager.broadcastPlaylistState(ctx.clientRoom);
      sendNavigateAck(ctx, urlCanonical);
      return;
    }
    const title = enrichBilibiliPlaylistTitle(urlCanonical, message.title, items);
    const item = {
      id: genPlaylistItemId(),
      url: urlCanonical,
      title,
      addedBy: resolvePlaylistAddedBy(ctx),
      readStatus: 'unread',
    };
    items.push(item);
    state.playlistItems = items;
    applyReadingFocus(state, item.id);
  }

  ctx.manager.broadcastRoom(ctx.clientRoom, { type: 'navigate', url: urlCanonical });
  ctx.manager.broadcastPlaylistState(ctx.clientRoom);
  sendNavigateAck(ctx, urlCanonical);
}

function handleNavigationMessage(ctx, message) {
  if (!message || message.type !== 'navigate') return false;
  handleNavigate(ctx, message);
  return true;
}

module.exports = { handleNavigationMessage };
