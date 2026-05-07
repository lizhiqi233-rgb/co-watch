/**
 * 扩展内共用：超长文本截断并加省略号（与原先 popup.js / content.js 行为一致）。
 * @param {unknown} s
 * @param {number} n 最大字符数（含省略号占位时实际展示可能为 n）
 * @returns {string}
 */
function coWatchTruncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}
