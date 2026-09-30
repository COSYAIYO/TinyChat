'use strict';
/**
 * ui.js — 共享 UI 基础能力（前台 / 后台通用）
 *  - toast 轻提示（可堆叠、语义色）
 *  - 确认弹窗（Promise 版，替代 window.confirm）
 *  - 弹窗控制（遮罩点击 / Esc 关闭 / 焦点回收）
 *  - 主题（跟随系统 / 浅色 / 深色）
 *  - 用户偏好（localStorage 持久化 + 变更订阅）
 *  - 工具：转义、下载、复制、防抖节流、时间格式化
 *
 * 注意：本文件不声明 $ / escapeHtml 等全局名，避免与页面脚本重复声明冲突。
 */

(function () {
  const UI = {};
  UI.version = '2.0.0';

  const PREF_KEY = 'oc_prefs';
  // 后台「内置字体默认不加载」开启时,默认字体用系统字体(不下载 ~19MB),
  // 用户仍可在「外观」里自行切换为思源宋体/阿里巴巴普惠体等内置字体(切换后会按需加载)。
  function ocNoWebfonts() { return !!(window.OC_PERF && window.OC_PERF.noWebfonts); }
  function ocDefaultCjkFont() { return ocNoWebfonts() ? 'system' : 'source-han-serif'; }
  function ocDefaultLatinFont() { return ocNoWebfonts() ? 'system' : 'alibaba-sans'; }
  const PREF_DEFAULTS = {
    stream: true,          // 流式输出
    followups: false,      // AI 跟进建议(会额外扣费,默认关闭)
    followupsModel: '',    // 跟进建议所用模型:'' = 跟随当前模型;否则 "providerId\nmodelId"
    autotitle: true,       // 自动生成会话标题(新建对话时)
    titleModel: '',        // [已并入 AI 工具判定] 旧字段,仅作迁移回退
    judgeModel: '',        // AI 工具判定所用模型:'' = 跟随当前对话模型;否则 "providerId\nmodelId"
    imageModel: '',        // 默认生图模型:'' = 用第一个可用生图模型;否则 "providerId\nmodelId"
    autoImageMode: 'rough', // 对话中自动出图:off=关闭 | rough=粗略关键词识别 | ai=智能判定(用判定模型)
    autoImageModel: '',    // [已并入 AI 工具判定] 旧字段,仅作迁移回退
    elapsed: true,         // 显示生成耗时
    reasoning: true,       // 请求并展示思维链
    reasoningEffort: 'medium', // off | low | medium | high
    contextMessages: 40,       // 每次请求带上的最近消息条数
    webSearchMode: 'auto',     // auto | on | off
    theme: 'system',       // system | light | dark
    fontSize: 14,          // 消息区字号(px)
    fontFamily: 'source-han-serif', // 旧版兼容:单一字体
    fontCjk: 'source-han-serif',     // 中文字体
    fontLatin: 'alibaba-sans',       // 英文/希腊字母字体
    accent: '',            // 主题色(空 = 默认)
    lastProviderId: null,  // 上次使用的供应商
    lastModel: null,       // 上次使用的模型
    pinnedProviderId: null, // 置顶供应商：新建对话使用
    pinnedModel: null,      // 置顶模型：新建对话使用
  };
  PREF_DEFAULTS.fontCjk = ocDefaultCjkFont();
  PREF_DEFAULTS.fontLatin = ocDefaultLatinFont();
  PREF_DEFAULTS.fontFamily = ocDefaultCjkFont();

  let prefs = null;
  const prefListeners = [];

  // ============ 偏好 ============
  function loadPrefs() {
    if (prefs) return prefs;
    prefs = Object.assign({}, PREF_DEFAULTS);
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (raw && typeof raw === 'object') Object.assign(prefs, raw);
    } catch (e) { /* 忽略损坏数据 */ }
    if (!localStorage.getItem(PREF_KEY)) {
      // 兼容旧版本单独存储的键
      const legacyTheme = localStorage.getItem('oc_theme');
      if (legacyTheme) prefs.theme = legacyTheme;
      if (localStorage.getItem('oc_sidebar_collapsed') === '1') prefs.sidebarCollapsed = true;
    }
    // 旧版本只有一组字体设置:非默认字体同时迁移到两组,默认字体用当前后台默认(可能为系统字体)。
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'fontCjk')) {
      const legacy = String(raw && raw.fontFamily != null ? raw.fontFamily : '').trim();
      prefs.fontCjk = (legacy && legacy !== 'system' && legacy !== 'source-han-serif') ? legacy : ocDefaultCjkFont();
    }
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'fontLatin')) {
      const legacy = String(raw && raw.fontFamily != null ? raw.fontFamily : '').trim();
      prefs.fontLatin = (legacy && legacy !== 'system' && legacy !== 'source-han-serif') ? legacy : ocDefaultLatinFont();
    } else if (raw.fontLatin === 'times-new-roman' && raw.fontFamily === 'source-han-serif') {
      // 仅迁移上一版的默认组合,不覆盖用户明确选择的其他字体。
      prefs.fontLatin = ocDefaultLatinFont();
    }
    // 旧版「命名方式 / 追问判定模型」并入统一的 AI 工具判定模型:
    // 若用户曾单独指定过 (titleModel 或 autoImageModel),迁移到 judgeModel。
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'judgeModel')) {
      const legacyTitle = String((raw && raw.titleModel) || '').trim();
      const legacyAuto = String((raw && raw.autoImageModel) || '').trim();
      if (legacyTitle && legacyTitle !== 'current') prefs.judgeModel = legacyTitle;
      else if (legacyAuto) prefs.judgeModel = legacyAuto;
    }
    return prefs;
  }
  UI.getPrefs = function () { return Object.assign({}, loadPrefs()); };
  UI.getPref = function (key) { return loadPrefs()[key]; };
  UI.setPref = function (key, value) {
    const p = loadPrefs();
    if (p[key] === value) return value;
    p[key] = value;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 存储不可用 */ }
    prefListeners.forEach((fn) => { try { fn(key, value, p); } catch (e) {} });
    return value;
  };
  UI.onPrefsChange = function (fn) { prefListeners.push(fn); };

  // ============ Toast ============
  function toastHost() {
    let host = document.getElementById('oc-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'oc-toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }
  /**
   * @param {string} msg 提示内容
   * @param {boolean|string} type true/'error' = 错误；'success' | 'info'
   */
  UI.toast = function (msg, type) {
    const isError = type === true || type === 'error';
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : (type === 'success' ? ' success' : ''));
    t.textContent = String(msg);
    toastHost().appendChild(t);
    const ttl = isError ? 4200 : 2600;
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 240);
    }, ttl);
    return t;
  };

  // ============ 转义与文本 ============
  UI.escapeHtml = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  UI.escapeAttr = function (s) { return UI.escapeHtml(s); };
  UI.truncate = function (s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  // ============ 剪贴板 / 下载 / 格式化 ============
  UI.copyText = async function (text) {
    const t = String(text === undefined || text === null ? '' : text);
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const done = document.execCommand('copy');
        ta.remove();
        return done;
      } catch (e2) {
        return false;
      }
    }
  };
  UI.download = function (filename, content, mime) {
    try {
      const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      return false;
    }
  };
  UI.fmtBytes = function (n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };
  UI.fmtTime = function (ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  };
  UI.fmtRelative = function (ts) {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return UI.fmtTime(ts);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
    return new Date(Number(ts)).toLocaleDateString('zh-CN');
  };
  UI.fmtDuration = function (ms) {
    const s = Math.max(0, Number(ms) || 0) / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
  };
  UI.debounce = function (fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait);
    };
  };
  UI.throttle = function (fn, wait) {
    let last = 0;
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      const now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) {
        last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(self, args);
        }, remain);
      }
    };
  };
  UI.uid = function (prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };
  // ============ 弹窗控制 ============
  const modalStack = [];
  UI.openModal = function (el) {
    if (!el) return;
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    if (modalStack.indexOf(el) === -1) modalStack.push(el);
    document.body.classList.add('modal-open');
    // 默认焦点优先落在输入框,其次是主操作按钮;绝不落在右上角关闭(X)等图标按钮上,
    // 否则弹窗一打开关闭按钮就带着焦点高亮,视觉上像是被"选中"了。
    const pick = [
      '[data-autofocus]:not([disabled])',
      'input:not([type=hidden]):not([disabled]):not([data-no-autofocus])',
      'textarea:not([disabled]):not([data-no-autofocus])',
      'button.btn.primary:not([disabled]):not([data-no-autofocus])',
      '.modal-footer .btn:not(.icon-btn):not([disabled]):not([data-no-autofocus])',
    ];
    let focusable = null;
    for (const sel of pick) {
      const found = el.querySelector(sel);
      if (found) { focusable = found; break; }
    }
    if (focusable) setTimeout(() => focusable.focus(), 80);
    else {
      // 没有可聚焦元素时,把焦点交给弹窗容器本身(不可见焦点环),避免浏览器把焦点留给关闭按钮
      el.setAttribute('tabindex', '-1');
      el.style.outline = 'none';
      setTimeout(() => el.focus({ preventScroll: true }), 80);
    }
  };
  UI.closeModal = function (el) {
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 320);
    const i = modalStack.indexOf(el);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) document.body.classList.remove('modal-open');
    if (typeof el._onClose === 'function') el._onClose();
  };
  UI.isModalOpen = function () { return modalStack.length > 0; };
  /** 绑定：遮罩点击关闭 + Esc 关闭 + 关闭按钮 */
  UI.bindModal = function (el, opts = {}) {
    if (!el) return;
    el._onClose = opts.onClose;
    el.addEventListener('mousedown', (e) => {
      if (e.target === el && opts.maskClose !== false) UI.closeModal(el);
    });
    if (opts.closeSelector) {
      const btn = el.querySelector(opts.closeSelector);
      if (btn) btn.addEventListener('click', () => UI.closeModal(el));
    }
    if (opts.closeId) {
      const btn = document.getElementById(opts.closeId);
      if (btn) btn.addEventListener('click', () => UI.closeModal(el));
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalStack.length) {
      e.preventDefault();
      UI.closeModal(modalStack[modalStack.length - 1]);
    }
  });

  // ============ 确认弹窗（Promise） ============
  UI.confirm = function (opts = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask oc-confirm-mask';
      mask.innerHTML =
        '<div class="modal modal-sm" role="alertdialog" aria-modal="true">'
        + '<div class="modal-header"><h3>' + UI.escapeHtml(opts.title || '确认操作') + '</h3></div>'
        + '<div class="modal-body"><p class="confirm-message">' + UI.escapeHtml(opts.message || '确定继续吗？') + '</p></div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">' + UI.escapeHtml(opts.cancelText || '取消') + '</button>'
        + '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-act="ok">' + UI.escapeHtml(opts.confirmText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      UI.openModal(mask);
      const done = (v) => {
        UI.closeModal(mask);
        setTimeout(() => mask.remove(), 340);
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return done(false);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        done(act.dataset.act === 'ok');
      });
      mask.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
      });
      setTimeout(() => {
        const okBtn = mask.querySelector('[data-act="ok"]');
        if (okBtn) okBtn.focus();
      }, 60);
    });
  };

  // ============ 主题 ============
  const HLJS = { light: '/vendor/highlight/github.min.css', dark: '/vendor/highlight/github-dark.min.css' };
  UI.resolveTheme = function (mode) {
    const m = mode || UI.getPref('theme') || 'system';
    if (m === 'light' || m === 'dark') return m;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  };
  UI.applyTheme = function (mode, opts = {}) {
    if (mode) UI.setPref('theme', mode);
    const resolved = UI.resolveTheme();
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem('oc_theme', resolved); // 兼容旧逻辑
    const link = document.getElementById('hljs-theme');
    if (link) link.setAttribute('href', (window.API_BASE || '') + HLJS[resolved]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#000000' : '#ffffff');
    if (window.OCRenderer && typeof window.OCRenderer.syncMermaidTheme === 'function') {
      try { window.OCRenderer.syncMermaidTheme(); } catch (e) {}
    }
    UI.applyAppearance();
    if (typeof opts.onChange === 'function') opts.onChange(resolved);
    return resolved;
  };
  UI.initTheme = function () {
    UI.applyTheme(null);
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (UI.getPref('theme') === 'system') UI.applyTheme(null); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    }
    return UI.resolveTheme();
  };
UI.toggleTheme = function () {
    const next = UI.resolveTheme() === 'dark' ? 'light' : 'dark';
    return UI.applyTheme(next);
  };

  // ============ 外观设置:字体大小 / 字体 / 主题色 ============
  const CUSTOM_FONT_KEY = 'oc_custom_fonts'; // {name, cssText}
  const ACCENT_DEFAULT_LIGHT = '#2563eb';
  const ACCENT_VARS = [
    '--accent', '--accent-hover',
    '--brand', '--brand-hover', '--brand-soft', '--brand-soft-strong', '--ring-brand',
    '--primary', '--primary-hover',
    '--active-text', '--active-bar', '--bg-selected',
  ];

  function parseHexColor(hex) {
    const m = String(hex || '').trim().match(/^#([0-9a-fA-F]{3,8})$/);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  function hexOf(c) {
    const p = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + p(c.r) + p(c.g) + p(c.b);
  }
  function mixRgb(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }
  function rgbaOf(c, a) {
    return 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + a + ')';
  }
  function applyAccentVars(root, hex, isDark) {
    const c = parseHexColor(hex);
    if (!c) {
      ACCENT_VARS.forEach((k) => root.style.removeProperty(k));
      return;
    }
    const hover = isDark ? mixRgb(c, { r: 255, g: 255, b: 255 }, 0.28) : mixRgb(c, { r: 0, g: 0, b: 0 }, 0.18);
    const acc = hexOf(c);
    const hoverHex = hexOf(hover);
    root.style.setProperty('--accent', acc);
    root.style.setProperty('--accent-hover', hoverHex);
    root.style.setProperty('--brand', acc);
    root.style.setProperty('--brand-hover', hoverHex);
    root.style.setProperty('--brand-soft', rgbaOf(c, isDark ? 0.12 : 0.08));
    root.style.setProperty('--brand-soft-strong', rgbaOf(c, isDark ? 0.2 : 0.14));
    root.style.setProperty('--ring-brand', rgbaOf(c, isDark ? 0.3 : 0.2));
    root.style.setProperty('--primary', acc);
    root.style.setProperty('--primary-hover', hoverHex);
    root.style.setProperty('--active-text', isDark ? hoverHex : acc);
    root.style.setProperty('--active-bar', acc);
    root.style.setProperty('--bg-selected', rgbaOf(c, isDark ? 0.14 : 0.07));
  }

  const FONT_RULE_ID = 'oc-font-rules';
  const CJK_UNICODE_RANGE = 'U+2E80-2EFF, U+3000-303F, U+3040-30FF, U+3100-312F, U+31A0-31BF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+20000-2FA1F';
  const LATIN_UNICODE_RANGE = 'U+0000-024F, U+0300-036F, U+0370-03FF, U+1E00-1EFF, U+1F00-1FFF, U+2000-206F, U+2070-209F, U+20A0-20CF, U+2100-214F, U+2190-21FF, U+2200-22FF, U+2300-23FF, U+2500-259F, U+25A0-25FF, U+2600-26FF, U+2700-27BF, U+2B00-2BFF, U+FB00-FB06, U+FF00-FFEF';
  const FONT_SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  function cssString(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
  }
  function fontAsset(name) {
    try { return new URL('./static/' + name, document.baseURI).href; }
    catch (e) { return './static/' + name; }
  }
  const BUILTIN_FONT_FILES = {
    'source-han-serif': ['SourceHanSerifCN.otf', 'opentype'],
    'times-new-roman': ['Times New Roman.ttf', 'truetype'],
    'alibaba-puhuiti': ['AlibabaPuHuiTi.ttf', 'truetype'],
    helvetica: ['Helvetica.ttf', 'truetype'],
    'alibaba-sans': ['AlibabaSans.ttf', 'truetype'],
  };
  function fontSource(value, kind) {
    const name = String(value == null ? '' : value).trim();
    const builtin = BUILTIN_FONT_FILES[name];
    const allowed = kind === 'cjk'
      ? name === 'source-han-serif' || name === 'alibaba-puhuiti'
      : name === 'times-new-roman' || name === 'helvetica' || name === 'alibaba-sans';
    if (builtin && allowed) {
      return 'url("' + cssString(fontAsset(builtin[0])) + '") format("' + builtin[1] + '")';
    }
    if (name === 'system' || !name) {
      return 'local("Segoe UI"), local("PingFang SC"), local("Hiragino Sans GB"), local("Microsoft YaHei"), local("Arial")';
    }
    return 'local("' + cssString(name) + '")';
  }
  function applyFontRules(cjkValue, latinValue) {
    let styleEl = document.getElementById(FONT_RULE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = FONT_RULE_ID;
      document.head.appendChild(styleEl);
    }
    const family = 'TinyChat Text';
    styleEl.textContent = '@font-face {'
      + 'font-family:"' + family + '";font-style:normal;font-weight:200 900;font-display:swap;'
      + 'src:' + fontSource(cjkValue, 'cjk') + ';unicode-range:' + CJK_UNICODE_RANGE + ';}'
      + '@font-face {'
      + 'font-family:"' + family + '";font-style:normal;font-weight:200 900;font-display:swap;'
      + 'src:' + fontSource(latinValue, 'latin') + ';unicode-range:' + LATIN_UNICODE_RANGE + ';}';
  }

  // 应用外观:字号/字体/主题色 → CSS 变量
  UI.applyAppearance = function () {
    const prefs = loadPrefs();
    const root = document.documentElement;

    // 1. 字体大小:整页缩放,基准 14px = 100%
    const fs = clampInt(prefs.fontSize, 11, 22, 14);
    const zoom = Math.round((fs / 14) * 1000) / 1000;
    root.style.setProperty('--oc-font-size-msg', fs + 'px');
    root.style.setProperty('--oc-font-size-ui', fs + 'px');
    root.style.setProperty('--fs', fs + 'px');
    root.style.setProperty('--oc-ui-zoom', String(zoom));

    // 2. 中文与英文/希腊字母按 unicode-range 分流,字体未就绪时由 swap 使用系统回退。
    // 后台「内置字体默认不加载」开启时,默认值是「系统字体」(不下载内置字体);
    // 但用户若在「外观」里明确选了思源宋体等内置字体,仍按选择加载,不做硬屏蔽。
    const cjkValue = String(prefs.fontCjk == null || prefs.fontCjk === '' ? ocDefaultCjkFont() : prefs.fontCjk).trim();
    const latinValue = String(prefs.fontLatin == null || prefs.fontLatin === '' ? ocDefaultLatinFont() : prefs.fontLatin).trim();
    applyFontRules(cjkValue, latinValue);
    // 仅当选择的是内置网页字体时才把 "TinyChat Text" 放进字体栈(系统字体无需该族名)
    const usesWebfont = cjkValue === 'source-han-serif' || cjkValue === 'alibaba-puhuiti'
      || latinValue === 'alibaba-sans' || latinValue === 'times-new-roman' || latinValue === 'helvetica';
    const uiStack = (usesWebfont ? '"TinyChat Text", ' : '') + FONT_SYSTEM_STACK;
    root.style.setProperty('--oc-font-family', uiStack);
    root.style.setProperty('--oc-ui-font', uiStack);
    root.style.setProperty('--oc-latin-font', uiStack);

    // 3. 主题色:同步覆盖品牌色 / 主按钮 / 高亮,而不只改 --accent
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyAccentVars(root, prefs.accent, isDark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const acc = parseHexColor(prefs.accent);
      meta.setAttribute('content', acc ? hexOf(acc) : (isDark ? '#000000' : '#ffffff'));
    }
  };
  UI.defaultAccent = ACCENT_DEFAULT_LIGHT;

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  // 本地字体注册:把用户粘贴的 @font-face CSS 存起来(排版用)
  UI.registerCustomFont = function (name, cssText) {
    try {
      const map = JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}');
      map[name] = cssText;
      localStorage.setItem(CUSTOM_FONT_KEY, JSON.stringify(map));
      applyCustomFonts();
      return true;
    } catch (e) { return false; }
  };
  UI.getCustomFonts = function () {
    try { return JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}'); }
    catch (e) { return {}; }
  };
  UI.removeCustomFont = function (name) {
    try {
      const map = JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}');
      delete map[name];
      localStorage.setItem(CUSTOM_FONT_KEY, JSON.stringify(map));
      applyCustomFonts();
    } catch (e) {}
  };
  function applyCustomFonts() {
    let styleEl = document.getElementById('oc-custom-fonts');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'oc-custom-fonts';
      document.head.appendChild(styleEl);
    }
    const map = UI.getCustomFonts();
    styleEl.textContent = Object.values(map).join('\n');
  }
  // 初始化时应用自定义字体
  applyCustomFonts();
  // 脚本一加载就刷主题色,避免等 app.init 期间主按钮仍是默认蓝
  UI.applyAppearance();

  window.OCUI = UI;
  window.toast = UI.toast; // 兼容既有调用(messages.js / multimodal.js)
})();


