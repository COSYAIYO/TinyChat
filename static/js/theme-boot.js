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

  // 4. Service Worker 提前注册。SW 文件在站点根目录,而本脚本在 static/js/ 下,
  //    所以要从脚本自身的 URL 里剥掉 static/js/<file> 这一段,剩下的才是站点基址。
  //    五种页面用的是同一种相对/绝对混排写法(./static/js/... 或 /static/js/...),
  //    这样推导对主站、分享页、子目录部署都成立。
  //    不要用 location.pathname 正则截断:/n/<token> 会推出 /n/,
  //    以它作为 scope 注册会被浏览器拒绝(SW 作用域不能窄于脚本所在目录),
  //    结果是笔记分享页根本没有 Service Worker。
  if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      var selfSrc = '';
      try { selfSrc = (document.currentScript && document.currentScript.src) || ''; } catch (e) {}
      if (!selfSrc) {
        // 极端情况下拿不到 currentScript(部分异步/打包环境),退回从 <script src> 里找
        var tags = document.getElementsByTagName('script');
        for (var i = tags.length - 1; i >= 0; i--) {
          var s = String(tags[i].src || '');
          if (/theme-boot(\.min)?\.js/.test(s)) { selfSrc = s; break; }
        }
      }
      if (selfSrc) {
        var root = selfSrc.replace(/\?.*$/, '').replace(/static\/js\/[^/]*$/, '');
        if (root) navigator.serviceWorker.register(root + 'sw.js', { scope: root }).catch(function () {});
      }
    } catch (e) {}
  }
})();
