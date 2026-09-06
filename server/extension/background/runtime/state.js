chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action } = request || {};

  if (action === 'setCoWatchDebug') {
    const on = !!request.enabled;
    setStorage({ [STORAGE_KEYS.coWatchDebug]: on }).then(() => {
      coWatchDebug = on;
      console.log('[co-watch]', new Date().toISOString(), 'debug logging', on ? 'on' : 'off');
      sendResponse({ ok: true, coWatchDebug: on });
    });
    return true;
  }

  if (action === 'getState') {
    getStorage([
      STORAGE_KEYS.serverWsUrl,
      STORAGE_KEYS.roomId,
      STORAGE_KEYS.role,
      STORAGE_KEYS.followedTabId,
      STORAGE_KEYS.lastRoomKey,
      STORAGE_KEYS.displayName,
    ]).then((data) => {
      const connected = !!(socket && socket.readyState === WebSocket.OPEN);
      const fid = connected ? (data[STORAGE_KEYS.followedTabId] ?? null) : null;
      const base = {
        serverWsUrl: data[STORAGE_KEYS.serverWsUrl] || DEFAULT_WS,
        roomId: connected ? (currentRoomId || data[STORAGE_KEYS.roomId] || null) : null,
        role: connected ? resolveEffectiveRole(data[STORAGE_KEYS.role]) : null,
        followedTabId: fid,
        lastRoomKey: data[STORAGE_KEYS.lastRoomKey] ?? null,
        displayName: data[STORAGE_KEYS.displayName] ?? '',
        roomMembers: connected ? roomMembers : [],
        roomConnected: !!(connected && currentRoomId),
        playlistItems: connected && currentRoomId ? playlistItems : [],
        playlistWatchedCount: connected && currentRoomId ? playlistWatchedCountFromServer : 0,
        connected,
        clientId: connected ? clientId : null,
        lastError,
        enterRoomPending,
        localExtensionVersion: String(
          (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
        ),
        serverExtensionVersion,
        extensionUpdateAvailable,
        extensionDownloadUrl,
        coWatchDebug,
        claimHostCooldownUntil: connected && currentRoomId ? claimHostCooldownUntil : null,
      };
      const finish = (tabTitle, tabUrl) => {
        sendResponse({
          ...base,
          playlistCurrentId:
            connected && currentRoomId
              ? resolvePlaylistCurrentIdForUi(tabTitle, tabUrl, playlistCurrentIdFromServer)
              : null,
        });
      };
      if (fid == null || !connected || !currentRoomId) {
        finish(null, null);
        return;
      }
      chrome.tabs.get(fid, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          finish(null, null);
          return;
        }
        finish(tab.title || '', tab.url || '');
      });
    });
    return true;
  }

  if (action === 'setServerUrl') {
    const url = normalizeWsUrl(request.url);
    setStorage({ [STORAGE_KEYS.serverWsUrl]: url }).then(() => {
      sendResponse({ ok: true, serverWsUrl: url });
    });
    return true;
  }

  return false;
});
