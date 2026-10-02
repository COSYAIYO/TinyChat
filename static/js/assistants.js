'use strict';
/**
 * assistants.js — 助手库弹窗
 *  分类展示预设助手；用户可新增分类/助手，也可改写公共助手为自己的副本。
 */
(function () {
  const A = {};
  const ic = () => (window.OC ? window.OC.icon : function () { return ''; });
  const $ = (id) => document.getElementById(id);
  const ICONS = ['bot', 'spark', 'layers', 'paper', 'code', 'table', 'nodes', 'think', 'user', 'wrench', 'edit', 'calendar'];
  const CAT_EMOJI = {
    'ac-present': '🎨', 'ac-academic': '📚', 'ac-code': '💻', 'ac-life': '🌿',
    'ac-write': '✍️', 'ac-study': '🎓', 'ac-as-ai': '🤖', 'ac-as-mind': '🧠',
    'ac-as-social': '💬', 'ac-as-philosophy': '🏛️', 'ac-as-language': '🌐',
    'ac-as-comments': '⭐', 'ac-as-company': '🏢', 'ac-as-tool': '🧰', 'ac-as-games': '🎲',
  };

  let cache = { categories: [], assistants: [] };
  let activeCat = 'all';
  let keyword = '';
  let formId = null;
  let formSourceId = null;
  let catEditId = null;
  let bound = false;

  function toast(msg, err) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, err);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function api(path, opts) {
    if (typeof window.api === 'function') return window.api(path, opts);
    const token = localStorage.getItem('oc_token') || '';
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
    return fetch((typeof apiUrl === 'function' ? apiUrl(path) : path), opts);
  }
  function isEmoji(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    try { return /\p{Extended_Pictographic}/u.test(t); } catch (e) { return /[^\x00-\x7F]/.test(t); }
  }
  function icon(name, size) {
    const fn = ic();
    return fn(ICONS.includes(name) ? name : 'bot', size || 16) || fn('bot', size || 16);
  }
  function avatarHtml(a, size) {
    const mark = String((a && a.icon) || '').trim();
    if (isEmoji(mark)) return '<span class="al-emoji" aria-hidden="true">' + escapeHtml(mark) + '</span>';
    return icon(mark, size || 18);
  }
  function catMark(c) {
    if (!c) return '';
    if (isEmoji(c.icon)) return c.icon;
    return CAT_EMOJI[c.id] || '';
  }

  async function load() {
    const r = await api('/api/assistants');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || '加载助手库失败');
    cache.categories = data.categories || [];
    cache.assistants = data.assistants || [];
    if (typeof window.syncAssistantCatalog === 'function') window.syncAssistantCatalog(data);
    if (activeCat !== 'all' && activeCat !== 'mine' && !cache.categories.some((c) => c.id === activeCat)) {
      activeCat = 'all';
    }
    return cache;
  }

  function filteredAssistants() {
    const kw = keyword.trim().toLowerCase();
    return cache.assistants.filter((a) => {
      if (activeCat === 'mine' && !a.mine && !a.sourceId) return false;
      if (activeCat !== 'all' && activeCat !== 'mine' && a.categoryId !== activeCat) return false;
      if (!kw) return true;
      return [a.name, a.desc, a.prompt].some((s) => String(s || '').toLowerCase().includes(kw));
    });
  }

  function catName(id) {
    const c = cache.categories.find((x) => x.id === id);
    return c ? c.name : '未分类';
  }

  function renderCats() {
    const el = $('al-cats');
    if (!el) return;
    const mineCount = cache.assistants.filter((a) => a.mine || a.sourceId).length;
    const pinned = [];
    const rest = [];
    cache.categories.forEach((c) => {
      const tab = { id: c.id, name: c.name, mark: catMark(c), count: c.count || 0, mine: c.mine };
      if (c.id === 'ac-present') pinned.push(tab);
      else rest.push(tab);
    });
    const tabs = [{ id: 'all', name: '全部', mark: '📚', count: cache.assistants.length }]
      .concat([{ id: 'mine', name: '我的', mark: '👤', count: mineCount }])
      .concat(pinned)
      .concat(rest);
    el.innerHTML = tabs.map((t) =>
      '<button class="al-cat' + (t.id === activeCat ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (t.id === activeCat ? 'true' : 'false') + '" data-cat="' + escapeHtml(t.id) + '">'
      + (t.mark ? '<i>' + escapeHtml(t.mark) + '</i>' : '')
      + '<span>' + escapeHtml(t.name) + (t.mine ? '<em>我的</em>' : '') + '</span>'
      + '<small>' + (t.count || 0) + '</small>'
      + '</button>'
    ).join('');
  }

  function cardHtml(a) {
    const badge = a.sourceId ? '<span class="al-badge">已改</span>' : (a.mine ? '<span class="al-badge mine">我的</span>' : '');
    const actions = [];
    actions.push('<button type="button" class="icon-btn al-mini" data-act="edit" data-id="' + escapeHtml(a.id) + '" aria-label="编辑">' + icon('edit', 14) + '</button>');
    if (a.sourceId) {
      actions.push('<button type="button" class="icon-btn al-mini" data-act="reset" data-id="' + escapeHtml(a.id) + '" aria-label="还原">' + icon('refresh', 14) + '</button>');
    } else if (a.mine) {
      actions.push('<button type="button" class="icon-btn al-mini danger" data-act="del" data-id="' + escapeHtml(a.id) + '" aria-label="删除">' + icon('trash', 14) + '</button>');
    }
    return '<article class="al-card" data-id="' + escapeHtml(a.id) + '">'
      + '<div class="al-card-ops">' + actions.join('') + '</div>'
      + '<button type="button" class="al-card-main" data-act="use" data-id="' + escapeHtml(a.id) + '">'
      + '<span class="al-card-icon">' + avatarHtml(a, 18) + '</span>'
      + '<span class="al-card-text">'
      + '<span class="al-card-title">' + escapeHtml(a.name) + badge + '</span>'
      + '<span class="al-card-desc">' + escapeHtml(a.desc || catName(a.categoryId)) + '</span>'
      + '</span></button>'
      + '</article>';
  }

  function renderBody() {
    const el = $('al-body');
    if (!el) return;
    const list = filteredAssistants();
    if (!list.length) {
      el.innerHTML = '<div class="al-empty">暂无助手，点击右上角添加。</div>';
      return;
    }
    if (activeCat === 'all' && !keyword.trim()) {
      const groups = cache.categories.map((c) => ({
        cat: c,
        items: list.filter((a) => a.categoryId === c.id),
      })).filter((g) => g.items.length);
      const orphans = list.filter((a) => !cache.categories.some((c) => c.id === a.categoryId));
      if (orphans.length) groups.push({ cat: { id: '_other', name: '其他' }, items: orphans });
      const none = '<section class="al-section">'
        + '<header class="al-section-head"><h4>不使用助手</h4></header>'
        + '<div class="al-grid">'
        + '<article class="al-card" data-id="">'
        + '<button type="button" class="al-card-main" data-act="none">'
        + '<span class="al-card-icon"><span class="al-emoji" aria-hidden="true">💬</span></span>'
        + '<span class="al-card-text"><span class="al-card-title">普通对话</span>'
        + '<span class="al-card-desc">不注入系统提示，按模型默认作答</span></span></button></article>'
        + '</div></section>';
      el.innerHTML = none + groups.map((g) =>
        '<section class="al-section">'
        + '<header class="al-section-head"><h4>' + (catMark(g.cat) ? '<i>' + escapeHtml(catMark(g.cat)) + '</i>' : '') + escapeHtml(g.cat.name) + '</h4>'
        + (g.cat.mine ? '<button type="button" class="btn small" data-act="edit-cat" data-id="' + escapeHtml(g.cat.id) + '">重命名</button>'
          + '<button type="button" class="btn small danger" data-act="del-cat" data-id="' + escapeHtml(g.cat.id) + '">删除分类</button>' : '')
        + '</header>'
        + '<div class="al-grid">' + g.items.map(cardHtml).join('') + '</div>'
        + '</section>'
      ).join('');
      return;
    }
    const cat = cache.categories.find((c) => c.id === activeCat);
    const head = (cat && cat.mine)
      ? '<header class="al-section-head"><h4>' + escapeHtml(cat.name) + '</h4>'
        + '<button type="button" class="btn small" data-act="edit-cat" data-id="' + escapeHtml(cat.id) + '">重命名</button>'
        + '<button type="button" class="btn small danger" data-act="del-cat" data-id="' + escapeHtml(cat.id) + '">删除分类</button></header>'
      : '';
    el.innerHTML = head + '<div class="al-grid">' + list.map(cardHtml).join('') + '</div>';
  }

  function render() {
    renderCats();
    renderBody();
  }

  function findAssistant(id) {
    return cache.assistants.find((a) => a.id === id);
  }

  function setCatSelect(id) {
    const box = $('af-cat');
    if (!box) return;
    const cat = cache.categories.find((c) => c.id === id) || cache.categories[0];
    box.dataset.value = cat ? cat.id : '';
    const label = box.querySelector('.sb-label');
    if (label) label.textContent = cat ? cat.name : '选择分类';
  }
  function bindCatSelect() {
    const box = $('af-cat');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    box.addEventListener('click', () => {
      if (!window.OC || !window.OC.openSelect) return;
      const items = cache.categories.map((c) => ({
        value: c.id,
        label: c.name + (c.mine ? '（我的）' : ''),
      }));
      if (!items.length) return toast('请先添加分类', true);
      window.OC.openSelect(box, items, {
        selected: box.dataset.value || '',
        onSelect: (val) => setCatSelect(val),
      });
    });
  }
  function fillCatSelect(selected) {
    bindCatSelect();
    setCatSelect(selected);
  }

  function openForm(asst) {
    const modal = $('assistant-form-modal');
    if (!modal) return;
    formId = asst ? asst.id : null;
    formSourceId = asst && asst.sourceId ? asst.sourceId : null;
    $('assistant-form-title').textContent = asst ? (asst.mine ? '编辑助手' : '改成我的版本') : '添加助手';
    $('af-name').value = asst ? asst.name : '';
    $('af-desc').value = asst ? (asst.desc || '') : '';
    if ($('af-icon')) $('af-icon').value = asst && isEmoji(asst.icon) ? asst.icon : (asst ? '' : '✨');
    $('af-prompt').value = asst ? (asst.prompt || '') : '';
    fillCatSelect(asst ? asst.categoryId : (activeCat !== 'all' && activeCat !== 'mine' ? activeCat : ''));
    if (window.OCUI) window.OCUI.openModal(modal);
    else modal.classList.remove('hidden');
  }

  function closeForm() {
    const modal = $('assistant-form-modal');
    if (!modal) return;
    if (window.OCUI) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
    formId = null;
    formSourceId = null;
  }

  async function saveForm() {
    const name = ($('af-name').value || '').trim();
    const desc = ($('af-desc').value || '').trim();
    const prompt = ($('af-prompt').value || '').trim();
    const iconVal = ($('af-icon') && $('af-icon').value || '').trim();
    const categoryId = $('af-cat') ? $('af-cat').dataset.value : '';
    if (!name) return toast('请填写名称', true);
    if (!prompt) return toast('请填写系统提示词', true);
    if (!categoryId) return toast('请选择分类', true);
    const body = { name, desc, prompt, categoryId, icon: iconVal || '✨' };
    const url = formId ? '/api/assistants/' + encodeURIComponent(formId) : '/api/assistants';
    const r = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
    closeForm();
    await load();
    render();
    toast(formId ? '已保存' : '已添加助手');
  }

  function openCatForm(cat) {
    const modal = $('assistant-cat-modal');
    if (!modal) return;
    catEditId = cat ? cat.id : null;
    $('assistant-cat-title').textContent = cat ? '重命名分类' : '添加分类';
    $('ac-name').value = cat ? cat.name : '';
    if (window.OCUI) window.OCUI.openModal(modal);
    else modal.classList.remove('hidden');
  }
  function closeCatForm() {
    const modal = $('assistant-cat-modal');
    if (!modal) return;
    if (window.OCUI) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
    catEditId = null;
  }
  async function saveCatForm() {
    const value = ($('ac-name').value || '').trim();
    if (!value) return toast('请填写分类名称', true);
    const url = catEditId
      ? '/api/assistants/categories/' + encodeURIComponent(catEditId)
      : '/api/assistants/categories';
    const r = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: value }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
    const creating = !catEditId;
    closeCatForm();
    await load();
    if (data.category && creating) activeCat = data.category.id;
    render();
    toast(creating ? '已添加分类' : '已重命名');
  }
  function addCategory() { openCatForm(null); }
  function renameCategory(id) {
    const cat = cache.categories.find((c) => c.id === id);
    if (cat) openCatForm(cat);
  }

  async function deleteCategory(id) {
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '删除分类', message: '仅删除空分类。确认删除？', danger: true, confirmText: '删除' })
      : window.confirm('确认删除该分类？');
    if (!ok) return;
    const r = await api('/api/assistants/categories/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
    if (activeCat === id) activeCat = 'all';
    await load();
    render();
  }

  async function deleteAssistant(id) {
    const a = findAssistant(id);
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '删除助手', message: '确认删除「' + ((a && a.name) || '助手') + '」？', danger: true, confirmText: '删除' })
      : window.confirm('确认删除该助手？');
    if (!ok) return;
    const r = await api('/api/assistants/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
    await load();
    render();
  }

  async function resetAssistant(id) {
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '还原助手', message: '还原后将丢弃你的修改，恢复公共版本。', confirmText: '还原' })
      : window.confirm('还原为公共版本？');
    if (!ok) return;
    const r = await api('/api/assistants/' + encodeURIComponent(id) + '/reset', { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast((data.error && data.error.message) || '还原失败', true);
    await load();
    render();
    toast('已还原');
  }

  function useAssistant(id) {
    const a = findAssistant(id);
    if (!a) return;
    closeLibrary();
    if (typeof window.startAssistantChat === 'function') window.startAssistantChat(a);
  }
  function useNone() {
    closeLibrary();
    if (typeof window.startAssistantChat === 'function') window.startAssistantChat(null);
  }

  function closeLibrary() {
    const modal = $('assistant-lib-modal');
    if (!modal) return;
    if (window.OCUI) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
  }

  async function openLibrary() {
    const modal = $('assistant-lib-modal');
    if (!modal) return;
    try { await load(); } catch (e) { return toast(e.message || '加载失败', true); }
    render();
    if (window.OCUI) window.OCUI.openModal(modal);
    else modal.classList.remove('hidden');
    const search = $('al-search');
    if (search) search.focus();
  }

  function bind() {
    if (bound) return;
    bound = true;
    const lib = $('assistant-lib-modal');
    const form = $('assistant-form-modal');
    if (window.OCUI) {
      if (lib) window.OCUI.bindModal(lib, { closeId: 'assistant-lib-close' });
      if (form) window.OCUI.bindModal(form, { closeId: 'assistant-form-close' });
      if ($('assistant-cat-modal')) window.OCUI.bindModal($('assistant-cat-modal'), { closeId: 'assistant-cat-close' });
    }
    const btn = $('assistant-lib-btn');
    if (btn) btn.addEventListener('click', openLibrary);
    if ($('al-add-cat')) $('al-add-cat').addEventListener('click', addCategory);
    if ($('al-add-asst')) $('al-add-asst').addEventListener('click', () => openForm(null));
    if ($('assistant-form-cancel')) $('assistant-form-cancel').addEventListener('click', closeForm);
    if ($('assistant-form-save')) $('assistant-form-save').addEventListener('click', saveForm);
    if ($('assistant-cat-cancel')) $('assistant-cat-cancel').addEventListener('click', closeCatForm);
    if ($('assistant-cat-save')) $('assistant-cat-save').addEventListener('click', saveCatForm);
    if ($('ac-name')) {
      $('ac-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveCatForm(); }
      });
    }
    if ($('al-search')) {
      $('al-search').addEventListener('input', () => {
        keyword = $('al-search').value || '';
        renderBody();
      });
    }
    if ($('al-cats')) {
      $('al-cats').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-cat]');
        if (!tab) return;
        activeCat = tab.dataset.cat;
        render();
      });
    }
    if ($('al-body')) {
      $('al-body').addEventListener('click', (e) => {
        const actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        const act = actEl.dataset.act;
        const id = actEl.dataset.id;
        if (act === 'use') return useAssistant(id);
        if (act === 'none') return useNone();
        if (act === 'edit') return openForm(findAssistant(id));
        if (act === 'del') return deleteAssistant(id);
        if (act === 'reset') return resetAssistant(id);
        if (act === 'edit-cat') return renameCategory(id);
        if (act === 'del-cat') return deleteCategory(id);
      });
    }
  }

  A.open = openLibrary;
  A.reload = load;
  window.OCAssistants = A;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
