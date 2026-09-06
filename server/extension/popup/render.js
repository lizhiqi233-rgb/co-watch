function renderStatus(state, followedTabTitle) {
  const connected = state.connected;
  const room = state.roomId;
  const pending = !!state.enterRoomPending;

  let connText;
  if (pending && !room) {
    connText = connected ? '已连上服务，进房中…' : '正在连接服务…';
  } else {
    connText = connected ? '已连接' : '未连接';
  }
  el('statusConn').textContent = connText;

  let roomText;
  if (room) {
    roomText = '已在房间';
  } else if (pending) {
    roomText = '进房中…';
  } else {
    roomText = '未进房';
  }
  el('statusRoom').textContent = roomText;

  let followText = '未绑定';
  if (state.followedTabId != null) {
    const id = state.followedTabId;
    if (followedTabTitle) {
      followText = `「${coWatchTruncate(followedTabTitle, 32)}」 · #${id}`;
    } else {
      followText = `标签 #${id}（标题不可用）`;
    }
  }
  el('statusFollow').textContent = followText;

  setErrorBanner(state.lastError || '');
}

function renderBindInfo(state, followedTabTitle, activeTab) {
  const bind = el('bindInfo');
  if (!state.connected || !state.roomId) {
    bind.textContent = '进房成功后，可在此查看当前「跟随」标签页的标题。';
    return;
  }
  if (state.followedTabId == null) {
    bind.textContent = '尚未绑定跟随标签：在目标页点击「设为跟随」。';
    return;
  }
  const title = followedTabTitle ? `「${coWatchTruncate(followedTabTitle, 40)}」` : '（无法读取标题）';
  const isCurrent = activeTab && activeTab.id === state.followedTabId;
  bind.textContent = isCurrent
    ? `跟随页即当前标签：${title}（#${state.followedTabId}）`
    : `跟随页：${title}（#${state.followedTabId}）`;
}

async function refresh() {
  const state = await send('getState');
  if (!state) return;

  const server = state.serverWsUrl || 'ws://127.0.0.1:15777';
  el('serverUrl').value = formatServerUrlForDisplay(server);

  const room = state.roomId;
  const role = state.role;
  const lastKey = state.lastRoomKey || null;

  const idLine = el('identityLine');
  const dn = state.displayName != null ? state.displayName : '';
  el('displayName').value = dn;

  if (room) {
    el('roomPassword').value = room;
  } else if (lastKey && !el('roomPassword').value.trim()) {
    el('roomPassword').value = lastKey;
  }

  if (room && role) {
    idLine.hidden = false;
    idLine.textContent =
      '身份：' + (role === 'host' ? '房主（可控制播放）' : '成员（仅跟随房主）');
  } else {
    idLine.hidden = true;
    idLine.textContent = '';
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let followedTabTitle = null;
  if (state.followedTabId != null) {
    followedTabTitle = await getTabTitle(state.followedTabId);
  }

  renderStatus(state, followedTabTitle);
  renderBindInfo(state, followedTabTitle, activeTab);

  el('navPanel').hidden = !room;

  const chkDbg = el('chkDebugLog');
  if (chkDbg) {
    chkDbg.checked = !!state.coWatchDebug;
  }

  const busy = !!(state.enterRoomPending && !room);
  el('serverUrl').disabled = busy;
  el('roomPassword').disabled = busy;

  const roomBtn = el('btnEnter');
  roomBtn.disabled = busy;
  if (room) {
    roomBtn.textContent = '离开房间并断开';
    roomBtn.classList.remove('primary');
    roomBtn.classList.add('danger');
  } else if (busy) {
    roomBtn.textContent = '连接中…';
    roomBtn.classList.remove('danger');
    roomBtn.classList.add('primary');
  } else {
    roomBtn.textContent = '连接房间';
    roomBtn.classList.remove('danger');
    roomBtn.classList.add('primary');
  }

  const activeId = activeTab && activeTab.id != null ? activeTab.id : null;
  const isFollowingThisTab =
    activeId != null && state.followedTabId != null && state.followedTabId === activeId;
  const followBtn = el('btnBind');
  followBtn.textContent = isFollowingThisTab ? '取消跟随' : '设为跟随';
  followBtn.classList.toggle('primary', !isFollowingThisTab);
  followBtn.classList.toggle('secondary', isFollowingThisTab);
}
