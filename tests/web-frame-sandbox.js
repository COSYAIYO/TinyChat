/* 在线浏览器 iframe 沙箱契约自检:
 *   node tests/web-frame-sandbox.js
 *
 * 背景:被代理的网页由**本站服务器**转发到 /api/web/page,所以它在浏览器眼里是
 * 同源文档。整个隔离模型只有一道防线 —— `sandbox` 属性里**不带 allow-same-origin**
 * 让文档变成不透明源,读不到 localStorage 里的 oc_token。
 *
 * 真实事故:该属性曾同时带着 `allow-popups-to-escape-sandbox`。这个标志会让弹窗
 * **完全脱离沙箱**:被代理页里的 window.open(u) 被垫片改写成本站同源的
 * /api/web/page?...,于是弹窗就是一个普通的同源文档,可直读 localStorage.oc_token
 * 并把令牌外发。一个标志作废了整个隔离模型,而在界面上完全看不出异常。
 *
 * 这类「属性里少写/多写一个词、功能照常、只是不再安全」的问题读代码极易看漏
 * (那一行还很长),所以在 CI 里钉成契约:任何一项不合规就失败。
 *
 * 检查的是源码 web.js —— web.min.js 由 tools/release.mjs 从它生成,同源同校验。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static/js/web.js'), 'utf8');

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); };
const check = (m, c, d) => { if (c) ok(m); else bad(m, d); };

// 取出 iframe 的 sandbox 属性值(可能被拼成 ' a b c' 这样的字符串字面量)
const m = src.match(/sandbox="([^"]*)"/);
if (!m) {
  bad('在 web.js 里找得到 iframe 的 sandbox 属性');
  console.log('\n失败 1 项\n');
  process.exit(1);
}
const raw = m[1];
const tokens = raw.split(/\s+/).filter(Boolean);
console.log('  当前 sandbox = "' + raw + '"');

// —— 必须不带:这些标志会把「不透明源」变回同源,或在同源下打开新窗口/下载 ——
const forbidden = {
  'allow-same-origin': '会让被代理页变回本站同源,直读 localStorage.oc_token',
  'allow-popups-to-escape-sandbox': '弹窗完全脱离沙箱,而垫片把 window.open 改写成本站同源地址',
  'allow-top-navigation': '可把整个本站导航去任意地址(钓鱼)',
  'allow-top-navigation-by-user-activation': '同上,只是需要一次点击',
  'allow-downloads': '与 allow-popups 组合是已知的偷跑下载手法,且下载经本站源发起',
  'allow-same-origin-as-credentialed': '非标准,出现即为误写',
};
for (const [flag, why] of Object.entries(forbidden)) {
  check('不带 ' + flag + '（' + why + '）', !tokens.includes(flag), '实际带了');
}

// —— 必须带:站内跳转与表单要能用,否则被代理页点不动 ——
for (const flag of ['allow-scripts', 'allow-forms']) {
  check('保留 ' + flag, tokens.includes(flag), '缺失会导致被代理页交互失效');
}
// allow-popups 保留(弹窗继承沙箱,可用);但要确保上面那条 escape 标志不在
check('保留 allow-popups(弹窗继承沙箱,不会被上面那条一起删掉)',
  tokens.includes('allow-popups'), '缺失会导致 target=_blank 类跳转失效');

// 兜底:属性必须原样出现在产物里,且同源相关字样不得以任何形式出现
check('iframe 同时带 referrerpolicy="no-referrer"',
  /referrerpolicy="no-referrer"/.test(src), '缺少会让目标站拿到本站地址作为 Referer');

// 垫片把 window.open / location 改写成本站同源地址 —— 这是上面那条 escape 标志
// 之所以致命的直接原因。这里一并钉住,防止垫片被改成直连目标站(会泄漏真实 IP)。
const shim = fs.readFileSync(path.join(root, 'static/js/web-shim.js'), 'utf8');
check('垫片改写 window.open 而不是直连目标站(否则泄漏用户真实 IP)',
  /window\.open\s*=\s*function/.test(shim), '未找到 window.open 改写');
check('垫片保留 referrerpolicy 之外的导航改写(location 系列)',
  /Location\.prototype/.test(shim), '未找到 Location 改写');

console.log(fail === 0 ? '\n沙箱契约自检通过\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
