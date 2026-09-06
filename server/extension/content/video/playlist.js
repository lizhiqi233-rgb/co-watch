  /** 房主：当前片剩余约 1s 且播放列表有下一项时，自动 playlistSelect 切下一集 */
  var PLAYLIST_NEAR_END_SEC = 1;
  var PLAYLIST_MIN_DURATION_AUTO = 2.5;

  /**
   * 自动连播的「下一集」：按列表顺序找下一项待看（unread），而不是简单的数组 idx+1。
   * 先扫当前索引之前的待看项（手动跳到第 2 集时，结束应先回补第 1 集），再扫当前之后的待看项
   * （第 1 集结束后应跳到第 3 集，因第 2 集已看过，而非再次播放第 2 集）。
   * normalizeReadStatus 在本 IIFE 内为函数声明，运行时已就绪。
   */
  function findNextPlaylistItemForAutoAdvance(items, currentIdx) {
    if (!items || !items.length || currentIdx < 0) return null;
    function isUnread(it) {
      if (!it) return false;
      return normalizeReadStatus(it.readStatus) === 'unread';
    }
    var i;
    for (i = 0; i < currentIdx; i++) {
      if (isUnread(items[i])) return items[i];
    }
    for (i = currentIdx + 1; i < items.length; i++) {
      if (isUnread(items[i])) return items[i];
    }
    return null;
  }

  function tryPlaylistAutoAdvance(v) {
    if (extContextDead || window[APPLY_FLAG]) return;
    if (!v || v.paused) return;
    // 仅房主自动连播；成员不发送 playlistSelect（页面随房主 navigate 已同步）
    if (
      lastSyncCtx &&
      (!lastSyncCtx.syncActive ||
        !lastSyncCtx.isFollowedTab ||
        !lastSyncCtx.isHost)
    ) {
      return;
    }
    var d = v.duration;
    if (!isFinite(d) || d < PLAYLIST_MIN_DURATION_AUTO) return;
    var remain = d - v.currentTime;
    if (remain > 2) {
      playlistAutoAdvanceFired = false;
      return;
    }
    if (remain <= 0) return;
    if (remain > PLAYLIST_NEAR_END_SEC + 0.08) return;
    if (playlistAutoAdvanceFired || playlistAutoAdvancePending) return;
    playlistAutoAdvancePending = true;
    askSync(function (ctx) {
      playlistAutoAdvancePending = false;
      if (!ctx || !ctx.syncActive || !ctx.isFollowedTab || !ctx.isHost) return;
      var items = ctx.playlistItems || [];
      var advanceCur =
        ctx.playlistCurrentIdForAdvance != null && String(ctx.playlistCurrentIdForAdvance).trim()
          ? String(ctx.playlistCurrentIdForAdvance).trim()
          : ctx.playlistCurrentId;
      if (advanceCur !== lastPlaylistAdvanceCurId) {
        lastPlaylistAdvanceCurId = advanceCur;
        playlistAutoAdvanceFired = false;
      }
      var cur = advanceCur;
      if (!items.length) return;
      var idx = -1;
      var i;
      for (i = 0; i < items.length; i++) {
        if (items[i] && items[i].id === cur) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        playlistAutoAdvanceFired = false;
        return;
      }
      var next = findNextPlaylistItemForAutoAdvance(items, idx);
      if (!next || !next.id) {
        playlistAutoAdvanceFired = false;
        return;
      }
      playlistAutoAdvanceFired = true;
      dbgPage('playlist auto-advance', {
        fromId: cur,
        toId: next.id,
        idx,
        nextMode: 'unread-order',
      });
      try {
        chrome.runtime.sendMessage({ action: 'playlistSelect', id: next.id }, function () {
          var le = readRuntimeLastError();
          if (le && isInvalidatedError(le)) teardownStaleContentScript();
        });
      } catch (e) {
        playlistAutoAdvanceFired = false;
        if (isInvalidatedError(e)) teardownStaleContentScript();
      }
    });
  }
