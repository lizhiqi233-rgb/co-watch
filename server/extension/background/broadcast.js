/**
 * @param {object} [extra]
 * @param {{ followedTabId?: number | null }} [stateHints] 覆盖刚从 storage 写入的值（Edge 上 set 后立即 get 可能仍为旧值，右键菜单会卡在「发送到协同浏览」）
 */
function broadcastState(extra, stateHints) {
  if (extra && 'lastError' in extra) lastError = extra.lastError;
  pendingStateExtra = { ...(pendingStateExtra || {}), ...(extra || {}) };
  pendingStateHints = { ...(pendingStateHints || {}), ...(stateHints || {}) };
  if (stateBroadcastTimer != null) return;
  stateBroadcastTimer = setTimeout(() => {
    stateBroadcastTimer = null;
    const nextExtra = pendingStateExtra;
    const nextHints = pendingStateHints;
    pendingStateExtra = null;
    pendingStateHints = null;
    broadcastStateNow(nextExtra, nextHints);
  }, STATE_BROADCAST_DEBOUNCE_MS);
}
function broadcastStateNow(extra, stateHints) {
  if (extra && 'lastError' in extra) {
    lastError = extra.lastError;
  }
  const connected = !!(socket && socket.readyState === WebSocket.OPEN);
  const payload = {
    type: 'state',
    connected,
    enterRoomPending,
    roomId: connected ? currentRoomId : null,
    followedTabId: null,
    roomMembers: connected ? roomMembers : [],
    roomConnected: !!(connected && currentRoomId),
    playlistItems: connected && currentRoomId ? playlistItems : [],
    playlistCurrentId: null,
    playlistWatchedCount: connected && currentRoomId ? playlistWatchedCountFromServer : 0,
    claimHostCooldownUntil: connected && currentRoomId ? claimHostCooldownUntil : null,
    ...(extra || {}),
    lastError,
  };
  getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
    let fid = data[STORAGE_KEYS.followedTabId];
    if (stateHints && Object.prototype.hasOwnProperty.call(stateHints, 'followedTabId')) {
      fid = stateHints.followedTabId;
    }
    payload.followedTabId = connected ? (fid ?? null) : null;
    payload.role = connected ? resolveEffectiveRole(data[STORAGE_KEYS.role]) : null;
    const applyPlaylistId = (tabTitle, tabUrl) => {
      payload.playlistCurrentId =
        connected && currentRoomId
          ? resolvePlaylistCurrentIdForUi(tabTitle, tabUrl, playlistCurrentIdFromServer)
          : null;
      chrome.runtime.sendMessage(payload).catch(() => {});
    };
    if (fid == null || !connected || !currentRoomId) {
      applyPlaylistId(null, null);
      return;
    }
    chrome.tabs.get(fid, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        applyPlaylistId(null, null);
        return;
      }
      applyPlaylistId(tab.title || '', tab.url || '');
      queuePlaylistReadSyncFromFollowedTab(fid, data[STORAGE_KEYS.role]);
    });
  });
  refreshContextMenuTitle(stateHints);
}
