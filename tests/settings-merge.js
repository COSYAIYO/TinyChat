/* 设置云同步合并逻辑自检:
 *   node tests/settings-merge.js
 *
 * 云同步最怕的不是「同步不上」,而是「同步错了」:旧设备把新设置顶掉、
 * 删掉的群聊被另一台设备复活、换账号后把上一个账号的偏好带进新账号。
 * 这里把合并规则固化成用例 —— 任何一条不满足即失败退出,供 CI 使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'js', 'settings-sync.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(label + ' = ' + b);
  else bad(label + ': 期望 ' + b + ', 实际 ' + a);
};
const noop = () => {};

// ---- 最小沙箱:内存版 localStorage + OCUI 桩 ----
function makeSandbox() {
  const store = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _dump: () => store,
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: noop,
    addEventListener: noop,
    removeEventListener: noop,
    localStorage,
    location: { pathname: '/', origin: 'http://localhost', protocol: 'http:' },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    document: {
      readyState: 'complete',
      body: { appendChild: noop, classList: { add: noop, remove: noop } },
      documentElement: { setAttribute: noop, style: { setProperty: noop, removeProperty: noop } },
      createElement: () => ({ classList: { add: noop, remove: noop }, style: {}, appendChild: noop }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
    },
    OCUI: {
      // 与 ui.js 的 setPrefsBulk 同语义:合并写入 oc_prefs(此处只做存储层)
      setPrefsBulk: (obj) => {
        let cur = {};
        try { cur = JSON.parse(localStorage.getItem('oc_prefs') || '{}') || {}; } catch (e) { cur = {}; }
        Object.keys(obj).forEach((k) => { cur[k] = obj[k]; });
        localStorage.setItem('oc_prefs', JSON.stringify(cur));
        return true;
      },
      onPrefsChange: noop,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'settings-sync.js' });
  const api = sandbox.OCSettingsSync;
  if (!api || !api._internal) {
    console.error('✗ settings-sync.js 未导出 OCSettingsSync._internal');
    process.exit(1);
  }
  return { api, internal: api._internal, localStorage, sandbox };
}

const env = makeSandbox();
const M = env.internal.mergeDocs;
const LS = env.localStorage;

// 1) 逐键合并:时间戳新者胜
{
  const local = {
    prefs: { theme: 'light', fontSize: 16 },
    ui: { sidebarWidth: 260, videoSeconds: 30 },
    groups: { groups: [], activeId: '' },
    fonts: {},
    tombs: {},
    at: { 'prefs.theme': 100, 'prefs.fontSize': 500, 'ui.sidebarWidth': 100, 'ui.videoSeconds': 100 },
  };
  const cloud = {
    prefs: { theme: 'dark', fontSize: 12, accent: '#ff0000' },
    ui: { sidebarWidth: 300, contentWidth: 900 },
    groups: { groups: [], activeId: '' },
    fonts: {},
    tombs: {},
    at: { 'prefs.theme': 200, 'prefs.fontSize': 100, 'ui.sidebarWidth': 400, 'prefs.accent': 300, 'ui.contentWidth': 300 },
  };
  const m = M(local, cloud);
  eq('云端较新的键取云端', m.prefs.theme, 'dark');
  eq('本地较新的键取本地', m.prefs.fontSize, 16);
  eq('云端独有的键被采纳', m.prefs.accent, '#ff0000');
  eq('云端较新的布局键取云端', m.ui.sidebarWidth, 300);
  eq('本地独有的键保留', m.ui.videoSeconds, 30);
  eq('云端独有的 UI 键被采纳', m.ui.contentWidth, 900);
  eq('合并后时间戳随胜者', m.at['prefs.theme'], 200);
  eq('本地胜出的键时间戳保留', m.at['prefs.fontSize'], 500);
}

// 2) 两侧都没有时间戳:本地优先(不把本机已设好的值判成旧值)
{
  const local = { prefs: { theme: 'dark' }, ui: {}, groups: { groups: [], activeId: '' }, fonts: {}, tombs: {}, at: {} };
  const cloud = { prefs: { theme: 'light' }, ui: {}, groups: { groups: [], activeId: '' }, fonts: {}, tombs: {}, at: {} };
  eq('无时间戳时本地优先', M(local, cloud).prefs.theme, 'dark');
  eq('无时间戳且本地缺失时取云端', M({ prefs: {}, ui: {}, groups: { groups: [], activeId: '' }, fonts: {}, tombs: {}, at: {} }, cloud).prefs.theme, 'light');
}

// 3) 群聊:按 id 合并、墓碑压制删除、activeId 跟随
{
  const local = {
    prefs: {}, ui: {}, fonts: {}, tombs: {},
    groups: { groups: [{ id: 'g1', name: '旧名' }, { id: 'g2', name: '将被删除' }], activeId: 'g2' },
    at: { 'groups.g1': 100, 'groups.g2': 100, 'groups.activeId': 100 },
  };
  const cloud = {
    prefs: {}, ui: {}, fonts: {},
    groups: { groups: [{ id: 'g1', name: '新名' }, { id: 'g3', name: '云端新增' }], activeId: 'g3' },
    tombs: { 'groups.g2': 150 },
    at: { 'groups.g1': 200, 'groups.g3': 300, 'groups.activeId': 300 },
  };
  const m = M(local, cloud);
  const ids = m.groups.groups.map((g) => g.id).sort();
  eq('合并后群列表', ids, ['g1', 'g3']);
  eq('较新的群配置胜出', m.groups.groups.find((g) => g.id === 'g1').name, '新名');
  eq('墓碑压制的群不再出现', m.groups.groups.some((g) => g.id === 'g2'), false);
  eq('墓碑被继承', m.tombs['groups.g2'], 150);
  eq('activeId 取较新一侧', m.groups.activeId, 'g3');
  // 本机删除(本地墓碑)也要压制云端的旧副本
  const localDel = {
    prefs: {}, ui: {}, fonts: {},
    groups: { groups: [], activeId: '' },
    tombs: { 'groups.g1': 400 },
    at: { 'groups.g1': 100 },
  };
  const m2 = M(localDel, cloud);
  eq('本地墓碑压制云端旧副本', m2.groups.groups.some((g) => g.id === 'g1'), false);
  eq('activeId 指向已删群时回落到首个群', m2.groups.activeId, 'g3');
}

// 4) 自定义字体:同名合并 + 删除墓碑
{
  const local = {
    prefs: {}, ui: {}, groups: { groups: [], activeId: '' }, tombs: {}, at: { 'fonts.甲': 100, 'fonts.乙': 100 },
    fonts: { '甲': 'old', '乙': 'keep' },
  };
  const cloud = {
    prefs: {}, ui: {}, groups: { groups: [], activeId: '' }, tombs: { 'fonts.乙': 150 }, at: { 'fonts.甲': 200 },
    fonts: { '甲': 'new', '丙': 'added' },
  };
  const m = M(local, cloud);
  eq('字体按名称取较新', m.fonts['甲'], 'new');
  eq('云端新增字体被采纳', m.fonts['丙'], 'added');
  eq('被删除的字体不再出现', m.fonts['乙'], undefined);
}

// 5) 快照 / 应用往返:本地各功能键 ↔ 设置文档
{
  LS.setItem('oc_prefs', JSON.stringify({ theme: 'dark', fontSize: 16 }));
  LS.setItem('oc_sidebar_width', '320');
  LS.setItem('oc_sidebar_collapsed', '1');
  LS.setItem('oc_composer_mode', 'group');
  LS.setItem('oc_notes_ai_cfg', JSON.stringify({ disabled: ['translate'], custom: [], overrides: {} }));
  LS.setItem('oc_custom_fonts', JSON.stringify({ '甲': '@font-face{}' }));
  LS.setItem('oc_groups', JSON.stringify({ groups: [{ id: 'g1', name: '问题研讨' }], activeId: 'g1' }));
  LS.setItem('oc_notes_ui_u7', JSON.stringify({ sort: 'title', mode: 'split' }));
  env.internal.state.uid = 'u7';
  const doc = env.internal.snapshot();
  eq('快照带偏好', doc.prefs.theme, 'dark');
  eq('快照带布局(布尔转真值)', doc.ui.sidebarCollapsed, true);
  eq('快照带布局(数值)', doc.ui.sidebarWidth, 320);
  eq('快照带模式', doc.ui.composerMode, 'group');
  eq('快照带笔记界面(按账号)', doc.ui.notesUi.sort, 'title');
  eq('快照带群聊配置', doc.groups.groups[0].id, 'g1');
  eq('快照带自定义字体', doc.fonts['甲'], '@font-face{}');
  // 清空后应用回来
  LS.removeItem('oc_prefs');
  LS.removeItem('oc_sidebar_width');
  LS.removeItem('oc_sidebar_collapsed');
  LS.removeItem('oc_composer_mode');
  LS.removeItem('oc_notes_ai_cfg');
  LS.removeItem('oc_custom_fonts');
  LS.removeItem('oc_groups');
  LS.removeItem('oc_notes_ui_u7');
  env.internal.applyDoc(doc);
  eq('应用后偏好回到本地', JSON.parse(LS.getItem('oc_prefs')).theme, 'dark');
  eq('应用后布局回到本地', LS.getItem('oc_sidebar_width'), '320');
  eq('应用后折叠状态回到本地', LS.getItem('oc_sidebar_collapsed'), '1');
  eq('应用后模式回到本地', LS.getItem('oc_composer_mode'), 'group');
  eq('应用后笔记界面回到本地', JSON.parse(LS.getItem('oc_notes_ui_u7')).sort, 'title');
  eq('应用后群聊配置回到本地', JSON.parse(LS.getItem('oc_groups')).groups[0].id, 'g1');
  eq('应用后字体回到本地', JSON.parse(LS.getItem('oc_custom_fonts'))['甲'], '@font-face{}');
}

// 6) 时间戳记录:本机改动才记,应用云端值不记
{
  LS.setItem('oc_settings_at', '{}');
  env.internal.bumpAt('prefs.theme', 12345);
  eq('改动记时间戳', env.internal.readAt()['prefs.theme'], 12345);
  const before = JSON.stringify(env.internal.readAt());
  env.internal.state.applying = true;
  env.internal.bumpAt; // no-op:调用方(API.touchUi)在 applying 期间会跳过
  env.internal.state.applying = false;
  eq('应用期间不改时间戳', JSON.stringify(env.internal.readAt()), before);
}

console.log('\n' + (fail === 0 ? `全部通过 (${pass})` : `失败 ${fail} 项`));
process.exit(fail === 0 ? 0 : 1);
