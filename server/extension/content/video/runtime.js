  function onTimeUpdate() {
    if (window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    if (Date.now() < navSyncCooldownUntil) {
      return;
    }
    var vEarly = pickVideo();
    if (vEarly) tryPlaylistAutoAdvance(vEarly);
  }

  function sendHostVideoSnapshot(force) {
    if (extContextDead || window[APPLY_FLAG]) return;
    if (!isCoWatchVideoFrame()) return;
    if (Date.now() < navSyncCooldownUntil) return;
    askSync(function (ctx) {
      if (!ctx || !ctx.syncActive || !ctx.isHost) return;
      var v = pickVideo();
      if (!v) return;
      var now = Date.now();
      if (!force && now - lastTimeSent < TIME_THROTTLE_MS) return;
      lastTimeSent = now;
      sendVideoToBg({
        action: 'time',
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
        playing: !v.paused,
      });
    });
  }

  function hostPeriodicVideoSync() {
    sendHostVideoSnapshot(false);
  }

  function flushHostVideoSnapshotNow() {
    sendHostVideoSnapshot(true);
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
      pickedVideoCacheValid = false;
      if (pickVideo() === v) {
        resetPlayerSyncState();
        lastPickedVideo = v;
      }
    });
    v.addEventListener('emptied', function () {
      pickedVideoCacheValid = false;
      if (pickVideo() === v) {
        resetPlayerSyncState();
        lastPickedVideo = v;
      }
    });
  }

  function scan() {
    if (extContextDead) return;
    if (!isCoWatchVideoFrame()) return;
    pickedVideoCacheValid = false;
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
