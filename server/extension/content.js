(function () {
  var CO_WATCH_DEBUG_KEY = 'coWatchDebug';
  var coWatchPageDebug = false;
  function dbgPage() {
    if (!coWatchPageDebug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[co-watch][page]', new Date().toISOString());
    console.log.apply(console, args);
  }
  try {
    chrome.storage.local.get([CO_WATCH_DEBUG_KEY], function (r) {
      coWatchPageDebug = !!(r && r[CO_WATCH_DEBUG_KEY]);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[CO_WATCH_DEBUG_KEY]) return;
      coWatchPageDebug = !!changes[CO_WATCH_DEBUG_KEY].newValue;
    });
  } catch (e) {}

  var APPLY_FLAG = '__coWatchApplying';
  var lastTimeSent = 0;
  /** 房主：周期性发送 time + playing（暂停时 timeupdate 不可靠，故用定时器） */
  var hostPeriodicSyncIntervalId = null;
  var TIME_THROTTLE_MS = 1000;
  var DRIFT_SEC = 1.25;

  var fwdDebounceTimer = null;
  var fwdPendingKind = null;
  /** 上次 pickVideo 结果，用于检测换片 / 换播放器节点 */
  var lastPickedVideo = null;
  var lastLocationKey = '';
  /** 对连续相同的 time 同步去抖（多 iframe 或密集包） */
  var lastDedupeTimeValue = NaN;
  var lastDedupeTimeAt = 0;
  /** 全员跳转/换页后短时间内不发送 time、不跟 periodic time，避免加载期多 video 与自动播放策略冲突 */
  var navSyncCooldownUntil = 0;
  /** 当前片尾「将自动切下一项」是否已触发（回拖进度 remain>2s 会复位） */
  var playlistAutoAdvanceFired = false;
  var playlistAutoAdvancePending = false;
  /** 上次用于连播判断的「当前项」id；与 resolve UI 解耦，随服务端 currentId 变化时重置 fired */
  var lastPlaylistAdvanceCurId = null;
  /** 是否已尝试消费后进房 resumeVideo（每页一次） */
  var joinResumeConsumed = false;
  /** refreshFloaterUI 写入；用于仅房主执行列表自动连播，成员直接跳过（跟随房主广播即可） */
  var lastSyncCtx = null;

  /** 扩展热重载/更新后旧 content script 仍存活，chrome.runtime 不可用；检测到后停止轮询避免抛错 */
  var extContextDead = false;
  var scanIntervalId = null;
  var floaterPollId = null;
  /** @type {MutationObserver | null} */
  var rootMutationObserver = null;

  function isInvalidatedError(e) {
    if (!e) return false;
    var msg = e.message != null ? String(e.message) : String(e);
    return msg.indexOf('Extension context invalidated') !== -1;
  }

  function readRuntimeLastError() {
    try {
      return chrome.runtime.lastError;
    } catch (e) {
      return e;
    }
  }

  function teardownStaleContentScript() {
    if (extContextDead) return;
    extContextDead = true;
    try {
      if (scanIntervalId != null) clearInterval(scanIntervalId);
    } catch (e) {}
    scanIntervalId = null;
    try {
      if (hostPeriodicSyncIntervalId != null) clearInterval(hostPeriodicSyncIntervalId);
    } catch (e2) {}
    hostPeriodicSyncIntervalId = null;
    try {
      if (floaterPollId != null) clearInterval(floaterPollId);
    } catch (e) {}
    floaterPollId = null;
    try {
      if (rootMutationObserver) rootMutationObserver.disconnect();
    } catch (e) {}
    rootMutationObserver = null;
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (e) {}
    destroyPageFloater();
  }

  /** 站点常在捕获阶段拦截 Ctrl+A；在 window 上优先处理悬浮窗内地址栏全选 */
  window.addEventListener(
    'keydown',
    function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      var key = ev.key;
      if (key !== 'a' && key !== 'A') return;
      var path = ev.composedPath ? ev.composedPath() : [];
      var i;
      var host = null;
      for (i = 0; i < path.length; i++) {
        if (path[i] && path[i].id === 'co-watch-floater-root') {
          host = path[i];
          break;
        }
      }
      if (!host || !host.shadowRoot) return;
      var t = ev.target;
      if (!t || t.tagName !== 'INPUT') return;
      if (!t.classList || !t.classList.contains('url')) return;
      if (!host.shadowRoot.contains(t)) return;
      ev.preventDefault();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      else ev.stopPropagation();
      try {
        t.select();
      } catch (e) {}
    },
    true
  );

  function isCoWatchVideoFrame() {
    try {
      return window.self === window.top;
    } catch (e) {
      return false;
    }
  }

  function resetPlaylistAutoAdvanceState() {
    playlistAutoAdvanceFired = false;
    playlistAutoAdvancePending = false;
    lastPlaylistAdvanceCurId = null;
  }

  function resetPlayerSyncState() {
    lastTimeSent = 0;
    lastPickedVideo = null;
    lastDedupeTimeValue = NaN;
    lastDedupeTimeAt = 0;
    resetPlaylistAutoAdvanceState();
  }

  function isBilibiliVideoPage() {
    var h = location.hostname || '';
    if (
      h !== 'www.bilibili.com' &&
      h !== 'm.bilibili.com' &&
      h !== 'bilibili.com' &&
      !h.endsWith('.bilibili.com')
    ) {
      return false;
    }
    return /\/video\//.test(location.pathname || '');
  }

  function getBilibiliMainVideo() {
    var root = document.querySelector('#bilibili-player');
    if (!root) return null;
    var v = root.querySelector('.bpx-player-video-wrap video');
    if (v) return v;
    v = root.querySelector('video');
    return v || null;
  }

  function pickVideo() {
    if (isBilibiliVideoPage()) {
      var bv = getBilibiliMainVideo();
      if (bv) return bv;
    }
    var list = document.querySelectorAll('video');
    if (!list.length) return null;
    var i;
    var v;
    var r;
    var area;
    var best = null;
    var bestArea = 0;
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (!v.isConnected) continue;
      r = v.getBoundingClientRect();
      area = r.width * r.height;
      if (area < 1600) continue;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    if (best) {
      // 始终用面积最大的主画面，勿因「优先正在播放」误选广告/画中画（房主暂停主视频时仍会播）
      return best;
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].isConnected && !list[i].paused) return list[i];
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].isConnected) return list[i];
    }
    return null;
  }

  function setApplying(ms) {
    window[APPLY_FLAG] = true;
    setTimeout(function () {
      window[APPLY_FLAG] = false;
    }, ms || 400);
  }

  /**
   * 应用服务端 joined.resumeVideo：对齐进度并尝试 play（无自动播放时可能仍失败，需用户点播放）。
   */
  function applyJoinResume(rv) {
    if (!rv || typeof rv !== 'object') return;
    if (!isCoWatchVideoFrame()) return;
    var v = pickVideo();
    if (!v) return;
    setApplying(1500);
    try {
      var ct = rv.currentTime;
      if (typeof ct === 'number' && !isNaN(ct) && ct >= 0) {
        v.currentTime = ct;
      }
      var pr = rv.playbackRate;
      if (typeof pr === 'number' && pr > 0 && pr <= 4) {
        v.playbackRate = pr;
      }
    } catch (e) {}
    if (rv.playing) {
      v.play().catch(function () {});
      setTimeout(function () {
        if (extContextDead || window[APPLY_FLAG]) return;
        var vv = pickVideo();
        if (!vv || !rv.playing) return;
        if (vv.paused) {
          vv.play().catch(function () {});
        }
      }, 500);
    } else {
      try {
        v.pause();
      } catch (e2) {}
    }
  }

  function tryConsumeJoinResume() {
    if (extContextDead || joinResumeConsumed) return;
    if (!pickVideo()) return;
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive || !ctx.isFollowedTab) return;
      if (ctx.isHost) {
        joinResumeConsumed = true;
        return;
      }
      chrome.runtime.sendMessage({ action: 'consumeJoinResume' }, function (res) {
        var le = readRuntimeLastError();
        if (le) {
          if (isInvalidatedError(le)) teardownStaleContentScript();
          joinResumeConsumed = true;
          return;
        }
        joinResumeConsumed = true;
        if (res && res.resume) {
          applyJoinResume(res.resume);
        }
      });
    });
  }

  function applyRemote(msg) {
    if (window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    var v = pickVideo();
    if (!v) return;

    if (msg.action === 'time') {
      if (Date.now() < navSyncCooldownUntil) {
        return;
      }
      if (msg.currentTime == null || typeof msg.currentTime !== 'number' || isNaN(msg.currentTime)) {
        return;
      }
      // 未带 playing 的旧版房主：仅在其播放时发 time，等价于 hostPlaying=true
      var hostPlaying = !(msg.playing === false || msg.playing === 'false');

      if (!hostPlaying) {
        setApplying(400);
        try {
          if (msg.playbackRate != null && msg.playbackRate > 0 && msg.playbackRate <= 4) {
            v.playbackRate = msg.playbackRate;
          }
          var driftP = Math.abs(v.currentTime - msg.currentTime);
          if (driftP > DRIFT_SEC) {
            v.currentTime = msg.currentTime;
          }
          v.pause();
        } catch (eP) {}
        return;
      }

      if (v.paused) {
        try {
          v.play().catch(function () {});
        } catch (e0) {}
      }

      var drift0 = Math.abs(v.currentTime - msg.currentTime);
      if (drift0 <= DRIFT_SEC) {
        return;
      }
      var tn = Date.now();
      if (Math.abs(msg.currentTime - lastDedupeTimeValue) < 0.15 && tn - lastDedupeTimeAt < 500) {
        return;
      }
      var targetT = msg.currentTime;
      var prRemote =
        msg.playbackRate != null && msg.playbackRate > 0 && msg.playbackRate <= 4
          ? msg.playbackRate
          : null;
      setApplying(900);
      lastDedupeTimeValue = targetT;
      lastDedupeTimeAt = Date.now();
      var fin = false;
      function finishTime() {
        if (fin) return;
        fin = true;
        try {
          v.play().catch(function () {});
        } catch (e2) {}
      }
      function onSk() {
        v.removeEventListener('seeked', onSk);
        finishTime();
      }
      try {
        if (prRemote != null) {
          v.playbackRate = prRemote;
        }
        v.addEventListener('seeked', onSk, false);
        v.currentTime = targetT;
        setTimeout(function () {
          v.removeEventListener('seeked', onSk);
          finishTime();
        }, 700);
      } catch (e) {
        finishTime();
      }
      return;
    }

    setApplying(500);
    try {
      if (msg.playbackRate != null && msg.playbackRate > 0 && msg.playbackRate <= 4) {
        v.playbackRate = msg.playbackRate;
      }
      if (msg.currentTime != null && typeof msg.currentTime === 'number') {
        v.currentTime = msg.currentTime;
      }
      if (msg.action === 'play') {
        v.play().catch(function () {});
      } else if (msg.action === 'pause') {
        v.pause();
      }
    } catch (e) {}
  }

  function onRuntimeMessage(msg) {
    if (extContextDead) return;
    try {
      if (msg && msg.type === 'CO_WATCH_APPLY') {
        applyRemote(msg);
      }
      if (msg && msg.type === 'CO_WATCH_FLOATER') {
        if (msg.visible === false) {
          destroyPageFloater();
        } else {
          updatePageFloaterVisibility();
        }
      }
      if (msg && msg.type === 'CO_WATCH_RECONNECT_DONE') {
        askSync(function (ctx) {
          var v = null;
          try {
            v = sessionStorage.getItem(FLOATER_RECONNECT_PENDING_KEY);
          } catch (e) {}
          if (v == null) return;
          try {
            sessionStorage.removeItem(FLOATER_RECONNECT_PENDING_KEY);
          } catch (e2) {}
          var restoreCollapsed = v === '1';
          updatePageFloaterVisibility();
          setTimeout(function () {
            try {
              if (
                floaterHostEl &&
                floaterHostEl._coWatch &&
                typeof floaterHostEl._coWatch.setCollapsed === 'function'
              ) {
                floaterHostEl._coWatch.setCollapsed(restoreCollapsed);
              }
            } catch (e3) {}
          }, 80);
        });
      }
      if (msg && msg.type === 'CO_WATCH_ROSTER') {
        if (floaterHostEl && floaterHostEl._coWatch) {
          var ui = floaterHostEl._coWatch;
          askSync(function (ctx) {
            if (!ctx || !ctx.isFollowedTab) return;
            renderMemberList(ui.memberListEl, msg.members || [], msg.clientId, ctx.syncActive);
          });
        }
      }
    } catch (e) {
      if (isInvalidatedError(e)) teardownStaleContentScript();
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  function sendVideoToBg(payload) {
    if (extContextDead) return;
    try {
      chrome.runtime.sendMessage({ action: 'forwardVideoSync', payload: payload }, function () {
        var le = readRuntimeLastError();
        if (le && isInvalidatedError(le)) teardownStaleContentScript();
      });
    } catch (e) {
      if (isInvalidatedError(e)) teardownStaleContentScript();
    }
  }

  function askSync(cb) {
    if (extContextDead) {
      if (typeof cb === 'function') cb(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'syncContext' }, function (r) {
        var le = readRuntimeLastError();
        if (le) {
          if (isInvalidatedError(le)) teardownStaleContentScript();
          if (typeof cb === 'function') cb(null);
          return;
        }
        try {
          if (typeof cb === 'function') cb(r);
        } catch (e2) {
          if (isInvalidatedError(e2)) teardownStaleContentScript();
        }
      });
    } catch (e) {
      if (isInvalidatedError(e)) teardownStaleContentScript();
      if (typeof cb === 'function') cb(null);
    }
  }

  function forwardIfSync(kind, extra) {
    if (extContextDead) return;
    if (window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive) return;
      if (!ctx.isHost) return;
      var v = pickVideo();
      if (!v) return;
      var payload = {
        action: kind,
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
      };
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          payload[k] = extra[k];
        });
      }
      sendVideoToBg(payload);
    });
  }

  function forwardIfSyncDebounced(kind) {
    if (extContextDead) return;
    if (window[APPLY_FLAG]) return;
    fwdPendingKind = kind;
    if (fwdDebounceTimer) clearTimeout(fwdDebounceTimer);
    fwdDebounceTimer = setTimeout(function () {
      fwdDebounceTimer = null;
      var k = fwdPendingKind;
      fwdPendingKind = null;
      if (k) forwardIfSync(k);
    }, 60);
  }

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

  function onTimeUpdate() {
    if (window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    if (Date.now() < navSyncCooldownUntil) {
      return;
    }
    var vEarly = pickVideo();
    if (vEarly) tryPlaylistAutoAdvance(vEarly);
  }

  /** 房主：约每秒推送 currentTime + playbackRate + playing（不再单独发 play/pause，避免双通道竞态） */
  function hostPeriodicVideoSync() {
    if (extContextDead || window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    if (Date.now() < navSyncCooldownUntil) return;
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive || !ctx.isHost) return;
      var v = pickVideo();
      if (!v) return;
      var now = Date.now();
      if (now - lastTimeSent < TIME_THROTTLE_MS) return;
      lastTimeSent = now;
      sendVideoToBg({
        action: 'time',
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
        playing: !v.paused,
      });
    });
  }

  /** seek/倍速变更后立刻补发一帧，降低成员侧最多 1s 的状态滞后 */
  function flushHostVideoSnapshotNow() {
    if (extContextDead || window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    if (Date.now() < navSyncCooldownUntil) return;
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive || !ctx.isHost) return;
      var v = pickVideo();
      if (!v) return;
      lastTimeSent = Date.now();
      sendVideoToBg({
        action: 'time',
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
        playing: !v.paused,
      });
    });
  }

  function hostSeekThenAutoPlayMaybe(v, fromTime) {
    if (window[APPLY_FLAG]) return;
    var toTime = v.currentTime;
    if (fromTime >= 0 && Math.abs(toTime - fromTime) < 0.12) {
      return;
    }
    if (fromTime < 0 && toTime < 0.25) {
      return;
    }
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive || !ctx.isHost) return;
      forwardIfSync('seek');
      flushHostVideoSnapshotNow();
      setTimeout(function () {
        if (window[APPLY_FLAG]) return;
        askSync(function (ctx2) {
          if (!ctx2 || !ctx2.syncActive || !ctx2.isHost) return;
          var vv = pickVideo();
          if (!vv || !vv.paused) return;
          vv.play().catch(function () {});
          flushHostVideoSnapshotNow();
        });
      }, 130);
    });
  }

  function attachToVideo(v) {
    if (!isCoWatchVideoFrame()) return;
    if (!v || v.dataset.coWatchBound) return;
    v.dataset.coWatchBound = '1';
    var scrubFromTime = -1;
    v.addEventListener('seeking', function () {
      scrubFromTime = v.currentTime;
    });
    /** 不单独发 play/pause 信令，仅立即补发 time+playing，与周期快照同源 */
    v.addEventListener('play', function () {
      flushHostVideoSnapshotNow();
    });
    v.addEventListener('pause', function () {
      flushHostVideoSnapshotNow();
    });
    v.addEventListener('seeked', function () {
      var from = scrubFromTime;
      scrubFromTime = -1;
      hostSeekThenAutoPlayMaybe(v, from);
    });
    v.addEventListener('ratechange', function () {
      forwardIfSyncDebounced('seek');
      flushHostVideoSnapshotNow();
    });
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadstart', function () {
      if (pickVideo() === v) {
        resetPlayerSyncState();
        lastPickedVideo = v;
      }
    });
    v.addEventListener('emptied', function () {
      if (pickVideo() === v) {
        resetPlayerSyncState();
        lastPickedVideo = v;
      }
    });
  }

  function scan() {
    if (extContextDead) return;
    if (!isCoWatchVideoFrame()) return;
    try {
      var loc = location.href || '';
      if (loc !== lastLocationKey) {
        lastLocationKey = loc;
        navSyncCooldownUntil = Date.now() + 2800;
        joinResumeConsumed = false;
        resetPlayerSyncState();
      }
    } catch (e) {}
    var nodes = document.querySelectorAll('video');
    var i;
    for (i = 0; i < nodes.length; i++) {
      attachToVideo(nodes[i]);
    }
    var picked = pickVideo();
    if (picked !== lastPickedVideo) {
      lastPickedVideo = picked;
      lastTimeSent = 0;
      resetPlaylistAutoAdvanceState();
    }
    tryConsumeJoinResume();
  }

  function hookSpaNavigation() {
    if (!isCoWatchVideoFrame()) return;
    try {
      var np = history.pushState;
      var nr = history.replaceState;
      if (typeof np === 'function') {
        history.pushState = function () {
          var ret = np.apply(history, arguments);
          setTimeout(scan, 0);
          return ret;
        };
      }
      if (typeof nr === 'function') {
        history.replaceState = function () {
          var ret = nr.apply(history, arguments);
          setTimeout(scan, 0);
          return ret;
        };
      }
      window.addEventListener('popstate', function () {
        setTimeout(scan, 0);
      });
    } catch (e) {}
  }
  hookSpaNavigation();

  rootMutationObserver = new MutationObserver(function () {
    if (extContextDead) return;
    scan();
  });
  rootMutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  scan();
  scanIntervalId = setInterval(function () {
    if (extContextDead) return;
    scan();
  }, 3000);
  hostPeriodicSyncIntervalId = setInterval(hostPeriodicVideoSync, TIME_THROTTLE_MS);

  /* ---------- 跟随标签页内：右上角可收起跳转条 ---------- */
  var floaterHostEl = null;
  var FLOATER_COLLAPSE_KEY = 'co-watch-floater-collapsed';
  var FLOATER_PL_HISTORY_KEY = 'co-watch-floater-pl-history';
  /** 自动重连前记下收起状态，重连成功后再恢复（与 FLOATER_COLLAPSE_KEY 配合） */
  var FLOATER_RECONNECT_PENDING_KEY = 'co-watch-floater-reconnect-pending';

  function readFloaterCollapsedSession() {
    try {
      var v = sessionStorage.getItem(FLOATER_COLLAPSE_KEY);
      if (v === null) return true;
      return v === '1';
    } catch (e) {
      return true;
    }
  }
  /** 上一轮 ctx 是否已有「可下载的扩展更新」，用于仅在「刚出现更新」时自动展开悬浮窗 */
  var lastCtxHadUpdate = false;

  function isTopFrameForFloater() {
    try {
      return window.self === window.top;
    } catch (e) {
      return false;
    }
  }

  function destroyPageFloater() {
    if (floaterHostEl && floaterHostEl.parentNode) {
      floaterHostEl.parentNode.removeChild(floaterHostEl);
    }
    floaterHostEl = null;
    lastCtxHadUpdate = false;
  }

  function readShowPlaylistHistory() {
    try {
      return sessionStorage.getItem(FLOATER_PL_HISTORY_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeShowPlaylistHistory(on) {
    try {
      sessionStorage.setItem(FLOATER_PL_HISTORY_KEY, on ? '1' : '0');
    } catch (e) {}
  }

  /**
   * 与 background.js、服务端 index.js 中 normalizeReadStatus 语义一致。
   * @param {unknown} s
   * @returns {'unread'|'reading'|'read'}
   */
  function normalizeReadStatus(s) {
    if (s === 'reading' || s === 'read' || s === 'unread') return s;
    return 'unread';
  }

  /**
   * 播放列表标题：在固定宽度内对过长标题做左右往返滚动，便于读全名。
   * @param {HTMLElement} wrapEl
   * @param {HTMLElement} innerEl
   */
  function attachPlaylistTitleMarquee(wrapEl, innerEl) {
    if (!wrapEl || !innerEl) return;
    function measure() {
      // 必须用「外层」的溢出量：子元素设 max-width:100% 时，部分浏览器里 scrollWidth≈clientWidth，会误判为无需滚动。
      var dist = wrapEl.scrollWidth - wrapEl.clientWidth;
      if (dist <= 1) {
        innerEl.classList.remove('is-marquee');
        wrapEl.style.removeProperty('--pl-dx');
        innerEl.style.removeProperty('--pl-dx');
        innerEl.style.removeProperty('animation-duration');
        return;
      }
      wrapEl.style.setProperty('--pl-dx', dist + 'px');
      innerEl.style.setProperty('--pl-dx', dist + 'px');
      innerEl.classList.add('is-marquee');
      innerEl.style.animationDuration = Math.max(6, 5 + dist / 40) + 's';
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(measure);
    });
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(measure);
      ro.observe(wrapEl);
    }
  }

  function renderPlaylistBlock(ui, ctx) {
    var listEl = ui.playlistListEl;
    if (!listEl) return;
    if (ui.playlistHistBtn) {
      if (!ctx || !ctx.roomConnected || !ctx.syncActive) {
        ui.playlistHistBtn.style.display = 'none';
      } else {
        ui.playlistHistBtn.style.display = '';
        var histOn = readShowPlaylistHistory();
        ui.playlistHistBtn.classList.toggle('on', histOn);
        ui.playlistHistBtn.setAttribute('aria-pressed', histOn ? 'true' : 'false');
        ui.playlistHistBtn.title = histOn ? '收起：仅显示待看与在看' : '展开：显示待看、在看与看过';
      }
    }
    listEl.innerHTML = '';
    if (!ctx || !ctx.roomConnected) {
      var hint = document.createElement('li');
      hint.className = 'playlist-empty';
      hint.textContent = '连接房间后在此查看播放列表';
      listEl.appendChild(hint);
      return;
    }
    var canManage = !!ctx.syncActive;
    var items = ctx.playlistItems || [];
    var showHist = readShowPlaylistHistory();
    var displayItems = showHist
      ? items.slice()
      : items.filter(function (it) {
          if (!it) return false;
          var rs = normalizeReadStatus(it.readStatus);
          return rs === 'reading' || rs === 'unread';
        });
    if (!canManage) {
      var ro = document.createElement('li');
      ro.className = 'playlist-empty';
      ro.textContent = '当前页不是跟随页，仅可查看队列（在跟随页可点「播放」或「删除」）';
      listEl.appendChild(ro);
    }
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'playlist-empty';
      empty.textContent = '队列空，可在其他标签点右侧「加入队列」添加';
      listEl.appendChild(empty);
      return;
    }
    if (!displayItems.length) {
      var empty2 = document.createElement('li');
      empty2.className = 'playlist-empty';
      empty2.textContent = '当前无待看与在看（点「历史」可查看「看过」）';
      listEl.appendChild(empty2);
      return;
    }
    displayItems.forEach(function (it) {
      if (!it || !it.id) return;
      var row = document.createElement('li');
      row.className = 'playlist-row';
      if (ctx.playlistCurrentId === it.id) row.classList.add('is-current');
      var rs = normalizeReadStatus(it.readStatus);
      var badge = document.createElement('span');
      badge.className = 'playlist-status';
      if (rs === 'reading') {
        badge.textContent = '在看';
        badge.classList.add('st-reading');
      } else if (rs === 'read') {
        badge.textContent = '看过';
        badge.classList.add('st-read');
      } else {
        badge.textContent = '待看';
        badge.classList.add('st-unread');
      }
      var titleWrap = document.createElement('span');
      titleWrap.className = 'playlist-title-wrap';
      var titleInner = document.createElement('span');
      titleInner.className = 'playlist-title-inner';
      var fullTitle = String(it.title || it.url || '（无标题）');
      titleInner.textContent = fullTitle;
      titleWrap.title = String(it.title || it.url || '');
      titleWrap.appendChild(titleInner);
      row.appendChild(badge);
      row.appendChild(titleWrap);
      attachPlaylistTitleMarquee(titleWrap, titleInner);
      var actions = document.createElement('span');
      actions.className = 'playlist-actions';
      if (canManage) {
        if (ctx.isHost) {
          var btnPlay = document.createElement('button');
          btnPlay.type = 'button';
          btnPlay.className = 'btn-pl';
          btnPlay.textContent = '播放';
          (function (pid) {
            btnPlay.addEventListener('click', function (ev) {
              ev.stopPropagation();
              if (extContextDead) return;
              chrome.runtime.sendMessage({ action: 'playlistSelect', id: pid }, function () {
                var le = readRuntimeLastError();
                if (le && isInvalidatedError(le)) teardownStaleContentScript();
              });
            });
          })(it.id);
          actions.appendChild(btnPlay);
        }
        var btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn-pl-del';
        btnDel.textContent = '删除';
        (function (pid) {
          btnDel.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (extContextDead) return;
            chrome.runtime.sendMessage({ action: 'playlistRemove', id: pid }, function () {
              var le = readRuntimeLastError();
              if (le && isInvalidatedError(le)) teardownStaleContentScript();
            });
          });
        })(it.id);
        actions.appendChild(btnDel);
      }
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  /** @param {unknown} ms */
  function rttColorClass(ms) {
    if (ms == null || typeof ms !== 'number' || isNaN(ms)) return 'rtt-unknown';
    if (ms < 120) return 'rtt-low';
    if (ms < 350) return 'rtt-mid';
    return 'rtt-high';
  }

  /**
   * @param {unknown} js 服务端多次采样后的跳转对齐：true / false / null
   */
  function renderJumpCell(js) {
    var span = document.createElement('span');
    span.className = 'member-jump';
    if (js === true) {
      span.classList.add('ok');
      span.textContent = '✓';
      span.title = '本轮（标题/URL 更新或房间换页后）已与房间当前页一致';
      return span;
    }
    if (js === false) {
      span.classList.add('bad');
      span.textContent = '✗';
      span.title = '本轮不一致：重试中，或已满 5 次采样仍不一致';
      return span;
    }
    span.classList.add('pending');
    span.textContent = '…';
    span.title = '本轮尚未采样或等待首次结果（房间无当前页时也会显示）';
    return span;
  }

  function renderMemberList(container, members, selfId, syncActive) {
    if (!container) return;
    container.innerHTML = '';
    if (!syncActive) {
      var empty = document.createElement('li');
      empty.textContent = '未在协同会话中';
      empty.style.color = '#9ca3af';
      container.appendChild(empty);
      return;
    }
    var list = members && members.length ? members : [];
    if (!list.length) {
      var loading = document.createElement('li');
      loading.textContent = '加载成员…';
      loading.style.color = '#9ca3af';
      container.appendChild(loading);
      return;
    }
    list.forEach(function (m) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.className = 'member-label';
      var name = (m && m.displayName) || '访客';
      var extra = m && m.role === 'host' ? ' · 房主' : '';
      var me = selfId && m && m.clientId === selfId ? '（我）' : '';
      label.textContent = name + extra + me;

      var meta = document.createElement('span');
      meta.className = 'member-meta';
      var rttEl = document.createElement('span');
      rttEl.className = 'member-rtt ' + rttColorClass(m && m.rttMs);
      var rttVal = m && typeof m.rttMs === 'number' && !isNaN(m.rttMs) ? Math.round(m.rttMs) : null;
      rttEl.textContent = rttVal != null ? rttVal + 'ms' : '—';
      rttEl.title = rttVal != null ? '与服务器的往返延迟' : '尚未收到延迟样本';
      meta.appendChild(rttEl);
      meta.appendChild(renderJumpCell(m && m.jumpSynced));

      li.appendChild(label);
      li.appendChild(meta);
      container.appendChild(li);
    });
  }

  function refreshFloaterUI(ctx) {
    lastSyncCtx = ctx || null;
    if (!floaterHostEl || !floaterHostEl._coWatch) return;
    var ui = floaterHostEl._coWatch;
    var hasUp = !!(ctx && ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl);
    var idText = '身份：—';
    if (ctx && !ctx.isFollowedTab && hasUp) {
      idText = '身份：当前标签不是跟随页（可先更新扩展）';
    } else if (ctx && ctx.isFollowedTab) {
      if (ctx.syncActive) {
        idText = ctx.isHost
          ? '身份：房主（可控制播放）'
          : '身份：成员（仅跟随房主）';
      } else {
        idText = '身份：未连接房间';
      }
    }
    ui.roleEl.textContent = idText;
    if (ui.updateBlockEl) {
      ui.updateBlockEl.hidden = !hasUp;
      if (hasUp && ui.updateMetaEl) {
        ui.updateMetaEl.textContent =
          '服务端 ' +
          (ctx.serverExtensionVersion || '—') +
          ' · 本机 ' +
          (ctx.localExtensionVersion || '—');
      }
    }
    renderMemberList(
      ui.memberListEl,
      ctx && ctx.roomMembers ? ctx.roomMembers : [],
      ctx && ctx.clientId,
      !!(ctx && ctx.syncActive)
    );
    renderPlaylistBlock(ui, ctx);
    if (ui.btnDisconnect) {
      var inSession = !!(ctx && ctx.syncActive);
      ui.btnDisconnect.style.display = inSession ? 'inline-block' : 'none';
      ui.btnDisconnect.disabled = !inSession;
    }
    if (hasUp) {
      if (ui.setCollapsed && !lastCtxHadUpdate) {
        ui.setCollapsed(false);
      }
      lastCtxHadUpdate = true;
    } else {
      lastCtxHadUpdate = false;
    }
    syncRightRail(ctx);
  }

  /**
   * 右侧竖条栈：协同 / 全员跳转 / 加入队列；.strip-skin 统一尺寸。
   * 连接房间后：全员跳转在所有标签页显示；加入队列仅在非跟随标签页显示（跟随页不显示）。
   */
  function syncRightRail(ctx) {
    var ui = floaterHostEl && floaterHostEl._coWatch;
    if (!ui || !ui.stripStack) return;
    var showFloater = !!(
      ctx &&
      (ctx.isFollowedTab || (ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl))
    );
    var showQ = !!(
      ctx &&
      ctx.roomConnected &&
      (!ctx.isFollowedTab || ctx.syncActive)
    );
    var card = ui.card;
    var collapsed = !!(card && card.classList.contains('collapsed'));
    if (card) {
      card.style.display = showFloater ? '' : 'none';
    }
    var showStack = (showFloater && collapsed) || (showQ && !showFloater);
    ui.stripStack.classList.toggle('hidden', !showStack);
    if (ui.stripMain) {
      ui.stripMain.classList.toggle('hidden', !(showFloater && collapsed && showStack));
    }
    var showJoin = !!(showQ && showStack && ctx && !ctx.isFollowedTab);
    var showNav = !!(showStack && ctx && ctx.roomConnected);
    if (ui.stripQueueJoin) {
      ui.stripQueueJoin.classList.toggle('hidden', !showJoin);
    }
    if (ui.stripQueueNav) {
      ui.stripQueueNav.classList.toggle('hidden', !showNav);
    }
  }

  function ensurePageFloater(ctx) {
    if (!isTopFrameForFloater() || floaterHostEl) return;

    floaterHostEl = document.createElement('div');
    floaterHostEl.id = 'co-watch-floater-root';
    var sr = floaterHostEl.attachShadow({ mode: 'open' });
    sr.innerHTML = [
      '<style>',
      ':host { all: initial; }',
      '* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
      '.card { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 300px; padding: 10px 12px 12px; background: #fff; border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,.18); border: 1px solid #e5e7eb; }',
      '.card.collapsed { display: none; }',
      '.strip-stack { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147483647; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }',
      '.strip-stack.hidden { display: none !important; }',
      '.strip-skin { padding: 12px 7px; min-height: 72px; min-width: 40px; width: 100%; box-sizing: border-box; color: #fff; font-size: 13px; border-radius: 10px 0 0 10px; writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: 3px; box-shadow: -2px 0 16px rgba(0,0,0,.15); user-select: none; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
      '.strip-main { background: #2563eb; cursor: pointer; }',
      '.strip-queue-join { background: #059669; border: none; cursor: pointer; margin: 0; }',
      '.strip-queue-nav { background: #7c3aed; border: none; cursor: pointer; margin: 0; }',
      '.strip-main:hover, .strip-queue-join:hover, .strip-queue-nav:hover { filter: brightness(1.05); }',
      '.strip-main.hidden, .strip-queue-join.hidden, .strip-queue-nav.hidden { display: none !important; }',
      '.title { font-size: 13px; font-weight: 600; margin: 0 0 6px; color: #111827; }',
      '.identity { font-size: 12px; color: #374151; margin: 0 0 8px; line-height: 1.4; font-weight: 500; }',
      '.sep { height: 1px; background: #e5e7eb; margin: 8px 0; }',
      '.url { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }',
      '.url:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }',
      '.row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }',
      'button { padding: 7px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; }',
      'button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }',
      'button.danger { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }',
      'button.danger:hover:not(:disabled) { background: #fee2e2; }',
      'button:disabled { cursor: not-allowed; opacity: 0.55; }',
      'button:hover:not(:disabled) { filter: brightness(0.96); }',
      '.err { font-size: 11px; color: #b91c1c; margin-top: 4px; min-height: 14px; }',
      '.member-block { margin-top: 2px; }',
      '.member-title { font-size: 11px; font-weight: 600; color: #6b7280; margin: 0 0 4px; }',
      '.member-list { list-style: none; margin: 0; padding: 0; max-height: 168px; overflow-y: auto; }',
      '.member-list li { font-size: 12px; color: #374151; padding: 6px 0; border-bottom: 1px solid #f3f4f6; line-height: 1.35; display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.member-list li:last-child { border-bottom: none; }',
      '.member-label { flex: 1; min-width: 0; word-break: break-word; }',
      '.member-meta { flex-shrink: 0; display: flex; align-items: center; gap: 6px; font-size: 11px; font-variant-numeric: tabular-nums; }',
      '.member-rtt { font-weight: 600; }',
      '.member-rtt.rtt-low { color: #059669; }',
      '.member-rtt.rtt-mid { color: #ca8a04; }',
      '.member-rtt.rtt-high { color: #dc2626; }',
      '.member-rtt.rtt-unknown { color: #9ca3af; }',
      '.member-jump { font-weight: 700; width: 1em; text-align: center; }',
      '.member-jump.ok { color: #059669; }',
      '.member-jump.bad { color: #dc2626; }',
      '.member-jump.pending { color: #9ca3af; font-weight: 600; }',
      '.playlist-block { margin-top: 4px; }',
      '.playlist-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 4px; min-height: 18px; }',
      '.playlist-head .playlist-head-title { margin: 0; flex: 1; }',
      '.btn-history { font-size: 11px; font-weight: 600; padding: 2px 10px; line-height: 1.35; border-radius: 4px; cursor: pointer; border: 1px solid #d1d5db; background: #f9fafb; color: #6b7280; flex-shrink: 0; }',
      '.btn-history.on { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }',
      '.playlist-list { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow-y: auto; }',
      '.playlist-empty { font-size: 11px; color: #9ca3af; padding: 6px 0; line-height: 1.35; }',
      '.playlist-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: #374151; padding: 6px 0; border-bottom: 1px solid #f3f4f6; line-height: 1.35; }',
      '.playlist-row:last-child { border-bottom: none; }',
      '.playlist-row.is-current { background: #eff6ff; margin: 0 -6px; padding-left: 6px; padding-right: 6px; border-radius: 6px; border-bottom-color: transparent; }',
      '.playlist-status { flex-shrink: 0; font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px; margin-right: 6px; line-height: 1.2; }',
      '.playlist-status.st-unread { background: #f3f4f6; color: #6b7280; }',
      '.playlist-status.st-reading { background: #dbeafe; color: #1d4ed8; }',
      '.playlist-status.st-read { background: #ecfdf5; color: #047857; }',
      '.playlist-title-wrap { flex: 1; min-width: 0; overflow: hidden; position: relative; }',
      '.playlist-title-inner { display: inline-block; width: max-content; max-width: none; white-space: nowrap; vertical-align: top; }',
      '.playlist-title-inner.is-marquee { animation-name: pl-title-marquee; animation-timing-function: linear; animation-iteration-count: infinite; animation-direction: alternate; will-change: transform; }',
      '@keyframes pl-title-marquee { 0%, 12% { transform: translateX(0); } 44%, 56% { transform: translateX(calc(-1 * var(--pl-dx, 0px))); } 88%, 100% { transform: translateX(0); } }',
      '.playlist-actions { flex-shrink: 0; display: flex; gap: 4px; align-items: center; }',
      '.btn-pl, .btn-pl-del { padding: 2px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #374151; }',
      '.btn-pl { border-color: #2563eb; color: #1d4ed8; }',
      '.btn-pl-del { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }',
      '.update-block { margin: 0 0 10px; padding: 8px 10px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; }',
      '.update-badge { font-size: 11px; font-weight: 700; color: #1d4ed8; margin: 0 0 4px; }',
      '.update-meta { font-size: 11px; color: #374151; line-height: 1.4; margin: 0 0 6px; }',
      '.update-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.btn-update { padding: 7px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid #2563eb; background: #2563eb; color: #fff; }',
      '.btn-update:disabled { cursor: wait; opacity: 0.85; }',
      '.update-spinner { width: 16px; height: 16px; border: 2px solid rgba(37,99,235,.25); border-top-color: #2563eb; border-radius: 50%; animation: co-watch-spin 0.65s linear infinite; flex-shrink: 0; }',
      '.update-spinner[hidden] { display: none !important; }',
      '.update-hint { font-size: 10px; color: #6b7280; margin-top: 6px; line-height: 1.35; }',
      '@keyframes co-watch-spin { to { transform: rotate(360deg); } }',
      '</style>',
      '<div class="card">',
      '  <div class="title">协同浏览</div>',
      '  <div class="update-block" hidden>',
      '    <div class="update-badge">扩展更新</div>',
      '    <div class="update-meta"></div>',
      '    <div class="update-row">',
      '      <button type="button" class="btn-update">下载更新包（ZIP）</button>',
      '      <span class="update-spinner" hidden aria-hidden="true"></span>',
      '    </div>',
      '    <div class="update-hint">解压覆盖扩展文件夹后，在 chrome://extensions 刷新扩展。</div>',
      '  </div>',
      '  <div class="identity role-line">身份：—</div>',
      '  <div class="member-block">',
      '    <div class="member-title">房间内成员</div>',
      '    <ul class="member-list"></ul>',
      '  </div>',
      '  <div class="playlist-block">',
      '    <div class="playlist-head">',
      '      <span class="member-title playlist-head-title">播放列表</span>',
      '      <button type="button" class="btn-history" title="展开：显示待看、在看与看过">历史</button>',
      '    </div>',
      '    <ul class="playlist-list"></ul>',
      '  </div>',
      '  <div class="sep"></div>',
      '  <input type="text" class="url" placeholder="https://example.com" autocomplete="off" autocapitalize="off" spellcheck="false" />',
      '  <div class="row">',
      '    <button type="button" class="btn-go primary">全员跳转</button>',
      '    <button type="button" class="btn-disconnect danger">断开连接</button>',
      '    <button type="button" class="btn-collapse">侧边收起</button>',
      '  </div>',
      '  <div class="err"></div>',
      '</div>',
      '<div class="strip-stack hidden">',
      '  <div class="strip-skin strip-main hidden">协同</div>',
      '  <button type="button" class="strip-skin strip-queue-join hidden" title="将当前页加入房间播放列表">加入队列</button>',
      '  <button type="button" class="strip-skin strip-queue-nav hidden" title="与右键「发送到协同浏览」相同：将当前页同步给房间并全员跳转">全员跳转</button>',
      '</div>',
    ].join('');

    var card = sr.querySelector('.card');
    var stripStack = sr.querySelector('.strip-stack');
    var stripMain = sr.querySelector('.strip-main');
    var stripQueueJoin = sr.querySelector('.strip-queue-join');
    var stripQueueNav = sr.querySelector('.strip-queue-nav');
    var input = sr.querySelector('.url');
    var errEl = sr.querySelector('.err');
    var btnGo = sr.querySelector('.btn-go');
    var btnDisconnect = sr.querySelector('.btn-disconnect');
    var roleEl = sr.querySelector('.role-line');
    var memberListEl = sr.querySelector('.member-list');
    var playlistListEl = sr.querySelector('.playlist-list');
    var playlistHistBtn = sr.querySelector('.btn-history');
    var btnCollapse = sr.querySelector('.btn-collapse');
    var updateBlockEl = sr.querySelector('.update-block');
    var updateMetaEl = sr.querySelector('.update-meta');
    var btnUpdate = sr.querySelector('.btn-update');
    var updateSpinnerEl = sr.querySelector('.update-spinner');

    floaterHostEl._coWatch = {
      sr: sr,
      card: card,
      stripStack: stripStack,
      stripMain: stripMain,
      stripQueueJoin: stripQueueJoin,
      stripQueueNav: stripQueueNav,
      roleEl: roleEl,
      memberListEl: memberListEl,
      playlistListEl: playlistListEl,
      playlistHistBtn: playlistHistBtn,
      errEl: errEl,
      input: input,
      btnDisconnect: btnDisconnect,
      updateBlockEl: updateBlockEl,
      updateMetaEl: updateMetaEl,
      btnUpdate: btnUpdate,
      updateSpinnerEl: updateSpinnerEl,
      setCollapsed: null,
    };

    function readCollapsed() {
      try {
        var v = sessionStorage.getItem(FLOATER_COLLAPSE_KEY);
        if (v === null) return true;
        return v === '1';
      } catch (e) {
        return true;
      }
    }

    function setCollapsed(on) {
      try {
        sessionStorage.setItem(FLOATER_COLLAPSE_KEY, on ? '1' : '0');
      } catch (e) {}
      if (on) {
        card.classList.add('collapsed');
      } else {
        card.classList.remove('collapsed');
      }
      askSync(function (c) {
        syncRightRail(c);
      });
    }

    var hasUpInit = !!(ctx && ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl);
    var initialCollapsed = hasUpInit ? false : readCollapsed();
    setCollapsed(initialCollapsed);
    floaterHostEl._coWatch.setCollapsed = setCollapsed;

    function doNavigate() {
      if (extContextDead) return;
      var url = (input.value || '').trim();
      errEl.textContent = '';
      if (!url) {
        errEl.textContent = '请输入网址';
        return;
      }
      try {
        chrome.runtime.sendMessage({ action: 'navigate', url: url }, function (res) {
          var le = readRuntimeLastError();
          if (le) {
            if (isInvalidatedError(le)) teardownStaleContentScript();
            errEl.textContent = '扩展通信失败（若刚重载过扩展，请刷新本页）';
            return;
          }
          if (res && res.ok === false) {
            errEl.textContent = (res && res.error) || '无法跳转';
            return;
          }
          input.focus();
        });
      } catch (e) {
        if (isInvalidatedError(e)) teardownStaleContentScript();
        errEl.textContent = '扩展通信失败（若刚重载过扩展，请刷新本页）';
      }
    }

    btnGo.addEventListener('click', doNavigate);
    btnDisconnect.addEventListener('click', function () {
      if (extContextDead) return;
      errEl.textContent = '';
      try {
        chrome.runtime.sendMessage({ action: 'leaveRoom' }, function () {
          var le = readRuntimeLastError();
          if (le) {
            if (isInvalidatedError(le)) teardownStaleContentScript();
            errEl.textContent = '扩展通信失败（若刚重载过扩展，请刷新本页）';
            return;
          }
          updatePageFloaterVisibility();
        });
      } catch (e) {
        if (isInvalidatedError(e)) teardownStaleContentScript();
        errEl.textContent = '扩展通信失败';
      }
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        doNavigate();
      }
    });
    btnCollapse.addEventListener('click', function () {
      setCollapsed(true);
    });
    if (playlistHistBtn) {
      playlistHistBtn.addEventListener('click', function () {
        if (extContextDead) return;
        writeShowPlaylistHistory(!readShowPlaylistHistory());
        askSync(function (c) {
          refreshFloaterUI(c);
        });
      });
    }
    stripMain.addEventListener('click', function () {
      setCollapsed(false);
      input.focus();
    });
    stripQueueNav.addEventListener('click', function () {
      if (extContextDead) return;
      try {
        chrome.runtime.sendMessage(
          { action: 'sendToCoWatchFromFollowedStrip' },
          function () {
            var le = readRuntimeLastError();
            if (le && isInvalidatedError(le)) teardownStaleContentScript();
          }
        );
      } catch (e) {
        if (isInvalidatedError(e)) teardownStaleContentScript();
      }
    });
    stripQueueJoin.addEventListener('click', function () {
      if (extContextDead) return;
      try {
        chrome.runtime.sendMessage(
          {
            action: 'playlistAdd',
            url: location.href,
            title: document.title || '',
            closeTabAfter: true,
          },
          function () {
            var le = readRuntimeLastError();
            if (le && isInvalidatedError(le)) teardownStaleContentScript();
          }
        );
      } catch (e2) {
        if (isInvalidatedError(e2)) teardownStaleContentScript();
      }
    });

    btnUpdate.addEventListener('click', function () {
      if (extContextDead) return;
      errEl.textContent = '';
      btnUpdate.disabled = true;
      updateSpinnerEl.hidden = false;
      try {
        chrome.runtime.sendMessage({ action: 'downloadExtensionUpdate' }, function (res) {
          btnUpdate.disabled = false;
          updateSpinnerEl.hidden = true;
          var le = readRuntimeLastError();
          if (le) {
            if (isInvalidatedError(le)) teardownStaleContentScript();
            errEl.textContent = '扩展通信失败（若刚重载过扩展，请刷新本页）';
            return;
          }
          if (res && res.ok === false) {
            errEl.textContent = (res && res.error) || '下载失败';
            return;
          }
        });
      } catch (e) {
        btnUpdate.disabled = false;
        updateSpinnerEl.hidden = true;
        if (isInvalidatedError(e)) teardownStaleContentScript();
        errEl.textContent = '扩展通信失败';
      }
    });

    (document.body || document.documentElement).appendChild(floaterHostEl);
    syncRightRail(ctx);
  }

  function updatePageFloaterVisibility() {
    if (extContextDead) return;
    if (!isTopFrameForFloater()) return;
    askSync(function (ctx) {
      var showFloater =
        ctx &&
        (ctx.isFollowedTab ||
          (ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl));
      var showQueueStripPanel = !!(
        ctx &&
        ctx.roomConnected &&
        (!ctx.isFollowedTab || ctx.syncActive)
      );
      var needHost = !!(showFloater || showQueueStripPanel);
      if (needHost) {
        ensurePageFloater(ctx);
        refreshFloaterUI(ctx);
      } else {
        destroyPageFloater();
      }
    });
  }

  var floaterPollStarted = false;
  function startFloaterPolling() {
    if (!isTopFrameForFloater() || floaterPollStarted) return;
    floaterPollStarted = true;
    updatePageFloaterVisibility();
    floaterPollId = setInterval(updatePageFloaterVisibility, 1600);
  }

  /**
   * 心跳断线即将自动重连：记下当前是否收起，并展开主卡片便于看到重连提示。
   * 返回 true 表示将异步调用 sendResponse。
   */
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'CO_WATCH_PREPARE_HEARTBEAT_RECONNECT') return;
    if (extContextDead) {
      sendResponse({ ok: false });
      return;
    }
    if (!isTopFrameForFloater()) {
      sendResponse({ ok: false });
      return;
    }
    try {
      sessionStorage.setItem(
        FLOATER_RECONNECT_PENDING_KEY,
        readFloaterCollapsedSession() ? '1' : '0'
      );
    } catch (e) {}
    updatePageFloaterVisibility();
    setTimeout(function () {
      try {
        if (
          floaterHostEl &&
          floaterHostEl._coWatch &&
          typeof floaterHostEl._coWatch.setCollapsed === 'function'
        ) {
          floaterHostEl._coWatch.setCollapsed(false);
        }
      } catch (e2) {}
      try {
        sendResponse({ ok: true });
      } catch (e3) {}
    }, 100);
    return true;
  });

  if (document.body) {
    startFloaterPolling();
  } else {
    document.addEventListener('DOMContentLoaded', startFloaterPolling);
  }
})();
