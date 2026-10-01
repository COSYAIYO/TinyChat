/* TinyChat 首屏主题预置(index / admin / login / share 四页共用)。
 * 原先各页面持有一份内联实现且已互相漂移;统一到这里维护。
 * 同步执行:紧跟样式表之后、首帧渲染之前 ——
 *   1) 设置 data-theme(深色用户不再白闪);
 *   2) 代码高亮主题随主题切换(保留各页面声明的路径基准:主站相对、分享页绝对、子目录前缀);
 *   3) 应用用户主题色(accent)到 CSS 变量,主按钮首帧即为目标色;
 *   4) 从自身 URL 的 ?v= 提取发布版本号,暴露为 window.OC_ASSET_V;
 *   5) 提前注册 Service Worker(原先挂在 app.js 尾部,主包加载完才开始缓存 vendor)。
 */
(function () {
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('oc_prefs') || '{}'); } catch (e) {}
  try { window.OC_ASSET_V = ((document.currentScript && document.currentScript.src || '').split('?')[1] || '').replace(/^v=/, ''); } catch (e) {}

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

  // 3. 主题色变量
  try {
    var hex = String(prefs.accent || '').trim();
    var m = hex.match(/^#([0-9a-fA-F]{3,8})$/);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length === 6 || h.length === 8) {
        var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        var t = dark ? 0.28 : 0.18;
        var mix = function (c, d) { return Math.max(0, Math.min(255, Math.round(c + (d - c) * t))); };
        var pad = function (n) { return n.toString(16).padStart(2, '0'); };
        var acc = '#' + pad(r) + pad(g) + pad(b);
        var hover = '#' + pad(mix(r, dark ? 255 : 0)) + pad(mix(g, dark ? 255 : 0)) + pad(mix(b, dark ? 255 : 0));
        var rgba = function (a) { return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')'; };
        var root = document.documentElement;
        root.style.setProperty('--accent', acc);
        root.style.setProperty('--accent-hover', hover);
        root.style.setProperty('--brand', acc);
        root.style.setProperty('--brand-hover', hover);
        root.style.setProperty('--brand-soft', rgba(dark ? 0.12 : 0.08));
        root.style.setProperty('--brand-soft-strong', rgba(dark ? 0.2 : 0.14));
        root.style.setProperty('--ring-brand', rgba(dark ? 0.3 : 0.2));
        root.style.setProperty('--primary', acc);
        root.style.setProperty('--primary-hover', hover);
        root.style.setProperty('--active-text', dark ? hover : acc);
        root.style.setProperty('--active-bar', acc);
        root.style.setProperty('--bg-selected', rgba(dark ? 0.14 : 0.07));
      }
    }
  } catch (e) {}

  // 4. Service Worker 提前注册。SW 路径按部署形态推导:
  //    主站页面取当前目录(相对),分享页(/s/xxx)回退到站点根(分享页脚本是绝对路径约定)。
  if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      var dir = location.pathname.indexOf('/s/') === 0
        ? location.pathname.split('/s/')[0] + '/'
        : location.pathname.replace(/[^/]*$/, '');
      navigator.serviceWorker.register(dir + 'sw.js', { scope: dir }).catch(function () {});
    } catch (e) {}
  }
})();
