/**
 * Normalize user-entered WebSocket addresses.
 * Bare hosts and ws:// addresses use port 15777; wss:// uses port 443.
 * http(s):// inputs are converted to ws(s)://, and URL fragments are removed.
 */
function normalizeWsUrl(input) {
  const s = (input || '').trim();
  if (!s) return DEFAULT_WS;
  try {
    const lower = s.toLowerCase();
    let source = s;
    let bareHost = false;
    if (lower.startsWith('http://')) {
      source = 'ws://' + s.slice('http://'.length);
    } else if (lower.startsWith('https://')) {
      source = 'wss://' + s.slice('https://'.length);
    } else if (!lower.startsWith('ws://') && !lower.startsWith('wss://')) {
      source = 'http://' + s.replace(/^\/+/, '');
      bareHost = true;
    }
    const u = new URL(source);
    if (bareHost) {
      u.protocol = u.port === '443' ? 'wss:' : 'ws:';
    }
    if (u.protocol === 'ws:' && !u.port) {
      u.port = '15777';
    }
    u.hash = '';
    return u.toString();
  } catch {
    return DEFAULT_WS;
  }
}

/**
 * 连接前校验 URL 格式。建立连接时，明文 ws:// 且主机为域名时，会经国内 DoH 查 A 记录优先用 IPv4（见 preferIpv4WsUrl）。
 * @param {string} wsUrlString
 */
function assertValidWsUrl(wsUrlString) {
  let u;
  try {
    u = new URL(wsUrlString);
  } catch {
    throw new Error('服务地址格式无效');
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('仅支持 ws:// 或 wss://');
  }
  if (!u.hostname) {
    throw new Error('服务地址缺少主机名（请填写域名或 IP）');
  }
  if (u.username || u.password) {
    throw new Error('服务地址不支持用户名密码');
  }
  if (u.hash) {
    throw new Error('服务地址不支持片段');
  }
}

/** 是否为 IPv4 字面量或 IPv6 字面量（避免对已是 IP 的地址再做 DoH） */
function isIpLiteralHost(host) {
  if (!host) return true;
  if (host.includes(':')) {
    return true;
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * 通过 DNS over HTTPS 查询 A 记录（仅 IPv4）。
 * 使用国内一般可直接访问的 JSON DoH（阿里 AliDNS、DNSPod），避免依赖境外 DoH。
 * 失败时返回 null，由调用方回退为原始域名连接。
 */
async function resolveHostnameToIpv4ViaDoh(hostname) {
  const endpoints = [
    () => {
      const q = new URL('https://dns.alidns.com/resolve');
      q.searchParams.set('name', hostname);
      q.searchParams.set('type', 'A');
      return q.toString();
    },
    () => {
      const q = new URL('https://dns.pub/resolve');
      q.searchParams.set('name', hostname);
      q.searchParams.set('type', 'A');
      return q.toString();
    },
  ];
  for (let e = 0; e < endpoints.length; e++) {
    try {
      const r = await fetch(endpoints[e](), {
        headers: { Accept: 'application/dns-json' },
        cache: 'no-store',
      });
      if (!r.ok) continue;
      const j = await r.json();
      const answers = j.Answer || [];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        if (a && a.type === 1 && typeof a.data === 'string') {
          const ip = a.data.replace(/^"|"$/g, '').trim();
          if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
            return ip;
          }
        }
      }
    } catch (_) {
      /* try next endpoint */
    }
  }
  return null;
}

/**
 * 明文 ws:// 时：将域名解析为 IPv4 再连接，避免系统优先走不可达/错误的 IPv6（AAAA）导致 1006。
 * wss:// 不改写主机名，以免与证书域名不一致导致 TLS 失败。
 */
async function preferIpv4WsUrl(wsUrlString) {
  let u;
  try {
    u = new URL(wsUrlString);
  } catch {
    return wsUrlString;
  }
  if (u.protocol !== 'ws:') {
    return wsUrlString;
  }
  const host = u.hostname;
  if (!host || isIpLiteralHost(host)) {
    return wsUrlString;
  }
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return wsUrlString;
  }
  const ipv4 = await resolveHostnameToIpv4ViaDoh(host);
  if (!ipv4) {
    return wsUrlString;
  }
  u.hostname = ipv4;
  return u.toString();
}
