/**
 * 服务端 index.js 与扩展（background / content / popup）共用的规范化工具。
 * 浏览器端通过 script / importScripts 注入全局；Node 端 require 同一文件。
 */

/**
 * @param {unknown} s
 * @param {number} n
 * @returns {string}
 */
function coWatchTruncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * @param {unknown} s
 * @returns {'unread'|'reading'|'read'}
 */
function normalizeReadStatus(s) {
  if (s === 'reading' || s === 'read' || s === 'unread') return s;
  return 'unread';
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function normalizeDisplayName(s) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 32);
  return t;
}

/**
 * 列表项展示用标题：trim、合并空白、最长 200、空为「（无标题）」。
 * @param {unknown} s
 * @returns {string}
 */
function normalizePlaylistTitle(s) {
  if (typeof s !== 'string') return '（无标题）';
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '（无标题）';
  if (t.length > 200) return t.slice(0, 200);
  return t;
}

/**
 * 标题宽松规范化，仅用于与跟随标签标题比对（无 200 字截断、无默认「无标题」）。
 * @param {unknown} s
 * @returns {string}
 */
function normalizePlaylistTitleCompare(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * URL 规范化键：B 站 /video/BV… 去跟踪参数、保留 ?p=，统一 www 主机。
 * @param {string} url
 * @returns {string}
 */
function normalizeUrlKeyForCoWatch(url) {
  try {
    const x = new URL(url);
    const h = x.hostname.toLowerCase();
    if (
      h === 'bilibili.com' ||
      h === 'www.bilibili.com' ||
      h === 'm.bilibili.com' ||
      h.endsWith('.bilibili.com')
    ) {
      const pathOnly = x.pathname.replace(/\/+$/, '') || '/';
      const m = pathOnly.match(/^\/video\/(BV[a-zA-Z0-9]+)$/i);
      if (m) {
        const bv = m[1];
        const p = x.searchParams.get('p');
        const part = p && /^\d+$/.test(String(p)) ? `?p=${p}` : '';
        return `https://www.bilibili.com/video/${bv}${part}`;
      }
    }
    let path = x.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return x.origin + path + x.search;
  } catch {
    return String(url || '').trim();
  }
}

/** @param {unknown} t */
function titleBaseForPlaylistDedup(t) {
  return normalizePlaylistTitle(
    String(t || '')
      .replace(/\s*·\s*P\d+\s*$/i, '')
      .replace(/\s*·\s*[A-Za-z0-9]{4,12}\s*$/, '')
      .trim()
  );
}

/**
 * B 站：分 P>1 时加「· P2」；同标题不同稿件加 BV 后 6 位区分。
 * @param {string} url
 * @param {unknown} rawTitle
 * @param {Array<{ url?: string, title?: string }> | undefined} existingItems
 */
function enrichBilibiliPlaylistTitle(url, rawTitle, existingItems) {
  const base = normalizePlaylistTitle(rawTitle);
  try {
    const x = new URL(url);
    const h = x.hostname.toLowerCase();
    if (
      h !== 'bilibili.com' &&
      h !== 'www.bilibili.com' &&
      h !== 'm.bilibili.com' &&
      !h.endsWith('.bilibili.com')
    ) {
      return base;
    }
    const pathOnly = x.pathname.replace(/\/+$/, '') || '/';
    const m = pathOnly.match(/^\/video\/(BV[a-zA-Z0-9]+)$/i);
    if (!m) return base;
    const bv = m[1];
    const myKey = normalizeUrlKeyForCoWatch(url);
    const p = x.searchParams.get('p');
    let extra = '';
    if (p && /^\d+$/.test(String(p)) && Number(p) > 1) {
      extra = ` · P${p}`;
    } else {
      const dup = (existingItems || []).some((it) => {
        if (!it || !it.url || typeof it.title !== 'string') return false;
        if (normalizeUrlKeyForCoWatch(it.url) === myKey) return false;
        return titleBaseForPlaylistDedup(it.title) === titleBaseForPlaylistDedup(base);
      });
      if (dup) extra = ` · ${bv.slice(-6)}`;
    }
    const out = (base + extra).trim();
    return out.length > 200 ? out.slice(0, 200) : out;
  } catch (_) {
    return base;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    coWatchTruncate,
    normalizeReadStatus,
    normalizeDisplayName,
    normalizePlaylistTitle,
    normalizePlaylistTitleCompare,
    isAllowedHttpUrl,
    normalizeUrlKeyForCoWatch,
    titleBaseForPlaylistDedup,
    enrichBilibiliPlaylistTitle,
  };
}
