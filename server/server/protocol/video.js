const {
  computeJumpSyncedDisplay,
  isHttpUrl,
  normalizePlaylistUrlKey,
} = require('../rooms/state.js');
const {
  getPeer,
  requireRoom,
  sendError,
  sendJson,
} = require('./context.js');

function handleVideoSync(ctx, message) {
  if (!requireRoom(ctx)) return;
  const peer = getPeer(ctx);
  if (!peer || peer.role !== 'host') {
    sendError(ctx, '仅房主可同步播放（暂停/进度/倍速）');
    return;
  }
  const action = message.action;
  if (!['time', 'play', 'pause', 'seek'].includes(action)) return;

  ctx.manager.mergeHostVideoSnapshot(ctx.clientRoom, action, message);
  const payload = { type: 'video_sync', action };
  if (typeof message.currentTime === 'number' && !isNaN(message.currentTime)) {
    payload.currentTime = message.currentTime;
  }
  if (
    typeof message.playbackRate === 'number' &&
    message.playbackRate > 0 &&
    message.playbackRate <= 4
  ) {
    payload.playbackRate = message.playbackRate;
  }
  if (action === 'time' && typeof message.playing === 'boolean') {
    payload.playing = message.playing;
  }
  ctx.manager.broadcastRoom(ctx.clientRoom, payload, ctx.ws);
}

function handleSyncStatusReport(ctx, message) {
  if (!ctx.clientRoom) {
    sendError(ctx, '未加入房间');
    return;
  }
  const peer = getPeer(ctx);
  if (!peer) return;

  const state = ctx.manager.getOrInitRoomState(ctx.clientRoom);
  const canonical = state.lastNavigateUrl;
  const canonicalUrl = canonical && isHttpUrl(canonical)
    ? normalizePlaylistUrlKey(canonical)
    : '';
  const previousJumpSynced = computeJumpSyncedDisplay(peer, canonicalUrl);
  const jumpRoundReset =
    message.jumpRoundReset === true || message.jumpRoundReset === 'true';
  if (jumpRoundReset) {
    peer.jvAttempts = 0;
    peer.jvSuccess = null;
    peer.jumpDesyncSince = null;
  }

  peer.lastRttMs =
    typeof message.rttMs === 'number' &&
    !isNaN(message.rttMs) &&
    message.rttMs >= 0 &&
    message.rttMs < 60000
      ? Math.round(message.rttMs)
      : null;

  const rawFollow = typeof message.followUrl === 'string' ? message.followUrl.trim() : '';
  const followUrl = rawFollow && isHttpUrl(rawFollow)
    ? normalizePlaylistUrlKey(rawFollow)
    : '';
  const publishRoster = () => {
    ctx.manager.setPeer(ctx.clientRoom, ctx.ws, peer);
    if (computeJumpSyncedDisplay(peer, canonicalUrl) !== previousJumpSynced) {
      ctx.manager.emitRoster(ctx.clientRoom);
    } else {
      ctx.manager.scheduleRoster(ctx.clientRoom);
    }
  };

  if (!canonicalUrl) {
    peer.jvAttempts = 0;
    peer.jvSuccess = null;
    peer.jumpDesyncSince = null;
    publishRoster();
    return;
  }
  if (peer.jvSuccess === true && !jumpRoundReset) {
    peer.jumpDesyncSince = null;
    publishRoster();
    return;
  }
  if (peer.jvSuccess === false && !jumpRoundReset) {
    if (ctx.manager.maybeKickForJumpDesync(ctx.clientRoom, ctx.ws, peer, canonicalUrl)) return;
    publishRoster();
    return;
  }

  peer.jvAttempts = (peer.jvAttempts || 0) + 1;
  const matched = !!(followUrl && followUrl === canonicalUrl);
  if (matched) peer.jvSuccess = true;
  else if (peer.jvAttempts >= ctx.config.jumpVerifyMaxAttempts) peer.jvSuccess = false;
  else peer.jvSuccess = null;
  if (ctx.manager.maybeKickForJumpDesync(ctx.clientRoom, ctx.ws, peer, canonicalUrl)) return;
  publishRoster();
}

function handleVideoMessage(ctx, message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'video_sync') {
    handleVideoSync(ctx, message);
    return true;
  }
  if (message.type === 'sync_status_report') {
    handleSyncStatusReport(ctx, message);
    return true;
  }
  return false;
}

module.exports = { handleVideoMessage };
