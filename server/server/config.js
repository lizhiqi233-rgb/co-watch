const path = require('path');

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const projectRoot = path.resolve(__dirname, '..');
const port = parsePositiveInt(process.env.PORT, 15777);
const tlsKeyFile = process.env.TLS_KEY_FILE ? path.resolve(process.env.TLS_KEY_FILE) : '';
const tlsCertFile = process.env.TLS_CERT_FILE ? path.resolve(process.env.TLS_CERT_FILE) : '';
const tlsPort = parsePositiveInt(process.env.TLS_PORT, 443);
const extensionRoot = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : path.join(projectRoot, 'extension');

const config = {
  port,
  tlsPort,
  tlsKeyFile,
  tlsCertFile,
  tlsEnabled: Boolean(tlsKeyFile && tlsCertFile),
  extensionRoot,
  coWatchDebug:
    process.env.CO_WATCH_DEBUG === '1' ||
    process.env.CO_WATCH_DEBUG === 'true' ||
    process.env.DEBUG === 'co-watch',
  idleCloseMs: parsePositiveInt(process.env.IDLE_CLOSE_MS, 90000),
  idleSweepMs: parsePositiveInt(process.env.IDLE_SWEEP_MS, 15000),
  jumpVerifyMaxAttempts: 5,
  jumpDesyncKickMs: parsePositiveInt(process.env.JUMP_DESYNC_KICK_MS, 60000),
  claimHostCooldownMs: parsePositiveInt(process.env.CLAIM_HOST_CD_MS, 60000),
  playlistMaxItems: 100,
  wsMaxPayloadBytes: parsePositiveInt(process.env.WS_MAX_PAYLOAD, 64 * 1024),
  maxWsConnections: parsePositiveInt(process.env.MAX_WS_CONNECTIONS, 100),
  maxRoomClients: parsePositiveInt(process.env.MAX_ROOM_CLIENTS, 20),
  maxRooms: parsePositiveInt(process.env.MAX_ROOMS, 1000),
  rosterBroadcastDelayMs: parsePositiveInt(process.env.ROSTER_BROADCAST_DELAY_MS, 500),
  messageRateWindowMs: 60 * 1000,
  maxMessagesPerWindow: parsePositiveInt(process.env.MAX_MESSAGES_PER_WINDOW, 300),
};

function validateConfig() {
  if (Boolean(config.tlsKeyFile) !== Boolean(config.tlsCertFile)) {
    throw new Error('TLS_KEY_FILE and TLS_CERT_FILE must be configured together');
  }
  if (config.tlsEnabled && config.tlsPort === config.port) {
    throw new Error('TLS_PORT must differ from PORT');
  }
}

module.exports = { config, validateConfig };
