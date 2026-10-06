/* 验证 shim 的表单字段拼装逻辑 + web-shim.js 的源码契约。
   这是「在线浏览器里搜索框不生效」的回归:修复前 <form action> 只换成代理地址,
   浏览器提交时丢掉查询串,字段整个丢失,于是必应搜索跳到空搜索页、地址栏也不动。

   这里不改写任何导航:把 shim 里那两条函数按同样实现放进真实 DOM 跑,逐条断言
   字段拼装规则(编码、跳过提交按钮、未勾选的 checkbox、disabled、多选 select…),
   再对 web-shim.js 源码做字符串级契约断言,防止哪天有人把某条规则删掉。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.WEBFORM_PORT || 8539), BASE = `http://127.0.0.1:${PORT}`;
// 上游 mock:末段那几项「沙箱 iframe 里渲不渲染得出来」的断言要真抓一页,
// CI 上没有外网,所以必须走 mock(TC_WEB_FETCH_BASE 钩子),和 e2e 的做法一致。
const MOCK_PORT = Number(process.env.WEBFORM_MOCK_PORT || 8540);
const ADMIN = { name: 'admin', password: 'shim-pass' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// playwright 定位:CI 的 gui job 是 `npm install --no-save playwright`,落在 node_modules;
// 本机通常没有依赖,只有 npx 的缓存。两边都要认。
// **不能只看 npx 缓存**:Linux 上 LOCALAPPDATA 未设置,join('', 'npm-cache', '_npx')
// 会退化成相对路径,readdirSync 直接 ENOENT 抛错 —— 这一步没做防御时 CI 恒定挂在这里
// (表现是整条用例未跑完就异常退出,和用例本身的对错无关)。
const candidates = [];
try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未安装到 node_modules */ }
const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
if (existsSync(cache)) {
  for (const d of readdirSync(cache)) { const p = join(cache, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) candidates.push(pathToFileURL(p).href); }
}
let pw = null;
for (const c of candidates) { try { pw = await import(c); break; } catch (e) { /* 换下一个 */ } }
if (!pw) { console.log('(skip) 未找到 playwright,跳过沙箱 iframe 渲染用例'); process.exit(0); }
const TMP = join(tmpdir(), 'shimq-' + Date.now()); mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'ignore' }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });

// 残留的 php -S 会占着端口,让下面的服务起不来(表现为 fetch 直接 ECONNREFUSED)。
// 两个端口都要查:mock 被占时应用会照常起来,只是抓取一直失败,报错离现场很远。
for (const p of [PORT, MOCK_PORT]) {
  try {
    await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(800) });
    console.error(`✗ 端口 ${p} 已被占用(疑似残留 php -S),请先结束该进程或用 WEBFORM_PORT / WEBFORM_MOCK_PORT 换端口`);
    process.exit(1);
  } catch (e) { /* 端口空闲 */ }
}

// 上游 mock(网页正文用 tests/mock-upstream.php,与 e2e 同一个),再把应用指向它。
// CN 判定必须关掉:mock 跑在本机,解析结果永远不在境内网段。
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});
sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_WEB_FETCH_BASE: `http://127.0.0.1:${MOCK_PORT}`, TC_WEB_CN_ONLY: '0',
});
let up = false;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.status) { up = true; break; } } catch (e) {}
  await sleep(250);
}
if (!up) { console.error('✗ 测试服务未能在 30s 内起来'); process.exit(1); }
// 上游 mock 也要单独等:应用起来 ≠ mock 起来,而「服务端反代抓页面」那两条断言
// 一旦在 mock 就绪前发出请求就会抓到失败页(mock 未就绪只是连接被拒,极快),
// 于是成功页断言拿到的是错误页 —— 在慢一点的 CI 机器上就是随机挂。
let mup = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/`); if (r.status) { mup = true; break; } } catch (e) {}
  await sleep(250);
}
if (!mup) { console.error(`✗ 上游 mock 未能在 15s 内起来(端口 ${MOCK_PORT})`); process.exit(1); }

const browser = await pw.chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await sleep(400);

const shimSrc = readFileSync(join(ROOT, 'static/js/web-shim.js'), 'utf8');

const result = await page.evaluate(() => {
  function formQuery(form) {
    var parts = [];
    var els = form.elements || [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || !el.name || el.disabled) continue;
      var tag = (el.tagName || '').toLowerCase();
      var type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file' || type === 'image') continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      var val = el.value == null ? '' : String(el.value);
      if (tag === 'select' && el.multiple) {
        for (var j = 0; j < el.options.length; j++) if (el.options[j].selected) parts.push([el.name, el.options[j].value]);
        continue;
      }
      parts.push([el.name, val]);
    }
    var out = [];
    for (var k = 0; k < parts.length; k++) out.push(encodeURIComponent(parts[k][0]) + '=' + encodeURIComponent(parts[k][1]));
    return out.join('&');
  }
  function formTarget(form, remote) {
    var action = form.getAttribute('data-ocw-action') || remote;
    var a;
    try { a = new URL(action); } catch (e) { return ''; }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return '';
    var q = formQuery(form);
    if (q) a.search = a.search ? (a.search + '&' + q) : ('?' + q);
    return a.href;
  }
  function mk(html) { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); return d.querySelector('form'); }
  return {
    basic: formTarget(mk('<form data-ocw-action="https://www.bing.com/search"><input name="q" value="hello world & more"></form>'), 'https://www.bing.com/'),
    withExistingQuery: formTarget(mk('<form data-ocw-action="https://e.com/s?ie=utf-8"><input name="q" value="x"></form>'), 'https://e.com/'),
    checkbox: formQuery(mk('<form><input name="a" value="1"><input type="checkbox" name="b" value="2"><input type="checkbox" name="c" value="3" checked></form>')),
    skips: formQuery(mk('<form><input name="q" value="v"><input type="submit" name="go" value="g"><button name="btn" value="b">x</button><input type="file" name="f"></form>')),
    disabled: formQuery(mk('<form><input name="a" value="1" disabled><input name="b" value="2"></form>')),
    multiSelect: formQuery(mk('<form><select name="s" multiple><option value="1" selected>1</option><option value="2">2</option><option value="3" selected>3</option></select></form>')),
    noName: formQuery(mk('<form><input value="anon"><input name="q" value="k"></form>')),
    jsAction: formTarget(mk('<form data-ocw-action="javascript:void(0)"><input name="q" value="1"></form>'), 'https://e.com/'),
  };
});

let fail = 0;
const check = (name, cond, got) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  got=' + JSON.stringify(got))); if (!cond) fail++; };
console.log('shim 表单逻辑:');
check('普通字段编码正确', result.basic === 'https://www.bing.com/search?q=hello%20world%20%26%20more', result.basic);
check('action 自带查询串被保留并追加', result.withExistingQuery === 'https://e.com/s?ie=utf-8&q=x', result.withExistingQuery);
check('未勾选的 checkbox 不带上', result.checkbox === 'a=1&c=3', result.checkbox);
check('提交/按钮/文件不混进查询串', result.skips === 'q=v', result.skips);
check('disabled 字段不带上', result.disabled === 'b=2', result.disabled);
check('多选 select 只带选中的', result.multiSelect === 's=1&s=3', result.multiSelect);
check('无 name 的字段跳过', result.noName === 'q=k', result.noName);
check('非 http(s) 的 action 不生成目标', result.jsAction === '', result.jsAction);

console.log('\nweb-shim.js 源码契约:');
check('监听了 submit', /addEventListener\('submit'/.test(shimSrc), '');
check('读 data-ocw-action', /data-ocw-action/.test(shimSrc), '');
check('跳过 submit/button/reset/file', /'submit'/.test(shimSrc) && /'file'/.test(shimSrc), '');
check('跳过未勾选的 checkbox', /!el\.checked/.test(shimSrc), '');
check('对字段名与值做 URL 编码', /encodeURIComponent\(parts\[k\]\[0\]\)/.test(shimSrc), '');
check('站点自己 preventDefault 时不接管', /defaultPrevented/.test(shimSrc), '');

// ------------------------------------------------------------------
// 代理响应必须能显示在**带 sandbox 的 iframe**里 —— 成功页和失败页都要。
// 真实事故:index.php 开头 tc_send_cors() 给每个响应发全局
// `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`,而渲染被代理页的 iframe
// 正落在 /api/web/page 上。成功分支各自写了覆盖,**失败分支一个都没写**,
// 于是抓取失败 / 票据过期时用户看到的是一片空白(控制台才报 frame-ancestors)。
// 这里用真浏览器量:把 /api/web/page 放进 sandbox(不含 allow-same-origin)的 iframe,
// 看文档到底渲不渲染得出来 —— 读响应头列表看不出「浏览器会不会把它拦掉」。
//
// 分工(两处都要有,浏览器这里量不到 XFO):现代 Chrome 只要响应带了 CSP 的
// frame-ancestors,就完全忽略 X-Frame-Options —— 实测把 XFO 改回 DENY、CSP 保持 'self',
// 帧照常渲染(本用例全绿);反过来 CSP 改 'none' 则整页被拦(本用例三项全红)。
// 所以「浏览器实际会不会拦」由本文件守着(CSP 那行),「XFO 那行写没写对」由
// tests/web-proxy.php 的源码断言 + e2e.sh 的响应头断言守着。
console.log('\n沙箱 iframe 里渲染代理响应(成功 + 失败都要出得来):');
{
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })).json();
  const tk = await (await fetch(BASE + '/api/web/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token } })).json();
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // 主页先放一个和 web.js 逐字同款的 iframe(沙箱里**没有** allow-same-origin,
  // 这正是隔离模型的全部依据),再分别导航到成功/失败两种响应。
  const refusals = [];
  page.on('console', (m) => { const t = m.text(); if (/X-Frame-Options|Refused to display|frame-ancestors/i.test(t)) refusals.push(t.slice(0, 100)); });

  // 每次新建一个带唯一 id 的 iframe,读完就摘掉。
  // 不复用同一个元素改 src:那会先经历一次导航,轮询时可能读到**上一个文档**的残留
  // 文本,于是「失败页」断言拿到的是成功页的内容(反之亦然),结论完全不可信。
  // 也不靠 page.frames() 里按 URL 字符串找帧:目标地址整条被编进 u 参数,任何一次
  // 时序差都表现为「找不到帧」,而元素句柄的 contentFrame() 是确定的。
  let probeSeq = 0;
  const dropFrame = (id) => page.evaluate((i) => { const f = document.getElementById(i); if (f) f.remove(); }, id);
  const load = async (src) => {
    const id = 'ocw-probe-frame-' + (++probeSeq);
    await page.evaluate(({ i, s }) => {
      const f = document.createElement('iframe');
      f.id = i;
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals allow-presentation');
      f.setAttribute('src', s);
      document.body.appendChild(f);
    }, { i: id, s: src });
    const handle = await page.$('#' + id);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const fr = handle ? await handle.contentFrame() : null;
      if (fr) {
        try {
          const t = await fr.evaluate(() => (document.body ? document.body.innerText : ''));
          if (t) { await dropFrame(id); return t; }
        } catch (e) { /* 文档还没换完 */ }
      }
    }
    await dropFrame(id);
    return '';
  };

  // 成功页:上游 mock 的正文标记必须出现在帧里
  const okText = await load(BASE + '/api/web/page?u=' + b64('https://example.com/page/x') + '&t=' + tk.ticket);
  check('成功页在沙箱 iframe 里渲染出来', /MOCK-PAGE-BODY-OK/.test(okText), okText.slice(0, 80));

  // 失败页:坏票据 → 403 + tc_web_fail_page,同样必须显示出来(修复前是空白)
  const badText = await load(BASE + '/api/web/page?u=' + b64('https://example.com/page/x') + '&t=deadbeef.deadbeef.deadbeef');
  check('失败页在沙箱 iframe 里也渲染出来(不是一片空白)', /无法打开该网页/.test(badText), badText.slice(0, 80));
  check('没有被浏览器以 XFO/CSP 拦下', refusals.length === 0, refusals.join(' | '));
}

console.log('\n' + (fail ? fail + ' 项未通过' : '全部通过'));
await browser.close();
process.exit(fail ? 1 : 0);
