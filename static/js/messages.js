'use strict';
/**
 * messages.js — 消息内容增强
 *  - Markdown 渲染管线接入（renderer.js）+ 增强副作用
 *  - 消息操作栏：复制 / 点赞 / 点踩 / 重新生成 / 分享 / 编辑
 *  - 编辑后重新生成
 *  - 快捷指令：继续生成 / 简要总结 / 扩展说明 / 提取要点
 *  - 跟进建议问题
 */

(function () {
  const M = {};

  // ============ 渲染一条消息的正文（带操作钩子） ============
  /**
   * @param {HTMLElement} contentEl 消息内容容器
   * @param {object} msg {content}
   * @param {object} hooks {onRegenerate, onEdit, onLike, onShare}
   */
  M.renderContent = function (contentEl, msg, hooks = {}) {
    contentEl.innerHTML = '<div class="msg-render-root md-prose"></div>';
    const root = contentEl.querySelector('.msg-render-root');

    // 思维链/工具调用组件会自动被 renderer.js 的容器规则解析
    let html = window.OCRenderer.render(msg.content || '');
    root.innerHTML = html;
    window.OCRenderer.enhance(root);

    // 校正细节：比较替换掉渲染前的不转义风险（容器里已安全转义）
    if (hooks.onContentRendered) hooks.onContentRendered(root);
    return root;
  };

  // ============ 消息操作栏 ============
  /**
   * @param {HTMLElement} msgEl 整条消息 DOM
   * @param {object} msg 消息数据 {id, content, vote?}
   * @param {object} hooks 回调
   */
  M.attachActions = function (msgEl, msg, hooks = {}) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const ic = window.OC && window.OC.icon;
    bar.innerHTML =
      '<button class="msg-action" data-act="copy" data-tip="复制消息">' + ic('copy', 14) + '</button>'
      + '<button class="msg-action" data-act="like" data-tip="点赞" data-vote="up">' + ic('like', 14) + '</button>'
      + '<button class="msg-action" data-act="dislike" data-tip="点踩" data-vote="down">' + ic('dislike', 14) + '</button>'
      + '<button class="msg-action" data-act="regenerate" data-tip="重新生成">' + ic('refresh', 14) + '</button>'
      + '<button class="msg-action" data-act="share" data-tip="分享对话">' + ic('share', 14) + '</button>'
      + '<button class="msg-action" data-act="edit" data-tip="编辑此消息">' + ic('edit', 14) + '</button>'
      + '<button class="msg-action" data-act="branch" data-tip="从此处另开对话">' + ic('branch', 14) + '</button>'
      + '<button class="msg-action" data-act="delete" data-tip="删除此消息">' + ic('trash', 14) + '</button>'
      + '<button class="msg-action" data-act="more" data-tip="更多操作">' + ic('more', 14) + '</button>';

    const likeBtn0 = bar.querySelector('[data-vote="up"]');
    const disBtn0 = bar.querySelector('[data-vote="down"]');
    if (likeBtn0) likeBtn0.classList.toggle('active', msg.vote === 'up');
    if (disBtn0) disBtn0.classList.toggle('active', msg.vote === 'down');

    // 只对 assistant 显示重新生成/分享/更多，只对 user 显示编辑
    const isAssistant = msgEl.classList.contains('assistant');
    const isUser = msgEl.classList.contains('user');
    bar.querySelector('[data-act="regenerate"]').style.display = isAssistant ? '' : 'none';
    bar.querySelector('[data-act="share"]').style.display = isAssistant ? '' : 'none';
    bar.querySelector('[data-act="edit"]').style.display = isUser ? '' : 'none';
    bar.querySelector('[data-act="dislike"]').style.display = isAssistant ? '' : 'none';
    bar.querySelector('[data-act="like"]').style.display = isAssistant ? '' : 'none';
    const moreBtn = bar.querySelector('[data-act="more"]');
    if (moreBtn) moreBtn.style.display = isAssistant ? '' : 'none';
    const branchBtn = bar.querySelector('[data-act="branch"]');
    if (branchBtn) branchBtn.style.display = (isAssistant || isUser) && hooks.onBranch ? '' : 'none';
    const deleteBtn = bar.querySelector('[data-act="delete"]');
    if (deleteBtn) deleteBtn.style.display = (isAssistant || isUser) && hooks.onDelete ? '' : 'none';

    // 交互
    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.msg-action');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'copy') {
        const text = msg.content || '';
        let ok = false;
        if (window.OCUI && window.OCUI.copyText) {
          ok = await window.OCUI.copyText(text);
        } else {
          try {
            await navigator.clipboard.writeText(text);
            ok = true;
          } catch (er) {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            ok = document.execCommand('copy');
            ta.remove();
          }
        }
        if (ok) {
          const orig = btn.innerHTML;
          btn.classList.add('copied');
          btn.innerHTML = window.OC.icon('check', 14);
          setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1400);
          if (window.toast) window.toast('已复制');
        } else if (window.toast) {
          window.toast('复制失败', true);
        }
      } else if (act === 'like' || act === 'dislike') {
        const vote = act === 'like' ? 'up' : 'down';
        const already = msg.vote === vote;
        msg.vote = already ? null : vote;
        const likeBtn = bar.querySelector('[data-vote="up"]');
        const disBtn = bar.querySelector('[data-vote="down"]');
        likeBtn.classList.toggle('active', msg.vote === 'up');
        disBtn.classList.toggle('active', msg.vote === 'down');
        if (hooks.onVote) hooks.onVote(msg);
      } else if (act === 'regenerate') {
        if (hooks.onRegenerate) hooks.onRegenerate(msg);
      } else if (act === 'share') {
        if (hooks.onShare) hooks.onShare(msg);
      } else if (act === 'edit') {
        if (hooks.onEdit) hooks.onEdit(msg, msgEl);
      } else if (act === 'branch') {
        if (hooks.onBranch) hooks.onBranch(msg);
      } else if (act === 'delete') {
        if (hooks.onDelete) hooks.onDelete(msg);
      } else if (act === 'more') {
        // 弹出快捷指令菜单
        if (window.OC && window.OC.openSelect) {
          const groups = QUICK_ACTIONS.map((q) => ({ value: q.key, label: q.label }));
          window.OC.openSelect(btn, groups, {
            selected: null,
            onSelect: (val) => {
              const q = QUICK_ACTIONS.find((x) => x.key === val);
              if (q && hooks.onQuickAction) hooks.onQuickAction(q.key, msg);
            },
          });
        } else if (hooks.onQuickAction) {
          // 降级：直接执行第一个
          const q = QUICK_ACTIONS[0];
          hooks.onQuickAction(q.key, msg);
        }
      }
    });

    msgEl.appendChild(bar);
  };

  // ============ 编辑模式 ============
  M.enterEditMode = function (msgEl, msg, hooks) {
    const contentEl = msgEl.querySelector('.msg-content');
    if (!contentEl) return;
    const bar = msgEl.querySelector('.msg-actions');
    if (bar) bar.style.display = 'none';
    const orig = msg.content || '';
    contentEl.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'msg-edit-area';
    ta.value = orig;
    ta.rows = Math.min(6, Math.max(2, orig.split('\n').length));
    const row = document.createElement('div');
    row.className = 'msg-edit-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn small primary';
    saveBtn.textContent = '保存并重新生成';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn small';
    cancelBtn.textContent = '取消';
    row.appendChild(saveBtn); row.appendChild(cancelBtn);
    contentEl.appendChild(ta); contentEl.appendChild(row);

    const exit = () => {
      if (hooks.onExitEdit) hooks.onExitEdit();
    };
    cancelBtn.addEventListener('click', exit);
    saveBtn.addEventListener('click', () => {
      const text = ta.value;
      if (!text.trim()) return;
      if (hooks.onSaveEdit) hooks.onSaveEdit(text);
    });
    ta.focus();
  };

  // ============ 快捷指令 ============
  const QUICK_ACTIONS = [
    { key: 'continue', label: '继续生成' },
    { key: 'summarize', label: '简要总结' },
    { key: 'expand', label: '扩展说明' },
    { key: 'extract', label: '提取要点' },
  ];

  M.attachQuickActions = function (msgEl, msg, hooks) {
    const isAssistant = msgEl.classList.contains('assistant');
    if (!isAssistant) return;
    const wrap = document.createElement('div');
    wrap.className = 'quick-actions';
    QUICK_ACTIONS.forEach((q) => {
      const b = document.createElement('button');
      b.className = 'quick-action';
      b.textContent = q.label;
      b.addEventListener('click', () => {
        if (hooks.onQuickAction) hooks.onQuickAction(q.key, msg);
      });
      wrap.appendChild(b);
    });
    msgEl.appendChild(wrap);
  };

  window.OCMessages = M;
})();