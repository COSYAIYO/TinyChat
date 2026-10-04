/* AI 整理输出解析自检:
 *   node tests/notes-archive.js
 *
 * 「保存到 AI 笔记」要消化的是**任意模型**的返回,包括小参数/小上下文模型。
 * 它们的典型输出毛病:代码块围栏、前后废话、JSON 里带裸换行、尾逗号、
 * 写一半被 max_tokens 截断、字段名换写法、干脆不按 JSON 来直接写笔记。
 * 这里把这些形态全部固化成用例,任何一条解析不出来即失败退出,供 CI 使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'js', 'notes.js'), 'utf8');

// ---- 最小沙箱:notes.js 是 IIFE,顶层只做少量 DOM 挂载,这里只需要解析器 ----
const noop = () => {};
const el = () => ({
  classList: { add: noop, remove: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, appendChild: noop,
  querySelector: () => null, querySelectorAll: () => [], remove: noop,
  setAttribute: noop, getAttribute: () => null, style: { setProperty: noop },
  dataset: {}, innerHTML: '', textContent: '', value: '',
});
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: noop,
  addEventListener: noop, removeEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { pathname: '/', origin: 'http://localhost', protocol: 'http:' },
  navigator: { userAgent: 'node' },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  document: {
    readyState: 'complete',
    body: el(),
    documentElement: el(),
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'notes.js' });
} catch (e) {
  console.error('✗ notes.js 在最小沙箱中执行失败: ' + e.message);
  process.exit(1);
}
const OCNotes = sandbox.OCNotes;
// 解析器只挂在 window.OCNotes 上;沙箱里 window === sandbox
const P = (OCNotes && OCNotes._parse) || (sandbox.window.OCNotes && sandbox.window.OCNotes._parse);
if (!P || typeof P.strict !== 'function' || typeof P.loose !== 'function') {
  console.error('✗ notes.js 未导出 OCNotes._parse(期望含 strict / loose 解析器)');
  process.exit(1);
}

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (name, cond) => { if (cond) ok(name); else bad(name); };

// 让降级解析器能按名字认出文件夹(它会把非 id 的文件夹名换回 id)
const N = OCNotes._debug;
N.doc.folders = [
  { id: 'uncat', parentId: null, name: '默认分类', createdAt: 0, updatedAt: 0, system: true },
  { id: 'f_food', parentId: null, name: '餐饮品牌', createdAt: 0, updatedAt: 0 },
];

console.log('== 严格 JSON 解析(完整契约)==');
{
  const t = JSON.stringify({
    folderAction: 'create', newFolderName: '餐饮品牌', noteTitle: '凑凑火锅',
    tags: ['火锅', '餐饮'], markdownContent: '# 凑凑火锅\n\n正文', reasoning: '新建长期文件夹',
  });
  const p = P.strict(t);
  check('标准 JSON', p && p.folderAction === 'create' && p.noteTitle === '凑凑火锅');
  check('tags 归一为数组', p && p.tags.length === 2 && p.tags[0] === '火锅');
  check('正文保留', p && p.markdownContent.indexOf('凑凑火锅') >= 0);
}
{
  const t = '```json\n{"noteTitle":"标题","markdownContent":"# 内容"}\n```';
  const p = P.strict(t);
  check('代码块围栏内 JSON', p && p.noteTitle === '标题' && p.markdownContent === '# 内容');
}
{
  const t = '好的,以下是整理结果:\n{"noteTitle":"标题","markdownContent":"# 内容"}\n希望对你有帮助!';
  const p = P.strict(t);
  check('JSON 前后夹带废话', p && p.markdownContent === '# 内容');
}
{
  // 弱模型最常见的坏味道:字符串里写了真实换行而不是 \n
  const t = '{"noteTitle":"标题","markdownContent":"# 标题\n\n第一段\n\n- a\n- b"}';
  const p = P.strict(t);
  check('字符串内裸换行(JSON 修复)', p && p.markdownContent.indexOf('第一段') >= 0 && p.markdownContent.indexOf('- b') >= 0);
}
{
  const t = '{"noteTitle":"标题","tags":["a","b",],"markdownContent":"# 内容",}';
  const p = P.strict(t);
  check('尾逗号(JSON 修复)', p && p.markdownContent === '# 内容' && p.tags.length === 2);
}
{
  // 正文写到一半被 max_tokens 截断:必须保住已写出的部分而不是整条丢弃
  const t = '{"noteTitle":"标题","markdownContent":"# 标题\n\n第一段完整内容\n\n第二段被截断这';
  const p = P.strict(t);
  check('输出截断仍能取回正文', p && p.markdownContent.indexOf('第一段完整内容') >= 0);
}
{
  const t = '{"folderAction":"existing","targetFolderId":"f_food","markdownContent":"# 内容"}';
  const p = P.strict(t);
  check('existing + 文件夹 id', p && p.folderAction === 'existing' && p.targetFolderId === 'f_food');
}
{
  const t = '{"markdownContent":"# 只有正文"}';
  const p = P.strict(t);
  check('缺标题时从正文推导', p && p.noteTitle === '只有正文');
  check('缺 folderAction 时按内容兜底', p && p.folderAction === 'existing');
}
{
  const t = '{"noteTitle":"标题","tags":"火锅,茶饮、餐饮","markdownContent":"# 内容"}';
  const p = P.strict(t);
  check('tags 是分隔字符串', p && p.tags.length === 3 && p.tags[1] === '茶饮');
}
{
  check('空返回不误判', P.strict('') === null && P.strict('no json here') === null);
  check('无正文不误判', P.strict('{"noteTitle":"只有标题"}') === null);
}

console.log('\n== 降级纯文本解析(弱模型兜底格式)==');
{
  const t = [
    '文件夹ID：',
    '新文件夹名：餐饮品牌',
    '标题：凑凑火锅品牌档案',
    '标签：火锅, 餐饮品牌, 茶饮',
    '理由：现有文件夹均不匹配,新建餐饮品牌',
    '内容：',
    '# 凑凑火锅',
    '',
    '## 核心信息',
    '- 呷哺呷哺旗下中高端品牌',
  ].join('\n');
  const p = P.loose(t);
  check('标记格式全字段', p && p.folderAction === 'create' && p.newFolderName === '餐饮品牌'
    && p.noteTitle === '凑凑火锅品牌档案' && p.tags.length === 3);
  check('正文从「内容：」之后取', p && p.markdownContent.indexOf('## 核心信息') >= 0
    && p.markdownContent.indexOf('理由') < 0);
}
{
  const t = [
    '- **文件夹ID**：f_food',
    '- **标题**：已有文件夹归档',
    '- **标签**：火锅',
    '- **内容**：',
    '正文第一行',
  ].join('\n');
  const p = P.loose(t);
  check('列表符号 + 加粗键名', p && p.folderAction === 'existing' && p.targetFolderId === 'f_food' && p.noteTitle === '已有文件夹归档');
}
{
  // 弱模型常把文件夹名当 id 回:必须换回真实 id,否则会错误新建重名文件夹
  const t = '文件夹ID：餐饮品牌\n标题：按名称归档\n内容：\n正文';
  const p = P.loose(t);
  check('文件夹名换回真实 id', p && p.targetFolderId === 'f_food' && p.folderAction === 'existing');
}
{
  const t = '文件夹ID：不存在的名字\n标题：按名称兜底\n内容：\n正文';
  const p = P.loose(t);
  check('认不出的文件夹名降级为新建', p && !p.targetFolderId && p.newFolderName === '不存在的名字' && p.folderAction === 'create');
}
{
  // 完全不按格式:整段当作笔记正文,仍然可保存,不丢内容
  const t = '这是模型直接写出来的笔记正文,没有按任何格式。\n\n第二段。';
  const p = P.loose(t);
  check('无标记时整段作正文', p && p.markdownContent.indexOf('第二段') >= 0);
}
{
  // snake_case 键名(英文提示或模型自创写法)也必须认得
  const t = ['note_title: snake 键名标题', 'folder_id: f_food', 'tags: alpha, beta', 'content:', '正文在这里'].join('\n');
  const p = P.loose(t);
  check('snake_case 键名可解析', p && p.noteTitle === 'snake 键名标题' && p.targetFolderId === 'f_food'
    && p.folderAction === 'existing' && p.tags.length === 2 && p.markdownContent.indexOf('正文在这里') >= 0);
}
{
  const t = ['文件夹ID：f_food', '标题：截断的降级输出', '内容：', '# 标题', '', '写到一半被截'].join('\n');
  const p = P.loose(t);
  check('降级输出被截断仍可用', p && p.targetFolderId === 'f_food' && p.markdownContent.indexOf('写到一半被截') >= 0);
}
{
  check('空输入不误判', P.loose('') === null);
}

console.log('\n== 输入裁剪(小上下文模型)==');
{
  const long = ('中文内容测试。'.repeat(2000));
  const cut = P.truncateToTokens(long, 1000);
  check('超预算文本被截断', P.estimateTokens(cut) <= 1200);
  check('截断后带明确提示', cut.indexOf('已截断') >= 0);
  const short = '短文本';
  check('未超预算不改动', P.truncateToTokens(short, 1000) === short);
}
{
  const longEn = 'lorem ipsum '.repeat(3000);
  const cut = P.truncateToTokens(longEn, 500);
  check('英文长文本按 token 截断', P.estimateTokens(cut) <= 700);
}

console.log('\n== 输入/输出预算分配(小窗口模型)==');
{
  const B = OCNotes._budgets;
  const sys = '你是 AI 笔记整理助手。'.repeat(20);
  const tree = ['- 默认分类（id: uncat）（空）', '- 餐饮品牌（id: f_food） 已有笔记: 凑凑火锅'];

  // 普通模型(131k 窗口):输入给足,输出不超上限
  N.doc.folders = [{ id: 'uncat', name: '默认分类' }, { id: 'f_food', name: '餐饮品牌' }];
  sandbox.OCApp = { modelCapsNow: () => ({ out: 8192, ctx: 131072 }) };
  const big = B(sys, tree);
  check('大窗口:输入预算充足', big.input > 100000);
  check('大窗口:输出仍受模型上限约束', big.output === 8192);
  // overhead(提示词+文件夹树)已从输入预算里扣掉,所以输入+输出必须落在窗口内
  check('大窗口:输入+输出不超窗口', big.input + big.output <= 131072);

  // 弱模型(8k 窗口):必须把输出也压下来,并保证输入不被算成负数
  sandbox.OCApp = { modelCapsNow: () => ({ out: 8192, ctx: 8192 }) };
  const small = B(sys, tree);
  check('小窗口:输入为正且可用', small.input >= 512);
  check('小窗口:输出被压到窗口以内', small.output < 8192);
  check('小窗口:输入+输出不超过窗口', small.input + small.output <= 8192);
  // 极小窗口:不能出现负预算把请求直接打死
  sandbox.OCApp = { modelCapsNow: () => ({ out: 4096, ctx: 4096 }) };
  const tiny = B(sys, tree);
  check('极小窗口:输入输出均为正', tiny.input >= 512 && tiny.output >= 512);
}

console.log('\n' + (fail ? '✗ AI 整理解析自检失败: ' + fail + ' 项' : '✓ AI 整理解析自检通过'));
process.exit(fail ? 1 : 0);
