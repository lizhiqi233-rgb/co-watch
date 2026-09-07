const fs = require('fs');
const http = require('http');
const https = require('https');
const { config, validateConfig } = require('./config.js');
const { createDebugLogger } = require('./log.js');
const { createExtensionService } = require('./http.js');
const { RoomManager } = require('./rooms/manager.js');
const { handleWsConnection } = require('./connection.js');
const { createWebSocketTransports } = require('./transport.js');

validateConfig();
const debug = createDebugLogger(config.coWatchDebug);
const extensionService = createExtensionService(config.extensionRoot);
const server = http.createServer(extensionService.handleHttpRequest);
let tlsServer = null;

if (config.tlsEnabled) {
  tlsServer = https.createServer(
    {
      key: fs.readFileSync(config.tlsKeyFile),
      cert: fs.readFileSync(config.tlsCertFile),
    },
    extensionService.handleHttpRequest
  );
}

const manager = new RoomManager({
  maxRooms: config.maxRooms,
  maxRoomClients: config.maxRoomClients,
  claimHostCooldownMs: config.claimHostCooldownMs,
  jumpDesyncKickMs: config.jumpDesyncKickMs,
  rosterBroadcastDelayMs: config.rosterBroadcastDelayMs,
});

const transports = createWebSocketTransports({
  server,
  tlsServer,
  config,
  onConnection(ws, transport) {
    handleWsConnection(ws, {
      config,
      manager,
      debug,
      tracker: transport.tracker,
      getActiveConnectionCount: transport.getActiveConnectionCount,
      readExtensionManifestVersion: extensionService.readExtensionManifestVersion,
    });
  },
});

server.listen(config.port, () => {
  console.log(`co-watch room server listening on ws://127.0.0.1:${config.port}`);
  console.log(
    `extension dir: ${config.extensionRoot} (manifest version: ${
      extensionService.readExtensionManifestVersion() || '(none)'
    })`
  );
  console.log(
    `GET http://127.0.0.1:${config.port}/extension.zip or /extension-{manifest version}.zip`
  );
  console.log(
    `idle kick: no message for ${config.idleCloseMs}ms -> close 1001 (fallback terminate after 1000ms; ${config.idleSweepMs}ms sweep)`
  );
  console.log(
    `jump desync ${config.jumpDesyncKickMs}ms -> remove client (host promotes next)`
  );
  console.log(
    `claim_host cooldown ${config.claimHostCooldownMs}ms per room (CLAIM_HOST_CD_MS)`
  );
  console.log(
    `limits: ${config.maxWsConnections} connections, ${config.maxRoomClients} clients/room, ${config.maxRooms} rooms`
  );
  if (config.tlsEnabled) {
    console.log(`wss://127.0.0.1:${config.tlsPort} enabled`);
  } else {
    console.log('TLS disabled; set TLS_KEY_FILE and TLS_CERT_FILE to enable WSS');
  }
  if (config.coWatchDebug) {
    console.log('[co-watch] debug logging enabled (CO_WATCH_DEBUG=1 or DEBUG=co-watch)');
  }
});

if (tlsServer) {
  tlsServer.listen(config.tlsPort, () => {
    console.log(`co-watch TLS room server listening on wss://127.0.0.1:${config.tlsPort}`);
    console.log(`GET https://127.0.0.1:${config.tlsPort}/extension.zip`);
  });
}

module.exports = { manager, server, tlsServer, transports };
