'use strict';
/**
 * web.js — 在线浏览器(服务端反向代理渲染 + 网页 AI 总结)
 *
 * 结构:侧栏「在线浏览器」入口 → 全屏弹窗,弹窗自成一体的「浏览器壳」:
 *   标签栏:logo | 多标签页(各自独立地址栈与 iframe,可关闭) | 新建标签
 *   工具条:后退·前进·刷新·首页 | 地址栏 | 阅读模式·原站打开·AI 总结·关闭
 *   首页:收藏夹(内置 Google 学术 / arXiv / PubMed 等 + 自己的收藏)+ 搜索引擎切换
 *   网页:iframe 加载同源代理地址(用户看到的是真实渲染出来的网页,不是正文抽取)
 *   阅读:服务端抽正文后的干净视图(JS 重站点渲染失败时的兜底)
 *
 * 关键约束(改这里前先看 lib/web.php 顶部注释):
 *   被代理页面跑在**不带 allow-same-origin** 的 sandbox iframe 里,所以:
 *   - 它与本页不共享源,只能靠 postMessage 通信(地址/标题/正文都从那边上报);
 *   - 它的脚本读不到本页 localStorage 里的登录令牌,站点会话由服务端 cookie jar 维持;
 *   - 地址栏/历史由本模块维护,不读 iframe 的 location(跨源读不到)。
 *
 * 与 im.js 同款约定:票据鉴权用 URL 参数(iframe 与子资源带不上 Authorization 头),
 * 所以打开时先用 Bearer 换一张短期票据,再把它拼进所有代理地址。
 *
 * 内网闸门是**服务端**权威判定(lib/web.php 的 tc_web_guard);这里只做一次同样的
 * 客户端预检,让用户不必等一个来回就看到「内网地址不可访问」,而不是指望它来兜底。
 */
(function () {
  const S = {
    ready: false, open: false,
    tabs: [], active: 0, seq: 0,     // 多标签页:tabs[i] = { id, view, url, title, hist, hi, reader, ... }
    ticket: '', exp: 0,              // 代理票据(短期)
    defaults: [], mine: [],          // 内置收藏 / 自己的收藏
    engine: 'scholar',
    sum: { busy: false, text: '', err: '', model: '', q: '' },
    usage: { limit: 0, used: 0 },
    textWait: null,
    els: {},
  };

  const ENGINES = [
    { id: 'scholar', name: 'Google 学术', q: 'https://scholar.google.com/scholar?q=%s' },
    { id: 'google', name: 'Google', q: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: '必应', q: 'https://www.bing.com/search?q=%s' },
    { id: 'baidu', name: '百度', q: 'https://www.baidu.com/s?wd=%s' },
    { id: 'arxiv', name: 'arXiv', q: 'https://arxiv.org/search/?searchtype=all&query=%s' },
    { id: 'pubmed', name: 'PubMed', q: 'https://pubmed.ncbi.nlm.nih.gov/?term=%s' },
    { id: 'wiki', name: '维基百科', q: 'https://zh.wikipedia.org/w/index.php?search=%s' },
    { id: 'github', name: 'GitHub', q: 'https://github.com/search?q=%s' },
  ];

  // ============ 小工具 ============
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function icon(name, size) {
    return (window.OC && window.OC.icon) ? window.OC.icon(name, size || 15) : '';
  }
  const SVG_LOGO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/>'
    + '<path d="M12 3.1c2.6 2.5 4 5.6 4 8.9s-1.4 6.4-4 8.9c-2.6-2.5-4-5.6-4-8.9s1.4-6.4 4-8.9z"/></svg>';
  const SVG_HOME = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 10.6 12 4.2l8 6.4"/><path d="M6.2 9.8V20h11.6V9.8"/></svg>';
  const SVG_GLOBE_SM = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/></svg>';
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
  }
  function api(path, opts) { return window.OCApp.api(path, opts); }
  async function apiJson(path, opts) {
    const r = await api(path, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok) throw new Error((data.error && data.error.message) || ('请求失败（HTTP ' + r.status + '）'));
    return data;
  }
  function webEnabled() {
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
      if (cfg && typeof cfg.browserEnabled === 'boolean') return cfg.browserEnabled;
    } catch (e) {}
    return true;
  }
  function isWebPath() {
    try { return location.pathname.replace(/\/+$/, '') === '/browser'; } catch (e) { return false; }
  }
  // 代理地址要 base64url 编码目标地址(与 lib/web.php 的 tc_web_b64d 对应)
  function b64url(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function proxyUrl(url, kind) {
    return '/api/web/' + (kind === 'reader' ? 'read' : 'page') + '?u=' + b64url(url) + '&t=' + encodeURIComponent(S.ticket);
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
  }
  function schemeOf(url) { return /^https:/i.test(url) ? 'https://' : (/^http:/i.test(url) ? 'http://' : ''); }
  // 地址栏只显示 http(s):// 之后的部分 —— 协议由左侧徽标单独呈现,避免出现「https://https://…」
  function bareUrl(url) { return String(url || '').replace(/^[a-zA-Z][\w+.-]*:\/\//, ''); }
  // 输入框 → 真正的地址:像地址就当地址,否则按当前引擎搜索
  function resolveInput(raw) {
    const s = String(raw || '').trim();
    if (s === '') return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(s) && !/\s/.test(s)) return 'https://' + s;
    const eng = ENGINES.find((e) => e.id === S.engine) || ENGINES[0];
    return eng.q.replace('%s', encodeURIComponent(s));
  }
  // 站点图标:直接用目标站自己的 favicon(经代理取,不算直连)
  function faviconHtml(url, size) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return SVG_GLOBE_SM; }
    return '<img class="web-fav" loading="lazy" alt="" src="/api/web/res?u=' + b64url('https://' + host + '/favicon.ico') + '&t=' + encodeURIComponent(S.ticket) + '">';
  }

  // ============ 内网闸门(客户端预检,服务端 tc_web_guard 才是权威) ============
  function isPrivateHost(h) {
    const host = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '' || host === 'localhost') return true;
    if (/\.(local|internal|intranet|lan|home\.arpa|arpa|localhost)$/.test(host)) return true;
    if (host.indexOf(':') >= 0) {                       // IPv6
      if (host === '::1' || host === '::') return true;
      if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;  // fc00::/7 唯一本地
      if (/^fe[89ab][0-9a-f]:/.test(host)) return true;  // fe80::/10 链路本地
      if (/^ff[0-9a-f]{2}:/.test(host)) return true;     // ff00::/8 组播
      if (/^::(ffff:)?/.test(host)) return true;         // ::ffff:a.b.c.d / ::a.b.c.d
      if (/^(2002|2001:0|2001:db8|64:ff9b|100):/.test(host)) return true; // 隧道/过渡段
      return false;
    }
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
      if (a === 169 && b === 254) return true;             // 链路本地 / 云元数据
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && (b === 168 || b === 0)) return true;
      if (a === 198 && (b === 18 || b === 19)) return true;
      if (a >= 224) return true;
      return false;
    }
    return false;
  }
  // 返回空串=放行;否则是给用户看的原因
  function localBlock(url) {
    let u;
    try { u = new URL(url); } catch (e) { return '地址格式不对'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只支持 http/https 地址';
    if (isPrivateHost(u.hostname)) return '内网地址不可访问（含本机与本站自身）';
    if (u.hostname.indexOf('.') < 0) return '无法识别的地址';
    if (u.username || u.password) return '地址不允许携带账号信息';
    return '';
  }

  // ============ 标签页模型 ============
  function tab() { return S.tabs[S.active] || null; }
  function activeEl() { const t = tab(); return t ? t.el : null; }
  function tabTitle(t) {
    if (!t || t.view === 'home' || !t.url) return '新标签页';
    return t.title || hostOf(t.url) || '新标签页';
  }

  function newTab(url, opts) {
    const o = opts || {};
    const t = {
      id: ++S.seq, view: url ? 'page' : 'home',
      url: url || '', title: '', hist: [], hi: -1,
      reader: { url: '', title: '', text: '' },
      frameEl: null, el: document.createElement('div'),
    };
    t.el.className = 'web-tabview hidden';
    S.els.stage.appendChild(t.el);
    if (url) { t.hist = [url]; t.hi = 0; }
    S.tabs.push(t);
    switchTab(S.tabs.length - 1, true);
    if (url) navigate(url, { replace: true });
    return t;
  }

  function switchTab(i, silent) {
    if (i < 0 || i >= S.tabs.length) return;
    S.active = i;
    S.tabs.forEach((t, k) => t.el.classList.toggle('hidden', k !== i));
    const t = tab();
    if (t && t.view === 'page') setLoading(t.loading !== false);
    else setLoading(false);
    if (t && (t.view === 'home' || t.view === '')) renderTabView(t);
    updateChrome(true);
    if (!silent) {
      const inp = t && t.el.querySelector('.web-search-input');
      if (inp) { try { inp.focus(); } catch (e) {} }
    }
  }

  function closeTab(i) {
    if (i < 0 || i >= S.tabs.length) return;
    const t = S.tabs[i];
    t.frameEl = null;                       // 移除容器即卸载 iframe 及其运行中的脚本
    if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    S.tabs.splice(i, 1);
    if (!S.tabs.length) { close(); return; }
    if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
    else if (S.active > i) S.active -= 1;
    S.tabs.forEach((x, k) => x.el.classList.toggle('hidden', k !== S.active));
    updateChrome(true);
  }

  // ============ 弹窗骨架 ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask web-fs-mask hidden';
    mask.innerHTML =
      '<div class="web-fs" role="dialog" aria-modal="true" aria-label="在线浏览器">'
      + '<div class="web-chrome">'
      // 第一行:logo 在最左上角,右边是标签页与新建标签
      + '<div class="web-tabs-row">'
      + '<button class="web-logo" id="web-logo" data-tip="首页" aria-label="回到首页">' + SVG_LOGO + '</button>'
      + '<div class="web-tabs" id="web-tabs" role="tablist" aria-label="标签页"></div>'
      + '<button class="web-icon-btn web-sm" id="web-tab-new" data-tip="新建标签页（Ctrl+T）" aria-label="新建标签页">' + icon('plus', 14) + '</button>'
      + '</div>'
      // 第二行:左上角依次是返回/前进/刷新/首页,右侧是地址栏与动作区
      + '<div class="web-head">'
      + '<button class="web-icon-btn" id="web-back" data-tip="返回上一页" aria-label="返回上一页">' + icon('chevronLeft', 16) + '</button>'
      + '<button class="web-icon-btn" id="web-fwd" data-tip="前进" aria-label="前进">' + icon('chevronRight', 16) + '</button>'
      + '<button class="web-icon-btn" id="web-reload" data-tip="刷新" aria-label="刷新">' + icon('refresh', 15) + '</button>'
      + '<button class="web-icon-btn" id="web-home" data-tip="首页" aria-label="首页">' + SVG_HOME + '</button>'
      + '<form class="web-addr" id="web-addr-form" autocomplete="off">'
      + '<span class="web-addr-scheme hidden" id="web-addr-scheme"></span>'
      + '<input type="text" id="web-addr" placeholder="输入网址，或直接搜索（默认 Google 学术）" spellcheck="false" aria-label="地址栏">'
      + '<button type="submit" class="web-icon-btn web-sm" id="web-go" data-tip="前往" aria-label="前往">' + icon('search', 15) + '</button>'
      + '</form>'
      + '<div class="web-acts">'
      + '<button class="web-icon-btn" id="web-read-btn" data-tip="阅读模式" aria-label="阅读模式">' + icon('eye', 16) + '</button>'
      + '<button class="web-icon-btn" id="web-external" data-tip="在原始网站打开（不走代理）" aria-label="在原始网站打开">' + icon('link', 15) + '</button>'
      + '<button class="web-ai-btn" id="web-ai-btn">' + icon('spark', 15) + '<span>AI 总结</span></button>'
      + '<button class="web-icon-btn" id="web-close" data-tip="关闭（Esc）" aria-label="关闭">' + icon('close', 16) + '</button>'
      + '</div>'
      + '</div>'
      + '</div>'
      + '<div class="web-main">'
      + '<div class="web-stage" id="web-stage">'
      + '<div class="web-loading hidden" id="web-loading"><span class="web-spin"></span><span id="web-loading-text">正在通过服务器加载…</span></div>'
      + '</div>'
      + '<aside class="web-ai-panel hidden" id="web-ai-panel" aria-label="AI 总结">'
      + '<header class="web-ai-head"><span>' + icon('spark', 14) + ' AI 总结</span>'
      + '<button class="web-icon-btn web-sm" id="web-ai-close" aria-label="关闭总结面板">' + icon('close', 14) + '</button></header>'
      + '<div class="web-ai-body" id="web-ai-body"></div>'
      + '<form class="web-ai-ask" id="web-ai-ask" autocomplete="off">'
      + '<input type="text" id="web-ai-q" placeholder="针对本页继续追问…">'
      + '<button type="submit" class="web-icon-btn web-sm" aria-label="发送">' + icon('send', 15) + '</button>'
      + '</form>'
      + '</aside>'
      + '</div>'
      + '</div>';
    document.body.appendChild(mask);
    S.els.mask = mask;
    S.els.stage = mask.querySelector('#web-stage');
    S.els.tabs = mask.querySelector('#web-tabs');
    S.els.addr = mask.querySelector('#web-addr');
    S.els.scheme = mask.querySelector('#web-addr-scheme');
    S.els.loading = mask.querySelector('#web-loading');
    S.els.loadingText = mask.querySelector('#web-loading-text');
    S.els.aiPanel = mask.querySelector('#web-ai-panel');
    S.els.aiBody = mask.querySelector('#web-ai-body');

    mask.querySelector('#web-close').addEventListener('click', close);
    mask.querySelector('#web-logo').addEventListener('click', goHome);
    mask.querySelector('#web-home').addEventListener('click', goHome);
    mask.querySelector('#web-back').addEventListener('click', goBack);
    mask.querySelector('#web-fwd').addEventListener('click', goForward);
    mask.querySelector('#web-reload').addEventListener('click', () => {
      const t = tab();
      if (t && t.url) navigate(t.url, { replace: true, force: true });
      else if (t) renderTabView(t);
    });
    mask.querySelector('#web-tab-new').addEventListener('click', () => newTab());
    S.els.addr.addEventListener('focus', () => { try { S.els.addr.select(); } catch (e) {} });
    mask.querySelector('#web-read-btn').addEventListener('click', toggleReader);
    mask.querySelector('#web-external').addEventListener('click', openExternal);
    mask.querySelector('#web-ai-btn').addEventListener('click', () => summarize(''));
    mask.querySelector('#web-ai-close').addEventListener('click', () => S.els.aiPanel.classList.add('hidden'));
    mask.querySelector('#web-addr-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = resolveInput(S.els.addr.value);
      if (!url) return;
      S.els.addr.blur();
      navigate(url);
    });
    mask.querySelector('#web-ai-ask').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = mask.querySelector('#web-ai-q').value.trim();
      if (!q || S.sum.busy) return;
      mask.querySelector('#web-ai-q').value = '';
      summarize(q);
    });
    // 标签栏:一个委托监听处理「切页」与「关页」
    S.els.tabs.addEventListener('click', (e) => {
      const x = e.target.closest('[data-close]');
      if (x) { e.stopPropagation(); closeTab(Number(x.dataset.close)); return; }
      const b = e.target.closest('[data-tab]');
      if (b) switchTab(Number(b.dataset.tab));
    });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = String(e.key).toLowerCase();
      if (k === 't') { e.preventDefault(); newTab(); }
      else if (k === 'l') { e.preventDefault(); S.els.addr.focus(); }
      else if (k === 'w') { e.preventDefault(); closeTab(S.active); }
    });
    // 被代理页面的上报(地址 / 标题 / 正文)统一从这里进
    window.addEventListener('message', onFrameMessage);
  }

  // ============ 打开 / 关闭 ============
  async function open() {
    const st = window.OCApp && window.OCApp.state;
    if (!st || !st.user) { toast('请先登录后再使用在线浏览器', true); return; }
    if (!webEnabled()) { toast('本站未开放在线浏览器功能', true); return; }
    if (!S.ready) { buildShell(); S.ready = true; }
    if (S.open) return;
    S.open = true;
    const mask = S.els.mask;
    mask.classList.remove('hidden');
    mask.classList.add('show');
    if (window.history && !isWebPath()) { try { history.pushState({ web: true }, '', '/browser'); } catch (e) {} }
    if (window.OCUI) window.OCUI.openModal(mask);
    // closeModal 的落幕定时器不认「已经重开」,320ms 内重开会被它重新挂上 hidden
    setTimeout(() => { if (S.open) mask.classList.remove('hidden'); }, 340);
    try {
      await loadTicket();
      if (S.open && !S.tabs.length) newTab();     // 打开即给一个空白首页标签
      else renderTabs();
      updateChrome(true);
    } catch (e) {
      toast('无法使用在线浏览器：' + e.message, true);
    }
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.els.mask.classList.remove('show');
    const m = S.els.mask;
    setTimeout(() => { if (!S.open) m.classList.add('hidden'); }, 240);
    if (window.OCUI) window.OCUI.closeModal(m);
    if (isWebPath() && window.history) { try { history.pushState(null, '', '/'); } catch (e) {} }
  }

  async function loadTicket(force) {
    // 服务端的 exp 与 Date.now() 同为毫秒(服务端 tc_now() 也是毫秒),留 1 分钟余量提前换票
    if (!force && S.ticket && S.exp > Date.now() + 60000) return;
    const d = await apiJson('/api/web/ticket', { method: 'POST' });
    S.ticket = d.ticket || '';
    S.exp = Number(d.exp) || 0;
    S.defaults = Array.isArray(d.bookmarks) ? d.bookmarks : [];
    S.usage = { limit: Number(d.dailyLimit) || 0, used: Number(d.dailyUsed) || 0 };
    try {
      const u = await apiJson('/api/web/bookmarks');
      S.mine = Array.isArray(u.bookmarks) ? u.bookmarks : [];
    } catch (e) { S.mine = []; }
  }

  // ============ 标签栏 / 地址栏 ============
  function renderTabs() {
    if (!S.els.tabs) return;
    S.els.tabs.innerHTML = S.tabs.map((t, i) => {
      const active = i === S.active;
      return '<div class="web-tab' + (active ? ' active' : '') + '" data-tab="' + i + '" role="tab"'
        + ' aria-selected="' + (active ? 'true' : 'false') + '" title="' + esc(tabTitle(t)) + '">'
        + '<span class="web-tab-ico">' + (t.url ? faviconHtml(t.url) : SVG_GLOBE_SM) + '</span>'
        + '<span class="web-tab-title">' + esc(tabTitle(t)) + '</span>'
        + '<button class="web-tab-x" data-close="' + i + '" aria-label="关闭标签页">' + icon('close', 11) + '</button>'
        + '</div>';
    }).join('');
  }

  function updateChrome(force) {
    const t = tab();
    renderTabs();
    const back = S.els.mask.querySelector('#web-back');
    const fwd = S.els.mask.querySelector('#web-fwd');
    if (back) back.disabled = !t || t.hi <= 0;
    if (fwd) fwd.disabled = !t || t.hi >= t.hist.length - 1;
    const rb = S.els.mask.querySelector('#web-read-btn');
    if (rb) rb.classList.toggle('active', !!t && t.view === 'reader');
    const home = S.els.mask.querySelector('#web-home');
    if (home) home.classList.toggle('active', !!t && t.view === 'home');
    const url = t && t.url ? t.url : '';
    const sch = (t && (t.view === 'page' || t.view === 'reader')) ? schemeOf(url) : '';
    if (S.els.scheme) {
      S.els.scheme.textContent = sch;
      S.els.scheme.classList.toggle('hidden', !sch);
    }
    if (force || document.activeElement !== S.els.addr) {
      S.els.addr.value = (t && t.view !== 'home') ? bareUrl(url) : '';
    }
  }

  // ============ 导航 ============
  function navigate(url, opts) {
    const o = opts || {};
    const t = tab();
    if (!t) return;
    if (!S.ticket) {
      loadTicket().then(() => { if (tab() === t) navigate(url, o); }).catch(() => toast('会话已过期，请重新打开在线浏览器', true));
      return;
    }
    if (!/^https?:\/\//i.test(url)) { toast('只支持 http/https 地址', true); return; }
    const blocked = localBlock(url);
    if (blocked) { toast(blocked, true); return; }
    t.view = 'page';
    t.url = url;
    t.title = o.title || '';
    if (!o.replace) pushHist(t, url);
    else if (t.hi >= 0) t.hist[t.hi] = url;
    renderTabView(t);
    setLoading(true);
  }

  function pushHist(t, url) {
    t.hist = t.hist.slice(0, t.hi + 1);
    if (t.hist[t.hist.length - 1] !== url) t.hist.push(url);
    t.hi = t.hist.length - 1;
  }

  function goBack() {
    const t = tab();
    if (!t) return;
    if (t.hi <= 0) { t.view = 'home'; t.url = ''; t.title = ''; renderTabView(t); return; }
    t.hi -= 1;
    navigate(t.hist[t.hi], { replace: true });
  }
  function goForward() {
    const t = tab();
    if (!t || t.hi >= t.hist.length - 1) return;
    t.hi += 1;
    navigate(t.hist[t.hi], { replace: true });
  }
  function goHome() {
    const t = tab();
    if (!t) return;
    t.view = 'home';
    t.title = '';
    renderTabView(t);
  }

  function renderTabView(t) {
    if (!t) return;
    if (t.view === 'page') { renderPage(t); return; }
    if (t.view === 'reader') { renderReader(t); return; }
    renderHome(t);
  }

  // ============ 首页(收藏夹) ============
  function bookmarks() {
    const out = S.mine.slice();
    const seen = {};
    out.forEach((b) => { seen[b.url] = 1; });
    S.defaults.forEach((b) => { if (!seen[b.url]) { out.push(b); seen[b.url] = 1; } });
    return out;
  }

  function engineName(id) {
    const e = ENGINES.find((x) => x.id === id);
    return e ? e.name : '搜索';
  }

  function renderHome(t) {
    const list = bookmarks();
    const engines = ENGINES.map((e) => '<button class="web-chip' + (e.id === S.engine ? ' active' : '') + '" data-engine="' + e.id + '">' + esc(e.name) + '</button>').join('');
    const el = t.el;
    el.innerHTML =
      '<div class="web-home">'
      + '<div class="web-home-hero">'
      + '<h1>在线浏览器</h1>'
      + '<p class="web-home-sub">网页由本站服务器抓取并渲染，你的浏览器不会直接连接目标网站；内网与本站自身地址一律不可访问。</p>'
      + '<form class="web-search" autocomplete="off">'
      + '<input type="text" class="web-search-input" placeholder="搜索或输入网址" spellcheck="false" aria-label="搜索或输入网址">'
      + '<button type="submit" class="web-search-go" aria-label="搜索">' + icon('search', 16) + '</button>'
      + '</form>'
      + '<div class="web-chips">' + engines + '</div>'
      + '</div>'
      + '<div class="web-bm-head"><span>收藏夹</span>'
      + '<button class="web-link-btn web-bm-add-btn">' + icon('plus', 14) + ' 添加</button></div>'
      + '<div class="web-bm-grid">' + list.map(bookmarkHtml).join('') + '</div>'
      + '<p class="web-home-note">收藏夹保存在你的账号下，换设备也能看到；内置项来自站点设置。</p>'
      + '</div>';
    el.querySelector('.web-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = resolveInput(el.querySelector('.web-search-input').value);
      if (url) navigate(url);
    });
    el.querySelector('.web-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-engine]');
      if (!btn) return;
      S.engine = btn.dataset.engine;
      el.querySelectorAll('.web-chip').forEach((c) => c.classList.toggle('active', c.dataset.engine === S.engine));
      S.els.addr.placeholder = '输入网址，或直接搜索（默认 ' + engineName(S.engine) + '）';
    });
    el.querySelector('.web-bm-add-btn').addEventListener('click', () => addBookmarkPrompt(t));
    el.querySelector('.web-bm-grid').addEventListener('click', onBookmarkClick);
    updateChrome(true);
  }

  function bookmarkHtml(b) {
    const mine = S.mine.some((m) => m.url === b.url);
    return '<div class="web-bm" data-url="' + esc(b.url) + '">'
      + '<a class="web-bm-main" href="#" data-url="' + esc(b.url) + '">'
      + '<span class="web-bm-ico">' + faviconHtml(b.url) + '</span>'
      + '<span class="web-bm-text"><span class="web-bm-name">' + esc(b.name) + '</span>'
      + '<span class="web-bm-host">' + esc(hostOf(b.url)) + '</span></span>'
      + '</a>'
      + (mine ? '<button class="web-bm-del" data-del="' + esc(b.url) + '" title="删除收藏" aria-label="删除收藏">' + icon('close', 12) + '</button>' : '')
      + '</div>';
  }

  function onBookmarkClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.preventDefault();
      const url = del.dataset.del;
      S.mine = S.mine.filter((m) => m.url !== url);
      saveBookmarks().then(() => { const t = tab(); if (t) renderHome(t); }).catch((err) => toast(err.message, true));
      return;
    }
    const a = e.target.closest('a[data-url]');
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.url);
  }

  // 收藏当前页:页内小表单(不用 window.prompt,那个在弹窗里既丑又会打断输入焦点)
  function addBookmarkPrompt(t) {
    const cur = t.url ? (t.title || hostOf(t.url)) : '';
    const wrap = document.createElement('div');
    wrap.className = 'web-bm-add';
    wrap.innerHTML = '<input type="text" class="web-bm-new" placeholder="名称，例如：机器学习论文">'
      + '<input type="text" class="web-bm-new-url" placeholder="网址，例如 scholar.google.com">'
      + '<button class="web-btn-primary web-bm-save">保存</button>'
      + '<button class="web-link-btn web-bm-cancel">取消</button>';
    const head = t.el.querySelector('.web-bm-head');
    if (!head) return;
    head.parentNode.insertBefore(wrap, head.nextSibling);
    wrap.querySelector('.web-bm-new').value = cur;
    wrap.querySelector('.web-bm-new-url').value = t.url || '';
    wrap.querySelector('.web-bm-cancel').addEventListener('click', () => wrap.remove());
    wrap.querySelector('.web-bm-save').addEventListener('click', async () => {
      const name = wrap.querySelector('.web-bm-new').value.trim();
      let url = wrap.querySelector('.web-bm-new-url').value.trim();
      if (!name || !url) { toast('名称和网址都要填写', true); return; }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
      if (!/^https?:\/\//i.test(url)) { toast('网址格式不对', true); return; }
      const blocked = localBlock(url);
      if (blocked) { toast(blocked, true); return; }
      if (!S.mine.some((m) => m.url === url)) S.mine.unshift({ name: name.slice(0, 40), url: url.slice(0, 500) });
      try {
        await saveBookmarks();
        toast('已加入收藏夹');
        renderHome(t);
      } catch (err) { toast(err.message, true); }
    });
  }

  function saveBookmarks() {
    return apiJson('/api/web/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarks: S.mine }),
    });
  }

  // ============ 网页视图(每个标签一个 iframe,切页保留各自状态) ============
  function renderPage(t) {
    if (!t.frameEl) {
      t.el.innerHTML = '<div class="web-page">'
        + '<iframe class="web-frame" title="网页内容"'
        + ' referrerpolicy="no-referrer"'
        // 关键:不带 allow-same-origin —— 被代理页因此成为不透明源,读不到本站令牌
        + ' sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation">'
        + '</iframe></div>';
      const f = t.el.querySelector('.web-frame');
      f.addEventListener('load', () => {
        if (t.loading === false) return;
        t.loading = false;
        if (tab() === t) setLoading(false);
      });
      t.frameEl = f;
    }
    t.loading = true;
    const want = proxyUrl(t.url, 'page');
    if (t.frameEl.getAttribute('src') !== want) t.frameEl.setAttribute('src', want);
    updateChrome(true);
  }

  function setLoading(on) {
    const el = S.els.loading;
    if (el) el.classList.toggle('hidden', !on);
    if (!on && S.els.loadingText) S.els.loadingText.textContent = '正在通过服务器加载…';
  }

  // ============ 阅读模式(服务端抽正文) ============
  async function toggleReader() {
    const t = tab();
    if (!t) return;
    if (t.view === 'reader') {
      if (t.url) navigate(t.url, { replace: true });
      else goHome();
      return;
    }
    const url = t.url || resolveInput(S.els.addr.value);
    if (!url || !/^https?:\/\//i.test(url)) { toast('先打开一个网页', true); return; }
    const blocked = localBlock(url);
    if (blocked) { toast(blocked, true); return; }
    t.view = 'reader';
    t.url = url;
    t.reader = { url: url, title: t.title, text: '', error: '' };
    renderReader(t);
    updateChrome(true);
    try {
      const d = await apiJson('/api/web/read?u=' + encodeURIComponent(b64url(url)) + '&t=' + encodeURIComponent(S.ticket));
      if (tab() !== t) return;
      t.reader.title = d.title || t.reader.title;
      t.reader.text = d.text || '';
      renderReader(t);
    } catch (e) {
      if (tab() !== t) return;
      t.reader.text = '';
      t.reader.error = e.message;
      renderReader(t);
    }
  }

  function renderReader(t) {
    const r = t.reader;
    const body = r.error
      ? '<p class="web-reader-err">' + esc(r.error) + '</p>'
      : (r.text
        ? r.text.split(/\n{2,}/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('')
        : '<p class="web-reader-err">正在抽取正文…</p>');
    t.el.innerHTML = '<div class="web-reader">'
      + '<div class="web-reader-head">'
      + '<button class="web-link-btn web-reader-back">' + icon('link', 14) + ' 回到网页</button>'
      + '<button class="web-btn-primary web-reader-ai">' + icon('spark', 14) + ' AI 总结这篇</button>'
      + '</div>'
      + '<article class="web-reader-art"><h1>' + esc(r.title || hostOf(r.url)) + '</h1>'
      + '<p class="web-reader-src">' + esc(r.url) + '</p>' + body + '</article></div>';
    t.el.querySelector('.web-reader-back').addEventListener('click', () => navigate(r.url, { replace: true }));
    t.el.querySelector('.web-reader-ai').addEventListener('click', () => summarize(''));
    updateChrome(true);
  }

  // ============ 与 iframe 的通信 ============
  function tabByWindow(w) {
    if (!w) return null;
    for (let i = 0; i < S.tabs.length; i++) {
      const f = S.tabs[i].frameEl;
      if (f && f.contentWindow === w) return S.tabs[i];
    }
    return null;
  }

  function onFrameMessage(e) {
    const t = tabByWindow(e.source);
    if (!t) return;                                          // 只认自己这些 iframe 的消息
    const d = e.data;
    if (!d || d.__ocw !== 1) return;
    if (d.type === 'text') { if (S.textWait) { const f = S.textWait; S.textWait = null; f(d); } return; }
    if (d.type === 'load' || d.type === 'navigate') {
      if (!d.url) return;
      if (!t.title || d.type === 'load') t.title = d.title || t.title;
      if (d.url !== t.url) { t.url = d.url; pushHist(t, d.url); }
      t.loading = false;
      if (tab() === t) { setLoading(false); updateChrome(true); }
      else renderTabs();
    }
  }

  // 向 iframe 要正文(JS 渲染出来的内容只有它自己拿得到);拿不到就返回空,由服务端重新抓
  function askFrameText(timeoutMs) {
    const t = tab();
    const w = t && t.frameEl ? t.frameEl.contentWindow : null;
    if (!w) return Promise.resolve(null);
    return new Promise((resolve) => {
      const to = setTimeout(() => { S.textWait = null; resolve(null); }, timeoutMs || 1500);
      S.textWait = (d) => { clearTimeout(to); resolve(d && d.ok ? d.text : null); };
      try { w.postMessage({ __ocwCmd: 'text' }, '*'); } catch (e) { clearTimeout(to); S.textWait = null; resolve(null); }
    });
  }

  // ============ AI 总结 ============
  async function summarize(question) {
    if (S.sum.busy) return;
    const t = tab();
    if (!t) return;
    const url = t.view === 'reader' ? t.reader.url : t.url;
    if (!url && !(t.view === 'reader' && t.reader.text)) { toast('先打开一个网页', true); return; }
    S.els.aiPanel.classList.remove('hidden');
    S.sum.busy = true;
    S.sum.err = '';
    S.sum.q = question || '';
    S.sum.text = '';
    renderAiPanel('正在阅读网页…');
    let text = '';
    let title = t.view === 'reader' ? t.reader.title : t.title;
    if (t.view === 'reader') text = t.reader.text || '';
    else text = (await askFrameText(1800)) || '';
    const st = window.OCApp && window.OCApp.state;
    const payload = {
      url: url || '',
      title: title || '',
      text: text || '',
      question: question || '',
      providerId: (st && st.currentProviderId) || '',
      model: (st && st.currentModel) || '',
    };
    if (!text) renderAiPanel('正在由服务器读取网页正文…');
    try {
      const d = await apiJson('/api/web/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      S.sum.text = d.text || '';
      S.sum.model = d.model || '';
    } catch (e) {
      S.sum.err = e.message || '总结失败';
    } finally {
      S.sum.busy = false;
      try {
        const u = await apiJson('/api/web/usage');
        S.usage = { limit: Number(u.dailyLimit) || 0, used: Number(u.dailyUsed) || 0 };
      } catch (e) { /* 用量拿不到不影响结果 */ }
      renderAiPanel();
    }
  }

  function renderAiPanel(phase) {
    const body = S.els.aiBody;
    if (!body) return;
    const t = tab();
    let html = '';
    const title = t ? (t.view === 'reader' ? t.reader.title : t.title) : '';
    if (title) html += '<div class="web-ai-src">' + esc(title) + '</div>';
    if (S.sum.q) html += '<div class="web-ai-q">' + esc(S.sum.q) + '</div>';
    if (S.sum.busy) html += '<div class="web-ai-busy"><span class="web-spin"></span>' + esc(phase || '正在生成…') + '</div>';
    if (S.sum.err) html += '<div class="web-ai-err">' + esc(S.sum.err) + '</div>';
    if (S.sum.text) {
      html += '<div class="web-ai-md">'
        + ((window.OCRenderer && OCRenderer.render) ? OCRenderer.render(S.sum.text) : '<p>' + esc(S.sum.text) + '</p>')
        + '</div>';
      if (S.sum.model) html += '<div class="web-ai-foot">模型：' + esc(S.sum.model) + '</div>';
    }
    if (S.usage.limit > 0) {
      html += '<div class="web-ai-quota">今日剩余 ' + Math.max(0, S.usage.limit - S.usage.used) + ' / ' + S.usage.limit + ' 次</div>';
    }
    body.innerHTML = html;
    if (window.OCRenderer && OCRenderer.enhance) { try { OCRenderer.enhance(body); } catch (e) {} }
  }

  function openExternal() {
    const t = tab();
    if (!t) return;
    const u = t.view === 'reader' ? t.reader.url : t.url;
    if (!u) { toast('先打开一个网页', true); return; }
    window.open(u, '_blank', 'noopener,noreferrer');
  }

  // ============ 入口 ============
  function initEntry() {
    const btn = document.getElementById('web-entry-btn');
    if (!btn) return;
    if (!webEnabled()) { btn.classList.add('hidden'); return; }
    const iconEl = document.getElementById('web-entry-icon');
    if (iconEl && window.OC && OC.icon) iconEl.innerHTML = OC.icon('search', 15);
    btn.addEventListener('click', open);
    if (isWebPath()) {
      let tries = 0;
      const boot = () => {
        tries++;
        const st = window.OCApp && window.OCApp.state;
        if (st && st.user) { open(); return; }
        if (tries < 40) { setTimeout(boot, 250); return; }
        toast('登录状态未就绪，浏览器暂未打开；请刷新页面或重新登录', true);
      };
      boot();
    }
    window.addEventListener('popstate', () => {
      const shown = S.open && S.els.mask && S.els.mask.classList.contains('show');
      if (isWebPath() && !shown) open();
      else if (!isWebPath() && shown) close();
    });
  }

  window.OCWeb = {
    open, close, navigate,
    isOpen: () => S.open,
    _debug: S,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
