function shouldReconnectAfterUnexpectedClose(ev, hadSession, wasEntering) {
  if (!hadSession && !wasEntering) return false;
  const code = ev && typeof ev.code === 'number' ? ev.code : 0;
  if ([1000, 1002, 1003, 1007, 1008, 1009, 1010, 1013].includes(code)) {
    return false;
  }
  return true;
}
function connectAnd(run) {
  const generation = ++connectionGeneration;
  getStorage([STORAGE_KEYS.serverWsUrl]).then(async (data) => {
    if (generation !== connectionGeneration) return;
    try {
      const configuredUrl = normalizeWsUrl(data[STORAGE_KEYS.serverWsUrl]);
      let wsUrl = configuredUrl;
      try {
        assertValidWsUrl(wsUrl);
      } catch (e) {
        enterRoomPending = false;
        broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
        return;
      }
      try {
        wsUrl = await preferIpv4WsUrl(wsUrl);
      } catch (_) {
        /* 解析失败则仍用原始 URL */
      }
      if (generation !== connectionGeneration) return;
      closeSocket();
      configuredWsUrl = configuredUrl;
      let ws;
      try {
        ws = new WebSocket(wsUrl);
        socket = ws;
        activeWsUrl = wsUrl;
      } catch (e) {
        activeWsUrl = null;
        configuredWsUrl = null;
        enterRoomPending = false;
        broadcastState({ lastError: '无法连接：' + (e && e.message) });
        return;
      }
      ws.onopen = () => {
        if (generation !== connectionGeneration || socket !== ws) {
          closeSocketQuietly(ws);
          return;
        }
        lastError = null;
        pendingDisconnectBanner = null;
        broadcastState({ lastError: null });
        startHeartbeat();
        if (typeof run === 'function') run();
      };
      ws.onmessage = (ev) => {
        if (generation !== connectionGeneration || socket !== ws) return;
        handleServerMessage(ev.data);
      };
      ws.onclose = (ev) => {
        if (generation !== connectionGeneration || socket !== ws) return;
        const hadSession = !!currentRoomId;
        const wasEntering = enterRoomPending;
        const heartbeatReconnect = reconnectAfterHeartbeat;
        stopHeartbeat();
        if (enterRoomPending) {
          enterRoomPending = false;
        }
        if (
          heartbeatReconnect ||
          shouldReconnectAfterUnexpectedClose(ev, hadSession, wasEntering)
        ) {
          reconnectAfterHeartbeat = false;
          pendingDisconnectBanner = null;
          clearWsSessionStateAfterClose();
          tryReconnectAfterHeartbeatFailure(heartbeatReconnect ? 'heartbeat' : 'unexpected');
          return;
        }
        clearWsSessionStateAfterClose();
        let banner = pendingDisconnectBanner;
        pendingDisconnectBanner = null;
        if (!banner) {
          if (!hadSession) {
            if (ev.code === 1006 || ev.code === 1002) {
              banner =
                '无法建立 WebSocket（关闭码 ' +
                ev.code +
                '）。请核对：服务端口与 ws/wss 是否一致、防火墙是否放行。若仅 IP 能连而域名不能，多为 IPv6(AAAA) 或 DNS：明文 ws:// 已尝试优先 IPv4；仍失败可修正域名 AAAA 记录，或暂用 IP。wss 须证书匹配域名，无法自动改 IP。';
            } else {
              banner =
                '无法连接房间服务（关闭码 ' +
                ev.code +
                (ev.reason ? '：' + ev.reason : '') +
                '）。';
            }
          } else if (!ev.wasClean || (ev.code !== 1000 && ev.code !== 1001)) {
            banner = '连接已断开（码 ' + ev.code + (ev.reason ? '：' + ev.reason : '') + '）';
          } else {
            banner = '连接已断开';
          }
        }
        lastError = banner;
        broadcastState({ lastError: banner });
      };
    } catch (e) {
      if (generation !== connectionGeneration) return;
      enterRoomPending = false;
      broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
    }
  }).catch((e) => {
    if (generation !== connectionGeneration) return;
    enterRoomPending = false;
    broadcastState({ lastError: '无法连接：' + (e && e.message ? e.message : String(e)) });
  });
}

function sendRaw(obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (enterRoomPending) enterRoomPending = false;
    broadcastState({ lastError: '未连接到房间服务' });
    return false;
  }
  if (coWatchDebug && obj && typeof obj === 'object' && obj.type) {
    const t = obj.type;
    if (t === 'ping' || t === 'video_sync') {
      /* 高频：不记日志 */
    } else if (t === 'navigate') dbg('ws→', t, /** @type {{ url?: string }} */ (obj).url);
    else dbg('ws→', t);
  }
  if (!sendSocketPayload(socket, obj)) {
    if (enterRoomPending) enterRoomPending = false;
    broadcastState({ lastError: '未连接到房间服务' });
    return false;
  }
  return true;
}
