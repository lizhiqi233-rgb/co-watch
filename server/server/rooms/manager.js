const {
  computeJumpSyncedDisplay,
  defaultRoomState,
  getOrInitRoomState,
  getPlaylistPayload,
  isHttpUrl,
  mergeHostVideoSnapshot,
  normalizePlaylistUrlKey,
} = require('./state.js');


class RoomManager {
  constructor({
    maxRooms,
    maxRoomClients,
    claimHostCooldownMs,
    jumpDesyncKickMs,
    rosterBroadcastDelayMs,
    debug,
  }) {
    this.rooms = new Map();
    this.roomState = new Map();
    this.rosterTimers = new Map();
    this.maxRooms = maxRooms;
    this.maxRoomClients = maxRoomClients;
    this.claimHostCooldownMs = claimHostCooldownMs;
    this.jumpDesyncKickMs = jumpDesyncKickMs;
    this.rosterBroadcastDelayMs = rosterBroadcastDelayMs || 500;
    this.debug = debug || (() => {});
  }

  hasRoom(roomId) {
    return this.rooms.has(roomId);
  }


  getClients(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getPeer(roomId, ws) {
    const clients = this.getClients(roomId);
    return clients ? clients.get(ws) || null : null;
  }

  getRoomSize(roomId) {
    const clients = this.getClients(roomId);
    return clients ? clients.size : 0;
  }

  getOrInitRoomState(roomId) {
    return getOrInitRoomState(this.roomState, roomId);
  }
  getPlaylistPayload(roomId) {
    return getPlaylistPayload(this.roomState.get(roomId));
  }
  resetVideoSnapshot(roomId) {
    const state = this.getOrInitRoomState(roomId);
    state.lastVideoTime = null;
    state.lastPlaybackRate = null;
    state.lastVideoPlaying = false;
    return state;
  }

  createRoom(roomId, ws, peer) {
    if (this.rooms.has(roomId)) return { ok: false, reason: 'exists' };
    if (this.rooms.size >= this.maxRooms) return { ok: false, reason: 'room_limit' };
    const clients = new Map();
    clients.set(ws, peer);
    this.rooms.set(roomId, clients);
    this.roomState.set(roomId, defaultRoomState());
    return { ok: true };
  }
  addClient(roomId, ws, peer) {
    const clients = this.getClients(roomId);
    if (!clients || clients.size >= this.maxRoomClients) return false;
    clients.set(ws, peer);
    return true;
  }
  setPeer(roomId, ws, peer) {
    const clients = this.getClients(roomId);
    if (clients && clients.has(ws)) clients.set(ws, peer);
  }
  resetJumpVerifyRound(roomId) {
    const clients = this.getClients(roomId);
    if (!clients) return;
    for (const [ws, peer] of clients.entries()) {
      peer.jvAttempts = 0;
      peer.jvSuccess = null;
      peer.jumpDesyncSince = null;
      clients.set(ws, peer);
    }
  }
  getClaimHostCooldownUntil(roomId) {
    const state = this.roomState.get(roomId);
    if (!state || typeof state.lastClaimHostAt !== 'number' || state.lastClaimHostAt <= 0) {
      return null;
    }
    const until = state.lastClaimHostAt + this.claimHostCooldownMs;
    return Date.now() >= until ? null : until;
  }
  buildMembersPayload(roomId, clients) {
    const state = this.roomState.get(roomId);
    const canonical = state && state.lastNavigateUrl;
    const canonicalUrl = canonical && isHttpUrl(canonical) ? normalizePlaylistUrlKey(canonical) : '';
    const members = [];
    for (const peer of clients.values()) {
      const rttMs = typeof peer.lastRttMs === 'number' && !isNaN(peer.lastRttMs)
        ? Math.round(peer.lastRttMs)
        : null;
      members.push({
        clientId: peer.id,
        role: peer.role,
        displayName: peer.displayName || '访客',
        rttMs,
        jumpSynced: computeJumpSyncedDisplay(peer, canonicalUrl),
      });
    }
    return members;
  }
  cancelScheduledRoster(roomId) {
    const timer = this.rosterTimers.get(roomId);
    if (timer == null) return;
    clearTimeout(timer);
    this.rosterTimers.delete(roomId);
  }
  emitRoster(roomId) {
    this.cancelScheduledRoster(roomId);
    const clients = this.getClients(roomId);
    if (!clients) return;
    this.broadcastRoom(roomId, {
      type: 'room_roster',
      members: this.buildMembersPayload(roomId, clients),
      claimHostCooldownUntil: this.getClaimHostCooldownUntil(roomId),
    });
  }
  scheduleRoster(roomId) {
    if (!this.hasRoom(roomId) || this.rosterTimers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.rosterTimers.delete(roomId);
      this.emitRoster(roomId);
    }, this.rosterBroadcastDelayMs);
    this.rosterTimers.set(roomId, timer);
  }

  removeClientFromRoom(roomId, ws, { skipEmitRoster = false } = {}) {
    const clients = this.getClients(roomId);
    if (!clients || !clients.has(ws)) return;
    const peer = clients.get(ws);
    const wasHost = peer && peer.role === 'host';
    clients.delete(ws);
    if (clients.size === 0) {
      this.cancelScheduledRoster(roomId);
      this.rooms.delete(roomId);
      this.roomState.delete(roomId);
      return;
    }
    if (wasHost) this.promoteNewHost(roomId);
    if (!skipEmitRoster) this.emitRoster(roomId);
  }

  promoteNewHost(roomId) {
    const clients = this.getClients(roomId);
    if (!clients || clients.size === 0) return;
    for (const ws of clients.keys()) {
      if (this.assignRoomHost(roomId, ws, { reason: 'auto' })) return;
    }
  }

  assignRoomHost(roomId, newHostWs, opts) {
    const clients = this.getClients(roomId);
    if (!clients || !clients.has(newHostWs)) return false;
    const newPeer = clients.get(newHostWs);
    if (!newPeer) return false;
    if (newPeer.role === 'host') return true;

    for (const [ws, peer] of clients.entries()) {
      if (peer && peer.role === 'host' && ws !== newHostWs) {
        peer.role = 'member';
        clients.set(ws, peer);
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'demoted', role: 'member' }));
          } catch (_) {}
        }
      }
    }

    newPeer.role = 'host';
    clients.set(newHostWs, newPeer);
    if (newHostWs.readyState !== 1) {
      this.removeClientFromRoom(roomId, newHostWs, { skipEmitRoster: true });
      return false;
    }
    try {
      newHostWs.send(JSON.stringify({ type: 'promoted', role: 'host' }));
    } catch (_) {
      this.removeClientFromRoom(roomId, newHostWs, { skipEmitRoster: true });
      return false;
    }

    if (opts && opts.reason === 'claim_host') {
      const state = this.getOrInitRoomState(roomId);
      state.lastClaimHostAt = Date.now();
    }
    return true;
  }

  broadcastRoom(roomId, payload, except) {
    const clients = this.getClients(roomId);
    if (!clients) return;
    const raw = JSON.stringify(payload);
    const dead = [];
    for (const ws of clients.keys()) {
      if (except && ws === except) continue;
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
      this.removeClientFromRoom(roomId, ws, { skipEmitRoster: true });
    }
    if (dead.length && this.hasRoom(roomId) && this.getRoomSize(roomId) > 0) {
      this.emitRoster(roomId);
    }
  }


  broadcastPlaylistState(roomId) {
    const state = this.roomState.get(roomId);
    if (!state) return;
    this.broadcastRoom(roomId, { type: 'playlist_state', ...getPlaylistPayload(state) });
  }

  mergeHostVideoSnapshot(roomId, action, message) {
    mergeHostVideoSnapshot(this.roomState.get(roomId), action, message);
  }

  maybeKickForJumpDesync(roomId, ws, peer, canonicalUrl) {
    if (!canonicalUrl) {
      peer.jumpDesyncSince = null;
      return false;
    }
    const display = computeJumpSyncedDisplay(peer, canonicalUrl);
    if (display !== false) {
      peer.jumpDesyncSince = null;
      return false;
    }
    const now = Date.now();
    if (peer.jumpDesyncSince == null) peer.jumpDesyncSince = now;
    if (now - peer.jumpDesyncSince < this.jumpDesyncKickMs) return false;
    this.debug('kick jump desync sustained', {
      room: roomId,
      clientId: peer.id,
      ms: this.jumpDesyncKickMs,
    });
    this.removeClientFromRoom(roomId, ws);
    try {
      ws.terminate();
    } catch (_) {}
    return true;
  }
}

module.exports = { RoomManager };
