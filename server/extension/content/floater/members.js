  /** @param {unknown} ms */
  function rttColorClass(ms) {
    if (ms == null || typeof ms !== 'number' || isNaN(ms)) return 'rtt-unknown';
    if (ms < 120) return 'rtt-low';
    if (ms < 350) return 'rtt-mid';
    return 'rtt-high';
  }

  /**
   * @param {unknown} js 服务端多次采样后的跳转对齐：true / false / null
   */
  function renderJumpCell(js) {
    var span = document.createElement('span');
    span.className = 'member-jump';
    if (js === true) {
      span.classList.add('ok');
      span.textContent = '✓';
      span.title = '本轮（标题/URL 更新或房间换页后）已与房间当前页一致';
      return span;
    }
    if (js === false) {
      span.classList.add('bad');
      span.textContent = '✗';
      span.title = '本轮不一致：重试中，或已满 5 次采样仍不一致';
      return span;
    }
    span.classList.add('pending');
    span.textContent = '…';
    span.title = '本轮尚未采样或等待首次结果（房间无当前页时也会显示）';
    return span;
  }

  function renderMemberList(container, members, selfId, syncActive) {
    if (!container) return;
    container.innerHTML = '';
    if (!syncActive) {
      var empty = document.createElement('li');
      empty.textContent = '未在协同会话中';
      empty.style.color = '#9ca3af';
      container.appendChild(empty);
      return;
    }
    var list = members && members.length ? members : [];
    if (!list.length) {
      var loading = document.createElement('li');
      loading.textContent = '加载成员…';
      loading.style.color = '#9ca3af';
      container.appendChild(loading);
      return;
    }
    list.forEach(function (m) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.className = 'member-label';
      var name = (m && m.displayName) || '访客';
      var extra = m && m.role === 'host' ? ' · 房主' : '';
      var me = selfId && m && m.clientId === selfId ? '（我）' : '';
      label.textContent = name + extra + me;

      var meta = document.createElement('span');
      meta.className = 'member-meta';
      var rttEl = document.createElement('span');
      rttEl.className = 'member-rtt ' + rttColorClass(m && m.rttMs);
      var rttVal = m && typeof m.rttMs === 'number' && !isNaN(m.rttMs) ? Math.round(m.rttMs) : null;
      rttEl.textContent = rttVal != null ? rttVal + 'ms' : '—';
      rttEl.title = rttVal != null ? '与服务器的往返延迟' : '尚未收到延迟样本';
      meta.appendChild(rttEl);
      meta.appendChild(renderJumpCell(m && m.jumpSynced));

      li.appendChild(label);
      li.appendChild(meta);
      container.appendChild(li);
    });
  }
