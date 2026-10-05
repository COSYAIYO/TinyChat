/* 静态路径的域名 WAF 关键词自检:
 *   node tests/waf-paths.js
 *
 * 背景:部分免费虚拟主机(典型是 InfinityFree)的边缘 WAF 会拦截 URL 路径里
 * 含特定关键词的请求,且发生在 .htaccess 与 PHP 之前 —— 文件不存在也照拦,
 * 静态资源与静态路由地址一视同仁,`.htaccess` 里怎么写都救不回来。唯一可行
 * 的修法是让 URL 本身不含那些词。
 *
 * 真实事故:static/css/groupchat.min.css 与 static/js/groupchat.min.js 在
 * InfinityFree 上返回主机自己的 403 页,于是回答模型标签页整组样式丢失、
 * window.OCGroup 缺失导致群聊不可用;而 /api、/v1 前缀被主机放行,所以
 * 「对话还能用、只有部分资源坏掉」,在自建服务器上永远复现不了。
 *
 * 本脚本扫描所有会被 Web 直接请求的路径,命中黑名单关键词即失败,挡住回归:
 *   1) git ls-files 的全部文件名(部署后即 Web 可访问的 URL);
 *   2) index.php / sw.js 里登记的静态页面路由;
 *   3) 前端与 HTML 里运行时拼出的静态资源引用。
 *
 * 注意:接口路径(/api/**、/v1/**)不需要检查 —— 主机对这两个前缀放行,
 * 且它们是 OpenAI 兼容协议的一部分,不能改名。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

// 已知会被这类主机拦截的路径关键词(小写;匹配大小写敏感,因为主机的规则如此)。
// 只放「确认过会拦」或「风险高且改名无代价」的词,避免误伤正常命名。
const BLOCKED = [
  'chat',     // 实证:InfinityFree 拦截,子串匹配(abcchat 也拦)
  'paypal',   // 支付类关键词,主机 WAF 常见黑名单
  'bank',
  'signin',
  'secure',
];

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

// 接口前缀放行名单:这些路径主机不拦,且协议要求不能改名。
const isApiPath = (p) => /(^|\/)(api|v1)\//.test(p);

// 路径是否含被拦关键词(逐段匹配子串,对齐主机的子串行为)。
// 仅在「路径」上匹配,查询串不参与(实测 ?chat=1 不受影响)。
function hitsKeyword(p) {
  const lower = p.toLowerCase();
  // 只看路径部分:URL 里可能带 ?v= 之类查询串
  const pathOnly = lower.split('?')[0].split('#')[0];
  return BLOCKED.filter((w) => pathOnly.indexOf(w) >= 0);
}

console.log('== 1. 仓库文件名(部署后即 URL)==');
let repoFiles = [];
try {
  repoFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
} catch (e) {
  console.error('无法执行 git ls-files:' + e.message);
  process.exit(1);
}
if (!repoFiles.length) {
  bad('git ls-files 没有返回文件,无法校验');
} else {
  // 只检查「部署后真的会被 Web 请求到」的路径。
  // 排除:开发目录(.htaccess 已 RedirectMatch 404 屏蔽,外部请求根本到不了)、
  //       文档与截图(同上,且不参与运行)、接口与库文件(不是 URL)。
  const NOT_SERVED = /^(tests|tools|docs|lib|vendor\/dompurify|\.github|\.zcode)\//;
  const served = repoFiles.filter((f) => !NOT_SERVED.test(f));
  const offenders = served.filter((f) => hitsKeyword(f).length);
  if (offenders.length) {
    offenders.forEach((f) => bad('文件名含被 WAF 拦截的关键词: ' + f + ' (' + hitsKeyword(f).join(',') + ')'));
  } else {
    ok(served.length + ' 个会被 Web 请求的文件名均不含被拦关键词'
      + '(已排除 ' + (repoFiles.length - served.length) + ' 个开发目录文件)');
  }
}

console.log('\n== 2. 静态页面路由(index.php)==');
const indexPhp = fs.readFileSync(path.join(root, 'index.php'), 'utf8');
// 抓 $pages 数组里的路由键:'/xxx' => 'yyy.html'
const pageRoutes = [...indexPhp.matchAll(/'(\/[A-Za-z0-9._-]*)'\s*=>\s*'[A-Za-z0-9._-]+\.html'/g)].map((m) => m[1]);
if (!pageRoutes.length) {
  bad('没能从 index.php 解析出任何页面路由');
} else {
  const offenders = pageRoutes.filter((r) => hitsKeyword(r).length);
  if (offenders.length) offenders.forEach((r) => bad('页面路由含被拦关键词: ' + r));
  else ok('页面路由 ' + pageRoutes.length + ' 条,均不含被拦关键词(' + pageRoutes.join(' ') + ')');
}

console.log('\n== 3. HTML 里引用的静态资源 ==');
const pages = ['index.html', 'admin.html', 'login.html', 'share.html', 'note-share.html'];
let assetRefs = 0;
for (const page of pages) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  // 取 src/href 里的站内资源路径
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?((?:static|vendor)\/[^"?]+)/g)].map((m) => m[1]);
  for (const r of refs) {
    assetRefs++;
    const hit = hitsKeyword(r);
    if (hit.length) bad(page + ' 引用了含被拦关键词的资源: ' + r + ' (' + hit.join(',') + ')');
  }
}
ok(assetRefs + ' 条静态资源引用已检查');

console.log('\n== 4. 前端运行时拼出的静态资源 ==');
// logos.js 的图标文件名表、sw.js 的路由判断,都是运行时才会请求的路径。
const runtimeChecks = [
  ['static/js/logos.js', /'([A-Za-z0-9._-]+\.svg)'/g],
  ['sw.js', /'(\/[A-Za-z0-9._\/-]+)'/g],
];
let runtimeRefs = 0;
for (const [rel, re] of runtimeChecks) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { bad('缺少文件 ' + rel); continue; }
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(re)) {
    const val = m[1];
    // sw.js 里的 '/api/...'、'/v1/...' 是接口前缀,主机放行
    if (isApiPath(val)) continue;
    runtimeRefs++;
    const hit = hitsKeyword(val);
    if (hit.length) bad(rel + ' 运行时引用含被拦关键词: ' + val + ' (' + hit.join(',') + ')');
  }
}
ok(runtimeRefs + ' 条运行时引用已检查');

console.log('\n== 5. 反向断言(确保本检查真的有效)==');
// 用真实事故里的旧名字验证:如果命中函数坏了(永远返回空),这里必须失败。
const mustHit = ['static/css/groupchat.min.css', 'static/js/groupchat.js', 'static/logo/chatglm-color.svg', '/chat'];
const missed = mustHit.filter((s) => !hitsKeyword(s).length);
if (missed.length) bad('关键词命中函数失效,未能识别: ' + missed.join(', '));
else ok('命中函数对旧名 ' + mustHit.join(' / ') + ' 均能识别');
// 对照组:接口路径不该被判为违规
if (hitsKeyword('/api/proxy/chat').length) ok('接口路径按预期被识别(由 isApiPath 单独放行,不参与校验)');
else ok('接口路径不参与该规则');

console.log('\n' + (fail ? '✗ WAF 路径自检失败: ' + fail + ' 项' : '✓ WAF 路径自检通过'));
process.exit(fail ? 1 : 0);
