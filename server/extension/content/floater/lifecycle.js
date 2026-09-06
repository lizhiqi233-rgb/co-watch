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
