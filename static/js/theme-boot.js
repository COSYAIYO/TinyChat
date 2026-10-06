/* TinyChat 首屏主题预置(index / admin / login / share / note-share 五页共用)。
 * 原先各页面持有一份内联实现且已互相漂移;统一到这里维护。
 * 同步执行:紧跟样式表之后、首帧渲染之前 ——
 *   1) 设置 data-theme(深色用户不再白闪);
 *   2) 代码高亮主题随主题切换(保留各页面声明的路径基准:主站相对、分享页绝对、子目录前缀);
 *   3) 应用主题包(theme pack):启用时写入 data-oc-theme 并注入对应样式表;
 *   4) 应用用户主题色(accent)到 CSS 变量,主按钮首帧即为目标色;
 *   5) 从自身 URL 的 ?v= 提取发布版本号,暴露为 window.OC_ASSET_V;
 *   6) 提前注册 Service Worker(原先挂在 app.js 尾部,主包加载完才开始缓存 vendor)。
 *
 * 主题包目录放在本文件而不是单独的 catalog.js:本文件是唯一保证在五页首帧前
 * 同步执行、且已持有站点基址推导逻辑的地方,放这里可以零额外请求完成首帧套用。
 * 消费方(ui.js 的主题市场、app.js 的弹窗)统一读 window.OC_THEME_PACKS。
 */
(function () {
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('oc_prefs') || '{}'); } catch (e) {}
  try { window.OC_ASSET_V = ((document.currentScript && document.currentScript.src || '').split('?')[1] || '').replace(/^v=/, ''); } catch (e) {}

  // 站点基址:从本脚本自身 URL 剥掉 static/js/<file> 这一段。
  // 五种页面用的是同一种相对/绝对混排写法(./static/js/... 或 /static/js/...),
  // 这样推导对主站、分享页、子目录部署都成立。
  var selfSrc = '';
  try { selfSrc = (document.currentScript && document.currentScript.src) || ''; } catch (e) {}
  if (!selfSrc) {
    // 极端情况下拿不到 currentScript(部分异步/打包环境),退回从 <script src> 里找
    var tags = document.getElementsByTagName('script');
    for (var ti = tags.length - 1; ti >= 0; ti--) {
      var ts = String(tags[ti].src || '');
      if (/theme-boot(\.min)?\.js/.test(ts)) { selfSrc = ts; break; }
    }
  }
  var siteRoot = selfSrc ? selfSrc.replace(/\?.*$/, '').replace(/static\/js\/[^/]*$/, '') : '';
  // 暴露给 ui.js:切换主题包时要注入同一路径基准的样式表(子目录部署下 /static/... 是错的)
  window.OC_THEME_CSS_BASE = siteRoot;

  // ---- 主题包目录 ----
  // ownsPalette=true 的主题自带完整配色,此时跳过用户的「主题色」覆盖,
  // 否则 applyAccentVars 的行内变量会盖住主题自己的 --brand/--primary(行内样式优先级最高)。
  // css 为 null 表示默认外观:不加载任何额外样式表。
  // swatch 供主题市场的预览缩略图取色,只放缩略图需要的 5 个色,不重复主题的完整调色板。
  var PACKS = [
    {
      id: 'default',
      name: 'TinyChat 默认',
      desc: '浅色 / 深色的经典外观，蓝色点缀，跟随你的主题色设置',
      ownsPalette: false,
      css: null,
      swatch: {
        light: { bg: '#fcfcfc', panel: '#ffffff', text: '#1d1d1f', accent: '#2563eb', bubble: 'rgba(0, 0, 0, 0.05)' },
        dark: { bg: '#000000', panel: '#1d1d1f', text: '#f5f5f7', accent: '#4d8dff', bubble: 'rgba(255, 255, 255, 0.08)' }
      }
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT 风格',
      desc: '黑白极简配色、大圆角气泡与胶囊输入框，自带配色不跟随主题色',
      ownsPalette: true,
      // 文件名不带 "chatgpt":部分免费虚拟主机的边缘 WAF 会拦 URL 里含 chat 的请求
      // (连静态资源也拦,实证见 tests/waf-paths.js),带上就整份主题 403。
      // 展示名与主题 id 不受影响 —— WAF 只看 URL。
      css: 'static/css/theme-gpt.min.css',
      swatch: {
        light: { bg: '#ffffff', panel: '#f9f9f9', text: '#0d0d0d', accent: '#0d0d0d', bubble: '#f4f4f4' },
        dark: { bg: '#212121', panel: '#171717', text: '#ececec', accent: '#ffffff', bubble: '#303030' }
      }
    },
    {
      id: 'block',
      name: '方块',
      desc: '苹果产品页式的圆角矩形分块，不画分割线，靠留白与浅投影分区，自带配色',
      ownsPalette: true,
      css: 'static/css/theme-block.min.css',
      swatch: {
        light: { bg: '#f5f5f7', panel: '#ffffff', text: '#1d1d1f', accent: '#0071e3', bubble: '#e8e8ed' },
        dark: { bg: '#000000', panel: '#1c1c1e', text: '#f5f5f7', accent: '#0a84ff', bubble: '#2c2c2e' }
      }
    },
    {
      id: 'claude',
      name: 'Claude 风格',
      desc: '暖米白纸感配色、陶土橙点缀，助手整栏通排与宽扁输入框，自带配色',
      ownsPalette: true,
      css: 'static/css/theme-claude.min.css',
      swatch: {
        light: { bg: '#faf9f5', panel: '#ffffff', text: '#1f1e1d', accent: '#c96442', bubble: '#f0eee6' },
        dark: { bg: '#262624', panel: '#30302e', text: '#f5f4ef', accent: '#d97757', bubble: '#30302e' }
      }
    }
  ];
  window.OC_THEME_PACKS = PACKS;

  function findPack(id) {
    id = String(id || '').trim();
    for (var i = 0; i < PACKS.length; i++) if (PACKS[i].id === id) return PACKS[i];
    return PACKS[0]; // 未知 id(降级/被改坏的偏好)一律回落到默认,不让页面套上半截样式
  }

  // 1. 主题:外观偏好 > 旧键 oc_theme > 系统偏好
  var pref = String(prefs.theme || '').trim();
  var saved = null;
  try { saved = localStorage.getItem('oc_theme'); } catch (e) {}
  var dark = pref === 'dark' || (pref !== 'light' && (
    saved === 'dark'
    || (saved !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ));
  var theme = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);

  // 2. 代码高亮主题跟 data-theme 一起切,否则深色访客会看到深色页面贴一块白底代码块
  var hljs = document.getElementById('hljs-theme');
  if (hljs) {
    var href = String(hljs.getAttribute('href') || '');
    if (/highlight\/[^?\/]+\.css/.test(href)) {
      hljs.setAttribute('href', href.replace(/highlight\/[^?\/]+\.css/, 'highlight/' + (dark ? 'github-dark.min.css' : 'github.min.css')));
    }
  }

  // 3. 主题包:先写 data-oc-theme(样式表里的规则全部以此为前缀),再注入样式表。
  //    在 <head> 解析期间插入 <link rel=stylesheet> 会阻塞渲染,所以首帧即为目标外观,
  //    不会出现"先默认主题、样式表到位后再跳一下"的闪烁。
  var pack = findPack(prefs.themePack);
  document.documentElement.setAttribute('data-oc-theme', pack.id);
  if (pack.css && siteRoot) {
    try {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.id = 'oc-theme-pack-css';
      link.href = siteRoot + pack.css + (window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : '');
      (document.head || document.documentElement).appendChild(link);
    } catch (e) {}
  }

  // 4. 主题色变量(主题包自带配色时跳过,理由见上面 ownsPalette 注释)
  if (!pack.ownsPalette) try {
    var hex = String(prefs.accent || '').trim();
    var m = hex.match(/^#([0-9a-fA-F]{3,8})$/);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length === 6 || h.length === 8) {
        var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        var alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        var t = dark ? 0.28 : 0.18;
        var mix = function (c, d) { return Math.max(0, Math.min(255, Math.round(c + (d - c) * t))); };
        var hr = mix(r, dark ? 255 : 0), hg = mix(g, dark ? 255 : 0), hb = mix(b, dark ? 255 : 0);
        var rgba = function (rr, gg, bb, a) {
          return 'rgba(' + rr + ', ' + gg + ', ' + bb + ', ' + Math.round(a * alpha * 1000) / 1000 + ')';
        };
        var acc = rgba(r, g, b, 1);
        var hover = rgba(hr, hg, hb, 1);
        var root = document.documentElement;
        root.style.setProperty('--accent', acc);
        root.style.setProperty('--accent-hover', hover);
        root.style.setProperty('--brand', acc);
        root.style.setProperty('--brand-hover', hover);
        root.style.setProperty('--brand-soft', rgba(r, g, b, dark ? 0.12 : 0.08));
        root.style.setProperty('--brand-soft-strong', rgba(r, g, b, dark ? 0.2 : 0.14));
        root.style.setProperty('--ring-brand', rgba(r, g, b, dark ? 0.3 : 0.2));
        root.style.setProperty('--primary', acc);
        root.style.setProperty('--primary-hover', hover);
        root.style.setProperty('--active-text', dark ? hover : acc);
        root.style.setProperty('--active-bar', acc);
        root.style.setProperty('--bg-selected', rgba(r, g, b, dark ? 0.14 : 0.07));
      }
    }
  } catch (e) {}

  // 5. Service Worker 提前注册。SW 文件在站点根目录,基址由上面剥出的 siteRoot 给出。
  //    不要用 location.pathname 正则截断:/n/<token> 会推出 /n/,
  //    以它作为 scope 注册会被浏览器拒绝(SW 作用域不能窄于脚本所在目录),
  //    结果是笔记分享页根本没有 Service Worker。
  if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      if (siteRoot) navigator.serviceWorker.register(siteRoot + 'sw.js', { scope: siteRoot }).catch(function () {});
    } catch (e) {}
  }
})();
