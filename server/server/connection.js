const { dispatchMessage } = require('./protocol/index.js');
const { sendJson } = require('./protocol/context.js');
const { dbgUrl } = require('./log.js');
const { genClientId } = require('./rooms/state.js');

function handleWsConnection(ws, deps) {
  const { config, manager, tracker, readExtensionManifestVersion, debug } = deps;
  if (deps.getActiveConnectionCount() > config.maxWsConnections) {
    try {
      ws.close(1013, 'server capacity');
    } catch (_) {}
    return;
  }

  const ctx = {
    ws,
    clientId: genClientId(),
    clientRoom: null,
    config,
    manager,
    debug,
    dbgUrl,
  };
  tracker.touch(ws);
  let messageWindowStartedAt = Date.now();
  let messageCountInWindow = 0;

  function consumeMessageBudget() {
    const now = Date.now();
    if (now - messageWindowStartedAt >= config.messageRateWindowMs) {
      messageWindowStartedAt = now;
      messageCountInWindow = 0;
    }
    messageCountInWindow += 1;
    if (messageCountInWindow > config.maxMessagesPerWindow) {
      try {
        ws.terminate();
      } catch (_) {}
      return false;
    }
    return true;
  }


  debug('ws connect', { clientId: ctx.clientId });
  sendJson(ctx, { type: 'extension_version', version: readExtensionManifestVersion() });

  ws.on('error', (error) => {
    debug('ws error', {
      clientId: ctx.clientId,
      message: error && error.message,
    });
  });

  ws.on('message', (data) => {
    if (!consumeMessageBudget()) return;
    tracker.touch(ws);
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    const type = message && message.type;
    if (
      config.coWatchDebug &&
      type !== 'ping' &&
      type !== 'video_sync' &&
      type !== 'sync_status_report'
    ) {
      debug('ws in', { clientId: ctx.clientId, room: ctx.clientRoom, type });
    }
    dispatchMessage(ctx, message);
  });

  ws.on('close', () => {
    tracker.forget(ws);
    if (!ctx.clientRoom || !manager.hasRoom(ctx.clientRoom)) return;
    const roomId = ctx.clientRoom;
    ctx.clientRoom = null;
    manager.removeClientFromRoom(roomId, ws);
  });
}

module.exports = { handleWsConnection };
