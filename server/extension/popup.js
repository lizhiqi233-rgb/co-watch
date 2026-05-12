const el = (id) => document.getElementById(id);

let toastTimer = null;

function getTabTitle(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      const title = (tab.title || '').trim();
      const url = (tab.url || '').trim();
      resolve(title || url || null);
    });
  });
}

function setErrorBanner(text) {
  const box = el('statusError');
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = text;
}

function showToast(msg) {
  const t = el('statusToast');
  if (!msg) {
    t.hidden = true;
    t.textContent = '';
    clearTimeout(toastTimer);
    return;
  }
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    t.textContent = '';
  }, 3200);
}

function send(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, resolve);
  });
}

/**
 * 输入框展示：在「与 normalizeWsUrl 往返一致」的前提下尽量简短（如本机只显示 IP/域名）。
 * 公网 WSS 等无法靠纯主机名区分默认端口的场景，则显示完整 ws/wss 串。
 * @param {string} stored
 */
function formatServerUrlForDisplay(stored) {
  const s = String(stored || '').trim();
  if (!s) return '';
  const norm = normalizeWsUrl(s);
  try {
    const u = new URL(norm);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return s;

    const hasPath = u.pathname !== '/' || u.search || u.hash;
    if (hasPath) return norm;

    if (u.hostname.includes(':')) return norm;

    if (u.protocol === 'wss:') {
      const defaultPort = !u.port || u.port === '443';
      if (!defaultPort) return norm;
      const short = u.hostname;
      return normalizeWsUrl(short) === norm ? short : norm;
    }

    if (!u.port || u.port === '15777') {
      const short = u.hostname;
      return normalizeWsUrl(short) === norm ? short : norm;
    }
    const short = u.hostname + ':' + u.port;
    return normalizeWsUrl(short) === norm ? short : norm;
  } catch {
    return s;
  }
}

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

  const server = state.serverWsUrl || DEFAULT_WS;
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

el('serverUrl').addEventListener('change', async () => {
  await send('setServerUrl', { url: el('serverUrl').value.trim() });
  refresh();
});

el('displayName').addEventListener('change', async () => {
  const res = await send('setDisplayName', { displayName: el('displayName').value });
  if (res && res.ok === false) {
    setErrorBanner('保存显示名失败');
    return;
  }
  if (res && typeof res.displayName === 'string') {
    el('displayName').value = res.displayName;
  }
  refresh();
});

async function doEnterRoom(roomKey) {
  const key = String(roomKey || '').trim();
  if (!key) {
    setErrorBanner('请先填写房间密码。');
    return;
  }
  setErrorBanner('');
  showToast('');
  await send('setServerUrl', { url: el('serverUrl').value.trim() });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const followTabId = tab && tab.id != null ? tab.id : undefined;
  const res = await send('enterRoom', { roomKey: key, followTabId });
  if (res && res.ok === false) {
    setErrorBanner(res.error || '连接失败');
    return;
  }
  await refresh();
}

el('btnEnter').addEventListener('click', async () => {
  const st = await send('getState');
  if (!st) return;
  if (st.roomId) {
    await send('leaveRoom');
    el('roomPassword').value = '';
    setErrorBanner('');
    showToast('已离开房间。');
    refresh();
    return;
  }
  await doEnterRoom(el('roomPassword').value);
});

el('btnNavigate').addEventListener('click', async () => {
  const url = el('navUrl').value.trim();
  const res = await send('navigate', { url });
  if (res && res.ok === false) {
    setErrorBanner(res.error || '发送失败');
    return;
  }
  setErrorBanner('');
  showToast('已发送全员跳转。');
});

el('btnBind').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    setErrorBanner('无法获取当前标签。');
    return;
  }
  const st = await send('getState');
  if (!st) return;
  const isThisFollowed = st.followedTabId != null && st.followedTabId === tab.id;
  if (isThisFollowed) {
    await send('unbindTab');
    setErrorBanner('');
    showToast('已取消跟随绑定。');
  } else {
    await send('bindTab', { tabId: tab.id });
    setErrorBanner('');
    const title = (tab.title || '').trim();
    showToast(title ? `已绑定：${coWatchTruncate(title, 28)}` : '已绑定当前标签');
  }
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'state') {
    refresh();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const chk = el('chkDebugLog');
  if (chk) {
    chk.addEventListener('change', async () => {
      const on = chk.checked;
      const res = await send('setCoWatchDebug', { enabled: on });
      if (res && res.ok === false) {
        setErrorBanner(res.error || '无法保存调试开关');
        chk.checked = !on;
        return;
      }
      setErrorBanner('');
      showToast(on ? '已开启调试日志' : '已关闭调试日志');
    });
  }
  refresh();
});
