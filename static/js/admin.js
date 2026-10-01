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
// ============ 服务器状态看板（概览顶部） ============
// 取不到的指标（如 Windows 下的 CPU/整机内存）直接隐藏，不显示会误导人的 0
function fmtBytesBig(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtUptime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}
function sysRing(label, sub, pct, color) {
  const has = (pct !== null && pct !== undefined);
  const p = has ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return '<div class="sys-meter">'
    + '<div class="sys-ring"' + (has ? ' style="--ring-color:' + color + ';--pct:' + p + '"' : ' style="--ring-color:#cbd5e1"') + '>'
    + '<span>' + (has ? p + '%' : '—') + '</span></div>'
    + '<div class="sys-meter-meta"><div class="k">' + escapeHtml(label) + '</div><div class="v">' + escapeHtml(sub) + '</div></div>'
    + '</div>';
}
function sysFact(k, v, sub) {
  return '<div class="sys-fact"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>'
    + (sub ? '<div class="sub">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}
function sysRingColor(pct) { return pct >= 85 ? '#dc2626' : (pct >= 60 ? '#f59e0b' : '#16a34a'); }
async function loadSystemBoard() {
  const metersEl = $('sys-meters'); const factsEl = $('sys-facts');
  if (!metersEl || !factsEl) return;
  let d = null;
  try {
    const r = await api('/api/admin/system');
    d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  } catch (e) {
    metersEl.innerHTML = '<p class="muted small" style="margin:0">服务器指标加载失败：' + escapeHtml(e.message || '') + '</p>';
    return;
  }
  const cpu = d.cpu || {}, mem = d.memory || {}, disk = d.disk || {}, users = d.users || {};
  const calls = d.calls || {}, content = d.content || {}, srv = d.server || {};
  const meters = [];
  if (cpu.percent !== null && cpu.percent !== undefined) {
    const la = (cpu.loadavg && cpu.loadavg.length) ? '负载 ' + cpu.loadavg.join(' / ') : (cpu.cores ? cpu.cores + ' 核' : '—');
    meters.push(sysRing('CPU 使用率', la, cpu.percent, sysRingColor(cpu.percent)));
  } else if (cpu.cores) {
    meters.push(sysRing('CPU', cpu.cores + ' 核', null, '#cbd5e1'));
  }
  if (mem.totalBytes) {
    const pct = mem.usedBytes * 100 / mem.totalBytes;
    meters.push(sysRing('内存', fmtBytesBig(mem.usedBytes) + ' / ' + fmtBytesBig(mem.totalBytes), pct, sysRingColor(pct)));
  } else if (mem.phpBytes) {
    const lim = mem.phpLimitBytes;
    meters.push(sysRing('PHP 进程内存', fmtBytesBig(mem.phpBytes) + (lim ? ' / ' + fmtBytesBig(lim) : ''),
      lim ? mem.phpBytes * 100 / lim : null, sysRingColor(lim ? mem.phpBytes * 100 / lim : 0)));
  }
  if (disk.totalBytes && disk.freeBytes !== null && disk.freeBytes !== undefined) {
    const used = disk.totalBytes - disk.freeBytes;
    const pct = used * 100 / disk.totalBytes;
    meters.push(sysRing('磁盘', fmtBytesBig(used) + ' / ' + fmtBytesBig(disk.totalBytes), pct, sysRingColor(pct)));
  }
  metersEl.innerHTML = meters.join('') || '<p class="muted small" style="margin:0">当前环境未提供 CPU / 内存指标。</p>';
  factsEl.innerHTML = [
    sysFact('在线用户', users.online, '最近 ' + (users.onlineWindowMin || 5) + ' 分钟活跃'),
    sysFact('总用户', users.total, '24 小时活跃 ' + (users.active24h || 0)),
    sysFact('今日调用', calls.today, '近 7 天 ' + (calls.last7d || 0)),
    sysFact('累计调用', calls.total),
    sysFact('对话总数', content.chats),
    sysFact('模型供应商', content.providers),
    sysFact('助手数', content.assistants),
    sysFact('运行时长', fmtUptime(d.uptimeSec)),
  ].join('');
  const hostEl = $('sys-host');
  if (hostEl) hostEl.textContent = ['v' + (d.version || '?'), srv.phpVersion ? 'PHP ' + srv.phpVersion : '', srv.os, srv.sqliteVersion ? 'SQLite ' + srv.sqliteVersion : '', srv.arch].filter(Boolean).join(' · ');
  const upEl = $('sys-updated');
  if (upEl) upEl.textContent = '更新于 ' + fmtTime(Date.now()).replace(/^.*\s/, '').replace(/:\d\d$/, '');
}
(function initSystemBoard() {
  const btn = $('sys-refresh');
  if (btn) btn.addEventListener('click', () => { btn.disabled = true; Promise.resolve(loadSystemBoard()).then(() => { btn.disabled = false; }); });
})();

// ============ 存储管理 ============
function stRow(name, desc, bytes, maxBytes, action) {
  const pct = maxBytes > 0 ? Math.min(100, bytes * 100 / maxBytes) : 0;
  return '<div class="st-row">'
    + '<div class="st-row-main"><div class="st-row-name">' + escapeHtml(name) + '</div>'
    + '<div class="st-row-desc">' + escapeHtml(desc) + '</div>'
    + '<div class="st-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>'
    + '<div class="st-row-val">' + fmtBytesBig(bytes) + (action || '') + '</div></div>';
}
async function loadStorage() {
  const catEl = $('st-categories');
  if (!catEl) return;
  catEl.innerHTML = '<p class="muted small">加载中…</p>';
  let d = null;
  try {
    const r = await api('/api/admin/storage');
    d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  } catch (e) {
    catEl.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message || '') + '</p>';
    return;
  }
  const total = d.totalBytes || 1;
  const byKey = {};
  (d.categories || []).forEach((c) => { byKey[c.key] = c; });
  const meters = [sysRing('数据目录占用', fmtBytesBig(d.totalBytes), null, '#cbd5e1')];
  if (d.disk && d.disk.totalBytes) {
    const used = d.disk.totalBytes - d.disk.freeBytes;
    const pct = used * 100 / d.disk.totalBytes;
    meters.push(sysRing('磁盘已用', fmtBytesBig(used) + ' / ' + fmtBytesBig(d.disk.totalBytes), pct, sysRingColor(pct)));
  }
  const quotaBytes = (d.quotaMb > 0 ? d.quotaMb : 0) * 1048576;
  meters.push(sysRing('生图留存', fmtBytesBig(d.images.bytes) + (d.archiveEnabled ? '' : '（留存已关闭）'),
    quotaBytes > 0 ? d.images.bytes * 100 / quotaBytes : null, d.images.bytes * 100 > quotaBytes * 85 ? '#f59e0b' : '#16a34a'));
  meters.push(sysRing('数据备份', d.backups.count + ' 个文件', null, '#cbd5e1'));
  if ($('st-meters')) $('st-meters').innerHTML = meters.join('');
  catEl.innerHTML = (d.categories || []).map((c) => stRow(c.name,
    c.desc + (c.exists ? '' : '（当前不存在）') + (c.files ? ' · ' + c.files + ' 个文件' : ''), c.bytes, total)).join('');
  const cl = [];
  if (byKey.imgcache && byKey.imgcache.bytes > 0) cl.push(['imagecache', '图片代理缓存（' + (byKey.imgcache.files || 0) + ' 个文件）', fmtBytesBig(byKey.imgcache.bytes) + ' 可释放']);
  if (d.images.count > 0) cl.push(['images', '生图留存（' + d.images.count + ' 个文件）', fmtBytesBig(d.images.bytes) + ' 可释放']);
  if (d.backups.count > 0) cl.push(['backups', '数据备份（' + d.backups.count + ' 个文件）', fmtBytesBig(d.backups.bytes) + ' 可释放']);
  if (byKey.logs && byKey.logs.bytes > 0) cl.push(['logs', '运行日志（' + d.logs.count + ' 条）', fmtBytesBig(byKey.logs.bytes) + ' 可释放']);
  if (byKey.update && byKey.update.bytes > 0) cl.push(['updates', '更新残留（' + (byKey.update.files || 0) + ' 个文件）', fmtBytesBig(byKey.update.bytes) + ' 可释放']);
  if ($('st-clean')) $('st-clean').innerHTML = cl.length ? cl.map((x) =>
    '<div class="st-row"><div class="st-row-main"><div class="st-row-name">' + escapeHtml(x[1]) + '</div>'
    + '<div class="st-row-desc">' + escapeHtml(x[2]) + '</div></div>'
    + '<div class="st-row-val"><button class="btn small st-danger" type="button" data-st-clean="' + x[0] + '">清理</button></div></div>').join('')
    : '<p class="muted small">暂无可清理项。</p>';
  const fileRow = (f) => '<div class="st-row"><div class="st-row-main"><div class="st-row-name">' + escapeHtml(f.name) + '</div>'
    + '<div class="st-row-desc">' + fmtTime(f.mtime) + '</div></div>'
    + '<div class="st-row-val">' + fmtBytesBig(f.bytes) + '</div></div>';
  if ($('st-images')) $('st-images').innerHTML = d.images.count
    ? d.images.items.map(fileRow).join('') + (d.images.count > d.images.items.length ? '<p class="muted small">仅显示最近 ' + d.images.items.length + ' 个，共 ' + d.images.count + ' 个。</p>' : '')
    : '<p class="muted small">暂无生图留存文件。</p>';
  if ($('st-backups')) $('st-backups').innerHTML = d.backups.count
    ? d.backups.items.map(fileRow).join('') + (d.backups.count > d.backups.items.length ? '<p class="muted small">仅显示最近 ' + d.backups.items.length + ' 个，共 ' + d.backups.count + ' 个。</p>' : '')
    : '<p class="muted small">暂无备份文件（可在「版本更新」页开启自动备份）。</p>';
}
(function initStoragePanel() {
  const b = $('st-refresh');
  if (b) b.addEventListener('click', () => { b.disabled = true; Promise.resolve(loadStorage()).then(() => { b.disabled = false; }); });
  const box = $('st-clean');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-st-clean]');
    if (!btn) return;
    const target = btn.getAttribute('data-st-clean');
    const label = btn.closest('.st-row').querySelector('.st-row-name').textContent;
    const hint = {
      imagecache: '仅清空代理图片缓存，用户下次访问会重新抓取，不影响历史内容。',
      images: '已生成图片的本地留存会被删除，历史对话中这些图片将无法再显示。',
      backups: '历史数据快照会被删除，删除后无法回滚到这些时间点。',
      logs: '运行日志会被清空，仅影响排查记录。',
      updates: '更新下载的包与旧版本备份会被删除，不影响当前运行。',
    }[target] || '';
    const msg = hint + '清理后不可恢复，确定继续？';
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清理' + label, message: msg, danger: true, confirmText: '清理' })
      : window.confirm('清理' + label + '？' + msg);
    if (!ok) return;
    btn.disabled = true;
    try {
      const r = await api('/api/admin/storage/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: target }) });
      const res = await readJsonSafe(r);
      if (!r.ok) throw new Error((res.error && res.error.message) || '清理失败');
      toast('已清理' + res.label + '：' + res.removed + ' 个文件，释放 ' + fmtBytesBig(res.freedBytes));
      await loadStorage();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || '清理失败', true);
    }
  });
})();

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
let USER_SELECTED = new Set();
let USER_FORM_ID = null;
let USER_FORM_WAS_DEMO = false; // 编辑对象原本是否为演示管理员(决定保存时要不要提交 demoMinutes)
let DEMO_MINUTES_CFG = 10;      // 站点当前的全局演示还原窗口(/api/config),编辑表单据此回填
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
    const gd = await readJsonSafe(gr);
    if (!gr.ok) throw new Error((gd.error && gd.error.message) || ('HTTP ' + gr.status));
    GROUPS = gd.groups || [];
  } catch (e) {
    // 下拉会退化为无分组可选,必须让管理员知道原因
    toast('用户组加载失败：' + (e.message || '网络错误'), true);
  }
}

// ============ 后台:用户第三方绑定管理 ============
// 管理员可查看/解除某用户的第三方绑定,也可复制"绑定链接"让用户自己完成授权
async function loadUserOauth(userId) {
  const wrap = $('uf-oauth-wrap');
  const box = $('uf-oauth-list');
  if (!wrap || !box) return;
  if (!userId) { wrap.hidden = true; box.innerHTML = ''; return; }
  wrap.hidden = false;
  box.innerHTML = '<p class="muted small" style="margin:0">加载中…</p>';
  try {
    const r = await api('/api/admin/users/oauth?userId=' + encodeURIComponent(userId));
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
    const list = Array.isArray(d.providers) ? d.providers : [];
    const userInfo = d.user || {};
    if (!list.some((p) => p.enabled || p.bound)) {
      box.innerHTML = '<p class="muted small" style="margin:0">后台尚未开启任何第三方登录方式。</p>';
      return;
    }
    box.innerHTML = list.map((p) => {
      let label, act = '';
      if (p.bound) {
        label = '已绑定' + (p.boundName ? '（' + escapeHtml(p.boundName) + '）' : '');
        act = '<button class="btn small" type="button" data-ao-unbind="' + escapeHtml(p.id) + '">解除</button>';
      } else if (p.enabled) {
        label = '未绑定';
        act = '<button class="btn small" type="button" data-ao-copy="' + escapeHtml(p.bindUrl || '') + '">复制绑定链接</button>';
      } else {
        label = '未启用';
      }
      return '<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--line,#eee);gap:8px">'
        + '<div style="display:flex;align-items:center;gap:8px;min-width:0">'
        + '<img src="' + escapeHtml(p.logo) + '" alt="" style="width:16px;height:16px;border-radius:4px;object-fit:contain">'
        + '<div><div>' + escapeHtml(p.name) + '</div><div class="muted small">' + label + '</div></div></div>'
        + '<div>' + act + '</div></div>';
    }).join('');
    if (!userInfo.hasPassword && list.filter((p) => p.bound).length === 1) {
      box.innerHTML += '<p class="muted small" style="margin:8px 0 0">该用户还没有设置密码，解除唯一绑定后将无法登录，建议先让其在「设置 → 账户」设置密码。</p>';
    }
    box.dataset.userId = userId;
  } catch (e) {
    box.innerHTML = '<p class="muted small" style="margin:0">加载失败：' + escapeHtml(e.message || '') + '</p>';
  }
}
(function initUserOauthPanel() {
  const box = $('uf-oauth-list');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-ao-copy]');
    if (copyBtn) {
      const val = copyBtn.getAttribute('data-ao-copy') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(val);
        else {
          const ta = document.createElement('textarea');
          ta.value = val; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        const old = copyBtn.textContent;
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = old; }, 1200);
      } catch (err) { toast('复制失败，请手动选择复制', true); }
      return;
    }
    const unbindBtn = e.target.closest('[data-ao-unbind]');
    if (!unbindBtn) return;
    const pid = unbindBtn.getAttribute('data-ao-unbind');
    const userId = box.dataset.userId || '';
    unbindBtn.disabled = true;
    try {
      const r = await api('/api/admin/users/' + encodeURIComponent(userId) + '/oauth/' + encodeURIComponent(pid), { method: 'DELETE' });
      const d = await readJsonSafe(r);
      if (!r.ok) throw new Error((d.error && d.error.message) || '解除失败');
      toast('已解除绑定');
      loadUserOauth(userId);
    } catch (err) {
      unbindBtn.disabled = false;
      toast(err.message || '解除失败', true);
    }
  });
})();

async function openUserForm(user) {
  const modal = $('user-form-modal');
  if (!modal) return;
  await ensureGroups();
  USER_FORM_ID = user ? user.id : null;
  USER_FORM_WAS_DEMO = !!(user && user.demo);
  $('user-form-title').textContent = user ? '编辑用户' : '创建用户';
  $('user-form-save').textContent = user ? '保存' : '创建';
  $('uf-name').value = user ? user.name : '';
  $('uf-pass').value = '';
  $('uf-pass-label').textContent = user ? '新密码（留空不改）' : '密码';
  $('uf-quota').value = user ? user.quota : 100;
  $('uf-admin').checked = !!(user && user.admin);
  if ($('uf-demo')) $('uf-demo').checked = !!(user && user.demo);
  // 演示身份不限于创建时:编辑已有用户也能设置/取消
  if ($('uf-demo-row')) $('uf-demo-row').style.display = '';
  if ($('uf-demo-options')) $('uf-demo-options').hidden = !($('uf-demo') && $('uf-demo').checked);
  // 回填站点当前的全局演示窗口,而不是写死 10:否则编辑保存会把全局窗口悄悄改回 10
  if ($('uf-demo-minutes')) $('uf-demo-minutes').value = DEMO_MINUTES_CFG;
  const adminGroup = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
  const preferred = $('uf-admin').checked
    ? adminGroup
    : (user && user.groupId && user.groupId !== adminGroup ? user.groupId : (DEFAULT_GROUP_ID || ''));
  setGroupSelect($('uf-group'), preferred);
  bindGroupSelect($('uf-group'));
  // 第三方绑定管理(仅编辑已有用户时可用)
  loadUserOauth(user ? user.id : null);
  if (!$('uf-admin').dataset.boundGroup) {
    $('uf-admin').dataset.boundGroup = '1';
    $('uf-admin').addEventListener('change', () => {
      // 演示管理员必然也是管理员:不允许单独取消「设为管理员」
      if ($('uf-demo') && $('uf-demo').checked && !$('uf-admin').checked) {
        $('uf-admin').checked = true;
        toast('演示管理员默认也是管理员，请先取消「演示管理员」', true);
        return;
      }
      const nextAdmin = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
      const current = $('uf-group').getAttribute('data-value') || '';
      if ($('uf-admin').checked) setGroupSelect($('uf-group'), nextAdmin);
      else if (!current || current === nextAdmin) setGroupSelect($('uf-group'), DEFAULT_GROUP_ID || '');
    });
  }
  // 演示管理员 = 管理员:勾选「演示管理员」会自动勾选并锁定「设为管理员」,并把用户组切到管理员组。
  const syncDemoPair = () => {
    const demoOn = !!($('uf-demo') && $('uf-demo').checked);
    const adminEl = $('uf-admin');
    const groupEl = $('uf-group');
    const adminGroup = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
    if (demoOn) {
      // 记下切换前的用户组,取消演示时原样还原
      if (groupEl && groupEl.dataset.preDemoGroup === undefined) {
        groupEl.dataset.preDemoGroup = groupEl.getAttribute('data-value') || '';
      }
      if (adminEl && !adminEl.checked) { adminEl.dataset.forcedByDemo = '1'; adminEl.checked = true; }
      if (adminEl) adminEl.disabled = true;
      setGroupSelect(groupEl, adminGroup);
    } else if (adminEl) {
      adminEl.disabled = false;
      // 若「管理员」是随演示自动带上的,取消演示时一并取消,避免残留为正式管理员
      if (adminEl.dataset.forcedByDemo === '1') {
        adminEl.checked = false;
        adminEl.dataset.forcedByDemo = '';
        const prev = groupEl && groupEl.dataset.preDemoGroup !== undefined ? groupEl.dataset.preDemoGroup : '';
        setGroupSelect(groupEl, prev && prev !== adminGroup ? prev : (DEFAULT_GROUP_ID || ''));
      }
      if (groupEl) delete groupEl.dataset.preDemoGroup;
    }
    if ($('uf-demo-options')) $('uf-demo-options').hidden = !demoOn;
  };
  if ($('uf-demo') && !$('uf-demo').dataset.boundDemo) {
    $('uf-demo').dataset.boundDemo = '1';
    $('uf-demo').addEventListener('change', syncDemoPair);
  }
  // 打开表单时按现有状态同步一次(编辑已有演示管理员时应已锁定「设为管理员」)
  syncDemoPair();
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
  setTimeout(() => $('uf-name').focus(), 30);
}

function closeUserForm() {
  const modal = $('user-form-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  USER_FORM_ID = null;
}

async function saveUserForm() {
  const name = $('uf-name').value.trim();
  const password = $('uf-pass').value;
  const quota = Number($('uf-quota').value);
  const demo = !!($('uf-demo') && $('uf-demo').checked);
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
      // 后端在创建管理员/演示账号时已自动归入管理员组;仅当用户特意选了别的组时才再调组接口
      if (created && groupId && groupId !== createdGroup) {
        const gr = await api('/api/admin/users/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: created.id, groupId: groupId || null }),
        });
        if (!gr.ok) {
          const dd = await gr.json().catch(() => ({}));
          toast((dd.error && dd.error.message) || '用户组更新失败', true);
        }
      }
      toast('用户已创建');
    } else {
      const body = { userId: USER_FORM_ID, name, admin, demo };
      if (password) body.password = password;
      // demoMinutes 是全局「演示还原窗口」:仅在新建演示身份或明确改动窗口值时提交,
      // 避免每次编辑演示用户都把全局窗口静默重置
      if (demo && (!USER_FORM_WAS_DEMO || demoMinutes !== DEMO_MINUTES_CFG)) body.demoMinutes = demoMinutes;
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
      if (!qr.ok) {
        const qd = await qr.json().catch(() => ({}));
        toast((qd.error && qd.error.message) || '额度更新失败', true);
      }
      // 后端在设为管理员/演示时已自动归入管理员组;仅当目标组与后端结果不一致时才再调组接口,
      // 避免「演示管理员」这类场景下多调一次反而报「用户组更新失败」。
      const newGroup = data.user && data.user.groupId ? data.user.groupId : '';
      if (groupId && groupId !== newGroup) {
        const gr = await api('/api/admin/users/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_FORM_ID, groupId: groupId || null }),
        });
        if (!gr.ok) {
          const gd = await gr.json().catch(() => ({}));
          toast((gd.error && gd.error.message) || '用户组更新失败', true);
        }
      }
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
  const next = (window.OCUI && OCUI.prompt)
    ? await OCUI.prompt({ title: '修改用户组名称', value: g.name, confirmText: '保存' })
    : window.prompt('修改用户组名称', g.name);
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

// ============ 用户表分页(客户端) ============
let USER_PAGE = 1;
const USER_PAGE_SIZE = 50;
function usersPageOf(list) {
  const pages = Math.max(1, Math.ceil(list.length / USER_PAGE_SIZE));
  if (USER_PAGE > pages) USER_PAGE = pages;
  if (USER_PAGE < 1) USER_PAGE = 1;
  return { slice: list.slice((USER_PAGE - 1) * USER_PAGE_SIZE, USER_PAGE * USER_PAGE_SIZE), pages };
}
function renderUsersPager(pages, total) {
  const box = $('users-pager');
  if (!box) return;
  const multi = pages > 1;
  box.hidden = !multi;
  if (!multi) return;
  const info = $('users-page-info');
  if (info) info.textContent = '第 ' + USER_PAGE + ' / ' + pages + ' 页 · 共 ' + total + ' 人';
  const prev = $('users-page-prev');
  const next = $('users-page-next');
  if (prev) prev.disabled = USER_PAGE <= 1;
  if (next) next.disabled = USER_PAGE >= pages;
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
  // 清理已不存在的选中项(切换筛选/删除后)
  const aliveIds = new Set(USER_LIST.map((u) => u.id));
  Array.from(USER_SELECTED).forEach((id) => { if (!aliveIds.has(id)) USER_SELECTED.delete(id); });
  if (!list.length) {
    tbody.innerHTML = '<tr class="users-empty-row"><td colspan="9">' + (USER_LIST.length ? '没有匹配的用户' : '还没有用户，点右上角创建') + '</td></tr>';
    renderUsersPager(1, 0);
    return;
  }
  const { slice, pages } = usersPageOf(list);
  renderUsersPager(pages, list.length);
  slice.forEach((u) => {
    const tr = document.createElement('tr');
    const initial = String(u.name || '?').trim().charAt(0).toUpperCase();
    const gName = groupLabel(u.groupId);
    const me = u.id === ME_ID;
    tr.innerHTML =
      '<td class="col-check">' + (me ? '' : '<input type="checkbox" class="user-pick" data-id="' + escapeHtml(u.id) + '"' + (USER_SELECTED.has(u.id) ? ' checked' : '') + ' aria-label="选择">') + '</td>'
      + '<td class="col-user">'
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
    const pick = tr.querySelector('.user-pick');
    if (pick) pick.addEventListener('change', () => {
      if (pick.checked) USER_SELECTED.add(u.id); else USER_SELECTED.delete(u.id);
      syncUserSelection();
    });
    tr.querySelector('[data-edit]')?.addEventListener('click', () => openUserForm(u));
    tr.querySelector('[data-chats]')?.addEventListener('click', () => openUserChats(u));
    tr.querySelector('[data-deluser]')?.addEventListener('click', async () => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除用户', message: '确认删除用户「' + u.name + '」？其对话和自建供应商会一并清除。', danger: true, confirmText: '删除' })
        : confirm('确认删除用户 ' + u.name + '?');
      if (!ok) return;
      const rr = await api('/api/admin/users/' + u.id, { method: 'DELETE' });
      if (rr.ok) { toast('已删除'); loadUsers(currentUserKw()); loadStats(); }
      else {
        const d = await rr.json().catch(() => ({}));
        toast('删除失败' + (d.error && d.error.message ? '：' + d.error.message : ''), true);
      }
    });
    tbody.appendChild(tr);
  });
  syncUserSelection();
}
// 同步「删除所选」按钮与全选框状态(全选只覆盖当前页,避免跨页误删看不见的用户)
function usersCurrentPageList() {
  const list = visibleUsers();
  return list.slice((USER_PAGE - 1) * USER_PAGE_SIZE, USER_PAGE * USER_PAGE_SIZE);
}
function syncUserSelection() {
  const btn = $('users-bulk-delete');
  if (btn) {
    btn.hidden = USER_SELECTED.size === 0;
    btn.textContent = USER_SELECTED.size ? ('删除所选 (' + USER_SELECTED.size + ')') : '删除所选';
  }
  const all = $('users-check-all');
  if (all) {
    const pickable = usersCurrentPageList().filter((u) => u.id !== ME_ID);
    const picked = pickable.filter((u) => USER_SELECTED.has(u.id)).length;
    all.checked = pickable.length > 0 && picked === pickable.length;
    all.indeterminate = picked > 0 && picked < pickable.length;
  }
}

// 用户批量操作:全选、删除所选、一键清除游客
(function initUserBulk() {
  const all = $('users-check-all');
  if (all) all.addEventListener('change', () => {
    const pickable = usersCurrentPageList().filter((u) => u.id !== ME_ID);
    if (all.checked) pickable.forEach((u) => USER_SELECTED.add(u.id));
    else pickable.forEach((u) => USER_SELECTED.delete(u.id));
    renderUsers();
  });
  const bulk = $('users-bulk-delete');
  if (bulk) bulk.addEventListener('click', async () => {
    const ids = Array.from(USER_SELECTED);
    if (!ids.length) return;
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '批量删除用户', message: '确认删除选中的 ' + ids.length + ' 个用户？其对话与自建供应商会一并清除。', danger: true, confirmText: '删除' })
      : confirm('确认删除选中的 ' + ids.length + ' 个用户?');
    if (!ok) return;
    bulk.disabled = true;
    try {
      const r = await api('/api/admin/users/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
      USER_SELECTED.clear();
      toast('已删除 ' + d.deleted + ' 个用户' + (d.skipped ? '，跳过 ' + d.skipped + ' 个' : ''));
      loadUsers(currentUserKw()); loadStats();
    } catch (e) {
      toast('删除失败: ' + e.message, true);
    } finally { bulk.disabled = false; }
  });
  const purge = $('users-purge-guests');
  if (purge) purge.addEventListener('click', async () => {
    const guests = USER_LIST.filter((u) => u.guest);
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清除全部游客', message: '将删除全部 ' + guests.length + ' 个游客账号及其对话与自建供应商。管理员与普通成员不受影响。', danger: true, confirmText: '全部清除' })
      : confirm('将删除全部 ' + guests.length + ' 个游客账号,确认?');
    if (!ok) return;
    purge.disabled = true;
    try {
      const r = await api('/api/admin/users/purge-guests', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '清除失败', true);
      USER_SELECTED.clear();
      toast(d.removed ? ('已清除 ' + d.removed + ' 个游客账号') : '当前没有游客账号');
      loadUsers(currentUserKw()); loadStats();
    } catch (e) {
      toast('清除失败: ' + e.message, true);
    } finally { purge.disabled = false; }
  });
})();

async function loadUsers(searchKw) {
  try {
    const r = await api('/api/admin/users' + (searchKw ? '?q=' + encodeURIComponent(searchKw) : ''));
    const data = await readJsonSafe(r);
    if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
    if (!GROUPS.length) {
      const gr = await api('/api/admin/groups');
      const gd = await readJsonSafe(gr);
      if (!gr.ok) throw new Error((gd.error && gd.error.message) || '用户组加载失败');
      GROUPS = gd.groups || [];
    }
    USER_LIST = data.users || [];
    USER_PAGE = 1;
    renderUsers();
  } catch (e) {
    toast('用户列表加载失败：' + (e.message || '网络错误'), true);
  }
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
// ---- 多密钥编辑器:每行 = 名称 + Key(掩码/明文) + 显示/删除 ----
function setKeyVisibility(input, button, visible) {
  if (!input || !button) return;
  input.type = visible ? 'text' : 'password';
  button.innerHTML = window.OC.icon(visible ? 'eyeOff' : 'eye', 14);
  button.title = visible ? '隐藏 Key' : '显示 Key';
  button.setAttribute('aria-label', button.title);
}
// 当前编辑中的密钥列表:[{id,name,apiKey,revealable}]
let AP_KEYS = [];
let AP_KEYS_EDIT_ID = null;    // 编辑模式下的供应商 id(用于小眼睛回显)
let AP_KEYS_REVEALABLE = false;
function apKeysBox() { return $('ap-keys'); }
function renderApKeys() {
  const box = apKeysBox();
  if (!box) return;
  // 每把 Key 需要有稳定 id 供模型绑定引用(新加的行为空 id)
  AP_KEYS.forEach((k) => { if (!k.id) k.id = 'k' + Math.random().toString(36).slice(2, 9); });
  box.innerHTML = AP_KEYS.map((k, i) => {
    // 已保存的 Key 不回填掩码到输入框(留空 = 保持不变);掩码只放在 placeholder 里提示
    const val = String(k.apiKey || '');
    const ph = (val === '' && k.hasKey)
      ? ('已保存 ' + String(k.masked || '••••••') + '，留空保持不变')
      : 'sk-...';
    return '<div class="ap-key-row" data-idx="' + i + '">'
      + '<input class="ap-key-name" type="text" data-idx="' + i + '" value="' + escapeHtml(k.name || '') + '" placeholder="Key 名称（多个时必填）" maxlength="40" autocomplete="off">'
      + '<div class="pw-wrap ap-key-pw">'
      + '<input class="ap-key-val" type="password" data-idx="' + i + '" value="' + escapeHtml(val) + '" placeholder="' + escapeHtml(ph) + '" autocomplete="off">'
      + '<button class="pw-toggle ap-key-eye" type="button" data-idx="' + i + '" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 14) + '</button>'
      + '</div>'
      + '<button class="icon-btn ap-key-del" type="button" data-del="' + i + '" title="移除该 Key" aria-label="移除该 Key">' + window.OC.icon('close', 14) + '</button>'
      + '</div>';
  }).join('');
  const addBtn = $('ap-key-add');
  if (addBtn) addBtn.disabled = AP_KEYS.length >= 20;
  // 密钥列表变化时同步给模型清单(用于密钥列下拉);未命名的暂用「未命名 N」
  if (apModelList && apModelList.setKeys) {
    apModelList.setKeys(AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) })));
  }
  syncFetchKeyBox();
}
// 「获取列表」用哪把 Key:多把密钥时显示选择器(默认第一把已填/已保存的)
function syncFetchKeyBox() {
  const box = $('ap-fetch-key');
  if (!box) return;
  const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
  if (usable.length < 2) { box.classList.add('hidden'); box.setAttribute('data-value', usable[0] ? usefulId(usable[0]) : ''); return; }
  box.classList.remove('hidden');
  let cur = box.getAttribute('data-value') || '';
  const ids = usable.map((k) => usefulId(k));
  if (ids.indexOf(cur) < 0) cur = ids[0];
  box.setAttribute('data-value', cur);
  const hit = usable.find((k) => usefulId(k) === cur);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = (hit && (hit.name || '').trim()) || '获取用 Key';
}
function usefulId(k) { return String((k && k.id) || ''); }
function bindFetchKeyBox() {
  const box = $('ap-fetch-key');
  if (!box || !window.OC || !OC.openSelect) return;
  box.addEventListener('click', () => {
    const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
    if (usable.length < 2) return;
    OC.openSelect(box, usable.map((k) => ({ value: usefulId(k), label: (k.name || '').trim() || '未命名' })), {
      selected: box.getAttribute('data-value') || '',
      fitWidth: true,
      onSelect: (val, item) => {
        box.setAttribute('data-value', val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || val;
      },
    });
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); } });
}
function apKeysFromProvider(p) {
  AP_KEYS = [];
  AP_KEYS_EDIT_ID = p && p.id ? p.id : null;
  AP_KEYS_REVEALABLE = !!(p && p.keyRevealable);
  const list = (p && Array.isArray(p.keys)) ? p.keys : [];
  if (list.length) {
    // 接口只回掩码:输入框留空表示「保持原 Key」,掩码存起来供 placeholder 展示
    AP_KEYS = list.map((k) => ({ id: String(k.id || ''), name: String(k.name || ''), apiKey: '', masked: String(k.apiKey || ''), hasKey: !!k.hasKey }));
  } else if (p && p.hasKey) {
    // 旧数据:单 Key
    AP_KEYS = [{ id: 'k0', name: '', apiKey: '', masked: String(p.apiKey || '••••••'), hasKey: true }];
  }
  if (!AP_KEYS.length) AP_KEYS = [{ id: '', name: '', apiKey: '' }];
  renderApKeys();
}
function apKeysPayload() {
  // 带回全部行(含未改动、apiKey 为空的):服务端按 id 复用原密文,
  // 否则未改动的密钥会在保存时被丢弃。
  return AP_KEYS.map((k) => ({ id: k.id || '', name: String(k.name || '').trim(), apiKey: String(k.apiKey || '') }));
}
// 有效行:已保存过的(hasKey) 或 刚填了明文
function apKeysEffective() {
  return AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
}
// 只更新模型表密钥下拉的选项文字(不重渲染,避免输入时丢焦点)
function syncKeySelectLabels() {
  const opts = AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) }));
  document.querySelectorAll('#ap-models-list select.mkey').forEach((sel) => {
    Array.from(sel.options).forEach((o) => {
      if (!o.value) return;
      const hit = opts.find((x) => String(x.id) === o.value);
      if (hit) o.textContent = hit.name || hit.id;
    });
  });
}
// 校验:多 Key 时名称必填且不可重复;返回错误信息或 ''
function apKeysValidate() {
  const named = apKeysEffective();
  if (named.length < 2) return '';
  const seen = {};
  for (const k of named) {
    const nm = String(k.name || '').trim();
    if (!nm) return '配置了多个 Key 时，每个 Key 都需要填写名称';
    const low = nm.toLowerCase();
    if (seen[low]) return 'Key 名称不能重复：' + nm;
    seen[low] = true;
  }
  return '';
}
(function initApKeys() {
  const box = apKeysBox();
  if (!box) return;
  const addBtn = $('ap-key-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (AP_KEYS.length >= 20) return;
    AP_KEYS.push({ id: '', name: '', apiKey: '' });
    renderApKeys();
  });
  box.addEventListener('input', (e) => {
    const nameInp = e.target.closest ? e.target.closest('input.ap-key-name') : null;
    if (nameInp) {
      const k = AP_KEYS[Number(nameInp.dataset.idx)];
      if (k) k.name = nameInp.value;
      // 同步模型表:密钥链芯片与下拉标签都按新名字显示
      // (焦点在密钥名称输入框,不在模型表内,重渲染不会丢焦点)
      syncKeySelectLabels();
      if (apModelList && apModelList.setKeys) {
        apModelList.setKeys(AP_KEYS.map((x, i) => ({ id: x.id, name: (x.name || '').trim() || ('未命名 ' + (i + 1)) })));
      }
      syncFetchKeyBox();
      return;
    }
    const valInp = e.target.closest ? e.target.closest('input.ap-key-val') : null;
    if (valInp) { const k = AP_KEYS[Number(valInp.dataset.idx)]; if (k) { k.apiKey = valInp.value; k.hasKey = true; } syncFetchKeyBox(); return; }
  });
  box.addEventListener('click', async (e) => {
    const del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      const i = Number(del.dataset.del);
      const victim = AP_KEYS[i];
      // 该密钥正被模型绑定时先提示:移除后这些模型会回退到默认密钥
      const bound = victim && victim.id && apModelList
        ? (apModelList.getCatalog() || []).filter((m) => String(m.keyId || '') === String(victim.id))
        : [];
      if (bound.length) {
        const names = bound.slice(0, 3).map((m) => m.name || m.id).join('、');
        const more = bound.length > 3 ? ' 等 ' + bound.length + ' 个' : '';
        const ok = window.OCUI
          ? await window.OCUI.confirm({ title: '移除密钥', message: '「' + (victim.name || '未命名') + '」正被模型 ' + names + more + ' 使用，移除后这些模型会改用默认密钥。确认移除？', danger: true, confirmText: '移除' })
          : confirm('密钥「' + (victim.name || '未命名') + '」正被 ' + bound.length + ' 个模型使用，移除后它们会改用默认密钥。确认?');
        if (!ok) return;
      }
      AP_KEYS.splice(i, 1);
      if (!AP_KEYS.length) AP_KEYS.push({ id: '', name: '', apiKey: '' });
      renderApKeys();
      return;
    }
    const eye = e.target.closest ? e.target.closest('.ap-key-eye') : null;
    if (!eye) return;
    const i = Number(eye.dataset.idx);
    const k = AP_KEYS[i];
    if (!k) return;
    const input = box.querySelector('input.ap-key-val[data-idx="' + i + '"]');
    if (!input) return;
    // 编辑模式 + 输入为空 + 属主勾选过「保存后保持显示」:取回服务器上保存的明文
    if (AP_KEYS_EDIT_ID && String(k.apiKey || '').trim() === '') {
      if (!AP_KEYS_REVEALABLE) { toast('该 Key 保存时未勾选「保存后保持显示」，无法查看', true); return; }
      try {
        eye.disabled = true;
        const rr = await api('/api/providers/' + encodeURIComponent(AP_KEYS_EDIT_ID) + '/key?keyId=' + encodeURIComponent(k.id || ''), { method: 'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '无法查看 Key');
        k.apiKey = dd.key || '';
        input.value = k.apiKey;
        setKeyVisibility(input, eye, true);
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally { eye.disabled = false; }
      return;
    }
    setKeyVisibility(input, eye, input.type !== 'text');
  });
})();

bindFetchKeyBox();

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
  // 上/下移:把当前顺序数组里相邻两项对调后整体提交,保证前台按此顺序展示
  const providerIds = providers.map((p) => p.id);
  const saveReorder = async (ids) => {
    try {
      const rr = await api('/api/admin/providers/' + ids[0], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', order: ids }),
      });
      if (!rr.ok) throw new Error('排序失败');
      loadProviders();
    } catch (e) { toast(e.message || '排序失败', true); }
  };
  providers.forEach((p, idx) => {
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
        <button class="btn small" data-up="' + p.id + '" type="button" title="上移（前台显示更靠前）">↑</button>
        <button class="btn small" data-down="' + p.id + '" type="button" title="下移（前台显示更靠后）">↓</button>
        ${!disabled && !isDefault ? '<button class="btn small" data-default="' + p.id + '">设为默认</button>' : ''}
        <button class="btn small" data-toggle type="button">${disabled ? '启用' : '停用'}</button>
        <button class="btn small" data-test type="button">测试</button>
        <button class="btn small" data-edit type="button">编辑</button>
        <button class="btn small danger" data-del type="button">删除</button>
      </div>`;
    card.querySelector('[data-up]')?.addEventListener('click', () => {
      if (idx <= 0) return;
      const ids = providerIds.slice();
      [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
      saveReorder(ids);
    });
    card.querySelector('[data-down]')?.addEventListener('click', () => {
      if (idx >= providerIds.length - 1) return;
      const ids = providerIds.slice();
      [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
      saveReorder(ids);
    });
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
      // 接口只回掩码:密钥编辑器里空值表示「沿用已保存的密钥」,输入新值才覆盖
      apKeysFromProvider(target);
      $('ap-key-keep').checked = target.keyRevealable !== false;
      window.apEditingRevealable = target.keyRevealable !== false;
      delete $('ap-save').dataset.origKey;
      if (window.__setApFormat) window.__setApFormat(target.apiFormat);
      if (apModelList) {
        apModelList.setKeys((target.keys || []).map((k) => ({ id: k.id, name: k.name || k.id })));
        apModelList.setEnabled(target.models || []);
      }
      $('ap-cost').value = target.costPerCall;
      if (window.__setApBilling) window.__setApBilling(target.billingMode || 'call');
      if ($('ap-price')) $('ap-price').value = target.pricePer1k != null ? target.pricePer1k : 0;
      $('ap-save').dataset.editId = target.id;
      $('ap-save').textContent = '保存修改';
      // 编辑态标识 + 取消入口:避免「以为在新增,实际在覆盖」
      const cancelBtn = $('ap-cancel-edit');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
      const note = $('ap-editing-note');
      if (note) { note.hidden = false; note.textContent = '正在编辑「' + (target.name || target.id) + '」，保存会覆盖其配置'; }
    };
    // 退出编辑态:恢复「新增供应商」默认表单
    const resetProviderForm = () => {
      delete $('ap-save').dataset.editId;
      window.apEditingRevealable = false;
      $('ap-save').textContent = '保存供应商';
      $('ap-name').value = ''; $('ap-baseurl').value = '';
      apKeysFromProvider(null);
      resetModelTestResults();
      if (apModelList) { apModelList.setKeys([]); apModelList.reset(); }
      if (window.__setApBilling) window.__setApBilling('call');
      if ($('ap-price')) $('ap-price').value = 0;
      if ($('ap-key-keep')) $('ap-key-keep').checked = true;
      const cancelBtn = $('ap-cancel-edit');
      if (cancelBtn) cancelBtn.classList.add('hidden');
      const note = $('ap-editing-note');
      if (note) note.hidden = true;
    };
    const cancelBtn0 = $('ap-cancel-edit');
    if (cancelBtn0) cancelBtn0.addEventListener('click', () => {
      resetProviderForm();
      const details = document.querySelector('.add-provider');
      if (details) details.open = false;
      toast('已退出编辑');
    });
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
  { value: 'brave', label: 'Brave Search', sub: '独立索引，免费 2000 次/月' },
  { value: 'ddg', label: 'DuckDuckGo', sub: '免 Key，抓结果页，有速率限制' },
  { value: 'jina', label: 'Jina AI', sub: '免 Key 可用，填 Key 提升配额' },
];
const WS_PROVIDER_NAMES = { tavily: 'Tavily', searxng: 'SearXNG', brave: 'Brave Search', ddg: 'DuckDuckGo', jina: 'Jina AI' };
function setWsProvider(val) {
  const box = $('ws-provider');
  if (!box) return;
  const known = WS_PROVIDERS.some((x) => x.value === val);
  const next = known ? val : 'tavily';
  box.setAttribute('data-value', next);
  const f = WS_PROVIDERS.find((x) => x.value === next);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = f ? f.label : next;
  if ($('ws-tavily-row')) $('ws-tavily-row').classList.toggle('hidden', next !== 'tavily');
  if ($('ws-brave-row')) $('ws-brave-row').classList.toggle('hidden', next !== 'brave');
  if ($('ws-jina-row')) $('ws-jina-row').classList.toggle('hidden', next !== 'jina');
  if ($('ws-searx-row')) $('ws-searx-row').classList.toggle('hidden', next !== 'searxng');
}
// 「对话设置」面板专用加载:此前该页签没有 loader,直接打开会显示 HTML 默认值,
// 若此时点保存会把默认值写回服务端、静默重置真实配置。
async function loadChatSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  fillChatLimits((data && data.settings) || {});
}
// 性能优化面板:读取/保存
function fillPerfSettings(s) {
  const src = s || {};
  if ($('perf-no-webfonts')) $('perf-no-webfonts').checked = !!src.perfNoWebfonts;
  if ($('perf-no-katex')) $('perf-no-katex').checked = !!src.perfNoKatex;
  if ($('perf-no-highlight')) $('perf-no-highlight').checked = !!src.perfNoHighlight;
  if ($('perf-no-mermaid')) $('perf-no-mermaid').checked = !!src.perfNoMermaid;
}
async function loadPerfSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  fillPerfSettings((data && data.settings) || {});
}
(function initPerfSettings() {
  const save = $('perf-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const body = {
      perfNoWebfonts: !!($('perf-no-webfonts') && $('perf-no-webfonts').checked),
      perfNoKatex: !!($('perf-no-katex') && $('perf-no-katex').checked),
      perfNoHighlight: !!($('perf-no-highlight') && $('perf-no-highlight').checked),
      perfNoMermaid: !!($('perf-no-mermaid') && $('perf-no-mermaid').checked),
    };
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      fillPerfSettings(data.settings || body);
      toast('性能设置已保存，用户下次访问生效');
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
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
  if ($('ws-brave-key') && s.webSearchBraveKey) $('ws-brave-key').value = s.webSearchBraveKey;
  if ($('ws-jina-key') && s.webSearchJinaKey) $('ws-jina-key').value = s.webSearchJinaKey;
  if ($('ws-searx-url')) $('ws-searx-url').value = s.webSearchSearxUrl || '';
  if ($('ws-max')) $('ws-max').value = s.webSearchMaxResults || 5;
  fillMineruSettings(s);
  fillChatLimits(s);
}
function fillChatLimits(s) {
  const src = s || {};
  const maxCtx = Math.min(500, Math.max(2, parseInt(src.maxContextMessages, 10) || 200));
  const ctx = Math.min(maxCtx, Math.max(2, parseInt(src.contextMessages, 10) || 12));
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
  if ($('chat-save-api')) $('chat-save-api').checked = src.apiSaveChats !== false;
  if ($('chat-health-ok')) $('chat-health-ok').value = Math.min(100, Math.max(1, parseInt(src.healthOkMin, 10) || 75));
  if ($('chat-health-warn')) $('chat-health-warn').value = Math.min(99, Math.max(0, parseInt(src.healthWarnMin, 10) || 40));
  if ($('chat-img-archive')) $('chat-img-archive').checked = src.imageArchiveEnabled !== false;
  if ($('chat-img-archive-quota')) $('chat-img-archive-quota').value = Math.min(10240, Math.max(50, parseInt(src.imageArchiveQuotaMb, 10) || 500));
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
    const apiSaveChats = !!($('chat-save-api') && $('chat-save-api').checked);
    // 可用性阈值:保证 okMin 严格大于 warnMin(输入颠倒时本地纠正并回写)
    let healthOk = Math.min(100, Math.max(1, parseInt($('chat-health-ok') && $('chat-health-ok').value, 10) || 75));
    let healthWarn = Math.min(99, Math.max(0, parseInt($('chat-health-warn') && $('chat-health-warn').value, 10)));
    if (!(healthWarn < healthOk)) healthWarn = Math.max(0, healthOk - 1);
    if ($('chat-health-ok')) $('chat-health-ok').value = healthOk;
    if ($('chat-health-warn')) $('chat-health-warn').value = healthWarn;
    const imageArchiveEnabled = !!($('chat-img-archive') && $('chat-img-archive').checked);
    const imageArchiveQuotaMb = Math.min(10240, Math.max(50, parseInt($('chat-img-archive-quota') && $('chat-img-archive-quota').value, 10) || 500));
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextMessages: ctx, maxContextMessages: maxCtx, maxOutputTokens: output, temperature, rateLimitPerMin: rateLimit, proxyTimeoutMs: timeoutSec * 1000, contextAutoLearn: contextLearn, persistChats, apiSaveChats, healthOkMin: healthOk, healthWarnMin: healthWarn, imageArchiveEnabled, imageArchiveQuotaMb }),
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
    const provider = ($('ws-provider') && $('ws-provider').getAttribute('data-value')) || 'tavily';
    const keyFor = { tavily: 'ws-tavily-key', brave: 'ws-brave-key', jina: 'ws-jina-key' };
    const key = (keyFor[provider] && $(keyFor[provider]) && $(keyFor[provider]).value || '').trim();
    const payload = {
      provider: provider,
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
      const title = escapeHtml(row.url || WS_PROVIDER_NAMES[row.provider] || row.provider);
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
    const braveKey = ($('ws-brave-key') && $('ws-brave-key').value || '').trim();
    const jinaKey = ($('ws-jina-key') && $('ws-jina-key').value || '').trim();
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
    if (braveKey && braveKey.indexOf('••') < 0) payload.webSearchBraveKey = braveKey;
    if (jinaKey && jinaKey.indexOf('••') < 0) payload.webSearchJinaKey = jinaKey;
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
        if ($('ws-brave-key') && data.settings.webSearchBraveKey) $('ws-brave-key').value = data.settings.webSearchBraveKey;
        if ($('ws-jina-key') && data.settings.webSearchJinaKey) $('ws-jina-key').value = data.settings.webSearchJinaKey;
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

// ============ 第三方一键登录 ============
// 提供商元数据(字段名/显示名/图标/申请入口/回调路径)与后端 tc_oauth_providers() 对应
// callbackPath 必须与后端 tc_oauth_providers()[id] 的路由一致(/auth/<id>/callback)
const OAUTH_PROVIDERS = [
  {
    id: 'wechat', name: '微信', logo: 'static/logo/weixin.svg',
    hint: '需在微信开放平台创建「网站应用」并通过审核，回调域需与备案域名一致',
    docs: 'https://open.weixin.qq.com',
    callbackPath: '/auth/wechat/callback',
    callbackWhere: '填在「网站应用 → 授权回调域」，只需填域名（如 example.com），不要带路径',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: 'wx开头的应用 ID' },
      { key: 'appSecret', label: 'AppSecret', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'qq', name: 'QQ', logo: 'static/logo/qq.svg',
    hint: '需在 QQ 互联（connect.qq.com）创建网站应用，审核通过后获得 AppID 与 AppKey',
    docs: 'https://connect.qq.com',
    callbackPath: '/auth/qq/callback',
    callbackWhere: '填在「网站应用 → 回调地址」，需填完整地址（含 /auth/qq/callback）',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '数字 AppID' },
      { key: 'appKey', label: 'AppKey', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'linuxdo', name: 'LINUX DO', logo: 'static/logo/linuxdo.png',
    hint: '在 connect.linux.do 创建应用；scope 使用 openid profile email',
    docs: 'https://connect.linux.do',
    callbackPath: '/auth/linuxdo/callback',
    callbackWhere: '填在应用的 Redirect URI / 回调地址',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'nodeloc', name: 'NodeLoc', logo: 'static/logo/nodeloc.png',
    hint: '在 nodeloc.com/oauth-provider/applications 创建应用（需 TL2 及以上）',
    docs: 'https://www.nodeloc.com/oauth-provider/applications',
    callbackPath: '/auth/nodeloc/callback',
    callbackWhere: '填在应用的 Redirect URI / 回调地址',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true },
    ],
  },
];

function renderOauthProviders(s) {
  const box = $('oauth-providers');
  if (!box) return;
  const cfg = (s && s.oauthProviders) || {};
  box.innerHTML = OAUTH_PROVIDERS.map((p) => {
    const row = (cfg[p.id] && typeof cfg[p.id] === 'object') ? cfg[p.id] : {};
    const on = !!row.enabled;
    const fields = p.fields.map((f) => {
      const val = row[f.key] || '';
      return '<label class="field" style="margin:8px 0 0"><span>' + escapeHtml(f.label) + '</span>'
        + '<input type="' + (f.secret ? 'password' : 'text') + '" data-oauth="' + p.id + '" data-key="' + f.key + '"'
        + ' value="' + escapeHtml(f.secret ? val : (val.indexOf('••') >= 0 ? '' : val)) + '"'
        + ' placeholder="' + escapeHtml(f.placeholder || '') + '" autocomplete="off"' + (on ? '' : ' disabled') + '>'
        + '</label>';
    }).join('');
    return '<div class="oauth-row" data-oauth-row="' + p.id + '" style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:12px 14px;margin-bottom:10px">'
      + '<label class="user-form-admin" style="margin:0">'
      + '<span class="switch"><input type="checkbox" data-oauth-enable="' + p.id + '"' + (on ? ' checked' : '') + '><span class="slider"></span></span>'
      + '<img src="' + p.logo + '" alt="" style="width:20px;height:20px;border-radius:5px;object-fit:contain;vertical-align:-4px;margin-right:6px">'
      + '<b>' + escapeHtml(p.name) + '</b>'
      + '</label>'
      + '<p class="muted small" style="margin:6px 0 0">' + escapeHtml(p.hint)
      + ' · <a href="' + escapeHtml(p.docs) + '" target="_blank" rel="noopener">申请入口</a></p>'
      + '<div class="oauth-fields" style="' + (on ? '' : 'display:none') + '">' + fields + '</div>'
      + '</div>';
  }).join('');
  renderOauthCallbacks();
}

// 逐平台列出「该填哪条回调地址」——各平台不能共用,具体路径见 OAUTH_PROVIDERS[].callbackPath
function renderOauthCallbacks() {
  const box = $('oauth-callback-list');
  if (!box) return;
  const origin = location.origin;
  box.innerHTML = OAUTH_PROVIDERS.map((p) => {
    const url = origin + p.callbackPath;
    return '<div class="row-between" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#eee);align-items:flex-start">'
      + '<div style="min-width:0;flex:1">'
      + '<div><img src="' + p.logo + '" alt="" style="width:16px;height:16px;border-radius:4px;object-fit:contain;vertical-align:-3px;margin-right:5px">'
      + '<b>' + escapeHtml(p.name) + '</b>'
      + '<span class="muted small"> · ' + escapeHtml(p.callbackWhere) + '</span></div>'
      + '<code style="word-break:break-all;font-size:12px">' + escapeHtml(url) + '</code>'
      + '</div>'
      + '<button class="btn small" type="button" data-copy-cb="' + escapeHtml(url) + '">复制</button>'
      + '</div>';
  }).join('');
}
function fillOauthSettings(s) {
  if ($('oauth-auto-register')) $('oauth-auto-register').checked = (s && s.oauthAutoRegister) !== false;
  if ($('oauth-require-profile')) $('oauth-require-profile').checked = !!(s && s.oauthRequireProfile);
  renderOauthProviders(s || {});
}
async function loadOauthSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  if (!r.ok) return toast((data.error && data.error.message) || '加载失败', true);
  fillOauthSettings((data && data.settings) || {});
}
(function initOauthSettings() {
  const box = $('oauth-providers');
  if (box) {
    box.addEventListener('change', (e) => {
      const en = e.target.closest('[data-oauth-enable]');
      if (!en) return;
      const pid = en.getAttribute('data-oauth-enable');
      const row = box.querySelector('[data-oauth-row="' + pid + '"]');
      if (!row) return;
      const fields = row.querySelector('.oauth-fields');
      if (fields) fields.style.display = en.checked ? '' : 'none';
      row.querySelectorAll('[data-oauth]').forEach((inp) => { inp.disabled = !en.checked; });
    });
  }
  // 回调地址一键复制
  const cbList = $('oauth-callback-list');
  if (cbList) {
    cbList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy-cb]');
      if (!btn) return;
      const val = btn.getAttribute('data-copy-cb') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(val);
        else {
          const ta = document.createElement('textarea');
          ta.value = val; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (err) {
        toast('复制失败，请手动选择复制', true);
      }
    });
  }
  const save = $('oauth-save');
  if (save) save.addEventListener('click', async () => {
    const payload = { oauthProviders: {}, oauthAutoRegister: !!($('oauth-auto-register') && $('oauth-auto-register').checked), oauthRequireProfile: !!($('oauth-require-profile') && $('oauth-require-profile').checked) };
    OAUTH_PROVIDERS.forEach((p) => {
      const enableBox = box && box.querySelector('[data-oauth-enable="' + p.id + '"]');
      const row = { enabled: !!(enableBox && enableBox.checked) };
      p.fields.forEach((f) => {
        const inp = box && box.querySelector('[data-oauth="' + p.id + '"][data-key="' + f.key + '"]');
        const v = (inp && inp.value || '').trim();
        // 敏感字段:掩码或留空都不提交,由后端保留原值(避免误清空已保存的密钥)
        if (f.secret && (v === '' || v.indexOf('••') >= 0)) return;
        row[f.key] = v;
      });
      payload.oauthProviders[p.id] = row;
    });
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('第三方登录设置已保存');
      if (data.settings) fillOauthSettings(data.settings);
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
function fillMineruSettings(s) {
  const token = (s && s.mineruToken) || '';
  if ($('mineru-token') && token) $('mineru-token').value = token;
  const mode = $('mineru-mode');
  const precise = shownHasMask(token);
  const allow = $('mineru-allow-user');
  if (allow) allow.checked = !!(s && s.mineruAllowUser);
  if (mode) mode.textContent = precise
    ? '当前：精准解析。单文件不超过 200MB、200 页，Token 仅保存在服务器。'
    : '当前：轻量解析。单文件不超过 10MB、20 页，同一 IP 每分钟有次数限制。用户上传后直接解析，只有超限或失败时才会看到限制。';
  // 解析通道路由 + 新源配置回填
  const routes = (s && s.parseChannels) || {};
  if ($('paddle-url') && s.paddleOcrUrl != null) $('paddle-url').value = s.paddleOcrUrl;
  if ($('paddle-key') && s.paddleOcrKey) $('paddle-key').value = s.paddleOcrKey;
  if ($('mistral-key') && s.mistralOcrKey) $('mistral-key').value = s.mistralOcrKey;
  setParseRoute('parse-route-pdf', routes.pdf);
  setParseRoute('parse-route-image', routes.image);
  setParseRoute('parse-route-office', routes.office);
}
const PARSE_CHANNELS = [
  { value: 'mineru', label: 'MinerU', sub: '全格式：PDF/图片/Office/HTML' },
  { value: 'paddle', label: 'PaddleOCR', sub: '仅 PDF 与图片（自建 serving 或托管 API）' },
  { value: 'mistral', label: 'Mistral OCR', sub: 'PDF/图片/DOCX/PPTX，效果好，按量计费' },
];
const PARSE_CHANNEL_NAMES = { mineru: 'MinerU', paddle: 'PaddleOCR', mistral: 'Mistral OCR' };
function setParseRoute(boxId, val) {
  const box = $(boxId);
  if (!box) return;
  const next = PARSE_CHANNEL_NAMES[val] ? val : 'mineru';
  box.setAttribute('data-value', next);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = PARSE_CHANNEL_NAMES[next];
}
(function initMineruSettings() {
  // 三个路由下拉共用一套通道选项
  ['parse-route-pdf', 'parse-route-image', 'parse-route-office'].forEach((id) => {
    const box = $(id);
    if (!box) return;
    const open = () => {
      OC.openSelect(box, PARSE_CHANNELS, {
        selected: box.getAttribute('data-value') || 'mineru',
        onSelect: (val) => setParseRoute(id, val),
      });
    };
    box.addEventListener('click', open);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
  const save = $('mineru-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const key = ($('mineru-token') && $('mineru-token').value || '').trim();
    const payload = { mineruAllowUser: !!($('mineru-allow-user') && $('mineru-allow-user').checked) };
    if (!key) payload.mineruToken = '';
    else if (key.indexOf('••') < 0) payload.mineruToken = key;
    payload.parseChannels = {
      pdf: ($('parse-route-pdf') && $('parse-route-pdf').getAttribute('data-value')) || 'mineru',
      image: ($('parse-route-image') && $('parse-route-image').getAttribute('data-value')) || 'mineru',
      office: ($('parse-route-office') && $('parse-route-office').getAttribute('data-value')) || 'mineru',
    };
    payload.paddleOcrUrl = ($('paddle-url') && $('paddle-url').value || '').trim();
    const paddleKey = ($('paddle-key') && $('paddle-key').value || '').trim();
    if (paddleKey.indexOf('••') < 0) payload.paddleOcrKey = paddleKey;
    const mistralKey = ($('mistral-key') && $('mistral-key').value || '').trim();
    if (mistralKey.indexOf('••') < 0) payload.mistralOcrKey = mistralKey;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('文档解析设置已保存');
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
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  if (!baseUrl) return toast('请先填写 Base URL', true);
  const editId = $('ap-save').dataset.editId;
  // 多密钥:用「获取用 Key」选择器指定的那把(默认第一把已填/已保存的)
  const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
  const wantId = ($('ap-fetch-key') && $('ap-fetch-key').getAttribute('data-value')) || '';
  const pickKey = usable.find((k) => String(k.id) === wantId) || usable[0];
  const usedKey = pickKey && String(pickKey.apiKey || '').indexOf('••') < 0 ? String(pickKey.apiKey).trim() : '';
  const usedKeyId = pickKey ? pickKey.id : '';
  if (!usedKey && !usedKeyId && !editId) { toast('请先填写 API Key', true); return; }
  // 按某个 Key 拉取模型列表:新供应商用明文字段,已保存的供应商可只传 keyId 由服务端解密
  const fetchByKey = async (kid) => {
    const k = AP_KEYS.find((x) => String(x.id) === String(kid));
    const plain = k && String(k.apiKey || '').indexOf('••') < 0 ? String(k.apiKey).trim() : '';
    const r = await api('/api/proxy/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: plain, apiFormat, keyId: (kid || undefined), providerId: editId || undefined }),
    });
    const data = await readJsonSafe(r);
    if (!r.ok) throw new Error((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'));
    return { models: data.models || [], keyId: String(kid || '') };
  };
  const btn = $('ap-fetch-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const r = await api('/api/proxy/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: usedKey, apiFormat, keyId: usedKeyId || undefined, providerId: editId || undefined }),
    });
    const data = await readJsonSafe(r);
    if (!r.ok) return toast((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'), true);
    const models = data.models || [];
    if (!models.length) return toast('上游未返回模型', true);
    if (window.OC && window.OC.openFetchedModelsModal) {
      window.OC.openFetchedModelsModal(models, {
        title: '获取到的模型',
        existing: apModelList ? apModelList.getCatalog() : [],
        keys: AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) })),
        fetchedKeyId: usedKeyId || '',
        // 弹窗内切换 Key 继续获取:再次拉取并并入当前清单
        onRefetch: (kid) => fetchByKey(kid),
        onApply: (picked, staleIds) => {
          resetModelTestResults();
          if (apModelList) apModelList.applyFetched(picked, staleIds);
          const n = picked.filter((m) => m.enabled).length;
          const cleared = (staleIds || []).length;
          toast('已应用 ' + n + ' 个启用模型' + (cleared ? '，清除 ' + cleared + ' 个失效模型' : '') + '，保存后生效');
          return true;
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
  const usable = AP_KEYS.filter((k) => String(k.apiKey || '').trim() !== '');
  const pick = usable[0];
  const payload = {
    baseUrl: $('ap-baseurl').value.trim(),
    apiKey: pick && pick.apiKey.indexOf('••') < 0 ? pick.apiKey.trim() : '',
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
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  const cost = Number($('ap-cost').value) || 1;
  if (!baseUrl) return toast('请填写 Base URL', true);
  const models = apModelList ? apModelList.getEnabled() : [];
  if (!models.length) return toast('请先获取模型并至少勾选一个', true);
  const keyErr = apKeysValidate();
  if (keyErr) return toast(keyErr, true);
  // 全部行都提交(含未改动、apiKey 为空的):服务端按 id 复用原密文,
  // 只把「既无新明文也非已保存」的空行丢掉。
  const keys = apKeysPayload().filter((k, idx) => {
    if (String(k.apiKey || '').trim() !== '') return true;
    const src = AP_KEYS[idx];
    return !!(src && src.hasKey);   // 已保存过的密钥:保留占位,服务端沿用原密文
  });
  const editId = $('ap-save').dataset.editId;
  if (!keys.length && !editId) return toast('请至少填写一个 API Key', true);
  const url = editId ? '/api/admin/providers/' + editId : '/api/providers';
  const payload = { name, baseUrl, apiFormat, models, keys, costPerCall: cost, billingMode: ($('ap-billing') && $('ap-billing').getAttribute('data-value')) || 'call', pricePer1k: Math.min(1000, Math.max(0, parseFloat($('ap-price') && $('ap-price').value) || 0)), scope: 'global', keyRevealable: !!($('ap-key-keep') && $('ap-key-keep').checked) };
  // 兼容旧字段:取第一把有明文的 Key 作为主 Key;编辑时若一把都没改,不带 apiKey(服务端保留)
  const firstPlain = keys.find((k) => k.apiKey && k.apiKey.indexOf('••') < 0);
  if (firstPlain) payload.apiKey = firstPlain.apiKey;
  else if (!editId) payload.apiKey = (keys[0] && keys[0].apiKey) || '';
  const saveBtn = $('ap-save');
  saveBtn.disabled = true;
  let okSave = false;
  try {
    const r = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { toast((data.error && data.error.message) || '保存失败', true); return; }
    okSave = true;
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '网络错误'), true);
    return;
  } finally {
    saveBtn.disabled = false;
  }
  if (!okSave) return;
  toast(editId ? '已保存修改' : '全局供应商已添加');
  delete $('ap-save').dataset.editId;
  window.apEditingRevealable = false;
  $('ap-save').textContent = '保存供应商';
  const cancelBtnSave = $('ap-cancel-edit');
  if (cancelBtnSave) cancelBtnSave.classList.add('hidden');
  const noteSave = $('ap-editing-note');
  if (noteSave) noteSave.hidden = true;
  // 恢复表单到「新增」默认态；「保存后保持显示」默认勾选
  $('ap-name').value = ''; $('ap-baseurl').value = '';
  apKeysFromProvider(null);
  resetModelTestResults();
  if (apModelList) { apModelList.setKeys([]); apModelList.reset(); }
  // 计费模式一并回到默认「按次」，避免下次新增供应商继承上次编辑的 token 模式
  if (window.__setApBilling) window.__setApBilling('call');
  if ($('ap-price')) $('ap-price').value = 0;
  if ($('ap-key-keep')) $('ap-key-keep').checked = true;
  loadProviders(); loadStats();
});

// ============ 事件 & 启动 ============
$('back-chat').addEventListener('click', () => location.href = apiUrl('/'));
$('logout-btn').addEventListener('click', () => {
  // 先让服务端吊销会话(审计留痕、token 立即失效),再清本地跳转
  const done = () => {
    localStorage.removeItem('oc_token');
    localStorage.removeItem('oc_user');
    location.href = apiUrl('/login');
  };
  try {
    fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') } })
      .catch(() => {})
      .finally(done);
    setTimeout(done, 2000);
  } catch (e) { done(); }
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
    const hasStatus = typeof l.status === 'number' && l.status > 0;
    const ok = l.error ? false : (hasStatus ? status < 400 : true);
    // 无 HTTP 状态的条目(认证/邮件/管理等)不显示「连接失败」,统一按结果给「成功/失败」
    const statusText = l.error ? '失败' : (hasStatus ? String(status) : (l.status === 0 ? '连接失败' : '成功'));
    const badge = l.kind === 'auth' ? '<span class="log-badge auth">认证</span>'
      : (l.kind === 'parse' ? '<span class="log-badge chat">解析</span>'
      : (l.kind === 'mail' ? '<span class="log-badge auth">邮件</span>'
      : (l.kind === 'admin' ? '<span class="log-badge auth">管理</span>'
      : (status >= 400 || l.error ? '<span class="log-badge err">错误</span>' : '<span class="log-badge chat">对话</span>'))));
    const ms = l.ms !== undefined ? '<span title="' + l.ms + 'ms">' + (l.ms >= 1000 ? (l.ms / 1000).toFixed(1) + 's' : l.ms + 'ms') + '</span>' : '-';
    // 信息列:失败原因 / 解析摘要(note) / 认证动作(action)
    const infoMsg = l.error || l.note || l.action || '';
    // 完整内容:提示词 / 模型回复 / 用量 / 来源 IP;点小眼睛展开查看
    const hasDetail = !!(l.prompt || l.reply || l.usage || l.ip);
    let contentCell = '-';
    if (hasDetail) {
      const usage = l.usage && (l.usage.prompt || l.usage.completion)
        ? '用量：输入 ' + (l.usage.prompt || 0) + ' / 输出 ' + (l.usage.completion || 0) + ' tokens'
        : '';
      const detail = [
        l.ip ? '来源 IP：' + l.ip : '',
        l.action ? '动作：' + l.action : '',
        usage,
        l.prompt ? '【提示词】\n' + l.prompt : '',
        l.reply ? '【模型回复】\n' + l.reply : '',
        l.error ? '【错误】\n' + l.error : '',
      ].filter(Boolean).join('\n\n');
      contentCell = '<button class="log-eye" type="button" data-log-eye title="查看完整内容" aria-label="查看完整内容">' + window.OC.icon('eye', 13) + '</button>';
      tr.dataset.detail = detail;
    }
    tr.innerHTML = '<td>' + fmtTime(l.t) + '</td>'
      + '<td>' + escapeHtml(l.userName || '-') + '</td>'
      + '<td>' + badge + '</td>'
      + '<td>' + escapeHtml(l.provider || '-') + '</td>'
      + '<td>' + escapeHtml(l.model || '-') + '</td>'
      + '<td class="log-status ' + (ok ? 'ok' : 'fail') + '">' + statusText + '</td>'
      + '<td>' + ms + '</td>'
      + '<td>' + (l.cost || 0) + '</td>'
      + '<td class="log-msg" title="' + escapeHtml(infoMsg) + '">' + escapeHtml(infoMsg) + '</td>'
      + '<td class="log-content">' + contentCell + '</td>';
    tbody.appendChild(tr);
  });
}
(function bindLogs() {
  const filters = $('log-filters');
  if (!filters) return;
  const tbody = $('logs-tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const eye = e.target.closest ? e.target.closest('[data-log-eye]') : null;
      if (!eye) return;
      const detail = eye.closest('tr') ? eye.closest('tr').dataset.detail : '';
      if (!detail) return;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal modal-lg log-detail-modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>日志完整内容</h3>'
        + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + window.OC.icon('close', 16) + '</button></div>'
        + '<div class="modal-body"><pre class="log-detail-pre">' + escapeHtml(detail) + '</pre></div>'
        + '</div>';
      document.body.appendChild(mask);
      if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask); else mask.classList.add('show');
      const close = () => { if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(mask); else mask.remove(); setTimeout(() => mask.parentNode && mask.remove(), 360); };
      mask.addEventListener('click', (ev) => { if (ev.target === mask || ev.target.closest('[data-act="close"]')) close(); });
    });
  }
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
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
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
    const renderMarkdown = (el, text) => {
      if (window.OCRenderer && OCRenderer.renderInto) {
        try { OCRenderer.renderInto(el, String(text || '')); return; } catch (e) { /* 回退纯文本 */ }
      }
      el.textContent = String(text || '');
    };
    list.forEach((uc) => {
      html += '<div class="section-title" style="margin-top:14px">' + escapeHtml(uc.user.name) + ' · ' + uc.chats.length + ' 个对话</div>';
      uc.chats.forEach((c) => {
        const msgs = (c.messages || []).map((m) => {
          const who = m.role === 'user' ? '用户' : (m.role === 'system' ? '系统' : 'AI');
          const err = m.error ? ' <span class="log-badge err">失败</span>' : '';
          const reasoning = m.reasoning
            ? '<details class="chat-reasoning"><summary>思维链</summary><div class="chat-reasoning-body"></div></details>'
            : '';
          return '<div class="chat-msg ' + (m.role === 'user' ? 'u' : 'a') + '"><span class="chat-msg-who">' + who + err + '</span>'
            + reasoning
            + '<div class="chat-msg-text md-prose" data-md></div></div>';
        }).join('');
        const expanded = msgs ? '<div class="chat-detail"><div class="chat-detail-msgs">' + msgs + '</div></div>' : '';
        html += '<details class="chat-history-item">'
          + '<summary><span class="chat-h-title">' + escapeHtml(c.title) + '</span>'
          + '<span class="chat-h-meta">' + c.messages.length + ' 条 · ' + fmtTime(c.updatedAt) + '</span></summary>'
          + expanded + '</details>';
      });
    });
    content.innerHTML = html;
    // 逐条渲染 Markdown / 代码 / 公式 / 图片(与前台一致),并在有思维链时填入推理内容
    let mi = 0;
    list.forEach((uc) => {
      uc.chats.forEach((c) => {
        (c.messages || []).forEach((m) => {
          const root = content.querySelectorAll('[data-md]')[mi++];
          if (!root) return;
          renderMarkdown(root, m.content);
          if (m.reasoning) {
            const rb = root.closest('.chat-msg') ? root.closest('.chat-msg').querySelector('.chat-reasoning-body') : null;
            if (rb) renderMarkdown(rb, m.reasoning);
          }
        });
      });
    });
  } catch (e) {
    content.innerHTML = '<p class="muted small">加载失败:' + escapeHtml(e.message) + '</p>';
  }
}

(function bindUserChatsModal() {
  const modal = $('user-chats-modal');
  if (!modal) return;
  const hide = () => {
    if (window.OCUI) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
  };
  const close = $('user-chats-close');
  if (close) close.addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
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
      USER_PAGE = 1; // 切换筛选回到第一页
      filters.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderUsers();
    });
  }
  // 用户表分页
  const prevBtn = $('users-page-prev');
  const nextBtn = $('users-page-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { USER_PAGE -= 1; renderUsers(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { USER_PAGE += 1; renderUsers(); });
  const refreshBtn = $('users-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try { await loadUsers(currentUserKw()); } finally { refreshBtn.disabled = false; }
  });
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
  const wasEdit = !!ASST_FORM_ID; // closeAsstForm 会清空 ASST_FORM_ID,先记下
  closeAsstForm();
  await loadAssistants();
  toast(wasEdit ? '助手已保存' : '已添加助手');
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
    const box = $('smtp-test-result');
    const showResult = (html, isErr) => {
      if (!box) return;
      box.className = 'smtp-test-result' + (isErr ? ' is-err' : ' is-ok');
      box.innerHTML = html;
    };
    testBtn.disabled = true; const old = testBtn.textContent; testBtn.textContent = '发送中…';
    if (box) box.className = 'smtp-test-result hidden';
    try {
      const r = await api('/api/admin/settings/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ($('smtp-test-to') || {}).value || '' }) });
      // 容错解析:服务端 500 时可能返回 HTML 错误页,直接 r.json() 会退化成笼统的「发送失败」
      const d = await readJsonSafe(r);
      const detail = (d.error && d.error.message) || '';
      if (!r.ok) {
        toast('测试邮件发送失败', true);
        showResult('<b>发送失败</b><br>' + escapeHtml(detail || ('服务器返回 HTTP ' + r.status + '，未提供更多信息')), true);
      } else {
        toast('测试邮件已发送到 ' + (d.to || '你的邮箱') + '，请查收');
        showResult('<b>发送成功</b><br>已投递到 ' + escapeHtml(d.to || '你的邮箱') + '。若未收到，请检查收件箱的垃圾邮件/广告邮件分类，并确认收件服务器没有延迟。', false);
      }
    } catch (e) {
      toast('发送失败，请检查网络', true);
      showResult('<b>发送失败</b><br>' + escapeHtml((e && e.message) || '网络错误，请求未能送达服务器'), true);
    }
    finally { testBtn.disabled = false; testBtn.textContent = old; }
  });

  // SMTP 密码:小眼睛切换明文/掩码。未勾选「保存后保持显示」时只显示掩码,点击取回明文会被拒绝
  const passToggle = $('smtp-pass-toggle');
  const passInput = $('smtp-pass');
  if (passToggle && passInput) {
    if (window.OC && window.OC.icon) passToggle.innerHTML = OC.icon('eye', 14);
    const syncEye = () => { passToggle.title = passInput.type === 'text' ? '隐藏密码' : '显示密码'; };
    syncEye();
    passToggle.addEventListener('click', async () => {
      if (passInput.type === 'text') { passInput.type = 'password'; syncEye(); return; }
      // 输入框里已是服务端下发的明文(勾选了保持显示)时直接切类型即可
      const val = passInput.value || '';
      if (val && val.indexOf('••') < 0) { passInput.type = 'text'; syncEye(); return; }
      passToggle.disabled = true;
      try {
        const r = await api('/api/admin/settings/smtp-reveal', { method: 'POST' });
        const d = await readJsonSafe(r);
        if (!r.ok) {
          toast((d.error && d.error.message) || '无法查看密码', true);
          return;
        }
        passInput.value = d.password || '';
        passInput.type = 'text';
        syncEye();
        toast('已显示密码，可复制');
      } catch (e) {
        toast('无法查看密码：' + ((e && e.message) || '网络错误'), true);
      } finally {
        passToggle.disabled = false;
      }
    });
  }
}

let VERIFY_LOADED = false; // 「验证设置」表单是否已从服务端加载成功;未加载时禁止保存,防止把 HTML 默认值写回
async function loadVerifySettings() {
  VERIFY_LOADED = false;
  let d;
  try {
    const r = await api('/api/admin/settings');
    d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
  } catch (e) {
    toast('验证设置加载失败：' + (e.message || '网络错误') + '，为防覆盖未加载保存已禁用', true);
    return;
  }
  VERIFY_LOADED = true;
  const s = d.settings || {}; const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
  ['verify-email-enabled','verify-reset-enabled','verify-quota-unlimited'].forEach((id, i) => { const e=$(id); if(e) e.checked=!![s.emailVerificationEnabled,s.passwordResetEnabled,s.freeQuotaUnlimited][i]; });
  set('verify-free-quota', s.freeQuota); const smtp=s.smtp||{}; set('smtp-host',smtp.host); set('smtp-port',smtp.port||587); set('smtp-user',smtp.username); set('smtp-pass',smtp.password); set('smtp-encryption',smtp.encryption||'tls'); set('smtp-from-name',smtp.fromName||'TinyChat'); set('smtp-from-email',smtp.fromEmail);
  // 「SMTP 密码保存后保持显示」:勾选后服务端直接下发明文,取消勾选则只给掩码
  if ($('smtp-pass-keep')) $('smtp-pass-keep').checked = !!s.smtpKeyRevealable;
  if ($('smtp-pass')) $('smtp-pass').type = 'password';
  if ($('smtp-pass-toggle')) $('smtp-pass-toggle').disabled = false;
  set('session-days', s.sessionDays || 7);
  if ($('apikeys-enabled')) $('apikeys-enabled').checked = s.apiKeysEnabled !== false;
  if ($('invite-required')) $('invite-required').checked = !!s.registerInviteRequired;
  if ($('guest-enabled')) $('guest-enabled').checked = !!s.guestEnabled;
  set('guest-rounds', s.guestRounds || 3);
  // 注册与账号安全(allowRegister 后端强制:关掉后注册接口 403)
  if ($('register-open')) $('register-open').checked = s.allowRegister !== false;
  set('register-limit', s.registerLimitPerHour || 5);
  if ($('user-providers-allowed')) $('user-providers-allowed').checked = s.allowUserProviders !== false;
  set('account-deletion-mode', s.accountDeletionMode || 'soft');
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
        const ok = window.OCUI
          ? await window.OCUI.confirm({ title: '删除邀请码', message: '确认删除邀请码「' + btn.dataset.delInvite + '」？已注册的账号不受影响。', danger: true, confirmText: '删除' })
          : confirm('确认删除邀请码 ' + btn.dataset.delInvite + '?');
        if (!ok) return;
        btn.disabled = true;
        try {
          const r = await api('/api/admin/invites/' + encodeURIComponent(btn.dataset.delInvite), { method: 'DELETE' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) { toast((d.error && d.error.message) || '删除失败', true); btn.disabled = false; return; }
          toast('邀请码已删除');
          loadInvites();
        } catch (e) {
          btn.disabled = false;
          toast('删除失败：' + ((e && e.message) || '网络错误'), true);
        }
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
  const save=$('verify-save'); if(save) save.addEventListener('click',async()=>{
    // 表单未从服务端加载成功时禁止保存:防止把 HTML 默认值(空 SMTP 等)整包写回
    if (!VERIFY_LOADED) { toast('验证设置尚未加载完成，已取消保存', true); return; }
    const old=save.textContent; save.disabled=true; save.textContent='保存中…';
    try {
    const tplPayload=MAIL_TPL.loaded?{mailTemplates:{tplVersion:2,verifySubject:MAIL_TPL.tpl.verify.subject,verifyHtml:MAIL_TPL.tpl.verify.html,resetSubject:MAIL_TPL.tpl.reset.subject,resetHtml:MAIL_TPL.tpl.reset.html}}:{}; const payload=Object.assign({emailVerificationEnabled:!!$('verify-email-enabled').checked,passwordResetEnabled:!!$('verify-reset-enabled').checked,freeQuotaUnlimited:!!$('verify-quota-unlimited').checked,freeQuota:parseInt($('verify-free-quota').value,10)||0,sessionDays:Math.min(30,Math.max(1,parseInt($('session-days')&&$('session-days').value,10)||7)),apiKeysEnabled:!!($('apikeys-enabled')&&$('apikeys-enabled').checked),registerInviteRequired:!!($('invite-required')&&$('invite-required').checked),guestEnabled:!!($('guest-enabled')&&$('guest-enabled').checked),guestRounds:Math.min(1000,Math.max(1,parseInt($('guest-rounds')&&$('guest-rounds').value,10)||3)),allowRegister:!!($('register-open')&&$('register-open').checked),registerLimitPerHour:Math.min(1000,Math.max(1,parseInt($('register-limit')&&$('register-limit').value,10)||5)),allowUserProviders:!!($('user-providers-allowed')&&$('user-providers-allowed').checked),accountDeletionMode:($('account-deletion-mode')&&$('account-deletion-mode').value)||'soft',loginMaxFails:Math.min(50,Math.max(0,parseInt($('login-max-fails')&&$('login-max-fails').value,10)||0)),loginLockMs:Math.min(3600000,Math.max(0,parseInt($('login-lock-sec')&&$('login-lock-sec').value,10)||0))*1000,smtpKeyRevealable:!!($('smtp-pass-keep')&&$('smtp-pass-keep').checked),smtp:{host:$('smtp-host').value.trim(),port:parseInt($('smtp-port').value,10)||587,username:$('smtp-user').value.trim(),password:$('smtp-pass').value,encryption:$('smtp-encryption').value,fromName:$('smtp-from-name').value.trim(),fromEmail:$('smtp-from-email').value.trim()}},tplPayload); const r=await api('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'保存失败',true); toast('验证设置已保存'); } catch(e) { toast('保存失败：' + ((e && e.message) || '网络错误'), true); } finally { save.disabled=false; save.textContent=old; } });
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
  overview: () => { loadStats(); loadSystemBoard(); },
  usage: () => loadStats(),
  users: () => loadUsers(),
  groups: () => loadGroups(),
  access: async () => {
    await loadGroups();
    await loadAccess();
  },
  providers: () => loadProviders(),
  chat: () => loadChatSettings(),
  perf: () => loadPerfSettings(),
  search: () => loadSearchSettings(),
  docs: () => loadSearchSettings(),
  oauth: () => loadOauthSettings(),
  verify: () => loadVerifySettings(),
  // 邀请码页的开关会触发「验证设置」保存:必须先加载完整表单,否则会把未加载的
  // SMTP/注册等默认值整包写回服务端(历史事故:SMTP 配置被清空)
  invite: () => loadVerifySettings(),
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
  announce: () => loadAnnouncement(),
  storage: () => loadStorage(),
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
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return toast('导出失败' + (d.error && d.error.message ? '：' + d.error.message : ''), true);
    }
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
  overview: [{ id: 'overview', label: '概览' }, { id: 'usage', label: '用量分析' }, { id: 'announce', label: '全站公告' }, { id: 'logs', label: '运行日志' }],
  users: [{ id: 'users', label: '用户' }, { id: 'groups', label: '用户组' }, { id: 'access', label: '模型授权' }, { id: 'verify', label: '用户验证' }, { id: 'invite', label: '邀请码' }],
  billing: [
    { id: 'packages', label: '额度套餐' },
    { id: 'codes', label: '兑换码使用情况' },
    { id: 'codes-gen', label: '生成兑换码' },
    { id: 'codes-fixed', label: '添加固定兑换码' },
  ],
  platform: [{ id: 'providers', label: '供应商' }, { id: 'thinking', label: 'AI 思考' }, { id: 'chat', label: '对话设置' }, { id: 'perf', label: '性能优化' }, { id: 'openapi', label: '开放 API' }, { id: 'search', label: '联网搜索' }, { id: 'docs', label: '文档解析' }, { id: 'moderation', label: '内容安全' }, { id: 'oauth', label: '第三方登录' }, { id: 'storage', label: '存储管理' }, { id: 'update', label: '版本更新' }],
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
      // SMTP 凭据可用于冒用站点域名发信:整段置为只读(服务端同样拒绝写入)
      ['smtp-host', 'smtp-port', 'smtp-user', 'smtp-pass', 'smtp-encryption', 'smtp-from-name', 'smtp-from-email', 'smtp-test-btn', 'smtp-test-to', 'verify-save'].forEach((id) => {
        const el = $(id); if (el) el.disabled = true;
      });
      const smtpNote = document.getElementById('smtp-demo-note');
      if (smtpNote) smtpNote.hidden = false;
    }
    // 全局演示还原窗口:用户表单回填用(所有管理员都拉一次,避免编辑表单写死 10)
    try {
      const cr = await api('/api/config');
      const cfg = await cr.json();
      if (cfg && cfg.demoExpireMinutes != null) DEMO_MINUTES_CFG = Math.min(1440, Math.max(1, parseInt(cfg.demoExpireMinutes, 10) || 10));
      if ($('admin-demo-minutes') && data.user && data.user.demo) $('admin-demo-minutes').textContent = DEMO_MINUTES_CFG;
    } catch (e) { /* 提示条/回填不影响后台使用 */ }
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