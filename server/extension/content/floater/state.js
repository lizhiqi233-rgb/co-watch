  /* ---------- 跟随标签页内：右上角可收起跳转条 ---------- */
  var floaterHostEl = null;
  var FLOATER_COLLAPSE_KEY = 'co-watch-floater-collapsed';
  var FLOATER_PL_HISTORY_KEY = 'co-watch-floater-pl-history';
  var FLOATER_PL_ADDER_KEY = 'co-watch-floater-pl-adder';
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

  function readShowPlaylistAdder() {
    try {
      return sessionStorage.getItem(FLOATER_PL_ADDER_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeShowPlaylistAdder(on) {
    try {
      sessionStorage.setItem(FLOATER_PL_ADDER_KEY, on ? '1' : '0');
    } catch (e) {}
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
