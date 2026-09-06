/** 名单中是否存在「除指定客户端外」的房主（用于判断房主转让是否已在名单上体现） */
function rosterHasOtherHost(excludeClientId) {
  if (!excludeClientId || !Array.isArray(roomMembers)) return false;
  return roomMembers.some(
    (m) => m && m.clientId && m.clientId !== excludeClientId && m.role === 'host'
  );
}

/**
 * 从房间成员列表同步本机角色。
 * 旧房主掉线后，若先收到 promoted 已为 host，再收到仍把本机标成 member、且名单中尚无其他房主的陈旧 room_roster，
 * 则不应把 currentRole 从 host 覆盖回 member，否则房主无法转发 video_sync，全员各播各的。
 */
function syncRoleFromRosterMembers() {
  if (!clientId || !Array.isArray(roomMembers) || roomMembers.length === 0) return;
  const self = roomMembers.find((m) => m && m.clientId === clientId);
  if (!self) return;
  const r = self.role;
  if (r !== 'host' && r !== 'member') return;
  if (currentRole === r) return;
  if (currentRole === 'host' && r === 'member' && !rosterHasOtherHost(clientId)) {
    return;
  }
  currentRole = r;
  setStorage({ [STORAGE_KEYS.role]: currentRole });
}

/**
 * 播放同步等权限判断：综合 roomMembers、内存中的 currentRole（含 promoted）与 storage。
 * 当名单滞后于 promoted 时，不得以陈旧 member 条目否定本机房主身份。
 * @param {string | null | undefined} storedRole chrome.storage 中的 role
 */
function resolveEffectiveRole(storedRole) {
  if (clientId && roomMembers.length) {
    const self = roomMembers.find((m) => m && m.clientId === clientId);
    if (self && (self.role === 'host' || self.role === 'member')) {
      if (self.role === 'member' && currentRole === 'host' && !rosterHasOtherHost(clientId)) {
        return 'host';
      }
      return self.role;
    }
  }
  if (currentRole === 'host' || currentRole === 'member') return currentRole;
  if (storedRole === 'host' || storedRole === 'member') return storedRole;
  return null;
}
function applyRoleChange(msg) {
  const role = msg.type === 'promoted' ? msg.role || 'host' : msg.role || 'member';
  currentRole = role;
  setStorage({ [STORAGE_KEYS.role]: currentRole });
  if (clientId && Array.isArray(roomMembers)) {
    const idx = roomMembers.findIndex((m) => m && m.clientId === clientId);
    if (idx >= 0) {
      roomMembers[idx] = { ...roomMembers[idx], role: currentRole };
    }
  }
  pushRosterToFollowedTab();
  broadcastState();
}
function initializeRoomEntry(msg) {
  enterRoomPending = false;
  heartbeatReconnectAttempts = 0;
  currentRoomId = msg.roomId;
  currentRole = msg.role;
  clientId = msg.clientId;
  applyPlaylistFromServer(msg.playlist);
  if (Array.isArray(msg.members) && msg.members.length) {
    roomMembers = msg.members;
    syncRoleFromRosterMembers();
  }
  lastError = null;
}
