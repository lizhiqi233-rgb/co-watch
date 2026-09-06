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

  function pickVideoUncached() {
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
  function pickVideo() {
    if (pickedVideoCacheValid && (!pickedVideoCache || pickedVideoCache.isConnected)) {
      return pickedVideoCache;
    }
    pickedVideoCache = pickVideoUncached();
    pickedVideoCacheValid = true;
    return pickedVideoCache;
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
