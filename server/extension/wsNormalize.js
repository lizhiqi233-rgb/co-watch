/**
 * 与 background 共用：供 importScripts / 弹窗使用，避免两处逻辑分叉。
 *
 * 规范化 WebSocket 地址，便于使用域名（含内网/hosts）连接。
 * - 无协议时：域名或 IP，可带端口与路径；默认端口 15777。
 * - 仅填 https:// 或域名:443 时转为 wss://。
 * - 误粘贴的 // 开头会去掉再解析。
 *
 * @param {unknown} input
 * @returns {string}
 */
const DEFAULT_WS = 'ws://127.0.0.1:15777';

function normalizeWsUrl(input) {
  const s = (input || '').trim();
  if (!s) return DEFAULT_WS;
  try {
    if (s.startsWith('ws://') || s.startsWith('wss://')) return s;
    if (s.startsWith('http://')) return 'ws://' + s.slice('http://'.length);
    if (s.startsWith('https://')) return 'wss://' + s.slice('https://'.length);
    const rest = s.replace(/^\/+/, '');
    const probe = new URL('http://' + rest);
    const host = probe.hostname;
    if (!host) return DEFAULT_WS;
    const port = probe.port;
    const path = probe.pathname + probe.search + probe.hash;
    const pathPart = path && path !== '/' ? path : '';

    if (port === '443') {
      return 'wss://' + host + pathPart;
    }

    let portPart = '';
    if (port) {
      if (port === '80') {
        portPart = '';
      } else {
        portPart = ':' + port;
      }
    } else {
      portPart = ':15777';
    }
    return 'ws://' + host + portPart + pathPart;
  } catch {
    return DEFAULT_WS;
  }
}
