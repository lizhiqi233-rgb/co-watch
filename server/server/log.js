function createDebugLogger(enabled) {
  return (...args) => {
    if (!enabled) return;
    console.log('[co-watch]', new Date().toISOString(), ...args);
  };
}

function dbgUrl(value) {
  if (typeof value !== 'string') return value;
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

module.exports = { createDebugLogger, dbgUrl };
