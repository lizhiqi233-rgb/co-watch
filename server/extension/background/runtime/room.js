chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const { action } = request || {};

  if (action === 'downloadExtensionUpdate') {
    const url = extensionDownloadUrl;
    const ver = serverExtensionVersion || 'update';
    if (!url) {
      sendResponse({ ok: false, error: '无可用的下载地址，请先连接到房间服务' });
      return false;
    }
    const safeVer = String(ver).replace(/[^\w.\-+]/g, '_');
    // saveAs: false：使用浏览器默认下载目录与内置下载流程，不弹出系统「另存为」
    // 版本紧贴 .zip 前，与服务端 Content-Disposition co-watch-extension-{ver}.zip 一致
    chrome.downloads.download(
      {
        url,
        filename: `co-watch-extension-${safeVer}.zip`,
        saveAs: false,
      },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message || '下载失败' });
          return;
        }
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  if (action === 'enterRoom') {
    const roomKey = String(request.roomKey || '').trim();
    if (roomKey.length < 1 || roomKey.length > 128) {
      sendResponse({ ok: false, error: '房间密码需为 1～128 个字符' });
      return false;
    }
    const ft = request.followTabId;
    pendingFollowTabId = typeof ft === 'number' && ft >= 0 ? ft : null;
    enterRoomPending = true;
    broadcastState({ lastError: null });
    getStorage([STORAGE_KEYS.displayName]).then((data) => {
      const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
      connectAnd(() => {
        sendRaw({ type: 'enter_room', roomKey, displayName });
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (action === 'setDisplayName') {
    const displayName = normalizeDisplayName(request.displayName);
    setStorage({ [STORAGE_KEYS.displayName]: displayName }).then(() => {
      if (currentRoomId && socket && socket.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'set_display_name', displayName });
      }
      broadcastState();
      sendResponse({ ok: true, displayName });
    });
    return true;
  }

  if (action === 'syncContext') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId == null) {
      sendResponse({
        syncActive: false,
        roomConnected: false,
        isFollowedTab: false,
        isHost: false,
        isMember: false,
        lastRoomKey: null,
        clientId: null,
        roomMembers: [],
        playlistItems: [],
        playlistCurrentId: null,
        /** 与服务端 playlist_state.currentId 一致，供房主自动连播算「下一集」；与 UI 用 resolve 的 playlistCurrentId 分离 */
        playlistCurrentIdForAdvance: null,
        playlistWatchedCount: 0,
        localExtensionVersion: String(
          (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
        ),
        serverExtensionVersion: null,
        extensionUpdateAvailable: false,
        extensionDownloadUrl: '',
        claimHostCooldownUntil: null,
      });
      return false;
    }
    getStorage([
      STORAGE_KEYS.followedTabId,
      STORAGE_KEYS.lastRoomKey,
      STORAGE_KEYS.role,
    ]).then((data) => {
      const followed = data[STORAGE_KEYS.followedTabId];
      const connected = !!(socket && socket.readyState === WebSocket.OPEN);
      const roomConnected = !!(currentRoomId && connected);
      const isFollowedTab = followed === tabId;
      const syncActive = roomConnected && isFollowedTab;
      const role = resolveEffectiveRole(data[STORAGE_KEYS.role]);
      const localExtensionVersion = String(
        (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
      );
      const respond = (followedTabTitle, followedTabUrl) => {
        sendResponse({
          syncActive: !!syncActive,
          roomConnected: !!roomConnected,
          isFollowedTab: !!isFollowedTab,
          isHost: !!(roomConnected && role === 'host'),
          isMember: !!(roomConnected && role === 'member'),
          lastRoomKey: data[STORAGE_KEYS.lastRoomKey] ?? null,
          clientId,
          roomMembers,
          playlistItems: roomConnected ? playlistItems : [],
          playlistCurrentId: roomConnected
            ? resolvePlaylistCurrentIdForUi(
                followedTabTitle,
                followedTabUrl,
                playlistCurrentIdFromServer
              )
            : null,
          playlistCurrentIdForAdvance: roomConnected
            ? typeof playlistCurrentIdFromServer === 'string' && playlistCurrentIdFromServer.trim()
              ? playlistCurrentIdFromServer.trim()
              : resolvePlaylistCurrentIdForUi(followedTabTitle, followedTabUrl, null)
            : null,
          playlistWatchedCount: roomConnected ? playlistWatchedCountFromServer : 0,
          localExtensionVersion,
          serverExtensionVersion,
          extensionUpdateAvailable: !!(
            extensionUpdateAvailable &&
            extensionDownloadUrl &&
            typeof extensionDownloadUrl === 'string' &&
            extensionDownloadUrl.length > 0
          ),
          extensionDownloadUrl: extensionDownloadUrl || '',
          claimHostCooldownUntil:
            roomConnected && claimHostCooldownUntil && claimHostCooldownUntil > Date.now()
              ? claimHostCooldownUntil
              : null,
        });
      };
      if (!roomConnected || followed == null) {
        respond(null, null);
        return;
      }
      chrome.tabs.get(followed, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          respond(null, null);
          return;
        }
        respond(tab.title || '', tab.url || '');
      });
    });
    return true;
  }

  if (action === 'claimHost') {
    if (!currentRoomId || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: '未在房间中' });
      return false;
    }
    const ok = sendRaw({ type: 'claim_host' });
    sendResponse({ ok: !!ok });
    return false;
  }

  return false;
});
