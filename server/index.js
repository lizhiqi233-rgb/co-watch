/**
 * 协同浏览房间服务：WebSocket 广播导航指令。
 * 默认端口 15777，可用环境变量 PORT 覆盖。
 * 扩展目录：默认位于本目录下的 extension/，可用 EXTENSION_DIR 覆盖。
 * 连接时推送 extension/manifest.json 版本；HTTP GET /extension.zip 或 /extension-{版本}.zip 打包该目录供插件下载更新（带版本路径须与 manifest 一致，避免同名覆盖）。
 * 房间内播放列表仅存于内存，全员离房后清空；与 navigate / playlist_state 同步。
 * 每条链接 readStatus：unread | reading | read。加入队列默认为 unread；房主焦点落到某条时设为 reading，原 reading 变为 read。playlistWatchedCount 仅作旧客户端兼容占位。同 URL 在 getPlaylistPayload 时合并为一条。
 * playlist_current_match：房主跟随标签与列表项匹配时 applyReadingFocus（不广播 navigate）。
 * sync_status_report：客户端 ping→pong 后上报 rttMs、followUrl，可选 jumpRoundReset（跟随页标题/URL 更新后开启新轮）。
 * 跳转列持续为 ✗（与 computeJumpSyncedDisplay 一致）且房间已有 canonical 页时，超过 JUMP_DESYNC_KICK_MS（默认 60s）则断开该连接、移出房间，房主时移交权限。
 * 跳转对齐：以 lastNavigateUrl 为基准；每轮最多 5 次判定，任一次一致→✓，否则✗并继续直至成功或满 5 次仍不一致→✗；房间换页时全员重新开始一轮。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const archiver = require('archiver');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 15777;
/** 设为 1 / true 时向 stdout 打印调试日志（含时间戳与房间/消息摘要） */
const CO_WATCH_DEBUG =
  process.env.CO_WATCH_DEBUG === '1' ||
  process.env.CO_WATCH_DEBUG === 'true' ||
  process.env.DEBUG === 'co-watch';

/**
 * @param {unknown[]} args
 */
function dbg(...args) {
  if (!CO_WATCH_DEBUG) return;
  console.log('[co-watch]', new Date().toISOString(), ...args);
}

/**
 * @param {unknown} u
 */
function dbgUrl(u) {
  if (typeof u !== 'string') return u;
  return u.length > 160 ? `${u.slice(0, 160)}…` : u;
}

const EXTENSION_ROOT = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : path.join(__dirname, 'extension');
/** 超过此时间未收到该连接任何消息（含客户端 JSON ping）则强制断开，避免半开连接永久占房 */
const IDLE_CLOSE_MS = Number(process.env.IDLE_CLOSE_MS) || 90000;
const IDLE_SWEEP_MS = Number(process.env.IDLE_SWEEP_MS) || 15000;

/**
 * @returns {string}
 */
function readExtensionManifestVersion() {
  try {
    const p = path.join(EXTENSION_ROOT, 'manifest.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return typeof j.version === 'string' ? j.version.trim() : '';
  } catch {
    return '';
  }
}

/**
 * URL 路径中的版本片段，须与 manifest 一致方可下载（与扩展端 extension-{ver}.zip 对齐）。
 * @param {unknown} s
 * @returns {string}
 */
function sanitizeVersionInZipPath(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (!t || t.length > 64) return '';
  if (!/^[\w.\-+]+$/i.test(t)) return '';
  return t;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string | null} versionFromPath GET /extension-{version}.zip 中的 version；null 表示 /extension.zip
 */
function serveExtensionZip(req, res, versionFromPath) {
  if (!fs.existsSync(EXTENSION_ROOT)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('extension folder missing (configure EXTENSION_DIR)');
    return;
  }
  const manifestRaw = readExtensionManifestVersion().trim();
  const manifestVer = manifestRaw || 'unknown';
  if (versionFromPath != null && versionFromPath !== '') {
    const pv = sanitizeVersionInZipPath(versionFromPath);
    if (!pv || pv !== manifestVer) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('extension zip: path version does not match current manifest');
      return;
    }
  }
  const ver = manifestVer;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="co-watch-extension-${ver}.zip"`,
    'Cache-Control': 'no-store',
  });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => {
    try {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    } catch (_) {}
  });
  archive.pipe(res);
  archive.directory(EXTENSION_ROOT, false);
  archive.finalize();
}

const server = http.createServer((req, res) => {
  let pathname = (req.url || '').split('?')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (_) {}
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('co-watch room server ok');
    return;
  }
  if (req.method === 'GET' && pathname === '/extension.zip') {
    serveExtensionZip(req, res, null);
    return;
  }
  if (req.method === 'GET') {
    const m = pathname.match(/^\/extension-([^/]+)\.zip$/i);
    if (m) {
      serveExtensionZip(req, res, m[1]);
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

/** @type {Map<string, Map<import('ws').WebSocket, { id: string, role: 'host' | 'member', displayName: string, lastRttMs: number | null, jvAttempts: number, jvSuccess: boolean | null, jumpDesyncSince: number | null }>>} */
const rooms = new Map();

/** 每轮「标题/URL 更新后」或进房后：最多几次 sync_status_report 判定（与 ping 同周期） */
const JUMP_VERIFY_MAX_ATTEMPTS = 5;

/** 成员列表跳转判定持续为 ✗ 时，超过该时长移出连接（可用环境变量 JUMP_DESYNC_KICK_MS 覆盖，毫秒） */
const JUMP_DESYNC_KICK_MS = Number(process.env.JUMP_DESYNC_KICK_MS) || 60000;

/**
 * @typedef {{ id: string, url: string, title: string, readStatus?: 'unread'|'reading'|'read' }} PlaylistItem
 * @typedef {{ lastNavigateUrl: string | null, lastVideoTime: number | null, lastPlaybackRate: number | null, lastVideoPlaying: boolean, playlistItems: PlaylistItem[], playlistCurrentId: string | null, playlistWatchedCount: number }} RoomState
 */

/** @type {Map<string, RoomState>} */
const roomState = new Map();

/** @type {Map<import('ws').WebSocket, number>} */
const wsLastActivity = new Map();

/**
 * @param {import('ws').WebSocket} ws
 */
function touchWs(ws) {
  wsLastActivity.set(ws, Date.now());
}

/**
 * @param {import('ws').WebSocket} ws
 */
function forgetWs(ws) {
  wsLastActivity.delete(ws);
}

function defaultRoomState() {
  return {
    lastNavigateUrl: null,
    lastVideoTime: null,
    lastPlaybackRate: null,
    lastVideoPlaying: false,
    playlistItems: [],
    playlistCurrentId: null,
    /** 兼容旧字段：现为 read 状态条目数量 */
    playlistWatchedCount: 0,
  };
}

function genClientId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function genPlaylistItemId() {
  return 'pl' + genClientId();
}

const PLAYLIST_MAX_ITEMS = 100;

/**
 * 列表项展示用标题：trim、合并空白、最长 200、空为「（无标题）」。
 * 扩展端入队/上报对齐实现见 extension/background.js 的 normalizePlaylistTitle；仅比对用的宽松规范化见 normalizePlaylistTitleCompare。
 * @param {unknown} s
 * @returns {string}
 */
function normalizePlaylistTitle(s) {
  if (typeof s !== 'string') return '（无标题）';
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '（无标题）';
  if (t.length > 200) return t.slice(0, 200);
  return t;
}

/** 去重比较用：去掉本扩展为分 P / BV 区分而追加的后缀 */
function titleBaseForPlaylistDedup(t) {
  return normalizePlaylistTitle(
    String(t || '')
      .replace(/\s*·\s*P\d+\s*$/i, '')
      .replace(/\s*·\s*[A-Za-z0-9]{4,12}\s*$/, '')
      .trim()
  );
}

/**
 * B 站：分 P>1 时加「· P2」；同标题不同稿件加 BV 后 6 位区分（document.title 常为合集名相同）。
 * @param {string} url 已规范化的列表 URL
 * @param {unknown} rawTitle
 * @param {PlaylistItem[] | undefined} existingItems 插入前已有项（不含当前将插入的）
 */
function enrichBilibiliPlaylistTitle(url, rawTitle, existingItems) {
  const base = normalizePlaylistTitle(rawTitle);
  try {
    const x = new URL(url);
    const h = x.hostname.toLowerCase();
    if (
      h !== 'bilibili.com' &&
      h !== 'www.bilibili.com' &&
      h !== 'm.bilibili.com' &&
      !h.endsWith('.bilibili.com')
    ) {
      return base;
    }
    const pathOnly = x.pathname.replace(/\/+$/, '') || '/';
    const m = pathOnly.match(/^\/video\/(BV[a-zA-Z0-9]+)$/i);
    if (!m) return base;
    const bv = m[1];
    const myKey = normalizePlaylistUrlKey(url);
    const p = x.searchParams.get('p');
    let extra = '';
    if (p && /^\d+$/.test(String(p)) && Number(p) > 1) {
      extra = ` · P${p}`;
    } else {
      const dup = (existingItems || []).some((it) => {
        if (!it || !it.url || typeof it.title !== 'string') return false;
        if (normalizePlaylistUrlKey(it.url) === myKey) return false;
        return titleBaseForPlaylistDedup(it.title) === titleBaseForPlaylistDedup(base);
      });
      if (dup) extra = ` · ${bv.slice(-6)}`;
    }
    const out = (base + extra).trim();
    return out.length > 200 ? out.slice(0, 200) : out;
  } catch (_) {
    return base;
  }
}

/**
 * 与扩展端 normalizeUrlKeyForCoWatch 一致：用于判断 URL 是否已在播放列表。
 * B 站 /video/BV… 会去掉跟踪参数（spm 等），仅保留分 P ?p=；统一为 www 主机，避免 exIdx 恒为 -1 重复插入。
 */
function normalizePlaylistUrlKey(url) {
  try {
    const x = new URL(url);
    const h = x.hostname.toLowerCase();
    if (
      h === 'bilibili.com' ||
      h === 'www.bilibili.com' ||
      h === 'm.bilibili.com' ||
      h.endsWith('.bilibili.com')
    ) {
      const pathOnly = x.pathname.replace(/\/+$/, '') || '/';
      const m = pathOnly.match(/^\/video\/(BV[a-zA-Z0-9]+)$/i);
      if (m) {
        const bv = m[1];
        const p = x.searchParams.get('p');
        const part = p && /^\d+$/.test(String(p)) ? `?p=${p}` : '';
        return `https://www.bilibili.com/video/${bv}${part}`;
      }
    }
    let path = x.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return x.origin + path + x.search;
  } catch {
    return String(url || '').trim();
  }
}

/**
 * @param {PlaylistItem[]} items
 * @param {string} url
 */
function findPlaylistIndexByUrl(items, url) {
  const k = normalizePlaylistUrlKey(url);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && normalizePlaylistUrlKey(it.url) === k) return i;
  }
  return -1;
}

/**
 * 扩展端 background.js / content.js 中同名函数语义须与此保持一致。
 * @param {unknown} s
 * @returns {'unread'|'reading'|'read'}
 */
function normalizeReadStatus(s) {
  if (s === 'reading' || s === 'read' || s === 'unread') return s;
  return 'unread';
}

/**
 * 房主焦点落到某列表项：该项变为 reading，其余原 reading 变为 read。
 * @param {RoomState} st
 * @param {string} focusedId
 */
function applyReadingFocus(st, focusedId) {
  if (!st || !focusedId) return;
  const items = st.playlistItems;
  if (!Array.isArray(items)) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.id) continue;
    it.readStatus = normalizeReadStatus(it.readStatus);
    if (it.readStatus === 'reading' && it.id !== focusedId) {
      it.readStatus = 'read';
    }
  }
  const focus = items.find((x) => x && x.id === focusedId);
  if (focus) {
    focus.readStatus = 'reading';
  }
  st.playlistCurrentId = focusedId;
}

/**
 * 相同规范化 URL 只保留最先出现的一条；修正 currentId；合并重复项 readStatus（任一为 reading 则保留 reading）。
 * @param {RoomState} st
 */
function dedupePlaylistByUrl(st) {
  const items = Array.isArray(st.playlistItems) ? st.playlistItems.slice() : [];
  let cur = typeof st.playlistCurrentId === 'string' && st.playlistCurrentId ? st.playlistCurrentId : null;

  const seen = new Map();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.id !== 'string' || !it.url) continue;
    const k = normalizePlaylistUrlKey(it.url);
    if (seen.has(k)) {
      const keepId = seen.get(k);
      if (cur === it.id) cur = keepId;
      const keepIdx = out.findIndex((x) => x && x.id === keepId);
      if (keepIdx >= 0) {
        const a = normalizeReadStatus(out[keepIdx].readStatus);
        const b = normalizeReadStatus(it.readStatus);
        if (a === 'reading' || b === 'reading') out[keepIdx].readStatus = 'reading';
        else if (a === 'read' || b === 'read') out[keepIdx].readStatus = 'read';
        else out[keepIdx].readStatus = 'unread';
      }
      continue;
    }
    seen.set(k, it.id);
    it.readStatus = normalizeReadStatus(it.readStatus);
    out.push(it);
  }
  st.playlistItems = out;
  st.playlistCurrentId = cur;
  st.playlistWatchedCount = out.filter((x) => x && normalizeReadStatus(x.readStatus) === 'read').length;
}

/**
 * @param {RoomState | undefined} st
 */
function getPlaylistPayload(st) {
  if (!st || !Array.isArray(st.playlistItems)) {
    return { items: [], currentId: null, watchedCount: 0 };
  }
  dedupePlaylistByUrl(st);
  const items = st.playlistItems;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && typeof it === 'object') {
      it.readStatus = normalizeReadStatus(it.readStatus);
    }
  }
  const currentId =
    typeof st.playlistCurrentId === 'string' && st.playlistCurrentId ? st.playlistCurrentId : null;
  const readCount = items.filter((x) => x && normalizeReadStatus(x.readStatus) === 'read').length;
  st.playlistWatchedCount = readCount;
  return { items, currentId, watchedCount: readCount };
}

/**
 * 全员离开房间后 roomState 已删；此处保证读写字段存在。
 * @param {string} roomId
 * @returns {RoomState}
 */
function getOrInitRoomState(roomId) {
  let st = roomState.get(roomId);
  if (!st) {
    st = defaultRoomState();
    roomState.set(roomId, st);
    return st;
  }
  if (!Array.isArray(st.playlistItems)) {
    st.playlistItems = [];
  }
  if (!('playlistCurrentId' in st)) {
    st.playlistCurrentId = null;
  }
  if (
    !('playlistWatchedCount' in st) ||
    typeof st.playlistWatchedCount !== 'number' ||
    st.playlistWatchedCount < 0
  ) {
    st.playlistWatchedCount = 0;
  }
  return st;
}

/**
 * @param {string} roomId
 */
function broadcastPlaylistState(roomId) {
  const st = roomState.get(roomId);
  if (!st) return;
  broadcastRoom(roomId, { type: 'playlist_state', ...getPlaylistPayload(st) });
}

/**
 * 非致命提示（不触发扩展端清空进房状态）
 * @param {import('ws').WebSocket} ws
 * @param {string} message
 * @param {string} [code] 如 playlist_add，便于扩展端区分是否取消「加入队列后关标签」
 */
function sendServerNotice(ws, message, code) {
  try {
    if (ws.readyState === 1) {
      const o = { type: 'server_notice', message: String(message || '') };
      if (code) o.code = code;
      ws.send(JSON.stringify(o));
    }
  } catch (_) {}
}

/**
 * 房间内展示名：trim、合并空白、最长 32。扩展端见 extension/background.js 的 normalizeDisplayName。
 * @param {unknown} s
 */
function normalizeDisplayName(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length > 32) return t.slice(0, 32);
  return t;
}

/**
 * @param {{ jvAttempts?: number, jvSuccess?: boolean | null }} peer
 * @param {string} canonNorm
 * @returns {boolean | null} true=✓ false=✗ null=…
 */
function computeJumpSyncedDisplay(peer, canonNorm) {
  if (!canonNorm) return null;
  if (peer.jvSuccess === true) return true;
  if (peer.jvSuccess === false) return false;
  const att = peer.jvAttempts | 0;
  if (att === 0) return null;
  return false;
}

/**
 * 与成员列表 ✗ 一致：canonical 存在且展示为未对齐时累计时长，超时则踢出并移交房主（若有）。
 * @param {string} roomId
 * @param {import('ws').WebSocket} ws
 * @param {{ id: string, role: 'host' | 'member', displayName: string, lastRttMs?: number | null, jvAttempts?: number, jvSuccess?: boolean | null, jumpDesyncSince?: number | null }} peer
 * @param {string} canonNorm
 * @returns {boolean} true 表示已断开 ws，调用方勿再 write peer
 */
function maybeKickForJumpDesync(roomId, ws, peer, canonNorm) {
  if (!canonNorm) {
    peer.jumpDesyncSince = null;
    return false;
  }
  const disp = computeJumpSyncedDisplay(peer, canonNorm);
  if (disp !== false) {
    peer.jumpDesyncSince = null;
    return false;
  }
  const now = Date.now();
  if (peer.jumpDesyncSince == null) {
    peer.jumpDesyncSince = now;
  }
  if (now - peer.jumpDesyncSince >= JUMP_DESYNC_KICK_MS) {
    dbg('kick jump desync sustained', { room: roomId, clientId: peer.id, ms: JUMP_DESYNC_KICK_MS });
    removeClientFromRoom(roomId, ws);
    try {
      ws.terminate();
    } catch (_) {}
    return true;
  }
  return false;
}

/**
 * 房间当前页变更：全员重新开始跳转判定轮次。
 * @param {string} roomId
 */
function resetJumpVerifyRoundForRoom(roomId) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  for (const ws of clients.keys()) {
    const peer = clients.get(ws);
    if (!peer) continue;
    peer.jvAttempts = 0;
    peer.jvSuccess = null;
    peer.jumpDesyncSince = null;
    clients.set(ws, peer);
  }
}

/**
 * @param {string} roomId
 * @param {Map<import('ws').WebSocket, { id: string, role: 'host' | 'member', displayName: string, lastRttMs?: number | null, jvAttempts?: number, jvSuccess?: boolean | null, jumpDesyncSince?: number | null }>} clients
 */
function buildMembersPayload(roomId, clients) {
  const st = roomState.get(roomId);
  const canon = st && st.lastNavigateUrl;
  const canonNorm = canon && isHttpUrl(canon) ? normalizePlaylistUrlKey(canon) : '';
  const members = [];
  for (const info of clients.values()) {
    const label = info.displayName ? info.displayName : '访客';
    const rtt =
      typeof info.lastRttMs === 'number' && !isNaN(info.lastRttMs) ? Math.round(info.lastRttMs) : null;
    members.push({
      clientId: info.id,
      role: info.role,
      displayName: label,
      rttMs: rtt,
      jumpSynced: computeJumpSyncedDisplay(info, canonNorm),
    });
  }
  return members;
}

/**
 * 从房间移除连接（与 connection close 逻辑一致）。
 * 弱网客户端可能长期占座且 send 抛错；若不逐个 try/catch，会先向 ta 发送失败并中断整个广播，其他人收不到 room_roster/navigate。
 * @param {string} roomId
 * @param {import('ws').WebSocket} ws
 * @param {{ skipEmitRoster?: boolean }} [opts]
 */
function removeClientFromRoom(roomId, ws, opts) {
  if (!roomId || !rooms.has(roomId)) return;
  const clients = rooms.get(roomId);
  if (!clients || !clients.has(ws)) return;
  const peer = clients.get(ws);
  const wasHost = peer && peer.role === 'host';
  clients.delete(ws);
  if (clients.size === 0) {
    rooms.delete(roomId);
    roomState.delete(roomId);
    return;
  }
  if (wasHost) promoteNewHost(roomId);
  if (!opts || !opts.skipEmitRoster) {
    emitRoster(roomId);
  }
}

/**
 * @param {string} roomId
 * @param {object} payload
 */
function broadcastRoom(roomId, payload) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const raw = JSON.stringify(payload);
  const dead = [];
  for (const ws of clients.keys()) {
    if (ws.readyState !== 1) {
      dead.push(ws);
      continue;
    }
    try {
      ws.send(raw);
    } catch (_) {
      dead.push(ws);
    }
  }
  for (const ws of dead) {
    removeClientFromRoom(roomId, ws, { skipEmitRoster: true });
  }
  if (dead.length && rooms.has(roomId) && rooms.get(roomId).size > 0) {
    emitRoster(roomId);
  }
}

/**
 * @param {string} roomId
 * @param {import('ws').WebSocket} except
 * @param {object} payload
 */
function broadcastRoomExcept(roomId, except, payload) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const raw = JSON.stringify(payload);
  const dead = [];
  for (const ws of clients.keys()) {
    if (ws === except) continue;
    if (ws.readyState !== 1) {
      dead.push(ws);
      continue;
    }
    try {
      ws.send(raw);
    } catch (_) {
      dead.push(ws);
    }
  }
  for (const ws of dead) {
    removeClientFromRoom(roomId, ws, { skipEmitRoster: true });
  }
  if (dead.length && rooms.has(roomId) && rooms.get(roomId).size > 0) {
    emitRoster(roomId);
  }
}

/**
 * @param {string} roomId
 */
function emitRoster(roomId) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const members = buildMembersPayload(roomId, clients);
  broadcastRoom(roomId, { type: 'room_roster', members });
}

/**
 * @param {string} s
 */
function normalizeRoomKey(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (t.length < 1 || t.length > 128) return '';
  return t;
}

/**
 * @param {string} url
 */
function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 仅房主：更新房间内「当前页」上的播放快照，供后进房成员对齐进度。
 * action=time 时可带 playing，与周期性进度快照一致（暂停时亦为 false）。
 * @param {string} roomId
 * @param {string} act
 * @param {{ currentTime?: number, playbackRate?: number, playing?: boolean }} msg
 */
function mergeHostVideoSnapshot(roomId, act, msg) {
  const st = roomState.get(roomId);
  if (!st) return;
  const ct = msg.currentTime;
  if (typeof ct === 'number' && !isNaN(ct) && ct >= 0 && ct < 1e12) {
    st.lastVideoTime = ct;
  }
  const pr = msg.playbackRate;
  if (typeof pr === 'number' && pr > 0 && pr <= 4) {
    st.lastPlaybackRate = pr;
  }
  if (act === 'play') st.lastVideoPlaying = true;
  else if (act === 'pause') st.lastVideoPlaying = false;
  else if (act === 'time') {
    if (msg.playing === false) st.lastVideoPlaying = false;
    else if (msg.playing === true) st.lastVideoPlaying = true;
    else st.lastVideoPlaying = true;
  }
  roomState.set(roomId, st);
}

/**
 * 定时踢掉长期无活动的连接（僵尸占座）；已在房内的会触发 close -> removeClientFromRoom。
 * 遍历 wss.clients，避免「已连上但从未 enter_room」的连接永远不进入 rooms 而无法清理。
 */
function sweepIdleConnections() {
  const now = Date.now();
  const threshold = now - IDLE_CLOSE_MS;
  wss.clients.forEach((ws) => {
    const last = wsLastActivity.get(ws);
    if (last != null && last >= threshold) return;
    try {
      ws.terminate();
    } catch (_) {}
  });
}

function promoteNewHost(roomId) {
  const clients = rooms.get(roomId);
  if (!clients || clients.size === 0) return;
  let first = null;
  for (const ws of clients.keys()) {
    first = ws;
    break;
  }
  if (!first) return;
  const info = clients.get(first);
  if (!info) return;
  info.role = 'host';
  clients.set(first, info);
  if (first.readyState !== 1) {
    removeClientFromRoom(roomId, first, { skipEmitRoster: true });
    promoteNewHost(roomId);
    return;
  }
  try {
    first.send(JSON.stringify({ type: 'promoted', role: 'host' }));
  } catch (_) {
    removeClientFromRoom(roomId, first, { skipEmitRoster: true });
    promoteNewHost(roomId);
  }
}

wss.on('connection', (ws) => {
  /** @type {string | null} */
  let clientRoom = null;
  const clientId = genClientId();
  touchWs(ws);
  dbg('ws connect', { clientId });
  try {
    const ver = readExtensionManifestVersion();
    ws.send(JSON.stringify({ type: 'extension_version', version: ver }));
  } catch (_) {}

  ws.on('message', (data) => {
    touchWs(ws);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    const type = msg && msg.type;
    if (CO_WATCH_DEBUG && type !== 'ping' && type !== 'video_sync' && type !== 'sync_status_report') {
      dbg('ws in', { clientId, room: clientRoom, type });
    }

    if (type === 'enter_room') {
      if (clientRoom) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: '已在房间内，请勿重复进房' }));
        } catch (_) {}
        return;
      }
      const key = normalizeRoomKey(typeof msg.roomKey === 'string' ? msg.roomKey : '');
      if (!key) {
        ws.send(JSON.stringify({ type: 'error', message: '房间密码需为 1～128 个字符' }));
        return;
      }
      const displayName = normalizeDisplayName(msg.displayName);
      if (!rooms.has(key)) {
        rooms.set(key, new Map());
        roomState.set(key, defaultRoomState());
        clientRoom = key;
        rooms.get(key).set(ws, {
          id: clientId,
          role: 'host',
          displayName,
          lastRttMs: null,
          jvAttempts: 0,
          jvSuccess: null,
          jumpDesyncSince: null,
        });
        const stCreated = roomState.get(key) || defaultRoomState();
        ws.send(
          JSON.stringify({
            type: 'room_created',
            roomId: key,
            role: 'host',
            clientId,
            playlist: getPlaylistPayload(stCreated),
          })
        );
        emitRoster(key);
        dbg('enter_room host', { room: key, clientId });
        return;
      }
      clientRoom = key;
      rooms.get(key).set(ws, {
        id: clientId,
        role: 'member',
        displayName,
        lastRttMs: null,
        jvAttempts: 0,
        jvSuccess: null,
        jumpDesyncSince: null,
      });
      const st = getOrInitRoomState(key);
      /** @type {{ type: string, roomId: string, role: string, clientId: string, lastNavigateUrl?: string, resumeVideo?: { currentTime: number, playbackRate: number, playing: boolean } }} */
      const joinedPayload = {
        type: 'joined',
        roomId: key,
        role: 'member',
        clientId,
      };
      if (st.lastNavigateUrl && isHttpUrl(st.lastNavigateUrl)) {
        joinedPayload.lastNavigateUrl = st.lastNavigateUrl;
        if (typeof st.lastVideoTime === 'number' && !isNaN(st.lastVideoTime) && st.lastVideoTime >= 0) {
          joinedPayload.resumeVideo = {
            currentTime: st.lastVideoTime,
            playbackRate:
              typeof st.lastPlaybackRate === 'number' && st.lastPlaybackRate > 0 && st.lastPlaybackRate <= 4
                ? st.lastPlaybackRate
                : 1,
            playing: !!st.lastVideoPlaying,
          };
        }
      }
      joinedPayload.playlist = getPlaylistPayload(st);
      ws.send(JSON.stringify(joinedPayload));
      emitRoster(key);
      dbg('enter_room member', { room: key, clientId });
      return;
    }

    if (type === 'set_display_name') {
      if (!clientRoom) {
        ws.send(JSON.stringify({ type: 'error', message: '未加入房间' }));
        return;
      }
      const clients = rooms.get(clientRoom);
      if (!clients) return;
      const peer = clients.get(ws);
      if (!peer) return;
      peer.displayName = normalizeDisplayName(msg.displayName);
      clients.set(ws, peer);
      emitRoster(clientRoom);
      return;
    }

    if (type === 'navigate') {
      if (!clientRoom) {
        ws.send(JSON.stringify({ type: 'error', message: '未加入房间' }));
        return;
      }
      const url = typeof msg.url === 'string' ? msg.url.trim() : '';
      if (!url) {
        ws.send(JSON.stringify({ type: 'error', message: '缺少网址' }));
        return;
      }
      if (!isHttpUrl(url)) {
        ws.send(JSON.stringify({ type: 'error', message: '仅支持 http:// 或 https:// 网址' }));
        return;
      }
      const urlCanon = normalizePlaylistUrlKey(url);
      const clients = rooms.get(clientRoom);
      const peer = clients && clients.get(ws);
      const isHost = !!(peer && peer.role === 'host');
      /** 扩展端：右键「发送到协同」、悬浮窗/侧栏「全员跳转」、弹窗全员跳转；按房主规则更新列表与已看历史，任意成员发起亦同 */
      const roomSyncNavigate =
        msg.roomSyncNavigate === true || msg.roomSyncNavigate === 'true';

      let st = getOrInitRoomState(clientRoom);
      const prevCanon = st.lastNavigateUrl;
      st.lastNavigateUrl = urlCanon;
      if (prevCanon !== urlCanon) {
        resetJumpVerifyRoundForRoom(clientRoom);
      }
      st.lastVideoTime = null;
      st.lastPlaybackRate = null;
      st.lastVideoPlaying = false;

      if (!isHost && !roomSyncNavigate) {
        const memberItems = Array.isArray(st.playlistItems) ? st.playlistItems : [];
        const memberIdx = findPlaylistIndexByUrl(memberItems, urlCanon);
        if (memberIdx >= 0 && memberItems[memberIdx] && memberItems[memberIdx].id) {
          st.playlistCurrentId = memberItems[memberIdx].id;
        } else {
          st.playlistCurrentId = null;
        }
        roomState.set(clientRoom, st);
        broadcastRoom(clientRoom, { type: 'navigate', url: urlCanon });
        broadcastPlaylistState(clientRoom);
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'navigate_ack', url: urlCanon }));
          }
        } catch (_) {}
        return;
      }

      const items = Array.isArray(st.playlistItems) ? st.playlistItems.slice() : [];

      const exIdx = findPlaylistIndexByUrl(items, urlCanon);
      const skipPlaylistInsert =
        msg.skipPlaylistInsert === true || msg.skipPlaylistInsert === 'true';

      dbg('navigate', {
        host: isHost,
        roomSyncNavigate,
        url: dbgUrl(urlCanon),
        exIdx,
        skipPlaylistInsert,
        listLen: items.length,
      });

      if (exIdx >= 0) {
        const others = items.filter((_, i) => i !== exIdx);
        const rawT = msg.title != null ? msg.title : items[exIdx].title;
        const mergedTitle = enrichBilibiliPlaylistTitle(urlCanon, rawT, others);
        if (skipPlaylistInsert) {
          // 合集 SPA：先收到 URL 时 tab.title 常为合集名；随后 document.title 变为单集，扩展再发 skip 仅改标题
          items[exIdx] = { ...items[exIdx], url: urlCanon, title: mergedTitle };
          st.playlistItems = items;
          applyReadingFocus(st, items[exIdx].id);
          roomState.set(clientRoom, st);
          broadcastPlaylistState(clientRoom);
          try {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'navigate_ack', url: urlCanon }));
            }
          } catch (_) {}
          return;
        }
        items[exIdx] = { ...items[exIdx], url: urlCanon, title: mergedTitle };
        st.playlistItems = items;
        applyReadingFocus(st, items[exIdx].id);
      } else if (skipPlaylistInsert) {
        // 扩展端右键/侧栏先发 navigate，跟随标签 onUpdated 会再发一次并写入列表；此处不插入避免重复
        st.playlistItems = items;
        st.playlistCurrentId = null;
      } else {
        if (items.length >= PLAYLIST_MAX_ITEMS) {
          st.playlistItems = items;
          st.playlistCurrentId = null;
          roomState.set(clientRoom, st);
          broadcastRoom(clientRoom, { type: 'navigate', url: urlCanon });
          broadcastPlaylistState(clientRoom);
          try {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'navigate_ack', url: urlCanon }));
            }
          } catch (_) {}
          return;
        }
        const titleForNew = enrichBilibiliPlaylistTitle(urlCanon, msg.title, items);
        const newId = genPlaylistItemId();
        const newItem = { id: newId, url: urlCanon, title: titleForNew, readStatus: 'unread' };
        items.push(newItem);
        st.playlistItems = items;
        applyReadingFocus(st, newId);
      }

      roomState.set(clientRoom, st);
      broadcastRoom(clientRoom, { type: 'navigate', url: urlCanon });
      broadcastPlaylistState(clientRoom);
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'navigate_ack', url: urlCanon }));
        }
      } catch (_) {}
      return;
    }

    if (type === 'playlist_add') {
      if (!clientRoom) {
        sendServerNotice(ws, '未加入房间', 'playlist_add');
        return;
      }
      const url = typeof msg.url === 'string' ? msg.url.trim() : '';
      if (!url) {
        sendServerNotice(ws, '缺少网址', 'playlist_add');
        return;
      }
      if (!isHttpUrl(url)) {
        sendServerNotice(ws, '仅支持 http:// 或 https:// 网址', 'playlist_add');
        return;
      }
      const urlCanon = normalizePlaylistUrlKey(url);
      let st = getOrInitRoomState(clientRoom);
      const items = Array.isArray(st.playlistItems) ? st.playlistItems.slice() : [];
      const dupIdx = findPlaylistIndexByUrl(items, urlCanon);
      if (dupIdx >= 0) {
        const others = items.filter((_, i) => i !== dupIdx);
        const title = enrichBilibiliPlaylistTitle(urlCanon, msg.title, others);
        items[dupIdx] = {
          ...items[dupIdx],
          url: urlCanon,
          title,
          readStatus: normalizeReadStatus(items[dupIdx].readStatus),
        };
        st.playlistItems = items;
        roomState.set(clientRoom, st);
        dbg('playlist_add dup', { dupIdx, url: dbgUrl(urlCanon) });
        broadcastPlaylistState(clientRoom);
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'playlist_add_ack' }));
          }
        } catch (_) {}
        return;
      }
      if (items.length >= PLAYLIST_MAX_ITEMS) {
        sendServerNotice(ws, '播放列表已达上限', 'playlist_add');
        return;
      }
      const newId = genPlaylistItemId();
      const title = enrichBilibiliPlaylistTitle(urlCanon, msg.title, items);
      items.push({ id: newId, url: urlCanon, title, readStatus: 'unread' });
      st.playlistItems = items;
      roomState.set(clientRoom, st);
      dbg('playlist_add new', { id: newId, url: dbgUrl(urlCanon), dup: false });
      broadcastPlaylistState(clientRoom);
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'playlist_add_ack' }));
        }
      } catch (_) {}
      return;
    }

    if (type === 'playlist_remove') {
      if (!clientRoom) {
        sendServerNotice(ws, '未加入房间');
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id.trim() : '';
      if (!id) {
        return;
      }
      let st = getOrInitRoomState(clientRoom);
      const items = Array.isArray(st.playlistItems) ? st.playlistItems.slice() : [];
      const idx = items.findIndex((x) => x && x.id === id);
      if (idx === -1) {
        return;
      }
      items.splice(idx, 1);
      st.playlistItems = items;
      if (st.playlistCurrentId === id) {
        st.playlistCurrentId = null;
      }
      roomState.set(clientRoom, st);
      broadcastPlaylistState(clientRoom);
      return;
    }

    if (type === 'playlist_select') {
      if (!clientRoom) {
        sendServerNotice(ws, '未加入房间');
        return;
      }
      const clients = rooms.get(clientRoom);
      const peer = clients && clients.get(ws);
      if (!peer || peer.role !== 'host') {
        sendServerNotice(ws, '仅房主可选定播放');
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id.trim() : '';
      if (!id) {
        return;
      }
      let st = getOrInitRoomState(clientRoom);
      const items = Array.isArray(st.playlistItems) ? st.playlistItems : [];
      const item = items.find((x) => x && x.id === id);
      if (!item || !isHttpUrl(item.url)) {
        sendServerNotice(ws, '播放项不存在');
        return;
      }
      const selIdx = items.findIndex((x) => x && x.id === id);
      applyReadingFocus(st, id);
      const navOut = normalizePlaylistUrlKey(item.url);
      const prevSel = st.lastNavigateUrl;
      st.lastNavigateUrl = navOut;
      if (prevSel !== navOut) {
        resetJumpVerifyRoundForRoom(clientRoom);
      }
      st.lastVideoTime = null;
      st.lastPlaybackRate = null;
      st.lastVideoPlaying = false;
      roomState.set(clientRoom, st);
      dbg('playlist_select', {
        id,
        selIdx,
        url: dbgUrl(navOut),
        watchedCount: items.filter((x) => x && normalizeReadStatus(x.readStatus) === 'read').length,
      });
      broadcastRoom(clientRoom, { type: 'navigate', url: navOut });
      broadcastPlaylistState(clientRoom);
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'navigate_ack', url: navOut }));
        }
      } catch (_) {}
      return;
    }

    /**
     * 房主：跟随标签与列表项匹配时由扩展上报，applyReadingFocus（原 reading→read，本条→reading）；
     * 不广播 navigate。
     */
    if (type === 'playlist_current_match') {
      if (!clientRoom) {
        sendServerNotice(ws, '未加入房间', 'playlist_current_match');
        return;
      }
      const clients = rooms.get(clientRoom);
      const peer = clients && clients.get(ws);
      if (!peer || peer.role !== 'host') {
        sendServerNotice(ws, '仅房主可同步当前播放', 'playlist_current_match');
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id.trim() : '';
      if (!id) {
        return;
      }
      let st = getOrInitRoomState(clientRoom);
      const items = Array.isArray(st.playlistItems) ? st.playlistItems : [];
      const item = items.find((x) => x && x.id === id);
      if (!item || !isHttpUrl(item.url)) {
        sendServerNotice(ws, '播放项不存在', 'playlist_current_match');
        return;
      }
      applyReadingFocus(st, id);
      const navOut = normalizePlaylistUrlKey(item.url);
      const prevMatch = st.lastNavigateUrl;
      st.lastNavigateUrl = navOut;
      if (prevMatch !== navOut) {
        resetJumpVerifyRoundForRoom(clientRoom);
      }
      st.lastVideoTime = null;
      st.lastPlaybackRate = null;
      st.lastVideoPlaying = false;
      roomState.set(clientRoom, st);
      dbg('playlist_current_match', {
        id,
        url: dbgUrl(navOut),
        readCount: items.filter((x) => x && normalizeReadStatus(x.readStatus) === 'read').length,
      });
      broadcastPlaylistState(clientRoom);
      return;
    }

    if (type === 'video_sync') {
      if (!clientRoom) {
        ws.send(JSON.stringify({ type: 'error', message: '未加入房间' }));
        return;
      }
      const clients = rooms.get(clientRoom);
      const peer = clients && clients.get(ws);
      if (!peer || peer.role !== 'host') {
        ws.send(JSON.stringify({ type: 'error', message: '仅房主可同步播放（暂停/进度/倍速）' }));
        return;
      }
      const act = msg.action;
      const allowed = ['time', 'play', 'pause', 'seek'];
      if (!act || allowed.indexOf(act) === -1) {
        return;
      }
      mergeHostVideoSnapshot(clientRoom, act, msg);
      const out = { type: 'video_sync', action: act };
      if (typeof msg.currentTime === 'number' && !isNaN(msg.currentTime)) {
        out.currentTime = msg.currentTime;
      }
      if (typeof msg.playbackRate === 'number' && msg.playbackRate > 0 && msg.playbackRate <= 4) {
        out.playbackRate = msg.playbackRate;
      }
      if (act === 'time' && typeof msg.playing === 'boolean') {
        out.playing = msg.playing;
      }
      broadcastRoomExcept(clientRoom, ws, out);
      return;
    }

    if (type === 'sync_status_report') {
      if (!clientRoom) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: '未加入房间' }));
        } catch (_) {}
        return;
      }
      const clients = rooms.get(clientRoom);
      const peer = clients && clients.get(ws);
      if (!peer) return;
      const jumpRoundReset = msg.jumpRoundReset === true || msg.jumpRoundReset === 'true';
      if (jumpRoundReset) {
        peer.jvAttempts = 0;
        peer.jvSuccess = null;
        peer.jumpDesyncSince = null;
      }
      let rttMs = null;
      if (typeof msg.rttMs === 'number' && !isNaN(msg.rttMs) && msg.rttMs >= 0 && msg.rttMs < 60000) {
        rttMs = Math.round(msg.rttMs);
      }
      peer.lastRttMs = rttMs;
      const rawFollow = typeof msg.followUrl === 'string' ? msg.followUrl.trim() : '';
      let followNorm = '';
      if (rawFollow && isHttpUrl(rawFollow)) {
        followNorm = normalizePlaylistUrlKey(rawFollow);
      }
      const st = getOrInitRoomState(clientRoom);
      const canon = st.lastNavigateUrl;
      const canonNorm = canon && isHttpUrl(canon) ? normalizePlaylistUrlKey(canon) : '';
      if (!canonNorm) {
        peer.jvAttempts = 0;
        peer.jvSuccess = null;
        peer.jumpDesyncSince = null;
        clients.set(ws, peer);
        emitRoster(clientRoom);
        return;
      }
      if (peer.jvSuccess === true && !jumpRoundReset) {
        peer.jumpDesyncSince = null;
        clients.set(ws, peer);
        emitRoster(clientRoom);
        return;
      }
      if (peer.jvSuccess === false && !jumpRoundReset) {
        if (maybeKickForJumpDesync(clientRoom, ws, peer, canonNorm)) return;
        clients.set(ws, peer);
        emitRoster(clientRoom);
        return;
      }
      peer.jvAttempts = (peer.jvAttempts || 0) + 1;
      const match = !!(followNorm && followNorm === canonNorm);
      if (match) {
        peer.jvSuccess = true;
      } else if (peer.jvAttempts >= JUMP_VERIFY_MAX_ATTEMPTS) {
        peer.jvSuccess = false;
      } else {
        peer.jvSuccess = null;
      }
      clients.set(ws, peer);
      if (maybeKickForJumpDesync(clientRoom, ws, peer, canonNorm)) return;
      emitRoster(clientRoom);
      return;
    }

    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  });

  ws.on('close', () => {
    forgetWs(ws);
    if (!clientRoom || !rooms.has(clientRoom)) return;
    const rid = clientRoom;
    clientRoom = null;
    removeClientFromRoom(rid, ws);
  });
});

setInterval(sweepIdleConnections, IDLE_SWEEP_MS);

server.listen(PORT, () => {
  console.log(`co-watch room server listening on ws://127.0.0.1:${PORT}`);
  console.log(`extension dir: ${EXTENSION_ROOT} (manifest version: ${readExtensionManifestVersion() || '(none)'})`);
  console.log(`GET http://127.0.0.1:${PORT}/extension.zip 或 /extension-{manifest版本}.zip`);
  console.log(`idle kick: no message for ${IDLE_CLOSE_MS}ms -> terminate (${IDLE_SWEEP_MS}ms sweep)`);
  console.log(`jump ✗ sustained ${JUMP_DESYNC_KICK_MS}ms -> remove client (host promotes next)`);
  if (CO_WATCH_DEBUG) {
    console.log('[co-watch] debug logging enabled (CO_WATCH_DEBUG=1 or DEBUG=co-watch)');
  }
});
