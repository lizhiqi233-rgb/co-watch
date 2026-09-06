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
