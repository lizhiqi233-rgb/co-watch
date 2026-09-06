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
  var pickedVideoCache = null;
  var pickedVideoCacheValid = false;
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
    pickedVideoCache = null;
    pickedVideoCacheValid = false;
    lastDedupeTimeValue = NaN;
    lastDedupeTimeAt = 0;
    resetPlaylistAutoAdvanceState();
  }
