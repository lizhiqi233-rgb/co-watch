// ---- 右键菜单：一键开始/发送到协同浏览 ----
const CONTEXT_MENU_ID = 'co_watch_context';

function isSocketConnected() {
  return !!(socket && socket.readyState === WebSocket.OPEN);
}

function getTabUrl(tab) {
  try {
    return (tab && tab.url ? String(tab.url) : '').trim();
  } catch {
    return '';
  }
}

/**
 * 右键「开始协同浏览」：先断开 WebSocket 并清空房间内存与 storage 中的房间字段，再按上次房间密码重连并绑定 tabId 为跟随页。
 */
function contextMenuReconnectAndEnterRoom(tabId) {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.displayName]).then((data) => {
    const roomKey = String(data[STORAGE_KEYS.lastRoomKey] || '').trim();
    const displayName = normalizeDisplayName(data[STORAGE_KEYS.displayName] || '');
    if (!roomKey) {
      broadcastState({ lastError: '需先在弹窗中保存过房间密码' });
      return;
    }
    enterRoomPending = true;
    broadcastState({ lastError: null });
    pendingFollowTabId = tabId;
    disconnectSocketAndClearRoomMemory();
    setStorage({
      [STORAGE_KEYS.roomId]: null,
      [STORAGE_KEYS.role]: null,
      [STORAGE_KEYS.joinReplayUrl]: null,
      [STORAGE_KEYS.joinResumeVideo]: null,
    }).then(() => {
      connectAnd(() => {
        sendRaw({ type: 'enter_room', roomKey, displayName });
      });
    });
  });
}

function updateContextMenuTitle(enabled, title) {
  // contextMenus.update 在 SW 被唤醒后可用；如果尚未创建菜单，会抛错，因此只在已创建后调用。
  try {
    chrome.contextMenus.update(CONTEXT_MENU_ID, { enabled: !!enabled, title: String(title || '') });
  } catch (e) {
    // ignore
  }
}

/**
 * 根据当前连接状态与 storage 刷新右键菜单启用状态与标题。
 * broadcastState 与 contextMenus.onShown 均调用此函数；部分环境 onShown 不可靠，故状态变化时也必须走此处。
 * @param {{ followedTabId?: number | null }} [hints] 已知有效绑定时传入，避免 storage 读回滞后（尤其 Edge）
 */
function refreshContextMenuTitle(hints) {
  getStorage([STORAGE_KEYS.lastRoomKey, STORAGE_KEYS.followedTabId]).then((data) => {
    const roomKey = data[STORAGE_KEYS.lastRoomKey];
    let followed = data[STORAGE_KEYS.followedTabId];
    if (hints && Object.prototype.hasOwnProperty.call(hints, 'followedTabId')) {
      followed = hints.followedTabId;
    }
    const connected = isSocketConnected();
    if (connected) {
      if (followed != null) {
        updateContextMenuTitle(true, '发送到协同浏览');
      } else {
        updateContextMenuTitle(true, '开始协同浏览');
      }
      return;
    }
    if (!roomKey) {
      updateContextMenuTitle(false, '开始协同浏览（需先设置房间密码）');
      return;
    }
    updateContextMenuTitle(true, '开始协同浏览');
  });
}

/** Chrome API 要求 create(createProperties)，id 必须写在对象里；原先两参数写法无效，菜单不会出现 */
function ensureContextMenu() {
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: '协同浏览',
      contexts: ['page'],
    },
    () => {
      void chrome.runtime.lastError;
      refreshContextMenuTitle();
    }
  );
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  enterRoomPending = false;
  disconnectSocketAndClearRoomMemory();
  clearPersistedRoomSessionFromStorage().then(() => {
    broadcastState({ lastError: null }, { followedTabId: null });
  });
});

// MV3：浏览器重启后 onInstalled 不会触发，需在 Service Worker 启动时确保菜单存在
ensureContextMenu();

if (chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener(() => {
    refreshContextMenuTitle();
  });
}

/**
 * 与右键「发送到协同浏览」一致：先绑定跟随标签再 sendNavigateReliable，必要时关闭旧跟随标签。
 * @param {number} tabId
 * @param {(r?: object) => void} [sendResponse]
 */
function runSendToCoWatchSameAsContextMenu(tabId, sendResponse) {
  getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
    const oldFollowId = data[STORAGE_KEYS.followedTabId];
    if (oldFollowId == null) {
      if (sendResponse) sendResponse({ ok: false, error: '未设置跟随页' });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        if (sendResponse) sendResponse({ ok: false });
        return;
      }
      const url = getTabUrl(tab);
      if (!url || !isAllowedHttpUrl(url)) {
        broadcastState({ lastError: '仅支持 http/https 页面' });
        if (sendResponse) sendResponse({ ok: false, error: '仅支持 http/https 页面' });
        return;
      }
      setStorage({ [STORAGE_KEYS.followedTabId]: tabId }).then(() => {
        const ok = sendNavigateReliable(url, tab.title || '', {
          roomSyncNavigate: true,
        });
        if (!ok) {
          setStorage({ [STORAGE_KEYS.followedTabId]: oldFollowId }).then(() => {
            broadcastState(
              { lastError: '未连接到房间服务' },
              oldFollowId != null ? { followedTabId: oldFollowId } : { followedTabId: null }
            );
          });
          if (sendResponse) sendResponse({ ok: false });
          return;
        }
        notifyFloater(tabId, true);
        if (oldFollowId != null && oldFollowId !== tabId) {
          notifyFloater(oldFollowId, false);
        }
        pushRosterToFollowedTab();
        broadcastState(undefined, { followedTabId: tabId });
        if (oldFollowId != null && oldFollowId !== tabId) {
          chrome.tabs.remove(oldFollowId, () => void chrome.runtime.lastError);
        }
        if (sendResponse) sendResponse({ ok: true });
      });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  const tabId = tab.id;
  const url = getTabUrl(tab);
  const allowUrl = !!(url && isAllowedHttpUrl(url));

  if (isSocketConnected()) {
    getStorage([STORAGE_KEYS.followedTabId]).then((data) => {
      const oldFollowId = data[STORAGE_KEYS.followedTabId];
      if (oldFollowId == null) {
        // 已连接但未设跟随页：先断开再重连，与未连接时「开始协同浏览」一致，避免半开连接/陈旧状态
        contextMenuReconnectAndEnterRoom(tabId);
        return;
      }
      if (!allowUrl) {
        broadcastState({ lastError: '仅支持 http/https 页面' });
        return;
      }
      runSendToCoWatchSameAsContextMenu(tabId);
    });
    return;
  }

  // 未连接「开始协同浏览」：先断开再连接（与已连接但未设跟随时同一路径）
  contextMenuReconnectAndEnterRoom(tabId);
});

loadCoWatchDebugFlag().catch(() => {});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.coWatchDebug]) return;
    coWatchDebug = !!changes[STORAGE_KEYS.coWatchDebug].newValue;
  });
} catch (_) {
  /* ignore */
}
