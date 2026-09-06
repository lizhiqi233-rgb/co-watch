function setFloaterCollapsed(ui, on) {
  try {
    sessionStorage.setItem(FLOATER_COLLAPSE_KEY, on ? '1' : '0');
  } catch (e) {}
  if (on) {
    ui.card.classList.add('collapsed');
  } else {
    ui.card.classList.remove('collapsed');
  }
  askSync(function (c) {
    syncRightRail(c);
  });
}

function bindFloaterActions(ui, ctx) {
  var card = ui.card;
  var input = ui.input;
  var errEl = ui.errEl;
  var btnGo = ui.btnGo;
  var btnClaimHost = ui.btnClaimHost;
  var btnDisconnect = ui.btnDisconnect;
  var btnCollapse = ui.btnCollapse;
  var playlistHistBtn = ui.playlistHistBtn;
  var playlistAdderBtn = ui.playlistAdderBtn;
  var stripMain = ui.stripMain;
  var stripQueueNav = ui.stripQueueNav;
  var stripQueueJoin = ui.stripQueueJoin;
  var btnUpdate = ui.btnUpdate;
  var updateSpinnerEl = ui.updateSpinnerEl;
  var hasUpInit = !!(ctx && ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl);
  var initialCollapsed = hasUpInit ? false : readFloaterCollapsedSession();
  ui.setCollapsed = function (on) {
    setFloaterCollapsed(ui, on);
  };
  setFloaterCollapsed(ui, initialCollapsed);

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
    btnClaimHost.addEventListener('click', function () {
      if (extContextDead) return;
      errEl.textContent = '';
      try {
        chrome.runtime.sendMessage({ action: 'claimHost' }, function (res) {
          var le = readRuntimeLastError();
          if (le) {
            if (isInvalidatedError(le)) teardownStaleContentScript();
            errEl.textContent = '扩展通信失败（若刚重载过扩展，请刷新本页）';
            return;
          }
          if (res && res.ok === false) {
            errEl.textContent = (res && res.error) || '抢房主失败';
            return;
          }
          updatePageFloaterVisibility();
        });
      } catch (e) {
        if (isInvalidatedError(e)) teardownStaleContentScript();
        errEl.textContent = '扩展通信失败';
      }
    });
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
      setFloaterCollapsed(ui, true);
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
    if (playlistAdderBtn) {
      playlistAdderBtn.addEventListener('click', function () {
        if (extContextDead) return;
        writeShowPlaylistAdder(!readShowPlaylistAdder());
        askSync(function (c) {
          refreshFloaterUI(c);
        });
      });
    }
    stripMain.addEventListener('click', function () {
      setFloaterCollapsed(ui, false);
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
}
