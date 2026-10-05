/* 输入框聚焦环 / 主题色恢复默认 / 窄屏账户面板自检(真 Chromium + 真服务端):
 *   node tests/focus-ring-gui.mjs
 *
 * 覆盖三类只有真浏览器才量得出来的问题:
 *   1) 聚焦环只能有一圈:输入框聚焦后自身是一圈 2px 主色描边,不能再叠一层旧版
 *      光环(box-shadow 环),祖先也不许多画一圈 —— 这类「同一个框上两圈」的问题
 *      是 CSS 里两个不同层的规则叠加出来的,看代码看不出来,必须量计算样式;
 *   2) 复合控件的环要圈住整个框:主题色 HEX 输入框、上下文步进器、侧栏搜索、
 *      助手库搜索、后台用户搜索的可见框都是外层容器,环必须画在容器上,
 *      内部 input 不再单独描边(修复前环只圈住框内部的一小块);
 *   3) 主题色「恢复默认」:改色后点一下,偏好、CSS 变量、入口色值都回到内置默认,
 *      刷新后仍是默认(说明确实写进了本地偏好,而不是只改了当前这一帧);
 *   4) 窄屏账户页签:次数徽章独占一行,名字与「注册于 …」不再被挤成一条竖线
 *      (修复前 390px 下文字列只剩 25px、360px 下 0px,整块高 218px)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8251);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8252);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'focus-ring-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似残留 php -S),请先结束该进程或用 GUI_PORT 换端口`);
  process.exit(1);
}
await assertPortFree(PORT);
await assertPortFree(MOCK_PORT);

async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未安装 */ }
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const p = join(cache, dir, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) candidates.push(pathToFileURL(p).href);
    }
  }
  for (const c of candidates) {
    try { return await import(c); } catch (e) { /* 试下一个 */ }
  }
  return null;
}
const pw = await loadPlaywright();
if (!pw) {
  console.log('(skip) 未找到 playwright,跳过聚焦环自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-focus-gui-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
}
process.on('exit', () => { for (const p of procs) { try { p.kill(); } catch (e) {} } rmSync(TMP, { recursive: true, force: true }); });

const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
let appErr = '';
app.stderr.on('data', (d) => { appErr += String(d); });
spawnPhp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return true; } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}
if (!(await waitFor(BASE + '/api/config'))) {
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1200));
  process.exit(1);
}
await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`);

const loginText = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).text();
let login = {};
try { login = JSON.parse(loginText); } catch (e) { console.error('✗ 登录响应非 JSON: ' + loginText.slice(0, 200)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });

const browser = await pw.chromium.launch();
const pageErrors = [];

// 页面内:先清焦点再聚焦目标,等过渡结束后量「自身描边 / 自身环影 / 祖先环」
const PROBE = async (arg) => {
  const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = document.querySelector(arg.sel);
  if (!el) return { missing: true, why: '不存在' };
  const isRing = (sh) => !!sh && /0px 0px 0px [0-9.]+px/.test(sh);
  const info = (n) => {
    const cs = getComputedStyle(n);
    const ow = parseFloat(cs.outlineWidth) || 0;
    return {
      outline: cs.outlineStyle !== 'none' && ow > 0, ow,
      shadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
      ring: isRing(cs.boxShadow),
    };
  };
  const snap = () => { const out = []; let n = el; for (let i = 0; i < 4 && n; i++) { out.push(info(n)); n = n.parentElement; } return out; };
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  await sleepIn(140);
  const before = snap();
  const target = arg.focusSel ? document.querySelector(arg.focusSel) : el;
  if (!target) return { missing: true, why: '焦点目标不存在' };
  try { target.focus({ focusVisible: true }); } catch (e) { /* 见下 */ }
  if (document.activeElement !== target) return { missing: true, why: '无法聚焦(面板未激活?)' };
  await sleepIn(360);
  const after = snap();
  let anc = false;
  for (let i = 1; i < after.length; i++) {
    if ((after[i].ring && !before[i].ring) || (after[i].outline && !before[i].outline)) anc = true;
  }
  const r = target.getBoundingClientRect();
  const wrap = arg.wrap ? document.querySelector(arg.wrap) : null;
  const wr = wrap ? wrap.getBoundingClientRect() : null;
  return {
    selfOutline: after[0].outline, selfRing: after[0].ring, selfOw: after[0].ow, anc,
    shadow: after[0].shadow.slice(0, 60),
    box: Math.round(r.width) + 'x' + Math.round(r.height),
    wrapBox: wr ? Math.round(wr.width) + 'x' + Math.round(wr.height) : '',
  };
};

const single = (r) => r && !r.missing && r.selfOutline === true && r.selfOw === 2 && r.selfRing === false && r.anc === false;
const onWrap = (r) => r && !r.missing && r.selfOutline === false && r.selfRing === false && r.anc === true;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
await page.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

async function openSettings(p) {
  await p.evaluate(() => { const c = document.querySelector('#account-chip'); if (c) c.click(); });
  await sleep(350);
  await p.evaluate(() => { const b = document.querySelector('#user-menu-settings'); if (b) b.click(); });
  await sleep(800);
  return p.evaluate(() => !!document.querySelector('#settings-modal:not(.hidden)'));
}
async function tab(p, name) {
  await p.evaluate((t) => { const b = document.querySelector('.settings-tab[data-tab="' + t + '"]'); if (b) b.click(); }, name);
  await sleep(450);
}
async function closeTop(p) { await p.keyboard.press('Escape'); await sleep(500); }
async function openAssistantForm(p) {
  await p.evaluate(() => { const b = document.querySelector('#assistant-lib-btn'); if (b) b.click(); });
  await sleep(800);
  await p.evaluate(() => { const b = document.querySelector('#al-add-asst'); if (b) b.click(); });
  await sleep(800);
}

check('设置弹窗已打开', await openSettings(page));

console.log('\n== 1. 单行/多行输入框:聚焦只有一圈 2px 主色描边 ==');
{
  const cases = [
    { label: '设置·API Key 备注', sel: '#apikey-name', setup: async () => { await tab(page, 'apikeys'); } },
    { label: '设置·兑换码', sel: '#plan-redeem-code', setup: async () => { await tab(page, 'plan'); } },
    { label: '设置·字体选择', sel: '#pref-font-cjk', setup: async () => { await tab(page, 'look'); } },
    {
      label: '助手表单·系统提示词(多行)',
      sel: '#af-prompt',
      setup: async () => { await closeTop(page); await openAssistantForm(page); },
    },
  ];
  for (const c of cases) {
    await c.setup();
    const r = await page.evaluate(PROBE, { sel: c.sel });
    check(`${c.label}:聚焦后只有一圈 2px 描边(无第二圈环影)`, single(r));
    if (!single(r)) console.log(`      (${r.why || ''} 描边=${r.selfOutline}/${r.selfOw}px 环影=${r.selfRing} 祖先环=${r.anc} 阴影=${r.shadow || ''})`);
  }
}

console.log('\n== 2. 复合控件:环圈住整个框,内部输入框不单独描边 ==');
{
  const cases = [
    {
      label: '设置·上下文步进器',
      sel: '#pref-context', wrap: '#pref-context-step',
      setup: async () => { await closeTop(page); await openSettings(page); await tab(page, 'chat'); },
    },
    {
      label: '主题色·HEX 输入框',
      sel: '#pref-accent-hex', wrap: '.accent-hex-field',
      setup: async () => {
        await tab(page, 'look');
        await page.evaluate(() => { const b = document.querySelector('#accent-open'); if (b) b.click(); });
        await sleep(700);
      },
    },
    {
      label: '侧栏·搜索对话',
      sel: '#chat-search-input', wrap: '.chat-search',
      setup: async () => { await closeTop(page); await sleep(400); },
    },
    {
      label: '助手库·搜索',
      sel: '#al-search', wrap: '.al-search',
      setup: async () => {
        await page.evaluate(() => { const b = document.querySelector('#assistant-lib-btn'); if (b) b.click(); });
        await sleep(800);
      },
    },
  ];
  for (const c of cases) {
    await c.setup();
    const r = await page.evaluate(PROBE, { sel: c.sel, wrap: c.wrap });
    check(`${c.label}:环画在整框上,内部输入框不描边`, onWrap(r));
    if (!onWrap(r)) console.log(`      (${r.why || ''} 内部描边=${r.selfOutline} 内部环影=${r.selfRing} 整框环=${r.anc} 整框=${r.wrapBox || ''})`);
  }
}

console.log('\n== 3. 主题色「恢复默认」 ==');
{
  await closeTop(page);
  check('设置弹窗再次打开', await openSettings(page));
  await tab(page, 'look');
  // 颜色统一规范化成 rgb() 再比:空偏好时 --accent 来自样式表(十六进制写法),
  // 显式写入默认色后是 rgb() 写法 —— 两者是同一个颜色,字符串却不同。
  const READ = () => {
    const norm = (v) => { const d = document.createElement('div'); d.style.color = v || 'rgb(0, 0, 0)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return {
      pref: JSON.parse(localStorage.getItem('oc_prefs') || '{}').accent || '',
      accent: norm(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),
      entry: ((document.querySelector('#accent-entry-hex') || {}).textContent || '').trim(),
      defaultAccent: (window.OCUI && window.OCUI.defaultAccent) || '',
    };
  };
  const before = await page.evaluate(READ);
  await page.evaluate(() => { const b = document.querySelector('#accent-open'); if (b) b.click(); });
  await sleep(700);
  check('主题色弹窗可打开', await page.evaluate(() => !!document.querySelector('#accent-modal:not(.hidden)')));
  check('弹窗里有「恢复默认」按钮', await page.evaluate(() => !!document.querySelector('#accent-modal-reset')));
  await page.evaluate(() => {
    const i = document.querySelector('#pref-accent-hex');
    i.value = '#ff0000';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(450);
  const set = await page.evaluate(READ);
  check('改成 #FF0000 后写进本地偏好', String(set.pref).toUpperCase() === '#FF0000');
  check('主色变量随之改变', set.accent !== before.accent);
  await page.evaluate(() => { const b = document.querySelector('#accent-modal-reset'); if (b) b.click(); });
  await sleep(500);
  const after = await page.evaluate(READ);
  check('恢复默认后本地偏好回到内置默认色', String(after.pref).toUpperCase() === String(after.defaultAccent).toUpperCase());
  check('恢复默认后主色变量回到默认值', after.accent === before.accent);
  check('恢复默认后设置入口显示默认色值', after.entry.toUpperCase() === String(after.defaultAccent).toUpperCase());
  check('点恢复默认不会把弹窗关掉(还能接着调)', await page.evaluate(() => !!document.querySelector('#accent-modal:not(.hidden)')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const reloaded = await page.evaluate(READ);
  check('刷新后仍是默认色(偏好已持久化)',
    String(reloaded.pref).toUpperCase() === String(after.defaultAccent).toUpperCase() && reloaded.accent === before.accent);
}

console.log('\n== 4. 后台用户搜索:环画在整框上 ==');
{
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  await p2.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
  await p2.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await sleep(1600);
  const onUsers = await p2.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.admin-tabs button, .admin-tab')).find((x) => /用户/.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(700);
  if (!onUsers) bad('未找到后台「用户」页签');
  else {
    const r = await p2.evaluate(PROBE, { sel: '#user-search', wrap: '.users-search' });
    check('后台用户搜索:环画在整框上,内部 input 不描边', onWrap(r));
    if (!onWrap(r)) console.log(`      (${r.why || ''} 内部描边=${r.selfOutline} 内部环影=${r.selfRing} 整框环=${r.anc})`);
  }
  await p2.close();
}

console.log('\n== 5. 窄屏账户页签:名字/注册时间不被挤成竖条 ==');
{
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pm = await ctxM.newPage();
  pm.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  await pm.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
  await pm.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  check('窄屏下设置弹窗已打开', await openSettings(pm));
  await tab(pm, 'account');
  const MEASURE = () => {
    const g = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
    return {
      head: g('.acc-head'), name: g('#acc-name'), extra: g('#acc-extra'), quota: g('#acc-quota'),
      vw: window.innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  };
  for (const [w, h, minExtra] of [[390, 844, 120], [360, 740, 100]]) {
    await pm.setViewportSize({ width: w, height: h });
    await sleep(500);
    const m = await pm.evaluate(MEASURE);
    if (!m.extra || !m.name || !m.head) { bad(`${w}px 下账户面板元素缺失`); continue; }
    check(`${w}px:名字一行放得下(宽 ${m.name.w}px)`, m.name.w >= 100);
    check(`${w}px:「注册于 …」单行可读(宽 ${m.extra.w}px 高 ${m.extra.h}px)`, m.extra.w >= minExtra && m.extra.h <= 30);
    check(`${w}px:账户块不再被撑高(高 ${m.head.h}px)`, m.head.h <= 170);
    check(`${w}px:次数徽章在视口内且不横向溢出`, !!m.quota && m.quota.right <= m.vw + 1 && m.overflow <= 1);
  }
  await tab(pm, 'apikeys');
  const r = await pm.evaluate(PROBE, { sel: '#apikey-name' });
  check('窄屏输入框聚焦同样只有一圈 2px 描边', single(r));
  await ctxM.close();
}

console.log('\n== 6. 无未捕获异常 ==');
{
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
  check('无 JS 异常' + (real.length ? ': ' + real.slice(0, 2).join(' | ') : ''), real.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 聚焦环/主题色自检失败: ${fail} 项` : `✓ 聚焦环/主题色自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
