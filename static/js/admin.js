'use strict';
/* 管理后台逻辑 */
const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('oc_token') || '';

if (window.OCUI && typeof window.OCUI.initTheme === 'function') {
  window.OCUI.initTheme();
}

function api(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
  return fetch(apiUrl(path), opts).then(async (r) => {
    if (r.status === 401) { location.href = apiUrl('/login'); throw new Error('未登录'); }
    return r;
  });
}
// 容错解析 JSON:响应不是 JSON(服务器返回 HTML 错误页)时给出可读提示,而不是抛 "Unexpected token '<'"
async function readJsonSafe(res) {
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try { return JSON.parse(trimmed); } catch (e) { /* noop */ }
  }
  return { error: { message: '服务器返回了非预期内容（HTTP ' + res.status + '），请检查站点配置或稍后重试' } };
}
function toast(msg, isError = false) {
  if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isError);
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

// ============ 统计 ============
async function loadStats() {
  const r = await api('/api/admin/stats');
  const data = await r.json();
  const s = data.stats || {};
  $('stats-grid').innerHTML = [
    ['用户总数', s.userCount ?? 0],
    ['累计调用', s.totalCalls ?? 0],
    ['今日调用', s.todayCalls ?? 0],
    ['已发放额度', s.totalQuotaGiven ?? 0],
    ['注册默认额度', data.freeQuota ?? 100],
    ['供应商数', s.providerCount ?? 0],
  ].map(([label, value]) =>
    `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`
  ).join('');

  // 近 14 天趋势(纯 CSS 柱状)
  const trendEl = $('trend-chart');
  if (trendEl) {
    const trend = (s.trend || []).slice(-14);
    const total = trend.reduce((acc, x) => acc + (x.calls || 0), 0);
    if (!total) {
      trendEl.innerHTML = '<div class="trend-empty">近 14 天暂无调用记录</div>';
    } else {
      const max = Math.max(1, ...trend.map((x) => x.calls || 0));
      trendEl.innerHTML = trend.map((x) => {
        const n = x.calls || 0;
        const has = n > 0;
        const h = Math.max(has ? 8 : 3, Math.round((n / max) * 100));
        const today = x.day === new Date().toISOString().slice(0, 10);
        return '<div class="trend-col' + (has ? ' has' : '') + (today ? ' today' : '') + '">'
          + '<div class="trend-bar" style="height:' + h + 'px"' + (has ? ' data-n="' + n + '"' : '') + '><span class="trend-val">' + n + '</span></div>'
          + '<div class="trend-label">' + x.day.slice(5) + '</div></div>';
      }).join('');
    }
  }

  // 运行信息
  const metaEl = $('meta-row');
  if (metaEl) {
    const up = s.uptimeSec || 0;
    const days = Math.floor(up / 86400), hrs = Math.floor((up % 86400) / 3600), mins = Math.floor((up % 3600) / 60);
    metaEl.innerHTML = '<span>服务版本 <b>' + (s.version || '-') + '</b></span>'
      + '<span>运行时间 <b>' + (days ? days + '天' : '') + hrs + '小时' + mins + '分</b></span>'
      + '<span>内存 <b>' + (s.memoryMB || 0) + ' MB</b></span>'
      + '<span>用户组 <b>' + (s.groupCount ?? 0) + '</b></span>'
      + '<span>全局供应商 <b>' + (s.globalProviderCount ?? 0) + '</b>' + ((s.globalProviderDisabledCount ?? 0) > 0 ? '（停用 ' + s.globalProviderDisabledCount + '）' : '') + '</span>';
  }

  const usageEl = $('usage-ledger');
  if (usageEl) {
    const rows = s.usage || [];
    usageEl.innerHTML = rows.length
      ? rows.map((u) => {
        const models = (u.models || []).map((m) => escapeHtml(m.model) + ' ' + (m.calls || 0) + ' 次 / ' + (m.cost || 0) + ' 额度').join('，');
        return '<div class="usage-row"><span class="usage-name">' + escapeHtml(u.name || '用户') + '</span>'
          + '<span class="usage-sum">' + (u.calls || 0) + ' 次 · ' + (u.cost || 0) + ' 额度</span>'
          + '<span class="usage-models muted small">' + (models || '无模型明细') + '</span></div>';
      }).join('')
      : '<p class="muted small">近 14 天还没有扣费记录。此前的调用没有按模型记账。</p>';
  }

  const voteEl = $('model-votes');
  if (voteEl) {
    const votes = s.modelVotes || [];
    voteEl.innerHTML = votes.length
      ? votes.map((v) => '<div class="model-vote-row"><span class="mv-name">' + escapeHtml(v.model) + '</span><span class="mv-up">赞 ' + (v.up || 0) + '</span><span class="mv-down">踩 ' + (v.down || 0) + '</span></div>').join('')
      : '<p class="muted small">还没有点赞或点踩</p>';
  }

  // 额度 Top5
  const topEl = $('top-users');
  if (topEl) {
    const tops = (s.topUsers || []).slice(0, 5);
    topEl.innerHTML = tops.length
      ? tops.map((u, i) => '<div class="mini-user"><span class="mu-rank">' + (i + 1) + '</span><span class="mu-name">' + escapeHtml(u.name) + (u.admin ? ' <span class="badge global">管理员</span>' : '') + '</span><span class="mu-quota">' + u.quota + ' 次</span></div>').join('')
      : '<p class="muted small">暂无用户</p>';
  }
}


let USER_FILTER = 'all';
let USER_LIST = [];
let USER_FORM_ID = null;
let ME_ID = (JSON.parse(localStorage.getItem('oc_user') || '{}').id || '');

function currentUserKw() {
  const input = $('user-search');
  return input ? input.value.trim() : '';
}

function groupLabel(groupId) {
  const g = GROUPS.find((x) => x.id === groupId);
  return g ? g.name : '';
}

function setGroupSelect(el, groupId) {
  if (!el) return;
  el.setAttribute('data-value', groupId || '');
  const label = el.querySelector('.sb-label');
  if (label) {
    const name = groupLabel(groupId);
    label.innerHTML = name ? escapeHtml(name) : '<span class="muted">未分组</span>';
  }
}

function bindGroupSelect(el) {
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    const adminOn = !!($('uf-admin') && $('uf-admin').checked);
    const items = GROUPS
      .filter((g) => adminOn ? g.role === 'admin' : g.role !== 'admin')
      .map((g) => ({ value: g.id, label: g.name }));
    window.OC.openSelect(el, items, {
      selected: el.getAttribute('data-value') || '',
      onSelect: (val) => setGroupSelect(el, val || ''),
    });
  });
}

async function ensureGroups() {
  if (GROUPS.length) return;
  try {
    const gr = await api('/api/admin/groups');
    GROUPS = (await gr.json()).groups || [];
  } catch (e) { /* 打开表单时再试 */ }
}

async function openUserForm(user) {
  const modal = $('user-form-modal');
  if (!modal) return;
  await ensureGroups();
  USER_FORM_ID = user ? user.id : null;
  $('user-form-title').textContent = user ? '编辑用户' : '创建用户';
  $('user-form-save').textContent = user ? '保存' : '创建';
  $('uf-name').value = user ? user.name : '';
  $('uf-pass').value = '';
  $('uf-pass-label').textContent = user ? '新密码（留空不改）' : '密码';
  $('uf-quota').value = user ? user.quota : 100;
  $('uf-admin').checked = !!(user && user.admin);
  if ($('uf-demo')) $('uf-demo').checked = !!(user && user.demo);
  if ($('uf-demo-row')) $('uf-demo-row').style.display = user ? 'none' : '';
  if ($('uf-demo-options')) $('uf-demo-options').hidden = !($('uf-demo') && $('uf-demo').checked);
  if ($('uf-demo-minutes')) $('uf-demo-minutes').value = 10;
  const adminGroup = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
  const preferred = $('uf-admin').checked
    ? adminGroup
    : (user && user.groupId && user.groupId !== adminGroup ? user.groupId : (DEFAULT_GROUP_ID || ''));
  setGroupSelect($('uf-group'), preferred);
  bindGroupSelect($('uf-group'));
  if (!$('uf-admin').dataset.boundGroup) {
    $('uf-admin').dataset.boundGroup = '1';
    $('uf-admin').addEventListener('change', () => {
      const nextAdmin = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
      const current = $('uf-group').getAttribute('data-value') || '';
      if ($('uf-admin').checked) setGroupSelect($('uf-group'), nextAdmin);
      else if (!current || current === nextAdmin) setGroupSelect($('uf-group'), DEFAULT_GROUP_ID || '');
    });
  }
  if ($('uf-demo') && !$('uf-demo').dataset.boundDemo) {
    $('uf-demo').dataset.boundDemo = '1';
    $('uf-demo').addEventListener('change', () => {
      // 演示管理员必须是管理员,勾选后自动带入管理员组
      if ($('uf-demo').checked) {
        $('uf-admin').checked = true;
        const nextAdmin = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
        setGroupSelect($('uf-group'), nextAdmin);
      }
      if ($('uf-demo-options')) $('uf-demo-options').hidden = !$('uf-demo').checked;
    });
  }
  modal.classList.remove('hidden');
  setTimeout(() => $('uf-name').focus(), 30);
}

function closeUserForm() {
  const modal = $('user-form-modal');
  if (modal) modal.classList.add('hidden');
  USER_FORM_ID = null;
}

async function saveUserForm() {
  const name = $('uf-name').value.trim();
  const password = $('uf-pass').value;
  const quota = Number($('uf-quota').value);
  const demo = !!($('uf-demo') && $('uf-demo').checked && !USER_FORM_ID);
  const demoMinutes = Math.min(1440, Math.max(1, parseInt($('uf-demo-minutes') && $('uf-demo-minutes').value, 10) || 10));
  const admin = $('uf-admin').checked || demo;
  const groupId = $('uf-group').getAttribute('data-value') || '';
  if (!name) return toast('请填写用户名', true);
  if (!USER_FORM_ID && !password) return toast('请填写密码', true);
  if (password && password.length < 4) return toast('密码至少 4 个字符', true);
  if (!Number.isFinite(quota) || quota < 0) return toast('额度无效', true);

  const btn = $('user-form-save');
  btn.disabled = true;
  try {
    if (!USER_FORM_ID) {
      const r = await api('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password, quota, admin, demo, demoMinutes }),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '创建失败', true);
      const created = data.user;
      const createdGroup = created && created.groupId ? created.groupId : '';
      if (created && groupId !== createdGroup) {
        await api('/api/admin/users/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: created.id, groupId: groupId || null }),
        });
      }
      toast('用户已创建');
    } else {
      const body = { userId: USER_FORM_ID, name, admin };
      if (password) body.password = password;
      const r = await api('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      const qr = await api('/api/admin/users/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_FORM_ID, quota }),
      });
      if (!qr.ok) return toast('额度更新失败', true);
      const gr = await api('/api/admin/users/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_FORM_ID, groupId: groupId || null }),
      });
      if (!gr.ok) return toast('用户组更新失败', true);
      toast('已保存');
    }
    closeUserForm();
    loadUsers(currentUserKw());
    loadStats();
  } finally {
    btn.disabled = false;
  }
}

// ============ 用户组管理 ============
let GROUPS = [];
let ACCESS = [];
let PROVIDERS = [];

let DEFAULT_GROUP_ID = '';

function setDefaultGroupSelect(groupId) {
  const el = $('g-default');
  if (!el) return;
  const id = groupId || '';
  el.setAttribute('data-value', id);
  const label = el.querySelector('.sb-label');
  if (label) label.textContent = groupLabel(id) || '默认用户组';
}

function bindDefaultGroupSelect() {
  const el = $('g-default');
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    const items = GROUPS.filter((g) => g.role !== 'admin').map((g) => ({ value: g.id, label: g.name }));
    window.OC.openSelect(el, items, {
      selected: el.getAttribute('data-value') || DEFAULT_GROUP_ID,
      onSelect: (val) => setDefaultGroupSelect(val),
    });
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
}

async function openGroupRename(g) {
  if (g.builtin) {
    toast('系统用户组名称固定（按角色识别），可直接在「模型授权」中调整其可用模型', true);
    return;
  }
  const next = window.prompt('修改用户组名称', g.name);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) return toast('组名不能为空', true);
  if (name === g.name) return;
  const r = await api('/api/admin/groups/' + encodeURIComponent(g.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast((d.error && d.error.message) || '修改失败', true);
  toast('用户组已更新');
  loadGroups();
  loadUsers(currentUserKw());
}

async function loadGroups() {
  const r = await api('/api/admin/groups');
  const data = await r.json();
  GROUPS = data.groups || [];
  DEFAULT_GROUP_ID = data.defaultGroupId || '';
  bindDefaultGroupSelect();
  setDefaultGroupSelect(DEFAULT_GROUP_ID);
  const box = $('groups-list');
  box.innerHTML = '';
  if (!GROUPS.length) { box.innerHTML = '<p class="muted small">暂无用户组</p>'; return; }
  GROUPS.forEach((g) => {
    const card = document.createElement('div');
    card.className = 'group-card';
    const badges = (g.role === 'admin' ? '<span class="badge global">全部模型</span>' : '')
      + (g.builtin ? '<span class="badge default">系统</span>' : '')
      + (g.id === DEFAULT_GROUP_ID ? '<span class="badge global">注册默认</span>' : '');
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(g.name)} ${badges}</div>
        <div class="pc-url">${g.memberCount} 名成员</div>
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        ${g.builtin
          ? '<button class="btn small" data-editgroup="' + escapeHtml(g.id) + '">重命名</button>'
          : '<button class="btn small" data-editgroup="' + escapeHtml(g.id) + '">重命名</button><button class="btn small danger" data-delgroup="' + escapeHtml(g.id) + '">删除</button>'}
      </div>`;
    card.querySelector('[data-editgroup]')?.addEventListener('click', () => openGroupRename(g));
    card.querySelector('[data-delgroup]')?.addEventListener('click', async () => {
      const extra = g.id === DEFAULT_GROUP_ID ? '该组当前是注册默认组，删除后会改回系统默认用户组。' : '';
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除用户组', message: '确认删除用户组「' + g.name + '」？该组成员将变为未分组，相关授权一并清除。' + extra, danger: true, confirmText: '删除' })
        : confirm('确认删除用户组 ' + g.name + '？\n该组成员将变为未分组，相关授权一并清除。');
      if (!ok) return;
      const rr = await api('/api/admin/groups/' + g.id, { method: 'DELETE' });
      const body = await rr.json().catch(() => ({}));
      if (rr.ok) { toast('已删除'); loadGroups(); loadUsers(); loadAccess(); }
      else toast((body.error && body.error.message) || '删除失败', true);
    });
    box.appendChild(card);
  });
}

const gDefaultSave = $('g-default-save');
if (gDefaultSave) gDefaultSave.addEventListener('click', async () => {
  const groupId = ($('g-default') && $('g-default').getAttribute('data-value')) || '';
  if (!groupId) return toast('请选择一个用户组', true);
  gDefaultSave.disabled = true;
  try {
    const r = await api('/api/admin/groups/default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    const data = await r.json();
    if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
    toast('注册默认组已保存');
    loadGroups();
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  } finally {
    gDefaultSave.disabled = false;
  }
});

$('g-add').addEventListener('click', async () => {
  const name = $('g-name').value.trim();
  if (!name) return toast('请填写组名', true);
  const r = await api('/api/admin/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await r.json();
  if (!r.ok) return toast((data.error && data.error.message) || '创建失败', true);
  toast('用户组已创建');
  $('g-name').value = '';
  loadGroups(); loadAccess();
});

function visibleUsers() {
  if (USER_FILTER === 'admin') return USER_LIST.filter((u) => u.admin);
  if (USER_FILTER === 'guest') return USER_LIST.filter((u) => u.guest);
  if (USER_FILTER === 'member') return USER_LIST.filter((u) => !u.admin && !u.guest);
  return USER_LIST.slice();
}

function renderUsers() {
  const tbody = $('users-tbody');
  if (!tbody) return;
  const list = visibleUsers();
  const countEl = $('users-count');
  if (countEl) {
    countEl.textContent = USER_LIST.length
      ? (list.length === USER_LIST.length ? USER_LIST.length + ' 人' : '显示 ' + list.length + ' / ' + USER_LIST.length + ' 人')
      : '暂无用户';
  }
  tbody.innerHTML = '';
  if (!list.length) {
    tbody.innerHTML = '<tr class="users-empty-row"><td colspan="8">' + (USER_LIST.length ? '没有匹配的用户' : '还没有用户，点右上角创建') + '</td></tr>';
    return;
  }
  list.forEach((u) => {
    const tr = document.createElement('tr');
    const initial = String(u.name || '?').trim().charAt(0).toUpperCase();
    const gName = groupLabel(u.groupId);
    tr.innerHTML =
      '<td class="col-user">'
      + '<div class="user-cell">'
      + '<span class="user-avatar' + (u.admin ? ' is-admin' : '') + '">' + escapeHtml(initial) + '</span>'
      + '<div class="user-meta">'
      + '<div class="user-name">' + escapeHtml(u.name)
      + (u.admin ? ' <span class="badge global">管理员</span>' : '')
      + (u.demo ? ' <span class="badge">演示</span>' : '')
      + (u.guest ? ' <span class="badge">游客</span>' : '')
      + (u.id === ME_ID ? ' <span class="badge default">我</span>' : '')
      + '</div></div></div></td>'
      + '<td class="col-quota">' + (u.quota ?? 0) + '</td>'
      + '<td class="col-group">' + (gName ? escapeHtml(gName) : '<span class="muted">未分组</span>') + '</td>'
      + '<td class="col-chats">' + (u.chatCount || 0) + '</td>'
      + '<td class="col-time muted">' + fmtTime(u.createdAt) + '</td>'
      + '<td class="col-seen muted">' + (u.lastSeen ? fmtTime(u.lastSeen) : '—') + '</td>'
      + '<td class="col-ip muted">' + (u.lastIp ? escapeHtml(u.lastIp) : '—') + '</td>'
      + '<td class="col-actions"><div class="admin-row-actions">'
      + '<button class="btn small" type="button" data-edit="' + escapeHtml(u.id) + '">编辑</button>'
      + '<button class="btn small" type="button" data-chats="' + escapeHtml(u.id) + '">对话</button>'
      + (u.id === ME_ID ? '' : '<button class="btn small danger" type="button" data-deluser="' + escapeHtml(u.id) + '">删除</button>')
      + '</div></td>';
    tr.querySelector('[data-edit]')?.addEventListener('click', () => openUserForm(u));
    tr.querySelector('[data-chats]')?.addEventListener('click', () => openUserChats(u));
    tr.querySelector('[data-deluser]')?.addEventListener('click', async () => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除用户', message: '确认删除用户「' + u.name + '」？其对话和自建供应商会一并清除。', danger: true, confirmText: '删除' })
        : confirm('确认删除用户 ' + u.name + '?');
      if (!ok) return;
      const rr = await api('/api/admin/users/' + u.id, { method: 'DELETE' });
      if (rr.ok) { toast('已删除'); loadUsers(currentUserKw()); loadStats(); }
      else toast('删除失败', true);
    });
    tbody.appendChild(tr);
  });
}

async function loadUsers(searchKw) {
  const r = await api('/api/admin/users' + (searchKw ? '?q=' + encodeURIComponent(searchKw) : ''));
  const data = await r.json();
  if (!GROUPS.length) {
    const gr = await api('/api/admin/groups');
    GROUPS = (await gr.json()).groups || [];
  }
  USER_LIST = data.users || [];
  renderUsers();
}

// ============ 模型授权 ============
async function loadAccess() {
  const [r1, r2] = await Promise.all([
    api('/api/admin/access'),
    api('/api/providers'),
  ]);
  const ad = await r1.json();
  const pd = await r2.json();
  ACCESS = ad.rules || [];
  PROVIDERS = (pd.providers || []).filter((p) => p.scope === 'global' && p.enabled !== false);
  const box = $('access-box');
  box.innerHTML = '';
  if (!GROUPS.length) { box.innerHTML = '<p class="muted small">请先创建用户组</p>'; return; }
  if (!PROVIDERS.length) {
    const anyGlobal = (pd.providers || []).some((p) => p.scope === 'global');
    box.innerHTML = '<p class="muted small">' + (anyGlobal ? '全局供应商均已停用，请先在「供应商配置」中启用。' : '暂无可授权的全局供应商，请先在下方添加。') + '</p>';
    return;
  }

  GROUPS.forEach((g) => {
    const section = document.createElement('div');
    section.className = 'access-section';
    const locked = g.role === 'admin';
    section.innerHTML = `<div class="access-title">${escapeHtml(g.name)}${locked ? ' <span class="badge global">始终全部模型</span>' : ''}</div>`;
    PROVIDERS.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'access-row';
      row.dataset.group = g.id;
      row.dataset.provider = p.id;
      row.dataset.locked = locked ? '1' : '';
      row.innerHTML = `
        <div class="access-prov">${escapeHtml(p.name)}
          <label class="access-all" style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-weight:normal">
            <input type="checkbox" data-prov="${p.id}" ${locked ? 'disabled' : ''}> 全部
          </label>
        </div>
        <div class="access-models">
          ${p.models.map((m) => `
            <label class="access-model">
              <input type="checkbox" data-model="${p.id}|${m.id}" ${locked ? 'disabled' : ''}>
              ${escapeHtml(m.id)}
            </label>`).join('')}
        </div>`;
      syncAccessRow(row);
      const allChk = row.querySelector('[data-prov]');
      if (locked) { section.appendChild(row); return; }
      // 「全部」= 全选/全不选快捷键:勾上写通配 ['*'],取消则清空(之后可逐个勾选)
      allChk.addEventListener('change', async () => {
        await saveAccessRule(g.id, p.id, allChk.checked ? ['*'] : [], row);
      });
      // 单个模型:直接勾选即可只授权部分模型。全选时写回通配,便于新模型自动纳入。
      row.querySelectorAll('[data-model]').forEach((chk) => {
        chk.addEventListener('change', async () => {
          const boxes = Array.from(row.querySelectorAll('[data-model]'));
          const sel = boxes.filter((c) => c.checked).map((c) => c.dataset.model.split('|')[1]);
          const allSelected = boxes.length > 0 && sel.length === boxes.length;
          await saveAccessRule(g.id, p.id, allSelected ? ['*'] : sel, row);
        });
      });
      section.appendChild(row);
    });
    box.appendChild(section);
  });
}

// 依据当前 ACCESS 同步某一行复选框:通配时全部勾上并显示「全部」;
// 部分授权时「全部」呈半选(不确定)态。
function syncAccessRow(row) {
  if (!row) return;
  const gid = row.dataset.group;
  const pid = row.dataset.provider;
  const locked = row.dataset.locked === '1';
  const rule = ACCESS.find((a) => a.groupId === gid && a.providerId === pid);
  const ids = rule && Array.isArray(rule.modelIds) ? rule.modelIds : [];
  const allOpen = locked || ids.indexOf('*') >= 0;
  const boxFor = (mid) => allOpen || ids.indexOf(mid) >= 0;
  row.querySelectorAll('[data-model]').forEach((chk) => {
    const mid = chk.dataset.model.split('|')[1];
    chk.checked = boxFor(mid);
    chk.disabled = locked;
    const label = chk.closest('.access-model');
    if (label) label.classList.toggle('disabled', false);
  });
  const allChk = row.querySelector('[data-prov]');
  if (allChk) {
    const boxes = row.querySelectorAll('[data-model]');
    const n = Array.from(boxes).filter((c) => c.checked).length;
    allChk.checked = allOpen || (boxes.length > 0 && n === boxes.length);
    allChk.indeterminate = !allOpen && n > 0 && n < boxes.length;
  }
}

async function saveAccessRule(groupId, providerId, modelIds, row) {
  const r = await api('/api/admin/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, providerId, modelIds }),
  });
  const data = await readJsonSafe(r);
  if (!r.ok) {
    toast((data.error && data.error.message) || '保存授权失败', true);
    // 失败时回滚复选框到服务端真实状态
    syncAccessRow(row);
    return;
  }
  ACCESS = data.rules || [];
  const count = modelIds.length === 1 && modelIds[0] === '*' ? '全部模型' : (modelIds.length + ' 个模型');
  toast('授权已更新：' + count);
  // 局部同步复选框状态,避免整块重绘导致闪烁
  if (row) syncAccessRow(row);
  else loadAccess();
}

// ============ 供应商管理 ============
// API Key 显示/隐藏切换
const apKeyInput = $('ap-key');
const toggleKeyBtn = $('ap-key-toggle');
function setKeyVisibility(input, button, visible) {
  if (!input || !button) return;
  input.type = visible ? 'text' : 'password';
  button.innerHTML = window.OC.icon(visible ? 'eyeOff' : 'eye', 14);
  button.title = visible ? '隐藏 Key' : '显示 Key';
  button.setAttribute('aria-label', button.title);
}
if (apKeyInput && toggleKeyBtn) {
  toggleKeyBtn.addEventListener('click', async () => {
    // 编辑模式且输入框为空:点小眼睛取回服务器上已保存的 Key(仅限勾选了「保存后保持显示」的供应商)
    const editId = $('ap-save').dataset.editId;
    if (editId && apKeyInput.value.trim() === '') {
      if (!window.apEditingRevealable) {
        toast('该 Key 保存时未勾选「保存后保持显示」，无法查看', true);
        return;
      }
      try {
        toggleKeyBtn.disabled = true;
        const rr = await api('/api/providers/' + encodeURIComponent(editId) + '/key', { method: 'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '无法查看 Key');
        apKeyInput.value = dd.key || '';
        setKeyVisibility(apKeyInput, toggleKeyBtn, true);
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally {
        toggleKeyBtn.disabled = false;
      }
      return;
    }
    setKeyVisibility(apKeyInput, toggleKeyBtn, apKeyInput.type !== 'text');
    apKeyInput.focus();
  });
}

const apModelList = window.OC && window.OC.bindModelChecklist
  ? window.OC.bindModelChecklist({
    listId: 'ap-models-list',
    queryId: 'ap-model-q',
    allId: 'ap-models-all',
    countId: 'ap-models-count',
    addId: 'ap-model-add',
  })
  : null;

// 用户自建供应商不出现在管理后台;这里只展示管理员配置的全局供应商
async function loadProviders() {
  const r = await api('/api/providers');
  const data = await r.json();
  const box = $('admin-providers');
  box.innerHTML = '';
  const providers = (data.providers || []).filter((p) => p.scope === 'global');
  providers.forEach((p) => {
    const isDefault = p.id === data.defaultProviderId;
    const disabled = p.enabled === false;
    const card = document.createElement('div');
    card.className = 'provider-card' + (disabled ? ' disabled' : '');
    const keyHtml = p.hasKey && p.keyRevealable
      ? '<div class="pc-key">Key: <span class="pc-key-value" data-key-value="' + p.id + '" data-masked="' + escapeHtml(p.apiKey || '••••••') + '">' + escapeHtml(p.apiKey || '••••••') + '</span>'
        + '<button class="pc-key-eye" data-reveal="' + p.id + '" type="button" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 13) + '</button></div>'
      : '';
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(p.name)}
          <span class="badge global">全局</span>
          ${isDefault ? '<span class="badge default">默认</span>' : ''}
          ${disabled ? '<span class="badge disabled">已停用</span>' : ''}
        </div>
        <div class="pc-url">${escapeHtml(p.baseUrl)} · ${escapeHtml(p.apiFormat)} · 模型: ${escapeHtml(p.models.map((m) => m.id).join(', '))} · ${p.billingMode === 'token' ? ('按 token ' + (p.pricePer1k || 0) + '/1K') : ('扣 ' + p.costPerCall + ' 次')}</div>
        ${keyHtml}
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        ${!disabled && !isDefault ? '<button class="btn small" data-default="' + p.id + '">设为默认</button>' : ''}
        <button class="btn small" data-toggle type="button">${disabled ? '启用' : '停用'}</button>
        <button class="btn small" data-test type="button">测试</button>
        <button class="btn small" data-edit type="button">编辑</button>
        <button class="btn small danger" data-del type="button">删除</button>
      </div>`;
    card.querySelector('[data-toggle]')?.addEventListener('click', async () => {
      const enable = disabled;
      try {
        const rr = await api('/api/admin/providers/' + p.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enable }),
        });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '操作失败');
        toast(enable ? '已启用' : '已停用，用户端不再显示该供应商');
        loadProviders();
        loadStats();
      } catch (err) {
        toast(err.message || '操作失败', true);
      }
    });
    card.querySelector('[data-default]')?.addEventListener('click', async () => {
      const rr = await api('/api/admin/providers/' + p.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-default' }),
      });
      if (rr.ok) { toast('已设为默认'); loadProviders(); } else toast('操作失败', true);
    });
    card.querySelector('[data-reveal]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const span = card.querySelector('[data-key-value="' + p.id + '"]');
      if (!btn || !span) return;
      if (span.getAttribute('data-revealed') === '1') {
        span.textContent = span.getAttribute('data-masked') || '••••••';
        span.removeAttribute('data-revealed');
        btn.innerHTML = window.OC.icon('eye', 13);
        btn.title = '显示 Key';
        return;
      }
      try {
        btn.disabled = true;
        const rr = await api('/api/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '无法查看 Key');
        span.textContent = dd.key || '';
        span.setAttribute('data-revealed', '1');
        btn.innerHTML = window.OC.icon('eyeOff', 13);
        btn.title = '隐藏 Key';
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally {
        btn.disabled = false;
      }
    });
    card.querySelector('[data-del]')?.addEventListener('click', async () => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除供应商', message: '确认删除供应商「' + p.name + '」？', danger: true, confirmText: '删除' })
        : confirm('确认删除供应商 ' + p.name + '？');
      if (!ok) return;
      const rr = await api('/api/admin/providers/' + p.id, { method: 'DELETE' });
      if (rr.ok) { toast('已删除'); loadProviders(); loadStats(); } else toast('删除失败', true);
    });
    const fillEditForm = (target) => {
      showAdminTab('providers');
      $('ap-name').value = target.name;
      $('ap-baseurl').value = target.baseUrl;
      // 接口只回掩码。留空表示不改密钥，填写新值才会覆盖；默认勾选「保存后保持显示」。
      $('ap-key').value = '';
      $('ap-key').type = 'password';
      toggleKeyBtn.innerHTML = window.OC.icon('eye', 14);
      $('ap-key').placeholder = target.hasKey
        ? (target.keyRevealable ? ('已设置 ' + (target.apiKey || '') + '，留空则保持') : '已加密保存，不可查看；更换请输入新 Key')
        : 'sk-...';
      $('ap-key-keep').checked = target.keyRevealable !== false;
      window.apEditingRevealable = target.keyRevealable !== false;
      delete $('ap-save').dataset.origKey;
      if (window.__setApFormat) window.__setApFormat(target.apiFormat);
      if (apModelList) apModelList.setEnabled(target.models || []);
      $('ap-cost').value = target.costPerCall;
      if (window.__setApBilling) window.__setApBilling(target.billingMode || 'call');
      if ($('ap-price')) $('ap-price').value = target.pricePer1k != null ? target.pricePer1k : 0;
      $('ap-save').dataset.editId = target.id;
      $('ap-save').textContent = '保存修改';
    };
card.querySelector('[data-edit]')?.addEventListener('click', () => {
      fillEditForm(p);
      resetModelTestResults();
      // 展开添加/编辑表单
      const details = document.querySelector('.add-provider');
      if (details && !details.open) details.open = true;
      // 滚动到表单
      $('ap-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => $('ap-name').focus(), 350);
    });
    card.querySelector('[data-test]')?.addEventListener('click', () => {
      const details = document.querySelector('.add-provider');
      if (details && !details.open) details.open = true;
      fillEditForm(p);
      resetModelTestResults();
      if ($('ap-test-prompt') && !$('ap-test-prompt').value.trim()) $('ap-test-prompt').value = '回复一个字：好';
      if (typeof refreshModelTestSelect === 'function') refreshModelTestSelect((p.models[0] && p.models[0].id) || '');
      const el = $('ap-test');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    box.appendChild(card);
  });
  if (!providers.length) box.innerHTML = '<p class="muted small">暂无全局供应商。用户自建的供应商仅本人可见，不出现在后台。</p>';
}

const WS_PROVIDERS = [
  { value: 'tavily', label: 'Tavily', sub: '官方搜索 API，填 Key 即可' },
  { value: 'searxng', label: 'SearXNG', sub: '自建元搜索，填实例地址' },
];
function setWsProvider(val) {
  const box = $('ws-provider');
  if (!box) return;
  const next = val === 'searxng' ? 'searxng' : 'tavily';
  box.setAttribute('data-value', next);
  const f = WS_PROVIDERS.find((x) => x.value === next);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = f ? f.label : next;
  if ($('ws-tavily-row')) $('ws-tavily-row').classList.toggle('hidden', next !== 'tavily');
  if ($('ws-searx-row')) $('ws-searx-row').classList.toggle('hidden', next !== 'searxng');
}
// 「对话设置」面板专用加载:此前该页签没有 loader,直接打开会显示 HTML 默认值,
// 若此时点保存会把默认值写回服务端、静默重置真实配置。
async function loadChatSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  fillChatLimits((data && data.settings) || {});
}
async function loadSearchSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  const s = (data && data.settings) || {};
  if ($('ws-enabled')) $('ws-enabled').checked = !!s.webSearchEnabled;
  if ($('ws-allow-user')) $('ws-allow-user').checked = !!s.webSearchAllowUser;
  if ($('ws-url-read')) $('ws-url-read').checked = s.urlReadEnabled !== false;
  if ($('ws-url-read-max')) $('ws-url-read-max').value = Math.min(5, Math.max(1, parseInt(s.urlReadMax, 10) || 3));
  setWsProvider(s.webSearchProvider || 'tavily');
  if ($('ws-tavily-key') && s.webSearchTavilyKey) $('ws-tavily-key').value = s.webSearchTavilyKey;
  if ($('ws-searx-url')) $('ws-searx-url').value = s.webSearchSearxUrl || '';
  if ($('ws-max')) $('ws-max').value = s.webSearchMaxResults || 5;
  fillMineruSettings(s);
  fillChatLimits(s);
}
function fillChatLimits(s) {
  const src = s || {};
  const maxCtx = Math.min(500, Math.max(2, parseInt(src.maxContextMessages, 10) || 200));
  const ctx = Math.min(maxCtx, Math.max(2, parseInt(src.contextMessages, 10) || 40));
  const output = Math.min(128000, Math.max(256, parseInt(src.maxOutputTokens, 10) || 12800));
  if ($('chat-context-max')) $('chat-context-max').value = maxCtx;
  if ($('chat-context')) $('chat-context').value = ctx;
  if ($('chat-output')) $('chat-output').value = output;
  if ($('chat-temperature')) {
    const t = parseFloat(src.temperature);
    $('chat-temperature').value = Number.isFinite(t) ? t : '';
  }
  if ($('chat-ratelimit')) $('chat-ratelimit').value = Math.min(600, Math.max(0, parseInt(src.rateLimitPerMin, 10) || 0));
  if ($('chat-timeout')) $('chat-timeout').value = Math.min(600, Math.max(5, Math.round((parseInt(src.proxyTimeoutMs, 10) || 120000) / 1000)));
  if ($('chat-context-learn')) $('chat-context-learn').checked = src.contextAutoLearn !== false;
  if ($('chat-persist-chats')) $('chat-persist-chats').checked = src.persistChats !== false;
  if ($('chat-health-ok')) $('chat-health-ok').value = Math.min(100, Math.max(1, parseInt(src.healthOkMin, 10) || 75));
  if ($('chat-health-warn')) $('chat-health-warn').value = Math.min(99, Math.max(0, parseInt(src.healthWarnMin, 10) || 40));
}
(function initChatLimits() {
  document.querySelectorAll('#panel-chat .stepper [data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.getAttribute('data-target'));
      if (!input) return;
      const delta = parseInt(btn.getAttribute('data-step'), 10) || 0;
      const current = parseInt(input.value, 10) || 0;
      input.value = String(Math.min(500, Math.max(2, current + delta)));
    });
  });
  const save = $('chat-limits-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const maxCtx = Math.min(500, Math.max(2, parseInt($('chat-context-max') && $('chat-context-max').value, 10) || 200));
    const ctx = Math.min(maxCtx, Math.max(2, parseInt($('chat-context') && $('chat-context').value, 10) || 40));
    const output = Math.min(128000, Math.max(256, parseInt($('chat-output') && $('chat-output').value, 10) || 12800));
    const tempRaw = parseFloat(($('chat-temperature') && $('chat-temperature').value) || '');
    const temperature = Number.isFinite(tempRaw) ? Math.min(2, Math.max(0, tempRaw)) : null;
    const rateLimit = Math.min(600, Math.max(0, parseInt($('chat-ratelimit') && $('chat-ratelimit').value, 10) || 0));
    const timeoutSec = Math.min(600, Math.max(5, parseInt($('chat-timeout') && $('chat-timeout').value, 10) || 120));
    const contextLearn = !!($('chat-context-learn') && $('chat-context-learn').checked);
    const persistChats = !!($('chat-persist-chats') && $('chat-persist-chats').checked);
    // 可用性阈值:保证 okMin 严格大于 warnMin(输入颠倒时本地纠正并回写)
    let healthOk = Math.min(100, Math.max(1, parseInt($('chat-health-ok') && $('chat-health-ok').value, 10) || 75));
    let healthWarn = Math.min(99, Math.max(0, parseInt($('chat-health-warn') && $('chat-health-warn').value, 10)));
    if (!(healthWarn < healthOk)) healthWarn = Math.max(0, healthOk - 1);
    if ($('chat-health-ok')) $('chat-health-ok').value = healthOk;
    if ($('chat-health-warn')) $('chat-health-warn').value = healthWarn;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextMessages: ctx, maxContextMessages: maxCtx, maxOutputTokens: output, temperature, rateLimitPerMin: rateLimit, proxyTimeoutMs: timeoutSec * 1000, contextAutoLearn: contextLearn, persistChats, healthOkMin: healthOk, healthWarnMin: healthWarn }),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      fillChatLimits(data.settings || { contextMessages: ctx, maxContextMessages: maxCtx, maxOutputTokens: output, temperature });
      toast('对话设置已保存');
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
(function initSearchSettings() {
  const box = $('ws-provider');
  if (box) {
    box.addEventListener('click', () => {
      OC.openSelect(box, WS_PROVIDERS, {
        selected: box.getAttribute('data-value') || 'tavily',
        onSelect: (val) => setWsProvider(val),
      });
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
    });
  }
  const save = $('ws-save');
  function wsPayload(scan) {
    const key = ($('ws-tavily-key') && $('ws-tavily-key').value || '').trim();
    const payload = {
      provider: ($('ws-provider') && $('ws-provider').getAttribute('data-value')) || 'tavily',
      url: ($('ws-searx-url') && $('ws-searx-url').value || '').trim(),
      query: ($('ws-query') && $('ws-query').value || '').trim() || 'openai',
      max: Math.min(5, parseInt($('ws-max') && $('ws-max').value, 10) || 3),
      scan: !!scan,
    };
    if (key && key.indexOf('••') < 0) payload.apiKey = key;
    return payload;
  }
  function renderSearchProbe(data) {
    const box = $('ws-test-result');
    if (!box) return;
    const rows = data.results || (data.result ? [data.result] : []);
    if (!rows.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = rows.map((row) => {
      const ok = !!row.ok;
      const title = escapeHtml(row.url || (row.provider === 'tavily' ? 'Tavily' : 'SearXNG'));
      const detail = ok
        ? ('返回 ' + (row.count || 0) + ' 条' + (row.sample && row.sample[0] ? ' · ' + row.sample[0].title : ''))
        : (row.error || '不可用');
      const use = row.provider === 'searxng' && row.url
        ? '<button class="btn small" type="button" data-use-searx="' + escapeHtml(row.url) + '">填入</button>'
        : '';
      return '<div class="probe-row ' + (ok ? 'ok' : 'bad') + '">'
        + '<div class="probe-main"><div class="probe-title">' + (ok ? '可用' : '失败') + ' · ' + title + '</div>'
        + '<div class="probe-sub">' + escapeHtml(detail) + '</div></div>'
        + '<div class="probe-side"><span class="probe-ms">' + (row.ms || 0) + ' ms</span>' + use + '</div></div>';
    }).join('');
  }
  async function runSearchProbe(scan) {
    const testBtn = $('ws-test');
    const scanBtn = $('ws-scan');
    const status = $('ws-test-status');
    if (testBtn) testBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    if (status) status.textContent = scan ? '正在探测公共实例…' : '正在测试…';
    try {
      const r = await api('/api/admin/search/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wsPayload(scan)),
      });
      const data = await r.json();
      if (!r.ok) {
        if (status) status.textContent = '';
        return toast((data.error && data.error.message) || '测试失败', true);
      }
      renderSearchProbe(data);
      const rows = data.results || (data.result ? [data.result] : []);
      const good = rows.filter((x) => x.ok).length;
      const total = data.total || rows.length;
      if (status) status.textContent = scan ? ('可用 ' + good + ' / ' + total) : (good ? '当前接口可用' : '当前接口不可用');
    } catch (e) {
      if (status) status.textContent = '';
      toast('测试失败: ' + e.message, true);
    } finally {
      if (testBtn) testBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
    }
  }
  const testBtn = $('ws-test');
  const scanBtn = $('ws-scan');
  const resultBox = $('ws-test-result');
  if (testBtn) testBtn.addEventListener('click', () => runSearchProbe(false));
  if (scanBtn) scanBtn.addEventListener('click', () => {
    setWsProvider('searxng');
    runSearchProbe(true);
  });
  if (resultBox) resultBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-use-searx]');
    if (!btn || !$('ws-searx-url')) return;
    setWsProvider('searxng');
    const url = (btn.getAttribute('data-use-searx') || '').trim().replace(/\/+$/, '');
    const lines = $('ws-searx-url').value.split(/\s+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
    if (lines.some((s) => s.toLowerCase() === url.toLowerCase())) return toast('这个地址已经在列表里');
    lines.push(url);
    $('ws-searx-url').value = lines.join('\n');
    toast('已追加 SearXNG 地址，记得保存');
  });
  if (save) save.addEventListener('click', async () => {
    const key = ($('ws-tavily-key') && $('ws-tavily-key').value || '').trim();
    const payload = {
      webSearchEnabled: !!($('ws-enabled') && $('ws-enabled').checked),
      webSearchAllowUser: !!($('ws-allow-user') && $('ws-allow-user').checked),
      urlReadEnabled: !!($('ws-url-read') && $('ws-url-read').checked),
      urlReadMax: Math.min(5, Math.max(1, parseInt($('ws-url-read-max') && $('ws-url-read-max').value, 10) || 3)),
      webSearchProvider: ($('ws-provider') && $('ws-provider').getAttribute('data-value')) || 'tavily',
      webSearchSearxUrl: ($('ws-searx-url') && $('ws-searx-url').value || '').trim(),
      webSearchMaxResults: parseInt($('ws-max') && $('ws-max').value, 10) || 5,
    };
    if (key && key.indexOf('••') < 0) payload.webSearchTavilyKey = key;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('联网设置已保存');
      if (data.settings) {
        setWsProvider(data.settings.webSearchProvider);
        if ($('ws-enabled')) $('ws-enabled').checked = !!data.settings.webSearchEnabled;
        if ($('ws-allow-user')) $('ws-allow-user').checked = !!data.settings.webSearchAllowUser;
        if ($('ws-tavily-key') && data.settings.webSearchTavilyKey) $('ws-tavily-key').value = data.settings.webSearchTavilyKey;
        if ($('ws-searx-url')) $('ws-searx-url').value = data.settings.webSearchSearxUrl || '';
        if ($('ws-max')) $('ws-max').value = data.settings.webSearchMaxResults || 5;
      }
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();


function shownHasMask(token) {
  return String(token || '').indexOf('••') >= 0;
}
function fillMineruSettings(s) {
  const token = (s && s.mineruToken) || '';
  if ($('mineru-token') && token) $('mineru-token').value = token;
  const mode = $('mineru-mode');
  if (!mode) return;
  const precise = shownHasMask(token);
  const allow = $('mineru-allow-user');
  if (allow) allow.checked = !!(s && s.mineruAllowUser);
  mode.textContent = precise
    ? '当前：精准解析。单文件不超过 200MB、200 页，Token 仅保存在服务器。'
    : '当前：轻量解析。单文件不超过 10MB、20 页，同一 IP 每分钟有次数限制。用户上传后直接解析，只有超限或失败时才会看到限制。';
}
(function initMineruSettings() {
  const save = $('mineru-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const key = ($('mineru-token') && $('mineru-token').value || '').trim();
    const payload = { mineruAllowUser: !!($('mineru-allow-user') && $('mineru-allow-user').checked) };
    if (!key) payload.mineruToken = '';
    else if (key.indexOf('••') < 0) payload.mineruToken = key;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast(key ? '文档解析设置已保存' : '已切换为轻量解析');
      if (data.settings) fillMineruSettings(data.settings);
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();

// API 格式自定义选择
(function initFormatSelect() {
  const box = $('ap-format');
  if (!box) return;
  const FORMATS = [
    { value: 'chat', label: 'OpenAI chat/completions', sub: '对话接口 /v1/chat/completions（常用）' },
    { value: 'responses', label: 'OpenAI responses', sub: '新版接口 /v1/responses' },
    { value: 'completions', label: 'OpenAI completions', sub: '旧版补全 /v1/completions' },
    { value: 'anthropic', label: 'Anthropic messages', sub: 'Claude 消息接口 /v1/messages' },
    { value: 'video', label: 'Agnes videos', sub: '视频生成 /v1/videos（异步任务，前台可生视频）' },
  ];
  const setLabel = (v) => {
    const f = FORMATS.find((x) => x.value === (v || box.getAttribute('data-value') || 'chat'));
    box.querySelector('.sb-label').textContent = f ? f.label : (v || 'chat');
  };
  window.__setApFormat = (v) => { box.setAttribute('data-value', v); setLabel(v); };
  box.addEventListener('click', () => {
    OC.openSelect(box, FORMATS.map((f) => ({ value: f.value, label: f.label, sub: f.sub })), {
      selected: box.getAttribute('data-value') || 'chat',
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(val); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();

// 计费模式自定义选择:按次 / 按 token
(function initBillingSelect() {
  const box = $('ap-billing');
  if (!box) return;
  const MODES = [
    { value: 'call', label: '按次（扣费次数）', sub: '每次调用扣固定次数' },
    { value: 'token', label: '按 token', sub: '按实际用量（输入+输出）/1K 计费' },
  ];
  const setLabel = (v) => {
    const m = MODES.find((x) => x.value === (v || 'call'));
    box.querySelector('.sb-label').textContent = m ? m.label : v;
  };
  const togglePrice = (v) => { const row = $('ap-price-row'); if (row) row.classList.toggle('hidden', v !== 'token'); };
  window.__setApBilling = (v) => { box.setAttribute('data-value', v === 'token' ? 'token' : 'call'); setLabel(v); togglePrice(v); };
  box.addEventListener('click', () => {
    OC.openSelect(box, MODES, {
      selected: box.getAttribute('data-value') || 'call',
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(val); togglePrice(val); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();
$('ap-fetch-models').addEventListener('click', async () => {
  const baseUrl = $('ap-baseurl').value.trim();
  const apiKey = $('ap-key').value.trim();
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  if (!baseUrl) return toast('请先填写 Base URL', true);
  // 编辑模式 key 未填时用原 key 尝试
  const editId = $('ap-save').dataset.editId;
  const usedKey = apiKey.indexOf('••') < 0 ? apiKey : '';
  if (!usedKey && !editId) { toast('请先填写 API Key', true); return; }
  const btn = $('ap-fetch-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const r = await api('/api/proxy/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: usedKey, apiFormat, providerId: editId || undefined }),
    });
    const data = await readJsonSafe(r);
    if (!r.ok) return toast((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'), true);
    const models = data.models || [];
    if (!models.length) return toast('上游未返回模型', true);
    if (window.OC && window.OC.openFetchedModelsModal) {
      window.OC.openFetchedModelsModal(models, {
        title: '获取到的模型',
        existing: apModelList ? apModelList.getCatalog() : [],
        onApply: (picked, staleIds) => {
          resetModelTestResults();
          if (apModelList) apModelList.applyFetched(picked, staleIds);
          const n = picked.filter((m) => m.enabled).length;
          const cleared = (staleIds || []).length;
          toast('已应用 ' + n + ' 个启用模型' + (cleared ? '，清除 ' + cleared + ' 个失效模型' : '') + '，保存后生效');
        },
      });
    } else if (apModelList) {
      resetModelTestResults();
      apModelList.setFromFetch(models);
      toast('已获取 ' + models.length + ' 个模型，勾选后保存即可启用');
    }
  } catch (e) {
    toast('获取失败: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '获取列表';
  }
});

function modelTestChoices() {
  const models = apModelList ? apModelList.getEnabled() : [];
  return models.map((m) => ({ value: m.id, label: m.name || m.id, sub: m.name && m.name !== m.id ? m.id : '' }));
}
function refreshModelTestSelect(prefer) {
  const box = $('ap-test-model');
  if (!box) return;
  const choices = modelTestChoices();
  const cur = prefer || box.getAttribute('data-value') || '';
  const hit = choices.find((x) => x.value === cur) || choices[0];
  box.setAttribute('data-value', hit ? hit.value : '');
  const lab = box.querySelector('.sb-label');
  if (lab) lab.innerHTML = hit ? escapeHtml(hit.label) : '<span class="muted">先获取或勾选模型</span>';
}
function modelProbeRow(model, row) {
  const ok = !!(row && row.ok);
  return '<div class="probe-row ' + (ok ? 'ok' : 'bad') + '" data-model="' + escapeHtml(model) + '">'
    + '<div class="probe-main"><div class="probe-title">' + escapeHtml(ok ? '可用' : '失败') + ' · ' + escapeHtml((row && row.model) || model) + '</div>'
    + '<div class="probe-sub">' + escapeHtml(ok ? ((row && row.reply) || '已响应') : ((row && row.error) || '无回复')) + '</div></div>'
    + '<div class="probe-side"><span class="probe-ms">' + ((row && row.ms) || 0) + ' ms</span></div></div>';
}
function modelTestGapMs() {
  const raw = parseFloat($('ap-test-gap') && $('ap-test-gap').value);
  const sec = Number.isFinite(raw) ? Math.min(60, Math.max(0, raw)) : 1;
  return Math.round(sec * 1000);
}
let modelTestAbort = false;
let modelTestBusy = false;
let modelTestPassed = new Set();

function updateKeepPassedAction() {
  const btn = $('ap-keep-passed');
  if (!btn) return;
  const available = !modelTestBusy && modelTestPassed.size > 0;
  btn.classList.toggle('hidden', !available);
  btn.disabled = !available;
}

function resetModelTestResults(clearOutput = true) {
  modelTestPassed.clear();
  updateKeepPassedAction();
  if (clearOutput) {
    const out = $('ap-test-result');
    if (out) {
      out.classList.add('hidden');
      out.innerHTML = '';
    }
  }
}

function keepPassedModels() {
  const ids = apModelList
    ? Array.from(modelTestPassed).filter((id) => apModelList.getCatalog().some((m) => m.id === id))
    : [];
  if (!ids.length) return toast('没有可保留的通过模型', true);
  if (apModelList) apModelList.setEnabledIds(ids);
  refreshModelTestSelect(ids[0]);
  toast('已保留 ' + ids.length + ' 个通过模型，保存后生效');
}

async function requestModelTest(model) {
  const payload = {
    baseUrl: $('ap-baseurl').value.trim(),
    apiKey: $('ap-key').value.trim(),
    apiFormat: ($('ap-format') && $('ap-format').getAttribute('data-value')) || 'chat',
    model: model,
    prompt: ($('ap-test-prompt') && $('ap-test-prompt').value.trim()) || '回复一个字：好',
    providerId: $('ap-save').dataset.editId || undefined,
  };
  const r = await api('/api/admin/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || '测试失败');
  return data.result || { ok: false, model: model, error: '无回复' };
}
function setModelTestBusy(on) {
  modelTestBusy = on;
  updateKeepPassedAction();
  ['ap-test', 'ap-test-all'].forEach((id) => { if ($(id)) $(id).disabled = on; });
  const stop = $('ap-test-stop');
  if (stop) stop.classList.toggle('hidden', !on);
}
(function initModelTest() {
  const box = $('ap-test-model');
  const btn = $('ap-test');
  const allBtn = $('ap-test-all');
  const stopBtn = $('ap-test-stop');
  const keepBtn = $('ap-keep-passed');
  if (keepBtn) keepBtn.addEventListener('click', keepPassedModels);
  if (box) {
    box.addEventListener('click', () => {
      const choices = modelTestChoices();
      if (!choices.length) return toast('请先获取或勾选至少一个模型', true);
      OC.openSelect(box, choices, {
        selected: box.getAttribute('data-value') || '',
        onSelect: (val) => refreshModelTestSelect(val),
      });
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
    });
  }
  const list = $('ap-models-list');
  if (list) list.addEventListener('change', () => {
    resetModelTestResults();
    refreshModelTestSelect();
  });
  if (stopBtn) stopBtn.addEventListener('click', () => { modelTestAbort = true; stopBtn.disabled = true; });
  if (btn) btn.addEventListener('click', async () => {
    resetModelTestResults();
    const choices = modelTestChoices();
    const model = ($('ap-test-model') && $('ap-test-model').getAttribute('data-value')) || (choices[0] && choices[0].value) || '';
    if (!model) return toast('请先选择要测试的模型', true);
    const status = $('ap-test-status');
    const out = $('ap-test-result');
    modelTestAbort = false;
    setModelTestBusy(true);
    if (status) status.textContent = '正在询问 ' + model + '…';
    try {
      const row = await requestModelTest(model);
      if (out) {
        out.classList.remove('hidden');
        out.innerHTML = modelProbeRow(model, row);
      }
      if (status) status.textContent = row.ok ? '模型可用' : '模型不可用';
    } catch (e) {
      if (status) status.textContent = '';
      toast('测试失败: ' + e.message, true);
    } finally {
      if (stopBtn) stopBtn.disabled = false;
      setModelTestBusy(false);
    }
  });
  if (allBtn) allBtn.addEventListener('click', async () => {
    resetModelTestResults();
    const choices = modelTestChoices();
    if (!choices.length) return toast('请先勾选要测试的模型', true);
    const status = $('ap-test-status');
    const out = $('ap-test-result');
    const gap = modelTestGapMs();
    modelTestAbort = false;
    setModelTestBusy(true);
    if (out) {
      out.classList.remove('hidden');
      out.innerHTML = '';
    }
    let ok = 0;
    let tested = 0;
    try {
      for (let i = 0; i < choices.length; i++) {
        if (modelTestAbort) break;
        const model = choices[i].value;
        if (status) status.textContent = '正在测试 ' + (i + 1) + ' / ' + choices.length + ' · ' + model;
        let row;
        try {
          row = await requestModelTest(model);
        } catch (e) {
          row = { ok: false, model: model, error: e.message, ms: 0 };
        }
        tested++;
        if (row.ok) {
          ok++;
          modelTestPassed.add(model);
          updateKeepPassedAction();
        }
        if (out) out.insertAdjacentHTML('beforeend', modelProbeRow(model, row));
        if (i < choices.length - 1 && gap && !modelTestAbort) {
          if (status) status.textContent = '等待 ' + (gap / 1000) + ' 秒后继续 · ' + (i + 1) + ' / ' + choices.length;
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
      }
      const done = modelTestAbort ? '已停止' : '完成';
      updateKeepPassedAction();
      if (status) status.textContent = done + ' · 可用 ' + ok + ' / ' + tested;
    } finally {
      if (stopBtn) stopBtn.disabled = false;
      setModelTestBusy(false);
    }
  });
})();

$('ap-save').addEventListener('click', async () => {
  const name = $('ap-name').value.trim();
  const baseUrl = $('ap-baseurl').value.trim();
  const apiKey = $('ap-key').value.trim();
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  const cost = Number($('ap-cost').value) || 1;
  if (!baseUrl) return toast('请填写 Base URL', true);
  const models = apModelList ? apModelList.getEnabled() : [];
  if (!models.length) return toast('请先获取模型并至少勾选一个', true);

  const editId = $('ap-save').dataset.editId;
  const url = editId ? '/api/admin/providers/' + editId : '/api/providers';
  const payload = { name, baseUrl, apiFormat, models, costPerCall: cost, billingMode: ($('ap-billing') && $('ap-billing').getAttribute('data-value')) || 'call', pricePer1k: Math.min(1000, Math.max(0, parseFloat($('ap-price') && $('ap-price').value) || 0)), scope: 'global', keyRevealable: !!($('ap-key-keep') && $('ap-key-keep').checked) };
  // 编辑时留空或仍是掩码，表示不改密钥；服务端会保留原值。
  if (!(editId && (!apiKey || apiKey.includes('••')))) payload.apiKey = apiKey;
  const r = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
  toast(editId ? '已保存修改' : '全局供应商已添加');
  delete $('ap-save').dataset.editId;
  window.apEditingRevealable = false;
  $('ap-save').textContent = '保存供应商';
  // 恢复表单到「新增」默认态；「保存后保持显示」默认勾选
  $('ap-name').value = ''; $('ap-baseurl').value = ''; $('ap-key').value = '';
  resetModelTestResults();
  if (apModelList) apModelList.reset();
  // 计费模式一并回到默认「按次」，避免下次新增供应商继承上次编辑的 token 模式
  if (window.__setApBilling) window.__setApBilling('call');
  if ($('ap-price')) $('ap-price').value = 0;
  setKeyVisibility(apKeyInput, toggleKeyBtn, false);
  if (apKeyInput) apKeyInput.placeholder = 'sk-...';
  if ($('ap-key-keep')) $('ap-key-keep').checked = true;
  loadProviders(); loadStats();
});

// ============ 事件 & 启动 ============
$('back-chat').addEventListener('click', () => location.href = apiUrl('/'));
$('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('oc_token');
  localStorage.removeItem('oc_user');
  location.href = apiUrl('/login');
});

// ============ 运行日志 ============
let logKind = '';
async function loadLogs() {
  const r = await api('/api/admin/logs?limit=200');
  const data = await r.json();
  const tbody = $('logs-tbody');
  const empty = $('logs-empty');
  if (!tbody) return;
  tbody.innerHTML = '';
  const logs = (data.logs || []).filter((l) => !logKind || (logKind === 'err' ? (l.status >= 400 || l.error) : l.kind === logKind));
  if (empty) empty.style.display = logs.length ? 'none' : 'block';
  logs.forEach((l) => {
    const tr = document.createElement('tr');
    const status = l.status || 0;
    const ok = status === 0 ? l.error ? false : true : status < 400;
    const badge = l.kind === 'auth' ? '<span class="log-badge auth">认证</span>'
      : (l.kind === 'parse' ? '<span class="log-badge chat">解析</span>'
      : (status >= 400 || l.error ? '<span class="log-badge err">错误</span>' : '<span class="log-badge chat">对话</span>'));
    const ms = l.ms !== undefined ? '<span title="' + l.ms + 'ms">' + (l.ms >= 1000 ? (l.ms / 1000).toFixed(1) + 's' : l.ms + 'ms') + '</span>' : '-';
    tr.innerHTML = '<td>' + fmtTime(l.t) + '</td>'
      + '<td>' + escapeHtml(l.userName || '-') + '</td>'
      + '<td>' + badge + '</td>'
      + '<td>' + escapeHtml(l.provider || '-') + '</td>'
      + '<td>' + escapeHtml(l.model || '-') + '</td>'
      + '<td class="log-status ' + (ok ? 'ok' : 'fail') + '">' + (l.error ? '失败' : status + (status === 0 ? '(连接失败)' : '')) + '</td>'
      + '<td>' + ms + '</td>'
      + '<td>' + (l.cost || 0) + '</td>'
      + '<td class="log-msg" title="' + escapeHtml(l.error || '') + '">' + escapeHtml(l.error || '') + '</td>';
    tbody.appendChild(tr);
  });
}
(function bindLogs() {
  const filters = $('log-filters');
  if (!filters) return;
  filters.addEventListener('click', async (e) => {
    const btn = e.target.closest('.log-filter-btn');
    if (!btn) return;
    filters.querySelectorAll('.log-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    logKind = btn.dataset.kind || '';
    loadLogs();
  });
  const refresh = $('log-refresh');
  if (refresh) refresh.addEventListener('click', loadLogs);
  const clear = $('log-clear');
  if (clear) clear.addEventListener('click', async () => {
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清空日志', message: '确认清空全部运行日志？此操作不可恢复。', danger: true, confirmText: '清空' })
      : window.confirm('确认清空全部运行日志?');
    if (!ok) return;
    const rr = await api('/api/admin/logs', { method: 'DELETE' });
    if (rr.ok) { toast('日志已清空'); loadLogs(); } else toast('清空失败', true);
  });
})();

// ============ 用户对话历史查看 ============
let USER_CACHE = [];
async function loadUserOptions() {
  try {
    const r = await api('/api/admin/users');
    const data = await r.json();
    USER_CACHE = data.users || [];
    const select = $('user-chats-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">选择用户(输入筛选)</option>'
      + USER_CACHE.map((u) => '<option value="' + u.id + '">' + escapeHtml(u.name) + ' (' + (u.chatCount || 0) + ' 对话)</option>').join('');
    select.value = current || '';
  } catch (e) { /* 静默 */ }
}

async function openUserChats(user) {
  const modal = $('user-chats-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  $('user-chats-title').textContent = '对话历史 · ' + (user ? user.name : '全部用户');
  $('user-chats-content').innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">加载中...</p>';
  await loadUserOptions();
  if (user) {
    const select = $('user-chats-select');
    select.value = user.id;
  }
  await loadUserChats(user ? user.id : ($('user-chats-select').value || ''));
}

async function loadUserChats(userId) {
  const content = $('user-chats-content');
  if (!content) return;
  content.innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">加载中...</p>';
  try {
    const url = '/api/admin/users/chats' + (userId ? '?userId=' + encodeURIComponent(userId) : '');
    const r = await api(url);
    const data = await r.json();
    if (!r.ok) { content.innerHTML = '<p class="muted small">加载失败</p>'; return; }
    const list = (data.usersChats || []).filter((x) => x.chats && x.chats.length);
    if (!list.length) {
      content.innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">该用户暂无对话记录</p>';
      return;
    }
    let html = '';
    list.forEach((uc) => {
      html += '<div class="section-title" style="margin-top:14px">' + escapeHtml(uc.user.name) + ' · ' + uc.chats.length + ' 个对话</div>';
      uc.chats.forEach((c) => {
        const msgs = (c.messages || []).map((m) => {
          const who = m.role === 'user' ? '用户' : 'AI';
          const err = m.error ? ' <span class="log-badge err">失败</span>' : '';
          const txt = escapeHtml((m.content || '').slice(0, 300)) + ((m.content || '').length > 300 ? '…' : '');
          return '<div class="chat-msg ' + (m.role === 'user' ? 'u' : 'a') + '"><span class="chat-msg-who">' + who + err + '</span><div class="chat-msg-text">' + txt + '</div></div>';
        }).join('');
        const expanded = msgs ? '<div class="chat-detail"><div class="chat-detail-msgs">' + msgs + '</div></div>' : '';
        html += '<details class="chat-history-item" ' + (c.id === (userId ? null : null) ? '' : '') + '>'
          + '<summary><span class="chat-h-title">' + escapeHtml(c.title) + '</span>'
          + '<span class="chat-h-meta">' + c.messages.length + ' 条 · ' + fmtTime(c.updatedAt) + '</span></summary>'
          + expanded + '</details>';
      });
    });
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = '<p class="muted small">加载失败:' + escapeHtml(e.message) + '</p>';
  }
}

(function bindUserChatsModal() {
  const modal = $('user-chats-modal');
  if (!modal) return;
  const close = $('user-chats-close');
  if (close) close.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  const select = $('user-chats-select');
  if (select) select.addEventListener('change', () => {
    const v = select.value;
    const u = USER_CACHE.find((x) => x.id === v);
    $('user-chats-title').textContent = '对话历史 · ' + (u ? u.name : '全部用户');
    loadUserChats(v);
  });
  const reload = $('user-chats-reload');
  if (reload) reload.addEventListener('click', () => loadUserChats(select.value));
})();

// ============ 用户搜索 / 筛选 / 表单 ============
(function bindUserAdmin() {
  const input = $('user-search');
  const clearBtn = $('search-clear');
  let timer = null;
  if (input) {
    input.addEventListener('input', () => {
      const kw = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(() => { loadUsers(kw); if (clearBtn) clearBtn.hidden = !kw; }, 300);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (input) input.value = '';
      clearBtn.hidden = true;
      loadUsers();
    });
  }
  const filters = $('users-filters');
  if (filters) {
    filters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      USER_FILTER = btn.dataset.filter || 'all';
      filters.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderUsers();
    });
  }
  const createBtn = $('user-create-btn');
  if (createBtn) createBtn.addEventListener('click', () => openUserForm(null));
  const modal = $('user-form-modal');
  const close = () => closeUserForm();
  if ($('user-form-close')) $('user-form-close').addEventListener('click', close);
  if ($('user-form-cancel')) $('user-form-cancel').addEventListener('click', close);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  if ($('user-form-save')) $('user-form-save').addEventListener('click', saveUserForm);
  if ($('uf-pass')) {
    $('uf-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveUserForm(); }
    });
  }
})();

// ============ 助手库（公共） ============
let ASST_CATS = [];
let ASST_ITEMS = [];
let ASST_FILTER = 'all';
let ASST_FORM_ID = null;
let ASST_CAT_EDIT = null;

function asstIsEmoji(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  try { return /\p{Extended_Pictographic}/u.test(t); } catch (e) { return /[^\x00-\x7F]/.test(t); }
}
function asstIcon(name) {
  if (asstIsEmoji(name)) return '<span class="al-emoji" aria-hidden="true">' + escapeHtml(name) + '</span>';
  return window.OC ? window.OC.icon(name || 'bot', 16) : '';
}
function asstCatMark(c) {
  if (!c) return '';
  if (asstIsEmoji(c.icon)) return c.icon;
  return ({ 'ac-academic': '📚', 'ac-code': '💻', 'ac-life': '🌿', 'ac-write': '✍️', 'ac-study': '🎓' })[c.id] || '';
}

function setAsstCatSelect(id) {
  const el = $('asf-cat');
  if (!el) return;
  const cat = ASST_CATS.find((c) => c.id === id) || ASST_CATS[0];
  el.dataset.value = cat ? cat.id : '';
  const label = el.querySelector('.sb-label');
  if (label) label.textContent = cat ? cat.name : '选择分类';
}

function bindAsstCatSelect() {
  const el = $('asf-cat');
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    if (!ASST_CATS.length) return toast('请先添加分类', true);
    window.OC.openSelect(el, ASST_CATS.map((c) => ({ value: c.id, label: c.name })), {
      selected: el.dataset.value || '',
      onSelect: (val) => setAsstCatSelect(val),
    });
  });
}

function renderAssistantCats() {
  const el = $('asst-cats');
  if (!el) return;
  const tabs = [{ id: 'all', name: '全部', count: ASST_ITEMS.length }]
    .concat(ASST_CATS.map((c) => ({ id: c.id, name: c.name, count: c.count || 0 })));
  el.innerHTML = tabs.map((t) =>
    '<button class="al-cat' + (t.id === ASST_FILTER ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (t.id === ASST_FILTER ? 'true' : 'false') + '" data-cat="' + escapeHtml(t.id) + '">'
    + (t.id !== 'all' && asstCatMark(ASST_CATS.find((c) => c.id === t.id)) ? '<i>' + escapeHtml(asstCatMark(ASST_CATS.find((c) => c.id === t.id))) + '</i>' : '')
    + '<span>' + escapeHtml(t.name) + '</span>'
    + '<small>' + (t.count || 0) + '</small>'
    + '</button>'
  ).join('');
}

function renderAssistants() {
  const el = $('asst-body');
  if (!el) return;
  const list = ASST_FILTER === 'all' ? ASST_ITEMS : ASST_ITEMS.filter((a) => a.categoryId === ASST_FILTER);
  const countEl = $('asst-count');
  if (countEl) countEl.textContent = ASST_CATS.length + ' 个分类 · ' + ASST_ITEMS.length + ' 个公共助手';
  if (!list.length) {
    el.innerHTML = '<div class="al-empty">暂无助手，先添加分类再添加助手。</div>';
    return;
  }
  const groups = (ASST_FILTER === 'all' ? ASST_CATS : ASST_CATS.filter((c) => c.id === ASST_FILTER)).map((c) => ({
    cat: c,
    items: list.filter((a) => a.categoryId === c.id),
  })).filter((g) => g.items.length);
  el.innerHTML = groups.map((g) =>
    '<section class="al-section">'
    + '<header class="al-section-head"><h4>' + (asstCatMark(g.cat) ? '<i>' + escapeHtml(asstCatMark(g.cat)) + '</i>' : '') + escapeHtml(g.cat.name) + '</h4>'
    + '<button type="button" class="btn small" data-act="rename-cat" data-id="' + escapeHtml(g.cat.id) + '">重命名</button>'
    + '<button type="button" class="btn small danger" data-act="del-cat" data-id="' + escapeHtml(g.cat.id) + '">删除分类</button>'
    + '</header>'
    + '<div class="al-grid">' + g.items.map((a) =>
      '<article class="al-card">'
      + '<div class="al-card-ops">'
      + '<button type="button" class="icon-btn al-mini" data-act="edit" data-id="' + escapeHtml(a.id) + '" aria-label="编辑">' + (window.OC ? window.OC.icon('edit', 14) : '编辑') + '</button>'
      + '<button type="button" class="icon-btn al-mini danger" data-act="del" data-id="' + escapeHtml(a.id) + '" aria-label="删除">' + (window.OC ? window.OC.icon('trash', 14) : '删除') + '</button>'
      + '</div>'
      + '<div class="al-card-main static">'
      + '<span class="al-card-icon">' + asstIcon(a.icon) + '</span>'
      + '<span class="al-card-text">'
      + '<span class="al-card-title">' + escapeHtml(a.name) + '</span>'
      + '<span class="al-card-desc">' + escapeHtml(a.desc || '未填写简介') + '</span>'
      + '</span></div></article>'
    ).join('') + '</div></section>'
  ).join('');
}

async function loadAssistants() {
  const r = await api('/api/admin/assistants');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '加载助手库失败', true);
  ASST_CATS = data.categories || [];
  ASST_ITEMS = data.assistants || [];
  if (ASST_FILTER !== 'all' && !ASST_CATS.some((c) => c.id === ASST_FILTER)) ASST_FILTER = 'all';
  renderAssistantCats();
  renderAssistants();
}

function openAsstForm(asst) {
  const modal = $('asst-form-modal');
  if (!modal) return;
  ASST_FORM_ID = asst ? asst.id : null;
  $('asst-form-title').textContent = asst ? '编辑助手' : '添加助手';
  $('asf-name').value = asst ? asst.name : '';
  $('asf-desc').value = asst ? (asst.desc || '') : '';
  if ($('asf-icon')) $('asf-icon').value = asst && asstIsEmoji(asst.icon) ? asst.icon : (asst ? '' : '✨');
  $('asf-prompt').value = asst ? (asst.prompt || '') : '';
  bindAsstCatSelect();
  setAsstCatSelect(asst ? asst.categoryId : (ASST_FILTER !== 'all' ? ASST_FILTER : ''));
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}

function closeAsstForm() {
  const modal = $('asst-form-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  ASST_FORM_ID = null;
}

async function saveAsstForm() {
  const name = ($('asf-name').value || '').trim();
  const desc = ($('asf-desc').value || '').trim();
  const prompt = ($('asf-prompt').value || '').trim();
  const iconVal = ($('asf-icon') && $('asf-icon').value || '').trim();
  const categoryId = $('asf-cat') ? $('asf-cat').dataset.value : '';
  if (!name) return toast('请填写名称', true);
  if (!prompt) return toast('请填写系统提示词', true);
  if (!categoryId) return toast('请选择分类', true);
  const url = ASST_FORM_ID ? '/api/admin/assistants/' + encodeURIComponent(ASST_FORM_ID) : '/api/admin/assistants';
  const r = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, desc, prompt, categoryId, icon: iconVal || '✨' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
  closeAsstForm();
  await loadAssistants();
  toast(ASST_FORM_ID ? '已保存' : '已添加助手');
}

function openAsstCatForm(cat) {
  const modal = $('asst-cat-modal');
  if (!modal) return;
  ASST_CAT_EDIT = cat ? cat.id : null;
  $('asst-cat-title').textContent = cat ? '重命名分类' : '添加分类';
  $('asc-name').value = cat ? cat.name : '';
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}
function closeAsstCatForm() {
  const modal = $('asst-cat-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  ASST_CAT_EDIT = null;
}
async function saveAsstCatForm() {
  const value = ($('asc-name').value || '').trim();
  if (!value) return toast('请填写分类名称', true);
  const editing = ASST_CAT_EDIT;
  const url = editing
    ? '/api/admin/assistants/categories/' + encodeURIComponent(editing)
    : '/api/admin/assistants/categories';
  const r = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
  closeAsstCatForm();
  await loadAssistants();
  if (data.category && !editing) {
    ASST_FILTER = data.category.id;
    renderAssistantCats();
    renderAssistants();
  }
  toast(editing ? '已重命名' : '已添加分类');
}
function addAsstCategory() { openAsstCatForm(null); }
function renameAsstCategory(id) {
  const cat = ASST_CATS.find((c) => c.id === id);
  if (cat) openAsstCatForm(cat);
}

async function deleteAsstCategory(id) {
  const cat = ASST_CATS.find((c) => c.id === id);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '删除分类', message: '仅删除空分类。确认删除「' + ((cat && cat.name) || '分类') + '」？', danger: true, confirmText: '删除' })
    : confirm('确认删除该分类？');
  if (!ok) return;
  const r = await api('/api/admin/assistants/categories/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
  if (ASST_FILTER === id) ASST_FILTER = 'all';
  await loadAssistants();
}

async function deleteAsst(id) {
  const a = ASST_ITEMS.find((x) => x.id === id);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '删除助手', message: '确认删除公共助手「' + ((a && a.name) || '助手') + '」？所有用户将看不到它。', danger: true, confirmText: '删除' })
    : confirm('确认删除该公共助手？');
  if (!ok) return;
  const r = await api('/api/admin/assistants/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
  await loadAssistants();
}

(function bindAssistantAdmin() {
  if ($('asst-add-cat')) $('asst-add-cat').addEventListener('click', addAsstCategory);
  if ($('asst-add')) $('asst-add').addEventListener('click', () => openAsstForm(null));
  if ($('asst-form-close')) $('asst-form-close').addEventListener('click', closeAsstForm);
  if ($('asst-form-cancel')) $('asst-form-cancel').addEventListener('click', closeAsstForm);
  if ($('asst-form-save')) $('asst-form-save').addEventListener('click', saveAsstForm);
  if ($('asst-cat-close')) $('asst-cat-close').addEventListener('click', closeAsstCatForm);
  if ($('asst-cat-cancel')) $('asst-cat-cancel').addEventListener('click', closeAsstCatForm);
  if ($('asst-cat-save')) $('asst-cat-save').addEventListener('click', saveAsstCatForm);
  if ($('asc-name')) {
    $('asc-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveAsstCatForm(); }
    });
  }
  const modal = $('asst-form-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeAsstForm(); });
  const catModal = $('asst-cat-modal');
  if (catModal) catModal.addEventListener('click', (e) => { if (e.target === catModal) closeAsstCatForm(); });
  if ($('asst-cats')) {
    $('asst-cats').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-cat]');
      if (!tab) return;
      ASST_FILTER = tab.dataset.cat;
      renderAssistantCats();
      renderAssistants();
    });
  }
  if ($('asst-body')) {
    $('asst-body').addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const act = actEl.dataset.act;
      const id = actEl.dataset.id;
      if (act === 'edit') return openAsstForm(ASST_ITEMS.find((a) => a.id === id));
      if (act === 'del') return deleteAsst(id);
      if (act === 'rename-cat') return renameAsstCategory(id);
      if (act === 'del-cat') return deleteAsstCategory(id);
    });
  }
})();

// ===== 邮件模板编辑器状态 =====
const MAIL_TPL = { active: 'verify', siteName: 'TinyChat', tpl: { verify: { subject: '', html: '' }, reset: { subject: '', html: '' } } };
function mailTplRenderPreview() {
  const frame = $('mtpl-preview'); if (!frame) return;
  const t = MAIL_TPL.tpl[MAIL_TPL.active] || { subject: '', html: '' };
  const sample = { '{siteName}': MAIL_TPL.siteName || 'TinyChat', '{name}': '示例用户', '{link}': location.origin + '/login?verify=sample-token', '{expires}': MAIL_TPL.active === 'reset' ? '1 小时' : '24 小时' };
  let html = String(t.html || '');
  Object.keys(sample).forEach((k) => { html = html.split(k).join(sample[k]); });
  frame.srcdoc = html;
}
function mailTplSyncInputs() {
  const t = MAIL_TPL.tpl[MAIL_TPL.active] || { subject: '', html: '' };
  const s = $('mtpl-subject'), h = $('mtpl-html');
  if (s) s.value = t.subject || '';
  if (h) h.value = t.html || '';
  mailTplRenderPreview();
}
function mailTplBind() {
  const subj = $('mtpl-subject'), body = $('mtpl-html');
  let timer = 0;
  const onEdit = () => {
    const t = MAIL_TPL.tpl[MAIL_TPL.active]; if (!t) return;
    if (subj) t.subject = subj.value;
    if (body) t.html = body.value;
    clearTimeout(timer); timer = setTimeout(mailTplRenderPreview, 250);
  };
  if (subj) subj.addEventListener('input', onEdit);
  if (body) body.addEventListener('input', onEdit);
  const tabs = $('mtpl-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mtpl]'); if (!btn) return;
    MAIL_TPL.active = btn.dataset.mtpl === 'reset' ? 'reset' : 'verify';
    tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    mailTplSyncInputs();
  });
  const defBtn = $('mtpl-defaults');
  if (defBtn) defBtn.addEventListener('click', async () => {
    const r = await api('/api/admin/settings/mail-template-defaults');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.templates) return toast((d.error && d.error.message) || '获取默认模板失败', true);
    MAIL_TPL.tpl.verify = { subject: d.templates.verifySubject || '', html: d.templates.verifyHtml || '' };
    MAIL_TPL.tpl.reset = { subject: d.templates.resetSubject || '', html: d.templates.resetHtml || '' };
    mailTplSyncInputs();
    toast('已恢复默认模板，记得点「保存验证设置」生效');
  });
  const testBtn = $('smtp-test-btn');
  if (testBtn) testBtn.addEventListener('click', async () => {
    testBtn.disabled = true; const old = testBtn.textContent; testBtn.textContent = '发送中…';
    try {
      const r = await api('/api/admin/settings/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ($('smtp-test-to') || {}).value || '' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) toast((d.error && d.error.message) || '发送失败', true);
      else toast('测试邮件已发送到 ' + (d.to || '你的邮箱') + '，请查收');
    } catch (e) { toast('发送失败，请检查网络', true); }
    finally { testBtn.disabled = false; testBtn.textContent = old; }
  });
}

async function loadVerifySettings() {
  const r = await api('/api/admin/settings'); const d = await r.json(); if (!r.ok) return;
  const s = d.settings || {}; const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
  ['verify-email-enabled','verify-reset-enabled','verify-quota-unlimited'].forEach((id, i) => { const e=$(id); if(e) e.checked=!![s.emailVerificationEnabled,s.passwordResetEnabled,s.freeQuotaUnlimited][i]; });
  set('verify-free-quota', s.freeQuota); const smtp=s.smtp||{}; set('smtp-host',smtp.host); set('smtp-port',smtp.port||587); set('smtp-user',smtp.username); set('smtp-pass',smtp.password); set('smtp-encryption',smtp.encryption||'tls'); set('smtp-from-name',smtp.fromName||'TinyChat'); set('smtp-from-email',smtp.fromEmail);
  set('session-days', s.sessionDays || 7);
  if ($('apikeys-enabled')) $('apikeys-enabled').checked = s.apiKeysEnabled !== false;
  if ($('invite-required')) $('invite-required').checked = !!s.registerInviteRequired;
  if ($('guest-enabled')) $('guest-enabled').checked = !!s.guestEnabled;
  set('guest-rounds', s.guestRounds || 3);
  // 注册与账号安全(allowRegister 后端强制:关掉后注册接口 403)
  if ($('register-open')) $('register-open').checked = s.allowRegister !== false;
  set('register-limit', s.registerLimitPerHour || 5);
  if ($('user-providers-allowed')) $('user-providers-allowed').checked = s.allowUserProviders !== false;
  set('login-max-fails', s.loginMaxFails != null ? s.loginMaxFails : 5);
  set('login-lock-sec', s.loginLockMs != null ? Math.round(s.loginLockMs / 1000) : 60);
  const tpl = s.mailTemplates || {};
  MAIL_TPL.siteName = s.siteName || 'TinyChat';
  MAIL_TPL.tpl.verify = { subject: tpl.verifySubject || '', html: tpl.verifyHtml || '' };
  MAIL_TPL.tpl.reset = { subject: tpl.resetSubject || '', html: tpl.resetHtml || '' };
  MAIL_TPL.loaded = true;
  mailTplBind();
  mailTplSyncInputs();
  loadInvites();
}
async function loadInvites() {
  try {
    const r = await api('/api/admin/invites');
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '邀请码加载失败', true);
    if ($('invite-required')) $('invite-required').checked = !!d.required;
    const codes = d.codes || [];
    const usable = codes.filter((c) => c.usable).length;
    if ($('invite-count-info')) $('invite-count-info').textContent = '可用 ' + usable + ' / 共 ' + codes.length + ' 张';
    const tb = $('invite-tbody');
    if (!tb) return;
    tb.innerHTML = codes.map((c) => {
      const max = typeof c.maxUses === 'number' ? c.maxUses : 1;
      const used = typeof c.usedCount === 'number' ? c.usedCount : (c.usedBy ? 1 : 0);
      const limit = max < 0 ? '不限' : String(max);
      const status = c.usable
        ? '<b>可用</b>'
        : '<span class="muted">已用完</span>';
      const usage = used + ' / ' + limit
        + (c.usedByName ? '<div class="muted small">最后：' + escapeHtml(c.usedByName) + '</div>' : '');
      return '<tr><td><code>' + escapeHtml(c.code) + '</code></td><td>' + status + '</td><td class="muted small">' + usage + '</td>'
        + '<td style="text-align:right"><button class="btn small danger" data-del-invite="' + escapeHtml(c.code) + '" type="button">删除</button></td></tr>';
    }).join('');
    if ($('invite-empty')) $('invite-empty').style.display = codes.length ? 'none' : 'block';
    tb.querySelectorAll('[data-del-invite]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await api('/api/admin/invites/' + encodeURIComponent(btn.dataset.delInvite), { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
        loadInvites();
      });
    });
  } catch (e) { toast('邀请码加载失败: ' + e.message, true); }
}
(function initInvites() {
  const gen = $('invite-generate');
  if (!gen) return;
  gen.addEventListener('click', async () => {
    gen.disabled = true;
    try {
      const count = Math.min(50, Math.max(1, parseInt($('invite-count') && $('invite-count').value, 10) || 5));
      const rawMax = parseInt($('invite-max-uses') && $('invite-max-uses').value, 10);
      const maxUses = Number.isFinite(rawMax) && rawMax < 0 ? -1 : Math.min(10000, Math.max(1, rawMax || 1));
      const prefix = (($('invite-prefix') && $('invite-prefix').value) || '').trim();
      const r = await api('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, maxUses, prefix }),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '生成失败', true);
      toast('已生成 ' + (d.created || []).length + ' 个邀请码');
      loadInvites();
    } catch (e) {
      toast('生成失败: ' + e.message, true);
    } finally { gen.disabled = false; }
  });
  // 「注册需要邀请码」属于验证设置,改动后随验证设置一并保存
  const req = $('invite-required');
  if (req) req.addEventListener('change', () => { const sv = $('verify-save'); if (sv) sv.click(); });
})();

// ============ 开放 API(OpenAI 兼容出口)设置 ============
let OPENAPI_MODELS = [];   // [{providerId, providerName, models:[{id,name}]}]
async function loadOpenApi() {
  const [rs, rp] = await Promise.all([api('/api/admin/settings'), api('/api/providers')]);
  const ds = await rs.json();
  const dp = await rp.json();
  if (!rs.ok) return toast((ds.error && ds.error.message) || '加载失败', true);
  const s = ds.settings || {};
  if ($('apikeys-enabled')) $('apikeys-enabled').checked = s.apiKeysEnabled !== false;
  if ($('openapi-key-limit')) $('openapi-key-limit').value = s.apiKeyRateLimitPerMin == null ? 60 : s.apiKeyRateLimitPerMin;
  if ($('openapi-user-limit-hint')) $('openapi-user-limit-hint').textContent = (s.rateLimitPerMin == null ? 30 : s.rateLimitPerMin) + ' 次/分钟';
  const exposed = new Set(Array.isArray(s.apiExposedModels) ? s.apiExposedModels : []);
  if ($('openapi-restrict')) $('openapi-restrict').checked = exposed.size > 0;
  OPENAPI_MODELS = (dp.providers || [])
    .filter((p) => p.scope === 'global' && p.enabled !== false && Array.isArray(p.models) && p.models.length)
    .map((p) => ({ providerId: p.id, providerName: p.name, models: p.models }));
  renderOpenApiModels(exposed);
}
function renderOpenApiModels(exposed) {
  const box = $('openapi-models');
  if (!box) return;
  const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
  if (!OPENAPI_MODELS.length) {
    box.innerHTML = '<p class="muted small">暂无可用的全局供应商模型，请先在「供应商」中添加。</p>';
  } else {
    box.innerHTML = OPENAPI_MODELS.map((g) => {
      const items = g.models.map((m) => {
        const key = g.providerId + '|' + m.id;
        const on = !restrict || exposed.has(key);
        return '<label class="access-model' + (restrict ? '' : ' disabled') + '">'
          + '<input type="checkbox" data-expose="' + escapeHtml(key) + '"' + (on ? ' checked' : '') + (restrict ? '' : ' disabled') + '>'
          + escapeHtml(m.name || m.id) + '</label>';
      }).join('');
      return '<div class="access-row"><div class="access-prov">' + escapeHtml(g.providerName) + '</div>'
        + '<div class="access-models">' + items + '</div></div>';
    }).join('');
  }
  updateOpenApiCount();
}
function updateOpenApiCount() {
  const el = $('openapi-model-count');
  if (!el) return;
  const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
  if (!restrict) { el.textContent = '当前：全部模型可用'; return; }
  const total = OPENAPI_MODELS.reduce((n, g) => n + g.models.length, 0);
  const picked = document.querySelectorAll('#openapi-models [data-expose]:checked').length;
  el.textContent = '已选 ' + picked + ' / ' + total + ' 个模型';
}
(function initOpenApi() {
  const box = $('openapi-models');
  if (!box) return;
  $('openapi-restrict')?.addEventListener('change', () => { renderOpenApiModels(new Set()); });
  box.addEventListener('change', (e) => { if (e.target.closest('[data-expose]')) updateOpenApiCount(); });
  $('openapi-select-all')?.addEventListener('click', () => {
    box.querySelectorAll('[data-expose]').forEach((c) => { c.checked = true; });
    updateOpenApiCount();
  });
  $('openapi-select-none')?.addEventListener('click', () => {
    box.querySelectorAll('[data-expose]').forEach((c) => { c.checked = false; });
    updateOpenApiCount();
  });
  $('openapi-fetch')?.addEventListener('click', async () => {
    const btn = $('openapi-fetch');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '获取中…';
    try {
      const r = await api('/api/providers?refresh=1');
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '获取失败');
      OPENAPI_MODELS = (d.providers || [])
        .filter((p) => p.scope === 'global' && p.enabled !== false && Array.isArray(p.models) && p.models.length)
        .map((p) => ({ providerId: p.id, providerName: p.name, models: p.models }));
      renderOpenApiModels(new Set());
      toast('已刷新模型列表');
    } catch (e) {
      toast('获取失败: ' + e.message, true);
    } finally { btn.disabled = false; btn.textContent = old; }
  });
  $('openapi-save')?.addEventListener('click', async () => {
    const btn = $('openapi-save');
    btn.disabled = true;
    try {
      const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
      const list = restrict
        ? Array.from(box.querySelectorAll('[data-expose]:checked')).map((c) => c.dataset.expose)
        : [];
      const payload = {
        apiKeysEnabled: !!($('apikeys-enabled') && $('apikeys-enabled').checked),
        apiKeyRateLimitPerMin: Math.min(600, Math.max(0, parseInt($('openapi-key-limit') && $('openapi-key-limit').value, 10) || 0)),
        apiExposedModels: list,
      };
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('开放 API 设置已保存');
      loadOpenApi();
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally { btn.disabled = false; }
  });
})();
let CODES_CACHE = [];
const CODES_PAGE_SIZE = 20;
let CODES_PAGE = 1;
function filteredCodes() {
  const q = ($('codes-search') && $('codes-search').value || '').trim().toLowerCase();
  return CODES_CACHE.filter((c) => !q
    || (c.packageName || '').toLowerCase().includes(q)
    || (c.status || '').toLowerCase().includes(q)
    || (c.codeMask || '').toLowerCase().includes(q));
}
function renderCodesList() {
  const list = $('codes-list'); if (!list) return;
  const rows = filteredCodes();
  const used = CODES_CACHE.filter((c) => c.status === 'used').length;
  const summary = $('codes-summary');
  if (summary) summary.textContent = '共 ' + CODES_CACHE.length + ' 张，已使用 ' + used + ' 张，未使用 ' + (CODES_CACHE.length - used) + ' 张';
  const pages = Math.max(1, Math.ceil(rows.length / CODES_PAGE_SIZE));
  if (CODES_PAGE > pages) CODES_PAGE = pages;
  const pageRows = rows.slice((CODES_PAGE - 1) * CODES_PAGE_SIZE, CODES_PAGE * CODES_PAGE_SIZE);
  const pager = $('codes-pager');
  if (pager) {
    pager.classList.toggle('hidden', pages <= 1);
    const label = $('codes-page-label');
    if (label) label.textContent = '第 ' + CODES_PAGE + ' / ' + pages + ' 页 · 共 ' + rows.length + ' 条';
    const prev = $('codes-prev'), next = $('codes-next');
    if (prev) prev.disabled = CODES_PAGE <= 1;
    if (next) next.disabled = CODES_PAGE >= pages;
  }
  if (!pageRows.length) { list.innerHTML = '<span class="muted small">' + (CODES_CACHE.length ? '没有匹配的兑换码' : '还没有生成过兑换码') + '</span>'; return; }
  list.innerHTML = pageRows.map((c) => {
    const isFixed = c.type === 'fixed';
    const expired = isFixed && c.expiresAt && Date.now() > c.expiresAt;
    const remain = isFixed ? Math.max(0, (c.maxRedemptions || 1) - (c.usedCount || 0)) : 0;
    const statusTxt = !isFixed ? (c.status === 'used' ? '已使用' : '未使用')
      : (c.status === 'used' ? '已用完' : (expired ? '已过期' : '剩 ' + remain + ' 次'));
    const info = isFixed
      ? ' · 每次兑 +' + (c.quota === -1 ? '无限' : c.quota) + ' 次 · 已兑 ' + (c.usedCount || 0) + '/' + (c.maxRedemptions || 1)
        + ' · ' + (c.expiresAt ? '有效期至 ' + fmtTime(c.expiresAt) : '长期有效')
        + (c.perUserLimit ? ' · 每人限兑一次' : '')
      : '';
    return '<div class="row-between" data-code="' + escapeHtml(c.id) + '">'
      + '<span><code>' + escapeHtml(c.codeMask || '') + '</code> · ' + escapeHtml(c.packageName || '')
      + '<span class="muted small"> 生成于 ' + (c.createdAt ? fmtTime(c.createdAt) : '-') + info
      + (c.status === 'used' && !isFixed ? ' · 使用于 ' + (c.usedAt ? fmtTime(c.usedAt) : '-') + (c.usedByName ? ' · 使用者 ' + escapeHtml(c.usedByName) : '') : '')
      + (isFixed && (c.usedCount || 0) > 0 && c.usedAt ? ' · 最近使用 ' + fmtTime(c.usedAt) + (c.usedByName ? ' · ' + escapeHtml(c.usedByName) : '') : '')
      + '</span></span>'
      + '<span class="row-between" style="gap:8px"><span class="' + ((c.status === 'used' || expired) ? 'muted' : '') + '">' + statusTxt + '</span>'
      + '<button class="btn small danger" data-delcode type="button">删除</button></span>'
      + '</div>';
  }).join('');
  list.querySelectorAll('[data-delcode]').forEach((btn) => btn.addEventListener('click', async () => {
    const row = btn.closest('[data-code]'); const id = row && row.dataset.code;
    const c = CODES_CACHE.find((x) => x.id === id); if (!c) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除兑换码', message: '确认删除这张「' + c.packageName + '」的兑换码？删除后无法兑换。', danger: true, confirmText: '删除' })
      : confirm('确认删除该兑换码？删除后无法兑换。');
    if (!ok) return;
    const r = await api('/api/admin/codes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) return toast('删除失败', true);
    toast('已删除'); loadPackages();
  }));
}

let PKG_EDITING_ID = '';
let PKG_CACHE = [];

function pkgPriceLabel(p) {
  if (p.price !== null && p.price !== undefined && p.price !== '') return (parseFloat(p.price) === 0) ? '免费' : '¥' + p.price;
  return p.priceLabel || '';
}

function renderPackageCards() {
  const list = $('pkg-list'); if (!list) return;
  if (!PKG_CACHE.length) { list.innerHTML = '<p class="muted small">还没有套餐，用上方表单创建第一个套餐。</p>'; return; }
  list.innerHTML = PKG_CACHE.map((p) => {
    const priceTxt = pkgPriceLabel(p);
    const free = p.price !== null && p.price !== undefined && parseFloat(p.price) === 0;
    const validity = (p.validityDays && p.validityDays > 0) ? p.validityDays + ' 天有效' : '永久有效';
    const quotaTxt = p.quota === -1 ? '无限次' : p.quota + ' 次';
    const limit = (p.limitPerUser != null) ? parseInt(p.limitPerUser, 10) : 1;
    const limitTxt = free ? (limit === -1 ? '不限次领取' : (limit === 0 ? '暂不可领取' : '每人限领 ' + limit + ' 次')) : '';
    return '<div class="pkg-card' + (p.enabled ? '' : ' pkg-card-off') + '" data-id="' + escapeHtml(p.id) + '">'
      + '<div class="pkg-card-top"><span class="pkg-card-name">' + escapeHtml(p.name) + '</span>'
      + (free ? '<span class="pkg-tag pkg-tag-free">0 元领取</span>' : (priceTxt ? '<span class="pkg-tag">' + escapeHtml(priceTxt) + '</span>' : ''))
      + (limitTxt ? '<span class="pkg-tag">' + escapeHtml(limitTxt) + '</span>' : '')
      + (!p.enabled ? '<span class="pkg-tag pkg-tag-off">已停用</span>' : '')
      + (PKG_EDITING_ID === p.id ? '<span class="pkg-tag pkg-tag-edit">编辑中</span>' : '') + '</div>'
      + '<div class="pkg-card-stats"><span><b>' + escapeHtml(quotaTxt) + '</b><i>对话次数</i></span><span><b>' + escapeHtml(validity) + '</b><i>有效期</i></span><span><b>' + (priceTxt ? escapeHtml(priceTxt) : '—') + '</b><i>价格</i></span></div>'
      + (p.description ? '<p class="pkg-card-desc">' + escapeHtml(p.description) + '</p>' : '')
      + (p.purchaseUrl ? '<p class="pkg-card-url muted small">购买链接：' + escapeHtml(p.purchaseUrl) + '</p>' : '')
      + '<div class="pkg-card-actions">'
      + '<button class="btn small" data-pkg-edit type="button">编辑</button>'
      + '<button class="btn small" data-pkg-codes type="button">生成兑换码</button>'
      + '<button class="btn small danger" data-pkg-del type="button">删除</button>'
      + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-pkg-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const card = btn.closest('[data-id]'); const p = PKG_CACHE.find((x) => x.id === card.dataset.id); if (!p) return;
    PKG_EDITING_ID = p.id;
    $('pkg-name').value = p.name || '';
    $('pkg-quota').value = p.quota;
    $('pkg-validity').value = p.validityDays || 0;
    $('pkg-limit').value = (p.limitPerUser != null) ? p.limitPerUser : 1;
    $('pkg-price').value = (p.price !== null && p.price !== undefined) ? p.price : '';
    $('pkg-url').value = p.purchaseUrl || '';
    $('pkg-desc').value = p.description || '';
    const cancel = $('pkg-cancel-edit'); if (cancel) cancel.hidden = false;
    renderPackageCards();
    $('pkg-name').focus();
  }));
  list.querySelectorAll('[data-pkg-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-id]'); const p = PKG_CACHE.find((x) => x.id === card.dataset.id); if (!p) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除套餐', message: '确认删除套餐「' + p.name + '」？已生成的兑换码将无法再兑换。', danger: true, confirmText: '删除' })
      : confirm('确认删除套餐「' + p.name + '」？');
    if (!ok) return;
    const r = await api('/api/admin/packages/' + encodeURIComponent(p.id), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
    if (PKG_EDITING_ID === p.id) { PKG_EDITING_ID = ''; const cancel = $('pkg-cancel-edit'); if (cancel) cancel.hidden = true; }
    toast('套餐已删除'); loadPackages();
  }));
  list.querySelectorAll('[data-pkg-codes]').forEach((btn) => btn.addEventListener('click', () => {
    const card = btn.closest('[data-id]');
    const sel = $('pkg-code-package'); if (sel) sel.value = card.dataset.id;
    const count = $('pkg-code-count'); if (count) { count.focus(); count.select(); }
    toast('已在下方兑换码面板选中该套餐，设置数量后点「生成兑换码」');
  }));
}

async function loadPackages() {
  const r=await api('/api/admin/packages'); const d=await r.json(); if(!r.ok)return; const list=$('pkg-list'), sel=$('pkg-code-package'), bulk=$('codes-bulk-package');
  PKG_CACHE = d.packages || [];
  const opts=PKG_CACHE.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</option>').join('');
  if(sel) sel.innerHTML=opts;
  if(bulk) bulk.innerHTML=opts;
  if (list) renderPackageCards();
  CODES_CACHE = (d.codes || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  renderCodesList();
}
(function initCodesPanel(){
  const search = $('codes-search');
  if (search) search.addEventListener('input', () => { CODES_PAGE = 1; renderCodesList(); });
  const prev = $('codes-prev'); if (prev) prev.addEventListener('click', () => { CODES_PAGE--; renderCodesList(); });
  const next = $('codes-next'); if (next) next.addEventListener('click', () => { CODES_PAGE++; renderCodesList(); });
  const prune = $('codes-prune');
  if (prune) prune.addEventListener('click', async () => {
    const usedCount = CODES_CACHE.filter((c) => c.status === 'used').length;
    if (!usedCount) return toast('没有已使用的兑换码');
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清理已使用', message: '确认删除全部 ' + usedCount + ' 张已使用的兑换码记录？未使用的兑换码不受影响。', danger: true, confirmText: '清理' })
      : confirm('确认删除全部 ' + usedCount + ' 张已使用的兑换码记录？');
    if (!ok) return;
    const r = await api('/api/admin/codes/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'used' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '清理失败', true);
    toast('已清理 ' + (d.removed || 0) + ' 张'); loadPackages();
  });
  // 按套餐批量导出未使用兑换码明文
  const exp = $('codes-export-unused');
  if (exp) exp.addEventListener('click', async () => {
    const bulkSel = $('codes-bulk-package'); const pid = bulkSel && bulkSel.value;
    if (!pid) return toast('请先选择套餐', true);
    const r = await api('/api/admin/packages/' + encodeURIComponent(pid) + '/codes/export');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '导出失败', true);
    const codes = (d.codes || []).map((x) => x.code);
    if (!codes.length) return toast('该套餐没有可导出的未使用兑换码' + (d.missing ? '（另有 ' + d.missing + ' 张旧码未存明文）' : ''), true);
    const blob = new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '兑换码-' + (d.packageName || pid) + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出 ' + codes.length + ' 张' + (d.missing ? '（另有 ' + d.missing + ' 张旧码未存明文）' : ''));
  });
  // 按套餐批量清除未使用兑换码
  const clr = $('codes-clear-unused');
  if (clr) clr.addEventListener('click', async () => {
    const bulkSel = $('codes-bulk-package'); const pid = bulkSel && bulkSel.value;
    if (!pid) return toast('请先选择套餐', true);
    const pkgName = (bulkSel.selectedOptions && bulkSel.selectedOptions[0]) ? bulkSel.selectedOptions[0].textContent : pid;
    const n = CODES_CACHE.filter((c) => c.packageId === pid && c.status !== 'used').length;
    if (!n) return toast('该套餐没有未使用的兑换码');
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清除未使用兑换码', message: '确认删除「' + pkgName + '」全部 ' + n + ' 张未使用的兑换码？删除后无法兑换，已使用的不受影响。', danger: true, confirmText: '清除' })
      : confirm('确认删除「' + pkgName + '」全部 ' + n + ' 张未使用的兑换码？');
    if (!ok) return;
    const r = await api('/api/admin/codes/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'unused', packageId: pid }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '清除失败', true);
    toast('已清除 ' + (d.removed || 0) + ' 张'); loadPackages();
  });
  // 添加固定兑换码
  const fa = $('fixed-code-add');
  if (fa) fa.addEventListener('click', async () => {
    const code = ($('fixed-code-value').value || '').trim();
    if (!code) return toast('请输入兑换码', true);
    const quotaRaw = parseInt($('fixed-code-quota').value, 10);
    if (isNaN(quotaRaw) || (quotaRaw !== -1 && quotaRaw < 1)) return toast('可用次数需大于 0，或填 -1 表示无限', true);
    const body = { code: code, quota: quotaRaw, maxRedemptions: parseInt($('fixed-code-max').value, 10) || 1, perUserLimit: !!(($('fixed-code-peruser') || {}).checked) };
    const expiryVal = ($('fixed-code-expiry').value || '').trim();
    if (expiryVal) {
      const t = new Date(expiryVal).getTime();
      if (!isFinite(t)) return toast('有效期格式不正确', true);
      if (t <= Date.now()) return toast('有效期必须晚于当前时间', true);
      body.expiresAt = t;
    }
    const r = await api('/api/admin/codes/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '添加失败', true);
    toast('固定兑换码已添加'); $('fixed-code-value').value = ''; loadPackages();
  });
})();
(function initVerifyAndPackages(){
  const save=$('verify-save'); if(save) save.addEventListener('click',async()=>{ const tplPayload=MAIL_TPL.loaded?{mailTemplates:{tplVersion:2,verifySubject:MAIL_TPL.tpl.verify.subject,verifyHtml:MAIL_TPL.tpl.verify.html,resetSubject:MAIL_TPL.tpl.reset.subject,resetHtml:MAIL_TPL.tpl.reset.html}}:{}; const payload=Object.assign({emailVerificationEnabled:!!$('verify-email-enabled').checked,passwordResetEnabled:!!$('verify-reset-enabled').checked,freeQuotaUnlimited:!!$('verify-quota-unlimited').checked,freeQuota:parseInt($('verify-free-quota').value,10)||0,sessionDays:Math.min(30,Math.max(1,parseInt($('session-days')&&$('session-days').value,10)||7)),apiKeysEnabled:!!($('apikeys-enabled')&&$('apikeys-enabled').checked),registerInviteRequired:!!($('invite-required')&&$('invite-required').checked),guestEnabled:!!($('guest-enabled')&&$('guest-enabled').checked),guestRounds:Math.min(1000,Math.max(1,parseInt($('guest-rounds')&&$('guest-rounds').value,10)||3)),allowRegister:!!($('register-open')&&$('register-open').checked),registerLimitPerHour:Math.min(1000,Math.max(1,parseInt($('register-limit')&&$('register-limit').value,10)||5)),allowUserProviders:!!($('user-providers-allowed')&&$('user-providers-allowed').checked),loginMaxFails:Math.min(50,Math.max(0,parseInt($('login-max-fails')&&$('login-max-fails').value,10)||0)),loginLockMs:Math.min(3600000,Math.max(0,parseInt($('login-lock-sec')&&$('login-lock-sec').value,10)||0))*1000,smtp:{host:$('smtp-host').value.trim(),port:parseInt($('smtp-port').value,10)||587,username:$('smtp-user').value.trim(),password:$('smtp-pass').value,encryption:$('smtp-encryption').value,fromName:$('smtp-from-name').value.trim(),fromEmail:$('smtp-from-email').value.trim()}},tplPayload); const r=await api('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'保存失败',true); toast('验证设置已保存'); });
  const invalidate=$('session-invalidate'); if(invalidate) invalidate.addEventListener('click',async()=>{
    const ok=window.OCUI&&OCUI.confirm?await OCUI.confirm({title:'强制全站下线',message:'所有人的现有登录态会立即失效（包括你自己），需要重新登录。确认执行？',danger:true,confirmText:'执行'}):confirm('所有人的现有登录态会立即失效（包括你自己），确认执行？');
    if(!ok) return;
    try { const r=await api('/api/admin/session/invalidate',{method:'POST'}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'操作失败',true); toast('已强制全站下线，即将重新登录'); setTimeout(()=>{ localStorage.removeItem('oc_token'); localStorage.removeItem('oc_user'); location.href=apiUrl('/login'); },1200); } catch(e) { toast('操作失败: '+e.message,true); }
  });
  const ps=$('pkg-save'); if(ps) ps.addEventListener('click',async()=>{
    const priceRaw=$('pkg-price').value.trim();
    const price=(priceRaw===''?'':parseFloat(priceRaw));
    const priceLabel=(priceRaw===''?'':(parseFloat(priceRaw)===0?'免费':'¥'+priceRaw));
    var limRaw = parseInt($('pkg-limit').value, 10);
    var limitPerUser = isNaN(limRaw) ? 1 : Math.max(-1, Math.min(999, limRaw));
    const b={id:PKG_EDITING_ID||'',name:$('pkg-name').value.trim(),quota:parseInt($('pkg-quota').value,10)||0,validityDays:parseInt($('pkg-validity').value,10)||0,limitPerUser:limitPerUser,price:price,priceLabel:priceLabel,purchaseUrl:$('pkg-url').value.trim(),description:$('pkg-desc').value.trim(),enabled:true};
    if(!b.name) return toast('请填写套餐名称',true);
    const r=await api('/api/admin/packages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); const d=await r.json();
    if(!r.ok) return toast((d.error&&d.error.message)||'保存失败',true);
    toast(PKG_EDITING_ID?'套餐已更新':'套餐已创建');
    PKG_EDITING_ID=''; const cancel=$('pkg-cancel-edit'); if(cancel) cancel.hidden=true;
    $('pkg-name').value=''; $('pkg-desc').value='';
    loadPackages();
  });
  const pc=$('pkg-cancel-edit'); if(pc) pc.addEventListener('click',()=>{PKG_EDITING_ID='';pc.hidden=true;toast('已取消编辑');loadPackages();});
  const pg=$('pkg-generate'); if(pg) pg.addEventListener('click',async()=>{const id=$('pkg-code-package').value; const r=await api('/api/admin/packages/'+encodeURIComponent(id)+'/codes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:parseInt($('pkg-code-count').value,10)||1})}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'生成失败',true); $('pkg-generated-codes').value=(d.codes||[]).join('\n');toast('兑换码已生成');loadPackages();});
})();

// ============ AI 思考策略 ============
let THINKING = null;
let TH_EDIT_ID = '';
const TH_MODE_LABEL = { map: '自动映射', force: '强制档位', off: '禁用思考' };

async function loadThinking() {
  const r = await api('/api/admin/thinking'); const d = await r.json(); if (!r.ok) return;
  THINKING = d.thinking || { defaultEffort: 'medium', allowUserOverride: true, autoLearn: true, rules: [] };
  renderThinking();
}

function renderThinking() {
  if (!THINKING) return;
  $('th-default').value = THINKING.defaultEffort || 'medium';
  $('th-override').checked = !!THINKING.allowUserOverride;
  $('th-learn').checked = !!THINKING.autoLearn;
  const list = $('thinking-rules'); if (!list) return;
  const rules = THINKING.rules || [];
  $('th-rule-count').textContent = rules.length ? rules.length + ' 条' : '';
  if (!rules.length) { list.innerHTML = '<p class="muted small">还没有规则。可在下方手动添加,或开启「自动学习」等上游报错时自动生成。</p>'; return; }
  list.innerHTML = rules.map((r) => {
    const detail = r.mode === 'force'
      ? '固定为「' + ({ low: '低', medium: '中', high: '高', max: '最大' }[r.forceEffort] || r.forceEffort) + '」'
      : (r.mode === 'map'
        ? '支持档位:' + ((r.levels || []).join(' / ') || '(空,等同学到后再填充)')
        : '移除全部推理参数');
    return '<div class="pkg-card' + (r.enabled ? '' : ' pkg-card-off') + '" data-id="' + escapeHtml(r.id) + '">'
      + '<div class="pkg-card-top"><span class="pkg-card-name">' + escapeHtml(r.match) + '</span>'
      + '<span class="pkg-tag">' + escapeHtml(TH_MODE_LABEL[r.mode] || r.mode) + '</span>'
      + ((r.source || '') === 'auto' ? '<span class="pkg-tag pkg-tag-free">自动学习</span>' : '<span class="pkg-tag">手动</span>')
      + (!r.enabled ? '<span class="pkg-tag pkg-tag-off">已停用</span>' : '')
      + '</div>'
      + '<p class="pkg-card-desc">' + escapeHtml(detail) + '</p>'
      + '<div class="pkg-card-actions">'
      + '<button class="btn small" data-th-toggle type="button">' + (r.enabled ? '停用' : '启用') + '</button>'
      + '<button class="btn small" data-th-edit type="button">编辑</button>'
      + '<button class="btn small danger" data-th-del type="button">删除</button>'
      + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-th-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    rule.enabled = !rule.enabled; saveThinking();
  }));
  list.querySelectorAll('[data-th-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    TH_EDIT_ID = id;
    $('th-form-title').textContent = '编辑规则';
    $('th-match').value = rule.match || '';
    $('th-mode').value = rule.mode || 'map';
    $('th-mode').dispatchEvent(new Event('change'));
    $('th-levels').value = (rule.levels || []).join(',');
    $('th-force').value = rule.forceEffort || 'medium';
    $('th-add').textContent = '更新规则';
    const cancel = $('th-cancel'); if (cancel) cancel.hidden = false;
    $('th-match').focus();
  }));
  list.querySelectorAll('[data-th-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除规则', message: '确认删除「' + rule.match + '」的思考规则?删除的自动规则可能在上游报错后重新生成。', danger: true, confirmText: '删除' })
      : confirm('确认删除「' + rule.match + '」的思考规则?');
    if (!ok) return;
    THINKING.rules = THINKING.rules.filter((x) => x.id !== id);
    const deleted = (rule.source || '') === 'auto' ? [id] : [];
    saveThinking(deleted);
  }));
}

async function saveThinking(deletedAutoIds) {
  const payload = {
    thinking: {
      defaultEffort: $('th-default').value,
      allowUserOverride: $('th-override').checked,
      autoLearn: $('th-learn').checked,
      rules: THINKING.rules,
    },
    deletedAutoIds: deletedAutoIds || [],
  };
  const r = await api('/api/admin/thinking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
  THINKING = d.thinking;
  renderThinking();
}

(function initThinkingPanel() {
  const modeSel = $('th-mode'); if (!modeSel) return;
  const syncMode = () => {
    const map = modeSel.value === 'map', force = modeSel.value === 'force';
    $('th-levels-wrap').hidden = !map;
    $('th-force-wrap').hidden = !force;
  };
  modeSel.addEventListener('change', syncMode);
  syncMode();
  ['th-default', 'th-override', 'th-learn'].forEach((id) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => saveThinking());
  });
  const resetForm = () => {
    TH_EDIT_ID = '';
    $('th-form-title').textContent = '添加规则';
    $('th-match').value = ''; $('th-levels').value = '';
    $('th-add').textContent = '添加规则';
    const cancel = $('th-cancel'); if (cancel) cancel.hidden = true;
  };
  $('th-add').addEventListener('click', () => {
    const match = $('th-match').value.trim();
    if (!match) return toast('请填写匹配关键词', true);
    const mode = $('th-mode').value;
    let levels = [];
    if (mode === 'map') {
      levels = $('th-levels').value.split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!levels.length) return toast('自动映射模式需要填写支持档位', true);
    }
    const rule = {
      id: TH_EDIT_ID || Math.random().toString(36).slice(2, 10),
      match, mode, levels,
      forceEffort: mode === 'force' ? $('th-force').value : '',
      enabled: true,
      updatedAt: Date.now(),
    };
    const existing = THINKING.rules.find((x) => x.id === rule.id);
    if (existing) Object.assign(existing, rule);
    else THINKING.rules.push(rule);
    saveThinking();
    resetForm();
  });
  $('th-cancel').addEventListener('click', resetForm);
})();

// ============ 版本更新 ============
let UPDATE_DATA = null;

function renderUpdate() {
  const d = UPDATE_DATA;
  if (!d) return;
  $('upd-current').textContent = 'v' + (d.current || '-');
  $('upd-cached').textContent = d.cached ? '（缓存于 ' + fmtTime(d.checkedAt) + '，点「检查更新」立即刷新）' : '';
  const latest = d.latest || {};
  const res = $('upd-result');
  if (d.hasUpdate) {
    $('upd-status').textContent = '发现新版本 v' + (latest.version || '?') + '，可一键更新。';
    $('upd-apply').classList.remove('hidden');
    res.classList.remove('hidden');
    $('upd-latest').textContent = 'v' + (latest.version || '?');
    $('upd-published').textContent = latest.publishedAt ? '发布于 ' + fmtTime(latest.publishedAt) : '';
    $('upd-notes').textContent = latest.notes || '（无发布说明）';
    $('upd-notes').hidden = !latest.notes;
    const link = $('upd-link');
    link.hidden = !latest.url;
    if (latest.url) link.href = latest.url;
  } else {
    $('upd-status').textContent = '已是最新版本。';
    $('upd-apply').classList.add('hidden');
    res.classList.add('hidden');
  }
  const last = d.lastUpdate;
  $('upd-last').textContent = last
    ? '上次在线更新：v' + last.from + ' → v' + last.to + '（' + fmtTime(last.at) + '）。更新前程序备份在 data/update/backup/。'
    : '';
}

async function checkUpdate(force) {
  const btn = $('upd-check');
  btn.disabled = true;
  $('upd-status').textContent = force ? '正在连接更新源…' : '正在读取检查结果…';
  try {
    const r = await api('/api/admin/update/check' + (force ? '?force=1' : ''));
    const d = await r.json();
    if (!r.ok) {
      $('upd-status').textContent = d.error && d.error.message ? d.error.message : '检查失败（HTTP ' + r.status + '）';
      return;
    }
    UPDATE_DATA = d;
    renderUpdate();
  } catch (e) {
    $('upd-status').textContent = '检查失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function performUpdate() {
  const d = UPDATE_DATA;
  if (!d || !d.hasUpdate) return;
  const ver = d.latest && d.latest.version ? d.latest.version : '';
  if (!confirm('确定要更新到 v' + ver + ' 吗？\n更新期间请勿关闭页面；data/ 数据目录与 config.php 不会被改动。')) return;
  const btn = $('upd-apply');
  btn.disabled = true;
  $('upd-status').textContent = '正在下载并应用更新，视主机网速可能需要 1-2 分钟，请勿关闭页面…';
  try {
    const r = await api('/api/admin/update/perform', { method: 'POST' });
    const res = await r.json();
    if (!r.ok) {
      $('upd-status').textContent = '更新失败：' + (res.error && res.error.message ? res.error.message : 'HTTP ' + r.status)
        + '。若为主机超时中断可重试；更新前程序备份在 data/update/backup/。';
      btn.disabled = false;
      return;
    }
    $('upd-status').textContent = '已更新到 v' + res.to + '，页面将在 3 秒后刷新加载新版本…';
    setTimeout(() => location.reload(), 3000);
  } catch (e) {
    $('upd-status').textContent = '更新失败: ' + e.message;
    btn.disabled = false;
  }
}

async function loadUpdatePanel() {
  UPDATE_DATA = null;
  $('upd-last').textContent = '';
  $('upd-result').classList.add('hidden');
  await checkUpdate(false);
}

(function bindUpdatePanel() {
  const check = $('upd-check');
  if (!check) return;
  check.addEventListener('click', () => checkUpdate(true));
  $('upd-apply').addEventListener('click', performUpdate);
})();

// ============ 页签切换(懒加载) ============
const tabLoaded = {};
// ============ 数据备份 ============
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
async function loadBackups() {
  try {
    const r = await api('/api/admin/backup');
    const d = await r.json();
    if ($('backup-enabled')) $('backup-enabled').checked = !!d.backupEnabled;
    if ($('backup-keep')) $('backup-keep').value = d.backupKeep || 7;
    const tb = $('backup-tbody');
    if (!tb) return;
    const list = d.backups || [];
    tb.innerHTML = list.map((b) => {
      const time = b.time ? new Date(b.time).toLocaleString('zh-CN') : '—';
      return '<tr><td>' + escapeHtml(b.name) + '</td><td>' + fmtBytes(b.size) + '</td><td>' + time + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + '<a class="btn small" href="' + apiUrl('/api/admin/backup/download?id=' + encodeURIComponent(b.name)) + '">下载</a> '
        + '<button class="btn small danger" data-restore="' + escapeHtml(b.name) + '" type="button">恢复</button></td></tr>';
    }).join('');
    if ($('backup-empty')) $('backup-empty').style.display = list.length ? 'none' : 'block';
    tb.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => restoreBackup(btn.dataset.restore));
    });
  } catch (e) {
    toast('备份列表加载失败: ' + e.message, true);
  }
}
async function restoreBackup(name) {
  const message = '确认用 ' + name + ' 整体替换当前数据库？恢复点之后的全部数据变更会丢失。';
  const ok = window.OCUI && OCUI.confirm
    ? await OCUI.confirm({ title: '恢复备份', message, danger: true, confirmText: '恢复' })
    : confirm(message);
  if (!ok) return;
  try {
    const r = await api('/api/admin/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name }),
    });
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '恢复失败', true);
    toast('已恢复（' + d.users + ' 个用户），即将刷新页面');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast('恢复失败: ' + e.message, true);
  }
}
(function initBackupUI() {
  const save = $('backup-save');
  if (save) save.addEventListener('click', async () => {
    const payload = {
      backupEnabled: !!($('backup-enabled') && $('backup-enabled').checked),
      backupKeep: Math.min(30, Math.max(1, parseInt($('backup-keep') && $('backup-keep').value, 10) || 7)),
    };
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
      toast('备份设置已保存');
      loadBackups();
    } catch (e) { toast('保存失败: ' + e.message, true); }
  });
  const nowBtn = $('backup-now');
  if (nowBtn) nowBtn.addEventListener('click', async () => {
    nowBtn.disabled = true;
    try {
      const r = await api('/api/admin/backup', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '备份失败', true);
      toast('已创建备份 ' + d.created);
      loadBackups();
    } catch (e) {
      toast('备份失败: ' + e.message, true);
    } finally { nowBtn.disabled = false; }
  });
})();

const TAB_LOADERS = {
  overview: () => { loadStats(); loadAnnouncement(); },
  usage: () => loadStats(),
  users: () => loadUsers(),
  groups: () => loadGroups(),
  access: async () => {
    await loadGroups();
    await loadAccess();
  },
  providers: () => loadProviders(),
  chat: () => loadChatSettings(),
  search: () => loadSearchSettings(),
  docs: () => loadSearchSettings(),
  verify: () => loadVerifySettings(),
  invite: () => loadInvites(),
  openapi: () => loadOpenApi(),
  packages: () => loadPackages(),
  codes: () => loadPackages(),
  'codes-gen': () => loadPackages(),
  'codes-fixed': () => loadPackages(),
  assistants: () => loadAssistants(),
  logs: () => loadLogs(),
  thinking: () => loadThinking(),
  update: async () => {
    loadUpdatePanel();
    await loadBackups();
  },
  moderation: () => loadModeration(),
};

// ============ 内容安全 ============
async function loadModeration() {
  const r = await api('/api/admin/settings');
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '加载失败', true);
  const s = d.settings || {};
  const mod = s.moderation || {};
  if ($('mod-enabled')) $('mod-enabled').checked = !!mod.enabled;
  if ($('mod-words')) $('mod-words').value = mod.words || '';
  if ($('agreement-enabled')) $('agreement-enabled').checked = !!s.agreementEnabled;
  if ($('agreement-html')) $('agreement-html').value = s.agreementHtml || '';
}
(function initModeration() {
  const save = $('moderation-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const payload = {
      moderation: {
        enabled: !!($('mod-enabled') && $('mod-enabled').checked),
        words: ($('mod-words') && $('mod-words').value) || '',
      },
      agreementEnabled: !!($('agreement-enabled') && $('agreement-enabled').checked),
      agreementHtml: ($('agreement-html') && $('agreement-html').value) || '',
    };
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
      toast('内容安全设置已保存');
      loadModeration();
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally { save.disabled = false; }
  });
})();

// ============ 全站公告 ============
let ANNOUNCE_LOADED_TEXT = '';
async function loadAnnouncement() {
  try {
    const r = await api('/api/admin/settings');
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '公告加载失败');
    const ann = (d.settings || {}).announcement || {};
    ANNOUNCE_LOADED_TEXT = ann.text || '';
    if ($('announce-enabled')) $('announce-enabled').checked = !!ann.enabled;
    if ($('announce-text')) $('announce-text').value = ANNOUNCE_LOADED_TEXT;
  } catch (e) {
    if ($('announce-status')) $('announce-status').textContent = '加载失败: ' + e.message;
  }
}
(function initAnnouncement() {
  const save = $('announce-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const textEl = $('announce-text');
    const status = $('announce-status');
    const text = ((textEl && textEl.value) || '').trim();
    const enabled = !!($('announce-enabled') && $('announce-enabled').checked);
    if (enabled && !text) {
      if (status) status.textContent = '启用公告时请填写公告内容';
      if (textEl) textEl.focus();
      return toast('启用公告时请填写公告内容', true);
    }
    const payload = { announcement: { enabled, text } };
    const oldLabel = save.textContent;
    save.disabled = true;
    save.textContent = '保存中…';
    if (status) status.textContent = '正在保存…';
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      const saved = (d.settings || {}).announcement || {};
      if (!!saved.enabled !== enabled || saved.text !== text) throw new Error('服务器未返回已保存的公告');
      ANNOUNCE_LOADED_TEXT = saved.text;
      if (textEl) textEl.value = saved.text;
      if (status) status.textContent = enabled ? '公告已发布' : '公告已关闭';
      toast(enabled ? '公告已发布' : '公告已关闭');
    } catch (e) {
      if (status) status.textContent = '保存失败: ' + e.message;
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
      save.textContent = oldLabel;
    }
  });
})();

// ============ 用量导出 ============
$('usage-export')?.addEventListener('click', async () => {
  const btn = $('usage-export');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/usage/export');
    if (!r.ok) return toast('导出失败', true);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tinychat-usage-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch (e) {
    toast('导出失败: ' + e.message, true);
  } finally { btn.disabled = false; }
});

const ADMIN_GROUPS = {
  overview: [{ id: 'overview', label: '概览' }, { id: 'usage', label: '用量分析' }, { id: 'logs', label: '运行日志' }],
  users: [{ id: 'users', label: '用户' }, { id: 'groups', label: '用户组' }, { id: 'access', label: '模型授权' }, { id: 'verify', label: '用户验证' }, { id: 'invite', label: '邀请码' }],
  billing: [
    { id: 'packages', label: '额度套餐' },
    { id: 'codes', label: '兑换码使用情况' },
    { id: 'codes-gen', label: '生成兑换码' },
    { id: 'codes-fixed', label: '添加固定兑换码' },
  ],
  platform: [{ id: 'providers', label: '供应商' }, { id: 'thinking', label: 'AI 思考' }, { id: 'chat', label: '对话设置' }, { id: 'openapi', label: '开放 API' }, { id: 'search', label: '联网搜索' }, { id: 'docs', label: '文档解析' }, { id: 'moderation', label: '内容安全' }, { id: 'update', label: '版本更新' }],
  thinking: [{ id: 'thinking', label: '思考策略' }],
  content: [{ id: 'assistants', label: '助手库' }],
};
function adminGroupForTab(tab) { return Object.keys(ADMIN_GROUPS).find((g) => ADMIN_GROUPS[g].some((x) => x.id === tab)) || 'overview'; }
function renderAdminSubnav(group, selected) {
  const box = $('admin-subnav'); if (!box) return;
  const items = ADMIN_GROUPS[group] || [];
  box.classList.toggle('is-single', items.length < 2);
  box.innerHTML = items.map((x) => '<button class="admin-subnav-btn' + (x.id === selected ? ' active' : '') + '" type="button" data-tab="' + x.id + '" role="tab" aria-selected="' + (x.id === selected ? 'true' : 'false') + '">' + x.label + '</button>').join('');
}
function showAdminTab(name, { load = true } = {}) {
  const group = adminGroupForTab(name);
  const entry = (ADMIN_GROUPS[group] || []).find((x) => x.id === name) || ADMIN_GROUPS[group][0];
  name = entry.id;
  document.querySelectorAll('.admin-group-tab').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
  renderAdminSubnav(group, name);
  document.querySelectorAll('.admin-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  const hash = '#' + group + '/' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const loader = TAB_LOADERS[name];
  if (load && loader && !tabLoaded[name]) { tabLoaded[name] = true; Promise.resolve(loader()).catch((e) => toast('加载失败: ' + e.message, true)); }
  return true;
}

$('admin-tabs').addEventListener('click', (e) => {
  const groupBtn = e.target.closest('.admin-group-tab');
  if (groupBtn) return showAdminTab((ADMIN_GROUPS[groupBtn.dataset.group] || [])[0].id);
  const btn = e.target.closest('.admin-subnav-btn');
  if (btn) showAdminTab(btn.dataset.tab);
});

window.addEventListener('hashchange', () => {
  const parts = (location.hash || '').replace(/^#/, '').split('/');
  if (parts[0] && ADMIN_GROUPS[parts[0]]) showAdminTab(parts[1] || ADMIN_GROUPS[parts[0]][0].id);
  else if (parts[0]) showAdminTab(parts[0]);
});

(async function init() {
  if (!token) { location.href = apiUrl('/login'); return; }
  try {
    const me = await api('/api/auth/me');
    const data = await me.json();
    if (!me.ok || !data.user.admin) throw new Error('not admin');
    localStorage.setItem('oc_user', JSON.stringify(data.user));
    ME_ID = data.user && data.user.id ? data.user.id : ME_ID;
    // 演示管理员:顶部常驻提示,提醒修改会失效;敏感入口直接隐藏,避免误操作撞到 403
    if (data.user && data.user.demo) {
      const banner = $('admin-demo-banner');
      if (banner) banner.classList.remove('hidden');
      document.body.classList.add('is-demo-admin');
      // 隐藏不可用的敏感操作入口(公告保存、创建/编辑用户、邀请码、查看对话等)
      ['announce-save'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
      const announceBox = $('announce-enabled'); if (announceBox) announceBox.disabled = true;
      const announceText = $('announce-text'); if (announceText) announceText.disabled = true;
      try {
        const cr = await api('/api/config');
        const cfg = await cr.json();
        if ($('admin-demo-minutes')) $('admin-demo-minutes').textContent = cfg.demoExpireMinutes == null ? 10 : cfg.demoExpireMinutes;
      } catch (e) { /* 提示条不影响后台使用 */ }
    }
    const rawStart = (location.hash || '').replace(/^#/, '');
    const startParts = rawStart.split('/');
    const start = startParts[0] && ADMIN_GROUPS[startParts[0]] ? (startParts[1] || ADMIN_GROUPS[startParts[0]][0].id) : (rawStart || 'overview');
    if (showAdminTab(start)) {
      if (!tabLoaded[start]) { const loader = TAB_LOADERS[start]; if (loader) { await loader(); tabLoaded[start] = true; } }
    } else {
      showAdminTab('overview');
    }
  } catch (e) {
    toast('需要管理员权限', true);
    setTimeout(() => location.href = apiUrl('/'), 1200);
  }
})();