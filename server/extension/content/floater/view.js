  function ensurePageFloater(ctx) {
    if (!isTopFrameForFloater() || floaterHostEl) return;

    floaterHostEl = document.createElement('div');
    floaterHostEl.id = 'co-watch-floater-root';
    var sr = floaterHostEl.attachShadow({ mode: 'open' });
    sr.innerHTML = [
      '<style>',
      ':host { all: initial; color-scheme: light; --card: #fff; --surface: #f6f7f8; --surface-info: #eefaff; --input-bg: #fafbfc; --text: #18191c; --muted: #61666d; --muted-strong: #3f4248; --border: #e3e5e7; --border-soft: #edf0f2; --input-placeholder: #9499a1; --accent: #00aeec; --accent-hover: #23b9e8; --accent-ink: #008fbe; --accent-border: #b9eafa; --danger: #fb7299; --danger-hover: #ff85a9; --danger-ink: #d94f7a; --danger-bg: #fff1f5; --danger-border: #ffd1df; --success: #16a085; --warning: #c58b16; }',
      '@media (prefers-color-scheme: dark) {',
      '  :host { color-scheme: dark; --card: #23262b; --surface: #2b2f35; --surface-info: #14333f; --input-bg: #1f2226; --text: #f1f2f3; --muted: #a8adb4; --muted-strong: #d3d6da; --border: #3b4148; --border-soft: #343a40; --input-placeholder: #7f8790; --accent-hover: #28c4f2; --accent-ink: #63d5f5; --accent-border: #1e5d72; --danger-hover: #ff9abd; --danger-ink: #ffacc5; --danger-bg: #3b252e; --danger-border: #663847; --success: #5dd0b7; --warning: #e6b84e; }',
      '}',
      '* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
      '.card { position: fixed; top: 18px; right: 18px; z-index: 2147483647; width: 370px; padding: 18px 18px 16px; color: var(--text); background: var(--card); border: 1px solid var(--border); border-top: 3px solid var(--accent); border-radius: 16px; box-shadow: 0 14px 34px rgba(24,25,28,.16); }',
      '.card.collapsed { display: none; }',
      '.strip-stack { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147483647; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }',
      '.strip-stack.hidden { display: none !important; }',
      '.strip-skin { width: 100%; min-width: 44px; min-height: 88px; padding: 14px 8px; box-sizing: border-box; color: #fff; font-size: 13px; font-weight: 650; letter-spacing: 2px; line-height: 1.35; writing-mode: vertical-rl; text-orientation: mixed; user-select: none; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 14px 0 0 14px; box-shadow: -4px 6px 18px rgba(24,25,28,.16); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
      '.strip-main { background: linear-gradient(180deg, #00aeec, #008fc2); cursor: pointer; }',
      '.strip-queue-join { background: linear-gradient(180deg, #4c9cff, #3677dd); cursor: pointer; margin: 0; }',
      '.strip-queue-nav { background: linear-gradient(180deg, #9a83e8, #8069d6); cursor: pointer; margin: 0; }',
      '.strip-main:hover, .strip-queue-join:hover, .strip-queue-nav:hover { filter: brightness(1.06); }',
      '.strip-main.hidden, .strip-queue-join.hidden, .strip-queue-nav.hidden { display: none !important; }',
      '.title { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--text); font-size: 16px; font-weight: 750; }',
      '.title::before { width: 4px; height: 18px; content: ""; background: var(--accent); border-radius: 999px; }',
      '.identity { margin: 0 0 14px; padding: 9px 11px; color: var(--accent-ink); font-size: 12px; line-height: 1.5; font-weight: 650; background: var(--surface-info); border: 1px solid var(--accent-border); border-radius: 10px; }',
      '.sep { height: 1px; margin: 16px 0; background: var(--border-soft); }',
      '.url { width: 100%; padding: 10px 12px; color: var(--text); font-size: 13px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 10px; transition: border-color .15s ease, box-shadow .15s ease; }',
      '.url::placeholder { color: var(--input-placeholder); }',
      '.url:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,174,236,.18); }',
      '.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }',
      'button { min-height: 34px; padding: 8px 12px; color: var(--muted-strong); font-size: 12px; font-weight: 650; cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; transition: transform .12s ease, filter .12s ease; }',
      'button.primary { color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-hover)); border-color: transparent; box-shadow: 0 5px 12px rgba(0,174,236,.2); }',
      'button.danger { color: var(--danger-ink); background: var(--danger-bg); border-color: var(--danger-border); }',
      'button.danger:hover:not(:disabled) { filter: brightness(1.08); }',
      'button.btn-claim-host { color: var(--accent-ink); background: var(--surface-info); border-color: var(--accent-border); }',
      'button.btn-claim-host:hover:not(:disabled) { filter: brightness(1.08); }',
      'button:disabled { cursor: not-allowed; opacity: 0.55; }',
      'button:hover:not(:disabled) { filter: brightness(0.98); transform: translateY(-1px); }',
      '.err { min-height: 16px; margin-top: 7px; color: var(--danger-ink); font-size: 11px; line-height: 1.5; }',
      '.member-block { margin-top: 4px; }',
      '.member-title { margin: 0 0 7px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .03em; }',
      '.member-list { list-style: none; max-height: 190px; margin: 0; padding: 0; overflow-y: auto; }',
      '.member-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; color: var(--muted-strong); font-size: 12px; line-height: 1.45; border-bottom: 1px solid var(--border-soft); }',
      '.member-list li:last-child { border-bottom: none; }',
      '.member-label { flex: 1; min-width: 0; word-break: break-word; }',
      '.member-meta { display: flex; align-items: center; flex-shrink: 0; gap: 6px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }',
      '.member-rtt { font-weight: 650; }',
      '.member-rtt.rtt-low { color: var(--success); }',
      '.member-rtt.rtt-mid { color: var(--warning); }',
      '.member-rtt.rtt-high { color: var(--danger); }',
      '.member-rtt.rtt-unknown { color: var(--input-placeholder); }',
      '.member-jump { width: 1em; font-weight: 750; text-align: center; }',
      '.member-jump.ok { color: var(--success); }',
      '.member-jump.bad { color: var(--danger); }',
      '.member-jump.pending { color: var(--input-placeholder); font-weight: 650; }',
      '.playlist-block { margin-top: 14px; }',
      '.playlist-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; margin: 0 0 7px; }',
      '.playlist-head .playlist-head-title { flex: 1; margin: 0; }',
      '.btn-history { flex-shrink: 0; padding: 3px 10px; color: var(--muted); font-size: 11px; font-weight: 650; line-height: 1.35; cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; }',
      '.btn-history.on { color: var(--accent-ink); background: var(--surface-info); border-color: var(--accent-border); }',
      '.playlist-list { list-style: none; max-height: 180px; margin: 0; padding: 0; overflow-y: auto; }',
      '.playlist-empty { padding: 8px 0; color: var(--input-placeholder); font-size: 11px; line-height: 1.45; }',
      '.playlist-row { display: flex; align-items: center; justify-content: space-between; gap: 7px; padding: 8px 0; color: var(--muted-strong); font-size: 12px; line-height: 1.45; border-bottom: 1px solid var(--border-soft); }',
      '.playlist-row:last-child { border-bottom: none; }',
      '.playlist-row.is-current { margin: 0 -8px; padding-right: 8px; padding-left: 8px; background: var(--surface-info); border-bottom-color: transparent; border-radius: 8px; }',
      '.playlist-status { flex-shrink: 0; margin-right: 6px; padding: 2px 6px; font-size: 10px; font-weight: 650; line-height: 1.2; border-radius: 999px; }',
      '.playlist-status.st-unread { color: var(--muted); background: var(--surface); }',
      '.playlist-status.st-reading { color: var(--accent-ink); background: var(--surface-info); }',
      '.playlist-status.st-read { color: var(--success); background: rgba(22,160,133,.14); }',
      '.playlist-title-wrap { position: relative; flex: 1; min-width: 0; overflow: hidden; }',
      '.playlist-title-inner { display: inline-block; width: max-content; max-width: none; white-space: nowrap; vertical-align: top; }',
      '.playlist-title-inner.is-marquee { animation-name: pl-title-marquee; animation-timing-function: linear; animation-iteration-count: infinite; animation-direction: alternate; will-change: transform; }',
      '@keyframes pl-title-marquee { 0%, 12% { transform: translateX(0); } 44%, 56% { transform: translateX(calc(-1 * var(--pl-dx, 0px))); } 88%, 100% { transform: translateX(0); } }',
      '.playlist-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }',
      '.btn-pl, .btn-pl-del { padding: 3px 8px; font-size: 11px; border-radius: 7px; cursor: pointer; }',
      '.btn-pl { color: var(--accent-ink); background: var(--surface-info); border: 1px solid var(--accent-border); }',
      '.btn-pl-del { color: var(--danger-ink); background: var(--danger-bg); border: 1px solid var(--danger-border); }',
      '.update-block { margin: 0 0 14px; padding: 10px 12px; background: var(--surface-info); border: 1px solid var(--accent-border); border-radius: 10px; }',
      '.update-badge { margin: 0 0 5px; color: var(--accent-ink); font-size: 11px; font-weight: 750; }',
      '.update-meta { margin: 0 0 8px; color: var(--muted-strong); font-size: 11px; line-height: 1.5; }',
      '.update-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.btn-update { padding: 8px 12px; color: #fff; font-size: 12px; font-weight: 650; cursor: pointer; background: var(--accent); border: 1px solid var(--accent); border-radius: 9px; }',
      '.btn-update:disabled { cursor: wait; opacity: 0.85; }',
      '.update-spinner { width: 16px; height: 16px; flex-shrink: 0; border: 2px solid rgba(0,174,236,.22); border-top-color: var(--accent); border-radius: 50%; animation: co-watch-spin .65s linear infinite; }',
      '.update-spinner[hidden] { display: none !important; }',
      '.update-hint { margin-top: 7px; color: var(--muted); font-size: 10px; line-height: 1.45; }',
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
      '      <button type="button" class="btn-history btn-adder" title="开启：标题显示添加者">添加者</button>',
      '    </div>',
      '    <ul class="playlist-list"></ul>',
      '  </div>',
      '  <div class="sep"></div>',
      '  <input type="text" class="url" placeholder="https://example.com" autocomplete="off" autocapitalize="off" spellcheck="false" />',
      '  <div class="row">',
      '    <button type="button" class="btn-go primary">全员跳转</button>',
      '    <button type="button" class="btn-claim-host">抢房主</button>',
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
    var btnClaimHost = sr.querySelector('.btn-claim-host');
    var btnDisconnect = sr.querySelector('.btn-disconnect');
    var roleEl = sr.querySelector('.role-line');
    var memberListEl = sr.querySelector('.member-list');
    var playlistListEl = sr.querySelector('.playlist-list');
    var playlistHistBtn = sr.querySelector('.btn-history');
    var playlistAdderBtn = sr.querySelector('.btn-adder');
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
      btnGo: btnGo,
      btnDisconnect: btnDisconnect,
      btnCollapse: btnCollapse,
      playlistHistBtn: playlistHistBtn,
      playlistAdderBtn: playlistAdderBtn,
      errEl: errEl,
      input: input,
      btnClaimHost: btnClaimHost,
      updateBlockEl: updateBlockEl,
      updateMetaEl: updateMetaEl,
      btnUpdate: btnUpdate,
      updateSpinnerEl: updateSpinnerEl,
      setCollapsed: null,
    };

    var ui = floaterHostEl._coWatch;
    bindFloaterActions(ui, ctx);

    (document.body || document.documentElement).appendChild(floaterHostEl);
    syncRightRail(ctx);
  }
