function isSocketOpen(ws) {
  return ws && ws.readyState === 1;
}

function sendJson(ctx, payload) {
  if (!isSocketOpen(ctx.ws)) return false;
  try {
    ctx.ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function sendError(ctx, message) {
  sendJson(ctx, { type: 'error', message });
}

function sendServerNotice(ctx, message, code) {
  const payload = { type: 'server_notice', message: String(message || '') };
  if (code) payload.code = code;
  sendJson(ctx, payload);
}

function requireRoom(ctx, message) {
  if (ctx.clientRoom) return true;
  sendError(ctx, message || '未加入房间');
  return false;
}

function getPeer(ctx) {
  return ctx.clientRoom ? ctx.manager.getPeer(ctx.clientRoom, ctx.ws) : null;
}

module.exports = {
  getPeer,
  requireRoom,
  sendError,
  sendJson,
  sendServerNotice,
};
