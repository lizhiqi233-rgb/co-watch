  function refreshFloaterUI(ctx) {
    lastSyncCtx = ctx || null;
    if (!floaterHostEl || !floaterHostEl._coWatch) return;
    var ui = floaterHostEl._coWatch;
    var hasUp = !!(ctx && ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl);
    var idText = '身份：—';
    if (ctx && !ctx.isFollowedTab && hasUp) {
      idText = '身份：当前标签不是跟随页（可先更新扩展）';
    } else if (ctx && ctx.isFollowedTab) {
      if (ctx.syncActive) {
        idText = ctx.isHost
          ? '身份：房主（可控制播放）'
          : '身份：成员（仅跟随房主）';
      } else {
        idText = '身份：未连接房间';
      }
    }
    ui.roleEl.textContent = idText;
    if (ui.updateBlockEl) {
      ui.updateBlockEl.hidden = !hasUp;
      if (hasUp && ui.updateMetaEl) {
        ui.updateMetaEl.textContent =
          '服务端 ' +
          (ctx.serverExtensionVersion || '—') +
          ' · 本机 ' +
          (ctx.localExtensionVersion || '—');
      }
    }
    renderMemberList(
      ui.memberListEl,
      ctx && ctx.roomMembers ? ctx.roomMembers : [],
      ctx && ctx.clientId,
      !!(ctx && ctx.syncActive)
    );
    renderPlaylistBlock(ui, ctx);
    if (ui.btnDisconnect) {
      var inSession = !!(ctx && ctx.syncActive);
      ui.btnDisconnect.style.display = inSession ? 'inline-block' : 'none';
      ui.btnDisconnect.disabled = !inSession;
    }
    if (ui.btnClaimHost) {
      var showClaim = !!(ctx && ctx.syncActive && !ctx.isHost);
      ui.btnClaimHost.style.display = showClaim ? 'inline-block' : 'none';
      if (showClaim) {
        var until = ctx.claimHostCooldownUntil;
        var nowMs = Date.now();
        if (until != null && typeof until === 'number' && nowMs < until) {
          var secLeft = Math.ceil((until - nowMs) / 1000);
          ui.btnClaimHost.disabled = true;
          ui.btnClaimHost.textContent = '抢房主 ' + secLeft + 's';
          ui.btnClaimHost.title = '上次有人抢房主成功，全房间须等待 1 分钟';
        } else {
          ui.btnClaimHost.disabled = false;
          ui.btnClaimHost.textContent = '抢房主';
          ui.btnClaimHost.title = '接管播放控制权（成功后全房间 1 分钟冷却）';
        }
      }
    }
    if (hasUp) {
      if (ui.setCollapsed && !lastCtxHadUpdate) {
        ui.setCollapsed(false);
      }
      lastCtxHadUpdate = true;
    } else {
      lastCtxHadUpdate = false;
    }
    syncRightRail(ctx);
  }

  /**
   * 右侧竖条栈：协同 / 全员跳转 / 加入队列；.strip-skin 统一尺寸。
   * 连接房间后：全员跳转在所有标签页显示；加入队列仅在非跟随标签页显示（跟随页不显示）。
   */
  function syncRightRail(ctx) {
    var ui = floaterHostEl && floaterHostEl._coWatch;
    if (!ui || !ui.stripStack) return;
    var showFloater = !!(
      ctx &&
      (ctx.isFollowedTab || (ctx.extensionUpdateAvailable && ctx.extensionDownloadUrl))
    );
    var showQ = !!(
      ctx &&
      ctx.roomConnected &&
      (!ctx.isFollowedTab || ctx.syncActive)
    );
    var card = ui.card;
    var collapsed = !!(card && card.classList.contains('collapsed'));
    if (card) {
      card.style.display = showFloater ? '' : 'none';
    }
    var showStack = (showFloater && collapsed) || (showQ && !showFloater);
    ui.stripStack.classList.toggle('hidden', !showStack);
    if (ui.stripMain) {
      ui.stripMain.classList.toggle('hidden', !(showFloater && collapsed && showStack));
    }
    var showJoin = !!(showQ && showStack && ctx && !ctx.isFollowedTab);
    var showNav = !!(showStack && ctx && ctx.roomConnected);
    if (ui.stripQueueJoin) {
      ui.stripQueueJoin.classList.toggle('hidden', !showJoin);
    }
    if (ui.stripQueueNav) {
      ui.stripQueueNav.classList.toggle('hidden', !showNav);
    }
  }
