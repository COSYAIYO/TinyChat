/* 渲染管线 HTML 消毒浏览器自检(真 Chromium):
 *   node tests/renderer-xss.mjs
 *
 * 对话页允许 Markdown 渲染 HTML(模型回答、用户消息、分享页都走同一条管线),
 * 因此消毒器是这条管线的安全底线。这一组用例锁住「既能渲染、又不可执行」:
 *   A. 可执行的 HTML 一律被拦:脚本标签、事件属性、危险协议;
 *   B. 旧实现漏掉的三个绕过必须挡住:
 *      1) java&#9;script: / &#01;javascript: —— 浏览器解析时会剥掉内嵌
 *         制表符与控制字符,旧实现只 trim 两端再做正则匹配,会被绕过;
 *      2) SVG 命名空间事件(<animate onbegin=…>),旧实现只在 HTML 分支拦事件;
 *      3) 消毒过程本身触发事件 —— 旧实现把待消毒 HTML 塞进活体 <div>,
 *         <img src=x onerror=…> 会在节点被删除前就派发 onerror。
 *   C. 合规排版 HTML 必须保留:表格、卡片样式、details、代码块复制按钮、相对/绝对链接;
 *   D. 链接外开带 noopener,图片走 data:image 白名单。
 *
 * 需要 playwright 与 chromium;缺失时自动跳过并返回 0(不阻塞 CI)。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };

// 与 tests/chat-mentions-gui.mjs 同一套解析:本地安装优先,其次 npx 缓存。
async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未本地安装 */ }
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const p = join(cache, dir, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) candidates.push(pathToFileURL(p).href);
    }
  }
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 试下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('未安装 playwright,跳过渲染消毒浏览器自检(不阻塞 CI)'); process.exit(0); }

// 真静态服务器:Chromium 不允许 file:// 页面再去加载 file:// 子资源
// (跨源 file 访问被拦),因此这里起一个只读的静态服务,把仓库目录本身当站点根
// —— 与浏览器里真实加载的 renderer.js / vendor 完全同一份文件。
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const full = join(ROOT, rel.replace(/^\/+/, ''));
    // 目录穿越防护:解析后仍须位于仓库内
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await readFile(full);
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
const PORT = Number(process.env.RENDER_TEST_PORT || 8321);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});
const ORIGIN = `http://127.0.0.1:${PORT}`;

const browser = await pw.chromium.launch();
const page = await browser.newPage();
await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async () => {
  // index.html 通过 perf.js 注入了 markdown-it / DOMPurify / katex / highlight;
  // 这里再按顺序补上和线上一致的加载链,确保 renderer 拿到全部依赖。
  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error('load fail ' + src));
    document.head.appendChild(s);
  });
  const out = { errors: [] };
  try {
    if (typeof window.markdownit === 'undefined') await load('/vendor/markdown-it/markdown-it.min.js');
    if (!window.DOMPurify) await load('/vendor/dompurify/purify.min.js');
    if (typeof window.katex === 'undefined') await load('/vendor/katex/katex.min.js');
    if (typeof window.hljs === 'undefined') await load('/vendor/highlight/highlight.min.js');
    if (!window.OCRenderer) await load('/static/js/renderer.js');
  } catch (e) {
    out.errors.push('脚本加载失败: ' + e.message);
    return out;
  }
  if (!window.OCRenderer) { out.errors.push('OCRenderer 未挂载'); return out; }
  if (!window.DOMPurify) { out.errors.push('DOMPurify 未加载'); return out; }

  // 每次渲染都放到一个挂到文档上的容器里,并把「是否真的执行过」记在计数器上。
  window.__pwn = 0;
  const sandbox = document.createElement('div');
  document.body.appendChild(sandbox);

  function renderInto(md) {
    sandbox.innerHTML = '';
    const html = window.OCRenderer.render(md);
    sandbox.innerHTML = html;
    // 触发惰性事件(图片加载失败会派发 onerror)
    return html;
  }

  out.render = (md) => renderInto(md);

  // A/B: 攻击载荷 —— 期望「渲染后不产生可执行结果」
  out.attacks = {
    'script 标签': '<script>window.__pwn=1<\/script>',
    'img onerror': '<img src="x-does-not-exist" onerror="window.__pwn=1">',
    'onerror 大小写混写': '<img src="x-does-not-exist" OnErRoR="window.__pwn=1">',
    'a href javascript:': '<a href="javascript:window.__pwn=1">x</a>',
    'a href 制表符绕过': '<a href="java&#9;script:window.__pwn=1">x</a>',
    'a href 控制字符绕过': '<a href="&#01;javascript:window.__pwn=1">x</a>',
    'a href 换行绕过': '<a href="java\nscript:window.__pwn=1">x</a>',
    'svg animate onbegin': '<svg><animate onbegin="window.__pwn=1" attributeName="x" dur="1s"></animate></svg>',
    'form + action 表单注入': '<form action="javascript:window.__pwn=1"><input autofocus></form>',
    'iframe srcdoc': '<iframe srcdoc="<script>parent.__pwn=1<\/script>"></iframe>',
    'object data': '<object data="javascript:window.__pwn=1"></object>',
    'style 表达式': '<div style="width:expression(window.__pwn=1)">x</div>',
    'math 命名空间': '<math><mtext><img src=x onerror="window.__pwn=1"></mtext></math>',
    'body onload': '<body onload="window.__pwn=1">x</body>',
    'base href 劫持': '<base href="javascript:window.__pwn=1">',
    'meta refresh': '<meta http-equiv="refresh" content="0;url=javascript:window.__pwn=1">',
    'template 嵌套': '<template><img src=x onerror="window.__pwn=1"></template>',
  };
  out.attackResults = {};
  for (const [name, payload] of Object.entries(out.attacks)) {
    sandbox.innerHTML = '';
    try {
      const html = window.OCRenderer.render(payload);
      sandbox.innerHTML = html;
      // 事件可能异步派发,给一帧时间
      await new Promise((r) => setTimeout(r, 30));
      out.attackResults[name] = {
        pwn: window.__pwn,
        html: html,
        hasScriptTag: /<script[\s>]/i.test(html),
        hasEventAttr: /\son[a-z]+\s*=/i.test(html),
        hasJsProtocol: /(?:javascript|vbscript)\s*:/i.test(html),
        hasIframe: /<iframe[\s>]/i.test(html),
        hasForm: /<form[\s>]/i.test(html),
        hasSvg: /<svg[\s>]/i.test(html),
      };
    } catch (e) {
      out.attackResults[name] = { error: String(e && e.message || e) };
    }
    window.__pwn = 0;
  }

  // C: 合规 HTML 必须保留(允许渲染 HTML 的意义所在)
  sandbox.innerHTML = '';
  const benign = [
    '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
    '<details><summary>展开</summary><p>内容</p></details>',
    '<div class="html-present" style="border-radius:8px;background:#eef;padding:12px">卡片</div>',
    '<p>段落 <strong>加粗</strong> <em>斜体</em> <code>代码</code> <mark>高亮</mark></p>',
    '<ul><li>一</li><li>二</li></ul>',
    '<a href="https://example.com/x">外链</a>',
    '<a href="#anchor">锚点</a>',
    '<img src="https://example.com/a.png" alt="图">',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="内联">',
    '<blockquote><p>引用</p></blockquote>',
  ];
  out.benign = {};
  for (const src of benign) {
    const html = renderInto(src);
    out.benign[src.slice(0, 60)] = html;
  }
  // 代码块(带复制按钮)与表格包裹容器
  out.codeBlock = renderInto('```js\nconst a = 1;\n```');
  out.mdTable = renderInto('| A | B |\n| --- | --- |\n| 1 | 2 |');
  // 模型回答里混排 Markdown 与 HTML
  out.mixed = renderInto('**粗体** 与 <span style="color:red">红字</span>\n\n<div class="card" style="padding:8px">卡片</div>');
  // 公式不应被消毒破坏
  out.math = renderInto('行内 $a^2+b^2=c^2$ 结束');
  out.externalLink = (() => {
    const html = renderInto('<a href="https://example.com/x">外链</a>');
    const d = document.createElement('div');
    d.innerHTML = html;
    d.innerHTML = html;
    const a = d.querySelector('a');
    return a ? { target: a.getAttribute('target'), rel: a.getAttribute('rel') } : null;
  })();
  return out;
}, {});

console.log('== 渲染管线 HTML 消毒自检 ==');

if (results.errors.length) {
  for (const e of results.errors) bad(e);
  await browser.close();
  server.close();
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

// A/B:攻击载荷
for (const [name, r] of Object.entries(results.attackResults || {})) {
  if (r.error) { bad(name + '(渲染抛异常: ' + r.error + ')'); continue; }
  const executed = r.pwn > 0;
  const leakedTag = r.hasScriptTag || r.hasIframe || r.hasForm || r.hasSvg;
  const leakedAttr = r.hasEventAttr;
  if (executed) bad(name + ':脚本被执行(pwn=' + r.pwn + ')');
  else if (leakedTag) bad(name + ':可执行标签残留在输出中');
  else if (leakedAttr) bad(name + ':事件属性残留在输出中');
  else ok(name + ':已拦截');
}

// C:合规 HTML 保留
const b = results.benign || {};
const has = (frag) => Object.entries(b).some(([k, v]) => v && v.includes(frag));
check('保留 <table> 排版', has('<table>'));
check('保留 <details>/<summary>', has('<details>') && has('<summary>'));
check('保留卡片 class 与行内样式', has('html-present') && has('border-radius'));
check('保留 strong/em/code/mark', has('<strong>') && has('<em>') && has('<code>'));
check('保留列表', has('<ul>') && has('<li>'));
check('保留外链 href', has('https://example.com/x'));
check('保留锚点 href', has('#anchor'));
check('保留远程图片 src', has('https://example.com/a.png'));
check('保留 data:image 内联图', has('data:image/png;base64,'));
check('保留 blockquote', has('<blockquote>'));
check('代码块保留 .code-block 与复制按钮', /code-block/.test(results.codeBlock || '') && /code-copy/.test(results.codeBlock || ''));
check('Markdown 表格包裹容器保留', /table-wrap/.test(results.mdTable || ''));
check('Markdown 与 HTML 混排正常', /<strong>粗体<\/strong>/.test(results.mixed || '') && /红字/.test(results.mixed || ''));
check('KaTeX 公式渲染未被破坏', /katex/.test(results.math || ''));
check('外链自动带 target=_blank 与 noopener', !!results.externalLink
  && results.externalLink.target === '_blank'
  && /noopener/.test(results.externalLink.rel || ''));

await browser.close();
server.close();
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
