/* 主题包契约自检:
 *   node tests/theme-pack.js
 *
 * 锁住四条「写错了也不报错、只会静默走样」的约定:
 *   1) 主题样式表的每条选择器都必须带 html[data-oc-theme=...] 前缀。漏掉一条,
 *      那条规则就会漏进默认外观 —— 而默认外观必须与引入主题市场之前逐像素一致,
 *      这种走样没有任何报错,只能靠约定挡住。
 *   2) 目录里每个主题的 css 路径必须真实存在(.min 旁车也在)。路径写错时浏览器
 *      只会静默 404,表现为「点了主题没反应」。
 *   3) 「主题市场」入口在用户菜单里位于「开源地址」之后(产品要求的位置)。
 *   4) 主题 id 进了 tc_settings_prefs 白名单,否则换设备后主题不跟着账号回来。
 * 另: 主题文件名不得含 WAF 关键词 —— 静态资源被主机 403 时表现为「主题半残」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (name, cond, detail) => { if (cond) ok(name); else bad(name + (detail ? ' — ' + detail : '')); };

// ---- 1. 在最小沙箱里跑 theme-boot.js,取出真实目录(而不是正则抠字符串)----
function loadPacks(prefs) {
  const linkSink = [];
  const el = () => ({
    setAttribute() {}, remove() {}, style: { setProperty() {}, removeProperty() {} },
    getAttribute: () => null, appendChild() {}, classList: { add() {}, remove() {} },
  });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: (k) => (k === 'oc_prefs' && prefs ? JSON.stringify(prefs) : null), setItem() {}, removeItem() {} },
    location: { protocol: 'http:', hostname: 'localhost', pathname: '/' },
    navigator: {},
    matchMedia: () => ({ matches: false }),
    document: {
      currentScript: { src: 'http://localhost/static/js/theme-boot.min.js?v=9.9.9' },
      documentElement: { setAttribute() {}, getAttribute: () => null, style: { setProperty() {}, removeProperty() {} } },
      head: { appendChild: (n) => linkSink.push(n) },
      getElementById: () => null,
      getElementsByTagName: () => [],
      createElement: () => { const n = el(); return n; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'static', 'js', 'theme-boot.js'), 'utf8'), sandbox, { filename: 'theme-boot.js' });
  return { packs: sandbox.window.OC_THEME_PACKS || [], links: linkSink };
}

console.log('== 1. 主题目录结构 ==');
const { packs, links } = loadPacks(null);
check('目录已定义 OC_THEME_PACKS', Array.isArray(packs) && packs.length > 0);
check('首个主题是默认外观', packs[0] && packs[0].id === 'default');
check('默认主题不加载额外样式表', packs[0] && !packs[0].css);
check('未选主题时不注入任何样式表', links.length === 0, '注入了 ' + links.length + ' 个');
packs.forEach((p) => {
  check('主题 ' + p.id + ' 有名称与描述', !!(p.name && p.desc));
  check('主题 ' + p.id + ' 声明了 ownsPalette', typeof p.ownsPalette === 'boolean');
  check('主题 ' + p.id + ' 带预览配色', !!(p.swatch && p.swatch.light && p.swatch.dark));
});

// 收集样式表里全部会生效的选择器。
// 递归下钻:@media / @supports 这类容器块自己不是选择器,但它内部的规则同样是会生效的
// 规则,必须一并校验 —— 只扫顶层的话,容器里写什么都能溜过自检。
function scanSelectors(css) {
  const selectors = [];
  const scan = (text) => {
    let buf = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '}') { buf = ''; i++; continue; }
      if (ch !== '{') { buf += ch; i++; continue; }
      const sel = buf.trim();
      buf = '';
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(i + 1, j - 1);
      if (sel) {
        // @keyframes 内部是 0%/from/to 这类关键帧选择器,不是规则,跳过整块
        if (/^@(-\w+-)?keyframes\b/.test(sel)) { /* 跳过 */ }
        else if (sel.charAt(0) === '@') scan(body);
        else selectors.push(sel);
      }
      i = j;
    }
  };
  scan(css);
  return selectors;
}

console.log('== 2. 主题样式表 ==');
const themed = packs.filter((p) => p.css);
check('至少有一个非默认主题', themed.length > 0);
const WAF_BLOCKED = ['chat', 'paypal', 'bank', 'signin', 'secure'];
themed.forEach((p) => {
  const srcPath = path.join(root, p.css.replace(/\.min\.css$/, '.css'));
  const minPath = path.join(root, p.css);
  check(p.id + ': 源样式表存在', fs.existsSync(srcPath), p.css);
  check(p.id + ': .min 旁车存在(浏览器实际请求的是它)', fs.existsSync(minPath), p.css);
  const hit = WAF_BLOCKED.filter((w) => p.css.toLowerCase().indexOf(w) >= 0);
  check(p.id + ': 文件名不含 WAF 关键词', hit.length === 0, '命中 ' + hit.join(','));
  if (!fs.existsSync(srcPath)) return;

  const css = fs.readFileSync(srcPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = scanSelectors(css);
  const prefixed = 'html[data-oc-theme="' + p.id + '"]';
  const leaked = selectors
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s && s.indexOf(prefixed) !== 0);
  check(p.id + ': 全部 ' + selectors.length + ' 条规则都限定在 ' + prefixed + ' 下', leaked.length === 0,
    '漏出 ' + leaked.length + ' 条:' + leaked.slice(0, 3).join(' | '));
  check(p.id + ': 定义了浅色与深色调色板',
    css.indexOf(prefixed + ' {') >= 0 && css.indexOf(prefixed + '[data-theme="dark"]') >= 0);
});

// 反向断言:上面那条「全部限定在前缀下」只有在扫描器真的能看见选择器时才有意义。
// 这里喂一段同时含顶层规则、@media 内规则与 @keyframes 的样式,验证前两者被收进
// 结果、关键帧不被误当成选择器。
const probe = scanSelectors(
  'html[data-oc-theme="x"] .a{color:red}' +
  '@media (hover:hover){html[data-oc-theme="x"] .b{color:red}.leak{color:red}}' +
  '@keyframes spin{0%{opacity:0}to{opacity:1}}'
);
check('反向断言:扫描器能看见顶层与 @media 内的选择器、且不误收关键帧',
  probe.length === 3 && probe.indexOf('.leak') >= 0 && probe.indexOf('0%') < 0,
  JSON.stringify(probe));

console.log('== 3. 启用后确实注入样式表 ==');
const on = loadPacks({ themePack: themed.length ? themed[0].id : 'default' });
check('启用主题后注入了 1 个样式表', on.links.length === 1, '注入了 ' + on.links.length + ' 个');
const injected = on.links[0] || {};
check('注入的是 link[rel=stylesheet]', injected.rel === 'stylesheet');
check('注入的 id 固定为 oc-theme-pack-css', injected.id === 'oc-theme-pack-css');
check('样式表 URL 带上发布版本号(?v=)', /theme-[\w-]+\.min\.css\?v=9\.9\.9$/.test(String(injected.href || '')), String(injected.href || ''));
const off = loadPacks({ themePack: 'no-such-theme' });
check('未知主题 id 回落到默认(不注入样式表)', off.links.length === 0);

console.log('== 4. 入口位置与接线 ==');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const githubAt = html.indexOf('id="user-menu-github"');
const themeAt = html.indexOf('id="user-menu-theme"');
check('index.html 有「主题市场」菜单项', themeAt >= 0);
check('「主题市场」位于「开源地址」之后', githubAt >= 0 && themeAt > githubAt);
check('index.html 有主题市场弹窗', html.indexOf('id="theme-market-modal"') >= 0 && html.indexOf('id="theme-grid"') >= 0);
check('设置 → 外观 也有入口', html.indexOf('id="pref-theme-pack"') >= 0);
const ui = fs.readFileSync(path.join(root, 'static', 'js', 'ui.js'), 'utf8');
check('ui.js 暴露 applyThemePack', ui.indexOf('UI.applyThemePack =') >= 0);
// 云同步拉回新偏好时只会走到 applyAppearance,主题必须在那里落 DOM
const appearance = ui.slice(ui.indexOf('UI.applyAppearance = function'), ui.indexOf('UI.defaultAccent'));
check('applyAppearance 内部会同步主题包 DOM(云同步恢复依赖它)', appearance.indexOf('syncThemePackDom(pack)') >= 0);
const app = fs.readFileSync(path.join(root, 'static', 'js', 'app.js'), 'utf8');
check('app.js 接线了两个入口', app.indexOf("$('user-menu-theme')") >= 0 && app.indexOf("$('pref-theme-pack')") >= 0);

console.log('== 5. 服务端白名单 ==');
const api = fs.readFileSync(path.join(root, 'lib', 'api.php'), 'utf8');
const prefsFn = api.slice(api.indexOf('function tc_settings_prefs'), api.indexOf('function tc_settings_ui'));
check('tc_settings_prefs 白名单含 themePack', /'themePack'\s*=>/.test(prefsFn));

console.log(fail ? '\n✗ 主题包契约自检未通过(' + fail + ' 项)' : '\n✓ 主题包契约自检通过');
process.exit(fail ? 1 : 0);
