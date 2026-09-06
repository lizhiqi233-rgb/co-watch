const { normalizeDisplayName } = require('../../extension/shared/utils.js');
const { isHttpUrl, normalizeRoomKey } = require('../rooms/state.js');
const { getPeer, sendError, sendJson, sendServerNotice } = require('./context.js');

function createPeer(id, role, displayName) {
  return {
    id,
    role,
    displayName,
    lastRttMs: null,
    jvAttempts: 0,
    jvSuccess: null,
    jumpDesyncSince: null,
  };
}

function handleEnterRoom(ctx, message) {
  if (ctx.clientRoom) {
    sendError(ctx, '已在房间内，请勿重复进房');
    return;
  }
  const key = normalizeRoomKey(typeof message.roomKey === 'string' ? message.roomKey : '');
  if (!key) {
    sendError(ctx, '房间密码需为 1～128 个字符');
    return;
  }

  const displayName = normalizeDisplayName(message.displayName);
  if (!ctx.manager.hasRoom(key)) {
    const result = ctx.manager.createRoom(
      key,
      ctx.ws,
      createPeer(ctx.clientId, 'host', displayName)
    );
    if (!result.ok) {
      sendError(ctx, result.reason === 'room_limit' ? '房间数已达上限' : '进房失败');
      return;
    }
    ctx.clientRoom = key;
    sendJson(ctx, {
      type: 'room_created',
      roomId: key,
      role: 'host',
      clientId: ctx.clientId,
      playlist: ctx.manager.getPlaylistPayload(key),
    });
    ctx.manager.emitRoster(key);
    ctx.debug('enter_room host', { room: key, clientId: ctx.clientId });
    return;
  }

  if (ctx.manager.getRoomSize(key) >= ctx.config.maxRoomClients) {
    sendError(ctx, '房间人数已达上限');
    return;
  }
  const added = ctx.manager.addClient(
    key,
    ctx.ws,
    createPeer(ctx.clientId, 'member', displayName)
  );
  if (!added) {
    sendError(ctx, '房间人数已达上限');
    return;
  }

  ctx.clientRoom = key;
  const state = ctx.manager.getOrInitRoomState(key);
  const joinedPayload = {
    type: 'joined',
    roomId: key,
    role: 'member',
    clientId: ctx.clientId,
  };
  if (state.lastNavigateUrl && isHttpUrl(state.lastNavigateUrl)) {
    joinedPayload.lastNavigateUrl = state.lastNavigateUrl;
    if (
      typeof state.lastVideoTime === 'number' &&
      !isNaN(state.lastVideoTime) &&
      state.lastVideoTime >= 0
    ) {
      joinedPayload.resumeVideo = {
        currentTime: state.lastVideoTime,
        playbackRate:
          typeof state.lastPlaybackRate === 'number' &&
          state.lastPlaybackRate > 0 &&
          state.lastPlaybackRate <= 4
            ? state.lastPlaybackRate
            : 1,
        playing: !!state.lastVideoPlaying,
      };
    }
  }
  joinedPayload.playlist = ctx.manager.getPlaylistPayload(key);
  sendJson(ctx, joinedPayload);
  ctx.manager.emitRoster(key);
  ctx.debug('enter_room member', { room: key, clientId: ctx.clientId });
}

function handleDisplayName(ctx, message) {
  if (!ctx.clientRoom) {
    sendError(ctx, '未加入房间');
    return;
  }
  const peer = getPeer(ctx);
  if (!peer) return;
  peer.displayName = normalizeDisplayName(message.displayName);
  ctx.manager.setPeer(ctx.clientRoom, ctx.ws, peer);
  ctx.manager.emitRoster(ctx.clientRoom);
}

function handleClaimHost(ctx) {
  if (!ctx.clientRoom) {
    sendServerNotice(ctx, '未加入房间', 'claim_host');
    return;
  }
  const peer = getPeer(ctx);
  if (!peer) return;
  if (peer.role === 'host') {
    sendServerNotice(ctx, '你已是房主', 'claim_host');
    return;
  }

  const cooldownUntil = ctx.manager.getClaimHostCooldownUntil(ctx.clientRoom);
  if (cooldownUntil != null) {
    const remainSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
    sendServerNotice(ctx, `抢房主冷却中，请 ${remainSec} 秒后再试`, 'claim_host');
    sendJson(ctx, { type: 'claim_host_cooldown', until: cooldownUntil });
    return;
  }

  if (ctx.manager.assignRoomHost(ctx.clientRoom, ctx.ws, { reason: 'claim_host' })) {
    ctx.debug('claim_host ok', { room: ctx.clientRoom, clientId: peer.id });
    ctx.manager.emitRoster(ctx.clientRoom);
  } else {
    sendServerNotice(ctx, '抢房主失败', 'claim_host');
  }
}

function handleRoomMessage(ctx, message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'enter_room') {
    handleEnterRoom(ctx, message);
    return true;
  }
  if (message.type === 'set_display_name') {
    handleDisplayName(ctx, message);
    return true;
  }
  if (message.type === 'claim_host') {
    handleClaimHost(ctx);
    return true;
  }
  return false;
}

module.exports = { handleRoomMessage };
