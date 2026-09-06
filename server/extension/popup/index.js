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
