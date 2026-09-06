function handleServerMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (coWatchDebug && msg && msg.type && msg.type !== 'pong' && msg.type !== 'video_sync') {
    if (msg.type === 'navigate') dbg('ws←', msg.type, msg.url);
    else dbg('ws←', msg.type);
  }
  if (msg.type === 'pong') {
    if (pongWaitTimer != null) {
      clearTimeout(pongWaitTimer);
      pongWaitTimer = null;
    }
    const t0 = typeof msg.t === 'number' ? msg.t : null;
    const rttMs = t0 != null ? Math.max(0, Date.now() - t0) : null;
    sendSyncStatusReport(rttMs);
    return;
  }
  if (msg.type === 'extension_version') {
    const serverV = typeof msg.version === 'string' ? msg.version.trim() : '';
    const localV = String((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '').trim();
    serverExtensionVersion = serverV || null;
    if (serverV && localV && serverV !== localV) {
      extensionUpdateAvailable = true;
      const originUrl = configuredWsUrl || activeWsUrl;
      const origin = originUrl ? wsUrlToHttpOrigin(originUrl) : '';
      // 与服务端 /extension-{版本}.zip 对齐，避免多次下载同名 extension.zip 覆盖
      extensionDownloadUrl = origin
        ? `${origin}/extension-${encodeURIComponent(serverV)}.zip`
        : '';
    } else {
      extensionUpdateAvailable = false;
      extensionDownloadUrl = '';
    }
    broadcastState();
    return;
  }
  if (msg.type === 'room_created') {
    initializeRoomEntry(msg);
    setStorage({
      [STORAGE_KEYS.roomId]: currentRoomId,
      [STORAGE_KEYS.role]: currentRole,
      [STORAGE_KEYS.lastRoomKey]: currentRoomId,
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    }).then(() => applyPendingFollowTab()).then(() => {
      broadcastState({ lastError: null });
      pushRosterToFollowedTab();
      notifyFloaterReconnectComplete();
      flushPendingNavigate();
    });
    return;
  }
  if (msg.type === 'joined') {
    initializeRoomEntry(msg);
    const replayUrl =
      typeof msg.lastNavigateUrl === 'string' ? msg.lastNavigateUrl.trim() : '';
    const joinReplayStored =
      replayUrl && isAllowedHttpUrl(replayUrl) ? replayUrl : null;
    let joinResumeStored = null;
    if (msg.resumeVideo && typeof msg.resumeVideo === 'object') {
      const rv = msg.resumeVideo;
      const ct = rv.currentTime;
      if (typeof ct === 'number' && !isNaN(ct) && ct >= 0) {
        joinResumeStored = {
          currentTime: ct,
          playbackRate:
            typeof rv.playbackRate === 'number' && rv.playbackRate > 0 && rv.playbackRate <= 4
              ? rv.playbackRate
              : 1,
          playing: !!rv.playing,
        };
      }
    }
    setStorage({
      [STORAGE_KEYS.roomId]: currentRoomId,
      [STORAGE_KEYS.role]: currentRole,
      [STORAGE_KEYS.lastRoomKey]: currentRoomId,
      [STORAGE_KEYS.joinReplayUrl]: joinReplayStored,
      [STORAGE_KEYS.joinResumeVideo]: joinResumeStored,
    }).then(() => applyPendingFollowTab()).then((boundTid) => {
      broadcastState({ lastError: null });
      pushRosterToFollowedTab();
      maybeApplyJoinReplay(boundTid != null ? boundTid : undefined);
      flushPendingNavigate();
      /** 有后进房重放 URL 时会导航跟随页，延后通知以便新文档中的 content 收到并读回 sessionStorage */
      const delayMs = joinReplayStored ? 900 : 0;
      setTimeout(() => notifyFloaterReconnectComplete(), delayMs);
    });
    return;
  }
  if (msg.type === 'promoted' || msg.type === 'demoted') {
    applyRoleChange(msg);
    return;
  }
  if (msg.type === 'claim_host_cooldown') {
    const until = typeof msg.until === 'number' && !isNaN(msg.until) ? msg.until : null;
    claimHostCooldownUntil = until && until > Date.now() ? until : null;
    broadcastState();
    return;
  }
  if (msg.type === 'navigate' && msg.url) {
    const nav = String(msg.url).trim();
    if (!isAllowedHttpUrl(nav)) return;
    const navKey = normalizeUrlKeyForCoWatch(nav);
    // 服务端广播的 navigate 不经 sendNavigateReliable，若不同步键，跟随页 onUpdated 会再发 ws→ navigate，造成重复插入与循环
    lastHostFollowBroadcastKey = navKey;
    getStorage([STORAGE_KEYS.followedTabId, STORAGE_KEYS.role]).then((data) => {
      const tid = data[STORAGE_KEYS.followedTabId];
      const role = resolveEffectiveRole(data[STORAGE_KEYS.role]);

      const applyNavigateToFollowedTab = () => {
        setStorage({
          [STORAGE_KEYS.joinReplayUrl]: nav,
          [STORAGE_KEYS.joinResumeVideo]: null,
        }).then(() => {
          applyOpenFollowedUrl(
            nav,
            typeof tid === 'number' && tid >= 0 ? tid : undefined,
            { broadcastNavigate: true }
          );
        });
      };

      // 房主也会收到自己发出的 navigate 广播：跟随页已是该地址时勿 update/reload，否则整页重载或打断自动连播
      if (role === 'host' && typeof tid === 'number' && tid >= 0) {
        chrome.tabs.get(tid, (tab) => {
          if (chrome.runtime.lastError || !tab || !tab.url) {
            applyNavigateToFollowedTab();
            return;
          }
          if (!isAllowedHttpUrl(tab.url)) {
            applyNavigateToFollowedTab();
            return;
          }
          if (normalizeUrlKeyForCoWatch(tab.url) === navKey) {
            setStorage({
              [STORAGE_KEYS.joinReplayUrl]: nav,
              [STORAGE_KEYS.joinResumeVideo]: null,
            });
            return;
          }
          applyNavigateToFollowedTab();
        });
        return;
      }

      applyNavigateToFollowedTab();
    });
    return;
  }
  if (msg.type === 'navigate_ack') {
    const u = typeof msg.url === 'string' ? msg.url.trim() : '';
    if (navigateAckUrl && navigateUrlsMatch(u, navigateAckUrl)) {
      clearNavigateAckState();
      broadcastState({ lastError: null });
    }
    return;
  }
  if (msg.type === 'playlist_add_ack') {
    if (tabToCloseAfterPlaylistAddAck != null) {
      const tid = tabToCloseAfterPlaylistAddAck;
      tabToCloseAfterPlaylistAddAck = null;
      try {
        chrome.tabs.remove(tid, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
    return;
  }
  if (msg.type === 'server_notice') {
    lastError = typeof msg.message === 'string' ? msg.message : '';
    if (msg.code === 'playlist_add' && tabToCloseAfterPlaylistAddAck != null) {
      tabToCloseAfterPlaylistAddAck = null;
    }
    broadcastState();
    return;
  }
  if (msg.type === 'error') {
    enterRoomPending = false;
    pendingFollowTabId = null;
    pendingNavigateUrl = null;
    setStorage({
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    });
    clearNavigateAckState();
    broadcastState({ lastError: msg.message || '未知错误' });
    return;
  }
  if (msg.type === 'room_roster') {
    roomMembers = Array.isArray(msg.members) ? msg.members : [];
    const until =
      typeof msg.claimHostCooldownUntil === 'number' && !isNaN(msg.claimHostCooldownUntil)
        ? msg.claimHostCooldownUntil
        : null;
    claimHostCooldownUntil = until && until > Date.now() ? until : null;
    syncRoleFromRosterMembers();
    pushRosterToFollowedTab();
    broadcastState();
    return;
  }
  if (msg.type === 'playlist_state') {
    applyPlaylistFromServer(msg);
    broadcastState();
    return;
  }
  if (msg.type === 'video_sync') {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      const tabId = data[STORAGE_KEYS.followedTabId];
      if (tabId == null) return;
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'CO_WATCH_APPLY',
          action: msg.action,
          currentTime: msg.currentTime,
          playbackRate: msg.playbackRate,
          ...(typeof msg.playing === 'boolean' ? { playing: msg.playing } : {}),
        },
        () => void chrome.runtime.lastError
      );
    });
    return;
  }
}
