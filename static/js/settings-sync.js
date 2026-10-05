'use strict';
/**
 * settings-sync.js — 用户设置云同步
 *
 * 目标:换设备 / 换浏览器登录同一账号时,主题、字体、字号、模型选择、群聊配置、
 * 生成参数、笔记动作等全部自动恢复,不必再逐项设置一遍。
 *
 * 与对话/笔记同步同构:本地 localStorage 是即时层,/api/sync/settings 按 baseRevision
 * 乐观并发;冲突(409)时按「逐键更新时间戳」合并后重推,两端的改动都不会丢。
 *
 * 文档形状(与服务端白名单 sanitize 一一对应):
 *   { v:1, prefs:{键:值}, ui:{键:值}, groups:{groups:[],activeId:''}, fonts:{名称:CSS},
 *     tombs:{路径:删除时间}, at:{路径:更新时间}, updatedAt }
 * at / tombs 的路径形如 prefs.theme / ui.sidebarWidth / groups.<id> / fonts.<名称>。
 * 合并规则:谁的时间戳新谁胜;没有时间戳的键视为「从未设置」,云端有值就以云端为准。
 *
 * 本地不存影子副本:快照直接读各功能自己的 localStorage 键,避免两份数据漂移。
 * 删除(group / 字体)走 tombs 墓碑,防止另一台设备用旧副本把条目合并回来。
 */
(function () {
  const S = {
    uid: null,          // 当前账号 id(游客不同步)
    guest: false,
    active: false,      // 是否参与云同步(登录 + 未关闭 + 站点未禁用)
    serverDisabled: false,
    revision: 0,
    pushTimer: null,
    pushBusy: false,
    dirty: false,
    applying: false,    // 正在把云端值写回本地:此期间的写入不再记时间戳
    lastPull: 0,
    lastSyncAt: 0,
    lastError: '',
    lastPushedJson: '',
    listeners: [],
    statusListeners: [],
    base: null,         // 上次已知的本地状态,用于 diff 出「哪些条目被改/被删」
  };

  const PREF_KEY = 'oc_prefs';
  const FONTS_KEY = 'oc_custom_fonts';
  const GROUPS_KEY = 'oc_groups';
  const AT_KEY = 'oc_settings_at';
  const TOMB_KEY = 'oc_settings_tombs';
  const OWNER_KEY = 'oc_settings_uid';
  const ENABLED_KEY = 'oc_settings_sync';
  const PULL_MIN_GAP = 60000; // 焦点/可见性触发的拉取最小间隔,避免频繁请求

  // 布局/生成参数/笔记界面:文档字段 ↔ localStorage 键 ↔ 类型
  const UI_FIELDS = [
    { f: 'sidebarCollapsed', k: 'oc_sidebar_collapsed', t: 'bool' },
    { f: 'sidebarWidth', k: 'oc_sidebar_width', t: 'int' },
    { f: 'contentWidth', k: 'oc_content_width', t: 'int' },
    { f: 'composerMode', k: 'oc_composer_mode', t: 'str' },
    { f: 'imageModel', k: 'oc_image_model', t: 'str' },
    { f: 'imageSize', k: 'oc_image_size', t: 'str' },
    { f: 'videoModel', k: 'oc_video_model', t: 'str' },
    { f: 'videoSeconds', k: 'oc_video_seconds', t: 'int' },
    { f: 'videoRatio', k: 'oc_video_ratio', t: 'str' },
    { f: 'announcementSeen', k: 'oc_announcement_seen', t: 'int' },
    { f: 'chatGroupCollapsed', k: 'oc_chat_group_collapsed', t: 'json' },
    { f: 'notesAiCfg', k: 'oc_notes_ai_cfg', t: 'json' },
    { f: 'notesUi', k: () => 'oc_notes_ui_' + (S.uid || 'anon'), t: 'json' },
    { f: 'notesSideW', k: 'oc_notes_side_w', t: 'int' },
    { f: 'notesMdbarPos', k: 'oc_notes_mdbar_pos', t: 'json' },
  ];
  const UI_BY_FIELD = {};
  UI_FIELDS.forEach((f) => { UI_BY_FIELD[f.f] = f; });

  // ============ 存储读写 ============
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function readJson(k, def) {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return (v === null || v === undefined) ? def : v;
    } catch (e) { return def; }
  }
  function fieldKey(f) { return typeof f.k === 'function' ? f.k() : f.k; }
  function readField(f) {
    const raw = lsGet(fieldKey(f));
    if (raw === null) return undefined;
    if (f.t === 'bool') return raw === '1' || raw === 'true';
    if (f.t === 'int') { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : undefined; }
    if (f.t === 'json') {
      try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : undefined; }
      catch (e) { return undefined; }
    }
    return String(raw);
  }
  function writeField(f, v) {
    if (v === undefined || v === null) { lsDel(fieldKey(f)); return; }
    if (f.t === 'bool') lsSet(fieldKey(f), v ? '1' : '0');
    else if (f.t === 'int') lsSet(fieldKey(f), String(parseInt(v, 10) || 0));
    else if (f.t === 'json') lsSet(fieldKey(f), JSON.stringify(v));
    else lsSet(fieldKey(f), String(v));
  }
  function readAt() { const j = readJson(AT_KEY, {}); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; }
  function writeAt(at) { lsSet(AT_KEY, JSON.stringify(at || {})); }
  function readTombs() { const j = readJson(TOMB_KEY, {}); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; }
  function writeTombs(t) { lsSet(TOMB_KEY, JSON.stringify(t || {})); }
  function readGroups() {
    const j = readJson(GROUPS_KEY, null);
    const groups = (j && Array.isArray(j.groups)) ? j.groups : [];
    return { groups: groups, activeId: (j && typeof j.activeId === 'string') ? j.activeId : '' };
  }
  function readFonts() {
    const j = readJson(FONTS_KEY, null);
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

  // ============ 快照 / 合并 ============
  function snapshot() {
    const at = readAt();
    const doc = {
      v: 1,
      prefs: readJson(PREF_KEY, {}),
      ui: {},
      groups: readGroups(),
      fonts: readFonts(),
      tombs: readTombs(),
      at: at,
      updatedAt: 0,
    };
    UI_FIELDS.forEach((f) => { const v = readField(f); if (v !== undefined) doc.ui[f.f] = v; });
    let maxAt = 0;
    Object.keys(at).forEach((k) => { if (num(at[k]) > maxAt) maxAt = num(at[k]); });
    doc.updatedAt = maxAt;
    return doc;
  }
  // 只比「值」,不比时间戳(用于判断合并是否真的带来了新内容)
  function valuesOf(doc) {
    return {
      prefs: (doc && doc.prefs) || {},
      ui: (doc && doc.ui) || {},
      groups: (doc && doc.groups) || { groups: [], activeId: '' },
      fonts: (doc && doc.fonts) || {},
    };
  }
  function valuesJson(doc) { return JSON.stringify(valuesOf(doc)); }
  function hasContent(doc) {
    const v = valuesOf(doc);
    return Object.keys(v.prefs).length > 0 || Object.keys(v.ui).length > 0
      || Object.keys(v.fonts).length > 0 || (v.groups.groups || []).length > 0;
  }

  // 逐键合并:时间戳新者胜;单侧缺失取另一侧;两侧都缺时间戳时本地优先
  function mergeScalarSection(sec, local, cloud, lAt, cAt, outAt) {
    const out = {};
    const keys = {};
    const l = local[sec] || {};
    const c = cloud[sec] || {};
    Object.keys(l).forEach((k) => { keys[k] = 1; });
    Object.keys(c).forEach((k) => { keys[k] = 1; });
    Object.keys(keys).forEach((k) => {
      const path = sec + '.' + k;
      const hasL = Object.prototype.hasOwnProperty.call(l, k);
      const hasC = Object.prototype.hasOwnProperty.call(c, k);
      const lt = num(lAt[path]);
      const ct = num(cAt[path]);
      if (!hasL) { if (hasC) { out[k] = c[k]; outAt[path] = ct; } return; }
      if (!hasC) { out[k] = l[k]; outAt[path] = lt; return; }
      if (ct > lt) { out[k] = c[k]; outAt[path] = ct; } else { out[k] = l[k]; outAt[path] = lt; }
    });
    return out;
  }
  // 键控集合(群聊 / 字体):墓碑时间不早于内容时间即视为已删除
  function mergeKeyedSection(prefix, localMap, cloudMap, lAt, cAt, tombs, outAt) {
    const out = {};
    const ids = {};
    Object.keys(localMap || {}).forEach((k) => { ids[k] = 1; });
    Object.keys(cloudMap || {}).forEach((k) => { ids[k] = 1; });
    Object.keys(ids).forEach((id) => {
      const path = prefix + '.' + id;
      const hasL = Object.prototype.hasOwnProperty.call(localMap || {}, id);
      const hasC = Object.prototype.hasOwnProperty.call(cloudMap || {}, id);
      const lt = num(lAt[path]);
      const ct = num(cAt[path]);
      let v, t;
      if (!hasL) { v = cloudMap[id]; t = ct; }
      else if (!hasC) { v = localMap[id]; t = lt; }
      else if (ct > lt) { v = cloudMap[id]; t = ct; }
      else { v = localMap[id]; t = lt; }
      if (v === undefined) return;
      // 墓碑按路径查(与 at 同一套路径键):删除时间不早于内容时间即视为已删除;
      // 另一台设备在删除之后又改过这一条(时间更新)时仍会复活,避免误删新改动
      if (num(tombs[path]) && num(tombs[path]) >= t) return;
      out[id] = v;
      outAt[path] = t;
    });
    return out;
  }
  function mergeDocs(local, cloud) {
    local = local || {};
    cloud = cloud || {};
    const lAt = (local.at && typeof local.at === 'object') ? local.at : {};
    const cAt = (cloud.at && typeof cloud.at === 'object') ? cloud.at : {};
    const tombs = Object.assign({}, local.tombs || {}, cloud.tombs || {});
    Object.keys(tombs).forEach((k) => {
      const a = num((local.tombs || {})[k]);
      const b = num((cloud.tombs || {})[k]);
      tombs[k] = Math.max(a, b);
    });
    const outAt = Object.assign({}, cAt);
    const out = {
      v: 1,
      prefs: mergeScalarSection('prefs', local, cloud, lAt, cAt, outAt),
      ui: mergeScalarSection('ui', local, cloud, lAt, cAt, outAt),
      groups: {
        groups: [],
        activeId: '',
      },
      fonts: {},
      tombs: tombs,
      at: outAt,
      updatedAt: 0,
    };
    // 群聊:按 id 合并条目 + 单独处理 activeId
    const lGroups = (local.groups && Array.isArray(local.groups.groups)) ? local.groups.groups : [];
    const cGroups = (cloud.groups && Array.isArray(cloud.groups.groups)) ? cloud.groups.groups : [];
    const lMap = {}, cMap = {};
    lGroups.forEach((g) => { if (g && g.id) lMap[g.id] = g; });
    cGroups.forEach((g) => { if (g && g.id) cMap[g.id] = g; });
    const mergedGroups = mergeKeyedSection('groups', lMap, cMap, lAt, cAt, tombs, outAt);
    const order = [];
    cGroups.forEach((g) => { if (g && g.id && mergedGroups[g.id] !== undefined && order.indexOf(g.id) < 0) order.push(g.id); });
    lGroups.forEach((g) => { if (g && g.id && mergedGroups[g.id] !== undefined && order.indexOf(g.id) < 0) order.push(g.id); });
    out.groups.groups = order.map((id) => mergedGroups[id]);
    const activePath = 'groups.activeId';
    const lActive = (local.groups && local.groups.activeId) || '';
    const cActive = (cloud.groups && cloud.groups.activeId) || '';
    const ltA = num(lAt[activePath]);
    const ctA = num(cAt[activePath]);
    let active = (ctA > ltA) ? cActive : (lActive || cActive);
    if (!mergedGroups[active]) active = out.groups.groups.length ? out.groups.groups[0].id : '';
    out.groups.activeId = active;
    if (active) outAt[activePath] = Math.max(ltA, ctA);
    // 自定义字体:同名合并,墓碑压制
    out.fonts = mergeKeyedSection('fonts', local.fonts || {}, cloud.fonts || {}, lAt, cAt, tombs, outAt);
    let maxAt = 0;
    Object.keys(outAt).forEach((k) => { if (num(outAt[k]) > maxAt) maxAt = num(outAt[k]); });
    out.updatedAt = maxAt;
    return out;
  }

  // ============ 时间戳 / 墓碑 ============
  function bumpAt(path, ts) {
    const at = readAt();
    at[path] = ts || Date.now();
    writeAt(at);
  }
  function setTomb(path, ts) {
    const t = readTombs();
    t[path] = ts || Date.now();
    writeTombs(t);
  }
  function clearTombs(paths) {
    const t = readTombs();
    let changed = false;
    (paths || []).forEach((p) => { if (p in t) { delete t[p]; changed = true; } });
    if (changed) writeTombs(t);
  }

  // ============ 应用(云端 → 本地) ============
  function applyDoc(doc, opts) {
    S.applying = true;
    try {
      if (doc.prefs && window.OCUI && typeof window.OCUI.setPrefsBulk === 'function') {
        window.OCUI.setPrefsBulk(doc.prefs);
      }
      UI_FIELDS.forEach((f) => {
        if (doc.ui && Object.prototype.hasOwnProperty.call(doc.ui, f.f)) writeField(f, doc.ui[f.f]);
      });
      if (doc.groups && Array.isArray(doc.groups.groups)) {
        lsSet(GROUPS_KEY, JSON.stringify({ groups: doc.groups.groups, activeId: doc.groups.activeId || '' }));
      }
      if (doc.fonts && typeof doc.fonts === 'object') lsSet(FONTS_KEY, JSON.stringify(doc.fonts));
      writeAt(doc.at || {});
      writeTombs(doc.tombs || {});
      if (!opts || opts.notify !== false) {
        S.listeners.forEach((fn) => { try { fn(doc); } catch (e) { /* 单个订阅者出错不影响其它 */ } });
      }
    } finally {
      S.applying = false;
    }
    captureBase();
  }

  // ============ 推送 / 拉取 ============
  function token() {
    const st = window.OCState;
    return (st && st.token) || lsGet('oc_token') || '';
  }
  function apiUrl(path) { return window.apiUrl ? window.apiUrl(path) : path; }
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + token() }, opts.headers || {});
    return fetch(apiUrl(path), opts);
  }
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
  }
  function revKey() { return 'oc_settings_rev_' + (S.uid || 'anon'); }

  function schedulePush() {
    if (!S.active) return;
    S.dirty = true;
    clearTimeout(S.pushTimer);
    S.pushTimer = setTimeout(pushNow, 1200);
  }
  async function pushNow() {
    clearTimeout(S.pushTimer);
    S.pushTimer = null;
    if (!S.active || S.pushBusy || !S.dirty || !S.uid || !token()) return;
    S.pushBusy = true;
    const baseRevision = S.revision;
    const doc = snapshot();
    const pushedJson = valuesJson(doc);
    try {
      const r = await apiFetch('/api/sync/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: doc, baseRevision: baseRevision }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        const cloud = (data && data.settings) || {};
        S.revision = Number(data && data.revision) || S.revision;
        lsSet(revKey(), String(S.revision));
        const merged = mergeDocs(doc, cloud);
        applyDoc(merged);
        S.dirty = true;
        S.lastError = '';
        toast('检测到其他设备的设置改动，已自动合并（较新的保留）');
        schedulePush();
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (r.ok && data && data.syncSettings === false) {
        // 站点关闭了设置云同步:停止推送,本地照常可用
        S.serverDisabled = true;
        S.active = false;
        S.dirty = false;
        notifyStatus();
        return;
      }
      if (!r.ok) { S.lastError = 'HTTP ' + r.status; notifyStatus(); return; }
      S.revision = Number(data && data.revision) || baseRevision + 1;
      lsSet(revKey(), String(S.revision));
      S.dirty = false;
      S.lastError = '';
      S.lastSyncAt = Date.now();
      S.lastPushedJson = pushedJson;
      notifyStatus();
    } catch (e) {
      S.lastError = String((e && e.message) || e);
      notifyStatus();
    } finally {
      S.pushBusy = false;
    }
  }
  async function pullNow(opts) {
    opts = opts || {};
    if (!S.active || !S.uid || !token()) return false;
    // 本地还有未推送的改动时不拉取:避免把刚改的键当成旧值合掉
    if (!opts.force && (S.dirty || S.pushBusy)) return false;
    try {
      const r = await apiFetch('/api/sync/settings');
      if (!r.ok) return false;
      const data = await r.json().catch(() => ({}));
      if (data && data.syncSettings === false) {
        S.serverDisabled = true;
        S.active = false;
        notifyStatus();
        return false;
      }
      const cloud = (data && data.settings) || {};
      const revision = Number(data && data.revision) || 0;
      const local = snapshot();
      const merged = mergeDocs(local, cloud);
      const changed = valuesJson(local) !== valuesJson(merged);
      S.revision = revision;
      lsSet(revKey(), String(revision));
      if (changed) {
        applyDoc(merged);
        if (opts.firstForDevice && hasContent(cloud)) toast('已从云端恢复你的设置');
      } else {
        // 值没变也要落时间戳/墓碑(合并结果),但不触发重绘
        writeAt(merged.at || {});
        writeTombs(merged.tombs || {});
        captureBase();
      }
      // 本地有云端还没有的内容(首次上传 / 本地独有键):补一次推送
      const mergedJson = valuesJson(merged);
      if (mergedJson !== valuesJson(cloud) && mergedJson !== S.lastPushedJson) {
        S.dirty = true;
        schedulePush();
      }
      S.lastError = '';
      S.lastSyncAt = Date.now();
      notifyStatus();
      return changed;
    } catch (e) {
      S.lastError = String((e && e.message) || e);
      notifyStatus();
      return false;
    }
  }
  // 页面关闭/切后台前冲刷:防抖定时器会被丢弃,这里用 keepalive 兜底
  function flush() {
    if (!S.active || !S.dirty || !S.uid || !token()) return;
    clearTimeout(S.pushTimer);
    S.pushTimer = null;
    try {
      fetch(apiUrl('/api/sync/settings'), {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({ settings: snapshot(), baseRevision: S.revision }),
      }).catch(() => {});
      S.dirty = false;
    } catch (e) { /* 降级:放弃本次冲刷 */ }
  }

  // ============ 基线(用于 diff 出被改动/被删除的条目) ============
  function captureBase() {
    S.base = {
      groups: clone(readGroups().groups),
      fonts: clone(readFonts()),
      activeId: readGroups().activeId || '',
    };
  }
  function mapById(list, key) {
    const m = {};
    (list || []).forEach((it) => { if (it && it[key]) m[it[key]] = it; });
    return m;
  }
  // 键控集合的差异比对:改过的记时间戳,删掉的记墓碑
  function diffKeyed(section, map) {
    if (!S.base) captureBase();
    const now = Date.now();
    const prev = S.base[section] || {};
    const at = readAt();
    let changed = false;
    Object.keys(map).forEach((id) => {
      if (prev[id] === undefined || JSON.stringify(prev[id]) !== JSON.stringify(map[id])) {
        at[section + '.' + id] = now;
        changed = true;
      }
    });
    const removed = Object.keys(prev).filter((id) => map[id] === undefined);
    if (removed.length) {
      const tombs = readTombs();
      removed.forEach((id) => { tombs[section + '.' + id] = now; });
      writeTombs(tombs);
      changed = true;
    }
    if (changed) {
      writeAt(at);
      S.base[section] = clone(map);
      clearTombs(Object.keys(map).map((id) => section + '.' + id));
      schedulePush();
    }
    return changed;
  }
  // 群聊配置由 groupui 整体写回 oc_groups,这里按 id 对比出「改了哪些 / 删了哪些」
  function syncGroups(store) {
    if (!S.active) return;
    if (!S.base) captureBase();
    const list = (store && Array.isArray(store.groups)) ? store.groups : [];
    const changed = diffKeyed('groups', mapById(list, 'id'));
    const activeId = (store && store.activeId) || '';
    if (activeId && activeId !== (S.base.activeId || '')) {
      S.base.activeId = activeId;
      bumpAt('groups.activeId');
      schedulePush();
    } else if (changed) {
      S.base.activeId = activeId || S.base.activeId;
    }
  }
  // 自定义字体:{名称: CSS},同样按名称对比(删除走墓碑,避免别的设备复活)
  function syncFonts() {
    if (!S.active) return;
    diffKeyed('fonts', readFonts());
  }

  // ============ 对外接口 ============
  const API = {};
  API.version = '1.0.0';
  API.enabled = function () { return lsGet(ENABLED_KEY) !== '0'; };
  API.isActive = function () { return !!S.active; };
  API.status = function () {
    return {
      active: S.active,
      serverDisabled: S.serverDisabled,
      syncing: !!(S.pushBusy || S.pushTimer),
      dirty: S.dirty,
      revision: S.revision,
      lastSyncAt: S.lastSyncAt,
      lastError: S.lastError,
      enabled: API.enabled(),
      guest: S.guest,
    };
  };
  API.onApply = function (fn) { if (typeof fn === 'function') S.listeners.push(fn); };
  API.onStatus = function (fn) { if (typeof fn === 'function') S.statusListeners.push(fn); };
  function notifyStatus() {
    const st = API.status();
    S.statusListeners.forEach((fn) => { try { fn(st); } catch (e) {} });
  }
  API.schedulePush = schedulePush;
  API.push = function () { S.dirty = true; return pushNow(); };
  // 有未推送改动才推(退出登录前调用,避免把 token 吊销后才发请求)
  API.flushAsync = async function () { if (S.dirty && S.active) await pushNow(); };
  API.pull = pullNow;
  API.flush = flush;
  // 用户在本设备改了某项 UI 设置(值由调用方写入 localStorage)
  API.touchUi = function (field) {
    if (!S.active || S.applying || !S.uid) return;
    if (!UI_BY_FIELD[field]) return;
    bumpAt('ui.' + field);
    schedulePush();
  };
  // 由本模块负责写入并记时间戳
  API.setUi = function (field, value) {
    const f = UI_BY_FIELD[field];
    if (!f) return value;
    writeField(f, value);
    API.touchUi(field);
    return value;
  };
  API.syncGroups = syncGroups;
  API.syncFonts = syncFonts;
  API._internal = {
    state: S,
    snapshot: snapshot, mergeDocs: mergeDocs, applyDoc: applyDoc,
    valuesOf: valuesOf, UI_FIELDS: UI_FIELDS, captureBase: captureBase,
    bumpAt: bumpAt, readAt: readAt, readTombs: readTombs,
  };

  // 偏好变更:记时间戳 + 防抖推送(应用云端值时由 applying 抑制)
  if (window.OCUI && typeof window.OCUI.onPrefsChange === 'function') {
    window.OCUI.onPrefsChange((key) => {
      if (!S.active || S.applying || !S.uid || key === null || key === undefined) return;
      bumpAt('prefs.' + key);
      schedulePush();
    });
  }

  /**
   * 登录后调用:拉取云端设置并应用;本地有云端没有的内容则补推。
   * @param {object} user /api/auth/me 返回的用户对象
   */
  API.init = async function (user) {
    clearTimeout(S.pushTimer);
    S.pushTimer = null;
    S.uid = (user && user.id) ? String(user.id) : null;
    S.guest = !!(user && user.guest);
    S.serverDisabled = false;
    S.lastError = '';
    S.dirty = false;
    S.pushBusy = false;
    S.lastPushedJson = '';
    if (!S.uid || S.guest) { S.active = false; captureBase(); notifyStatus(); return false; }
    if (!API.enabled()) { S.active = false; captureBase(); notifyStatus(); return false; }
    // 换账号(同浏览器上另一个用户):本地设置属于上一个账号,不能当成本账号的初始值
    const owner = lsGet(OWNER_KEY);
    const freshDevice = owner === null;
    if (owner !== null && owner !== S.uid) {
      resetLocalSettings();
      S.revision = 0;
    } else {
      S.revision = Number(lsGet(revKey()) || 0);
    }
    S.active = true;
    lsSet(OWNER_KEY, S.uid);
    captureBase();
    await pullNow({ force: true, firstForDevice: freshDevice });
    // 首次登录(云端为空)或本地有独有键:把本地设置推上去,让下一台设备直接可用
    if (!S.dirty) {
      const local = snapshot();
      if (hasContent(local)) { S.dirty = true; schedulePush(); }
    }
    notifyStatus();
    return true;
  };
  /** 退出登录:停止同步(本地设置保留,换账号登录时会重置) */
  API.stop = function () {
    clearTimeout(S.pushTimer);
    S.pushTimer = null;
    S.active = false;
    S.uid = null;
    S.dirty = false;
    notifyStatus();
  };
  /** 用户开关(本设备):关闭后不再读写云端,本地设置照常 */
  API.setEnabled = function (on) {
    lsSet(ENABLED_KEY, on ? '1' : '0');
    if (!on) { API.stop(); return; }
    const u = window.OCState && window.OCState.user;
    if (u && !u.guest) API.init(u);
  };
  /**
   * 换账号时把本机设置清回默认:上一个账号的偏好/外观/群聊配置不能带进新账号
   * (对话、笔记、密钥本来就是按账号隔离的,设置此前是全局的,这里补齐隔离)。
   */
  function resetLocalSettings() {
    S.applying = true;
    try {
      lsDel(PREF_KEY);
      lsDel('oc_prefs_touched');
      lsDel('oc_prefs_schema');
      lsDel('oc_theme');
      lsDel(FONTS_KEY);
      lsDel(GROUPS_KEY);
      UI_FIELDS.forEach((f) => lsDel(fieldKey(f)));
      lsDel(AT_KEY);
      lsDel(TOMB_KEY);
      // 内存里的偏好缓存一并复位(否则本次会话仍按上一个账号的设置渲染)
      if (window.OCUI && typeof window.OCUI.resetPrefs === 'function') window.OCUI.resetPrefs();
    } finally {
      S.applying = false;
    }
    captureBase();
  }

  // 焦点/切回前台时对一下云端(有间隔限制,避免频繁请求)
  window.addEventListener('focus', () => {
    if (!S.active) return;
    if (Date.now() - S.lastPull < PULL_MIN_GAP) return;
    S.lastPull = Date.now();
    pullNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flush(); return; }
    if (!S.active) return;
    if (Date.now() - S.lastPull < PULL_MIN_GAP) return;
    S.lastPull = Date.now();
    pullNow();
  });
  window.addEventListener('beforeunload', flush);

  window.OCSettingsSync = API;
})();
