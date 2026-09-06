const { WebSocketServer } = require('ws');

function createConnectionTracker() {
  const lastActivity = new Map();
  return {
    touch(ws) {
      lastActivity.set(ws, Date.now());
    },
    forget(ws) {
      lastActivity.delete(ws);
    },
    getLastActivity(ws) {
      return lastActivity.get(ws);
    },
  };
}

function createWebSocketTransports({ server, tlsServer, config, onConnection }) {
  const websocketOptions = {
    maxPayload: config.wsMaxPayloadBytes,
    perMessageDeflate: false,
  };
  const wss = new WebSocketServer({ server, ...websocketOptions });
  const tlsWss = tlsServer ? new WebSocketServer({ server: tlsServer, ...websocketOptions }) : null;
  const tracker = createConnectionTracker();

  function forEachWebSocket(callback) {
    wss.clients.forEach(callback);
    if (tlsWss) tlsWss.clients.forEach(callback);
  }

  function activeWebSocketCount() {
    return wss.clients.size + (tlsWss ? tlsWss.clients.size : 0);
  }

  function register(serverInstance) {
    serverInstance.on('connection', (ws) => {
      onConnection(ws, { tracker, getActiveConnectionCount: activeWebSocketCount });
    });
  }

  register(wss);
  if (tlsWss) register(tlsWss);

  const idleTimer = setInterval(() => {
    const threshold = Date.now() - config.idleCloseMs;
    forEachWebSocket((ws) => {
      const last = tracker.getLastActivity(ws);
      if (last != null && last >= threshold) return;
      try {
        ws.terminate();
      } catch (_) {}
    });
  }, config.idleSweepMs);

  return {
    wss,
    tlsWss,
    tracker,
    activeWebSocketCount,
    stop() {
      clearInterval(idleTimer);
    },
  };
}

module.exports = { createWebSocketTransports };
