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
