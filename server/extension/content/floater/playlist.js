  function renderPlaylistBlock(ui, ctx) {
    var listEl = ui.playlistListEl;
    if (!listEl) return;
    var playlistControlsVisible = !!(ctx && ctx.roomConnected && ctx.syncActive);
    if (ui.playlistHistBtn) {
      ui.playlistHistBtn.style.display = playlistControlsVisible ? '' : 'none';
      if (playlistControlsVisible) {
        var histOn = readShowPlaylistHistory();
        ui.playlistHistBtn.classList.toggle('on', histOn);
        ui.playlistHistBtn.setAttribute('aria-pressed', histOn ? 'true' : 'false');
        ui.playlistHistBtn.title = histOn ? '收起：仅显示待看与在看' : '展开：显示待看、在看与看过';
      }
    }
    if (ui.playlistAdderBtn) {
      ui.playlistAdderBtn.style.display = playlistControlsVisible ? '' : 'none';
      if (playlistControlsVisible) {
        var adderOn = readShowPlaylistAdder();
        ui.playlistAdderBtn.classList.toggle('on', adderOn);
        ui.playlistAdderBtn.setAttribute('aria-pressed', adderOn ? 'true' : 'false');
        ui.playlistAdderBtn.title = adderOn ? '关闭：隐藏添加者' : '开启：标题显示添加者';
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
    var showAdder = readShowPlaylistAdder();
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
      var addedBy = showAdder && it.addedBy ? String(it.addedBy).trim() : '';
      var displayTitle = addedBy ? '【' + addedBy + '】' + fullTitle : fullTitle;
      titleInner.textContent = displayTitle;
      titleWrap.title = displayTitle;
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
