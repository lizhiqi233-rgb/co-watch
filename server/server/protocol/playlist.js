const {
  enrichBilibiliPlaylistTitle,
  normalizeReadStatus,
} = require('../../extension/shared/utils.js');
const {
  applyReadingFocus,
  findPlaylistIndexByUrl,
  genPlaylistItemId,
  isHttpUrl,
  normalizePlaylistUrlKey,
} = require('../rooms/state.js');
const { getPeer, requireRoom, sendJson, sendServerNotice } = require('./context.js');

function sendPlaylistAck(ctx, type) {
  sendJson(ctx, { type });
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

function handlePlaylistAdd(ctx, message) {
  if (!ctx.clientRoom) {
    sendServerNotice(ctx, '未加入房间', 'playlist_add');
    return;
  }
  const url = typeof message.url === 'string' ? message.url.trim() : '';
  if (!url) {
    sendServerNotice(ctx, '缺少网址', 'playlist_add');
    return;
  }
  if (!isHttpUrl(url)) {
    sendServerNotice(ctx, '仅支持 http:// 或 https:// 网址', 'playlist_add');
    return;
  }

  const urlCanonical = normalizePlaylistUrlKey(url);
  const state = ctx.manager.getOrInitRoomState(ctx.clientRoom);
  const items = Array.isArray(state.playlistItems) ? state.playlistItems.slice() : [];
  const duplicateIndex = findPlaylistIndexByUrl(items, urlCanonical);
  if (duplicateIndex >= 0) {
    const others = items.filter((_, index) => index !== duplicateIndex);
    const title = enrichBilibiliPlaylistTitle(urlCanonical, message.title, others);
    items[duplicateIndex] = {
      ...items[duplicateIndex],
      url: urlCanonical,
      title,
      addedBy: resolvePlaylistAddedBy(ctx, items[duplicateIndex]),
      readStatus: normalizeReadStatus(items[duplicateIndex].readStatus),
    };
    state.playlistItems = items;
    ctx.debug('playlist_add dup', { duplicateIndex, url: ctx.dbgUrl(urlCanonical) });
    ctx.manager.broadcastPlaylistState(ctx.clientRoom);
    sendPlaylistAck(ctx, 'playlist_add_ack');
    return;
  }
  if (items.length >= ctx.config.playlistMaxItems) {
    sendServerNotice(ctx, '播放列表已达上限', 'playlist_add');
    return;
  }

  const item = {
    id: genPlaylistItemId(),
    url: urlCanonical,
    title: enrichBilibiliPlaylistTitle(urlCanonical, message.title, items),
    addedBy: resolvePlaylistAddedBy(ctx),
    readStatus: 'unread',
  };
  items.push(item);
  state.playlistItems = items;
  ctx.debug('playlist_add new', { id: item.id, url: ctx.dbgUrl(urlCanonical), dup: false });
  ctx.manager.broadcastPlaylistState(ctx.clientRoom);
  sendPlaylistAck(ctx, 'playlist_add_ack');
}

function handlePlaylistRemove(ctx, message) {
  if (!requireRoom(ctx, '未加入房间')) return;
  const id = typeof message.id === 'string' ? message.id.trim() : '';
  if (!id) return;
  const state = ctx.manager.getOrInitRoomState(ctx.clientRoom);
  const items = Array.isArray(state.playlistItems) ? state.playlistItems.slice() : [];
  const index = items.findIndex((item) => item && item.id === id);
  if (index === -1) return;
  items.splice(index, 1);
  state.playlistItems = items;
  if (state.playlistCurrentId === id) state.playlistCurrentId = null;
  ctx.manager.broadcastPlaylistState(ctx.clientRoom);
}

function applyPlaylistSelection(ctx, message, options) {
  const id = typeof message.id === 'string' ? message.id.trim() : '';
  if (!id) return;
  const state = ctx.manager.getOrInitRoomState(ctx.clientRoom);
  const items = Array.isArray(state.playlistItems) ? state.playlistItems : [];
  const item = items.find((entry) => entry && entry.id === id);
  if (!item || !isHttpUrl(item.url)) {
    sendServerNotice(ctx, '播放项不存在', options.noticeCode);
    return;
  }

  applyReadingFocus(state, id);
  const navigateUrl = normalizePlaylistUrlKey(item.url);
  const previousUrl = state.lastNavigateUrl;
  state.lastNavigateUrl = navigateUrl;
  if (previousUrl !== navigateUrl) ctx.manager.resetJumpVerifyRound(ctx.clientRoom);
  ctx.manager.resetVideoSnapshot(ctx.clientRoom);
  ctx.debug(options.debugType, {
    id,
    url: ctx.dbgUrl(navigateUrl),
    [options.countLabel]: items.filter(
      (entry) => entry && normalizeReadStatus(entry.readStatus) === 'read'
    ).length,
  });
  if (options.broadcastNavigate) {
    ctx.manager.broadcastRoom(ctx.clientRoom, { type: 'navigate', url: navigateUrl });
    sendJson(ctx, { type: 'navigate_ack', url: navigateUrl });
  }
  ctx.manager.broadcastPlaylistState(ctx.clientRoom);
}

function handlePlaylistSelect(ctx, message) {
  if (!requireRoom(ctx, '未加入房间')) return;
  const peer = getPeer(ctx);
  if (!peer || peer.role !== 'host') {
    sendServerNotice(ctx, '仅房主可选定播放');
    return;
  }
  applyPlaylistSelection(ctx, message, {
    debugType: 'playlist_select',
    countLabel: 'watchedCount',
    broadcastNavigate: true,
  });
}

function handlePlaylistCurrentMatch(ctx, message) {
  if (!ctx.clientRoom) {
    sendServerNotice(ctx, '未加入房间', 'playlist_current_match');
    return;
  }
  const peer = getPeer(ctx);
  if (!peer || peer.role !== 'host') {
    sendServerNotice(ctx, '仅房主可同步当前播放', 'playlist_current_match');
    return;
  }
  applyPlaylistSelection(ctx, message, {
    debugType: 'playlist_current_match',
    countLabel: 'readCount',
    noticeCode: 'playlist_current_match',
    broadcastNavigate: false,
  });
}

function handlePlaylistMessage(ctx, message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'playlist_add') {
    handlePlaylistAdd(ctx, message);
    return true;
  }
  if (message.type === 'playlist_remove') {
    handlePlaylistRemove(ctx, message);
    return true;
  }
  if (message.type === 'playlist_select') {
    handlePlaylistSelect(ctx, message);
    return true;
  }
  if (message.type === 'playlist_current_match') {
    handlePlaylistCurrentMatch(ctx, message);
    return true;
  }
  return false;
}

module.exports = { handlePlaylistMessage };
