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
