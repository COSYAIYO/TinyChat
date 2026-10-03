'use strict';
/**
 * notes.js — AI 笔记模块
 *  - 侧栏「AI 笔记」入口 → 近全屏三栏弹窗(文件夹树 / 笔记列表 / 编辑与预览)
 *  - Markdown 渲染复用聊天管线(renderer.js 的 OCRenderer.renderInto + .msg.assistant 结构)
 *  - 图片/附件上传(粘贴、拖拽、选择文件)→ /api/notes/upload,签名 URL 内嵌预览
 *  - 分享:仅自己可见 / 持链接查看 / 持链接可编辑(/n/{token},关闭或重新生成即失效)
 *  - AI 归档:消息操作栏「保存到 AI 笔记」→ AI 判定文件夹/标题/标签并结构化,确认后保存
 *  - 数据:本地 localStorage 为即时层,云端 /api/sync/notes 按 baseRevision 乐观并发同步
 *    (删除走 tombs 墓碑,与对话云同步同构)
 */
(function () {
  const UNCATA = 'uncat';  // 内部 id 保持不变(兼容已存数据),界面文案为「默认分类」
  const UNCATA_LABEL = '默认分类';
  const MODES = ['edit', 'split', 'preview'];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const DOC_EXT = ['pdf', 'txt', 'md', 'csv', 'json', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

  const N = {
    ready: false,
    doc: { folders: [], notes: [], tombs: {} },
    revision: 0,
    shares: [],
    userId: null,
    pushTimer: null,
    pushBusy: false,
    dirty: false,
    ui: {
      folderId: UNCATA,
      search: '',
      sort: 'updated',
      mode: 'split',
      expanded: {},
      selNoteId: null,
    },
    els: {},
    editor: null, // {noteId, ta, preview, saveTimer, renderTimer, dirty}
  };

  // ============ 小工具 ============
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid(prefix) {
    return (prefix || 'n') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function icon(name, size) {
    return (window.OC && window.OC.icon) ? window.OC.icon(name, size || 15) : '';
  }
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ts) {
    const d = new Date(Number(ts) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDate(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return fmtClock(ts);
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    return fmtDate(ts);
  }
  function fmtFull(ts) {
    const d = new Date(Number(ts) || Date.now());
    return fmtDate(ts) + ' ' + fmtClock(ts);
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function debounce(fn, ms) {
    let t = null;
    const wrapped = function () { clearTimeout(t); t = setTimeout(fn, ms); };
    wrapped.now = function () { clearTimeout(t); fn(); };
    return wrapped;
  }
  function apiUrlOf(path) {
    return window.apiUrl ? window.apiUrl(path) : path;
  }
  function appState() { return (window.OCApp && window.OCApp.state) || null; }
  function bearerToken() {
    const s = appState();
    return (s && s.token) || localStorage.getItem('oc_token') || '';
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + bearerToken() }, opts.headers || {});
    return fetch(apiUrlOf(path), opts);
  }

  // ============ 存储层 ============
  function lsDocKey() { return 'oc_notes_' + (N.userId || 'anon'); }
  function lsUiKey() { return 'oc_notes_ui_' + (N.userId || 'anon'); }

  function ensureUncat() {
    if (N.doc.folders.some((f) => f.id === UNCATA)) return;
    const now = Date.now();
    N.doc.folders.unshift({
      id: UNCATA, parentId: null, name: UNCATA_LABEL, description: '',
      createdAt: now, updatedAt: now, system: true,
    });
  }
  function persistLocal() {
    try {
      localStorage.setItem(lsDocKey(), JSON.stringify({ doc: N.doc, revision: N.revision, shares: N.shares }));
    } catch (e) { /* 容量满时静默:下次同步会以云端为准 */ }
  }
  function persistUi() {
    try { localStorage.setItem(lsUiKey(), JSON.stringify(N.ui)); } catch (e) {}
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(lsDocKey());
      if (!raw) return false;
      const j = JSON.parse(raw);
      if (!j || !j.doc || !Array.isArray(j.doc.notes)) return false;
      N.doc = { folders: j.doc.folders || [], notes: j.doc.notes || [], tombs: j.doc.tombs || {} };
      N.revision = Number(j.revision) || 0;
      N.shares = Array.isArray(j.shares) ? j.shares : [];
      ensureUncat();
      return true;
    } catch (e) { return false; }
  }
  function loadUi() {
    try {
      const raw = localStorage.getItem(lsUiKey());
      if (!raw) return;
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') Object.assign(N.ui, j);
    } catch (e) {}
    if (MODES.indexOf(N.ui.mode) < 0) N.ui.mode = 'split';
  }

  // 文档按条目 updatedAt 合并(新者胜),tombs 墓碑双向吸收并压制复活
  function mergeDocs(local, remote) {
    const tombs = Object.assign({}, local.tombs || {}, remote.tombs || {});
    const pick = (a, b) => ((Number(b.updatedAt) || 0) > (Number(a.updatedAt) || 0) ? b : a);
    const fMap = {};
    (local.folders || []).forEach((f) => { fMap[f.id] = f; });
    (remote.folders || []).forEach((f) => { fMap[f.id] = fMap[f.id] ? pick(fMap[f.id], f) : f; });
    const nMap = {};
    (local.notes || []).forEach((n) => { nMap[n.id] = n; });
    (remote.notes || []).forEach((n) => { nMap[n.id] = nMap[n.id] ? pick(nMap[n.id], n) : n; });
    const alive = (item) => !(item.id in tombs && Number(tombs[item.id]) >= (Number(item.updatedAt) || 0));
    return {
      folders: Object.values(fMap).filter(alive),
      notes: Object.values(nMap).filter(alive),
      tombs,
    };
  }

  function schedulePush() {
    N.dirty = true;
    clearTimeout(N.pushTimer);
    N.pushTimer = setTimeout(pushNow, 1500);
  }
  async function pushNow() {
    clearTimeout(N.pushTimer);
    if (!N.dirty || N.pushBusy || !N.userId) return;
    N.pushBusy = true;
    const baseRevision = N.revision;
    try {
      const r = await apiFetch('/api/sync/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: N.doc, baseRevision }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        const remote = (data && data.doc) || { folders: [], notes: [], tombs: {} };
        N.doc = mergeDocs(N.doc, remote);
        N.revision = Number(data && data.revision) || N.revision;
        if (Array.isArray(data && data.shares)) N.shares = data.shares;
        ensureUncat();
        persistLocal();
        N.dirty = true;
        schedulePush(); // 以新 baseRevision 重推本地合并结果
        if (N.ready) renderAll();
      } else if (r.ok) {
        const data = await r.json().catch(() => ({}));
        N.revision = Number(data.revision) || baseRevision + 1;
        N.dirty = false;
        persistLocal();
        syncDot('ok');
        // 云同步落定:保存状态从「同步中」收敛为「已保存 HH:MM」
        if (N.editor && !N.editor.dirty) setSaveState('saved');
      } else {
        syncDot('err');
      }
    } catch (e) {
      syncDot('err');
    } finally {
      N.pushBusy = false;
    }
  }
  async function pullFromCloud() {
    try {
      const r = await apiFetch('/api/sync/notes');
      if (!r.ok) return;
      const data = await r.json().catch(() => ({}));
      if (!data || !data.doc) { N.revision = Number(data && data.revision) || 0; return; }
      const hadLocal = N.doc.notes.length > 0 || N.doc.folders.length > 1;
      N.doc = hadLocal ? mergeDocs(N.doc, data.doc) : {
        folders: Array.isArray(data.doc.folders) ? data.doc.folders : [],
        notes: Array.isArray(data.doc.notes) ? data.doc.notes : [],
        tombs: data.doc.tombs || {},
      };
      N.revision = Number(data.revision) || 0;
      N.shares = Array.isArray(data.shares) ? data.shares : [];
      ensureUncat();
      persistLocal();
      if (N.ready) renderAll();
    } catch (e) { /* 离线时继续用本地 */ }
  }

  // 所有变更经由 mutate:立即落本地 + 防抖推云端 + 重绘
  function mutate(fn, opts) {
    fn();
    persistLocal();
    schedulePush();
    if (N.ready && !(opts && opts.noRender)) renderAll();
  }

  // ============ 数据操作 ============
  function folderById(id) { return N.doc.folders.find((f) => f.id === id) || null; }
  function noteById(id) { return N.doc.notes.find((n) => n.id === id) || null; }
  function folderName(id) { const f = folderById(id); return f ? f.name : UNCATA_LABEL; }
  function childFolders(pid) { return N.doc.folders.filter((f) => f.parentId === pid); }
  function folderDepth(id, guard) {
    guard = guard || 0;
    let d = 0;
    let cur = folderById(id);
    while (cur && cur.parentId && guard < 10) {
      d++; guard++;
      cur = folderById(cur.parentId);
    }
    return d;
  }

  function createFolder(name, parentId, opts) {
    const now = Date.now();
    const f = {
      id: uid('f'), parentId: parentId || null, name: String(name || '').trim() || '新建文件夹',
      description: '', createdAt: now, updatedAt: now,
    };
    N.doc.folders.push(f);
    if (!(opts && opts.silent)) mutate(() => {});
    return f;
  }
  function renameFolder(id, name) {
    const f = folderById(id);
    if (!f) return;
    f.name = String(name || '').trim() || f.name;
    f.updatedAt = Date.now();
    mutate(() => {});
  }
  function deleteFolder(id) {
    if (id === UNCATA) return;
    const f = folderById(id);
    if (!f) return;
    const now = Date.now();
    // 子文件夹上提一级,笔记全部落入「默认分类」
    N.doc.folders.forEach((x) => { if (x.parentId === id) { x.parentId = f.parentId || null; x.updatedAt = now; } });
    N.doc.notes.forEach((n) => { if (n.folderId === id) { n.folderId = UNCATA; n.updatedAt = now; } });
    N.doc.tombs[id] = now;
    N.doc.folders = N.doc.folders.filter((x) => x.id !== id);
    if (N.ui.folderId === id) N.ui.folderId = UNCATA;
    mutate(() => {});
    persistUi();
  }
  function createNote(folderId, data) {
    const now = Date.now();
    const n = {
      id: uid('n'),
      folderId: folderById(folderId) ? folderId : UNCATA,
      title: String((data && data.title) || '').trim() || '无标题笔记',
      content: String((data && data.content) || ''),
      tags: Array.isArray(data && data.tags) ? data.tags.filter(Boolean).slice(0, 20) : [],
      attachments: Array.isArray(data && data.attachments) ? data.attachments : [],
      isPinned: false,
      shareMode: 'private',
      shareToken: '',
      source: (data && data.source) || null,
      createdAt: now,
      updatedAt: now,
    };
    N.doc.notes.push(n);
    if (!(data && data.silent)) mutate(() => {});
    else { persistLocal(); schedulePush(); }
    return n;
  }
  function updateNote(id, patch) {
    const n = noteById(id);
    if (!n) return;
    Object.assign(n, patch, { updatedAt: Date.now() });
    mutate(() => {}, patch && patch._noRender ? { noRender: true } : undefined);
  }
  function deleteNote(id) {
    const n = noteById(id);
    if (!n) return;
    const now = Date.now();
    N.doc.tombs[id] = now;
    N.doc.notes = N.doc.notes.filter((x) => x.id !== id);
    if (N.ui.selNoteId === id) { N.ui.selNoteId = null; N.editor = null; }
    mutate(() => {});
    persistUi();
  }
  function togglePin(id) {
    const n = noteById(id);
    if (!n) return;
    n.isPinned = !n.isPinned;
    n.updatedAt = Date.now();
    mutate(() => {});
  }
  function moveNote(id, folderId) {
    const n = noteById(id);
    if (!n || !folderById(folderId) || n.folderId === folderId) return;
    n.folderId = folderId;
    n.updatedAt = Date.now();
    mutate(() => {});
    toast('已移动到「' + folderName(folderId) + '」');
  }

  // ============ 云端分享状态对齐(服务端为准) ============
  function shareOf(noteId) { return N.shares.find((s) => s.noteId === noteId) || null; }
  function alignShareState() {
    N.doc.notes.forEach((n) => {
      const s = shareOf(n.id);
      if (s) { n.shareMode = s.mode; n.shareToken = s.token; }
      else { n.shareMode = 'private'; n.shareToken = ''; }
    });
  }

  // ============ 模块初始化 ============
  function ensureUser() {
    const s = appState();
    const id = s && s.user && s.user.id;
    if (!id) return false;
    if (N.userId !== id) {
      N.userId = id;
      N.ready = false;
      N.doc = { folders: [], notes: [], tombs: {} };
      N.revision = 0;
      N.shares = [];
      loadLocal();
      loadUi();
    }
    return true;
  }
  async function ensureLoaded() {
    if (!ensureUser()) return false;
    if (!N.ready) {
      N.ready = true;
      alignShareState();
      pullFromCloud();
    }
    return true;
  }

  // ============ 全屏模块骨架 ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-fs-mask hidden';
    mask.innerHTML =
      '<div class="notes-fs" role="dialog" aria-modal="true" aria-label="AI 笔记">'
      + '<header class="notes-fs-head" id="notes-fs-head">'
      + '<div class="nfh-left">'
      + '<button class="nf-brand" id="notes-brand" data-tip="返回对话首页" aria-label="返回对话首页">'
      + '<img src="./logo.svg" class="brand-logo-light" alt="TinyChat">'
      + '<img src="./logo-dark.svg" class="brand-logo-dark" alt="TinyChat">'
      + '</button>'
      + '<button class="notes-back-btn" data-act="close" data-tip="返回对话（Esc）">' + icon('chevronLeft', 14) + '<span>返回</span></button>'
      + '</div>'
      + '<div class="nfh-right">'
      // 编辑器控件压缩在顶栏(标题与下方输入区左对齐);未选中笔记时隐藏
      + '<div class="notes-editor-bar hidden" id="notes-editor-bar">'
      + '<input class="neb-title" id="ne-title" placeholder="无标题笔记" maxlength="200" spellcheck="false">'
      + '<button class="neb-folder" id="ne-folder" data-tip="移动到其他文件夹"><span id="ne-folder-name"></span>' + icon('chevronDown', 11) + '</button>'
      + '<span class="neb-time" id="ne-time">更新于 --</span>'
      + '<span class="neb-sep">·</span>'
      + '<span class="ne-save-state" id="ne-save-state">已保存</span>'
      + '<button class="neb-tags-btn" id="ne-tags-btn" data-tip="编辑标签">' + icon('tag', 13) + '<span>标签</span></button>'
      + '<button class="neb-ai-btn" id="ne-ai" data-tip="AI 全文操作">' + icon('spark', 13) + '<span>AI</span></button>'
      + '<button class="neb-ai-btn" id="ne-ask" data-tip="基于全部笔记回答问题">' + icon('search', 13) + '<span>问笔记</span></button>'
      + '<button class="notes-icon-btn" id="ne-undo" data-tip="上一步（Ctrl+Z）" aria-label="上一步">' + icon('undo', 15) + '</button>'
      + '<button class="notes-icon-btn" id="ne-redo" data-tip="下一步（Ctrl+Shift+Z）" aria-label="下一步">' + icon('redo', 15) + '</button>'
      + '<div class="notes-mode-switch" id="ne-mode-switch">'
      + '<button data-mode="edit">编辑</button>'
      + '<button data-mode="split">分屏</button>'
      + '<button data-mode="preview">预览</button>'
      + '</div>'
      + '<div class="notes-editor-toolbar">'
      + '<button class="notes-icon-btn" data-act="image" data-tip="插入图片（也可直接粘贴 / 拖拽）">' + icon('image', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="attach" data-tip="添加附件">' + icon('paperclip', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="share" data-tip="分享设置">' + icon('link', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="export" data-tip="导出 .md">' + icon('download', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="delete" data-tip="删除笔记">' + icon('trash', 15) + '</button>'
      + '</div>'
      + '</div>'
      + '<span class="notes-sync" id="notes-sync-dot" data-tip="云同步状态"></span>'
      + '</div>'
      + '</header>'
      + '<button class="notes-side-float hidden" id="notes-side-float" data-tip="展开文件夹面板">' + icon('panelLeft', 15) + '</button>'
      + '<div class="notes-fs-body" id="notes-fs-body">'
      + '<aside class="notes-side" id="notes-side">'
      + '<div class="notes-side-tools">'
      + '<button class="notes-new-btn" id="notes-new-btn">' + icon('plus', 13) + '新建笔记</button>'
      + '<button class="notes-new-btn" id="notes-folder-new">' + icon('folderPlus', 14) + '新文件夹</button>'
      + '<button class="notes-icon-btn" id="notes-sort-btn" data-tip="排序">' + icon('sort', 15) + '</button>'
      + '<button class="notes-icon-btn" id="notes-side-collapse" data-tip="收起面板">' + icon('panelLeft', 15) + '</button>'
      + '</div>'
      + '<div class="notes-search">'
      + '<span class="notes-search-icon">' + icon('search', 14) + '</span>'
      + '<input id="notes-search-input" type="search" placeholder="搜索标题、内容或标签" autocomplete="off" spellcheck="false">'
      + '</div>'
      + '<div class="notes-tree" id="notes-tree"></div>'
      + '<div class="notes-usage-row">'
      + '<span class="notes-usage" id="notes-usage"></span>'
      + '<button class="notes-icon-btn notes-gear" id="notes-gear" data-tip="自定义右键菜单">' + icon('gear', 14) + '</button>'
      + '</div>'
      + '</aside>'
      + '<div class="notes-side-resizer" id="notes-side-resizer" data-tip="拖动调整宽度" aria-hidden="true"></div>'
      + '<section class="notes-editor-pane" id="notes-editor-pane"></section>'
      + '</div>'
      + '<div class="notes-upload-bar hidden" id="notes-upload-bar"></div>'
      + '</div>';
    document.body.appendChild(mask);
    N.els.mask = mask;
    N.els.head = mask.querySelector('#notes-fs-head');
    N.els.bar = mask.querySelector('#notes-editor-bar');
    N.els.tree = mask.querySelector('#notes-tree');
    N.els.editorPane = mask.querySelector('#notes-editor-pane');
    N.els.searchInput = mask.querySelector('#notes-search-input');
    N.els.syncDot = mask.querySelector('#notes-sync-dot');
    N.els.uploadBar = mask.querySelector('#notes-upload-bar');
    N.els.usage = mask.querySelector('#notes-usage');
    // 恢复上次侧栏宽度
    const savedW = parseInt(localStorage.getItem('oc_notes_side_w') || '', 10);
    if (savedW >= 200 && savedW <= 560) mask.querySelector('.notes-fs').style.setProperty('--notes-side-w', savedW + 'px');
    initSideResizer(mask);
    mask.querySelector('#notes-gear').addEventListener('click', (e) => openAiSettingsMenu(e.currentTarget));

    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) flushEditor();
    });
    // 右键菜单的全局收起(只注册一次;模块重开也不再重复挂)
    document.addEventListener('mousedown', (e) => {
      if (aiCtxMenu && !aiCtxMenu.contains(e.target)) closeAiCtxMenu();
    }, true);
    mask.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAiCtxMenu(); });
    mask.querySelector('[data-act="close"]').addEventListener('click', close);
    // Logo 与返回按钮一致:关闭笔记模块回到对话首页
    mask.querySelector('#notes-brand').addEventListener('click', close);
    mask.querySelector('#notes-folder-new').addEventListener('click', () => {
      // 选中普通文件夹时在其内部新建子文件夹;默认分类/根保持顶层
      const sel = folderById(N.ui.folderId);
      promptNewFolder(sel && sel.id !== UNCATA ? sel.id : null);
    });
    mask.querySelector('#notes-sort-btn').addEventListener('click', (e) => {
      const items = [
        { value: 'updated', label: '按更新时间（新→旧）' },
        { value: 'created', label: '按创建时间（新→旧）' },
        { value: 'title', label: '按标题（A→Z）' },
      ];
      window.OC.openSelect(e.currentTarget, items, {
        selected: N.ui.sort,
        onSelect: (v) => { N.ui.sort = v; persistUi(); renderTree(); },
      });
    });
    mask.querySelector('#notes-new-btn').addEventListener('click', (e) => openNewNoteDialog(e.currentTarget));
    // 仿对话首页的整栏侧栏折叠
    mask.querySelector('#notes-side-collapse').addEventListener('click', toggleSide);
    mask.querySelector('#notes-side-float').addEventListener('click', toggleSide);
    N.els.searchInput.addEventListener('input', debounce(() => {
      N.ui.search = N.els.searchInput.value.trim();
      renderTree();
    }, 160));
    // Esc 已由 modal 栈接管;Ctrl+S 手动保存
    mask.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushEditor();
        pushNow();
        toast('已保存' + (N.dirty ? '（待同步）' : ''));
      }
    });
    applySideState();
  }

  // 侧栏整栏折叠/展开(状态持久化,浮标恢复)
  function toggleSide() {
    N.ui.sideCollapsed = !N.ui.sideCollapsed;
    persistUi();
    applySideState();
  }
  function applySideState() {
    const fs = N.els.mask && N.els.mask.querySelector('.notes-fs');
    if (!fs) return;
    // 只折叠左侧面板:编辑器区域占满剩余宽度
    fs.classList.toggle('side-collapsed', !!N.ui.sideCollapsed);
    const float = N.els.mask.querySelector('#notes-side-float');
    if (float) float.classList.toggle('hidden', !N.ui.sideCollapsed);
  }

  // 模块内的输入弹窗:圆角输入框、聚焦不做蓝色高亮(替代全局 OCUI.prompt)
  function notesPrompt(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask notes-prompt-mask hidden';
      mask.innerHTML =
        '<div class="modal notes-prompt-modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>' + esc(opts.title || '请输入') + '</h3></div>'
        + '<div class="modal-body">'
        + (opts.message ? '<p class="confirm-message">' + esc(opts.message) + '</p>' : '')
        + '<input type="text" class="notes-prompt-input" maxlength="' + (opts.maxlength || 60) + '" spellcheck="false">'
        + '</div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>'
        + '<button class="btn primary" data-act="ok">' + esc(opts.confirmText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      const input = mask.querySelector('.notes-prompt-input');
      input.value = opts.value || '';
      // settled 守卫:closeModal 会触发 _onClose,不能再进入关闭流程(否则无限递归)
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
        window.OCUI.closeModal(mask);
        setTimeout(() => mask.remove(), 340);
      };
      mask._onClose = () => finish(null);
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return finish(null);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        finish(act.dataset.act === 'ok' ? String(input.value).trim() : null);
      });
      mask.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); finish(String(input.value).trim()); }
      });
      if (window.OCUI) window.OCUI.openModal(mask);
      else mask.classList.add('show');
      setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  }

  // 标签编辑弹窗:增删即时保存
  function openTagsDialog(n) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-tags-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-tags-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>标签</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<div class="ntags-list" id="ntags-list"></div>'
      + '<input type="text" class="notes-prompt-input" id="ntags-input" placeholder="输入标签，回车添加" maxlength="24" spellcheck="false">'
      + '</div>'
      + '<div class="modal-footer"><button class="btn primary" data-close>完成</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    let tagSettled = false;
    const closeDlg = () => {
      if (tagSettled) return;
      tagSettled = true;
      window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 340);
    };
    mask._onClose = closeDlg;
    mask.querySelector('[data-close]').addEventListener('click', closeDlg);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    const renderList = () => {
      const cur = noteById(n.id);
      const tags = cur ? (cur.tags || []) : [];
      const list = mask.querySelector('#ntags-list');
      list.innerHTML = tags.length
        ? tags.map((t, i) => '<span class="ne-tag" data-i="' + i + '">#' + esc(t) + '<button class="ne-tag-x" data-tip="移除标签">×</button></span>').join('')
        : '<span class="nt-none">还没有标签，回车即可添加。</span>';
      list.querySelectorAll('.ne-tag-x').forEach((x) => {
        x.addEventListener('click', () => {
          const i = Number(x.closest('.ne-tag').dataset.i);
          const c = noteById(n.id);
          if (!c) return;
          const tags = (c.tags || []).slice();
          tags.splice(i, 1);
          updateNote(n.id, { tags });
          renderList();
        });
      });
    };
    const input = mask.querySelector('#ntags-input');
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      const c = noteById(n.id);
      if (!c) return;
      const tags = (c.tags || []).slice();
      if (tags.indexOf(v) < 0) tags.push(v);
      updateNote(n.id, { tags });
      input.value = '';
      renderList();
    });
    renderList();
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    setTimeout(() => { input.focus(); }, 60);
  }

  // 侧栏左下角:附件空间剩余(配额在后台设置,0 表示不限)
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 侧栏拖拽调宽(与对话首页侧边栏同一套交互,宽度记忆在本地)
  function initSideResizer(root) {
    const resizer = root.querySelector('#notes-side-resizer');
    const fs = root.querySelector('.notes-fs');
    if (!resizer || !fs) return;
    const MIN = 200, MAX = 560;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = fs.querySelector('.notes-side').getBoundingClientRect().width;
      fs.classList.add('resizing');
      const onMove = (ev) => {
        const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX)));
        fs.style.setProperty('--notes-side-w', w + 'px');
      };
      const onUp = () => {
        const w = fs.querySelector('.notes-side').getBoundingClientRect().width;
        try { localStorage.setItem('oc_notes_side_w', String(Math.round(w))); } catch (err) {}
        fs.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // 左下角齿轮:定义右键菜单里显示哪些 AI 动作
  // 内置动作提示词(自定义动作直接存完整 prompt 模板,占位符 {{text}} 为选中文字)
  const BUILTIN_ACTIONS = [
    {
      key: 'expand', label: '扩写', desc: '把选中的内容展开写详细', builtin: true,
      prompt: '请扩写下面这段内容：补充细节、背景与必要的例子，使表达更充分，但不要改变原意，也不要引入原文没有的事实。',
    },
    {
      key: 'check', label: '谬误检查', desc: '检查事实与逻辑上的问题', builtin: true,
      prompt: '请检查下面这段内容中的事实性错误、逻辑漏洞与表述不严谨之处，并给出修正后的版本：保留原有结构与有效信息，改正的问题要落实到正文里（不要只列问题清单）。',
    },
    {
      key: 'summarize', label: '总结', desc: '压缩为要点', builtin: true,
      prompt: '请把下面这段内容总结为简洁的要点：保留关键信息、结论与限制条件，删除冗余表述。',
    },
    {
      key: 'translate', label: '翻译', desc: '中→英 / 英→中 / 中英混杂→英', builtin: true,
      autoDir: true,
      prompt: '请把下面这段内容翻译成地道的{{lang}}：专有名词与技术术语保留原文（必要时括注），语气与原文一致。',
    },
    {
      key: 'dedupe', label: '降低重复率', desc: '改写去除重复表达', builtin: true,
      prompt: '请改写下面这段内容以降低重复率：合并同义表述、删除重复信息、替换冗余句式，保持原意与信息完整性不变。',
    },
  ];
  // 读取用户自定义(停用列表 + 自定义动作 + 内置动作的覆盖)
  function aiConfig() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('oc_notes_ai_cfg') || 'null'); } catch (e) {}
    const cfg = saved && typeof saved === 'object' ? saved : {};
    return {
      disabled: Array.isArray(cfg.disabled) ? cfg.disabled : [],
      custom: Array.isArray(cfg.custom) ? cfg.custom.filter((x) => x && x.key && x.label) : [],
      overrides: cfg.overrides && typeof cfg.overrides === 'object' ? cfg.overrides : {},
    };
  }
  function aiConfigSave(cfg) {
    try { localStorage.setItem('oc_notes_ai_cfg', JSON.stringify(cfg)); } catch (e) {}
  }
  // 当前生效的动作列表(内置已覆盖 + 自定义,按顺序)
  function aiActions() {
    const cfg = aiConfig();
    const list = BUILTIN_ACTIONS.map((a) => {
      const ov = cfg.overrides[a.key] || {};
      return Object.assign({}, a, {
        label: ov.label || a.label,
        desc: ov.desc || a.desc,
        prompt: ov.prompt || a.prompt,
        enabled: cfg.disabled.indexOf(a.key) < 0,
      });
    });
    cfg.custom.forEach((c) => {
      list.push({
        key: c.key, label: c.label, desc: c.desc || '自定义动作', prompt: c.prompt || '{{text}}',
        custom: true, enabled: cfg.disabled.indexOf(c.key) < 0,
      });
    });
    return list;
  }
  // 兼容旧调用:启用映射
  function aiActionsEnabled() {
    const map = {};
    aiActions().forEach((a) => { map[a.key] = a.enabled; });
    return map;
  }

  // 中文占比判断:用于翻译方向(中文→英文,英文→中文,中英混杂→英文)
  function mostlyChinese(text) {
    const cn = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
    const en = (String(text).match(/[A-Za-z]/g) || []).length;
    return cn > 0 && cn * 2 >= en; // 中文占比过半 → 视为中文文本
  }
  function aiActionPrompt(action, text) {
    // 统一约束:只输出结果本身,不加解释、不加代码块围栏,便于直接插回正文
    const tail = '\n直接输出处理后的内容本身，不要任何解释、前言、编号或代码块围栏，保持 Markdown 格式。';
    let body = String((action && action.prompt) || '{{text}}');
    if (action && action.autoDir) {
      body = body.replace('{{lang}}', mostlyChinese(text) ? '英文' : '中文');
    }
    // 模板含占位符则替换,否则把原文附在末尾(自定义动作两种写法都支持)
    if (body.indexOf('{{text}}') >= 0) return body.replace('{{text}}', text) + tail;
    return body + tail + '\n\n' + text;
  }
  // ============ 正文选区右键:AI 编辑 ============
  // 结果插到选中文字之后(前后各留一个换行),原选中内容保持不变。
  let aiCtxMenu = null;
  function closeAiCtxMenu() {
    if (aiCtxMenu) { aiCtxMenu.remove(); aiCtxMenu = null; }
  }
  // 常用编辑(原生 textarea 能力):以一排小图标放在 AI 动作上方。
  // 「粘贴纯文本」用 navigator.clipboard.readText 过滤格式,粘贴为无格式文本。
  const CTX_TOOLS = [
    { key: 'cut', tip: '剪切', icon: 'cut' },
    { key: 'copy', tip: '复制', icon: 'copy' },
    { key: 'paste', tip: '粘贴', icon: 'clipboard' },
    { key: 'paste-plain', tip: '粘贴为纯文本', icon: 'clipboardPlain' },
    { key: 'selectall', tip: '全选', icon: 'selectAll' },
    { key: 'undo', tip: '撤销', icon: 'undo' },
    { key: 'redo', tip: '重做', icon: 'redo' },
  ];
  function runCtxTool(tool) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    if (tool === 'cut' || tool === 'copy') {
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (a === b) { toast('先选中要' + (tool === 'cut' ? '剪切' : '复制') + '的内容'); return; }
      const sel = ta.value.slice(a, b);
      const done = () => {
        if (tool === 'cut') {
          ta.value = ta.value.slice(0, a) + ta.value.slice(b);
          ta.selectionStart = ta.selectionEnd = a;
          N.editor.dirty = true;
          pushHistory({ force: true });
          renderPreview(ta.value);
          scheduleSaveSoon();
        }
        toast(tool === 'cut' ? '已剪切' : '已复制');
      };
      if (window.OCUI && window.OCUI.copyText) {
        window.OCUI.copyText(sel).then((ok) => { if (ok) done(); else toast('复制失败', true); });
      } else {
        try { navigator.clipboard.writeText(sel).then(done); } catch (e) { toast('复制失败', true); }
      }
      return;
    }
    if (tool === 'paste' || tool === 'paste-plain') {
      const insert = (txt) => {
        const a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + txt.length;
        N.editor.dirty = true;
        pushHistory({ force: true });
        renderPreview(ta.value);
        scheduleSaveSoon();
      };
      if (tool === 'paste-plain') {
        // 纯文本:剥掉 Markdown 结构符号与多余空行
        const plain = (raw) => String(raw)
          .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, ''))
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s{0,3}#{1,6}\s+/gm, '')
          .replace(/^\s{0,3}>\s?/gm, '')
          .replace(/^\s*[-*+]\s+/gm, '')
          .replace(/[*_~`]+/g, '')
          .replace(/\n{3,}/g, '\n\n');
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((raw) => insert(plain(raw))).catch(() => {
            toast('浏览器未授权读取剪贴板，请用 Ctrl+Shift+V', true);
          });
        } else {
          toast('当前浏览器不支持，请用 Ctrl+Shift+V', true);
        }
        return;
      }
      // 普通粘贴:交给原生事件(这里显式读取剪贴板文本兜底)
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(insert).catch(() => toast('请用 Ctrl+V 粘贴', true));
      } else {
        toast('请用 Ctrl+V 粘贴', true);
      }
      return;
    }
    if (tool === 'selectall') {
      ta.focus();
      ta.selectionStart = 0;
      ta.selectionEnd = ta.value.length;
      return;
    }
    if (tool === 'undo') { undo(); return; }
    if (tool === 'redo') { redo(); return; }
  }

  function ctxToolbarHtml() {
    return '<div class="ncm-tools">' + CTX_TOOLS.map((t) =>
      '<button class="ncm-tool" data-tool="' + t.key + '" data-tip="' + esc(t.tip) + '" aria-label="' + esc(t.tip) + '">'
      + icon(t.icon, 14) + '</button>').join('') + '</div>';
  }

  function openAiCtxMenu(x, y, text, start, end) {
    closeAiCtxMenu();
    const acts = aiActions().filter((a) => a.enabled);
    const menu = document.createElement('div');
    menu.className = 'notes-ctx-menu';
    menu.innerHTML = ctxToolbarHtml()
      + '<div class="ncm-sep"></div>'
      + (acts.length
        ? '<div class="ncm-head">AI 编辑</div>'
          + acts.map((a) => '<button class="ncm-item" data-ai="' + a.key + '"><span>' + esc(a.label) + '</span><i>' + esc(a.desc) + '</i></button>').join('')
        : '<div class="ncm-empty">没有启用的动作。点左下角齿轮添加或启用。</div>');
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 保住输入框焦点与选区
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAiCtxMenu();
        runCtxTool(b.dataset.tool);
      });
    });
    // 视口内定位(靠近边缘时自动内收)
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    aiCtxMenu = menu;
    menu.querySelectorAll('[data-ai]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAiCtxMenu();
        runAiEdit(b.dataset.ai, text, start, end);
      });
    });
  }

  async function runAiEdit(key, text, start, end) {
    if (!window.OCApp || !window.OCApp.aiComplete) { toast('AI 能力尚未就绪，请刷新页面', true); return; }
    const noteId = N.editor && N.editor.noteId;
    const n = noteById(noteId);
    if (!n) return;
    const act = aiActions().find((a) => a.key === key);
    // 占位标记:先把光标位置放好,结束后直接替换占位
    const ta = N.editor.ta;
    const marker = '\n\n<!--AI:' + Date.now().toString(36) + '-->\n';
    insertAtCursor(marker, end);
    setSaveState('editing');
    const busy = showAiBusy(act ? act.label : '处理');
    try {
      const out = await aiRun('note-edit', [
        { role: 'system', content: '你是严谨的中文写作助手。只按用户要求处理文本并直接输出结果，不要解释过程。' },
        { role: 'user', content: aiActionPrompt(act, text) },
      ], 4096);
      const clean = String(out || '').trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
      if (!clean) throw new Error('模型没有返回内容');
      replaceMarker(marker, '\n\n' + clean + '\n');
      toast((act ? act.label : 'AI 编辑') + '完成');
    } catch (e) {
      removeMarker(marker);
      toast('AI 编辑失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
      setSaveState('editing');
    }
  }

  // 在指定位置插入文本,并把光标移到插入内容之后
  function insertAtCursor(text, at) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    const pos = typeof at === 'number' ? at : (ta.selectionEnd || ta.value.length);
    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + text.length;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(ta.value);
    scheduleSaveSoon();
  }
  function replaceMarker(marker, text) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    const i = ta.value.indexOf(marker);
    if (i < 0) { insertAtCursor(text, ta.selectionEnd); return; }
    ta.value = ta.value.slice(0, i) + text + ta.value.slice(i + marker.length);
    ta.selectionStart = ta.selectionEnd = i + text.length;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(ta.value);
    scheduleSaveSoon();
  }
  function removeMarker(marker) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    const i = ta.value.indexOf(marker);
    if (i < 0) return;
    ta.value = ta.value.slice(0, i) + ta.value.slice(i + marker.length);
    renderPreview(ta.value);
  }
  function scheduleSaveSoon() {
    if (!N.editor) return;
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 500);
  }
  // ============ AI 扩展能力 ============
  // 统一的 AI 取用入口:先扣每日配额(后端),再调用补全,避免被当作免费 LLM 通道
  async function aiRun(purpose, messages, maxTokens) {
    const r = await apiFetch('/api/notes/ai/consume', { method: 'POST' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error((d.error && d.error.message) || '今日 AI 次数不足');
    }
    const out = await window.OCApp.aiComplete(messages, { purpose: purpose, maxTokens: maxTokens || 4096 });
    refreshUsage();
    return out;
  }
  function stripFence(t) {
    return String(t || '').trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  // ---- 建议1:全文 AI 动作 ----
  function openDocAiMenu(anchor) {
    const items = [
      { value: 'outline', label: '生成大纲 · 提取小标题层级' },
      { value: 'todos', label: '提取待办 · 汇总为任务列表' },
      { value: 'summary', label: '写入摘要 · 追加到正文开头' },
      { value: 'tags', label: '推荐标签 · 自动补充标签' },
      { value: 'tidy', label: '自动整理 · 重排结构（预览后应用）' },
      { value: 'links', label: '双链图谱 · 生成 Mermaid 关系图' },
      { value: 'digest', label: '生成日报 · 汇总近 24 小时更新的笔记' },
    ];
    window.OC.openSelect(anchor, items, {
      fitWidth: true,
      onSelect: (v) => runDocAi(v),
    });
  }
  async function runDocAi(kind) {
    if (kind === 'digest') { void runDailyDigest(); return; }
    const n = noteById(N.ui.selNoteId);
    if (!n || !N.editor) return;
    const text = N.editor.ta.value || '';
    if (!text.trim()) { toast('笔记还是空的，先写点内容吧', true); return; }
    const busy = showAiBusy(DOC_AI_LABEL[kind] || '处理');
    try {
      if (kind === 'tags') {
        const out = await aiRun('note-tags', [
          { role: 'system', content: '你是笔记助手。只输出 3-6 个简短中文标签，用中文逗号分隔，不要解释。' },
          { role: 'user', content: '为下面这篇笔记推荐标签：\n\n' + text.slice(0, 6000) },
        ], 200);
        const tags = stripFence(out).split(/[,，、\n]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8);
        if (!tags.length) throw new Error('没有解析出标签');
        const cur = noteById(n.id);
        const merged = Array.from(new Set(((cur && cur.tags) || []).concat(tags))).slice(0, 20);
        updateNote(n.id, { tags: merged });
        toast('已补充标签：' + tags.join('、'));
        return;
      }
      const prompts = {
        outline: '请为下面这篇笔记生成层级大纲：用 Markdown 无序列表输出 2 层，覆盖全文要点，不要解释。',
        todos: '请从下面这篇笔记里提取所有待办事项，输出 Markdown 任务列表（- [ ] 事项），注明负责人与时间（若有），不要解释。',
        summary: '请为下面这篇笔记写一段 100 字以内的摘要，直接输出摘要正文（不要「摘要：」前缀）。',
        tidy: '请重排下面这篇笔记的结构：补齐小标题、把并列信息改成列表、合并重复段落，保留全部事实与代码。直接输出整理后的完整 Markdown 全文。',
        links: '请分析下面这篇笔记涉及的核心概念及其关系，输出一个 Mermaid 代码块（graph LR，节点用中文短语，最多 12 个节点），不要解释。',
      };
      const out = await aiRun('note-doc', [
        { role: 'system', content: '你是严谨的中文写作助手。只输出要求的内容本身，不要任何解释或额外前言。' },
        { role: 'user', content: prompts[kind] + '\n\n' + text.slice(0, 12000) },
      ], kind === 'tidy' ? 8192 : 2048);
      const clean = stripFence(out);
      if (!clean) throw new Error('模型没有返回内容');
      if (kind === 'tidy') { showTidyPreview(n, clean); return; }
      if (kind === 'summary') {
        const cur = noteById(n.id);
        const head = '> **摘要**：' + clean.replace(/\n+/g, ' ').trim() + '\n\n';
        updateNote(n.id, { content: head + (cur ? cur.content : text) });
        saveEditorSoon(n.id);
        toast('摘要已写入正文开头');
        return;
      }
      // outline / todos / links 追加到文末
      const cur = noteById(n.id);
      const block = '\n\n## ' + (DOC_AI_HEAD[kind] || 'AI 生成') + '\n\n' + clean + '\n';
      updateNote(n.id, { content: (cur ? cur.content : text) + block });
      saveEditorSoon(n.id);
      toast((DOC_AI_LABEL[kind] || 'AI') + '已完成');
    } catch (e) {
      toast('AI 操作失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }
  const DOC_AI_LABEL = { outline: '生成大纲', todos: '提取待办', summary: '写入摘要', tags: '推荐标签', tidy: '自动整理', links: '生成双链图谱', digest: '生成日报' };
  const DOC_AI_HEAD = { outline: '大纲', todos: '待办事项', links: '概念关系图' };
  // 把更新后的内容灌回编辑器并触发保存(不重渲染编辑器,避免打断光标)
  function saveEditorSoon(noteId) {
    if (!N.editor || N.editor.noteId !== noteId) { renderEditor(); return; }
    const cur = noteById(noteId);
    if (!cur) return;
    const ti = N.els.bar.querySelector('#ne-title');
    if (ti && ti.value !== cur.title) ti.value = cur.title;
    N.editor.ta.value = cur.content;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(cur.content);
    setSaveState('editing');
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 400);
    renderTree();
  }

  // 建议6:自动整理 → 预览对比后再应用
  function showTidyPreview(n, newContent) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-tidy-mask hidden';
    mask.innerHTML =
      '<div class="modal modal-lg notes-tidy-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('spark', 15) + ' 自动整理预览</h3></div>'
      + '<div class="modal-body notes-tidy-body">'
      + '<div class="tidy-col"><div class="tidy-head">整理前</div><div class="tidy-pane md-prose msg assistant" id="tidy-old"></div></div>'
      + '<div class="tidy-col"><div class="tidy-head">整理后</div><div class="tidy-pane md-prose msg assistant" id="tidy-new"></div></div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" data-close type="button">放弃</button>'
      + '<button class="btn primary" id="tidy-apply" type="button">应用整理结果</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelector('[data-close]').addEventListener('click', done);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    if (window.OCRenderer) {
      window.OCRenderer.renderInto(mask.querySelector('#tidy-old'), N.editor.ta.value);
      window.OCRenderer.renderInto(mask.querySelector('#tidy-new'), newContent);
    } else {
      mask.querySelector('#tidy-old').textContent = N.editor.ta.value;
      mask.querySelector('#tidy-new').textContent = newContent;
    }
    mask.querySelector('#tidy-apply').addEventListener('click', () => {
      const cur = noteById(n.id);
      updateNote(n.id, { content: newContent });
      saveEditorSoon(n.id);
      done();
      toast('已应用整理结果（可 Ctrl+Z 撤销）');
      void cur;
    });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // ---- 建议3:问笔记(关键词召回 + 引用来源) ----
  function noteKeywords(q) {
    const raw = String(q).toLowerCase();
    const words = raw.match(/[a-z0-9_]+|[\u4e00-\u9fff]{2,}/g) || [];
    const out = new Set(words);
    // 中文长词再切 2-gram,提升召回
    words.forEach((w) => {
      if (/^[\u4e00-\u9fff]+$/.test(w) && w.length > 2) {
        for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
      }
    });
    return Array.from(out).slice(0, 24);
  }
  function recallNotes(q, limit) {
    const kws = noteKeywords(q);
    const scored = [];
    N.doc.notes.forEach((n) => {
      const hay = ((n.title || '') + '\n' + (n.content || '')).toLowerCase();
      let score = 0;
      kws.forEach((k) => { if (k && hay.indexOf(k) >= 0) score += Math.min(4, k.length); });
      if (kws.some((k) => (n.title || '').toLowerCase().indexOf(k) >= 0)) score += 6;
      if (score > 0) scored.push({ note: n, score: score });
    });
    scored.sort((a, b) => b.score - a.score || (b.note.updatedAt || 0) - (a.note.updatedAt || 0));
    return scored.slice(0, limit || 5);
  }
  function openAskNotes() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-ask-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-ask-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('search', 15) + ' 问笔记</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">基于你的全部笔记回答，最多引用 5 篇；回答会列出引用来源，仅作参考，请自行核对。</p>'
      + '<div class="ask-row"><input class="notes-prompt-input" id="ask-q" placeholder="例如：容器查询和媒体查询的差别是什么？" maxlength="300" spellcheck="false">'
      + '<button class="btn primary" id="ask-go" type="button">提问</button></div>'
      + '<div class="ask-answer" id="ask-answer"></div>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn" data-close>关闭</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    const input = mask.querySelector('#ask-q');
    const ans = mask.querySelector('#ask-answer');
    const go = async () => {
      const q = input.value.trim();
      if (!q) return;
      const hits = recallNotes(q, 5);
      ans.innerHTML = '<div class="ask-loading"><span class="nab-spin"></span>正在阅读你的笔记…</div>';
      try {
        let ctx = '';
        hits.forEach((h, i) => {
          ctx += '\n\n【笔记' + (i + 1) + '】标题：' + h.note.title + '\n' + String(h.note.content || '').slice(0, 3000);
        });
        const out = await aiRun('note-ask', [
          { role: 'system', content: '你是笔记助手。只根据提供的笔记内容回答问题；如果笔记里没有相关信息，直接说明「笔记里没有相关内容」，不要编造。回答后不要自行编造引用编号。' },
          { role: 'user', content: '问题：' + q + '\n\n我的笔记：' + (ctx || '（没有检索到相关笔记）') },
        ], 2048);
        ans.innerHTML = '<div class="ask-text"></div><div class="ask-src"></div>';
        const textBox = ans.querySelector('.ask-text');
        if (window.OCRenderer) window.OCRenderer.renderInto(textBox, stripFence(out));
        else textBox.textContent = stripFence(out);
        const src = ans.querySelector('.ask-src');
        src.innerHTML = hits.length
          ? '<div class="ask-src-head">引用来源（' + hits.length + '）</div>' + hits.map((h) => ''
              + '<button class="ask-src-item" data-id="' + esc(h.note.id) + '">' + esc(h.note.title || '无标题') + '</button>').join('')
          : '<div class="ask-src-head">没有检索到相关笔记，回答仅供参考</div>';
        src.querySelectorAll('[data-src-item], .ask-src-item').forEach((b) => {
          b.addEventListener('click', () => {
            const id = b.dataset.id;
            done();
            if (noteById(id)) openNote(id);
          });
        });
        refreshUsage();
      } catch (e) {
        ans.innerHTML = '<div class="ask-err">' + esc(e.message || '提问失败，请稍后重试') + '</div>';
      }
    };
    mask.querySelector('#ask-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    setTimeout(() => input.focus(), 80);
  }

  // ---- 建议2:Tab 续写 ----
  let continueBusy = false;
  async function continueWriting() {
    if (continueBusy || !N.editor) return;
    const ta = N.editor.ta;
    const caret = ta.selectionStart || 0;
    const before = ta.value.slice(0, caret);
    const after = ta.value.slice(ta.selectionEnd || caret);
    if (!before.trim()) { toast('先写一点内容，AI 才知道怎么接', true); return; }
    continueBusy = true;
    const busy = showAiBusy('续写');
    try {
      const out = await aiRun('note-continue', [
        { role: 'system', content: '你是写作助手。请接着用户已写的内容自然地续写一小段（60-160 字），保持语气与 Markdown 格式一致；只输出续写内容本身，不要重复已有文字，不要解释。' },
        { role: 'user', content: '已有内容（末尾是我停笔的地方）：\n\n' + before.slice(-3000) + (after.trim() ? '\n\n[后面还有内容]' : '') },
      ], 800);
      const ins = stripFence(out);
      if (!ins) throw new Error('没有生成内容');
      const marker = '\n\n<!--AI:' + Date.now().toString(36) + '-->\n';
      ta.value = before + marker + after;
      ta.selectionStart = ta.selectionEnd = before.length + marker.length;
      const rep = '\n\n' + ins + '\n';
      ta.value = before + rep + after;
      // 光标停在补全内容之后,继续按 Tab 可接着写
      ta.selectionStart = ta.selectionEnd = before.length + rep.length;
      N.editor.dirty = true;
      pushHistory({ force: true });
      renderPreview(ta.value);
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 600);
      toast('已续写（可 Ctrl+Z 撤销）');
    } catch (e) {
      toast('续写失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
      continueBusy = false;
    }
  }

  // ---- 建议8:每日摘要(把近期改动的笔记汇总成一篇日报) ----
  async function runDailyDigest() {
    const now = Date.now();
    const since = now - 24 * 3600 * 1000;
    const picks = N.doc.notes
      .filter((n) => (n.updatedAt || 0) >= since && !(n.source && n.source.generatedByAI && n.source.digest))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 20);
    if (!picks.length) { toast('最近 24 小时没有更新的笔记', true); return; }
    const busy = showAiBusy('生成日报');
    try {
      const ctx = picks.map((n) => '## ' + (n.title || '无标题') + '\n' + String(n.content || '').slice(0, 1200)).join('\n\n');
      const out = await aiRun('note-digest', [
        { role: 'system', content: '你是学习/工作记录助手。请把下面的笔记汇总成一份简洁的日报：先给 3-5 条要点，再列出待办（若有），最后注明涉及的笔记标题。直接输出 Markdown。' },
        { role: 'user', content: ctx },
      ], 2048);
      const day = new Date().toISOString().slice(0, 10);
      const content = '## ' + day + ' 每日摘要\n\n' + stripFence(out) + '\n\n---\n\n> 由 AI 汇总，涉及 ' + picks.length + ' 篇近 24 小时更新的笔记。';
      const note = createNote(N.ui.folderId || UNCATA, {
        title: day + ' 日报', tags: ['日报'], content: content,
        source: { conversationId: '', messageId: '', userQuestion: '', generatedByAI: true, digest: true },
      });
      openNote(note.id);
      toast('已生成日报（' + picks.length + ' 篇来源）');
    } catch (e) {
      toast('日报生成失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }

  // ============ 使用导航 ============
  // 空态里常驻一份简版导航;首次进入再弹一次完整引导(加粗深色突出「可右键」)
  function usageGuideHtml() {
    return '<ul class="notes-guide">'
      + '<li><b>选文字右键</b>，用 AI 扩写、总结、翻译、检查谬误或降低重复率。</li>'
      + '<li><b>左下角齿轮</b>可自定义右键菜单里的动作（添加、删除、改名、改提示词）。</li>'
      + '<li><b>打「/」</b>插入模板，<b>按 Tab</b> 让 AI 续写下一句。</li>'
      + '<li><b>顶栏「问笔记」</b>基于全部笔记回答你的问题。</li>'
      + '<li><b>拖拽</b>图片或文件到编辑区即可上传；<b>拖笔记</b>可移动到其他文件夹。</li>'
      + '</ul>';
  }
  function maybeShowFirstRunGuide() {
    let seen = false;
    try { seen = localStorage.getItem('oc_notes_guide_seen') === '1'; } catch (e) {}
    if (seen) return;
    try { localStorage.setItem('oc_notes_guide_seen', '1'); } catch (e) {}
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-guide-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-guide-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('notebook', 15) + ' 欢迎使用 AI 笔记</h3></div>'
      + '<div class="modal-body">'
      + '<p class="ng-lead">这是一套可以用 AI 帮你写作的 Markdown 笔记。几个关键用法：</p>'
      + '<div class="ng-items">'
      + '<div class="ng-item"><span class="ng-num">1</span><div><b>选中文字后右键</b>，让 AI 扩写 / 总结 / 翻译 / 检查谬误 / 降低重复率；结果会追加在选中文字后面，可随时 Ctrl+Z 撤销。</div></div>'
      + '<div class="ng-item"><span class="ng-num">2</span><div><b>左下角齿轮</b>可以自定义这个右键菜单：添加自己的动作、改写提示词、停用不需要的。</div></div>'
      + '<div class="ng-item"><span class="ng-num">3</span><div><b>输入 / 或按 Tab</b>：斜杠插入模板，Tab 让 AI 接着写。</div></div>'
      + '<div class="ng-item"><span class="ng-num">4</span><div><b>顶栏「问笔记」</b>能基于你的全部笔记回答问题，并标出引用来源。</div></div>'
      + '<div class="ng-item"><span class="ng-num">5</span><div><b>拖入图片或文件</b>即上传；把笔记<b>拖到左侧文件夹</b>即可移动；<b>拖动侧栏右缘</b>可调宽度。</div></div>'
      + '</div>'
      + '<p class="ng-foot">这份导航随时可以在左下角齿轮里重新查看。</p>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn primary" id="ng-ok" type="button">开始使用</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelector('#ng-ok').addEventListener('click', done);
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // 处理中的浮标(右下角,不遮挡编辑)
  function showAiBusy(label) {
    const el = document.createElement('div');
    el.className = 'notes-ai-busy';
    el.innerHTML = '<span class="nab-spin"></span>AI 正在' + esc(label) + '…';
    (N.els.mask || document.body).appendChild(el);
    return el;
  }

  // 齿轮:右键菜单管理(自定义添加/删除/编辑/启停)
  function openAiSettingsMenu(anchor) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-aimgr-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-aimgr-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('gear', 15) + ' 右键菜单动作</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">这些动作会出现在正文选中文字的右键菜单里。可停用、改名、改提示词，或添加自己的动作（提示词里用 <code>{{text}}</code> 代表选中的文字）。</p>'
      + '<div class="aimgr-list" id="aimgr-list"></div>'
      + '<details class="aimgr-add"><summary>＋ 添加自定义动作</summary>'
      + '<label class="field"><span>名称（右键菜单里显示）</span><input id="aimgr-new-label" maxlength="16" placeholder="例如：改写成表格"></label>'
      + '<label class="field"><span>提示词（<code>{{text}}</code> 为选中文字，可省略）</span>'
      + '<textarea id="aimgr-new-prompt" rows="3" spellcheck="false" placeholder="请把下面这段内容改写为 Markdown 表格，列包括…"></textarea></label>'
      + '<button class="btn primary" id="aimgr-add-btn" type="button">添加</button>'
      + '</details>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" id="aimgr-guide" type="button">重新查看使用导航</button>'
      + '<button class="btn primary" data-close>完成</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const closeDlg = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = closeDlg;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDlg));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    mask.querySelector('#aimgr-guide').addEventListener('click', () => {
      closeDlg();
      try { localStorage.removeItem('oc_notes_guide_seen'); } catch (e) {}
      setTimeout(maybeShowFirstRunGuide, 380);
    });

    const renderList = () => {
      const cfg = aiConfig();
      const list = mask.querySelector('#aimgr-list');
      list.innerHTML = aiActions().map((a) => ''
        + '<div class="aimgr-item' + (a.enabled ? '' : ' off') + '" data-key="' + esc(a.key) + '">'
        + '<label class="aimgr-switch" data-tip="' + (a.enabled ? '停用' : '启用') + '">'
        + '<input type="checkbox" data-act="toggle"' + (a.enabled ? ' checked' : '') + '><span class="slider"></span></label>'
        + '<div class="aimgr-main">'
        + '<input class="aimgr-label" data-act="label" value="' + esc(a.label) + '" maxlength="16" placeholder="动作名称">'
        + '<textarea class="aimgr-prompt" data-act="prompt" rows="2" spellcheck="false" placeholder="提示词（{{text}} 代表选中文字）">' + esc(a.prompt) + '</textarea>'
        + '</div>'
        + '<div class="aimgr-ops">'
        + (a.builtin ? '' : '<button class="notes-icon-btn" data-act="del" data-tip="删除">' + icon('trash', 14) + '</button>')
        + (a.builtin ? '<span class="aimgr-tag" data-tip="内置动作，可停用与改写提示词">内置</span>' : '')
        + '</div>'
        + '</div>').join('');
      list.querySelectorAll('.aimgr-item').forEach((row) => {
        const key = row.dataset.key;
        row.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
          const c = aiConfig();
          const i = c.disabled.indexOf(key);
          if (e.target.checked) { if (i >= 0) c.disabled.splice(i, 1); }
          else if (i < 0) c.disabled.push(key);
          aiConfigSave(c);
          row.classList.toggle('off', !e.target.checked);
          row.querySelector('.aimgr-switch').dataset.tip = e.target.checked ? '停用' : '启用';
        });
        const lab = row.querySelector('[data-act="label"]');
        lab.addEventListener('change', () => {
          const c = aiConfig();
          const v = lab.value.trim() || '未命名动作';
          lab.value = v;
          if (BUILTIN_ACTIONS.some((b) => b.key === key)) {
            c.overrides[key] = Object.assign({}, c.overrides[key], { label: v });
          } else {
            const it = c.custom.find((x) => x.key === key);
            if (it) it.label = v;
          }
          aiConfigSave(c);
        });
        const pr = row.querySelector('[data-act="prompt"]');
        pr.addEventListener('change', () => {
          const c = aiConfig();
          const v = pr.value;
          if (BUILTIN_ACTIONS.some((b) => b.key === key)) {
            c.overrides[key] = Object.assign({}, c.overrides[key], { prompt: v });
          } else {
            const it = c.custom.find((x) => x.key === key);
            if (it) it.prompt = v;
          }
          aiConfigSave(c);
        });
        const del = row.querySelector('[data-act="del"]');
        if (del) del.addEventListener('click', () => {
          const c = aiConfig();
          c.custom = c.custom.filter((x) => x.key !== key);
          c.disabled = c.disabled.filter((x) => x !== key);
          aiConfigSave(c);
          renderList();
        });
      });
    };
    mask.querySelector('#aimgr-add-btn').addEventListener('click', () => {
      const label = (mask.querySelector('#aimgr-new-label').value || '').trim();
      const prompt = (mask.querySelector('#aimgr-new-prompt').value || '').trim();
      if (!label) { toast('请填写动作名称', true); return; }
      const c = aiConfig();
      c.custom.push({ key: 'c' + Date.now().toString(36), label: label, desc: '自定义动作', prompt: prompt || '{{text}}' });
      aiConfigSave(c);
      mask.querySelector('#aimgr-new-label').value = '';
      mask.querySelector('#aimgr-new-prompt').value = '';
      renderList();
      toast('已添加动作「' + label + '」');
    });
    renderList();
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  async function refreshUsage() {
    const el = N.els.usage;
    if (!el) return;
    try {
      const r = await apiFetch('/api/notes/usage');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { el.textContent = ''; return; }
      N.usage = d;
      const quota = Number(d.quota) || 0;
      const aiUsed = Number(d.aiUsedToday) || 0;
      const aiLimit = Number(d.aiDailyLimit) || 0;
      N.usageAi = { used: aiUsed, limit: aiLimit };
      if (!quota) {
        el.innerHTML = icon('upload', 12) + '<span>已用 ' + fmtBytes(d.used) + '（不限量）</span>';
      } else {
        const left = Math.max(0, quota - (Number(d.used) || 0));
        const pct = Math.min(100, Math.round(((Number(d.used) || 0) / quota) * 100));
        el.innerHTML = icon('upload', 12) + '<span>剩余 ' + fmtBytes(left) + ' / ' + fmtBytes(quota) + '</span>';
        el.title = '笔记附件空间已用 ' + fmtBytes(d.used) + '（' + pct + '%），上限 ' + fmtBytes(quota);
      }
      if (aiLimit > 0) el.title += ' · 今日 AI 已用 ' + aiUsed + '/' + aiLimit + ' 次';
    } catch (e) { el.textContent = ''; }
  }

  function syncDot(state) {
    const dot = N.els.syncDot;
    if (!dot) return;
    dot.dataset.state = state || '';
    dot.dataset.tip = state === 'err' ? '云同步失败，稍后自动重试' : (state === 'ok' ? '已同步到云端' : '云同步中');
  }

  function isNotesPath() {
    try { return location.pathname.replace(/\/+$/, '') === '/ainotes'; } catch (e) { return false; }
  }
  async function open(opts) {
    opts = opts || {};
    if (!(await ensureLoaded())) { toast('请先登录后再使用 AI 笔记', true); return; }
    if (!N.els.mask) buildShell();
    flushEditor();
    refreshUsage();
    N.ui.search = '';
    N.els.searchInput.value = '';
    renderAll();
    // 独立地址:刷新后仍停留在笔记页
    if (window.history && !isNotesPath()) {
      try { history.pushState({ notes: true }, '', '/ainotes'); } catch (e) {}
    }
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(N.els.mask);
    else N.els.mask.classList.add('show');
    if (!opts.boot) maybeShowFirstRunGuide();
    else setTimeout(maybeShowFirstRunGuide, 400);
  }
  function close() {
    closeAiCtxMenu();
    flushEditor();
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(N.els.mask);
    else N.els.mask.classList.remove('show');
    // 返回对话首页:地址同步回根路径(仅在确实处于 /ainotes 时)
    if (isNotesPath() && window.history) {
      try { history.pushState(null, '', '/'); } catch (e) {}
    }
  }

  // ============ 渲染 ============
  function renderAll() {
    renderTree();
    renderEditor();
    alignShareState();
  }

  function sortCmp(a, b) {
    if (N.ui.sort === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    if (N.ui.sort === 'title') return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }
  function folderNotes(folderId) {
    return N.doc.notes
      .filter((n) => n.folderId === folderId)
      .sort((a, b) => ((b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0)) || sortCmp(a, b));
  }

  // 左栏:文件夹(可折叠)与笔记的同一棵树。文件夹行点击=选中并展开;箭头=折叠/展开。
  function renderTree() {
    const tree = N.els.tree;
    if (!tree) return;
    tree.innerHTML = '';
    const q = N.ui.search.toLowerCase();
    if (q) {
      const matches = visibleNotes();
      const head = document.createElement('div');
      head.className = 'nt-search-head';
      head.textContent = '搜索「' + N.ui.search + '」· ' + matches.length + ' 篇';
      tree.appendChild(head);
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'nt-none';
        empty.textContent = '没有匹配的笔记';
        tree.appendChild(empty);
      }
      matches.forEach((n) => tree.appendChild(noteRow(n, true)));
      return;
    }
    tree.appendChild(folderBlock(folderById(UNCATA) || { id: UNCATA, name: UNCATA_LABEL }, 0));
    const build = (pid, depth, host) => {
      if (N.ui.expanded[pid] === false) return;
      childFolders(pid).forEach((f) => {
        if (f.id === UNCATA) return; // 默认分类已固定在顶部
        host.appendChild(folderBlock(f, depth));
        build(f.id, depth + 1, host);
      });
    };
    build(null, 0, tree);
  }

  // 一个文件夹块 = 文件夹行 + (展开时的)笔记列表与子文件夹块
  function folderBlock(f, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'nt-block';
    wrap.appendChild(folderRow(f, depth));
    if (N.ui.expanded[f.id] !== false) {
      const notes = folderNotes(f.id);
      if (notes.length) {
        const list = document.createElement('div');
        list.className = 'nt-notes';
        list.style.paddingLeft = (26 + depth * 14) + 'px';
        notes.forEach((n) => list.appendChild(noteRow(n, false)));
        wrap.appendChild(list);
      }
      childFolders(f.id).forEach((sub) => {
        if (sub.id === UNCATA) return;
        wrap.appendChild(folderBlock(sub, depth + 1));
      });
    }
    return wrap;
  }

  function folderRow(f, depth) {
    const row = document.createElement('div');
    row.className = 'notes-folder-row' + (N.ui.folderId === f.id && !N.ui.search ? ' active' : '');
    row.dataset.folderId = f.id;
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    const open = N.ui.expanded[f.id] !== false;
    const kids = childFolders(f.id);
    const notes = folderNotes(f.id);
    const expandable = kids.length > 0 || notes.length > 0;
    const chev = document.createElement('button');
    chev.className = 'notes-chev' + (expandable ? '' : ' leaf');
    chev.innerHTML = icon('chevronRight', 12);
    chev.dataset.tip = open ? '折叠' : '展开';
    if (expandable) {
      row.classList.add('has-kids');
      row.classList.toggle('open-row', open);
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        N.ui.expanded[f.id] = !open;
        persistUi();
        renderTree();
      });
    } else {
      chev.disabled = true;
    }
    const ic = document.createElement('span');
    ic.className = 'notes-folder-icon';
    ic.innerHTML = icon('folder', 15);
    const name = document.createElement('span');
    name.className = 'notes-folder-name';
    name.textContent = f.name;
    const count = document.createElement('span');
    count.className = 'notes-folder-count';
    count.textContent = notes.length || '';
    const more = document.createElement('button');
    more.className = 'notes-row-more';
    more.innerHTML = icon('more', 14);
    more.dataset.tip = '文件夹操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      folderMenu(more, f);
    });
    row.appendChild(chev); row.appendChild(ic); row.appendChild(name); row.appendChild(count); row.appendChild(more);
    row.addEventListener('click', () => {
      // 点击 = 选中该文件夹并展开其笔记列表(折叠只走左侧箭头,避免误折叠)
      N.ui.folderId = f.id;
      if (expandable) N.ui.expanded[f.id] = true;
      persistUi();
      renderTree();
    });
    // 双击直接重命名
    row.addEventListener('dblclick', () => {
      if (f.id !== UNCATA) renameFolderFlow(f);
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/oc-note-id');
      if (id) moveNote(id, f.id);
    });
    return row;
  }

  function folderMenu(more, f) {
    const items = [];
    if (f.id !== UNCATA) items.push({ value: 'sub', label: '新建子文件夹' });
    if (f.id !== UNCATA) items.push({ value: 'rename', label: '重命名' });
    if (f.id !== UNCATA) items.push({ value: 'delete', label: '删除文件夹' });
    window.OC.openSelect(more, items, {
      onSelect: async (v) => {
        if (v === 'sub') promptNewFolder(f.id);
        else if (v === 'rename') renameFolderFlow(f);
        else if (v === 'delete') {
          const cnt = folderNotes(f.id).length;
          const ok = await window.OCUI.confirm({
            title: '删除文件夹「' + f.name + '」？',
            message: cnt ? ('其中 ' + cnt + ' 篇笔记将移动到「' + UNCATA_LABEL + '」，子文件夹上提一级。') : '空文件夹将被删除。',
            danger: true, confirmText: '删除',
          });
          if (ok) deleteFolder(f.id);
        }
      },
    });
  }

  function renameFolderFlow(f) {
    notesPrompt({
      title: '重命名文件夹',
      value: f.name, maxlength: 80, confirmText: '保存',
    }).then((name) => {
      if (name && name.trim() && name.trim() !== f.name) renameFolder(f.id, name.trim());
    });
  }

  function promptNewFolder(parentId) {
    notesPrompt({
      title: parentId ? '新建子文件夹' : '新建文件夹',
      message: '名称要语义明确、可长期使用，避免「其他」「杂项」这类泛化名称。',
      value: '', maxlength: 80, confirmText: '创建',
    }).then((name) => {
      name = String(name || '').trim();
      if (!name) return;
      const f = createFolder(name, parentId);
      N.ui.expanded[parentId || 'root'] = true;
      if (parentId) N.ui.expanded[parentId] = true;
      N.ui.folderId = f.id;
      persistUi();
      renderAll();
    });
  }

  function noteRow(n, searching) {
    const item = document.createElement('div');
    item.className = 'nt-note' + (N.ui.selNoteId === n.id ? ' active' : '') + (n.isPinned ? ' pinned' : '');
    item.draggable = true;
    item.dataset.noteId = n.id;
    item.title = n.title || '无标题笔记';
    item.innerHTML =
      (n.isPinned
        ? '<span class="nt-pin">' + icon('pin', 11) + '</span>'
        : '<span class="nt-doc">' + icon('notebook', 12) + '</span>')
      + '<span class="nt-note-title">' + esc(n.title || '无标题笔记') + '</span>'
      + (searching ? '<span class="nt-folder-badge">' + icon('folder', 10) + esc(folderName(n.folderId)) + '</span>' : '')
      + '<span class="nt-time">' + esc(fmtTime(n.updatedAt)) + '</span>';
    const more = document.createElement('button');
    more.className = 'notes-row-more';
    more.innerHTML = icon('more', 13);
    more.dataset.tip = '笔记操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      noteMenu(more, n);
    });
    item.appendChild(more);
    item.addEventListener('click', () => openNote(n.id));
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/oc-note-id', n.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    return item;
  }

  function noteMenu(more, n) {
    const s = shareOf(n.id);
    const items = [
      { value: 'pin', label: n.isPinned ? '取消置顶' : '置顶' },
      { value: 'move', label: '移动到…' },
      { value: 'rename', label: '重命名' },
      { value: 'share', label: s ? '分享（已开启）' : '分享…' },
      { value: 'export', label: '导出 .md' },
      { value: 'delete', label: '删除笔记' },
    ];
    window.OC.openSelect(more, items, {
      onSelect: async (v) => {
        if (v === 'pin') togglePin(n.id);
        else if (v === 'move') pickFolder((f) => moveNote(n.id, f));
        else if (v === 'rename') {
          const t = await notesPrompt({ title: '重命名笔记', value: n.title, maxlength: 200, confirmText: '保存' });
          if (t && t.trim()) updateNote(n.id, { title: t.trim() });
        } else if (v === 'share') openShareDialog(n.id);
        else if (v === 'export') exportNote(n);
        else if (v === 'delete') {
          const ok = await window.OCUI.confirm({ title: '删除笔记「' + n.title + '」？', message: '删除后其他设备也会同步删除。', danger: true, confirmText: '删除' });
          if (ok) deleteNote(n.id);
        }
      },
    });
  }

  function visibleNotes() {
    const q = N.ui.search.toLowerCase();
    let notes = N.doc.notes.filter((n) => !(n.id in (N.doc.tombs || {})));
    if (q) {
      notes = notes.filter((n) =>
        (n.title || '').toLowerCase().includes(q)
        || (n.content || '').toLowerCase().includes(q)
        || (n.tags || []).some((t) => String(t).toLowerCase().includes(q)));
    } else {
      notes = notes.filter((n) => n.folderId === N.ui.folderId);
    }
    return notes.sort((a, b) => ((b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0)) || sortCmp(a, b));
  }

  function pickFolder(cb, excludeId) {
    if (!N.els.mask) return;
    const items = N.doc.folders
      .filter((f) => f.id !== excludeId)
      .sort((a, b) => folderDepth(a.id) - folderDepth(b.id))
      .map((f) => ({ value: f.id, label: '　'.repeat(folderDepth(f.id)) + f.name }));
    // 锚到编辑区(页面居中偏右),避免出现在左下角看不见
    const anchor = N.els.editorPane && N.els.editorPane.offsetWidth
      ? N.els.editorPane
      : N.els.mask;
    window.OC.openSelect(anchor, items, { searchable: true, searchPlaceholder: '搜索文件夹…', center: true, onSelect: cb });
  }

  function exportNote(n) {
    const blob = new Blob([n.content || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (n.title || '笔记').replace(/[\\/:*?"<>|]/g, '_') + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  // ============ 编辑器 ============
  function openNote(id) {
    flushEditor();
    const n = noteById(id);
    // 选中笔记时,所属文件夹同步选中并展开(两者高亮保持一致)
    if (n) {
      N.ui.folderId = n.folderId;
      N.ui.expanded[n.folderId] = true;
    }
    N.ui.selNoteId = id;
    persistUi();
    renderTree();
    renderEditor();
  }

  function renderEditor() {
    const pane = N.els.editorPane;
    const bar = N.els.bar;
    const head = N.els.head;
    if (!pane || !bar || !head) return;
    const n = N.ui.selNoteId ? noteById(N.ui.selNoteId) : null;
    if (!n) {
      N.editor = null;
      bar.classList.add('hidden');
      head.classList.remove('has-editor');
      pane.innerHTML = '<div class="notes-editor-empty">'
        + icon('notebook', 34)
        + '<h3>选择或新建一篇笔记</h3>'
        + usageGuideHtml()
        + '<button class="notes-new-btn" id="notes-empty-new">' + icon('plus', 13) + '新建笔记</button>'
        + '</div>';
      const btn = pane.querySelector('#notes-empty-new');
      if (btn) btn.addEventListener('click', () => openNewNoteDialog(btn));
      return;
    }
    const mode = N.ui.mode;
    bar.classList.remove('hidden');
    head.classList.add('has-editor');
    // 顶栏右上角:标题 / 标签 / 分类 / 时间 / 模式 / 工具
    bar.querySelector('#ne-title').value = n.title || '';
    bar.querySelector('#ne-folder-name').textContent = folderName(n.folderId);
    bar.querySelector('#ne-time').textContent = '更新于 ' + fmtTime(n.updatedAt);
    bar.querySelector('#ne-time').dataset.tip = '创建于 ' + fmtFull(n.createdAt);
    bar.querySelectorAll('#ne-mode-switch button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
    pane.innerHTML =
      '<div class="notes-editor">'
      + '<div class="notes-editor-panes mode-' + mode + '">'
      + '<textarea class="notes-ta" id="ne-ta" spellcheck="false" placeholder="用 Markdown 书写…粘贴图片或拖入文件可直接上传。"></textarea>'
      + '<div class="notes-preview-wrap"><div class="notes-preview msg assistant"><div class="msg-content" id="ne-preview"></div></div></div>'
      + '</div>'
      + '</div>';
    const ta = pane.querySelector('#ne-ta');
    const preview = pane.querySelector('#ne-preview');
    ta.value = n.content || '';
    N.editor = { noteId: n.id, ta, preview, dirty: false, saveTimer: null, renderTimer: null };
    renderPreview(n.content || '');
    resetHistory(n.id);
    bar.querySelector('#ne-ai').addEventListener('click', (e) => openDocAiMenu(e.currentTarget));
    bar.querySelector('#ne-ask').addEventListener('click', openAskNotes);
    bar.querySelector('#ne-undo').addEventListener('click', undo);
    bar.querySelector('#ne-redo').addEventListener('click', redo);
    bar.querySelector('#ne-tags-btn').addEventListener('click', () => {
      const cur = noteById(n.id);
      if (cur) openTagsDialog(cur);
    });

    bar.querySelector('#ne-mode-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      N.ui.mode = b.dataset.mode;
      persistUi();
      const panes = pane.querySelector('.notes-editor-panes');
      ['edit', 'split', 'preview'].forEach((m) => panes.classList.toggle('mode-' + m, m === N.ui.mode));
      bar.querySelectorAll('#ne-mode-switch button').forEach((x) => x.classList.toggle('active', x.dataset.mode === N.ui.mode));
      if (N.ui.mode !== 'edit') renderPreview(ta.value);
    });
    bar.querySelector('#ne-folder').addEventListener('click', () => pickFolder((f) => moveNote(n.id, f), n.folderId));
    bar.querySelector('[data-act="share"]').addEventListener('click', () => openShareDialog(n.id));
    bar.querySelector('[data-act="export"]').addEventListener('click', () => exportNote(noteById(n.id) || n));
    bar.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const cur = noteById(n.id);
      const ok = await window.OCUI.confirm({ title: '删除笔记「' + (cur ? cur.title : '') + '」？', message: '删除后其他设备也会同步删除。', danger: true, confirmText: '删除' });
      if (ok) deleteNote(n.id);
    });
    bar.querySelector('[data-act="image"]').addEventListener('click', () => pickFiles(true));
    bar.querySelector('[data-act="attach"]').addEventListener('click', () => pickFiles(false));

    ta.addEventListener('input', () => {
      N.editor.dirty = true;
      pushHistory();
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 900);
      clearTimeout(N.editor.renderTimer);
      N.editor.renderTimer = setTimeout(() => renderPreview(ta.value), 450);
    });
    ta.addEventListener('keydown', (e) => {
      // 撤销 / 重做:自建历史栈(原生 undo 在重渲染后会失效)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveEditor();
        toast('已保存');
      }
      // Tab:行尾/空选区 → 让 AI 续写;行内缩进场景仍做缩进
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const sPos = ta.selectionStart, ePos = ta.selectionEnd;
        const lineStart = ta.value.lastIndexOf('\n', sPos - 1) + 1;
        const lineEnd = ta.value.indexOf('\n', sPos);
        const atLineEnd = (lineEnd < 0 || ePos >= lineEnd);
        const atEmptyLine = ta.value.slice(lineStart, lineEnd < 0 ? ta.value.length : lineEnd).trim() === '';
        if (atLineEnd || atEmptyLine) { continueWriting(); return; }
        ta.value = ta.value.slice(0, sPos) + '  ' + ta.value.slice(ePos);
        ta.selectionStart = ta.selectionEnd = sPos + 2;
        ta.dispatchEvent(new Event('input'));
      }
    });
    // 选区右键 → AI 编辑菜单(编辑区与预览区都支持)
    const ctxTargets = [ta, pane.querySelector('.notes-preview-wrap')];
    ctxTargets.forEach((zone) => {
      zone.addEventListener('contextmenu', (e) => {
        const sel = window.getSelection ? String(window.getSelection().toString() || '') : '';
        let picked = sel.trim();
        let from = null, to = null;
        if (zone === ta) {
          // 编辑区优先用 textarea 自身的选区
          from = ta.selectionStart; to = ta.selectionEnd;
          if (from !== to) picked = ta.value.slice(from, to).trim();
        }
        if (!picked) return; // 未选中文字时保留系统菜单
        e.preventDefault();
        const src = zone === ta ? ta.value.slice(from, to) : picked;
        openAiCtxMenu(e.clientX, e.clientY, src, zone === ta ? to : null, null);
      });
    });
    // 点空白 / 滚动时收起右键菜单(document 级监听在 buildShell 里只挂一次)
    pane.addEventListener('scroll', closeAiCtxMenu, true);

    // 粘贴 / 拖拽上传(编辑区 + 预览区都接)
    [ta, pane.querySelector('.notes-preview-wrap')].forEach((zone) => {
      zone.addEventListener('paste', (e) => {
        const files = clipboardFiles(e);
        if (files.length) { e.preventDefault(); uploadFiles(files); }
      });
    });
    const panesEl = pane.querySelector('.notes-editor-panes');
    panesEl.addEventListener('dragover', (e) => { e.preventDefault(); panesEl.classList.add('drag-over'); });
    panesEl.addEventListener('dragleave', (e) => { if (!panesEl.contains(e.relatedTarget)) panesEl.classList.remove('drag-over'); });
    panesEl.addEventListener('drop', (e) => {
      e.preventDefault();
      panesEl.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) uploadFiles(files);
    });
    if (N.ui.mode !== 'edit') setTimeout(() => { ta.blur(); }, 0);
  }

  function clipboardFiles(e) {
    const out = [];
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }

  function setSaveState(state) {
    const el = N.els.bar && N.els.bar.querySelector('#ne-save-state');
    if (!el) return;
    el.dataset.state = state;
    if (state === 'editing') el.textContent = '正在编辑…';
    else if (state === 'saving') el.textContent = '保存中…';
    else if (state === 'syncing') el.textContent = '已保存，同步中…';
    else el.textContent = '已保存 ' + fmtClock(Date.now());
  }

  function saveEditor() {
    if (!N.editor || !N.editor.dirty) return;
    const n = noteById(N.editor.noteId);
    if (!n) return;
    setSaveState('saving');
    const ta = N.editor.ta;
    const titleInput = N.els.bar.querySelector('#ne-title');
    n.content = ta.value;
    if (titleInput && titleInput.value.trim()) n.title = titleInput.value.trim();
    n.updatedAt = Date.now();
    N.editor.dirty = false;
    persistLocal();
    schedulePush();
    setSaveState('syncing');
    // 树行时间与头部「更新于」同步刷新(不整体重绘,避免打断输入)
    const timeEl = N.els.bar.querySelector('#ne-time');
    if (timeEl) timeEl.textContent = '更新于 ' + fmtTime(n.updatedAt);
    const row = N.els.tree && N.els.tree.querySelector('.nt-note[data-note-id="' + n.id + '"] .nt-time');
    if (row) row.textContent = fmtTime(n.updatedAt);
    const titleRow = N.els.tree && N.els.tree.querySelector('.nt-note[data-note-id="' + n.id + '"] .nt-note-title');
    if (titleRow) titleRow.textContent = n.title;
  }
  function flushEditor() {
    if (N.editor && N.editor.dirty) saveEditor();
  }

  // ============ 撤销 / 重做 ============
  // 自建历史栈(不依赖浏览器原生 undo:重渲染后原生栈会丢失)。
  // 快照 = {content, title};连续输入按时间窗合并成一步,上限 120 步。
  const HISTORY_LIMIT = 120;
  const HISTORY_MERGE_MS = 700;
  let hist = { noteId: '', stack: [], index: -1, lastAt: 0 };

  function editorSnapshot() {
    if (!N.editor) return null;
    const ti = N.els.bar && N.els.bar.querySelector('#ne-title');
    return { content: N.editor.ta ? N.editor.ta.value : '', title: ti ? ti.value : '' };
  }
  function sameSnapshot(a, b) {
    return !!a && !!b && a.content === b.content && a.title === b.title;
  }
  function resetHistory(noteId) {
    hist = { noteId: noteId || '', stack: [], index: -1, lastAt: 0 };
    const snap = editorSnapshot();
    if (snap) { hist.stack = [snap]; hist.index = 0; }
    syncUndoButtons();
  }
  function pushHistory(opts) {
    opts = opts || {};
    if (!N.editor) return;
    const snap = editorSnapshot();
    if (!snap) return;
    if (hist.noteId !== N.editor.noteId) { resetHistory(N.editor.noteId); return; }
    const cur = hist.stack[hist.index];
    if (sameSnapshot(cur, snap)) return;
    const now = Date.now();
    const mergeable = !opts.force && (now - hist.lastAt) < HISTORY_MERGE_MS && hist.index === hist.stack.length - 1;
    if (mergeable && hist.index > 0) {
      // 连续输入:覆盖栈顶,而不是每敲一个字就记一步
      hist.stack[hist.index] = snap;
    } else {
      hist.stack = hist.stack.slice(0, hist.index + 1);
      hist.stack.push(snap);
      if (hist.stack.length > HISTORY_LIMIT) hist.stack.shift();
      hist.index = hist.stack.length - 1;
    }
    hist.lastAt = now;
    syncUndoButtons();
  }
  function applySnapshot(snap) {
    if (!snap || !N.editor) return;
    const ta = N.editor.ta;
    const ti = N.els.bar && N.els.bar.querySelector('#ne-title');
    if (ta && ta.value !== snap.content) ta.value = snap.content;
    if (ti && ti.value !== snap.title) ti.value = snap.title;
    N.editor.dirty = true;
    setSaveState('editing');
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 700);
    renderPreview(ta ? ta.value : '');
  }
  function undo() {
    if (!N.editor) return;
    // 先把「尚未入栈的当前输入」记进去,保证第一次 Ctrl+Z 能回到编辑前一刻
    pushHistory();
    if (hist.index <= 0) { toast('已经是最早一步'); return; }
    hist.index--;
    hist.lastAt = 0;
    applySnapshot(hist.stack[hist.index]);
    syncUndoButtons();
  }
  function redo() {
    if (!N.editor) return;
    if (hist.index >= hist.stack.length - 1) { toast('已经是最新一步'); return; }
    hist.index++;
    hist.lastAt = 0;
    applySnapshot(hist.stack[hist.index]);
    syncUndoButtons();
  }
  function syncUndoButtons() {
    const bar = N.els.bar;
    if (!bar) return;
    const u = bar.querySelector('#ne-undo');
    const r = bar.querySelector('#ne-redo');
    if (u) u.disabled = !N.editor || hist.index <= 0;
    if (r) r.disabled = !N.editor || hist.index >= hist.stack.length - 1;
  }

  function renderPreview(md) {
    const preview = N.editor && N.editor.preview;
    if (!preview) return;
    // 附件走签名 URL 且需身份鉴权:属主本人由浏览器携带登录态即可取用
    if (window.OCRenderer && window.OCRenderer.renderInto) {
      window.OCRenderer.renderInto(preview, md);
    } else {
      preview.textContent = md;
    }
  }

  // 标题输入单独挂(input 委托,编辑器重建间不丢)
  document.addEventListener('input', (e) => {
    if (!N.editor || !N.els.editorPane) return;
    if (e.target && e.target.id === 'ne-title') {
      N.editor.dirty = true;
      pushHistory();
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 900);
    }
  });

  // ============ 新建笔记 / 模板 ============
  const TEMPLATES = [
    { key: 'blank', name: '空白笔记', desc: '从零开始书写', body: '' },
    {
      key: 'meeting', name: '会议纪要', desc: '议题 / 结论 / 待办',
      body: '## 会议信息\n\n- **时间**：\n- **参与人**：\n- **记录人**：\n\n## 议题与讨论\n\n1. \n\n## 结论\n\n- \n\n## 待办事项\n\n- [ ] 事项（负责人，截止时间）\n',
    },
    {
      key: 'study', name: '学习笔记', desc: '概念 / 要点 / 示例',
      body: '## 概念\n\n一句话说清它是什么。\n\n## 要点\n\n- \n\n## 示例\n\n```text\n\n```\n\n## 注意事项与疑问\n\n- \n',
    },
    {
      key: 'project', name: '项目记录', desc: '背景 / 进展 / 风险',
      body: '## 背景\n\n## 目标\n\n## 进展\n\n- [ ] \n\n## 风险与备注\n\n- \n',
    },
  ];

  function templateBody(key) {
    const t = TEMPLATES.find((x) => x.key === key);
    return t ? t.body : '';
  }

  function openNewNoteDialog(anchor) {
    const folderId = N.ui.folderId;
    const items = TEMPLATES.map((t) => ({ value: t.key, label: t.name + ' · ' + t.desc }));
    window.OC.openSelect(anchor || N.els.mask, items, {
      fitWidth: true,
      onSelect: async (key) => {
        const t = TEMPLATES.find((x) => x.key === key);
        const title = await notesPrompt({
          title: '新建' + (t ? t.name : '笔记'),
          message: '标题要可检索;标签用逗号分隔。创建/更新时间在编辑器右上角展示。',
          value: '', maxlength: 200, confirmText: '创建',
        });
        if (title === null) return;
        const name = String(title || '').trim() || (t ? t.name : '无标题笔记');
        const tags = name.match(/#(\S+)/g) ? [] : [];
        const content = t && t.body ? t.body : '';
        const n = createNote(folderId, { title: name, content, tags });
        N.ui.expanded[folderId] = true;
        persistUi();
        openNote(n.id);
        toast('已创建「' + n.title + '」');
      },
    });
  }

  // ============ 上传 ============
  let fileInput = null;
  function pickFiles(imageOnly) {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
        if (files.length) uploadFiles(files);
      });
    }
    fileInput.accept = imageOnly ? 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' : '';
    fileInput.click();
  }

  function extOf(name) { const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
  function validateFile(f) {
    const ext = extOf(f.name);
    const maxFileMb = (N.usage && Number(N.usage.maxFileMb)) || 50;
    if (IMAGE_EXT.indexOf(ext) >= 0) {
      if (f.size > 10 * 1048576) return '图片不能超过 10MB';
      return '';
    }
    if (N.usage && N.usage.allowFiles === false) return '本站仅允许上传图片附件';
    // 通用文件:仅要求有扩展名(服务端按类型给出 MIME,非图片强制下载)
    if (!ext) return '文件缺少扩展名，无法识别类型';
    if (f.size > maxFileMb * 1048576) return '附件不能超过 ' + maxFileMb + 'MB';
    return '';
  }

  function uploadFiles(files) {
    if (!N.editor || !noteById(N.editor.noteId)) { toast('先选择一篇笔记再上传', true); return; }
    files.forEach((f) => {
      const err = validateFile(f);
      if (err) { toast(f.name + '：' + err, true); return; }
      uploadOne(f);
    });
  }

  function uploadChip(file) {
    const bar = N.els.uploadBar;
    bar.classList.remove('hidden');
    const chip = document.createElement('div');
    chip.className = 'notes-upload-chip uploading';
    chip.innerHTML =
      '<span class="uc-icon">' + icon('upload', 14) + '</span>'
      + '<span class="uc-name" title="' + esc(file.name) + '">' + esc(file.name) + '</span>'
      + '<span class="uc-bar"><i style="width:0%"></i></span>'
      + '<span class="uc-pct">0%</span>'
      + '<button class="uc-act" data-a="cancel" data-tip="取消">' + icon('close', 13) + '</button>';
    bar.appendChild(chip);
    const remove = () => { chip.remove(); if (!bar.children.length) bar.classList.add('hidden'); };
    chip.querySelector('[data-a="cancel"]').addEventListener('click', remove);
    return {
      progress(pct) {
        chip.querySelector('.uc-bar i').style.width = pct + '%';
        chip.querySelector('.uc-pct').textContent = Math.round(pct) + '%';
      },
      done() { chip.classList.remove('uploading'); chip.classList.add('done'); chip.querySelector('.uc-pct').textContent = '完成'; setTimeout(remove, 1400); },
      fail(retry) {
        chip.classList.remove('uploading');
        chip.classList.add('failed');
        chip.querySelector('.uc-pct').textContent = '失败';
        const act = chip.querySelector('.uc-act');
        act.dataset.a = 'retry';
        act.dataset.tip = '重试';
        act.innerHTML = icon('refresh', 13);
        act.onclick = () => { remove(); retry(); };
      },
      remove,
    };
  }

  function uploadOne(file, attempt) {
    const noteId = N.editor && N.editor.noteId;
    const chip = uploadChip(file);
    const doUpload = () => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      // 绑定归属笔记:附件鉴权与「通过分享下载」据此判定
      if (noteId) fd.append('noteId', noteId);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrlOf('/api/notes/upload'));
      xhr.setRequestHeader('Authorization', 'Bearer ' + bearerToken());
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) chip.progress((e.loaded / e.total) * 100);
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          chip.done();
          insertAttachment(noteId, file.name, data);
          refreshUsage();
        } else {
          chip.fail(() => uploadOne(file));
          toast((data && data.error && data.error.message) || ('上传失败（HTTP ' + xhr.status + '）'), true);
        }
      });
      xhr.addEventListener('error', () => { chip.fail(() => uploadOne(file)); });
      xhr.addEventListener('abort', () => chip.remove());
      xhr.send(fd);
    };
    if (attempt === 'retry') doUpload();
    else doUpload();
  }

  function insertAttachment(noteId, name, data) {
    const n = noteById(noteId);
    if (!n || !N.editor) return;
    const isImage = data.mimeType && data.mimeType.indexOf('image/') === 0;
    const snippet = isImage ? ('\n\n![' + name.replace(/[\[\]]/g, '') + '](' + data.url + ')\n\n')
      : ('\n\n[📎 ' + name.replace(/[\[\]]/g, '') + '](' + data.url + ')\n\n');
    const ta = N.editor.ta;
    const pos = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    ta.value = ta.value.slice(0, pos) + snippet.replace(/^\n+/, '\n\n') + ta.value.slice(ta.selectionEnd || pos);
    const att = {
      id: data.id || uid('a'), name: name, url: data.url,
      mimeType: data.mimeType || '', size: Number(data.size) || 0,
      createdAt: Number(data.createdAt) || Date.now(),
    };
    n.attachments = (n.attachments || []).concat([att]);
    N.editor.dirty = true;
    setSaveState('editing');
    saveEditor();
    renderPreview(ta.value);
  }

  // ============ 分享 ============
  function openShareDialog(noteId) {
    const n = noteById(noteId);
    if (!n) return;
    const s = shareOf(noteId);
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-share-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-share-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>分享「' + esc(n.title) + '」</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<div class="ns-modes">'
      + '<label class="ns-mode"><input type="radio" name="ns-mode" value="private" ' + (!s ? 'checked' : '') + '><div><b>仅自己可见</b><span>不生成任何链接</span></div></label>'
      + '<label class="ns-mode"><input type="radio" name="ns-mode" value="view-link" ' + (s && s.mode === 'view-link' ? 'checked' : '') + '><div><b>持链接可查看</b><span>任何人拿到链接都能阅读这篇笔记</span></div></label>'
      + '<label class="ns-mode"><input type="radio" name="ns-mode" value="edit-link" ' + (s && s.mode === 'edit-link' ? 'checked' : '') + '><div><b>持链接可编辑</b><span>拿到链接的人可以直接修改笔记内容</span></div></label>'
      + '</div>'
      + '<div class="ns-link-row' + (s ? '' : ' hidden') + '" id="ns-link-row">'
      + '<input readonly id="ns-link" value="' + esc(s ? location.origin + '/n/' + s.token : '') + '">'
      + '<button class="notes-mini-btn" id="ns-copy">' + icon('copy', 13) + '复制</button>'
      + '</div>'
      + '<p class="ns-hint" id="ns-hint">' + (s ? '链接实时显示笔记最新内容;重新生成会使旧链接立即失效。' : '开启后可随时关闭或重新生成链接。') + '</p>'
      + '</div>'
      + '<div class="modal-footer">'
      + (s ? '<button class="btn danger" id="ns-close-share">关闭分享</button>' : '')
      + '<button class="btn' + (s ? '' : ' hidden') + '" id="ns-regen">重新生成链接</button>'
      + '<button class="btn primary" id="ns-apply">' + (s ? '保存设置' : '生成链接') + '</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    const closeDlg = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask.querySelector('[data-close]').addEventListener('click', closeDlg);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    const linkRow = mask.querySelector('#ns-link-row');
    const regenBtn = mask.querySelector('#ns-regen');
    const applyBtn = mask.querySelector('#ns-apply');
    const hint = mask.querySelector('#ns-hint');
    const currentMode = () => (mask.querySelector('input[name="ns-mode"]:checked') || {}).value || 'private';

    mask.querySelector('#ns-copy').addEventListener('click', async () => {
      const v = mask.querySelector('#ns-link').value;
      let ok = false;
      if (window.OCUI && window.OCUI.copyText) ok = await window.OCUI.copyText(v);
      else { try { await navigator.clipboard.writeText(v); ok = true; } catch (e) {} }
      toast(ok ? '链接已复制' : '复制失败,请手动选择复制', !ok);
    });

    const showShare = (share) => {
      linkRow.classList.remove('hidden');
      regenBtn.classList.remove('hidden');
      mask.querySelector('#ns-link').value = location.origin + '/n/' + share.token;
      hint.textContent = '链接实时显示笔记最新内容;重新生成会使旧链接立即失效。';
    };

    applyBtn.addEventListener('click', async () => {
      const mode = currentMode();
      applyBtn.disabled = true;
      try {
        if (mode === 'private') {
          if (!s) { toast('已保持仅自己可见'); closeDlg(); return; }
          const r = await apiFetch('/api/notes/share', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }) });
          if (!r.ok) throw new Error('关闭分享失败');
          N.shares = N.shares.filter((x) => x.noteId !== noteId);
          alignShareState();
          persistLocal();
          toast('分享已关闭,旧链接全部失效');
          closeDlg();
        } else {
          const r = await apiFetch('/api/notes/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId, mode }) });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((data.error && data.error.message) || '生成分享链接失败');
          const share = data.share;
          N.shares = N.shares.filter((x) => x.noteId !== noteId).concat([share]);
          alignShareState();
          persistLocal();
          showShare(share);
          applyBtn.textContent = '保存设置';
          toast('分享已开启');
        }
      } catch (e) {
        toast(e.message || '操作失败', true);
      } finally {
        applyBtn.disabled = false;
        renderTree();
      }
    });
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      try {
        const mode = currentMode() === 'private' ? 'view-link' : currentMode();
        const r = await apiFetch('/api/notes/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId, mode }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data.error && data.error.message) || '重新生成失败');
        const share = data.share;
        N.shares = N.shares.filter((x) => x.noteId !== noteId).concat([share]);
        alignShareState();
        persistLocal();
        showShare(share);
        toast('已重新生成,旧链接已失效');
      } catch (e) {
        toast(e.message || '操作失败', true);
      } finally {
        regenBtn.disabled = false;
      }
    });
    const closeShareBtn = mask.querySelector('#ns-close-share');
    if (closeShareBtn) {
      closeShareBtn.addEventListener('click', async () => {
        closeShareBtn.disabled = true;
        try {
          const r = await apiFetch('/api/notes/share', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }) });
          if (!r.ok) throw new Error('关闭分享失败');
          N.shares = N.shares.filter((x) => x.noteId !== noteId);
          alignShareState();
          persistLocal();
          toast('分享已关闭');
          closeDlg();
        } catch (e) {
          toast(e.message || '操作失败', true);
        } finally { closeShareBtn.disabled = false; renderTree(); }
      });
    }
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    renderTree();
  }

  // ============ AI 归档:保存到 AI 笔记 ============
  const ARCHIVE_SYSTEM_PROMPT = [
    '你是 AI 笔记整理助手。请根据当前用户问题、AI 回答内容和已有笔记目录，',
    '将有长期价值的信息整理为一篇可检索、可复用的 Markdown 笔记。',
    '',
    '要求：',
    '1. 优先选择语义最匹配的已有文件夹。',
    '2. 只有当现有文件夹均不合适时，才创建新文件夹。',
    '3. 新文件夹名称必须简洁、明确、可长期使用，避免「其他」「杂项」「临时」等名称。',
    '4. 新建笔记标题应准确概括核心内容，不得使用「AI 回答」「新笔记」等无意义标题。',
    '5. 不要机械复制原回答；应提炼、分层、结构化，并保留关键细节、限制条件和行动项。',
    '6. 不编造原回答中不存在的事实、数据、来源或结论。',
    '7. 保留必要的代码、公式、表格和链接，并使用标准 Markdown。',
    '8. 在文末添加「来源」区块，记录原始问题、生成时间和对话引用信息。',
    '9. 输出 JSON，字段包括：',
    '   - folderAction: "existing" 或 "create"',
    '   - targetFolderId: 已有文件夹时填写 ID',
    '   - newFolderName: 新建文件夹时填写名称',
    '   - noteTitle',
    '   - tags',
    '   - markdownContent',
    '   - reasoning: 简要说明归档原因',
    '',
    '只输出 JSON,不要输出任何其他文字或代码块围栏。',
  ].join('\n');

  function findUserQuestion(chat, msg) {
    const msgs = (chat && chat.messages) || [];
    let idx = msgs.indexOf(msg);
    if (idx < 0) idx = msgs.length;
    for (let i = idx - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user') {
        let t = String(m.text || m.content || '').trim();
        // 去掉附件卡片的 markdown 块,只留提问正文
        t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[📎[^\]]*\]\([^)]*\)/g, '');
        return t.replace(/\s+/g, ' ').trim().slice(0, 400);
      }
    }
    return '';
  }

  function folderTreePromptLines() {
    const lines = [];
    N.doc.folders.forEach((f) => {
      const depth = folderDepth(f.id);
      const titles = N.doc.notes.filter((n) => n.folderId === f.id).slice(0, 8).map((n) => n.title);
      lines.push('- ' + '  '.repeat(depth) + f.name + '（id: ' + f.id + (f.description ? ', 说明: ' + f.description : '') + '）'
        + (titles.length ? ' 已有笔记: ' + titles.join('、') : '（空）'));
    });
    return lines;
  }

  async function archiveFromMessage(chat, msg) {
    if (!(await ensureLoaded())) { toast('请先登录后再使用 AI 笔记', true); return; }
    const question = findUserQuestion(chat, msg);
    const answer = String(msg.content || '');
    const dlg = buildArchiveDialog();
    showArchiveLoading(dlg);
    const context = [
      '## 当前对话主题',
      (chat && chat.title) || '（无标题对话）',
      '',
      '## 用户问题',
      question || '（未找到原始问题）',
      '',
      '## AI 回答全文',
      answer.slice(0, 24000),
      '',
      '## 现有笔记文件夹树（含层级与已有笔记标题摘要）',
      folderTreePromptLines().join('\n') || '（还没有任何文件夹,只有默认的「默认分类」）',
      '',
      '## 用户指定文件夹',
      '无',
      '',
      '请按系统要求输出 JSON。',
    ].join('\n');

    let plan = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      try {
        const text = await window.OCApp.aiComplete(
          [{ role: 'system', content: ARCHIVE_SYSTEM_PROMPT }, { role: 'user', content: context }],
          { purpose: 'note', maxTokens: 8192 }
        );
        plan = parseArchivePlan(text);
        if (!plan) lastErr = new Error('AI 返回的内容无法解析为结构化结果');
      } catch (e) {
        lastErr = e;
      }
    }
    if (!plan) {
      showArchiveError(dlg, (lastErr && lastErr.message) || '整理失败', () => {
        return {
          folderAction: 'create', newFolderName: UNCATA_LABEL, noteTitle: (question || '笔记').slice(0, 60),
          tags: [], markdownContent: answer, reasoning: 'AI 整理失败,直接保存原文。',
          _forceFolder: UNCATA,
        };
      }, question, answer, () => archiveFromMessage(chat, msg));
      return;
    }
    showArchivePlan(dlg, plan, { chat, msg, question, answer });
  }

  function parseArchivePlan(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    let j = null;
    try { j = JSON.parse(t.slice(s, e + 1)); } catch (e2) { return null; }
    if (!j || typeof j !== 'object') return null;
    const content = String(j.markdownContent || j.content || '').trim();
    const title = String(j.noteTitle || j.title || '').trim();
    if (!content) return null;
    return {
      folderAction: j.folderAction === 'create' ? 'create' : 'existing',
      targetFolderId: String(j.targetFolderId || ''),
      newFolderName: String(j.newFolderName || '').trim().slice(0, 80),
      noteTitle: (title || '无标题笔记').slice(0, 200),
      tags: Array.isArray(j.tags) ? j.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [],
      markdownContent: content,
      reasoning: String(j.reasoning || '').trim(),
    };
  }

  function buildArchiveDialog() {
    const old = document.getElementById('notes-ai-mask');
    if (old) old.remove();
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-ai-mask hidden';
    mask.id = 'notes-ai-mask';
    mask.innerHTML =
      '<div class="modal notes-ai-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('noteSave', 16) + ' AI 整理预览</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body" id="nai-body"></div>'
      + '<div class="modal-footer" id="nai-foot"></div>'
      + '</div>';
    document.body.appendChild(mask);
    mask.querySelector('[data-close]').addEventListener('click', () => {
      window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 340);
    });
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.querySelector('[data-close]').click(); });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    return mask;
  }

  function closeArchiveDialog(mask) {
    window.OCUI.closeModal(mask);
    setTimeout(() => mask.remove(), 340);
  }

  function showArchiveLoading(mask) {
    mask.querySelector('#nai-body').innerHTML =
      '<div class="nai-loading"><span class="nai-spinner"></span>'
      + '<p>AI 正在整理回答并选择归档位置…</p>'
      + '<p class="muted">它会根据现有笔记目录判断最合适的文件夹,并生成结构化笔记。</p></div>';
    mask.querySelector('#nai-foot').innerHTML = '';
  }

  function showArchiveError(mask, message, fallbackPlanFn, question, answer, retryFn) {
    const body = mask.querySelector('#nai-body');
    const foot = mask.querySelector('#nai-foot');
    body.innerHTML =
      '<div class="nai-error"><p>' + esc(message) + '</p>'
      + '<p class="muted">可以让 AI 重试,也可以把原始回答不做加工直接存入「默认分类」。</p></div>';
    foot.innerHTML =
      '<button class="btn" id="nai-cancel">取消</button>'
      + '<button class="btn" id="nai-raw">直接保存原文</button>'
      + '<button class="btn primary" id="nai-retry">重试 AI 整理</button>';
    foot.querySelector('#nai-cancel').addEventListener('click', () => closeArchiveDialog(mask));
    foot.querySelector('#nai-raw').addEventListener('click', () => {
      const plan = fallbackPlanFn();
      plan._direct = true;
      showArchivePlan(mask, plan, { chat: null, msg: null, question, answer });
    });
    foot.querySelector('#nai-retry').addEventListener('click', () => {
      closeArchiveDialog(mask);
      if (typeof retryFn === 'function') retryFn();
    });
  }

  function showArchivePlan(mask, plan, ctx) {
    const body = mask.querySelector('#nai-body');
    const foot = mask.querySelector('#nai-foot');
    // 文件夹选项:existing 计划若指向不存在的 id,自动降级为「新建」
    let folderId = plan.targetFolderId;
    if (plan.folderAction === 'existing' && !folderById(folderId)) {
      plan.folderAction = 'create';
      folderId = '';
    }
    const recommendedName = plan.folderAction === 'create'
      ? (plan.newFolderName || (plan._forceFolder ? UNCATA_LABEL : ''))
      : folderName(folderId);
    const direct = !!plan._direct;
    body.innerHTML =
      '<div class="nai-reason">' + icon('spark', 13) + ' ' + esc(plan.reasoning || '已根据内容主题选择归档位置。') + '</div>'
      + '<div class="nai-grid">'
      + '<label class="nai-field"><span>归档文件夹</span>'
      + '<div class="nai-folder-row">'
      + '<select id="nai-folder"></select>'
      + '<input id="nai-newfolder" class="hidden" placeholder="新文件夹名称（如：前端开发）" maxlength="80">'
      + '</div></label>'
      + '<label class="nai-field"><span>笔记标题</span><input id="nai-title" value="' + esc(plan.noteTitle) + '" maxlength="200" ' + (direct ? 'readonly' : '') + '></label>'
      + '<label class="nai-field"><span>标签（逗号分隔）</span><input id="nai-tags" value="' + esc(plan.tags.join(', ')) + '" ' + (direct ? 'readonly' : '') + '></label>'
      + '</div>'
      + '<div class="nai-content-head">'
      + '<span>笔记内容</span>'
      + '<button class="notes-mini-btn" id="nai-toggle">' + icon('eye', 13) + '查看 Markdown 源码</button>'
      + '</div>'
      + '<div class="nai-content">'
      + '<div class="nai-preview msg assistant"><div class="msg-content" id="nai-preview"></div></div>'
      + '<textarea id="nai-ta" class="hidden" spellcheck="false"></textarea>'
      + '</div>'
      + (direct ? '' : '<p class="nai-tip">文末会自动追加「来源」区块（原始问题、整理时间与对话引用），保存后可随时编辑。</p>');

    const sel = body.querySelector('#nai-folder');
    const newInput = body.querySelector('#nai-newfolder');
    const ta = body.querySelector('#nai-ta');
    const previewBox = body.querySelector('#nai-preview');
    const fillFolderOptions = (selectedId) => {
      const opts = [];
      N.doc.folders.slice().sort((a, b) => folderDepth(a.id) - folderDepth(b.id)).forEach((f) => {
        opts.push('<option value="' + esc(f.id) + '">' + '　'.repeat(folderDepth(f.id)) + esc(f.name) + '</option>');
      });
      opts.push('<option value="__create__">➕ 新建文件夹…</option>');
      sel.innerHTML = opts.join('');
      sel.value = selectedId || (plan._forceFolder || '');
      if (!sel.value) sel.value = UNCATA;
    };
    fillFolderOptions(plan.folderAction === 'existing' ? folderId : (plan._forceFolder || '__create__'));
    if (plan.folderAction === 'create' && !plan._forceFolder) {
      sel.value = '__create__';
      newInput.classList.remove('hidden');
      newInput.value = recommendedName || '';
    }
    ta.value = plan.markdownContent;
    if (window.OCRenderer) window.OCRenderer.renderInto(previewBox, plan.markdownContent);
    else previewBox.textContent = plan.markdownContent;

    sel.addEventListener('change', () => {
      if (sel.value === '__create__') newInput.classList.remove('hidden');
      else newInput.classList.add('hidden');
    });
    body.querySelector('#nai-toggle').addEventListener('click', () => {
      const editing = !ta.classList.contains('hidden');
      if (editing) {
        ta.classList.add('hidden');
        if (window.OCRenderer) window.OCRenderer.renderInto(previewBox, ta.value);
        body.querySelector('#nai-toggle').innerHTML = icon('edit', 13) + '查看 Markdown 源码';
      } else {
        ta.classList.remove('hidden');
        body.querySelector('#nai-toggle').innerHTML = icon('eye', 13) + '查看渲染效果';
      }
    });

    const commit = async () => {
      // 收集最终值(直接保存=AI 推荐;确认保存=表单当前值)
      let targetId = sel.value;
      if (targetId === '__create__') {
        const name = (newInput.value || '').trim();
        if (!name) { toast('请填写新文件夹名称', true); return; }
        const exist = N.doc.folders.find((f) => f.name === name);
        targetId = exist ? exist.id : createFolder(name, null, { silent: true }).id;
      }
      const title = (body.querySelector('#nai-title').value || '').trim() || plan.noteTitle;
      const tags = (body.querySelector('#nai-tags').value || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const md = ta.value;
      const sourceLines = [];
      if (ctx.question) sourceLines.push('- **原始问题**：' + ctx.question.replace(/\n/g, ' '));
      sourceLines.push('- **整理时间**：' + fmtFull(Date.now()));
      if (ctx.chat && ctx.chat.id) sourceLines.push('- **对话**：' + ((ctx.chat.title || '未命名对话') + '（ID: ' + ctx.chat.id + '）'));
      const content = md + '\n\n---\n\n## 来源\n\n'
        + sourceLines.join('\n') + '\n\n> 本笔记由 AI 自动整理生成,可直接修改。';
      const note = createNote(targetId, {
        title, tags, content,
        source: {
          conversationId: (ctx.chat && ctx.chat.id) || '',
          messageId: '',
          userQuestion: (ctx.question || '').slice(0, 2000),
          generatedByAI: true,
        },
      });
      pushNow();
      closeArchiveDialog(mask);
      toast('已保存到 AI 笔记「' + folderName(targetId) + ' / ' + title + '」');
      // 若笔记弹窗开着,刷新视图并选中
      if (N.els.mask && N.els.mask.classList.contains('show')) {
        N.ui.folderId = targetId;
        N.ui.search = '';
        persistUi();
        openNote(note.id);
        renderAll();
      }
    };

    foot.innerHTML = direct
      ? '<button class="btn" id="nai-cancel">取消</button><button class="btn primary" id="nai-save">确认保存</button>'
      : '<button class="btn" id="nai-cancel">取消</button>'
        + '<button class="btn" id="nai-quick">直接保存（使用 AI 推荐）</button>'
        + '<button class="btn primary" id="nai-save">确认保存</button>';
    foot.querySelector('#nai-cancel').addEventListener('click', () => closeArchiveDialog(mask));
    foot.querySelector('#nai-save').addEventListener('click', () => {
      // 进入编辑态后的保存:把预览切回源码读取最新值
      if (!ta.classList.contains('hidden')) { /* 源码可见,直接用 */ }
      commit();
    });
    const quick = foot.querySelector('#nai-quick');
    if (quick) {
      quick.addEventListener('click', () => {
        sel.value = plan.folderAction === 'existing' && folderById(plan.targetFolderId) ? plan.targetFolderId : (plan._forceFolder || sel.value);
        if (plan.folderAction === 'create' && !plan._forceFolder) {
          sel.value = '__create__';
          newInput.value = plan.newFolderName || '';
          newInput.classList.remove('hidden');
        }
        body.querySelector('#nai-title').value = plan.noteTitle;
        body.querySelector('#nai-tags').value = plan.tags.join(', ');
        ta.value = plan.markdownContent;
        commit();
      });
    }
  }

  // ============ 入口 ============
  // 入口按后台开关显示(公开配置 cached 在 localStorage['oc_cfg'])
  function notesFeatureEnabled() {
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
      if (cfg && typeof cfg.notesEnabled === 'boolean') return cfg.notesEnabled;
    } catch (e) {}
    return true;
  }
  function initEntry() {
    const btn = document.getElementById('notes-entry-btn');
    if (btn && !notesFeatureEnabled()) btn.classList.add('hidden');
    if (btn) {
      const iconEl = document.getElementById('notes-entry-icon');
      if (iconEl && window.OC && OC.icon) iconEl.innerHTML = OC.icon('notebook', 15);
      btn.addEventListener('click', open);
    }
    // 直接访问 /ainotes(或刷新)时自动进入笔记;登录态未就绪时等 app 初始化完再试
    if (isNotesPath()) {
      let tries = 0;
      const boot = async () => {
        tries++;
        const st = window.OCApp && window.OCApp.state;
        if (st && st.user) { open({ boot: true }); return; }
        if (tries < 40) setTimeout(boot, 250);
      };
      boot();
    }
    // 浏览器前进/后退:地址与模块状态保持一致
    window.addEventListener('popstate', () => {
      const shown = N.els.mask && N.els.mask.classList.contains('show');
      if (isNotesPath() && !shown) open();
      else if (!isNotesPath() && shown) close();
    });
  }

  window.OCNotes = {
    open,
    close,
    archiveFromMessage,
    _debug: N,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
