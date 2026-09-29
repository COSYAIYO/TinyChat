'use strict';
/* OpenAI Chat 前端逻辑 */

const $ = (id) => document.getElementById(id);
const quotaIsUnlimited = (value) => String(value) === '-1';
window.OCState = null;
let streamSaveTimer = null;
const state = {
  token: localStorage.getItem('oc_token') || '',
  user: null,
  providers: [],
  defaultProviderId: null,
  currentProviderId: null,
  currentModel: null,
  streaming: false,
  abortController: null,
  chats: [], // {id, title, messages: [{role, content}]}
  currentChatId: null,
  deletedIds: [], // 本端已删除的聊天 id(墓碑,合并云端时排除,防止删除记录复活)
  streamToggle: true,
  assistants: [],
  assistantCategories: [],
  defaultAssistant: null,
  mention: { open: false, q: '', index: 0, start: -1 },
  clearAssistantAt: 0,
  webSearchAvailable: false,
  tools: null,
  mineru: { enabled: true, mode: 'lite' },
  chatLimits: { contextMessages: 40, maxContextMessages: 200, maxOutputTokens: 8192 },
};

window.OCState = state;

// 从 UI 偏好系统读取运行参数(未加载时回退默认值)
function uiPref(key, def) {
  return (window.OCUI && window.OCUI.getPref(key) !== undefined) ? window.OCUI.getPref(key) : def;
}
function streamEnabled() { return !!uiPref('stream', true); }
function followUpsEnabled() { return !!uiPref('followups', false); }
function autoTitleEnabled() { return !!uiPref('autotitle', true); }
// 解析「辅助任务(跟进建议/命名)」指定的模型。
// pref 形如 'providerId\nmodelId';空值返回 null(调用方回退当前模型/本地截取)。
// 只接受对话模型(生图/生视频模型不用于文本辅助任务)。
function resolveAuxModel(prefKey) {
  const raw = String(uiPref(prefKey, '') || '');
  if (!raw) return null;
  const parts = raw.split('\n');
  const providerId = parts[0] || '';
  const modelId = parts.slice(1).join('\n');
  if (!providerId || !modelId) return null;
  const p = (state.providers || []).find((x) => x.id === providerId);
  if (!p || p.enabled === false) return null;
  const m = (p.models || []).find((x) => x && String(x.id) === modelId);
  if (!m) return null;
  if (modelIsImage(modelId) || modelIsVideo(modelId)) return null;
  return { providerId, model: modelId, format: p.apiFormat || 'chat' };
}
function elapsedEnabled() { return !!uiPref('elapsed', true); }
function reasoningEnabled() { return !!uiPref('reasoning', true); }
function reasoningEffort() {
  const v = String(uiPref('reasoningEffort', 'medium') || 'medium').toLowerCase();
  return (v === 'low' || v === 'high' || v === 'medium') ? v : 'medium';
}
const EFFORT_LABELS = { off: '关', low: '低', medium: '中', high: '高' };
function currentEffortMode() {
  return reasoningEnabled() ? reasoningEffort() : 'off';
}
const WEBSEARCH_LABELS = { auto: '智能', on: '始终', off: '关闭' };
function searchReady() {
  const t = state.tools && state.tools.webSearch;
  if (!t) return !!state.webSearchAvailable;
  if (t.source === 'own' && t.allowOwn) return !!t.ownReady;
  return !!t.platformReady;
}
function parseModeNow() {
  const t = state.tools && state.tools.parse;
  if (t && t.source === 'own' && t.allowOwn) return t.hasToken ? 'precise' : 'lite';
  return (state.mineru && state.mineru.mode) || 'lite';
}
function webSearchMode() {
  if (!searchReady()) return 'off';
  const stored = uiPref('webSearchMode', undefined);
  if (stored === 'auto' || stored === 'on' || stored === 'off') return stored;
  if (uiPref('webSearch', undefined) === true) return 'on';
  return 'auto';
}
function webSearchEnabled() {
  return webSearchMode() === 'on';
}
function setWebSearchMode(mode) {
  const next = (mode === 'on' || mode === 'off') ? mode : 'auto';
  if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('webSearchMode', next);
  syncComposerWebSearch();
}
function syncComposerWebSearch() {
  const btn = $('composer-websearch');
  if (!btn) return;
  const ready = searchReady();
  const mode = ready ? webSearchMode() : 'off';
  btn.classList.remove('hidden');
  btn.classList.toggle('on', ready && mode === 'on');
  btn.classList.toggle('auto', ready && mode === 'auto');
  btn.classList.toggle('off', !ready || mode === 'off');
  btn.setAttribute('aria-pressed', mode === 'on' ? 'true' : 'false');
  const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
  const title = !ready
    ? (own ? '联网搜索（还没填自己的配置）' : '联网搜索（后台尚未配置）')
    : ('联网：' + (WEBSEARCH_LABELS[mode] || '智能') + (own ? ' · 自己的' : ''));
  btn.title = title;
  btn.setAttribute('aria-label', title);
  document.querySelectorAll('#websearch-pop [data-websearch], #composer-tool-search [data-websearch]').forEach((b) => {
    b.classList.toggle('active', b.dataset.websearch === mode);
  });
  // 「≡」菜单按钮上加圆点:联网已开启(始终)时提示,收起菜单后也能一眼看出状态
  const more = $('composer-more');
  if (more) more.classList.toggle('flag-on', ready && mode === 'on');
}
function setEffortMode(mode) {
  const next = (mode === 'off' || mode === 'low' || mode === 'high') ? mode : 'medium';
  if (window.OCUI && window.OCUI.setPref) {
    if (next === 'off') window.OCUI.setPref('reasoning', false);
    else {
      window.OCUI.setPref('reasoning', true);
      window.OCUI.setPref('reasoningEffort', next);
    }
  }
  if (typeof syncPrefsPanel === 'function') syncPrefsPanel();
  if (typeof syncComposerEffort === 'function') syncComposerEffort();
}
function syncComposerEffort() {
  const mode = currentEffortMode();
  const btn = $('composer-effort');
  const lab = $('composer-effort-label');
  if (lab) lab.textContent = EFFORT_LABELS[mode] || '中';
  if (btn) {
    btn.classList.toggle('off', mode === 'off');
    const title = mode === 'off' ? '思维链已关闭' : ('思考强度：' + (EFFORT_LABELS[mode] || mode));
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  document.querySelectorAll('#effort-pop [data-effort], #composer-tool-effort [data-effort]').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === mode);
  });
}
function partsText(parts, thinking) {
  if (!Array.isArray(parts)) {
    if (thinking) return '';
    return typeof parts === 'string' ? parts : '';
  }
  return parts.map((p) => {
    if (!p) return '';
    const isThink = p.type === 'thinking' || p.type === 'reasoning' || p.type === 'thought';
    if (thinking) {
      if (!isThink) return '';
      return p.thinking || p.text || p.reasoning || '';
    }
    if (isThink) return '';
    if (typeof p === 'string') return p;
    return p.text || '';
  }).join('');
}
function reasoningText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.content || val.text || val.thinking || '';
  return String(val);
}
function upsertReasoningPanel(contentEl, msg, streaming) {
  if (!contentEl) return;
  const text = reasoningText(msg && msg.reasoning);
  let panel = contentEl.querySelector(':scope > .live-reasoning');
  if (!text) {
    if (panel) panel.remove();
    return;
  }
  const answering = !!(streaming && msg && msg.content);
  const userOpen = !!(panel && panel.dataset.userOpen === '1');
  const open = userOpen || (!!streaming && !answering);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'reasoning-wrap live-reasoning';
    panel.dataset.role = 'reasoning';
    contentEl.insertBefore(panel, contentEl.firstChild);
    panel.addEventListener('click', (e) => {
      if (!e.target.closest('.reasoning-header')) return;
      const next = !panel.classList.contains('open');
      panel.dataset.userOpen = next ? '1' : '0';
      panel.classList.toggle('open', next);
      const steps = panel.querySelector('.reasoning-steps');
      if (steps) steps.style.display = next ? '' : 'none';
    });
    panel.innerHTML =
      '<div class="reasoning-header">'
      + '<span class="reasoning-icon"></span>'
      + '<span class="reasoning-copy">'
      + '<span class="reasoning-title"></span>'
      + '<span class="reasoning-preview"></span>'
      + '</span>'
      + '<span class="phase-spinner" hidden></span>'
      + '<span class="reasoning-chev"></span>'
      + '</div>'
      + '<div class="reasoning-steps">'
      + '<div class="reasoning-body reasoning-live md-prose"></div>'
      + '</div>';
  }
  panel.classList.toggle('streaming', !!streaming);
  panel.classList.toggle('open', open);
  const icon = (window.OC && window.OC.icon) ? window.OC.icon('think', 14) : '';
  const chev = (window.OC && window.OC.icon) ? window.OC.icon('chevronDown', 14) : '';
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 72);
  const iconEl = panel.querySelector('.reasoning-icon');
  const titleEl = panel.querySelector('.reasoning-title');
  const previewEl = panel.querySelector('.reasoning-preview');
  const spinner = panel.querySelector('.phase-spinner');
  const chevEl = panel.querySelector('.reasoning-chev');
  const steps = panel.querySelector('.reasoning-steps');
  const body = panel.querySelector('.reasoning-live');
  if (iconEl) iconEl.innerHTML = icon;
  if (titleEl) titleEl.textContent = streaming ? (answering ? '思考完成' : '正在思考') : '思考过程';
  if (previewEl) {
    if (!open && preview) {
      previewEl.hidden = false;
      previewEl.textContent = preview + (text.length > 72 ? '…' : '');
    } else {
      previewEl.hidden = true;
      previewEl.textContent = '';
    }
  }
  if (spinner) spinner.hidden = !streaming || answering;
  if (chevEl) chevEl.innerHTML = chev;
  if (steps) steps.style.display = open ? '' : 'none';
  if (body) {
    if (window.OCRenderer && streaming && window.OCRenderer.renderStreamingInto) {
      window.OCRenderer.renderStreamingInto(body, text);
    } else if (window.OCRenderer && window.OCRenderer.renderInto) {
      window.OCRenderer.renderInto(body, text);
    } else {
      body.textContent = text;
    }
    if (streaming) body.scrollTop = body.scrollHeight;
  }
}

const ENDPOINT_BY_FORMAT = {
  chat: '/api/proxy/chat',
  responses: '/api/proxy/responses',
  completions: '/api/proxy/completions',
  anthropic: '/api/proxy/anthropic',
};

// ============ 基础工具 ============
function api(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + state.token }, opts.headers || {});
  return fetch(apiUrl(path), opts).then(async (r) => {
    if (r.status === 401) { logout(); throw new Error('登录已过期'); }
    return r;
  });
}

// 容错解析 JSON:响应不是 JSON(常见于服务器返回 HTML 错误页)时返回带提示的对象,而不是抛解析异常
async function readJsonSafe(res) {
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try { return JSON.parse(trimmed); } catch (e) { /* 落到下面统一处理 */ }
  }
  return { error: { message: '服务器返回了非预期内容（HTTP ' + res.status + '），请检查站点配置或稍后重试' } };
}

function toast(msg, isError = false) {
  if (window.OCUI) return window.OCUI.toast(msg, isError ? 'error' : undefined);
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ 头像(默认用 logo) ============
const LOGO_AVATAR_HTML = '<img src="./logo.svg" class="brand-logo-light avatar-logo-img" alt="">'
  + '<img src="./logo-dark.svg" class="brand-logo-dark avatar-logo-img" alt="">';
const USER_AVATAR_SVG = LOGO_AVATAR_HTML;
const AI_AVATAR_SVG = LOGO_AVATAR_HTML;
// 生图模型判定:优先用供应商配置里的显式 image 标记,缺省时按模型名启发式
function modelIsImage(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const hint = (window.OC && OC.isImageModelName) ? OC.isImageModelName : () => false;
  for (const p of state.providers || []) {
    for (const m of p.models || []) {
      if (m && String(m.id) === id) {
        if (Object.prototype.hasOwnProperty.call(m, 'image')) return !!m.image;
        return hint(id);
      }
    }
  }
  return hint(id);
}
function imageModelLogo() {
  return (window.OC && OC.imageLogo) ? OC.imageLogo() : 'static/logo/picture.svg';
}
// 视频模型判定:优先用供应商配置里的显式 video 标记,缺省时按模型名启发式;
// 若供应商接口格式本身就是 video,该供应商下模型一律视为视频模型。
function modelIsVideo(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const hint = (window.OC && OC.isVideoModelName) ? OC.isVideoModelName : () => false;
  for (const p of state.providers || []) {
    if (p && p.apiFormat === 'video') {
      for (const m of p.models || []) {
        if (m && String(m.id) === id) return true;
      }
    }
    for (const m of p.models || []) {
      if (m && String(m.id) === id) {
        if (Object.prototype.hasOwnProperty.call(m, 'video')) return !!m.video;
        return hint(id);
      }
    }
  }
  return hint(id);
}
// 当前供应商下被判定为视频生成的模型
function videoModelsOfCurrentProvider() {
  const p = (state.providers || []).find((x) => x.id === state.currentProviderId);
  if (!p || !Array.isArray(p.models)) return [];
  return p.models.filter((m) => m && m.id && modelIsVideo(m.id));
}
function videoModelLogo() {
  return 'static/logo/picture.svg';
}
// 生图 / 生视频都「不使用助手」,也不参与 @助手 候选
function modelIsVisual(modelId) {
  return modelIsImage(modelId) || modelIsVideo(modelId);
}
// 读取本地图片为 data URL(供改图参考图使用)
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
// 压缩参考图:长边不超过 1536px、JPEG 质量 0.9。
// 参考图只用于给上游做编辑依据,无需原图分辨率;压缩能显著减小请求体与上游处理开销。
// 输入既可以是 File,也可以是 data URL(输入框附件保存的就是 data URL),
// 这样「输入框上传图片」与「绘图弹窗添加参考图」走同一套压缩逻辑,发给上游的结果一致。
function compressImageRef(source, maxEdge = 1536) {
  return new Promise((resolve) => {
    const finishFromDataUrl = (dataUrl) => {
      if (!dataUrl) return resolve('');
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, maxEdge / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          // JPEG 无透明通道:先铺白底,避免透明 PNG 转出黑块
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const out = c.toDataURL('image/jpeg', 0.9);
          resolve(out || dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    if (typeof source === 'string') return finishFromDataUrl(source);
    if (!source) return resolve('');
    readFileAsDataUrl(source).then(finishFromDataUrl).catch(() => resolve(''));
  });
}
function readImageRefCompressed(file, maxEdge = 1536) {
  return compressImageRef(file, maxEdge);
}
// 图片规格解析:支持像素尺寸(1024x1024)、档位(2K/4K)与宽高比(16:9)。
// 上游对「尺寸」与「宽高比」是两个不同参数,这里按形态分派,非法值一律回退默认尺寸。
function parseImageSpec(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[×*]/g, 'x');
  if (/^\d{3,4}x\d{3,4}$/.test(s)) return { size: s, ratio: '' };
  if (/^[1-4]k$/.test(s)) return { size: s.toUpperCase(), ratio: '' };
  if (/^\d{1,2}:\d{1,2}$/.test(s)) return { size: '', ratio: s };
  return { size: '1024x1024', ratio: '' };
}
// 视频规格:时长(4~12 秒)与画面比例,沿用生视频弹窗最近一次的选择
const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
function parseVideoSpec() {
  const rawSec = parseInt(localStorage.getItem('oc_video_seconds') || '', 10);
  const seconds = (rawSec >= 4 && rawSec <= 12) ? rawSec : 5;
  const rawRatio = String(localStorage.getItem('oc_video_ratio') || '').trim();
  const ratio = VIDEO_RATIOS.indexOf(rawRatio) >= 0 ? rawRatio : '16:9';
  return { seconds, ratio };
}
// 助手头像按消息所属模型匹配图标:生图/生视频模型统一用 picture.svg,其余匹配厂商 logo,未命中回退站点 logo
function aiAvatarHtml(modelText) {
  const raw = String(modelText || '').trim();
  // 生图结果的消息模型名形如 "xxx (图像)",生视频形如 "xxx (视频)"
  const isImageMsg = /\(图像\)\s*$/.test(raw);
  const isVideoMsg = /\(视频\)\s*$/.test(raw);
  const modelId = raw.replace(/\s*\((图像|视频)\)\s*$/, '');
  if (window.OC && window.OC.logoImg && (isImageMsg || isVideoMsg || (modelId && (modelIsImage(modelId) || modelIsVideo(modelId))))) {
    const html = window.OC.logoImg(imageModelLogo(), 'avatar-logo-img');
    if (html) return html;
  }
  if (raw && window.OC && window.OC.logoImg && window.OC.modelLogo) {
    const html = window.OC.logoImg(window.OC.modelLogo(raw), 'avatar-logo-img');
    if (html) return html;
  }
  return AI_AVATAR_SVG;
}
function fillLogoAvatar(el) {
  if (!el) return;
  el.classList.add('avatar-logo');
  el.style.background = '';
  el.style.color = '';
  el.innerHTML = LOGO_AVATAR_HTML;
}

// ============ 会话 / 侧边栏 ============
function loadChats() {
  try {
    state.chats = window.OCConversations.normalize(JSON.parse(localStorage.getItem('oc_chats_' + state.user.id) || '[]'));
    state.chats.forEach((c) => (c.messages || []).forEach((m) => { if (m && m.role === 'assistant') m._voteSent = m.vote || null; }));
  } catch (e) { state.chats = []; }
  state.currentChatId = state.chats[0] ? state.chats[0].id : null;
}

// 云同步：保存到本地 + 防抖推送云端
let syncTimer = null;
function slimChatsForStore(chats) {
  return (chats || []).map((c) => {
    const copy = Object.assign({}, c);
    copy.messages = (c.messages || []).map((m) => {
      const msg = Object.assign({}, m);
      if (msg.attachments && msg.attachments.length) {
        msg.attachments = msg.attachments.map((a) => {
          const att = Object.assign({}, a);
          if (att.dataUrl && att.dataUrl.length > 8000) att.dataUrl = '';
          if (att.content && att.content.length > 20000) att.content = att.content.slice(0, 20000);
          return att;
        });
      }
      return msg;
    });
    return copy;
  });
}
function scheduleStreamSave() {
  if (streamSaveTimer || !state.user) return;
  streamSaveTimer = setTimeout(() => { streamSaveTimer = null; saveChats(); }, 700);
}
function saveChats() {
  if (!state.user || state.applyingCloudChats) return;
  const key = 'oc_chats_' + state.user.id;
  try {
    localStorage.setItem(key, JSON.stringify(state.chats));
  } catch (e) {
    try { localStorage.setItem(key, JSON.stringify(slimChatsForStore(state.chats))); }
    catch (e2) { console.warn('保存对话失败', e2); }
  }
  scheduleCloudSync();
}
function scheduleCloudSync() {
  if (!state.token || !state.user) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushChatsToCloud(), 1500);
}
// 立即推送(删除等高危操作调用,不等防抖)
function syncNow() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  return pushChatsToCloud();
}
async function pushChatsToCloud() {
  syncTimer = null;
  try {
    const r = await api('/api/sync/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chats: state.chats, baseRevision: state.chatRevision || 0 }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const revision = Number(data.revision) || 0;
      const prevId = state.currentChatId;
      const prev = (state.chats || []).find((c) => c.id === prevId) || null;
      const prevStamp = chatViewStamp(prev);
      state.chats = mergeChatLists(data.chats || [], state.chats || []);
      state.chatRevision = revision;
      if (state.user) localStorage.setItem('oc_chat_rev_' + state.user.id, String(revision));
      saveChats();
      renderChatList();
      const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
      if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
      return;
    }
    if (!r.ok) throw new Error('sync failed');
    state.chatRevision = Number(data.revision) || state.chatRevision || 0;
    if (state.user) localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
  } catch (e) {
    // 静默失败,下次修改会重试
  }
}
// 页面关闭/刷新前冲刷待同步数据(防抖定时器会被取消,这里兜底防止云端残留旧数据)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.streaming) pullChatsFromCloud();
});
window.addEventListener('focus', () => { if (!state.streaming) pullChatsFromCloud(); });
// 已打开的页面不会收到焦点事件。只在可见、且没有待上传改动时对一下版本号。
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (syncTimer || state.streaming || state.applyingCloudChats) return;
  pullChatsFromCloud();
}, 8000);
window.addEventListener('beforeunload', () => {
  if (state.token && state.user) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    try {
      // keepalive 请求在页面卸载时仍能送达,且可带 Authorization header
      fetch(apiUrl('/api/sync/chats'), {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: JSON.stringify({ chats: state.chats, baseRevision: state.chatRevision || 0 }),
      }).catch(() => {});
    } catch (e) { /* 降级:放弃本次冲刷 */ }
  }
});
// 登录后从云端拉取并合并到本地
function chatViewStamp(chat) {
  if (!chat) return '';
  const msgs = chat.messages || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return [
    chat.id,
    chat.updatedAt || 0,
    msgs.length,
    chat._showAll ? 1 : 0,
    last ? (last.id || '') + ':' + (last.role || '') + ':' + String(last.content || '').length + ':' + (last._streaming ? 1 : 0) : '',
  ].join('|');
}
function applyCloudChats(chats, revision) {
  if (!state.user) return;
  state.applyingCloudChats = true;
  try {
    const prevId = state.currentChatId;
    const prev = (state.chats || []).find((c) => c.id === prevId) || null;
    const prevStamp = chatViewStamp(prev);
    state.chats = window.OCConversations.normalize(chats || []);
    state.chatRevision = Number(revision) || 0;
    localStorage.setItem('oc_chats_' + state.user.id, JSON.stringify(state.chats));
    localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
    state.currentChatId = state.chats.some((c) => c.id === state.currentChatId) ? state.currentChatId : null;
    const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
    renderChatList();
    if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
  } finally {
    state.applyingCloudChats = false;
  }
}

async function pullChatsFromCloud() {
  if (!state.token || !state.user) return;
  try {
    const r = await api('/api/sync/chats');
    if (!r.ok) return;
    const data = await r.json();
    const revision = Number(data.revision) || 0;
    const seen = Number(localStorage.getItem('oc_chat_rev_' + state.user.id) || 0);
    if (revision !== seen) {
      const merged = mergeChatLists(data.chats || [], state.chats || []);
      state.chats = merged;
      state.chatRevision = revision;
      localStorage.setItem('oc_chats_' + state.user.id, JSON.stringify(merged));
      localStorage.setItem('oc_chat_rev_' + state.user.id, String(revision));
      renderChatList();
      if (!state.currentChatId && merged.length) state.currentChatId = merged[0].id;
      renderMessages();
      return;
    }
    const cloud = data.chats || [];
    if (!cloud.length && !(state.chats || []).length) return;
    const prevId = state.currentChatId;
    const prev = (state.chats || []).find((c) => c.id === prevId) || null;
    const prevStamp = chatViewStamp(prev);
    const merged = mergeChatLists(cloud, state.chats || []);
    if (merged.length === (state.chats || []).length && chatViewStamp(merged.find((c) => c.id === prevId) || null) === prevStamp) {
      const sameIds = merged.every((c, i) => state.chats[i] && state.chats[i].id === c.id && (state.chats[i].updatedAt || 0) === (c.updatedAt || 0) && !!state.chats[i].pinned === !!c.pinned);
      if (sameIds) return;
    }
    state.chats = merged;
    if (!state.currentChatId) state.currentChatId = state.chats[0] ? state.chats[0].id : null;
    saveChats();
    renderChatList();
    const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
    if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
  } catch (e) {
    // 网络失败用本地
  }
}

function mergeChatLists(cloudChats, localChats) {
  const cloud = window.OCConversations.normalize(cloudChats || []);
  const local = window.OCConversations.normalize(localChats || []);
  const merged = cloud.slice();
  local.forEach((lc) => {
    const found = merged.find((c) => c.id === lc.id);
    if (!found) {
      merged.push(lc);
      return;
    }
    if ((lc.updatedAt || 0) > (found.updatedAt || 0)) {
      merged[merged.indexOf(found)] = lc;
    }
  });
  merged.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return merged;
}

function currentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}
// API 对话是否显示在列表:用户偏好(默认开启),关闭后列表只显示网页端对话
function showApiChats() { return !!uiPref('showApiChats', true); }
function isApiChat(c) { return !!(c && c.apiKey); }
function visibleChats() {
  const all = state.chats || [];
  return showApiChats() ? all : all.filter((c) => !isApiChat(c));
}
function renderChatList() {
  const list = $('chat-list');
  list.innerHTML = '';
  if (!window.OCConversations || !list) { renderChatListSimple(list); return; }
  window.OCConversations.renderList(list, visibleChats(), {
    currentId: state.currentChatId,
    onSelect: (c) => {
      if (state.streaming) { stopStreaming(); }
      state.currentChatId = c.id;
      state._scrollHistoryToBottom = true;
      if (c._showAll) delete c._showAll;
      renderChatList(); renderMessages(); resetComposer(); updateAssistantChip();
    },
    onDelete: async (c) => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除对话', message: '确认删除此对话？删除后不可恢复。', danger: true, confirmText: '删除' })
        : confirm('确认删除此对话?');
      if (!ok) return;
      state.chats = state.chats.filter((x) => x.id !== c.id);
      if (state.currentChatId === c.id) state.currentChatId = state.chats[0] ? state.chats[0].id : null;
      saveChats(); renderChatList(); renderMessages();
      syncNow();
    },
    onRename: (c, item) => {
      window.OCConversations.renameInline(item, c.title, (title) => {
        c.title = title;
        // 手动重命名后不再是「自动标题」,AI 命名完成时不得覆盖
        c._autoTitled = false;
        c.updatedAt = Date.now();
        saveChats(); renderChatList();
      });
    },
    onTogglePin: (c) => {
      c.pinned = !c.pinned;
      c.updatedAt = Date.now();
      saveChats(); renderChatList();
    },
    onShare: (c) => shareConversation(c),
    onBranch: (c) => {
      // 在新对话中复制全部消息作为分支起点
      const branch = {
        id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
        title: c.title + '（副本）',
        messages: JSON.parse(JSON.stringify(c.messages || [])),
        pinned: false,
        branchOf: c.id,
        assistantId: c.assistantId || null,
        assistantName: c.assistantName || '',
        systemPrompt: c.systemPrompt || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.chats.unshift(branch);
      state.currentChatId = branch.id;
      saveChats(); renderChatList(); renderMessages(); resetComposer();
      updateAssistantChip();
    },
  });
}
function renderChatListSimple(list) {
  // 兜底：无 OCConversations 时的旧版渲染
  visibleChats().forEach((c) => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.currentChatId ? ' active' : '');
    item.textContent = c.title;
    item.addEventListener('click', () => {
      state.currentChatId = c.id;
      renderChatList(); renderMessages();
    });
    list.appendChild(item);
  });
}

// 分支：从消息处创建（右键/悬浮菜单触发专用）
function branchFromMessage(msg, chat) {
  const idx = chat.messages.indexOf(msg);
  if (idx < 0) return;
  const branch = window.OCConversations.createBranch(chat, idx);
  state.chats.unshift(branch);
  state.currentChatId = branch.id;
  saveChats(); renderChatList(); renderMessages(); resetComposer();
  updateAssistantChip();
  toast('已从该消息创建分支');
}

// 删除单条消息:用于清理无关上下文(用户消息与回答分别删除)
function deleteMessage(msg, chat) {
  if (!msg || !chat) return;
  const idx = chat.messages.indexOf(msg);
  if (idx < 0) return;
  chat.messages.splice(idx, 1);
  chat.updatedAt = Date.now();
  saveChats(); renderChatList(); renderMessages();
  toast('已删除该消息');
}

async function loadDefaultAssistant() {
  try {
    const r = await api('/api/assistants');
    const data = await r.json();
    if (!r.ok) return;
    syncAssistantCatalog(data);
    updateAssistantChip();
  } catch (e) { /* 助手库不可用时保持普通对话 */ }
}
function syncAssistantCatalog(data) {
  if (!data) return;
  if (Array.isArray(data.assistants)) state.assistants = data.assistants;
  if (Array.isArray(data.categories)) state.assistantCategories = data.categories;
  state.defaultAssistant = data.defaultAssistant
    || (state.assistants || []).find((a) => a.id === 'as-present')
    || state.defaultAssistant
    || null;
}
window.syncAssistantCatalog = syncAssistantCatalog;
function defaultAssistant() {
  return state.defaultAssistant
    || (state.assistants || []).find((a) => a.id === 'as-present')
    || null;
}
function resolveNewChatAssistant(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'assistant')) return opts.assistant;
  return defaultAssistant();
}
function ensureDefaultAssistantOnBlank(chat) {
  const target = chat || currentChat();
  if (!isBlankChat(target) || target.assistantId) return false;
  const assistant = defaultAssistant();
  if (!assistant) return false;
  applyAssistantToChat(target, assistant);
  target.updatedAt = Date.now();
  return true;
}
function applyAssistantToChat(chat, assistant) {
  if (!chat) return chat;
  if (assistant && assistant.id) {
    chat.assistantId = assistant.id;
    chat.assistantName = assistant.name || '';
    chat.systemPrompt = String(assistant.prompt || '');
  } else {
    chat.assistantId = null;
    chat.assistantName = '';
    chat.systemPrompt = '';
  }
  return chat;
}
function isBlankChat(chat) {
  return !!(chat && !(chat.messages && chat.messages.length));
}
function findBlankChat() {
  const cur = currentChat();
  if (isBlankChat(cur)) return cur;
  return (state.chats || []).find(isBlankChat) || null;
}
function newChat(opts) {
  if (state.streaming) { stopStreaming(); }
  const existing = findBlankChat();
  if (existing) {
    state.currentChatId = existing.id;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'assistant')) {
      applyAssistantToChat(existing, opts.assistant);
      existing.updatedAt = Date.now();
    } else {
      ensureDefaultAssistantOnBlank(existing);
    }
    saveChats();
    renderChatList();
    renderMessages();
    renderEmptyState();
    resetComposer();
    updateAssistantChip();
    autosizeInput();
    Promise.resolve(applyPinnedModel()).catch(() => {});
    const reuseInput = $('input');
    if (reuseInput) reuseInput.focus();
    return existing;
  }
  const assistant = resolveNewChatAssistant(opts);
  const chat = {
    id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
    title: '新对话',
    messages: [],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  applyAssistantToChat(chat, assistant);
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  saveChats(); renderChatList(); renderMessages(); renderEmptyState(); resetComposer();
  updateAssistantChip();
  autosizeInput();
  Promise.resolve(applyPinnedModel()).catch(() => {});
  const input = $('input');
  if (input) input.focus();
  return chat;
}
function useAssistantOnChat(assistant, opts) {
  const silent = opts && opts.silent;
  let chat = currentChat();
  if (!chat) chat = newChat({ assistant: assistant || null });
  else {
    applyAssistantToChat(chat, assistant || null);
    chat.updatedAt = Date.now();
    saveChats();
    updateAssistantChip();
  }
  if (!silent) {
    toast(assistant ? '已选用「' + (assistant.name || '助手') + '」' : '已取消助手');
  }
  return chat;
}
// 选用生图模型时自动去除当前对话的 @助手:
// 助手注入的是对话系统提示词,对生图请求没有意义,反而可能干扰生图平台。
function enforceImageModelAssistant(opts) {
  const chat = currentChat();
  if (!chat || !chat.assistantId) return false;
  const name = chat.assistantName || '助手';
  applyAssistantToChat(chat, null);
  chat.updatedAt = Date.now();
  saveChats();
  updateAssistantChip();
  if (!(opts && opts.silent)) toast('生图模型不使用助手，已自动取消「' + name + '」');
  return true;
}
function startAssistantChat(assistant) {
  if (!assistant) {
    useAssistantOnChat(null);
    return;
  }
  useAssistantOnChat(assistant);
}
window.startAssistantChat = startAssistantChat;
window.useAssistantOnChat = useAssistantOnChat;
function updateAssistantChip() {
  const label = $('assistant-lib-label');
  const chip = $('composer-assistant');
  const chat = currentChat();
  const name = chat && chat.assistantName ? String(chat.assistantName).trim() : '';
  if (label) label.textContent = name || '助手库';
  if (!chip) return;
  if (!name) {
    chip.classList.add('hidden');
    chip.textContent = '';
    chip.removeAttribute('data-tip');
    chip.removeAttribute('title');
    return;
  }
  chip.classList.remove('hidden');
  chip.textContent = '@' + name;
  chip.setAttribute('data-tip', '当前助手：' + name + '（再按两下 Backspace 可取消）');
  chip.removeAttribute('title');
}
function renderEmptyState() {
  const empty = $('empty-state');
  empty.style.display = (state.currentChatId && currentChat() && currentChat().messages.length) ? 'none' : 'flex';
  updateAssistantChip();
}
function resetComposer() {
  const input = $('input');
  if (input) {
    input.value = '';
    if (typeof autosizeInput === 'function') autosizeInput();
  }
  state.pendingAttachments = [];
  if (typeof renderAttachments === 'function') renderAttachments();
  if (typeof updateSendBtn === 'function') updateSendBtn();
}
function renderMessages() {
  const chat = currentChat();
  const box = $('messages');
  box.innerHTML = '';
  renderEmptyState();
  if (!chat) return;
  // 长对话分页：最多渲染最近 100 条，提供「加载更早消息」
  const MAX_VISIBLE = 100;
  const msgs = chat.messages;
  if (msgs.length > MAX_VISIBLE) {
    const pg = document.createElement('div');
    pg.className = 'msgs-pagination';
    const btn = document.createElement('button');
    btn.textContent = '↑ 加载更早的 ' + (msgs.length - MAX_VISIBLE) + ' 条消息';
    btn.addEventListener('click', () => {
      const area = $('chat-area');
      const before = area ? area.scrollHeight : 0;
      const top = area ? area.scrollTop : 0;
      chat._showAll = true;
      renderMessages();
      if (area) area.scrollTop = top + (area.scrollHeight - before);
    });
    pg.appendChild(btn);
    box.appendChild(pg);
  }
  const startIdx = chat._showAll ? 0 : Math.max(0, msgs.length - MAX_VISIBLE);
  for (let i = startIdx; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === 'system') continue;
    box.appendChild(buildMsgNode(msgs[i], chat, i));
  }
  renderChatToc();
  if (state._scrollHistoryToBottom) {
    state._scrollHistoryToBottom = false;
    scrollToBottom();
  }
}
function scrollToBottom() {
  const area = document.getElementById('chat-area');
  if (!area) return;
  const move = () => { area.scrollTop = area.scrollHeight; };
  move();
  requestAnimationFrame(() => {
    move();
    requestAnimationFrame(move);
  });
  setTimeout(move, 120);
}

function tocPreview(text, limit) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '（空）';
  const n = limit || 36;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function chatRounds(chat) {
  const rounds = [];
  const msgs = (chat && chat.messages) || [];
  let pending = null;
  msgs.forEach((m, i) => {
    if (!m || m.role === 'system') return;
    if (m.role === 'user') {
      pending = { userIdx: i, user: m, assistantIdx: -1, assistant: null };
      rounds.push(pending);
      return;
    }
    if (m.role === 'assistant') {
      if (pending && pending.assistantIdx < 0) {
        pending.assistantIdx = i;
        pending.assistant = m;
      } else {
        pending = { userIdx: -1, user: null, assistantIdx: i, assistant: m };
        rounds.push(pending);
      }
    }
  });
  return rounds;
}

function renderChatToc() {
  const toc = $('chat-toc');
  const main = document.querySelector('main.main');
  if (!toc) return;
  const chat = currentChat();
  const rounds = chatRounds(chat);
  const show = !!(chat && rounds.length >= 2);
  toc.classList.toggle('hidden', !show);
  if (main) main.classList.toggle('has-toc', show);
  if (!show) {
    toc.innerHTML = '';
    toc.classList.remove('open');
    return;
  }
  const activeIdx = toc.dataset.active ? Number(toc.dataset.active) : -1;
  toc.innerHTML = '';
  const marks = document.createElement('div');
  marks.className = 'chat-toc-marks';
  rounds.forEach((_, i) => {
    const tick = document.createElement('span');
    tick.className = 'chat-toc-mark' + (i === activeIdx ? ' active' : '');
    tick.dataset.round = String(i);
    marks.appendChild(tick);
  });
  toc.appendChild(marks);
  const head = document.createElement('div');
  head.className = 'chat-toc-head';
  head.textContent = '本轮目录';
  toc.appendChild(head);
  rounds.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-toc-item' + (i === activeIdx ? ' active' : '');
    btn.dataset.round = String(i);
    const q = tocPreview(r.user && r.user.content, 34);
    const a = r.assistant
      ? (r.assistant._streaming && !String(r.assistant.content || '').trim()
        ? '正在生成…'
        : tocPreview(r.assistant.content, 42))
      : '';
    btn.innerHTML =
      '<span class="chat-toc-num">' + (i + 1) + '</span>'
      + '<span class="chat-toc-copy">'
      + '<span class="chat-toc-q">' + escapeHtml(q) + '</span>'
      + (a ? '<span class="chat-toc-a">' + escapeHtml(a) + '</span>' : '')
      + '</span>';
    btn.addEventListener('click', () => jumpToRound(r.userIdx >= 0 ? r.userIdx : r.assistantIdx));
    toc.appendChild(btn);
  });
}

function jumpToRound(idx) {
  const chat = currentChat();
  if (!chat) return;
  if (!chat._showAll && chat.messages && chat.messages.length > 100) {
    chat._showAll = true;
    renderMessages();
  }
  const node = document.querySelector('#messages .msg[data-idx="' + idx + '"]');
  const area = $('chat-area');
  if (node && area) {
    const top = node.offsetTop - 16;
    area.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  const toc = $('chat-toc');
  if (toc) {
    toc.dataset.active = String(chatRounds(chat).findIndex((r) => r.userIdx === idx || r.assistantIdx === idx));
    toc.querySelectorAll('.chat-toc-item, .chat-toc-mark').forEach((el) => {
      el.classList.toggle('active', el.dataset.round === toc.dataset.active);
    });
  }
}

let syncTocTimer = 0;
function syncTocActive() {
  const toc = $('chat-toc');
  const area = $('chat-area');
  const chat = currentChat();
  if (!toc || toc.classList.contains('hidden') || !area || !chat) return;
  const rounds = chatRounds(chat);
  if (!rounds.length) return;
  const mid = area.scrollTop + Math.min(160, area.clientHeight * 0.28);
  let active = 0;
  rounds.forEach((r, i) => {
    const idx = r.userIdx >= 0 ? r.userIdx : r.assistantIdx;
    const node = document.querySelector('#messages .msg[data-idx="' + idx + '"]');
    if (node && node.offsetTop <= mid) active = i;
  });
  if (String(active) === toc.dataset.active) return;
  toc.dataset.active = String(active);
  toc.querySelectorAll('.chat-toc-item, .chat-toc-mark').forEach((el) => {
    el.classList.toggle('active', el.dataset.round === String(active));
  });
}
function snapshotReplyVersion(msg) {
  if (!msg || msg.role !== 'assistant') return null;
  const content = String(msg.content || '');
  if (!content.trim() && !msg.error) return null;
  return {
    content: content,
    reasoning: msg.reasoning || '',
    followUps: Array.isArray(msg.followUps) ? msg.followUps.slice() : [],
    citations: Array.isArray(msg.citations) ? msg.citations.slice() : [],
    vote: msg.vote || null,
    model: msg.model || '',
    error: !!msg.error,
    interrupted: !!msg.interrupted,
    failNote: msg.failNote || '',
    elapsedMs: typeof msg.elapsedMs === 'number' ? msg.elapsedMs : null,
    createdAt: msg.createdAt || Date.now(),
    usage: msg.usage ? Object.assign({}, msg.usage) : null,
    contextCount: Number(msg.contextCount) || 0,
    contextLimit: Number(msg.contextLimit) || 0,
  };
}

function applyReplyVersion(msg, snap) {
  if (!msg || !snap) return;
  msg.content = snap.content || '';
  msg.reasoning = snap.reasoning || '';
  msg.followUps = Array.isArray(snap.followUps) ? snap.followUps.slice() : [];
  msg.citations = Array.isArray(snap.citations) ? snap.citations.slice() : [];
  msg.vote = snap.vote || null;
  msg._voteSent = msg.vote;
  msg.model = snap.model || msg.model;
  msg.error = !!snap.error;
  msg.interrupted = !!snap.interrupted;
  msg.failNote = snap.failNote != null ? snap.failNote : (msg.failNote || '');
  msg.elapsedMs = typeof snap.elapsedMs === 'number' ? snap.elapsedMs : null;
  msg.createdAt = snap.createdAt || msg.createdAt;
  msg.usage = snap.usage ? Object.assign({}, snap.usage) : null;
  msg.contextCount = Number(snap.contextCount) || 0;
  msg.contextLimit = Number(snap.contextLimit) || 0;
  delete msg._startTime;
}

function ensureReplyVersions(msg) {
  if (!msg.versions || !msg.versions.length) {
    const snap = snapshotReplyVersion(msg);
    msg.versions = snap ? [snap] : [];
    msg.versionIndex = msg.versions.length ? msg.versions.length - 1 : 0;
  }
  if (typeof msg.versionIndex !== 'number' || msg.versionIndex < 0) {
    msg.versionIndex = Math.max(0, msg.versions.length - 1);
  }
  return msg.versions;
}

function persistCurrentReplyVersion(msg) {
  if (!msg || msg.role !== 'assistant') return;
  const versions = ensureReplyVersions(msg);
  const snap = snapshotReplyVersion(msg);
  if (!snap) return;
  const i = Math.min(Math.max(0, msg.versionIndex || 0), Math.max(0, versions.length - 1));
  versions[i] = snap;
}

function pushReplyVersion(msg) {
  persistCurrentReplyVersion(msg);
  const versions = ensureReplyVersions(msg);
  versions.push({
    content: '',
    reasoning: '',
    followUps: [],
    citations: [],
    vote: null,
    model: state.currentModel || '',
    error: false,
    interrupted: false,
    failNote: '',
    elapsedMs: null,
    createdAt: Date.now(),
    usage: null,
    contextCount: 0,
    contextLimit: 0,
  });
  msg.versionIndex = versions.length - 1;
  applyReplyVersion(msg, versions[msg.versionIndex]);
}

function switchReplyVersion(msg, chat, delta) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const versions = ensureReplyVersions(msg);
  if (versions.length < 2) return;
  persistCurrentReplyVersion(msg);
  const next = Math.min(versions.length - 1, Math.max(0, (msg.versionIndex || 0) + delta));
  if (next === msg.versionIndex) return;
  msg.versionIndex = next;
  applyReplyVersion(msg, versions[next]);
  saveChats();
  renderMessages();
}

function finalizeReplyTiming(msg) {
  if (!msg || !msg._startTime) return;
  msg.elapsedMs = Math.max(0, Date.now() - msg._startTime);
  persistCurrentReplyVersion(msg);
}

function formatElapsedMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  return (n / 1000).toFixed(1) + 's';
}

function formatTokenCount(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return '';
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}
function formatUsageText(msg) {
  if (!msg || msg.role !== 'assistant' || msg._streaming) return '';
  const usage = msg.usage || {};
  const total = Number(usage.total);
  const prompt = Number(usage.prompt);
  const completion = Number(usage.completion);
  const parts = [];
  if (isFinite(prompt) && prompt > 0) parts.push('↑ ' + formatTokenCount(prompt));
  if (isFinite(completion) && completion > 0) parts.push('↓ ' + formatTokenCount(completion));
  if (!parts.length && isFinite(total) && total > 0) parts.push('合计 ' + formatTokenCount(total));
  return parts.join(' · ');
}
function usageTitle(msg) {
  const usage = (msg && msg.usage) || {};
  const bits = [];
  if (usage.prompt) bits.push('输入 ' + usage.prompt);
  if (usage.completion) bits.push('输出 ' + usage.completion);
  if (usage.total) bits.push('合计 ' + usage.total);
  const sent = Number(msg && msg.contextCount);
  const limit = Number(msg && msg.contextLimit);
  if (isFinite(sent) && sent > 0) bits.push('本次带上 ' + Math.round(sent) + ' 条' + (isFinite(limit) && limit > 0 ? '，上限 ' + Math.round(limit) + ' 条' : ''));
  return bits.join(' · ') || 'Token 与上下文';
}
function takeUsage(target, raw) {
  if (!target || !raw || typeof raw !== 'object') return;
  const prompt = Number(raw.prompt_tokens != null ? raw.prompt_tokens : raw.input_tokens);
  const completion = Number(raw.completion_tokens != null ? raw.completion_tokens : raw.output_tokens);
  let total = Number(raw.total_tokens);
  if (!isFinite(total) || total < 0) {
    total = (isFinite(prompt) ? prompt : 0) + (isFinite(completion) ? completion : 0);
  }
  if (!(total > 0) && !(prompt > 0) && !(completion > 0)) return;
  target.usage = {
    prompt: isFinite(prompt) && prompt > 0 ? Math.round(prompt) : 0,
    completion: isFinite(completion) && completion > 0 ? Math.round(completion) : 0,
    total: Math.round(total),
  };
}
function formatMsgClock(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const p = (v) => String(v).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function stripInterruptMarks(text) {
  return String(text || '').replace(/\n*(\*\(已停止生成\)\*|\*\(生成中断，回答可能不完整\)\*)\s*$/g, '').trim();
}

function replyWasInterrupted(msg) {
  if (!msg || msg.role !== 'assistant' || msg.error || msg._streaming) return false;
  if (msg.interrupted) return true;
  const content = String(msg.content || '');
  if (/\*\((已停止生成|生成中断，回答可能不完整)\)\*/.test(content)) return true;
  const draft = content.replace(/\s+/g, '');
  return !draft && String(msg.reasoning || '').trim().length > 0;
}

function streamLooksComplete(format, text) {
  if (text.indexOf('[DONE]') >= 0) return true;
  if (format === 'anthropic' && text.indexOf('message_stop') >= 0) return true;
  if (format === 'responses' && (text.indexOf('response.completed') >= 0 || text.indexOf('response.incomplete') >= 0)) return true;
  return /"finish_reason"\s*:\s*"(stop|length|tool_calls|content_filter)"/.test(text);
}

function streamEndedEarly(format, raw, assistantMsg) {
  if (assistantMsg && assistantMsg.interrupted) return false;
  if (!raw || streamLooksComplete(format, raw)) return false;
  const content = String((assistantMsg && assistantMsg.content) || '').trim();
  const reasoning = String((assistantMsg && assistantMsg.reasoning) || '').trim();
  return !!(content || reasoning);
}

function renderElapsed(container, msg) {
  container.querySelectorAll('.reply-cost, .reply-versions').forEach((el) => el.remove());
  const elapsedText = elapsedEnabled()
    ? (typeof msg.elapsedMs === 'number'
      ? formatElapsedMs(msg.elapsedMs)
      : (msg && msg._startTime ? formatElapsedMs(Date.now() - msg._startTime) : ''))
    : '';
  const versions = (msg && Array.isArray(msg.versions)) ? msg.versions : [];
  const showPager = versions.length > 1 && !msg._streaming;
  const clockText = formatMsgClock(msg.createdAt);
  const usageText = formatUsageText(msg);
  if (!elapsedText && !showPager && !clockText && !usageText && !replyWasInterrupted(msg)) return;

  const mount = document.createElement('div');
  mount.className = 'reply-meta';
  const clock = formatMsgClock(msg.createdAt);
  if (clock) {
    const time = document.createElement('span');
    time.className = 'reply-time';
    time.textContent = clock;
    time.title = '回答时间';
    mount.appendChild(time);
  }
  const who = String(msg.model || '').trim();
  if (who) {
    const model = document.createElement('span');
    model.className = 'reply-model';
    model.textContent = who;
    model.title = '回答模型';
    mount.appendChild(model);
  }
  if (usageText) {
    const usage = document.createElement('span');
    usage.className = 'reply-usage';
    usage.textContent = usageText;
    usage.title = usageTitle(msg);
    mount.appendChild(usage);
  }
  if (replyWasInterrupted(msg)) {
    const flag = document.createElement('span');
    flag.className = 'reply-flag';
    flag.textContent = '中断';
    const who = String(msg.model || '').trim();
    flag.title = (who ? who + ' ' : '') + '生成被中断，回答可能不完整';
    mount.appendChild(flag);
    if (msg.failNote) {
      const note = document.createElement('span');
      note.className = 'reply-fail';
      note.textContent = msg.failNote;
      note.title = msg.failNote;
      mount.appendChild(note);
    }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'reply-continue';
    go.textContent = '继续生成';
    go.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chat = currentChat();
      if (chat) continueInterrupted(msg, chat);
    });
    mount.appendChild(go);
  }
  if (elapsedText) {
    const cost = document.createElement('span');
    cost.className = 'reply-cost';
    cost.textContent = elapsedText;
    cost.title = '生成耗时';
    mount.appendChild(cost);
  }
  if (showPager) {
    const idx = Math.min(Math.max(0, msg.versionIndex || 0), versions.length - 1);
    const pager = document.createElement('div');
    pager.className = 'reply-versions';
    pager.setAttribute('role', 'group');
    pager.setAttribute('aria-label', '切换回答版本');
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'reply-ver-btn';
    prev.textContent = '<';
    prev.disabled = idx <= 0;
    prev.setAttribute('aria-label', '上一版回答');
    const label = document.createElement('span');
    label.className = 'reply-ver-label';
    label.textContent = (idx + 1) + '/' + versions.length;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'reply-ver-btn';
    next.textContent = '>';
    next.disabled = idx >= versions.length - 1;
    next.setAttribute('aria-label', '下一版回答');
    prev.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chat = currentChat();
      if (chat) switchReplyVersion(msg, chat, -1);
    });
    next.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chat = currentChat();
      if (chat) switchReplyVersion(msg, chat, 1);
    });
    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
    mount.appendChild(pager);
  }

  const bar = container.querySelector('.msg-actions');
  if (bar) bar.appendChild(mount);
  else container.appendChild(mount);
}

// 回到底部悬浮按钮:滚动远离底部时显示,点击回到底部
(function initScrollBottomBtn() {
  const btn = $('scroll-bottom-btn');
  const area = $('chat-area');
  if (!btn || !area) return;
  const NEAR_BOTTOM = 120;
  const update = () => {
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
    btn.classList.toggle('show', dist > NEAR_BOTTOM);
  };
  area.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => {
    area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  });
  // 消息渲染后也检查一次
  const mo = new MutationObserver(() => update());
  mo.observe($('messages'), { childList: true, subtree: true });
  update();
})();
function buildMsgNode(m, chat, idx) {
  const role = m.role || 'assistant';
  const div = document.createElement('div');
  div.className = 'msg ' + role + (m.error ? ' msg-errored' : '');
  if (typeof idx === 'number') div.dataset.idx = String(idx);
  const avatar = role === 'user' ? USER_AVATAR_SVG : aiAvatarHtml((m && m.model) || state.currentModel || '');
  div.innerHTML = '<div class="msg-avatar">' + avatar + '</div>';
  const contentDiv = document.createElement('div');
  contentDiv.className = 'msg-content';
  if (m.error) {
    const kept = stripInterruptMarks(m.content);
    const note = String(m.failNote || m.content || '请求出错');
    contentDiv.innerHTML = (kept
      ? '<div class="msg-render-root md-prose"></div>'
      : '') + '<div class="msg-error">' + escapeHtml(note) + '</div>';
    if (kept && window.OCRenderer) {
      window.OCRenderer.renderInto(contentDiv.querySelector('.msg-render-root'), kept);
    }
    if (role === 'assistant') {
      // 失败时提供重试按钮
      const retryRow = document.createElement('div');
      retryRow.className = 'msg-retry-row';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn small';
      retryBtn.textContent = '↻ 重试';
      retryBtn.addEventListener('click', () => {
        regenerateMessage(m, chat);
      });
      retryRow.appendChild(retryBtn);
      if (kept) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'btn small';
        go.textContent = '继续生成';
        go.addEventListener('click', () => continueInterrupted(m, chat));
        retryRow.appendChild(go);
      }
      contentDiv.appendChild(retryRow);
    }
  } else if (role === 'assistant') {
    if (m.imagePending && !m.content) {
      // 生图/生视频占位:出图通常要 10–60 秒,出视频更久,给出明确的等待提示而不是空白气泡
      const waiting = m.pendingKind === 'video' ? '正在生成视频（可能需要 1–5 分钟）…' : '正在生成图片…';
      contentDiv.innerHTML = '<div class="phase-indicator"><span class="phase-spinner"></span><span class="phase-text">' + waiting + '</span></div>';
      div.appendChild(contentDiv);
      return div;
    }
    if (!m.createdAt && typeof idx === 'number' && chat && chat.messages) {
      for (let j = idx - 1; j >= 0; j--) {
        const prev = chat.messages[j];
        if (prev && prev.role === 'user' && prev.createdAt) {
          m.createdAt = prev.createdAt + (typeof m.elapsedMs === 'number' ? m.elapsedMs : 0);
          break;
        }
      }
    }
    // 新渲染管线：Markdown + 公式 + 代码 + Mermaid + 组件
    if (m.reasoning) upsertReasoningPanel(contentDiv, m, !!m._streaming);
    if (m._streaming) {
      // 流式中先出头像+思考态,有字后再跟光标,避免首 token 前像没头像
      if (m.content) {
        const root = document.createElement('div');
        root.className = 'stream-answer';
        contentDiv.appendChild(root);
        if (window.OCRenderer && window.OCRenderer.renderStreamingInto) {
          window.OCRenderer.renderStreamingInto(root, m.content);
        } else {
          root.classList.add('stream-inline');
          root.innerHTML = escapeHtml(m.content) + '<span class="stream-cursor"></span>';
        }
      } else if (!m.reasoning) {
        contentDiv.innerHTML = '<div class="phase-indicator"><span class="phase-spinner"></span><span class="phase-text">思考中</span></div>';
      }
    } else {
      const root = document.createElement('div');
      contentDiv.appendChild(root);
      window.OCRenderer.renderInto(root, m.content || '');
      // HTML/SVG 代码块附加「在 Artifacts 中打开」按钮
      if (window.OCMultimodal && window.OCMultimodal.enhanceArtifactButtons) {
        window.OCMultimodal.enhanceArtifactButtons(root);
      }
      // 来源引用 [n] → 可点击上标
      if (window.OCCitations && m.citations && m.citations.length) {
        window.OCCitations.enhanceCitations(root, m.citations);
      }
    }
  } else {
    // 用户消息：走渲染管线以支持附件（图片/文件卡片），但限制富文本能力
    const root = document.createElement('div');
    contentDiv.appendChild(root);
    window.OCRenderer.renderInto(root, m.content || '');
  }
  div.appendChild(contentDiv);

  // 操作栏 + 快捷指令（仅在非流式完成时）
  if (role === 'assistant' && !m._streaming && (m.content || m.reasoning || replyWasInterrupted(m))) {
    window.OCMessages.attachActions(div, m, {
      onRegenerate: (mm) => regenerateMessage(mm, chat),
      onShare: (mm) => shareMessage(mm),
      onVote: submitMessageVote,
      onQuickAction: quickAction,
      onBranch: (mm) => branchFromMessage(mm, chat),
      onDelete: (mm) => deleteMessage(mm, chat),
    });
    // 跟进建议
    if (m.followUps && m.followUps.length) {
      window.OCMultimodal.renderFollowUps(div, m.followUps, applyFollowUp);
    }
    // 来源列表
    if (m.citations && m.citations.length && window.OCCitations) {
      window.OCCitations.renderSources(div, m.citations);
    }
    // 耗时显示
    if (typeof renderElapsed === 'function') renderElapsed(div, m);
  }
  if (role === 'user' && !m._streaming) {
    window.OCMessages.attachActions(div, m, {
      onEdit: (mm, el) => editAndResend(mm, chat, el || div),
      onBranch: (mm) => branchFromMessage(mm, chat),
      onDelete: (mm) => deleteMessage(mm, chat),
    });
    const clock = formatMsgClock(m.createdAt);
    if (clock) {
      const bar = div.querySelector('.msg-actions');
      if (bar) {
        const time = document.createElement('span');
        time.className = 'reply-time';
        time.textContent = clock;
        time.title = '提问时间';
        bar.appendChild(time);
      }
    }
  }
  return div;
}

// ============ 供应商 / 模型 ============
function persistCurrentModel() {
  if (!(window.OCUI && window.OCUI.setPref)) return;
  window.OCUI.setPref('lastProviderId', state.currentProviderId || null);
  window.OCUI.setPref('lastModel', state.currentModel || null);
}
function pinnedModelId() { return uiPref('pinnedModel', null) || null; }
function pinnedProviderId() { return uiPref('pinnedProviderId', null) || null; }
function isPinnedModel(id) {
  return !!id && id === pinnedModelId() && (!pinnedProviderId() || pinnedProviderId() === state.currentProviderId);
}
function togglePinModel(modelId) {
  if (!modelId || !(window.OCUI && window.OCUI.setPref)) return pinnedModelId();
  if (isPinnedModel(modelId)) {
    window.OCUI.setPref('pinnedModel', null);
    window.OCUI.setPref('pinnedProviderId', null);
    toast('已取消置顶');
  } else {
    window.OCUI.setPref('pinnedModel', modelId);
    window.OCUI.setPref('pinnedProviderId', state.currentProviderId);
    toast('已置顶，新建对话将使用此模型');
  }
  renderModelPicker();
  const now = pinnedModelId();
  document.querySelectorAll('.oc-menu-pin').forEach((btn) => {
    const on = btn.getAttribute('data-pin') === now && isPinnedModel(now);
    btn.classList.toggle('active', on);
    btn.title = on ? '取消置顶' : '置顶，新建对话使用此模型';
  });
  return now;
}
async function applyPinnedModel() {
  const pinProv = pinnedProviderId();
  const pinModel = pinnedModelId();
  if (!pinModel) return;
  if (pinProv && pinProv !== state.currentProviderId) {
    if (!state.providers.some((p) => p.id === pinProv)) return;
    state.currentProviderId = pinProv;
    await loadModels({ prefer: pinModel });
    renderProviderLabel();
    return;
  }
  if (state.models.some((m) => m.id === pinModel) && state.currentModel !== pinModel) {
    state.currentModel = pinModel;
    persistCurrentModel();
    renderModelPicker();
  }
}
async function loadProviders() {
  const r = await api('/api/providers');
  const data = await r.json();
  // 已停用的供应商(仅管理员会从接口拿到)不在聊天侧展示与选用,后台管理列表除外
  state.providers = (data.providers || []).filter((p) => p.enabled !== false);
  state.defaultProviderId = data.defaultProviderId;
  state.webSearchAvailable = !!(data.webSearch && data.webSearch.enabled);
  state.mineru = (data.mineru && data.mineru.mode) ? data.mineru : { enabled: true, mode: 'lite' };
  if (data.chatLimits) {
    state.chatLimits = {
      contextMessages: Math.min(500, Math.max(2, Number(data.chatLimits.contextMessages) || 40)),
      maxContextMessages: Math.min(500, Math.max(2, Number(data.chatLimits.maxContextMessages) || 200)),
      maxOutputTokens: Math.min(128000, Math.max(256, Number(data.chatLimits.maxOutputTokens) || 8192)),
    };
  }
  if (!state.tools) {
    state.tools = {
      webSearch: { allowOwn: !!(data.webSearch && data.webSearch.allowOwn), platformReady: state.webSearchAvailable, source: 'platform', ownReady: false },
      parse: { allowOwn: !!(data.mineru && data.mineru.allowOwn), platformMode: state.mineru.mode, source: 'platform', hasToken: false },
    };
  }
  if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
  // 标记需要点选默认供应商的场景
  const provs = state.providers;
  const lastProv = uiPref('lastProviderId', null);
  const pinProv = pinnedProviderId();
  const d = provs.find((p) => p.id === lastProv)
    || provs.find((p) => p.id === pinProv)
    || provs.find((p) => p.id === state.defaultProviderId)
    || provs.find((p) => p.scope === 'global')
    || provs.find((p) => p.ownerId === (state.user && state.user.id))
    || state.providers[0];
  state.currentProviderId = d ? d.id : null;
  await loadModels({ prefer: pinnedModelId() });
  await applyPinnedModel();
  renderProviderLabel();
}
async function loadModels(opts) {
  opts = opts || {};
  state.currentModel = null;
  state.models = [];
  if (!state.currentProviderId) { renderModelPicker(); return; }

  const r = await api('/api/proxy/models?provider=' + encodeURIComponent(state.currentProviderId));
  const data = await r.json();
  const prov = state.providers.find((p) => p.id === state.currentProviderId);
  state.models = data.models || [];
  state.modelHealth = data.health && typeof data.health === 'object' ? data.health : {};
  state.modelCosts = data.costs && typeof data.costs === 'object' ? data.costs : {};
  const prefer = opts.prefer || pinnedModelId() || uiPref('lastModel', null);
  const found = prefer && state.models.find((x) => x.id === prefer);
  if (found) state.currentModel = found.id;
  else if (prov) state.currentModel = (state.models[0] ? state.models[0].id : null) || prov.defaultModel || null;
  else if (state.models.length) state.currentModel = state.models[0].id;
  persistCurrentModel();
  renderModelPicker();
  // 切换后若当前模型是生图/生视频模型,自动取消 @助手
  if (modelIsVisual(state.currentModel)) enforceImageModelAssistant({ silent: true });
}
// 当前供应商下某模型的单次扣减次数:模型级 cost 优先(costs 映射),否则用供应商价
function modelCostOf(id, providerId) {
  const pid = providerId || state.currentProviderId;
  const prov = (state.providers || []).find((p) => p.id === pid);
  if (!prov) return null;
  const m = (prov.models || []).find((x) => x && String(x.id) === String(id));
  if (m && Object.prototype.hasOwnProperty.call(m, 'cost')) {
    const c = Number(m.cost);
    if (isFinite(c) && c >= 0) return c;
  }
  if (pid === state.currentProviderId && state.modelCosts && Object.prototype.hasOwnProperty.call(state.modelCosts, String(id))) {
    const c = Number(state.modelCosts[String(id)]);
    if (isFinite(c) && c >= 0) return c;
  }
  // 属主自己的供应商不计费
  if (state.user && ((prov.ownerId && String(prov.ownerId) === String(state.user.id)) || prov.mine)) return 0;
  const pc = Number(prov.costPerCall);
  return isFinite(pc) && pc >= 0 ? pc : null;
}
function costTextOf(id, providerId) {
  const c = modelCostOf(id, providerId);
  if (c === null) return '';
  return c === 0 ? '免费（不计站点次数）' : ('每次调用扣 ' + c + ' 次');
}
// 可用性分级:阈值由后台「对话设置 → 模型可用性显示」配置
function healthLabelOf(stateName) {
  if (stateName === 'ok') return '可用';
  if (stateName === 'warn') return '不稳定';
  if (stateName === 'bad') return '较差';
  return '暂无数据';
}
function modelHealthOf(id, providerId) {
  const row = id && state.modelHealth ? state.modelHealth[id] : null;
  const allowed = ['ok', 'warn', 'bad'];
  const stateName = row && allowed.indexOf(row.state) >= 0 ? row.state : 'idle';
  const calls = row && Number(row.calls) > 0 ? Number(row.calls) : 0;
  const rate = row && isFinite(Number(row.rate)) ? Math.round(Number(row.rate) * 100) : 0;
  const cost = costTextOf(id, providerId);
  const costLine = cost ? String.fromCharCode(10) + cost : '';
  if (stateName === 'idle') return { state: 'idle', title: '最近 4 小时无人调用' + costLine };
  return {
    state: stateName,
    title: healthLabelOf(stateName) + '：最近 4 小时 ' + calls + ' 次调用，成功率 ' + rate + '%' + costLine,
  };
}
function healthIconName(stateName) {
  if (stateName === 'ok') return 'healthOk';
  if (stateName === 'bad') return 'healthBad';
  return 'healthIdle';   // idle 与 warn 共用省略号图标(warn 由文字与颜色区分)
}
function modelDisplayName(model) {
  const provider = state.providers.find((x) => x.id === state.currentProviderId);
  const name = model && (model.name || model.id);
  return provider && name ? provider.name + '@' + name : (name || '');
}
function renderModelPicker() {
  const nameEl = $('model-name');
  if (!nameEl) return;
  if (!state.currentModel) {
    nameEl.textContent = state.models && state.models.length ? '' : '选择模型';
    if (!state.models || !state.models.length) nameEl.textContent = '暂无模型';
  } else {
    const m = state.models.find((x) => x.id === state.currentModel);
    nameEl.textContent = modelDisplayName(m) || state.currentModel;
  }
  const picker = $('model-picker');
  if (picker) picker.classList.toggle('is-pinned', isPinnedModel(state.currentModel));
  const health = $('model-health');
  const mark = $('model-pin-mark');
  const pinned = isPinnedModel(state.currentModel);
  if (health) {
    const info = modelHealthOf(state.currentModel);
    health.classList.remove('hidden', 'ok', 'bad', 'idle');
    if (!state.currentModel) health.classList.add('hidden');
    else {
      health.classList.add(info.state);
      health.title = info.title;
      health.innerHTML = window.OC && window.OC.icon ? window.OC.icon(healthIconName(info.state), 12) : '';
    }
  }
  if (mark) {
    mark.classList.toggle('hidden', !pinned);
    mark.classList.toggle('solo', !state.currentModel);
  }
  syncComposerTools();
}
// 后台是否有任何可用的生图 / 生视频模型:决定「≡」菜单里的「绘画」「生视频」入口是否显示。
// 一个都没有时(纯对话站)不显示对应入口,避免点开才发现没有模型。
function hasAnyImageModel() {
  return (state.providers || []).some((p) => (p.models || []).some((m) => m && m.id && modelIsImage(m.id)));
}
function hasAnyVideoModel() {
  return (state.providers || []).some((p) => (p.models || []).some((m) => m && m.id && modelIsVideo(m.id)));
}
function syncComposerTools() {
  const imgTool = $('composer-tool-image');
  const vidTool = $('composer-tool-video');
  if (imgTool) imgTool.classList.toggle('hidden', !hasAnyImageModel());
  if (vidTool) vidTool.classList.toggle('hidden', !hasAnyVideoModel());
}
function renderProviderLabel() {
  const p = state.providers.find((x) => x.id === state.currentProviderId);
  const hint = $('empty-hint');
  if (!hint) return;
  if (p) {
    hint.textContent = '';
    hint.hidden = true;
  } else {
    hint.hidden = false;
    hint.textContent = '暂无可用的 API 供应商，点击左下角「设置」添加';
  }
}

// 自定义模型选择器：汇总所有有权限的供应商模型
// 模型选择器的分组:对话模型在前,生图模型自动归入末尾的「生图模型」分组。
// openSelect 检测 groups[0].label !== undefined 时按分组渲染。
function availableModelItems() {
  const chat = [];
  const image = [];
  const video = [];
  (state.providers || []).forEach((provider) => {
    (provider.models || []).forEach((m) => {
      const id = m && m.id ? String(m.id) : '';
      if (!id) return;
      const name = m.name || id;
      const health = provider.id === state.currentProviderId
        ? modelHealthOf(id, provider.id)
        : (function () {
            // 非当前供应商没有健康数据,但仍显示价格(提示里最有用的信息)
            const c = modelCostOf(id, provider.id);
            const costLine = (c === null) ? '' : (String.fromCharCode(10) + (c === 0 ? '免费（不计站点次数）' : ('每次调用扣 ' + c + ' 次')));
            return { state: 'idle', title: '最近 4 小时无人调用' + costLine };
          })();
      const isVideo = provider.apiFormat === 'video'
        || (Object.prototype.hasOwnProperty.call(m, 'video')
          ? !!m.video
          : !!((window.OC && OC.isVideoModelName) ? OC.isVideoModelName(id) : false));
      const isImage = !isVideo && (Object.prototype.hasOwnProperty.call(m, 'image')
        ? !!m.image
        : !!((window.OC && OC.isImageModelName) ? OC.isImageModelName(id) : false));
      const logo = (window.OC && OC.modelIcon)
        ? OC.modelIcon(id + ' ' + name, provider.name, isImage || isVideo)
        : '';
      const item = {
        value: provider.id + '\n' + id, providerId: provider.id, modelId: id,
        label: provider.name + '@' + name, search: provider.name + ' ' + id + ' ' + name,
        health: health.state, healthTitle: health.title, icon: logo, isImage, isVideo,
      };
      (isVideo ? video : (isImage ? image : chat)).push(item);
    });
  });
  // 后台可排序:供应商顺序(接口按 order 升序下发)与各供应商内的模型顺序(数组原序)原样保留。
  // 不再按名称重排,否则后台调整的供应商顺序在前台会被打乱。
  const groups = [];
  const hasVisual = image.length || video.length;
  if (chat.length) groups.push({ label: hasVisual ? '对话模型' : '', items: chat });
  if (image.length) groups.push({ label: '生图模型', items: image });
  if (video.length) groups.push({ label: '生视频模型', items: video });
  return groups;
}
function togglePinnedSelection(value) {
  const parts = String(value || '').split('\n'); const providerId = parts[0], modelId = parts.slice(1).join('\n');
  if (!providerId || !modelId || !(window.OCUI && window.OCUI.setPref)) return;
  const same = pinnedProviderId() === providerId && pinnedModelId() === modelId;
  window.OCUI.setPref('pinnedProviderId', same ? null : providerId);
  window.OCUI.setPref('pinnedModel', same ? null : modelId);
  toast(same ? '已取消置顶' : '已置顶，新建对话将使用此模型');
  renderModelPicker();
}
const modelPickerEl = $('model-picker');
if (modelPickerEl) {
  modelPickerEl.addEventListener('click', () => {
    const groups = availableModelItems();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (!total) { toast('暂无可用模型', true); return; }
    const selected = state.currentProviderId && state.currentModel ? state.currentProviderId + '\n' + state.currentModel : null;
    OC.openSelect(modelPickerEl, groups, {
      menuClass: 'oc-model-menu',
      fitWidth: true,
      selected,
      pinned: pinnedProviderId() && pinnedModelId() ? pinnedProviderId() + '\n' + pinnedModelId() : null,
      searchable: total > 8,
      searchPlaceholder: '搜索供应商或模型…',
      chips: (state.providers || []).length > 1 ? state.providers.map((p) => ({ value: p.id, label: p.name || p.id, icon: window.OC && OC.providerLogo ? OC.providerLogo(p.models, p.name) : '' })) : null,
      onSelect: async (val, item) => {
        const parts = String(val).split('\n');
        state.currentProviderId = parts[0];
        await loadModels({ prefer: parts.slice(1).join('\n') });
        renderProviderLabel();
        renderModelPicker();
        if (item && (item.isImage || item.isVideo)) enforceImageModelAssistant();
      },
      onPin: (val) => togglePinnedSelection(val),
    });
  });
  modelPickerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modelPickerEl.click(); }
  });
}

// ============ 发送消息 ============
function messageApiContent(m, format) {
  if (m.role === 'user' && m.attachments && m.attachments.length && window.OCMultimodal && window.OCMultimodal.toApiContent) {
    return window.OCMultimodal.toApiContent(m.text != null ? m.text : '', m.attachments, format);
  }
  if (typeof m.content === 'string' || Array.isArray(m.content)) return m.content;
  return '';
}
function flattenApiContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (part.text) return part.text;
    if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}
function chatSystemPrompt(chat) {
  return String((chat && chat.systemPrompt) || '').trim();
}
function contextLimitNow() {
  const site = state.chatLimits || {};
  const cap = Math.min(500, Math.max(2, Number(site.maxContextMessages) || 200));
  const fallback = Math.min(cap, Math.max(2, Number(site.contextMessages) || 40));
  const chosen = Number(uiPref('contextMessages', fallback));
  return Math.min(cap, Math.max(2, isFinite(chosen) ? chosen : fallback));
}
// 粗略 token 估算:中日韩按 1 token/字,其余按 4 字符/token(与服务端同一口径,宁高勿低)
function estimateTextTokens(s) {
  const str = String(s || '');
  if (!str) return 0;
  const cjk = (str.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaf6\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (str.length - cjk) / 4);
}
function estimateMessageTokens(m) {
  let n = estimateTextTokens(flattenApiContent(messageApiContent(m, 'chat')));
  // 图片/文件附件按固定开销计,避免按文本低估
  if (m && Array.isArray(m.attachments)) n += m.attachments.length * 1024;
  return n;
}
function currentModelSpec() {
  if (!state.currentModel) return null;
  return (state.models || []).find((x) => x && x.id === state.currentModel) || null;
}
function outgoingMessages(chatMessages, chat) {
  const msgs = (chatMessages || []).filter((m) => m && m.role !== 'system');
  const limit = contextLimitNow();
  let kept = msgs.length > limit ? msgs.slice(-limit) : msgs;
  // 模型配置了最大上下文时,再做一轮 token 预算裁剪:输入 + 预留输出不超过窗口
  const spec = currentModelSpec();
  const maxCtx = spec && parseInt(spec.maxContext, 10) > 0 ? parseInt(spec.maxContext, 10) : 0;
  if (maxCtx > 0 && kept.length) {
    const outCap = spec && parseInt(spec.maxTokens, 10) > 0 ? parseInt(spec.maxTokens, 10) : (Number((state.chatLimits || {}).maxOutputTokens) || 8192);
    const reserve = Math.min(outCap, Math.max(256, Math.floor(maxCtx / 2)));
    const budget = maxCtx - reserve;
    const sysTokens = estimateTextTokens(chatSystemPrompt(chat));
    const costs = kept.map((m) => estimateMessageTokens(m));
    let total = sysTokens + costs.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (total > budget && drop < kept.length - 1) {
      total -= costs[drop];
      drop++;
    }
    if (drop > 0) kept = kept.slice(drop);
  }
  const prompt = chatSystemPrompt(chat);
  const out = prompt ? [{ role: 'system', content: prompt }].concat(kept) : kept;
  out.contextCount = kept.length;
  out.contextLimit = limit;
  return out;
}
function modelVendor(model) {
  const id = String(model || '').toLowerCase();
  if (/claude|anthropic/.test(id)) return 'anthropic';
  if (/deepseek/.test(id)) return 'deepseek';
  if (/(^|\/|:)(gpt-|o[1-9]|chatgpt)/.test(id) || /openai/.test(id)) return 'openai';
  return '';
}
// 部分模型只支持 effort 档位的子集,直接发界面的档位会被上游整包拒绝。
// 已知限制(匹配模型 ID,不区分供应商;遇到新模型在这里加一行即可):
//   Kimi K3(Nvidia/官方)只接受 low/high/max,没有 medium
//   Grok 3 mini(xAI)只接受 low/high
// 策略与 DeepSeek 一致:就近向上取档(中→高),保留推理强度而不是丢掉参数。
const MODEL_EFFORT_SUPPORT = [
  { test: /kimi-k3|kimi_k3|kimi k3/, levels: ['low', 'high', 'max'] },
  { test: /grok-3-mini/, levels: ['low', 'high'] },
];
function compatEffort(model, effort) {
  const id = String(model || '').toLowerCase();
  if (!effort || effort === 'off') return effort;
  for (const rule of MODEL_EFFORT_SUPPORT) {
    if (!rule.test.test(id) || rule.levels.includes(effort)) continue;
    const order = ['low', 'medium', 'high', 'max'];
    const idx = order.indexOf(effort);
    if (idx < 0) return effort;
    for (let i = idx + 1; i < order.length; i++) if (rule.levels.includes(order[i])) return order[i];
    for (let i = idx - 1; i >= 0; i--) if (rule.levels.includes(order[i])) return order[i];
    return effort;
  }
  return effort;
}
function applyReasoningToBody(body, format) {
  const enabled = reasoningEnabled();
  const vendor = modelVendor(body && body.model);
  const model = String((body && body.model) || '').toLowerCase();
  const effort = compatEffort(model, reasoningEffort());
  const deepseekEffort = effort === 'low' ? 'low' : 'high';
  if (format === 'anthropic') {
    if (!enabled) return body;
    if (vendor === 'deepseek') {
      body.thinking = { type: 'enabled' };
      body.output_config = { effort: deepseekEffort };
      return body;
    }
    if (vendor === 'anthropic' && /claude-(?:opus|sonnet|haiku)-4-6/.test(model)) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: effort };
      return body;
    }
    const budget = effort === 'high' ? 16000 : effort === 'low' ? 2048 : 8000;
    body.thinking = { type: 'enabled', budget_tokens: budget };
    if (!body.max_tokens || body.max_tokens <= budget) body.max_tokens = budget + 2048;
    return body;
  }
  if (format === 'responses') {
    if (!enabled) {
      if (vendor === 'deepseek') body.reasoning = { effort: 'none' };
      return body;
    }
    body.reasoning = { effort: vendor === 'deepseek' ? deepseekEffort : effort };
    if (vendor !== 'deepseek') {
      body.reasoning.summary = 'auto';
      body.include = Array.from(new Set((body.include || []).concat(['reasoning.encrypted_content'])));
    }
    return body;
  }
  if (vendor === 'deepseek') {
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) {
      // DeepSeek 官方映射：界面“中”对应实际 high，不能直接发送 medium/max。
      body.reasoning_effort = deepseekEffort;
    }
    return body;
  }
  if (!enabled) return body;
  // OpenAI Chat Completions and compatible gateways use the top-level field.
  body.reasoning_effort = effort;
  return body;
}
function buildRequestBody(chatMessages, format, chat, extra) {
  const msgs = outgoingMessages(chatMessages, chat);
  const cap = Math.min(128000, Math.max(256, Number((state.chatLimits || {}).maxOutputTokens) || 8192));
  const system = chatSystemPrompt(chat);
  if (format === 'anthropic') {
    const body = {
      model: state.currentModel,
      stream: state.streamToggle,
      max_tokens: cap,
      messages: msgs.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: messageApiContent(m, format),
      })),
    };
    if (system) body.system = system;
    if (state.currentProviderId) body.providerId = state.currentProviderId;
    const readyA = attachWebSearchFlag(applyReasoningToBody(body, format));
    if (!readyA.max_tokens || readyA.max_tokens > cap) readyA.max_tokens = cap;
    return stampContext(readyA, msgs);
  }
  if (format === 'responses') {
    const body = {
      model: state.currentModel,
      stream: state.streamToggle,
      input: msgs.filter((m) => m.role !== 'system').map((m) => {
        const content = messageApiContent(m, format);
        if (Array.isArray(content)) {
          return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
        }
        return content;
      }),
    };
    if (system) body.instructions = system;
    if (state.currentProviderId) body.providerId = state.currentProviderId;
    const readyR = attachWebSearchFlag(applyReasoningToBody(body, format));
    readyR.max_output_tokens = cap;
    return stampContext(readyR, msgs);
  }
  if (format === 'completions') {
    const head = system ? 'System: ' + system + '\n\n' : '';
    const bodyC = attachWebSearchFlag({
      model: state.currentModel,
      stream: state.streamToggle,
      max_tokens: cap,
      prompt: head + msgs.filter((m) => m.role !== 'system').map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + flattenApiContent(messageApiContent(m, format))).join('\n\n'),
    });
    if (state.currentProviderId) bodyC.providerId = state.currentProviderId;
    return stampContext(bodyC, msgs);
  }
  // chat
  const body = applyReasoningToBody({
    model: state.currentModel,
    stream: state.streamToggle,
    messages: msgs.map((m) => ({ role: m.role, content: messageApiContent(m, format) })),
  }, format);
  if (state.currentProviderId) body.providerId = state.currentProviderId;
  const ready = attachWebSearchFlag(body);
  if (!ready.max_tokens || ready.max_tokens > cap) ready.max_tokens = cap;
  if (extra && extra.continueFrom) ready.webSearch = 'off';
  return stampContext(ready, msgs);
}
function stampContext(body, msgs) {
  body._contextCount = msgs.contextCount || 0;
  body._contextLimit = msgs.contextLimit || body._contextCount;
  return body;
}

function attachWebSearchFlag(body) {
  const mode = webSearchMode();
  if (mode === 'on' || mode === 'off') { body.webSearch = mode; state._toolSearch = null; return body; }
  if (mode === 'auto') {
    // 智能:优先用统一 AI 工具判定给出的结果(省一次主模型判定);否则交给后端启发式
    if (state._toolSearch === true || state._toolSearch === false) {
      body.webSearch = state._toolSearch ? 'on' : 'off';
    } else {
      body.webSearch = 'auto';
    }
    state._toolSearch = null;
  }
  return body;
}
function citationsFromResponse(resp) {
  if (!resp || !resp.headers || !resp.headers.get) return [];
  const raw = resp.headers.get('X-Oc-Citations') || resp.headers.get('x-oc-citations');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function applyCitations(assistantMsg, resp) {
  const cites = citationsFromResponse(resp);
  if (cites.length) assistantMsg.citations = cites;
}

function applyFollowUp(q) {
  const text = String(q || '').trim();
  if (!text) return;
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const input = $('input');
  if (!input) return;
  input.value = text;
  autosizeInput();
  updateSendBtn();
  sendMessage();
}
// 对话模型下识别「要画图」意图:出现明确的绘图口令即认为要出图。
// 例:「画一张…」「帮我画个…」「生成一张图」「来张海报」「画个 logo」「draw …」
function wantsDrawImage(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 明显是在「问/讨论」而不是「下命令」时不触发:
  // 以疑问收尾,或含「是什么/为什么/如何/怎么/能不能」等讨论性措辞,或过去式叙述(我画了…)
  if (/[?？]$/.test(t) || /[吗呢]$/.test(t)) return false;
  if (/(是什么|为什么|啥意思|什么意思|如何|怎么|怎样|能不能|可否|可不可以|是不是)/.test(t)) return false;
  // 过去式叙述(我画了/他画了…),但「帮我画/给我画/替我画/为你画」属祈使,不算
  if (/(^|[^帮给替为])(我|他|她|他们|她们)画了?/.test(t)) return false;
  const drawRe = /(画一张|画一幅|画一个|画个|画张|画幅|帮我画|给我画|帮忙画|替我画|画一下|画出来|绘制|重新画|再画|重画|生成图片|生成图像|生成一张|生成一幅|生成个图|生成插画|生成海报|生成头像|生成logo|生成标志|出一张图|出个图|来一张图|来张图|做个图|做一张图|设计一张|设计个logo|设计一个logo)/i;
  if (drawRe.test(t)) return true;
  // 「画 + 数量词 + 对象」:如「画一只柯基」「画两张海报」(已排除疑问/叙述)
  if (/画[一二三四五六七八九十两几]?[只个条张幅匹头朵棵盆群尾轮帧]/.test(t)) return true;
  if (/\b(draw|paint|sketch|illustrate|generate an image|create an image|make an image|generate a picture|create a picture|render an image)\b/i.test(t)) return true;
  return false;
}
// 「编辑已有图片」意图:必须有可用的参考图(本次附件或本会话上一张生成图),且有明确编辑动词。
// 单独的「这张图是什么」这类看图问题不应命中。
function wantsEditImage(text) {
  const t = String(text || '');
  if (!t) return false;
  return /(改成|换成|修改|改一下|改变|调整成|调整一下|变成|变为|去掉|删除掉|删掉|加个|加上|添加|添个|换个|替换成|替换|重新画|再画|重画)/.test(t);
}
// 文本是否明确指代「上一张图」(决定追问是否把它作为参考图)
function refersToPrevImage(text) {
  return /(上面|刚才|上一张|上张|之前|这张图|这张|那张图|那张|这个图|那个图|此图|它)/.test(String(text || ''));
}
// 对话中自动出图的模式:off=关闭 | rough=粗略关键词识别 | auto=智能判定(用统一工具判定模型)
function autoImageMode() {
  const v = String(uiPref('autoImageMode', 'rough') || 'rough').toLowerCase();
  if (v === 'off' || v === 'rough' || v === 'auto' || v === 'ai') return v === 'ai' ? 'auto' : v;
  return 'rough';
}
// 统一的「AI 工具判定」:一次轻量调用判定本次发言需要启用哪些工具/功能。
// ctx: { imageEnabled, searchEnabled, prevImage } → 返回 {draw,edit,search,title}|null(判定失败)。
// 判定模型 = 设置里的「AI 工具判定模型」,未设置则跟随当前对话模型。判定会额外消耗一次调用。
async function aiJudgeTools(text, ctx) {
  ctx = ctx || {};
  const aux = resolveAuxModel('judgeModel');
  const providerId = aux ? aux.providerId : state.currentProviderId;
  const model = aux ? aux.model : state.currentModel;
  const format = aux ? aux.format : providerFormat();
  if (!providerId || !model) return null;
  const wantImage = ctx.imageEnabled !== false;
  const wantSearch = !!ctx.searchEnabled;
  const wantTitle = !!ctx.wantTitle;
  let sys = '你是「AI 助手调度器」。根据用户最新一句话判断这次回答需要启用哪些能力，只输出一个 JSON 对象，不要输出任何解释或多余文字。字段：'
    + '{"search":true|false,"draw":true|false,"edit":true|false'
    + (wantTitle ? ',"title":"简短标题"' : '') + '}。'
    + 'search=需要联网检索最新/实时信息（如新闻、天气、股价、当前时间、近期事件、需查证的事实）；闲聊、写作、代码、翻译、数学等不联网。';
  if (wantImage) {
    sys += 'draw=用户在要求生成一张新图片（如「画一只猫」「生成海报」）；edit=用户在要求修改已有的图片（上下文提供了一张可修改的图片，且用户在要求改它，如「把上面的图换成蓝色」）。'
      + '注意：讨论、提问或解释（如「画一个圆是什么原理」）不算。';
    if (ctx.prevImage) sys += '当前上下文里有一张可供修改的图片。';
    else sys += '当前上下文里没有可修改的图片，edit 一律为 false。';
  } else {
    sys += '本回合不支持生图，draw 与 edit 一律为 false。';
  }
  if (wantTitle) sys += 'title=根据这句话为本次对话起一个简短中文标题（不超过 14 字、不加引号、不用「对话/标题」等字眼）。';
  const user = '用户发言：' + text;
  const body = { model, providerId, stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  try {
    const r = await api(ENDPOINT_BY_FORMAT[format] || ENDPOINT_BY_FORMAT.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const raw = String(extractText(data, format) || '');
    const lower = raw.toLowerCase();
    const val = (k) => {
      const m = lower.match(new RegExp('"' + k + '"\\s*:\\s*(true|false)'));
      return m ? m[1] === 'true' : false;
    };
    let title = '';
    if (wantTitle) {
      const tm = raw.match(/"title"\s*:\s*"([^"]{1,40})"/);
      if (tm) title = tm[1].replace(/^["'「『]+|["'」』。.]+$/g, '').trim().slice(0, 24);
    }
    return { search: val('search'), draw: wantImage && val('draw'), edit: wantImage && val('edit'), title };
  } catch (e) {
    return null;
  }
}

async function sendMessage() {
  if (state.streaming) return;
  const input = $('input');
  const text = input.value.trim();
  const attachments = (state.pendingAttachments || []).slice();
  if (attachments.some((a) => a && a.parsing)) {
    toast('文档还在解析，请稍候', true);
    return;
  }
  if (!text && !attachments.length) return;

  if (!state.user || !state.currentProviderId || !state.currentModel) {
    openAuthModal();
    return;
  }
  if (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0) {
    // 游客额度用尽:引导登录;普通用户则提示充值
    if (state.isGuest) {
      state.isGuestExpired = true;
      showGuestBar();
      openAuthModal('游客体验次数已用完，注册或登录后可继续对话');
    } else {
      toast('剩余次数不足，请联系管理员', true);
    }
    return;
  }

  // 生图模型:纯文本=文生图,带图=图生图,都走生图接口。
  // 之前只处理「带图」的情况,纯文本会被当成普通对话发出去:后端虽然会自动改走生图接口,
  // 但返回的是 {images:[...]} 结构,对话渲染按 choices 取文本取不到,于是表现为「不出图」。
  if (modelIsImage(state.currentModel)) {
    const imageAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 4);
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    await sendImageTurn(text, imageAtts);
    return;
  }

  // 视频模型:纯文本=文生视频,带图=以图为参考生视频,都走视频接口(异步任务)。
  if (modelIsVideo(state.currentModel)) {
    const imageAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 5);
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    await sendVideoTurn(text, imageAtts);
    return;
  }

  // 对话模型下:识别到「画图 / 改图」意图时,自动改用「默认生图模型」出图,
  // 并自动带上上一张生成图或本次附件作参考图(改图)。识别方式由设置决定:
  // off=关闭 | rough=粗略关键词识别 | auto=统一 AI 工具判定(更准,但多一次调用)。
  // 「联网=智能」时也复用同一次判定,避免再用主模型多判一次、也更省 token。
  const aim = autoImageMode();
  {
    const imgAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 4);
    let prevImg = '';
    if (typeof lastImageSourceInChat === 'function') {
      const c = currentChat();
      if (c) prevImg = lastImageSourceInChat(c) || '';
    }
    const hasRef = imgAtts.length > 0 || !!prevImg;
    const hasImageModel = typeof defaultImageModel === 'function' ? !!defaultImageModel() : false;
    const searchReady = typeof webSearchMode === 'function' && webSearchMode() === 'auto';
    // 新对话首条消息且开启了自动命名:让判定顺带给出标题,省去单独一次命名调用
    const curChat = currentChat();
    const isFirstMsg = !!curChat && (!curChat.messages || curChat.messages.length === 0) && autoTitleEnabled();
    // 需要 AI 工具判定的条件:生图设为智能判定,或联网=智能,或需要 AI 命名
    const needJudge = text && ((aim === 'auto' && hasImageModel) || searchReady || isFirstMsg);
    let verdict = null;
    if (needJudge) {
      // 判定期间锁住发送,避免重复触发
      state.streaming = true; updateSendBtn();
      try {
        verdict = await aiJudgeTools(text, { imageEnabled: hasImageModel, searchEnabled: searchReady, prevImage: hasRef, wantTitle: isFirstMsg });
      } finally { state.streaming = false; updateSendBtn(); }
    }
    // 联网:判定成功则按结果显式开关;失败则回退后端启发式(body.webSearch 保持 'auto')
    state._toolSearch = (verdict && searchReady) ? !!verdict.search : null;
    // 判定给出的标题:建对话时先用上(本地截取作为兜底)
    state._judgeTitle = (verdict && verdict.title) ? verdict.title : '';
    let isDraw = false, isEdit = false;
    if (aim !== 'off') {
      if (aim === 'auto' && verdict) {
        isDraw = !!verdict.draw;
        isEdit = !!verdict.edit && hasRef;
      } else {
        // 粗略识别,或「智能判定」失败时回退
        isDraw = wantsDrawImage(text);
        // 改图意图:必须能定位到一张图。附图即视为要改这张图;否则需本会话有上一张生成图,
        // 且文本明确指代它(上面/这张图/它…)。避免把「把这段话改成英文」这类文本编辑误判为改图。
        isEdit = wantsEditImage(text) && (imgAtts.length > 0 || (!!prevImg && refersToPrevImage(text)));
      }
    }
    // 参考图策略:显式编辑或明确指代上一张图时带上;全新绘图默认不带
    const usePrevRef = imgAtts.length === 0 && (isEdit || (isDraw && !!prevImg));
    if (isDraw || isEdit) {
      const target = defaultImageModel();
      if (target) {
        state._toolSearch = null; // 本次改走生图,联网判定结果不适用于后续对话
        input.value = '';
        autosizeInput();
        state.pendingAttachments = [];
        renderAttachments();
        updateSendBtn();
        // 记住用户原本的对话模型,出图后恢复,让用户继续留在对话模型里
        const prevProviderId = state.currentProviderId;
        const prevModel = state.currentModel;
        // 临时切到默认生图模型(仅本次出图,不改变用户的置顶/上次使用偏好)
        state.currentProviderId = target.providerId;
        await loadModels({ prefer: target.modelId });
        state.currentModel = target.modelId;
        renderProviderLabel();
        renderModelPicker();
        const withRef = imgAtts.length > 0 || usePrevRef;
        toast((isEdit ? '识别到改图意图，已用生图模型「' : '识别到绘图意图，已用生图模型「') + (target.label || target.modelId) + '」' + (withRef ? '并带上参考图' : ''));
        try {
          await sendImageTurn(text, imgAtts, { autoRef: usePrevRef });
        } finally {
          // 无论出图成功或失败,都恢复到用户原本的对话模型
          state.currentProviderId = prevProviderId;
          await loadModels({ prefer: prevModel });
          state.currentModel = prevModel;
          renderProviderLabel();
          renderModelPicker();
        }
        return;
      }
    }
  }

  input.value = '';
  autosizeInput();
  state.pendingAttachments = [];
  renderAttachments();
  updateSendBtn();
  // 没有当前会话时自动新建
  let chat = currentChat();
  if (!chat || !chat.id) {
    chat = newChat();
  }
  // 新会话给第一个消息生成标题:优先用统一工具判定已生成的标题(省一次调用),否则本地截取
  if (chat.messages.length === 0 && autoTitleEnabled()) {
    const seed = text || (attachments[0] && attachments[0].name) || '新对话';
    chat.title = (state._judgeTitle && state._judgeTitle.trim()) || window.OCConversations.autoTitle(seed);
    chat._autoTitled = true;
    renderChatList();
  }
  state._judgeTitle = '';

  const displayParts = [];
  if (text) displayParts.push(text);
  if (attachments.length && window.OCMultimodal) {
    attachments.forEach((a) => displayParts.push(window.OCMultimodal.toMarkdown(a)));
  }
  const content = displayParts.join('\n\n') || '（附件）';

  const userMsg = { role: 'user', content, text, attachments, createdAt: Date.now() };
  chat.messages.push(userMsg);
  chat.updatedAt = Date.now();
  saveChats(); renderMessages();

  // 添加 assistant 占位并请求回复
  const assistantMsg = { role: 'assistant', content: '' };
  chat.messages.push(assistantMsg);
  saveChats();
  renderMessages();
  await requestAssistantReply(chat, userMsg);
  await refreshMe();
  refreshModelHealth();
}

// (AI 会话标题已并入统一的「AI 工具判定」:新建对话首条消息时由 aiJudgeTools 顺带生成,省一次调用。)
function providerFormat() {
  const p = state.providers.find((x) => x.id === state.currentProviderId);
  return (p && p.apiFormat) || 'chat';
}

// 流式请求
async function streamRequest(format, body, chat, assistantMsg) {
  state.streaming = true;
  document.documentElement.classList.add('oc-streaming');
  assistantMsg._streaming = true;
  assistantMsg.interrupted = false;
  assistantMsg.createdAt = assistantMsg.createdAt || Date.now();
  assistantMsg._startTime = Date.now();
  $('send-btn').classList.add('hidden');
  $('stop-btn').classList.remove('hidden');
  const ac = new AbortController();
  state.abortController = ac;

  let phaseTimer = null;
  const startPhases = () => {
    const phases = (window.OCReasoning && window.OCReasoning.PHASES) || ['思考中', '整理中', '生成中'];
    let i = 0;
    phaseTimer = setInterval(() => {
      i = (i + 1) % phases.length;
      const label = document.querySelector('#messages .msg.assistant:last-child .phase-text');
      if (label) label.textContent = phases[i];
    }, 2400);
  };

  // 渲染占位（待 AI 回复）
  renderMessages();
  startPhases();

  try {
    const resp = await api(ENDPOINT_BY_FORMAT[format], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
      throw new Error(msg);
    }
    applyCitations(assistantMsg, resp);
    const taskId = resp.headers.get('X-Oc-Task-Id');
    if (taskId) { assistantMsg.taskId = taskId; assistantMsg.taskFormat = resp.headers.get('X-Oc-Task-Format') || format; assistantMsg.taskSeq = 0; assistantMsg.taskStatus = 'running'; saveChats(); }
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      const text = await resp.text();
      const data = JSON.parse(text);
      assistantMsg.content = extractText(data, format);
      const think = extractReasoning(data, format);
      if (think) assistantMsg.reasoning = think;
      absorbThinkTags(assistantMsg, true);
      if (data && data.usage) takeUsage(assistantMsg, data.usage);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      raw += piece;
      if (raw.length > 12000) raw = raw.slice(-12000);
      buffer += piece;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        handleSseChunk(chunk, format, assistantMsg);
        if (assistantMsg.taskId) assistantMsg.taskSeq += 1;
        chat.updatedAt = Date.now();
        scheduleStreamSave();
        updateStreamingText(assistantMsg);
      }
    }
    if (buffer.trim()) { handleSseChunk(buffer, format, assistantMsg); updateStreamingText(assistantMsg); }
    absorbThinkTags(assistantMsg, true);
    updateStreamingText(assistantMsg);
    if (streamEndedEarly(format, raw, assistantMsg)) {
      assistantMsg.interrupted = true;
      noteModelFailure(assistantMsg, '连接中断，已保留已写出的内容');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      assistantMsg.interrupted = true;
    } else {
      throw e;
    }
  } finally {
    if (phaseTimer) clearInterval(phaseTimer);
    cancelStreamPaint();
    assistantMsg._streaming = false;
    if (assistantMsg.taskId) assistantMsg.taskStatus = assistantMsg.interrupted ? 'interrupted' : (assistantMsg.error ? 'failed' : 'completed');
    finalizeReplyTiming(assistantMsg);
    // 完成后仅重绘最后一条 AI 消息（走 Markdown/公式/code 管线），避免全量重绘跳动
    reRenderLastAssistant(assistantMsg);
    initStreamingState();
    // 异步生成 AI 跟进建议（受偏好开关控制,不阻塞主回复）
    if (followUpsEnabled() && assistantMsg.content && !assistantMsg.error) {
      aiFollowUps(assistantMsg.content).then((ups) => {
        if (ups && ups.length && assistantMsg.followUps !== ups) {
          assistantMsg.followUps = ups;
          saveChats();
          reRenderLastAssistant(assistantMsg);
        }
      });
    }
  }
}

// 精准重绘最后一条 assistant 消息（流式结束后调用）
function reRenderLastAssistant(assistantMsg) {
  const chat = currentChat();
  if (!chat) return;
  const idx = (chat.messages || []).indexOf(assistantMsg);
  if (idx < 0) return;
  const last = document.querySelector('#messages .msg.assistant[data-idx="' + idx + '"]');
  if (!last) return;
  const _av = last.querySelector('.msg-avatar');
  if (_av) _av.innerHTML = aiAvatarHtml(assistantMsg.model || state.currentModel || '');
  const contentEl = last.querySelector('.msg-content');
  if (!contentEl) return;
  contentEl.innerHTML = '';
  upsertReasoningPanel(contentEl, assistantMsg, false);
  const root = document.createElement('div');
  contentEl.appendChild(root);
  window.OCRenderer.renderInto(root, assistantMsg.content || '');
  if (window.OCMultimodal && window.OCMultimodal.enhanceArtifactButtons) {
    window.OCMultimodal.enhanceArtifactButtons(root);
  }
  if (window.OCCitations && assistantMsg.citations && assistantMsg.citations.length) {
    window.OCCitations.enhanceCitations(root, assistantMsg.citations);
  }
  // 重新挂载操作栏 + 快捷指令 + 跟进建议
  last.querySelectorAll('.msg-actions, .quick-actions, .follow-ups, .cite-sources').forEach((el) => el.remove());
  if (assistantMsg.content || assistantMsg.reasoning || replyWasInterrupted(assistantMsg)) {
    window.OCMessages.attachActions(last, assistantMsg, {
      onRegenerate: (mm) => regenerateMessage(mm, chat),
      onShare: (mm) => shareMessage(mm),
      onVote: submitMessageVote,
      onQuickAction: quickAction,
      onBranch: (mm) => branchFromMessage(mm, chat),
    });
    if (assistantMsg.followUps && assistantMsg.followUps.length) {
      window.OCMultimodal.renderFollowUps(last, assistantMsg.followUps, applyFollowUp);
    }
    if (assistantMsg.citations && assistantMsg.citations.length && window.OCCitations) {
      window.OCCitations.renderSources(last, assistantMsg.citations);
    }
    // 耗时显示(先清旧再渲染,避免重复叠加)
    if (typeof renderElapsed === 'function') renderElapsed(last, assistantMsg);
  }
  saveChats();
  scrollToBottom();
}

// 流式文本即时更新：已闭合的 Markdown / HTML / 图表马上呈现
let streamPaintAt = 0;
let streamPaintTimer = null;
function cancelStreamPaint() {
  if (streamPaintTimer) {
    clearTimeout(streamPaintTimer);
    streamPaintTimer = null;
  }
}

function paintStreamingText(assistantMsg) {
  if (!assistantMsg || !assistantMsg._streaming) return;
  const msgs = document.querySelectorAll('#messages .msg.assistant:not(.msg-errored)');
  const last = msgs[msgs.length - 1];
  if (!last) return;
  const contentEl = last.querySelector('.msg-content');
  if (!contentEl) return;
  upsertReasoningPanel(contentEl, assistantMsg, true);
  const phase = contentEl.querySelector('.phase-indicator');
  if ((assistantMsg.reasoning || assistantMsg.content) && phase) phase.remove();
  let root = contentEl.querySelector(':scope > .stream-answer');
  if (!assistantMsg.content) {
    if (root) root.remove();
    scrollToBottom();
    return;
  }
  if (!root) {
    root = document.createElement('div');
    root.className = 'stream-answer';
    contentEl.appendChild(root);
  }
  if (window.OCRenderer && window.OCRenderer.renderStreamingInto) {
    window.OCRenderer.renderStreamingInto(root, assistantMsg.content || '');
  } else {
    root.classList.add('stream-inline');
    root.innerHTML = escapeHtml(assistantMsg.content || '') + '<span class="stream-cursor"></span>';
  }
  scrollToBottom();
}
function updateStreamingText(assistantMsg) {
  if (!assistantMsg || !assistantMsg._streaming) return;
  const now = Date.now();
  if (now - streamPaintAt < 80) {
    if (streamPaintTimer) clearTimeout(streamPaintTimer);
    streamPaintTimer = setTimeout(() => {
      streamPaintTimer = null;
      streamPaintAt = Date.now();
      paintStreamingText(assistantMsg);
    }, 80);
    return;
  }
  if (streamPaintTimer) { clearTimeout(streamPaintTimer); streamPaintTimer = null; }
  streamPaintAt = now;
  paintStreamingText(assistantMsg);
}

function appendReasoning(assistantMsg, text) {
  if (!text) return;
  assistantMsg.reasoning = String(assistantMsg.reasoning || '') + text;
}

const THINK_OPEN = /<\s*(?:think|redacted_thinking)\s*>/i;
const THINK_CLOSE = /<\/\s*(?:think|redacted_thinking)\s*>/i;

function absorbThinkTags(assistantMsg, finished) {
  if (!assistantMsg) return;
  const raw = String(assistantMsg.content || '');
  const cursor = Math.min(assistantMsg._thinkCursor || 0, raw.length);
  let pending = String(assistantMsg._thinkHold || '') + raw.slice(cursor);
  assistantMsg._thinkHold = '';
  let visible = raw.slice(0, cursor);
  let guard = 0;
  while (pending && guard++ < 20) {
    if (assistantMsg._inThink) {
      const end = pending.search(THINK_CLOSE);
      if (end < 0) {
        const tail = finished ? 0 : incompleteTagTail(pending, false);
        appendReasoning(assistantMsg, pending.slice(0, pending.length - tail));
        assistantMsg._thinkHold = pending.slice(pending.length - tail);
        pending = '';
        break;
      }
      appendReasoning(assistantMsg, pending.slice(0, end));
      pending = pending.slice(end).replace(THINK_CLOSE, '');
      assistantMsg._inThink = false;
      continue;
    }
    const start = pending.search(THINK_OPEN);
    if (start < 0) {
      const tail = finished ? 0 : incompleteTagTail(pending, true);
      assistantMsg._thinkHold = pending.slice(pending.length - tail);
      visible += pending.slice(0, pending.length - tail);
      pending = '';
      break;
    }
    const open = pending.slice(start).match(THINK_OPEN);
    if (!open) break;
    visible += pending.slice(0, start);
    pending = pending.slice(start + open[0].length);
    assistantMsg._inThink = true;
  }
  assistantMsg.content = visible;
  assistantMsg._thinkCursor = visible.length;
  if (finished) {
    delete assistantMsg._thinkHold;
    delete assistantMsg._thinkCursor;
    delete assistantMsg._inThink;
  }
}

function incompleteTagTail(text, opening) {
  const src = String(text || '');
  const max = opening ? 8 : 22;
  for (let n = Math.min(max, src.length); n > 0; n--) {
    const tail = src.slice(src.length - n);
    if ((opening ? '<think' : '</think').startsWith(tail.toLowerCase()) || (opening ? '<redacted_thinking' : '</redacted_thinking').startsWith(tail.toLowerCase())) {
      return n;
    }
  }
  return 0;
}

function handleSseChunk(chunk, format, assistantMsg) {
  chunk.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let j;
    try { j = JSON.parse(payload); } catch (e) { return; }
    const think = getReasoningDelta(j, format);
    if (think) appendReasoning(assistantMsg, think);
    captureStreamUsage(j, format, assistantMsg);
    const delta = getDelta(j, format);
    if (delta) assistantMsg.content += delta;
  });
  absorbThinkTags(assistantMsg);
}

function captureStreamUsage(j, format, assistantMsg) {
  if (!j || !assistantMsg) return;
  if (j.usage) takeUsage(assistantMsg, j.usage);
  if (j.message && j.message.usage) takeUsage(assistantMsg, j.message.usage);
  if (j.type === 'message_delta' && j.usage) takeUsage(assistantMsg, j.usage);
  if (j.type === 'message_start' && j.message && j.message.usage) takeUsage(assistantMsg, j.message.usage);
  if (j.response && j.response.usage) takeUsage(assistantMsg, j.response.usage);
  if (format === 'responses' && j.usage) takeUsage(assistantMsg, j.usage);
}
function getReasoningDelta(j, format) {
  if (!j) return '';
  if (format === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'thinking_delta') return j.delta.thinking || '';
      if (typeof j.delta.thinking === 'string') return j.delta.thinking;
    }
    return '';
  }
  if (format === 'responses' || (j.type && String(j.type).indexOf('reasoning') >= 0)) {
    if (j.type === 'response.reasoning_text.delta') return j.delta || '';
    if (j.type === 'response.reasoning_summary_text.delta') return j.delta || '';
    if (j.type === 'response.reasoning.delta') {
      if (typeof j.delta === 'string') return j.delta;
      if (j.delta && typeof j.delta.text === 'string') return j.delta.text;
    }
    if (typeof j.reasoning === 'string') return j.reasoning;
  }
  if (j.choices && j.choices[0]) {
    const c = j.choices[0];
    const d = c.delta || c.message || {};
    if (typeof d.reasoning_content === 'string') return d.reasoning_content;
    if (typeof d.reasoning === 'string') return d.reasoning;
    if (d.reasoning && typeof d.reasoning === 'object') return d.reasoning.content || d.reasoning.text || '';
    if (typeof c.reasoning_content === 'string') return c.reasoning_content;
    const fromParts = partsText(d.content, true);
    if (fromParts) return fromParts;
  }
  return '';
}
function getDelta(j, format) {
  if (format === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') return j.delta.text;
    return '';
  }
  if (format === 'responses' || (j.type === 'response.output_text.delta')) {
    if (j.type === 'response.output_text.delta') return j.delta || '';
    if (j.type && String(j.type).includes('output_text')) return j.delta || '';
    return '';
  }
  // chat / completions
  if (j.choices && j.choices[0]) {
    const c = j.choices[0];
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (c.delta && Array.isArray(c.delta.content)) return partsText(c.delta.content, false);
    if (c.delta && typeof c.delta.text === 'string') return c.delta.text;
    if (typeof c.text === 'string') return c.text;
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (c.message && Array.isArray(c.message.content)) return partsText(c.message.content, false);
  }
  return '';
}

function extractText(data, format) {
  if (!data) return '';
  if (format === 'anthropic') {
    if (Array.isArray(data.content)) return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return data.content || '';
  }
  if (format === 'responses') {
    if (data.output_text) return data.output_text;
    if (Array.isArray(data.output)) return data.output.map((o) => (o && o.content && Array.isArray(o.content) ? o.content.map((c) => c.text || '').join('') : '')).join('');
    return '';
  }
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    if (c.message && Array.isArray(c.message.content)) return partsText(c.message.content, false);
    if (c.message && c.message.content) return c.message.content;
    if (c.text) return c.text;
  }
  return data.text || '';
}
function extractReasoning(data, format) {
  if (!data) return '';
  if (format === 'anthropic' && Array.isArray(data.content)) {
    return data.content.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
      .map((b) => b.thinking || b.text || '').join('');
  }
  if (format === 'responses' && Array.isArray(data.output)) {
    return data.output.filter((o) => o && o.type === 'reasoning').map((o) => {
      if (typeof o.summary === 'string') return o.summary;
      if (Array.isArray(o.summary)) return o.summary.map((s) => s.text || '').join('\n');
      if (Array.isArray(o.content)) return o.content.map((c) => c.text || '').join('');
      return o.text || '';
    }).join('\n');
  }
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    const m = c.message || {};
    if (typeof m.reasoning_content === 'string') return m.reasoning_content;
    if (typeof m.reasoning === 'string') return m.reasoning;
    if (m.reasoning && typeof m.reasoning === 'object') return m.reasoning.content || m.reasoning.text || '';
    if (typeof c.reasoning_content === 'string') return c.reasoning_content;
    return partsText(m.content, true) || '';
  }
  return '';
}

function buildMsgNodeUpdate(chat, assistantMsg, errorText) {
  // 已由新渲染管线处理，保留占位兼容
}

// ============ 消息操作 ============
// 重新生成：截断到该条消息，重新请求
function continueMessages(chat, msg) {
  const idx = chat.messages.indexOf(msg);
  const prior = idx >= 0 ? chat.messages.slice(0, idx) : chat.messages.filter((m) => m !== msg);
  const draft = stripInterruptMarks(msg.content);
  const thought = String(msg.reasoning || '').trim();
  const note = [];
  if (thought) note.push('你上次的思考进行到这里，请接着想完并给出回答，不要重复已写过的部分：\n' + thought.slice(-4000));
  if (draft) note.push('你上次的回答写到这里，请从断点接着写完，不要重复：\n' + draft.slice(-4000));
  if (!note.length) return prior;
  return prior.concat([{ role: 'assistant', content: note.join('\n\n') }]);
}

function noteModelFailure(msg, reason) {
  if (!msg) return;
  const model = String(msg.model || state.currentModel || '').trim() || '当前模型';
  const why = String(reason || '请求失败').replace(/^请求失败:\s*/, '').trim();
  msg.failNote = model + '：' + why;
}

async function continueInterrupted(msg, chat) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!msg || !chat) return;
  const model = String(msg.model || state.currentModel || '').trim();
  if (/claude-haiku-4\.5/i.test(model)) {
    toast(model + ' 的通道当前不可用，请换一个模型后再继续', true);
    return;
  }
  msg.content = stripInterruptMarks(msg.content);
  msg.interrupted = false;
  msg.error = false;
  msg.failNote = '';
  msg._continuing = true;
  saveChats();
  renderMessages();
  const lastUser = [...chat.messages.slice(0, chat.messages.indexOf(msg))].reverse().find((m) => m.role === 'user');
  await requestAssistantReply(chat, lastUser || { role: 'user', content: '' }, { continueFrom: msg });
}

async function regenerateMessage(msg, chat) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const idx = chat.messages.indexOf(msg);
  if (idx < 0) return;
  chat.messages = chat.messages.slice(0, idx + 1);
  persistCurrentReplyVersion(msg);
  pushReplyVersion(msg);
  msg.content = '';
  msg.reasoning = '';
  msg.followUps = [];
  msg.citations = [];
  msg.vote = null;
  msg.error = false;
  msg.interrupted = false;
  msg.failNote = '';
  msg.elapsedMs = null;
  msg._startTime = Date.now();
  msg.createdAt = Date.now();
  saveChats();
  renderMessages();
  const lastUser = [...chat.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    await requestAssistantReply(chat, lastUser);
  } else {
    toast('没有可重新生成的用户消息', true);
  }
}

// 编辑用户消息并重新生成
function editAndResend(msg, chat, msgEl) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!chat || !msg) return;
  let idx = msgEl && msgEl.dataset.idx !== undefined ? Number(msgEl.dataset.idx) : -1;
  if (!(idx >= 0) || chat.messages[idx] !== msg) {
    idx = chat.messages.indexOf(msg);
  }
  if (idx < 0) {
    idx = chat.messages.findIndex((m) =>
      m && m.role === 'user' && m.content === msg.content &&
      (!msg.createdAt || m.createdAt === msg.createdAt)
    );
  }
  if (idx < 0) return toast('找不到这条消息', true);
  const target = msgEl || document.querySelector('#messages .msg.user[data-idx="' + idx + '"]');
  if (!target || !window.OCMessages) return;
  window.OCMessages.enterEditMode(target, msg, {
    onSaveEdit: async (newText) => {
      const next = String(newText || '').trim();
      if (!next) return toast('消息不能为空', true);
      msg.content = next;
      if (msg.text !== undefined) msg.text = next;
      chat.messages = chat.messages.slice(0, idx + 1);
      chat.messages.push({ role: 'assistant', content: '' });
      saveChats();
      renderMessages();
      await requestAssistantReply(chat, msg);
    },
    onExitEdit: () => renderMessages(),
  });
}

// 请求一条 AI 回复（通用入口）
async function requestAssistantReply(chat, userMsg, extra) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId || !state.currentModel) {
    toast('请先选择供应商和模型', true);
    return;
  }
  if (!state.user || (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0)) {
    const spent = usageTodayText();
    toast('剩余次数不足' + (spent ? '。' + spent : '') + '，请联系管理员', true);
    renderUsageLedger();
    return;
  }
  // 若消息列表尾部无 assistant 占位则补一个
  let assistantMsg = chat.messages[chat.messages.length - 1];
  if (!assistantMsg || assistantMsg.role !== 'assistant') {
    assistantMsg = { role: 'assistant', content: '' };
    chat.messages.push(assistantMsg);
  }
  // 记录本次回答所用的模型/供应商:消息头像按此匹配厂商 logo
  assistantMsg.model = state.currentModel;
  assistantMsg.providerId = state.currentProviderId;
  saveChats();
  const format = providerFormat();
  state.streamToggle = streamEnabled();
  assistantMsg._startTime = Date.now();
  const continuing = !!(extra && extra.continueFrom === assistantMsg);
  const source = continuing
    ? continueMessages(chat, assistantMsg)
    : chat.messages.filter((m) => {
      if (!m || m.error || m.content === undefined) return false;
      if (m === assistantMsg && !String(m.content || '').trim()) return false;
      return true;
    });
  const body = buildRequestBody(source, format, chat, continuing ? { continueFrom: assistantMsg } : null);
  assistantMsg.contextCount = body._contextCount || 0;
  assistantMsg.contextLimit = body._contextLimit || assistantMsg.contextCount;
  delete body._contextCount;
  delete body._contextLimit;
  try {
    if (state.streamToggle) {
      await streamRequest(format, body, chat, assistantMsg);
    } else {
      assistantMsg._streaming = true;
      renderMessages();
      const r = await api(ENDPOINT_BY_FORMAT[format], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
      applyCitations(assistantMsg, r);
      assistantMsg.content = extractText(data, format);
      const think = extractReasoning(data, format);
      if (think) assistantMsg.reasoning = think;
      absorbThinkTags(assistantMsg, true);
      if (data && data.usage) takeUsage(assistantMsg, data.usage);
      assistantMsg.followUps = await aiFollowUps(assistantMsg.content);
      refreshMe();
    }
  } catch (e) {
    const kept = stripInterruptMarks(assistantMsg.content);
    assistantMsg.content = kept;
    assistantMsg.error = true;
    assistantMsg.interrupted = true;
    noteModelFailure(assistantMsg, (e && e.message) || '请求失败');
    if (!kept && !assistantMsg.reasoning) assistantMsg.content = assistantMsg.failNote + '（本次请求未扣费）';
  } finally {
    cancelStreamPaint();
    assistantMsg._streaming = false;
    if (assistantMsg.taskId) assistantMsg.taskStatus = assistantMsg.interrupted ? 'interrupted' : (assistantMsg.error ? 'failed' : 'completed');
    finalizeReplyTiming(assistantMsg);
    if (assistantMsg.error) {
      persistCurrentReplyVersion(assistantMsg);
      renderMessages();
    } else {
      persistCurrentReplyVersion(assistantMsg);
      reRenderLastAssistant(assistantMsg);
    }
    saveChats();
    initStreamingState();
  }
  await refreshMe();
  refreshModelHealth();
}

function availableModels() {
  const out = [];
  (state.providers || []).forEach((p) => {
    const models = Array.isArray(p.models) ? p.models : [];
    models.forEach((m) => {
      const id = typeof m === 'string' ? m : (m && (m.id || m.name));
      if (!id) return;
      out.push({ providerId: p.id, provider: p.name || '供应商', model: String(id) });
    });
  });
  return out;
}

function openReaskDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const chat = currentChat();
  const messages = ((chat && chat.messages) || []).map((m, i) => ({ m, i })).filter((x) => {
    return x.m && x.m.role !== 'system' && !x.m.error && String(stripInterruptMarks(x.m.content)).trim();
  });
  if (!messages.length) return toast('当前对话没有可重答的消息', true);
  const models = availableModels();
  if (!models.length) return toast('没有可选的模型', true);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  // 自定义下拉的候选项(替代原生 select)
  const reaskItems = models.map((item) => ({
    value: item.providerId + '\n' + item.model,
    label: item.provider + '@' + item.model,
  }));
  const cur = models.find((item) => item.providerId === state.currentProviderId && item.model === state.currentModel) || models[0];
  const curValue = cur ? cur.providerId + '\n' + cur.model : '';
  const rows = messages.map((x) => {
    const text = stripInterruptMarks(x.m.content).replace(/\s+/g, ' ');
    const who = x.m.role === 'user' ? '用户' : 'AI';
    return '<label class="reask-row"><input type="checkbox" data-idx="' + x.i + '" checked>'
      + '<span><b>' + who + '</b> ' + escapeHtml(text.slice(0, 120)) + '</span></label>';
  }).join('');
  mask.innerHTML = '<div class="modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>换模型重答</h3>'
    + '<button class="icon-btn" data-act="close" aria-label="关闭">' + (window.OC ? window.OC.icon('close', 16) : '×') + '</button></div>'
    + '<div class="modal-body">'
    + '<div class="field"><span>用这个模型重新回答</span>'
    + selectBoxHtml('reask-model', cur ? cur.provider + '@' + cur.model : '请选择模型', curValue) + '</div>'
    + '<div class="reask-list">' + rows + '</div>'
    + '<div class="form-actions"><button class="btn primary" data-act="go" type="button">生成新回答</button></div>'
    + '</div></div>';
  document.body.appendChild(mask);
  const close = () => {
    if (window.OCUI) window.OCUI.closeModal(mask);
    else mask.remove();
    setTimeout(() => mask.remove(), 360);
  };
  const reaskBox = mask.querySelector('#reask-model');
  bindModalSelect(reaskBox, reaskItems);
  mask.addEventListener('click', async (e) => {
    if (e.target === mask || e.target.closest('[data-act="close"]')) return close();
    if (!e.target.closest('[data-act="go"]')) return;
    const picked = Array.from(mask.querySelectorAll('.reask-row input:checked')).map((el) => Number(el.dataset.idx));
    if (!picked.length) return toast('请至少勾选一条消息', true);
    const chosen = String(reaskBox ? (reaskBox.getAttribute('data-value') || '') : '').split('\n');
    const providerId = chosen[0] || '';
    const model = chosen[1] || '';
    if (!providerId || !model) return toast('请选择模型', true);
    close();
    await reaskWithModel(chat, picked, providerId, model);
  });
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask);
  else mask.classList.add('show');
}

async function reaskWithModel(chat, indexes, providerId, model) {
  if (!chat || state.streaming) return;
  const picked = indexes.map((i) => chat.messages[i]).filter((m) => m && String(stripInterruptMarks(m.content)).trim());
  if (!picked.length) return toast('没有可重答的消息', true);
  const prevProvider = state.currentProviderId;
  const prevModel = state.currentModel;
  state.currentProviderId = providerId;
  state.currentModel = model;
  const seed = picked.map((m) => (m.role === 'user' ? '用户' : 'AI') + '：' + stripInterruptMarks(m.content)).join('\n\n');
  const userMsg = {
    role: 'user',
    content: '请根据下面挑出的对话，用你自己的话重新回答最后一个问题。不要复述挑选说明。\n\n' + seed.slice(0, 12000),
    createdAt: Date.now(),
  };
  chat.messages.push(userMsg);
  chat.messages.push({ role: 'assistant', content: '', model: model });
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
  try {
    await requestAssistantReply(chat, userMsg);
  } finally {
    state.currentProviderId = prevProvider;
    state.currentModel = prevModel;
    if (typeof renderModelPicker === 'function') renderModelPicker();
  }
}

function shareableMessages(chat) {
  return ((chat && chat.messages) || []).filter((m) => m && m.role !== 'system' && !m.error && String(m.content || '').trim()).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content || ''),
  }));
}

function showShareLinkModal(url) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal modal-sm" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>分享对话</h3>'
    + '<button class="icon-btn" data-act="close" aria-label="关闭">' + (window.OC ? window.OC.icon('close', 16) : '×') + '</button></div>'
    + '<div class="modal-body">'
    + '<p class="confirm-message">已生成公开链接，任何人打开即可查看这份对话快照。</p>'
    + '<div class="share-link-row">'
    + '<input id="share-link-input" type="text" readonly value="' + escapeHtml(url) + '">'
    + '<button class="btn primary" data-act="copy">复制</button>'
    + '</div>'
    + '<p class="share-link-hint">链接指向生成时的内容，之后修改对话不会同步。</p>'
    + '</div></div>';
  document.body.appendChild(mask);
  const input = mask.querySelector('#share-link-input');
  const close = () => {
    if (window.OCUI) window.OCUI.closeModal(mask);
    else mask.remove();
    setTimeout(() => mask.remove(), 360);
  };
  const copyLink = async () => {
    const ok = window.OCUI ? await window.OCUI.copyText(url) : false;
    if (ok) toast('链接已复制');
    else if (input) { input.focus(); input.select(); toast('请手动复制链接'); }
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-act="close"]')) return close();
    if (e.target.closest('[data-act="copy"]')) copyLink();
  });
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask);
  else mask.classList.add('show');
  if (input) { input.focus(); input.select(); }
  copyLink();
}

async function shareConversation(chat) {
  const target = chat || currentChat();
  const messages = shareableMessages(target);
  if (!messages.length) return toast('当前对话为空，无法分享', true);
  try {
    const r = await api('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: (target && target.title) || '未命名对话', messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || '分享失败');
    const path = data.url || (data.share && data.share.id ? '/s/' + data.share.id : '');
    if (!path) throw new Error('未返回分享链接');
    showShareLinkModal(location.origin + path);
  } catch (e) {
    toast(e.message || '分享失败', true);
  }
}

function shareMessage() {
  shareConversation(currentChat());
}

// 快捷指令
function submitMessageVote(msg) {
  persistCurrentReplyVersion(msg);
  saveChats();
  const model = String((msg && msg.model) || state.currentModel || '').trim();
  if (!model) {
    toast('这条回复没有模型记录，无法计入统计', true);
    return;
  }
  const from = msg._voteSent || null;
  const to = msg.vote || null;
  if (from === to) return;
  msg._voteSent = to;
  api('/api/votes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, from, to }),
  }).then(async (r) => {
    if (r.ok) return;
    msg.vote = from;
    msg._voteSent = from;
    persistCurrentReplyVersion(msg);
    saveChats();
    renderMessages();
    toast('评价没有保存', true);
  }).catch(() => {
    msg.vote = from;
    msg._voteSent = from;
    persistCurrentReplyVersion(msg);
    saveChats();
    renderMessages();
    toast('评价没有保存', true);
  });
}

function quickAction(action) {
  const templates = {
    continue: '请继续刚才的内容，接着上次的结尾继续生成。',
    summarize: '请用 3-5 句话简要总结以上内容。',
    expand: '请对以上内容进行详细扩展说明，补充背景和细节。',
    extract: '请从以上内容中提取要点，用列表形式列出。',
  };
  const prompt = templates[action] || templates.summarize;
  const input = $('input');
  input.value = prompt;
  autosizeInput();
  // 程序化填入不会触发 input 事件,手动刷新发送按钮状态
  updateSendBtn();
  input.focus();
}

// 跟进建议（简单启发式：根据回复内容生成 3-4 个问题）
function suggestFollowUps(content) {
  if (!content) return [];
  const text = content.trim();
  if (text.length < 20) return [];
  const list = [];
  if (text.includes('总结')) list.push('请把上面的内容整理成表格');
  if (/代码|function|def |class |const /.test(text)) list.push('请解释一下上面代码的关键逻辑');
  if (/\d+%|提升|增长|对比|差距/.test(text)) list.push('这个结论的数据依据是什么？');
  if (text.length > 200) list.push('能否给出一个更简洁的版本？');
  list.push('有哪些可能的问题或局限需要注意？');
  return list.slice(0, 4);
}

// 用 AI 生成跟进建议（失败时降级为启发式）
async function aiFollowUps(content) {
  // 可在设置 → 对话里指定「跟进建议模型」;未指定(或指定模型已不可用)时跟随当前对话模型
  const aux = resolveAuxModel('followupsModel');
  const providerId = aux ? aux.providerId : state.currentProviderId;
  const model = aux ? aux.model : state.currentModel;
  const format = aux ? aux.format : providerFormat();
  if (!content || !providerId || !model) return suggestFollowUps(content);
  try {
    const body = {
      model,
      stream: false,
      providerId,
      messages: [
        { role: 'system', content: '你是对话助手。根据用户与 AI 的最后一条回复，生成 3 个简短、自然的追问建议。只输出 3 个短句，每行一个，不要编号，不要引号。' },
        { role: 'user', content: '最后回复内容：\n' + content.slice(0, 3000) },
      ],
    };
    const r = await api(ENDPOINT_BY_FORMAT[format] || ENDPOINT_BY_FORMAT.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return suggestFollowUps(content);
    const data = await r.json();
    const text = extractText(data, format) || '';
    const lines = text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter((l) => l && l.length < 50);
    return lines.slice(0, 3).length >= 1 ? lines.slice(0, 3) : suggestFollowUps(content);
  } catch (e) {
    return suggestFollowUps(content);
  }
}

function stopStreaming() {
  cancelStreamPaint();
  const chat = currentChat();
  const pending = chat && [...(chat.messages || [])].reverse().find((m) => m && m.role === 'assistant' && m.taskId && m.taskStatus === 'running');
  if (pending) { pending.taskStatus = 'cancelled'; api('/api/proxy/tasks/' + encodeURIComponent(pending.taskId) + '/cancel', { method: 'POST' }).catch(() => {}); }
  if (state.abortController) state.abortController.abort();
  state.abortController = null;
  state.streaming = false;
  document.documentElement.classList.remove('oc-streaming');
  $('stop-btn').classList.add('hidden');
  $('send-btn').classList.remove('hidden');
  saveChats();
}

function initStreamingState() {
  state.streaming = false;
  document.documentElement.classList.remove('oc-streaming');
  state.abortController = null;
  $('stop-btn').classList.add('hidden');
  $('send-btn').classList.remove('hidden');
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

// ============ 用户 / 时长 ============
async function refreshModelHealth() {
  if (!state.currentProviderId) return;
  try {
    const r = await api('/api/proxy/models?provider=' + encodeURIComponent(state.currentProviderId));
    const data = await r.json();
    if (!r.ok) return;
    state.modelHealth = data.health && typeof data.health === 'object' ? data.health : {};
    renderModelPicker();
  } catch (e) {}
}
function planPriceInfo(p) {
  // 优先用数字价格;老数据没有 price 时回退到 priceLabel 文本
  if (p.price !== null && p.price !== undefined && p.price !== '') {
    const n = parseFloat(p.price);
    if (n === 0) return { free: true, text: '0 元', unit: '直接到账' };
    return { free: false, text: '¥' + n, unit: '一次性' };
  }
  return { free: false, text: p.priceLabel || '', unit: '' };
}

async function loadAccountPackages() {
  const box = $('plan-packages'); if (!box) return;
  try {
    const r = await api('/api/packages'); const d = await r.json(); if (!r.ok) return;
    const pkgs = d.packages || [];
    if (!pkgs.length) { box.innerHTML = '<span class="muted small">暂无套餐，请联系管理员。</span>'; return; }
    box.innerHTML = '<div class="plan-grid">' + pkgs.map((p) => {
      const price = planPriceInfo(p);
      const validity = (p.validityDays && p.validityDays > 0) ? p.validityDays + ' 天有效' : '永久有效';
      const quotaTxt = p.quota === -1 ? '无限次对话' : p.quota + ' 次对话';
      const limit = (p.limitPerUser != null) ? parseInt(p.limitPerUser, 10) : 1;
      const claimedN = Number(p.claimedCount) || 0;
      let action;
      if (price.free) {
        if (state.isGuest) {
          // 游客仅享有体验轮数,不参与套餐领取(与后端一致)
          action = '<button class="btn small plan-tile-btn" disabled>注册后可领取</button>';
        } else if (p.claimed || (limit === 0)) {
          action = '<button class="btn small plan-tile-btn" disabled>' + (limit === 0 ? '暂不可领取' : '已达领取上限') + '</button>';
        } else {
          action = '<button class="btn small primary plan-tile-btn" data-claim="' + escapeHtml(p.id) + '">立即领取</button>';
        }
      } else if (p.purchaseUrl) {
        action = '<a class="btn small primary plan-tile-btn" href="' + escapeHtml(p.purchaseUrl) + '" target="_blank" rel="noopener">前往购买</a>';
      } else {
        action = '<button class="btn small plan-tile-btn" disabled>请用兑换码兑换</button>';
      }
      let statsLine = '<span>' + escapeHtml(quotaTxt) + '</span><span class="plan-tile-dot">·</span><span>' + escapeHtml(validity) + '</span>';
      if (price.free && limit !== -1) {
        statsLine += '<span class="plan-tile-dot">·</span><span>剩余 ' + Math.max(0, limit - claimedN) + ' 次领取机会</span>';
      }
      return '<div class="plan-tile' + (price.free ? ' plan-tile-free' : '') + '">'
        + '<div class="plan-tile-head"><span class="plan-tile-name">' + escapeHtml(p.name) + '</span>'
        + (price.free ? '<span class="plan-tile-tag">限时免费</span>' : '') + '</div>'
        + '<div class="plan-tile-price"><span class="plan-tile-amount">' + escapeHtml(price.text || '—') + '</span>'
        + (price.unit ? '<span class="plan-tile-unit">' + escapeHtml(price.unit) + '</span>' : '') + '</div>'
        + '<div class="plan-tile-stats">' + statsLine + '</div>'
        + (p.description ? '<p class="plan-tile-desc">' + escapeHtml(p.description) + '</p>' : '')
        + '<div class="plan-tile-foot">' + action + '</div>'
        + '</div>';
    }).join('') + '</div>';
    box.querySelectorAll('[data-claim]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r2 = await api('/api/packages/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: btn.dataset.claim }) });
        const d2 = await r2.json();
        if (!r2.ok) { toast((d2.error && d2.error.message) || '领取失败', true); btn.disabled = false; return; }
        if (d2.user) { state.user = d2.user; renderUser(); renderAccountPanel(); renderUsageLedger(); }
        toast('领取成功，额度已到账');
        loadAccountPackages();
      } catch (e) { btn.disabled = false; toast('网络错误，请重试', true); }
    }));
  } catch (e) {}
}
async function resumeTaskMessage(chat, message) {
  if (!message || !message.taskId || message.taskStatus === 'completed' || message.taskStatus === 'cancelled') return;
  const format = message.taskFormat || providerFormat();
  // Keep the existing partial until the first replay event succeeds.
  const oldContent = message.content || '';
  const oldReasoning = message.reasoning || '';
  const oldSeq = Number(message.taskSeq) || 0;
  message._streaming = true;
  let replayBuffer = '';
  let active = true;
  while (active && message.taskId) {
    try {
      const r = await api('/api/proxy/tasks/' + encodeURIComponent(message.taskId) + '/events?after=' + (Number(message.taskSeq) || 0));
      const d = await r.json();
      if (!r.ok) {
        message.content = oldContent; message.reasoning = oldReasoning; message._streaming = false; message.interrupted = true; message.taskStatus = 'failed'; saveChats(); reRenderLastAssistant(message); break;
      }
      for (const event of (d.events || [])) {
        if (Number(event.seq) <= (Number(message.taskSeq) || 0)) continue;
        replayBuffer += event.data || '';
        let cut;
        while ((cut = replayBuffer.indexOf('\n\n')) >= 0) {
          const frame = replayBuffer.slice(0, cut + 2);
          replayBuffer = replayBuffer.slice(cut + 2);
          handleSseChunk(frame, format, message);
        }
        message.taskSeq = Number(event.seq);
        updateStreamingText(message);
      }
      message.taskStatus = d.status || 'running';
      saveChats();
      if (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') {
        if (replayBuffer.trim()) { handleSseChunk(replayBuffer, format, message); replayBuffer = ''; }
        message._streaming = false;
        if (d.status !== 'completed') message.interrupted = true;
        absorbThinkTags(message, true);
        reRenderLastAssistant(message);
        saveChats();
        active = false;
      } else await new Promise((resolve) => setTimeout(resolve, 900));
    } catch (e) {
      message.content = oldContent; message.reasoning = oldReasoning; message._streaming = false; message.interrupted = true; message.taskStatus = 'failed'; saveChats(); reRenderLastAssistant(message); active = false;
    }
  }
}
function resumePendingTasks() {
  const chat = currentChat();
  if (!chat) return;
  (chat.messages || []).filter((m) => m && m.role === 'assistant' && m.taskId && m.taskStatus === 'running').forEach((m) => resumeTaskMessage(chat, m));
}

async function refreshMe() {
  try {
    const r = await api('/api/auth/me');
    const data = await r.json();
    if (r.ok) {
      state.user = data.user;
      state.usage = Array.isArray(data.usage) ? data.usage : [];
      renderUser();
      renderUsageLedger();
      loadAccountPackages();
    }
  } catch (e) {}
}
function renderUser() {
  if (!state.user) return;
  fillLogoAvatar($('user-avatar'));
  $('user-name').textContent = state.user.name;
  const quotaEl = $('user-quota');
  quotaEl.textContent = '剩余次数: ' + (quotaIsUnlimited(state.user.quota) ? '无限' : state.user.quota);
quotaEl.classList.toggle('low', !quotaIsUnlimited(state.user.quota) && state.user.quota <= 5);
  const tip = usageTodayText();
  quotaEl.title = tip || '剩余可用次数';
  $('admin-link').hidden = !state.user.admin;
  $('admin-link').classList.toggle('hidden', !state.user.admin);
}
function usageTodayText() {
  const today = new Date().toISOString().slice(0, 10);
  const row = (state.usage || []).find((x) => x && x.day === today);
  if (!row || !(row.calls > 0)) return '';
  const models = (row.models || []).slice(0, 3).map((m) => m.model + ' ' + m.calls + ' 次').join('，');
  return '今日已用 ' + row.calls + ' 次' + (models ? '（' + models + '）' : '');
}
function renderUsageLedger() {
  const box = $('acc-usage');
  if (!box) return;
  const rows = state.usage || [];
  if (!rows.length) {
    box.innerHTML = '<p class="muted small">近 14 天还没有用量记录。</p>';
    return;
  }
  // 注意:-1 表示无限额度,不能当作「已用完」(此前误把 -1 <= 0 判为耗尽)
  const unlimited = state.user ? quotaIsUnlimited(state.user.quota) : false;
  const left = state.user ? state.user.quota : 0;
  const head = unlimited
    ? '<p class="muted small">近 14 天按模型和日期的消耗。您当前为无限额度。</p>'
    : (left <= 0
      ? '<p class="usage-empty">剩余次数已用完。近 14 天的消耗如下，需要管理员充值后才能继续。</p>'
      : '<p class="muted small">近 14 天按模型和日期的消耗。今天剩余 ' + left + ' 次。</p>');
  box.innerHTML = head + rows.map((row) => {
    const models = (row.models || []).map((m) => escapeHtml(m.model) + ' ' + (m.calls || 0) + ' 次').join('，');
    return '<div class="usage-row"><span class="usage-name">' + escapeHtml(String(row.day || '').slice(5)) + '</span>'
      + '<span class="usage-sum">' + (row.calls || 0) + ' 次 · ' + (row.cost || 0) + ' 额度</span>'
      + '<span class="usage-models muted small">' + (models || '') + '</span></div>';
  }).join('');
}

// ============ 用量页:消耗总结 + 使用日志 ============
const USAGE2_PAGE_SIZE = 20;
let usage2Limit = USAGE2_PAGE_SIZE;
function collectUsageEntries() {
  const entries = [];
  (state.chats || []).forEach((c) => (c.messages || []).forEach((m) => {
    if (!m || m.role !== 'assistant' || m._streaming) return;
    const model = String(m.model || '').trim();
    if (!model) return;
    entries.push({
      t: Number(m.createdAt) || 0,
      model,
      usage: (m.usage && typeof m.usage === 'object') ? m.usage : null,
      error: !!m.error,
      interrupted: replyWasInterrupted(m),
    });
  }));
  entries.sort((a, b) => b.t - a.t);
  return entries;
}
function renderUsagePanel() {
  const sumBox = $('usage2-summary');
  if (!sumBox) return;
  const entries = collectUsageEntries();
  const byModel = new Map();
  let totPrompt = 0, totCompletion = 0, totErr = 0;
  entries.forEach((e) => {
    if (e.error) totErr++;
    const cell = byModel.get(e.model) || { calls: 0, prompt: 0, completion: 0, errors: 0 };
    cell.calls++;
    if (e.error) cell.errors++;
    if (e.usage) {
      totPrompt += e.usage.prompt || 0;
      totCompletion += e.usage.completion || 0;
      cell.prompt += e.usage.prompt || 0;
      cell.completion += e.usage.completion || 0;
    }
    byModel.set(e.model, cell);
  });
  const headNote = $('usage2-head-note');
  if (headNote) headNote.textContent = '统计来自服务器台账，清空对话不影响；下方日志为本机对话明细。';
  // 台账口径(服务器记录,清空对话不影响):全部调用 = 生命周期计数;近 14 天/Tokens/模型分布 = 近 14 天台账
  const rows = state.usage || [];
  let calls14 = 0, cost14 = 0, prompt14 = 0, completion14 = 0;
  const modelMap = new Map();
  rows.forEach((r) => {
    calls14 += Number(r.calls) || 0;
    cost14 += Number(r.cost) || 0;
    prompt14 += Number(r.prompt) || 0;
    completion14 += Number(r.completion) || 0;
    (r.models || []).forEach((m) => {
      const key = m.model || '未知模型';
      const cell = modelMap.get(key) || { calls: 0, prompt: 0, completion: 0 };
      cell.calls += Number(m.calls) || 0;
      cell.prompt += Number(m.prompt) || 0;
      cell.completion += Number(m.completion) || 0;
      modelMap.set(key, cell);
    });
  });
  if (!entries.length && !calls14) {
    sumBox.innerHTML = '<span class="muted small">还没有调用记录。</span>';
  } else {
    const models = [...modelMap.entries()].sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion));
    const maxCalls = Math.max.apply(null, models.map(([, c]) => c.calls));
    const lifetimeCalls = (state.user && Number(state.user.totalCalls) > 0) ? Number(state.user.totalCalls) : entries.length;
    const stat = (label, value, sub, accent) => '<div class="usage-stat' + (accent ? ' usage-stat-accent' : '') + '">'
      + '<span class="usage-stat-label">' + label + '</span>'
      + '<span class="usage-stat-value">' + value + '</span>'
      + (sub ? '<span class="usage-stat-sub">' + sub + '</span>' : '')
      + '</div>';
    sumBox.innerHTML = '<div class="usage-cards">'
      + stat('全部调用', lifetimeCalls, '成功调用 · 服务器台账', true)
      + stat('近 14 天调用', calls14, '平台计费 ' + cost14 + ' 额度')
      + stat('总 Tokens（14 天）', formatTokenCount(prompt14 + completion14), '↑ ' + formatTokenCount(prompt14) + ' · ↓ ' + formatTokenCount(completion14))
      + stat('涉及模型', modelMap.size, '按下方占比分布')
      + '</div>'
      + (models.length ? '<div class="usage-model-grid">' + models.map(([model, c]) => {
        const pct = maxCalls ? Math.round((c.calls / maxCalls) * 100) : 0;
        return '<div class="usage-model-card">'
          + '<div class="usage-model-name" title="' + escapeHtml(model) + '">' + escapeHtml(model) + '</div>'
          + '<div class="share-bar"><span style="width:' + pct + '%"></span></div>'
          + '<div class="usage-model-meta"><span>' + c.calls + ' 次</span>'
          + '<span class="usage-model-tokens">↑ ' + formatTokenCount(c.prompt) + ' · ↓ ' + formatTokenCount(c.completion) + '</span></div>'
          + '</div>';
      }).join('') + '</div>' : '');
  }
  const listBox = $('usage2-log');
  if (listBox) {
    const shown = entries.slice(0, usage2Limit);
    if (!shown.length) {
      listBox.innerHTML = '<span class="muted small">还没有使用记录。</span>';
    } else {
      listBox.innerHTML = shown.map((e) => {
        const d = new Date(e.t);
        const p = (v) => String(v).padStart(2, '0');
        const when = isNaN(d.getTime()) ? '-' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        const tokens = e.usage ? '↑ ' + formatTokenCount(e.usage.prompt || 0) + ' · ↓ ' + formatTokenCount(e.usage.completion || 0) : '<span class="muted">tokens 未知</span>';
        const flag = e.error ? ' <span class="reply-flag">失败</span>' : (e.interrupted ? ' <span class="muted small">中断</span>' : '');
        return '<div class="row-between"><span style="min-width:0">' + escapeHtml(e.model) + flag
          + '<br><span class="muted small">' + when + '</span></span>'
          + '<span style="white-space:nowrap">' + tokens + '</span></div>';
      }).join('');
    }
    const note = $('usage2-log-note');
    if (note) note.textContent = '已显示 ' + shown.length + ' / ' + entries.length + ' 条';
    const more = $('usage2-more');
    if (more) more.classList.toggle('hidden', entries.length <= usage2Limit);
  }
}
const usage2MoreBtn = $('usage2-more');
if (usage2MoreBtn) usage2MoreBtn.addEventListener('click', () => { usage2Limit += USAGE2_PAGE_SIZE; renderUsagePanel(); });

function logout() {
  // 关闭账户菜单,再清除登录状态
  const menu = $('user-menu');
  if (menu) menu.classList.add('hidden');
  const chip = $('account-chip');
  if (chip) { chip.classList.remove('menu-open'); chip.setAttribute('aria-expanded', 'false'); }
  localStorage.removeItem('oc_token');
  localStorage.removeItem('oc_user');
  location.href = apiUrl('/login');
}

// ============ 主题切换(委托 OCUI 统一管理;ui.js 未加载时走旧逻辑) ============
function applyTheme(t) {
  if (window.OCUI) { window.OCUI.applyTheme(t); return; }
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('oc_theme', t);
  const hljsLink = document.getElementById('hljs-theme');
  const resolved = t === 'dark' ? 'dark' : 'light';
  if (hljsLink) {
    hljsLink.setAttribute('href', window.API_BASE + '/vendor/highlight/' + (resolved === 'dark' ? 'github-dark.min.css' : 'github.min.css'));
  }
  if (window.OCRenderer && typeof window.OCRenderer.syncMermaidTheme === 'function') {
    window.OCRenderer.syncMermaidTheme();
  }
}
function initTheme() {
  if (window.OCUI) { window.OCUI.initTheme(); return; }
  const saved = localStorage.getItem('oc_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}
$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur);
});

// ============ 设置弹窗与账户菜单 ============
const accountChip = $('account-chip');
const userMenu = $('user-menu');
if (accountChip && userMenu) {
  accountChip.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = userMenu.classList.toggle('hidden');
    accountChip.classList.toggle('menu-open', !open);
    accountChip.setAttribute('aria-expanded', String(!open));
  });
  userMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!userMenu.classList.contains('hidden')) {
      userMenu.classList.add('hidden');
      accountChip.classList.remove('menu-open');
      accountChip.setAttribute('aria-expanded', 'false');
    }
  });
}
function closeUserMenu() {
  if (!userMenu || !accountChip) return;
  userMenu.classList.add('hidden');
  accountChip.classList.remove('menu-open');
  accountChip.setAttribute('aria-expanded', 'false');
}
$('user-menu-settings').addEventListener('click', () => {
  closeUserMenu();
  openSettings();
});
const githubLink = $('user-menu-github');
if (githubLink) githubLink.addEventListener('click', () => closeUserMenu());
const announceMenuBtn = $('user-menu-announce');
if (announceMenuBtn) announceMenuBtn.addEventListener('click', () => {
  closeUserMenu();
  if (window.OCShowAnnouncement) window.OCShowAnnouncement();
});
const modal = $('settings-modal');
function openSettings(tab) {
  // 每次打开都从干净状态开始:上次生成的密钥明文不再保留在 DOM 中
  if (typeof resetApiKeySecret === 'function') resetApiKeySecret();
  if (window.OCUI && window.OCUI.openModal) {
    window.OCUI.openModal(modal);
  } else {
    modal.classList.remove('hidden');
    modal.classList.add('show');
  }
  // 渲染各面板内容(供应商/账户/偏好)
  try { renderProviderList(); } catch (e) { console.error(e); }
  try { renderAccountPanel(); } catch (e) { console.error(e); }
  try { syncPrefsPanel(); } catch (e) { console.error(e); }
  try { loadAccountPackages(); } catch (e) { console.error(e); }
  // tab 可能来自事件对象(MouseEvent),必须校验为字符串;不带参数时默认落在「账户」
  switchSettingsTab(typeof tab === 'string' && tab ? tab : 'account');
}
function switchSettingsTab(name) {
  document.querySelectorAll('#settings-tabs .settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#settings-modal .settings-panel').forEach((p) => p.classList.toggle('active', p.id === 'sp-' + name));
  if (name === 'usage2') { usage2Limit = USAGE2_PAGE_SIZE; try { renderUsagePanel(); } catch (e) { console.error(e); } }
}
function closeSettings() {
  // 关闭即清除已生成密钥明文,避免重新打开设置仍能看到
  if (typeof resetApiKeySecret === 'function') resetApiKeySecret();
  if (window.OCUI && window.OCUI.closeModal) {
    window.OCUI.closeModal(modal);
  } else {
    modal.classList.remove('show');
    modal.classList.add('hidden');
  }
}
const settingsTabsEl = $('settings-tabs');
if (settingsTabsEl) settingsTabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-tab');
  if (btn) switchSettingsTab(btn.dataset.tab);
});
$('settings-close').addEventListener('click', closeSettings);
modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });

// ============ 账户面板 / 偏好面板 ============
function renderAccountPanel() {
  if (!state.user) return;
  const avatar = $('acc-avatar');
  if (avatar) fillLogoAvatar(avatar);
  const nm = $('acc-name');
  if (nm) nm.textContent = state.user.name + (state.user.admin ? ' · 管理员' : '');
  const extra = $('acc-extra');
  if (extra) {
    extra.textContent = '注册于 ' + new Date(state.user.createdAt).toLocaleDateString('zh-CN');
  }
  const q = $('acc-quota');
  if (q) {
    q.textContent = '剩余次数: ' + (quotaIsUnlimited(state.user.quota) ? '无限' : state.user.quota);
    q.style.color = !quotaIsUnlimited(state.user.quota) && state.user.quota <= 5 ? 'var(--danger)' : '';
  }
}

// ============ 辅助任务模型选择(跟进建议/对话命名) ============
// 候选只含对话模型;生图/生视频模型不参与文本辅助任务。
function auxModelItems() {
  const items = [];
  availableModelItems().forEach((g) => {
    if (g.label === '生图模型' || g.label === '生视频模型') return;
    (g.items || []).forEach((it) => items.push({ value: it.value, label: it.label, search: it.search }));
  });
  return items;
}
function auxModelLabel(val, mode) {
  const v = String(val || '');
  if (mode === 'title') {
    if (v === 'current') return '跟随当前模型（AI 生成）';
    if (!v) return '本地截取';
  } else if (!v) return '跟随当前模型';
  const found = auxModelItems().find((it) => it.value === v);
  return found ? found.label : (mode === 'title' ? '本地截取' : '跟随当前模型');
}
function syncAuxModelSelect(id, prefKey, mode) {
  const box = $(id);
  if (!box) return;
  const val = String(uiPref(prefKey, '') || '');
  box.setAttribute('data-value', val);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = auxModelLabel(val, mode);
}
function bindAuxModelSelect(id, prefKey, mode) {
  const box = $(id);
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = auxModelItems().slice();
    if (mode === 'title') items.unshift({ value: 'current', label: '跟随当前模型（AI 生成）' });
    items.unshift({ value: '', label: mode === 'title' ? '本地截取' : '跟随当前模型' });
    OC.openSelect(box, items, {
      selected: String(uiPref(prefKey, '') || ''),
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(prefKey, val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || auxModelLabel(val, mode);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}
// 生图模型候选(跨供应商),供「默认生图模型」设置项使用
// 生图模型候选(跨供应商,仅生图,不含生视频),供「默认生图模型」设置项使用
function imageModelItems() {
  const items = [];
  availableModelItems().forEach((g) => {
    if (g.label !== '生图模型') return;
    (g.items || []).forEach((it) => items.push({ value: it.value, label: it.label, search: it.search }));
  });
  return items;
}
function imageModelLabel(val) {
  const v = String(val || '');
  if (!v) return '第一个生图模型';
  const found = imageModelItems().find((it) => it.value === v);
  return found ? found.label : '第一个生图模型';
}
function syncImageModelSelect(id, prefKey) {
  const box = $(id);
  if (!box) return;
  const val = String(uiPref(prefKey, '') || '');
  box.setAttribute('data-value', val);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = imageModelLabel(val);
}
function bindImageModelSelect(id, prefKey) {
  const box = $(id);
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = imageModelItems().slice();
    items.unshift({ value: '', label: '第一个生图模型' });
    OC.openSelect(box, items, {
      selected: String(uiPref(prefKey, '') || ''),
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(prefKey, val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || imageModelLabel(val);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}
// 全站可用的生图模型 [{providerId, modelId, value, label}]（后台「默认生图模型」与自动改走生图都用到）
function allImageModels() {
  const out = [];
  (state.providers || []).forEach((p) => {
    (p.models || []).forEach((m) => {
      if (!m || !m.id) return;
      if (!modelIsImage(m.id)) return;
      out.push({ providerId: p.id, modelId: String(m.id), value: p.id + '\n' + m.id, label: (p.name || p.id) + '@' + (m.name || m.id) });
    });
  });
  return out;
}
// 解析「默认生图模型」:优先用户设置,否则第一个可用生图模型
function defaultImageModel() {
  const list = allImageModels();
  if (!list.length) return null;
  const pref = String(uiPref('imageModel', '') || '');
  if (pref) {
    const hit = list.find((x) => x.value === pref);
    if (hit) return hit;
  }
  return list[0];
}
function syncPrefsPanel() {
  const checks = [
    ['pref-stream', 'stream'],
    ['pref-show-api-chats', 'showApiChats'],
    ['pref-followups', 'followups'],
    ['pref-autotitle', 'autotitle'],
    ['pref-elapsed', 'elapsed'],
    ['pref-reasoning', 'reasoning'],
  ];
  checks.forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.checked = !!uiPref(key, true);
  });
  syncAuxModelSelect('pref-followups-model', 'followupsModel', '');
  syncAuxModelSelect('pref-judge-model', 'judgeModel', '');
  syncImageModelSelect('pref-image-model', 'imageModel');
  // 对话中自动出图:三选一分段(默认粗略)
  const aiMode = autoImageMode();
  document.querySelectorAll('#pref-auto-image .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.autoimage === aiMode);
  });
  const effortVal = reasoningEffort();
  document.querySelectorAll('#pref-reasoning-effort .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === effortVal);
  });
  const effortRow = $('pref-reasoning-effort-row');
  if (effortRow) effortRow.style.opacity = reasoningEnabled() ? '1' : '0.45';
  const ctxInput = $('pref-context');
  const ctxCap = Math.min(500, Math.max(2, Number((state.chatLimits || {}).maxContextMessages) || 200));
  const ctxDefault = Math.min(ctxCap, Math.max(2, Number((state.chatLimits || {}).contextMessages) || 40));
  if (ctxInput) {
    ctxInput.min = '2';
    ctxInput.max = String(ctxCap);
    const stored = Number(uiPref('contextMessages', ctxDefault));
    ctxInput.value = String(Math.min(ctxCap, Math.max(2, isFinite(stored) ? stored : ctxDefault)));
  }
  const ctxDesc = $('pref-context-desc');
  if (ctxDesc) ctxDesc.textContent = '每次请求带上最近的对话消息，不含系统提示词。最多 ' + ctxCap + ' 条';
  const themeVal = (window.OCUI && window.OCUI.getPref && window.OCUI.getPref('theme')) || 'system';
  document.querySelectorAll('#pref-theme .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeVal === themeVal);
  });
  // 外观控件
  const fs = Number(uiPref('fontSize', 14)) || 14;
  const fsEl = $('pref-fontsize');
  if (fsEl) fsEl.value = fs;
  const fsVal = $('pref-fontsize-val');
  if (fsVal) fsVal.textContent = fs + 'px · ' + Math.round(fs / 14 * 100) + '%';
  const syncFontChoice = (key, inputId, selectId, fallback, labels) => {
    const value = String(uiPref(key, fallback) || fallback).trim();
    const input = $(inputId);
    if (input) input.value = (value === fallback || value === 'system') ? '' : value;
    const trigger = $(selectId);
    if (trigger) {
      const label = trigger.querySelector('.font-select-label');
      if (label) label.textContent = labels[value] || (value === 'system' ? '系统字体' : value);
    }
  };
  syncFontChoice('fontCjk', 'pref-font-cjk', 'pref-font-cjk-select', 'source-han-serif', { 'source-han-serif': '思源宋体', 'alibaba-puhuiti': 'AlibabaPuHuiTi', system: '系统字体' });
  syncFontChoice('fontLatin', 'pref-font-latin', 'pref-font-latin-select', 'alibaba-sans', { 'times-new-roman': 'Times New Roman', helvetica: 'Helvetica', 'alibaba-sans': 'AlibabaSans', system: '系统字体' });
  if (typeof syncAccentPicker === 'function') {
    const hex = /^#[0-9a-fA-F]{3,8}$/.test(uiPref('accent', ''))
      ? uiPref('accent', '')
      : ((window.OCUI && window.OCUI.defaultAccent) || '#2563eb');
    syncAccentPicker(hex);
  }
  if (typeof syncComposerEffort === 'function') syncComposerEffort();
  if (typeof syncToolSourcePanel === 'function') syncToolSourcePanel();
}
function syncToolSourcePanel() {
  const search = (state.tools && state.tools.webSearch) || {};
  const parse = (state.tools && state.tools.parse) || {};
  const searchRow = $('pref-search-source-row');
  const parseRow = $('pref-parse-source-row');
  if (searchRow) searchRow.classList.toggle('hidden', !search.allowOwn);
  if (parseRow) parseRow.classList.toggle('hidden', !parse.allowOwn);
  document.querySelectorAll('#pref-search-source .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === (search.source || 'platform'));
  });
  document.querySelectorAll('#pref-parse-source .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === (parse.source || 'platform'));
  });
  const searchOwn = $('pref-search-own');
  const parseOwn = $('pref-parse-own');
  if (searchOwn) searchOwn.classList.toggle('hidden', !search.allowOwn || search.source !== 'own');
  if (parseOwn) parseOwn.classList.toggle('hidden', !parse.allowOwn || parse.source !== 'own');
  const provider = $('pref-search-provider');
  const providerVal = search.provider === 'searxng' ? 'searxng' : 'tavily';
  if (provider) {
    provider.setAttribute('data-value', providerVal);
    const lab = provider.querySelector('.sb-label');
    if (lab) lab.textContent = providerVal === 'searxng' ? 'SearXNG' : 'Tavily';
  }
  const keyRow = $('pref-search-key-row');
  const urlRow = $('pref-search-url-row');
  const searx = providerVal === 'searxng';
  if (keyRow) keyRow.classList.toggle('hidden', !!searx);
  if (urlRow) urlRow.classList.toggle('hidden', !searx);
  const key = $('pref-search-key');
  if (key && document.activeElement !== key) key.value = search.keyMask || '';
  const url = $('pref-search-url');
  if (url && document.activeElement !== url) url.value = search.searxUrl || '';
  const token = $('pref-parse-token');
  if (token && document.activeElement !== token) token.value = parse.tokenMask || '';
  const searchDesc = $('pref-search-source-desc');
  if (searchDesc) {
    searchDesc.textContent = search.source === 'own'
      ? (search.ownReady ? '当前使用你自己的检索配置' : '已选自己的配置，但还没填完整')
      : (search.platformReady ? '当前使用平台配置' : '平台还没有可用的联网配置');
  }
  const parseDesc = $('pref-parse-source-desc');
  if (parseDesc) {
    const mode = parse.source === 'own' ? (parse.hasToken ? '精准' : '轻量') : (parse.platformMode === 'precise' ? '精准' : '轻量');
    parseDesc.textContent = (parse.source === 'own' ? '当前使用你自己的解析：' : '当前使用平台解析：') + mode;
  }
  const actions = $('pref-tools-actions');
  const locked = !search.allowOwn && !parse.allowOwn;
  if (actions) actions.classList.toggle('hidden', locked);
  const note = $('pref-tools-locked');
  if (note) note.classList.toggle('hidden', !locked);
}
function applyToolState(tools) {
  if (!tools) return;
  state.tools = tools;
  const parse = tools.parse || {};
  if (parse.source === 'own' && parse.allowOwn) {
    state.mineru = { enabled: true, mode: parse.hasToken ? 'precise' : 'lite', allowOwn: true };
  }
  syncToolSourcePanel();
  if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
}
async function saveToolSource(patch) {
  const tip = $('pref-tools-tip');
  if (tip) tip.textContent = '保存中…';
  const r = await api('/api/me/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '保存失败');
  applyToolState(data.tools);
  if (tip) tip.textContent = '已保存';
}
(function bindToolSource() {
  document.querySelectorAll('#pref-search-source .seg-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await saveToolSource({ webSearchSource: b.dataset.source }); }
      catch (e) { toast(e.message || '保存失败', true); }
    });
  });
  document.querySelectorAll('#pref-parse-source .seg-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await saveToolSource({ parseSource: b.dataset.source }); }
      catch (e) { toast(e.message || '保存失败', true); }
    });
  });
  const provider = $('pref-search-provider');
  if (provider && window.OC && window.OC.openSelect) {
    const SEARCH_PROVIDERS = [
      { value: 'tavily', label: 'Tavily', sub: '官方搜索 API，填自己的 Key' },
      { value: 'searxng', label: 'SearXNG', sub: '自建元搜索，填实例地址' },
    ];
    const open = () => {
      window.OC.openSelect(provider, SEARCH_PROVIDERS, {
        selected: provider.getAttribute('data-value') || 'tavily',
        onSelect: (val) => {
          const next = val === 'searxng' ? 'searxng' : 'tavily';
          provider.setAttribute('data-value', next);
          const lab = provider.querySelector('.sb-label');
          if (lab) lab.textContent = next === 'searxng' ? 'SearXNG' : 'Tavily';
          const keyRow = $('pref-search-key-row');
          const urlRow = $('pref-search-url-row');
          if (keyRow) keyRow.classList.toggle('hidden', next !== 'tavily');
          if (urlRow) urlRow.classList.toggle('hidden', next !== 'searxng');
        },
      });
    };
    provider.addEventListener('click', open);
    provider.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
  const save = $('pref-tools-save');
  if (save) save.addEventListener('click', async () => {
    const search = (state.tools && state.tools.webSearch) || {};
    const body = {
      webSearchProvider: (provider && provider.getAttribute('data-value')) || 'tavily',
      webSearchSearxUrl: ($('pref-search-url') && $('pref-search-url').value) || '',
    };
    const key = ($('pref-search-key') && $('pref-search-key').value || '').trim();
    const token = ($('pref-parse-token') && $('pref-parse-token').value || '').trim();
    if (key !== (search.keyMask || '')) body.webSearchTavilyKey = key;
    if (token !== (((state.tools && state.tools.parse) || {}).tokenMask || '')) body.mineruToken = token;
    save.disabled = true;
    try {
      await saveToolSource(body);
      toast('工具来源已保存');
    } catch (e) {
      toast(e.message || '保存失败', true);
      const tip = $('pref-tools-tip');
      if (tip) tip.textContent = '';
    } finally {
      save.disabled = false;
    }
  });
})();
(function bindPrefsPanel() {
  const bindCheck = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(key, el.checked);
      else localStorage.setItem('oc_pref_' + key, el.checked ? '1' : '0');
      if (key === 'stream') state.streamToggle = el.checked;
      if (key === 'reasoning') {
        syncPrefsPanel();
        syncComposerEffort();
      }
    });
  };
  bindCheck('pref-stream', 'stream');
  bindCheck('pref-show-api-chats', 'showApiChats');
  bindCheck('pref-followups', 'followups');
  bindCheck('pref-autotitle', 'autotitle');
  bindAuxModelSelect('pref-followups-model', 'followupsModel', 'followups');
  bindAuxModelSelect('pref-judge-model', 'judgeModel', '');
  bindImageModelSelect('pref-image-model', 'imageModel');
  // 对话中自动出图:三选一(关闭 / 粗略 / 智能判定)
  const autoImgBox = $('pref-auto-image');
  if (autoImgBox) autoImgBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || !btn.dataset.autoimage) return;
    document.querySelectorAll('#pref-auto-image .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('autoImageMode', btn.dataset.autoimage);
  });
  bindCheck('pref-elapsed', 'elapsed');
  bindCheck('pref-reasoning', 'reasoning');
  const effortBox = $('pref-reasoning-effort');
  if (effortBox) effortBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const val = btn.dataset.effort;
    if (!val) return;
    document.querySelectorAll('#pref-reasoning-effort .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('reasoningEffort', val);
    if (!reasoningEnabled() && window.OCUI && window.OCUI.setPref) {
      window.OCUI.setPref('reasoning', true);
      const sw = $('pref-reasoning');
      if (sw) sw.checked = true;
    }
    syncPrefsPanel();
    syncComposerEffort();
  });

  const ctxInput = $('pref-context');
  const commitContext = (raw, delta) => {
    if (!ctxInput) return;
    const cap = Math.min(500, Math.max(2, Number(ctxInput.max) || Number((state.chatLimits || {}).maxContextMessages) || 200));
    const current = parseInt(ctxInput.value, 10) || 2;
    const n = Math.min(cap, Math.max(2, (delta ? current + delta : parseInt(raw, 10)) || 2));
    ctxInput.value = String(n);
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('contextMessages', n);
  };
  if (ctxInput) {
    ctxInput.addEventListener('change', () => commitContext(ctxInput.value));
    ctxInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitContext(ctxInput.value); ctxInput.blur(); }
    });
  }
  const ctxMinus = $('pref-context-minus');
  const ctxPlus = $('pref-context-plus');
  if (ctxMinus) ctxMinus.addEventListener('click', () => commitContext(null, -1));
  if (ctxPlus) ctxPlus.addEventListener('click', () => commitContext(null, 1));

  const themeBox = $('pref-theme');
  if (themeBox) themeBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const val = btn.dataset.themeVal;
    document.querySelectorAll('#pref-theme .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.applyTheme) window.OCUI.applyTheme(val);
    else applyTheme(val);
  });

  // ---- 外观:字体大小 ----
  const applyFontSize = (v) => {
    const n = Math.min(22, Math.max(11, Number(v) || 14));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('fontSize', n);
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    const valEl = $('pref-fontsize-val');
    if (valEl) valEl.textContent = n + 'px · ' + Math.round(n / 14 * 100) + '%';
    const slider = $('pref-fontsize');
    if (slider) slider.value = n;
  };
  const fsSlider = $('pref-fontsize');
  if (fsSlider) fsSlider.addEventListener('input', () => applyFontSize(fsSlider.value));
  const fsMinus = $('pref-fontsize-minus');
  if (fsMinus) fsMinus.addEventListener('click', () => applyFontSize((Number(fsSlider.value) || 14) - 1));
  const fsPlus = $('pref-fontsize-plus');
  if (fsPlus) fsPlus.addEventListener('click', () => applyFontSize((Number(fsSlider.value) || 14) + 1));

  // ---- 外观:中文与英文/希腊字母字体 ----
  const applyFontChoice = (key, inputId, value, fallback) => {
    const name = String(value || '').trim() || fallback;
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(key, name);
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    const el = $(inputId);
    if (el) el.value = (name === fallback || name === 'system') ? '' : name;
  };
  const bindFontChoice = (config) => {
    const { key, inputId, selectId, browseId, fallback, labels, options } = config;
    const input = $(inputId);
    const select = $(selectId);
    if (select) select.addEventListener('click', () => {
      const current = (window.OCUI && window.OCUI.getPref) ? window.OCUI.getPref(key) : fallback;
      window.OC.openSelect(select, options.map((value) => ({ value, label: labels[value] || value })), {
        selected: current,
        onSelect: (value) => {
          applyFontChoice(key, inputId, value, fallback);
          const label = select.querySelector('.font-select-label');
          if (label) label.textContent = labels[value] || value;
        },
      });
    });
    if (input) {
      let timer = null;
      const commit = () => applyFontChoice(key, inputId, input.value, fallback);
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(commit, 300);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); commit(); }
      });
    }
    const browse = $(browseId);
    if (browse) browse.addEventListener('click', async () => {
      if (!window.queryLocalFonts) {
        toast('当前浏览器不支持读取本机字体,请直接输入字体名', true);
        return;
      }
      let fonts = [];
      try { fonts = await window.queryLocalFonts(); }
      catch (e) { toast('无法读取本机字体:' + e.message, true); return; }
      const seen = new Set();
      const uniq = [];
      fonts.forEach((f) => {
        const name = f.family || '';
        if (!name || seen.has(name)) return;
        seen.add(name);
        uniq.push(name);
      });
      uniq.sort((a, b) => a.localeCompare(b, 'zh'));
      if (!uniq.length) { toast('未找到本机字体'); return; }
      const current = input ? input.value.trim() : '';
      window.OC.openSelect(browse, uniq.map((name) => ({ value: name, label: name })), {
        selected: current,
        searchable: true,
        searchPlaceholder: '搜索本机字体…',
        width: 320,
        onSelect: (name) => applyFontChoice(key, inputId, name, fallback),
      });
      document.querySelectorAll('.oc-menu-item[data-value]').forEach((row) => {
        const name = row.dataset.value;
        const label = row.querySelector('.item-label');
        if (label && name) label.style.fontFamily = '"' + name.replace(/"/g, '') + '"';
      });
    });
  };
  bindFontChoice({ key: 'fontCjk', inputId: 'pref-font-cjk', selectId: 'pref-font-cjk-select', browseId: 'pref-font-cjk-browse', fallback: 'source-han-serif', options: ['source-han-serif', 'alibaba-puhuiti', 'system'], labels: { 'source-han-serif': '思源宋体', 'alibaba-puhuiti': 'AlibabaPuHuiTi', system: '系统字体' } });
  bindFontChoice({ key: 'fontLatin', inputId: 'pref-font-latin', selectId: 'pref-font-latin-select', browseId: 'pref-font-latin-browse', fallback: 'alibaba-sans', options: ['alibaba-sans', 'times-new-roman', 'helvetica', 'system'], labels: { 'times-new-roman': 'Times New Roman', helvetica: 'Helvetica', 'alibaba-sans': 'AlibabaSans', system: '系统字体' } });

  // ---- 外观:主题色（色相条 + 明暗条）----
  function hexToRgb(hex) {
    const m = String(hex || '').trim().match(/^#([0-9a-fA-F]{3,8})$/);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    const pad = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + pad(r) + pad(g) + pad(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const tk = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: tk(hue + 1 / 3) * 255, g: tk(hue) * 255, b: tk(hue - 1 / 3) * 255 };
  }
  const accentState = { h: 221, s: 0.83, l: 0.53 };
  function currentAccentHex() {
    const rgb = hslToRgb(accentState.h, accentState.s, accentState.l);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }
  function placeAccentThumbs() {
    const hueThumb = $('accent-hue-thumb');
    const lightThumb = $('accent-light-thumb');
    if (hueThumb) hueThumb.style.left = ((accentState.h / 360) * 100) + '%';
    if (lightThumb) lightThumb.style.left = (accentState.l * 100) + '%';
    const hue = $('accent-hue');
    const light = $('accent-light');
    if (hue) {
      hue.setAttribute('aria-valuenow', String(Math.round(accentState.h)));
      hue.style.setProperty('--thumb', currentAccentHex());
    }
    if (light) {
      light.setAttribute('aria-valuenow', String(Math.round(accentState.l * 100)));
      const mid = hslToRgb(accentState.h, Math.max(0.35, accentState.s), 0.5);
      light.style.background = 'linear-gradient(90deg, #2a2d33 0%, ' + rgbToHex(mid.r, mid.g, mid.b) + ' 52%, #f4f5f7 100%)';
    }
    const preview = $('accent-preview');
    if (preview) preview.style.background = currentAccentHex();
    const hexEl = $('pref-accent-hex');
    if (hexEl && document.activeElement !== hexEl) hexEl.value = currentAccentHex();
  }
  function applyAccentHex(hex, persist) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    accentState.h = hsl.h;
    accentState.s = hsl.s || 0.65;
    accentState.l = hsl.l;
    placeAccentThumbs();
    if (persist) {
      if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('accent', currentAccentHex());
      if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    }
  }
  window.syncAccentPicker = function (hex) {
    applyAccentHex(hex || ((window.OCUI && window.OCUI.defaultAccent) || '#2563eb'), false);
  };
  function bindAccentTrack(el, kind) {
    if (!el) return;
    const setFromEvent = (ev) => {
      const rect = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) / rect.width));
      if (kind === 'hue') accentState.h = t * 360;
      else accentState.l = t;
      if (accentState.s < 0.28) accentState.s = 0.65;
      placeAccentThumbs();
      if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('accent', currentAccentHex());
      if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    };
    const onMove = (ev) => { ev.preventDefault(); setFromEvent(ev); };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture && el.setPointerCapture(ev.pointerId);
      setFromEvent(ev);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 8 : 2;
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (kind === 'hue') accentState.h = (accentState.h - step + 360) % 360;
        else accentState.l = Math.max(0.08, accentState.l - step / 100);
      } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (kind === 'hue') accentState.h = (accentState.h + step) % 360;
        else accentState.l = Math.min(0.92, accentState.l + step / 100);
      } else return;
      placeAccentThumbs();
      if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('accent', currentAccentHex());
      if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    });
  }
  bindAccentTrack($('accent-hue'), 'hue');
  bindAccentTrack($('accent-light'), 'light');
  const accHex = $('pref-accent-hex');
  if (accHex) {
    accHex.addEventListener('change', () => applyAccentHex(accHex.value, true));
    accHex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyAccentHex(accHex.value, true); accHex.blur(); }
    });
  }
  const accReset = $('pref-accent-reset');
  if (accReset) accReset.addEventListener('click', () => {
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('accent', '');
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    applyAccentHex((window.OCUI && window.OCUI.defaultAccent) || '#2563eb', false);
  });

})();

// ============ 账户操作:改密 / 导出 / 清空 ============
(function bindAccountActions() {
  const savePwd = $('acc-save-pwd');
  if (savePwd) savePwd.addEventListener('click', async () => {
    const oldPwd = $('acc-old-pwd').value;
    const newPwd = $('acc-new-pwd').value;
    const newPwd2 = $('acc-new-pwd2').value;
    if (!oldPwd || !newPwd) return toast('请填写当前密码和新密码', true);
    if (newPwd.length < 4) return toast('新密码至少 4 个字符', true);
    if (newPwd !== newPwd2) return toast('两次输入的新密码不一致', true);
    const btn = $('acc-save-pwd');
    btn.disabled = true;
    btn.textContent = '更新中...';
    try {
      const r = await api('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '修改失败', true);
      state.token = data.token;
      localStorage.setItem('oc_token', data.token);
      toast('密码已更新');
      $('acc-old-pwd').value = ''; $('acc-new-pwd').value = ''; $('acc-new-pwd2').value = '';
    } catch (e) {
      toast('修改失败: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '更新密码';
    }
  });

  function chatToMarkdown(c) {
    const lines = ['# ' + ((c && c.title) || '未命名对话'), ''];
    ((c && c.messages) || []).forEach((m) => {
      if (!m || m.error) return;
      const text = stripInterruptMarks(m.content);
      if (!text) return;
      const who = m.role === 'user' ? '用户' : ('AI' + (m.model ? ' · ' + m.model : ''));
      lines.push('## ' + who, '', text, '');
    });
    return lines.join('\n');
  }

  const exportCurrent = $('chat-export-md');
  if (exportCurrent) exportCurrent.addEventListener('click', () => {
    const chat = currentChat();
    if (!chat || !(chat.messages || []).some((m) => m && String(m.content || '').trim() && !m.error)) {
      return toast('当前对话没有可导出的内容', true);
    }
    const name = String(chat.title || '当前对话').replace(/[\\/:*?"<>|]+/g, ' ').trim() || '当前对话';
    window.OCUI && window.OCUI.download(name + '.md', chatToMarkdown(chat), 'text/markdown');
    toast('已导出当前对话');
  });

  const reaskBtn = $('chat-reask');
  if (reaskBtn) reaskBtn.addEventListener('click', () => openReaskDialog());

  const exportMd = $('acc-export-md');
  if (exportMd) exportMd.addEventListener('click', () => {
    if (!state.chats.length) return toast('暂无对话可导出');
    const lines = [];
    state.chats.forEach((c) => {
      lines.push('# ' + c.title, '');
      (c.messages || []).forEach((m) => {
        if (m.error) return;
        lines.push('## ' + (m.role === 'user' ? '用户' : 'AI'), '', m.content || '', '');
      });
    });
    window.OCUI && window.OCUI.download('chat-export-' + Date.now() + '.md', lines.join('\n'), 'text/markdown');
    toast('已导出 Markdown');
  });

  const exportJson = $('acc-export-json');
  if (exportJson) exportJson.addEventListener('click', () => {
    if (!state.chats.length) return toast('暂无对话可导出');
    const payload = { exportedAt: new Date().toISOString(), user: state.user ? state.user.name : '', chats: state.chats };
    window.OCUI && window.OCUI.download('chat-backup-' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('已导出 JSON 备份');
  });

  const importJson = $('acc-import-json');
  if (importJson) importJson.addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      let raw = '';
      try { raw = await file.text(); } catch (e) { return toast('读取文件失败', true); }
      let data;
      try { data = JSON.parse(raw); } catch (e) { return toast('不是有效的 JSON 备份', true); }
      const incoming = Array.isArray(data) ? data : (data && data.chats);
      if (!Array.isArray(incoming) || !incoming.length) return toast('备份里没有对话', true);
      const imported = window.OCConversations.normalize(incoming).map((c) => {
        const copy = Object.assign({}, c);
        copy.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        copy.updatedAt = Date.now();
        return copy;
      });
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '导入对话', message: '将导入 ' + imported.length + ' 段对话，与现有记录合并，不会覆盖原对话。确定继续吗？', confirmText: '导入' })
        : confirm('将导入 ' + imported.length + ' 段对话，确定继续吗？');
      if (!ok) return;
      state.chats = imported.concat(state.chats || []);
      if (!state.currentChatId && state.chats[0]) state.currentChatId = state.chats[0].id;
      saveChats();
      renderChatList();
      renderMessages();
      toast('已导入 ' + imported.length + ' 段对话');
    });
    picker.click();
  });

  const clearChats = $('acc-clear-chats');
  if (clearChats) clearChats.addEventListener('click', async () => {
    if (!state.chats.length) return toast('没有可清空的聊天记录');
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清空聊天记录', message: '将删除本机与云端的全部对话记录,且不可恢复。确定继续吗?', danger: true, confirmText: '清空' })
      : confirm('将删除本机与云端的全部对话记录,且不可恢复。确定继续吗?');
    if (!ok) return;
    try {
      const r = await api('/api/sync/chats', { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('sync failed');
      state.chats = [];
      state.currentChatId = null;
      state.chatRevision = Number(data.revision) || (Number(state.chatRevision) || 0) + 1;
      localStorage.setItem('oc_chats_' + state.user.id, '[]');
      localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
      renderChatList();
      renderMessages();
      toast('已清空全部对话');
    } catch (e) {
      toast('清空失败: ' + e.message, true);
    }
  });

  const accLogout = $('acc-logout');
  if (accLogout) accLogout.addEventListener('click', logout);
})();

// ============ 顶栏导出当前对话 ============
(function bindExportChat() {
  const btn = $('export-chat-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const chat = currentChat();
    if (!chat || !chat.messages.length) return toast('当前对话为空');
    const lines = ['# ' + chat.title, ''];
    (chat.messages || []).forEach((m) => {
      if (m.error) return;
      lines.push('## ' + (m.role === 'user' ? '用户' : 'AI'), '', m.content || '', '');
    });
    window.OCUI && window.OCUI.download((chat.title || '对话') + '.md', lines.join('\n'), 'text/markdown');
    toast('已导出当前对话');
  });
})();

function renderProviderList() {
  const list = $('provider-list');
  list.innerHTML = '';
  state.providers.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    const isOwner = p.mine || p.ownerId === state.user.id;
    const isDefault = p.id === state.defaultProviderId;
    const badges = [];
    if (p.scope === 'global') badges.push('<span class="badge global">管理员</span>');
    if (isDefault) badges.push('<span class="badge default">默认</span>');
    if (isOwner) badges.push('<span class="badge user">我的</span>');
    // 普通用户不显示全局供应商的网址（管理员配置的接口地址应隐藏，只显示名称）
    const isAdmin = !!state.user.admin;
    const showUrl = isOwner || isAdmin;
    const urlText = showUrl ? p.baseUrl : '';
    // 只有平台计费的全局供应商才需要展示扣费;自己的 Key 不扣次数,不必说明
    const costText = isOwner ? '' : '每次调用扣 ' + p.costPerCall + ' 次';
    const urlParts = [urlText, p.apiFormat, costText].filter(Boolean).map((x) => escapeHtml(x));
    const urlHtml = urlParts.length ? '<div class="pc-url">' + urlParts.join(' · ') + '</div>' : '';
    let keyHtml = '';
    if (isOwner && p.hasKey && p.keyRevealable) {
      // 仅在属主勾选了「保存后保持显示」时展示遮罩 Key + 小眼睛
      keyHtml = '<div class="pc-key">Key: <span class="pc-key-value" data-key-value="' + p.id + '" data-masked="' + escapeHtml(p.apiKey || '••••••') + '">' + escapeHtml(p.apiKey || '••••••') + '</span>'
        + '<button class="pc-key-eye" data-reveal="' + p.id + '" type="button" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 13) + '</button></div>';
    }
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(p.name)} ${badges.join('')}</div>
        ${urlHtml}
        ${keyHtml}
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        ${isOwner ? '<button class="btn small" data-edit="' + p.id + '">编辑</button><button class="btn small" data-test-provider="' + p.id + '">测试</button><button class="btn small" data-test-all-provider="' + p.id + '">批量测试</button><button class="btn small danger" data-del="' + p.id + '">删除</button>' : ''}
      </div>`;
    card.querySelector('[data-edit]')?.addEventListener('click', () => openProviderEdit(p));
    card.querySelector('[data-reveal]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const span = card.querySelector('[data-key-value="' + p.id + '"]');
      if (!btn || !span) return;
      if (span.getAttribute('data-revealed') === '1') {
        span.textContent = span.getAttribute('data-masked') || '••••••';
        span.removeAttribute('data-revealed');
        btn.innerHTML = window.OC.icon('eye', 13);
        btn.title = '显示 Key';
        return;
      }
      try {
        btn.disabled = true;
        const key = await revealProviderKey(p.id);
        span.textContent = key;
        span.setAttribute('data-revealed', '1');
        btn.innerHTML = window.OC.icon('eyeOff', 13);
        btn.title = '隐藏 Key';
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally {
        btn.disabled = false;
      }
    });
    card.querySelector('[data-test-provider]')?.addEventListener('click', () => openProviderTest(p));
    card.querySelector('[data-test-all-provider]')?.addEventListener('click', () => openProviderTest(p, true));
    card.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除供应商', message: '确认删除该供应商？', danger: true, confirmText: '删除' })
        : confirm('确认删除该供应商？');
      if (!ok) return;
      const r = await api('/api/providers/' + p.id, { method: 'DELETE' });
      if (r.ok) {
        if (providerEditingId === p.id) resetProviderForm();
        toast('已删除'); await loadProviders(); renderProviderList();
      }
      else toast('删除失败', true);
    });
    list.appendChild(card);
  });
  if (!state.providers.length) list.innerHTML = '<p class="muted small">暂无供应商，请添加或等待管理员配置</p>';
}

// ============ 供应商编辑 / Key 查看 ============
let providerEditingId = null;
let providerEditingRevealable = false;
const PROVIDER_FORMAT_LABELS = {
  chat: 'OpenAI chat/completions',
  responses: 'OpenAI responses',
  completions: 'OpenAI completions',
  anthropic: 'Anthropic messages',
};
async function revealProviderKey(providerId) {
  const r = await api('/api/providers/' + encodeURIComponent(providerId) + '/key', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '无法查看 Key');
  return String(data.key || '');
}
function resetProviderForm() {
  providerEditingId = null;
  providerEditingRevealable = false;
  $('p-name').value = '';
  $('p-baseurl').value = '';
  $('p-key').value = '';
  $('p-key').type = 'password';
  setPKeyVisibility(false);
  $('p-key').placeholder = 'sk-...';
  if ($('p-key-keep')) $('p-key-keep').checked = true;
  const fmt = $('p-format');
  fmt.setAttribute('data-value', 'chat');
  const fmtLabel = fmt.querySelector('.sb-label');
  if (fmtLabel) fmtLabel.textContent = PROVIDER_FORMAT_LABELS.chat;
  if ($('p-cost')) $('p-cost').value = 1;
  if (pModelList) pModelList.reset();
  const summary = $('provider-form-summary');
  if (summary) summary.textContent = '+ 添加自定义供应商';
  $('p-save').textContent = '保存供应商';
  $('p-cancel')?.classList.add('hidden');
}
function openProviderEdit(p) {
  const wrap = $('provider-form-wrap');
  if (wrap && !wrap.open) wrap.open = true;
  providerEditingId = p.id;
  providerEditingRevealable = !!p.keyRevealable;
  $('p-name').value = p.name || '';
  $('p-baseurl').value = p.baseUrl || '';
  $('p-key').value = '';
  $('p-key').type = 'password';
  setPKeyVisibility(false);
  $('p-key').placeholder = p.hasKey
    ? (p.keyRevealable ? ('已保存 ' + (p.apiKey || '') + '，留空保持不变') : '已加密保存，不可查看；更换请输入新 Key')
    : 'sk-...';
  if ($('p-key-keep')) $('p-key-keep').checked = !!p.keyRevealable;
  const fmt = $('p-format');
  fmt.setAttribute('data-value', p.apiFormat || 'chat');
  const fmtLabel = fmt.querySelector('.sb-label');
  if (fmtLabel) fmtLabel.textContent = PROVIDER_FORMAT_LABELS[p.apiFormat] || p.apiFormat || 'OpenAI chat/completions';
  if ($('p-cost')) $('p-cost').value = p.costPerCall;
  if (pModelList) pModelList.setEnabled(p.models || []);
  const summary = $('provider-form-summary');
  if (summary) summary.textContent = '编辑供应商';
  $('p-save').textContent = '保存修改';
  $('p-cancel')?.classList.remove('hidden');
  $('p-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('p-name').focus(), 350);
}

let providerTestProvider = null;
let providerTestBatch = false;
let providerTestAbort = null;
let providerTestPassedModels = [];
let providerTestFailedModels = [];
function providerTestModels(provider) {
  return (provider && Array.isArray(provider.models) ? provider.models : []).map((m) => ({
    value: m.id,
    label: m.name || m.id,
    sub: m.name && m.name !== m.id ? m.id : '',
  })).filter((m) => m.value);
}
function setProviderTestModel(value) {
  const box = $('provider-test-model');
  if (!box) return;
  box.setAttribute('data-value', value || '');
  const choice = providerTestModels(providerTestProvider).find((m) => m.value === value);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = choice ? choice.label : '选择模型';
}
function renderProviderTestResult(row, append) {
  const out = $('provider-test-result');
  if (!out) return;
  const ok = !!(row && row.ok);
  if (!append) out.innerHTML = '';
  out.classList.remove('hidden');
  const item = document.createElement('div');
  item.className = 'provider-test-result-item ' + (ok ? 'ok' : 'bad');
  item.innerHTML = '<div class="provider-test-result-title">' + escapeHtml(ok ? '测试成功' : '测试失败') + ' · ' + escapeHtml((row && row.model) || '') + '</div>'
    + '<div class="provider-test-result-meta">' + escapeHtml(String((row && row.ms) || 0)) + ' ms</div>'
    + '<div class="provider-test-result-text">' + escapeHtml(ok ? ((row && row.reply) || '已响应') : ((row && row.error) || '无回复')) + '</div>';
  out.appendChild(item);
}
function setProviderTestBusy(on) {
  const run = $('provider-test-run');
  const stop = $('provider-test-stop');
  const model = $('provider-test-model');
  if (run) run.disabled = on;
  if (model) model.classList.toggle('disabled', on);
  if (stop) stop.hidden = !on;
}
async function requestProviderTest(model) {
  model = model || ($('provider-test-model') && $('provider-test-model').getAttribute('data-value'));
  const prompt = ($('provider-test-prompt') && $('provider-test-prompt').value.trim()) || '回复一个字：好';
  if (!providerTestProvider || !model) throw new Error('请选择要测试的模型');
  providerTestAbort = new AbortController();
  const r = await api('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: providerTestProvider.id, model, prompt }),
    signal: providerTestAbort.signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '测试失败');
  return data.result || { ok: false, model, error: '无测试结果' };
}
async function removeUnavailableProviderModels() {
  if (!providerTestProvider || !providerTestFailedModels.length) return;
  const keep = providerTestModels(providerTestProvider)
    .filter((m) => providerTestPassedModels.indexOf(m.value) >= 0)
    .map((m) => ({ id: m.value, name: m.label }));
  if (!keep.length) return toast('没有可保留的可用模型', true);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '移除不可用模型', message: '将保留 ' + keep.length + ' 个可用模型，移除 ' + providerTestFailedModels.length + ' 个不可用模型。确定继续吗？', danger: true, confirmText: '移除并保存' })
    : confirm('确认移除不可用模型并保存？');
  if (!ok) return;
  const r = await api('/api/providers/' + encodeURIComponent(providerTestProvider.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models: keep }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '保存失败');
  providerTestProvider.models = keep;
  providerTestFailedModels = [];
  $('provider-test-remove-bad')?.classList.add('hidden');
  toast('已移除不可用模型，保留 ' + keep.length + ' 个');
  await loadProviders();
  renderProviderList();
}
function openProviderTest(provider, batch) {
  providerTestProvider = provider;
  providerTestBatch = !!batch;
  const target = $('provider-test-target');
  if (target) target.textContent = (provider.name || '个人供应商') + (providerTestBatch ? ' · 批量测试全部已保存模型' : ' · 不扣站内额度');
  const models = providerTestModels(provider);
  setProviderTestModel(models[0] ? models[0].value : '');
  if ($('provider-test-prompt')) $('provider-test-prompt').value = '回复一个字：好';
  if ($('provider-test-status')) $('provider-test-status').textContent = '';
  providerTestPassedModels = [];
  providerTestFailedModels = [];
  if ($('provider-test-result')) { $('provider-test-result').innerHTML = ''; $('provider-test-result').classList.add('hidden'); }
  const removeBad = $('provider-test-remove-bad');
  if (removeBad) removeBad.classList.add('hidden');
  $('provider-test-use')?.classList.add('hidden');
  const run = $('provider-test-run');
  if (run) run.textContent = providerTestBatch ? '开始批量测试' : '开始测试';
  if (window.OCUI) window.OCUI.openModal($('provider-test-modal'));
}
(function initProviderTest() {
  const modal = $('provider-test-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.bindModal(modal, { closeId: 'provider-test-close', maskClose: false, onClose: () => {
    if (providerTestAbort) providerTestAbort.abort();
    providerTestAbort = null;
    setProviderTestBusy(false);
  }});
  const model = $('provider-test-model');
  if (model) {
    model.addEventListener('click', () => {
      if (model.classList.contains('disabled')) return;
      const choices = providerTestModels(providerTestProvider);
      if (!choices.length) return toast('该供应商没有已保存模型', true);
      OC.openSelect(model, choices, { selected: model.getAttribute('data-value') || '', onSelect: setProviderTestModel });
    });
    model.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); model.click(); }
    });
  }
  const close = () => { if (window.OCUI) window.OCUI.closeModal(modal); };
  $('provider-test-cancel')?.addEventListener('click', close);
  $('provider-test-stop')?.addEventListener('click', () => { if (providerTestAbort) providerTestAbort.abort(); });
  $('provider-test-remove-bad')?.addEventListener('click', async () => {
    try { await removeUnavailableProviderModels(); } catch (e) { toast(e.message || '保存失败', true); }
  });
  $('provider-test-use')?.addEventListener('click', async () => {
    if (!providerTestProvider || !providerTestPassedModels.length) return toast('请先完成一次成功的测试', true);
    const model = providerTestPassedModels[providerTestPassedModels.length - 1];
    state.currentProviderId = providerTestProvider.id;
    await loadModels({ prefer: model });
    renderProviderLabel();
    close();
    toast('已切换为对话模型：' + providerTestProvider.name + '@' + model);
  });
  $('provider-test-run')?.addEventListener('click', async () => {
    const status = $('provider-test-status');
    const models = providerTestModels(providerTestProvider);
    if (!models.length) return toast('该供应商没有已保存模型', true);
    setProviderTestBusy(true);
    if (status) status.textContent = providerTestBatch ? '准备批量测试…' : '正在请求上游…';
    let passed = 0;
    let tested = 0;
    try {
      const queue = providerTestBatch ? models : [models.find((m) => m.value === (($('provider-test-model') && $('provider-test-model').getAttribute('data-value')) || '')) || models[0]];
      if ($('provider-test-result')) { $('provider-test-result').innerHTML = ''; $('provider-test-result').classList.remove('hidden'); }
      for (const item of queue) {
        if (providerTestBatch && status) status.textContent = '正在测试 ' + (tested + 1) + ' / ' + queue.length + ' · ' + item.label;
        setProviderTestModel(item.value);
        let row;
        try {
          row = await requestProviderTest(item.value);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          row = { ok: false, model: item.value, ms: 0, error: e.message || '测试失败' };
        }
        tested++;
        if (row.ok) {
          passed++;
          if (providerTestPassedModels.indexOf(item.value) < 0) providerTestPassedModels.push(item.value);
        } else if (providerTestFailedModels.indexOf(item.value) < 0) {
          providerTestFailedModels.push(item.value);
        }
        renderProviderTestResult(row, providerTestBatch || tested > 1);
      }
      if (providerTestBatch && providerTestFailedModels.length) $('provider-test-remove-bad')?.classList.remove('hidden');
      if (passed) $('provider-test-use')?.classList.remove('hidden');
      if (status) status.textContent = providerTestBatch ? ('完成 · 可用 ' + passed + ' / ' + tested) : (passed ? '供应商可用' : '供应商返回异常');
    } catch (e) {
      if (e.name === 'AbortError') {
        if (status) status.textContent = '已停止 · 已完成 ' + tested + ' 个';
      } else {
        if (status) status.textContent = '';
        toast(e.message || '测试失败', true);
      }
    } finally {
      providerTestAbort = null;
      setProviderTestBusy(false);
    }
  });
})();
function maskKey(k) {
  if (!k || k.length <= 8) return k ? '••••' : '（管理员密钥，不显示）';
  return k.slice(0, 4) + '••••••' + k.slice(-4);
}

// API 格式自定义选择
(function initFormatSelect() {
  const box = $('p-format');
  if (!box) return;
  const FORMATS = [
    { value: 'chat', label: 'OpenAI chat/completions', sub: '对话接口 /v1/chat/completions（常用）' },
    { value: 'responses', label: 'OpenAI responses', sub: '新版接口 /v1/responses' },
    { value: 'completions', label: 'OpenAI completions', sub: '旧版补全 /v1/completions' },
    { value: 'anthropic', label: 'Anthropic messages', sub: 'Claude 消息接口 /v1/messages' },
  ];
  const setLabel = () => {
    const v = box.getAttribute('data-value');
    const f = FORMATS.find((x) => x.value === v);
    box.querySelector('.sb-label').textContent = f ? f.label : v;
  };
  box.addEventListener('click', () => {
    OC.openSelect(box, FORMATS.map((f) => ({ value: f.value, label: f.label, sub: f.sub })), {
      selected: box.getAttribute('data-value'),
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();

const pModelList = window.OC && window.OC.bindModelChecklist
  ? window.OC.bindModelChecklist({
    listId: 'p-models-list',
    queryId: 'p-model-q',
    allId: 'p-models-all',
    countId: 'p-models-count',
    addId: 'p-model-add',
  })
  : null;

const pFetchBtn = $('p-fetch-models');
if (pFetchBtn) {
  pFetchBtn.addEventListener('click', async () => {
    const baseUrl = $('p-baseurl').value.trim();
    const apiKey = $('p-key').value.trim();
    const apiFormat = $('p-format').getAttribute('data-value') || 'chat';
    if (!baseUrl) { toast('请先填写 Base URL', true); return; }
    // 编辑已有供应商时 Key 允许留空(保持原 Key):带上 providerId 让服务端回退用存储的密钥
    if (!apiKey && !providerEditingId) { toast('请先填写 API Key', true); return; }
    pFetchBtn.disabled = true;
    pFetchBtn.textContent = '获取中…';
    try {
      const r = await api('/api/proxy/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, apiFormat, providerId: providerEditingId || undefined }),
      });
      // 上游或服务器异常时可能返回 HTML 错误页,直接 .json() 会抛 "Unexpected token '<'",
      // 这里改为先取文本再尝试解析,给出可读提示
      const data = await readJsonSafe(r);
      if (!r.ok) { toast((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'), true); return; }
      const models = data.models || [];
      if (!models.length) { toast('上游未返回模型', true); return; }
      if (window.OC && window.OC.openFetchedModelsModal) {
        window.OC.openFetchedModelsModal(models, {
          title: '获取到的模型',
          existing: pModelList ? pModelList.getCatalog() : [],
          onApply: (picked, staleIds) => {
            if (pModelList) pModelList.applyFetched(picked, staleIds);
            const n = picked.filter((m) => m.enabled).length;
            const cleared = (staleIds || []).length;
            toast('已应用 ' + n + ' 个启用模型' + (cleared ? '，清除 ' + cleared + ' 个失效模型' : '') + '，保存后生效');
          },
        });
      } else if (pModelList) {
        pModelList.setFromFetch(models);
        toast('已获取 ' + models.length + ' 个模型，勾选后保存即可启用');
      }
    } catch (e) {
      toast('获取失败: ' + e.message, true);
    } finally {
      pFetchBtn.disabled = false;
      pFetchBtn.textContent = '获取列表';
    }
  });
}

const pKeyInput = $('p-key');
const pKeyToggle = $('p-key-toggle');
function setPKeyVisibility(visible) {
  if (!pKeyInput || !pKeyToggle) return;
  pKeyInput.type = visible ? 'text' : 'password';
  pKeyToggle.innerHTML = window.OC.icon(visible ? 'eyeOff' : 'eye', 14);
  pKeyToggle.title = visible ? '隐藏 Key' : '显示 Key';
  pKeyToggle.setAttribute('aria-label', pKeyToggle.title);
}
if (pKeyInput && pKeyToggle) pKeyToggle.addEventListener('click', async () => {
  // 编辑模式且输入框为空:点小眼睛取回服务器上已保存的 Key(仅限勾选了「保存后保持显示」的供应商)
  if (providerEditingId && pKeyInput.value.trim() === '') {
    if (!providerEditingRevealable) {
      toast('该 Key 保存时未勾选「保存后保持显示」，无法查看', true);
      return;
    }
    try {
      pKeyToggle.disabled = true;
      const key = await revealProviderKey(providerEditingId);
      pKeyInput.value = key;
      setPKeyVisibility(true);
    } catch (e) {
      toast(e.message || '无法查看 Key', true);
    } finally {
      pKeyToggle.disabled = false;
    }
    return;
  }
  setPKeyVisibility(pKeyInput.type !== 'text');
  pKeyInput.focus();
});

$('p-save').addEventListener('click', async () => {
  const name = $('p-name').value.trim();
  const baseUrl = $('p-baseurl').value.trim();
  const apiKey = $('p-key').value.trim();
  const apiFormat = $('p-format').getAttribute('data-value') || 'chat';
  const costValue = Number($('p-cost').value);
  const cost = Number.isFinite(costValue) && costValue >= 0 ? costValue : 1;
  const keyRevealable = !!(($('p-key-keep') && $('p-key-keep').checked));
  const editing = !!providerEditingId;
  if (!baseUrl) { toast('请填写 Base URL', true); return; }
  if (!editing && !apiKey) { toast('请填写 API Key', true); return; }
  const models = pModelList ? pModelList.getEnabled() : [];
  if (!models.length) { toast('请先获取模型并至少勾选一个', true); return; }

  // 编辑时 Key 留空 = 不修改;勾选「保存后保持显示」则保存后仍可点小眼睛查看
  const payload = { name, baseUrl, apiFormat, models, costPerCall: cost, keyRevealable };
  if (!editing || apiKey) payload.apiKey = apiKey;
  const r = await api(editing ? '/api/providers/' + encodeURIComponent(providerEditingId) : '/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) { toast((data.error && data.error.message) || '保存失败', true); return; }
  toast(editing ? '已保存修改' : '供应商已添加');
  resetProviderForm();
  await loadProviders();
  renderProviderList();
});
$('p-cancel')?.addEventListener('click', () => resetProviderForm());

// ============ 事件绑定 ============
const redeemBtn = $('plan-redeem-btn');
if (redeemBtn) redeemBtn.addEventListener('click', async () => {
  try {
    const code = ($('plan-redeem-code') && $('plan-redeem-code').value || '').trim();
    if (!code) return toast('请输入兑换码', true);
    const r = await api('/api/packages/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '兑换失败', true);
    if (d.user) state.user = d.user;
    if ($('plan-redeem-code')) $('plan-redeem-code').value = '';
    renderUser(); renderAccountPanel(); renderUsageLedger(); toast('兑换成功');
  } catch (e) { toast('兑换失败，请检查网络连接', true); }
});
const goPlanBtn = $('acc-go-plan');
if (goPlanBtn) goPlanBtn.addEventListener('click', () => switchSettingsTab('plan'));
$('send-btn').addEventListener('click', sendMessage);
$('stop-btn').addEventListener('click', stopStreaming);
$('new-chat-btn').addEventListener('click', newChat);
const composerAt = $('composer-assistant');
if (composerAt) {
  composerAt.addEventListener('click', () => {
    if (window.OCAssistants && typeof window.OCAssistants.open === 'function') window.OCAssistants.open();
  });
}
$('logout-btn').addEventListener('click', logout);
$('admin-link').addEventListener('click', () => location.href = apiUrl('/admin'));

// ============ 全站公告 ============
(function initAnnouncement() {
  // PWA:注册 service worker(静态资源离线缓存,"添加到主屏幕")
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(apiUrl('sw.js')).catch(() => {});
    });
  }
  const modal = $('announce-modal');
  if (!modal) return;
  let current = null;
  function markSeen() {
    const t = current && current.updatedAt ? current.updatedAt : Date.now();
    try { localStorage.setItem('oc_announcement_seen', String(t)); } catch (e) {}
  }
  function showAnnouncement(ann) {
    if (!ann || !ann.text) return;
    current = ann;
    const txt = $('announce-text');
    if (txt) {
      // 公告支持 Markdown 与内联 HTML(经渲染器统一清洗),便于富文本排版
      const raw = String(ann.text);
      let html = '';
      if (window.OCRenderer && window.OCRenderer.render) {
        try { html = window.OCRenderer.render(raw); } catch (e) { html = ''; }
      }
      if (!html) html = escapeHtml(raw).replace(/\n/g, '<br>');
      txt.innerHTML = html;
    }
    const title = $('announce-title');
    if (title) title.textContent = ann.title || '公告';
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(modal);
    else modal.classList.remove('hidden');
  }
  function closeAnnouncement() {
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
  }
  if (window.OCUI && window.OCUI.bindModal) {
    window.OCUI.bindModal(modal, {
      closeId: 'announce-close',
      closeSelector: '#announce-ok',
      onClose: markSeen,
    });
  } else {
    $('announce-close') && $('announce-close').addEventListener('click', () => { closeAnnouncement(); markSeen(); });
    $('announce-ok') && $('announce-ok').addEventListener('click', () => { closeAnnouncement(); markSeen(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { closeAnnouncement(); markSeen(); } });
  }
  window.OCShowAnnouncement = () => {
    // 用户菜单里的「公告」入口:总是展示最新公告,不写已读
    showAnnouncement(current || { text: '', updatedAt: 0 });
    if (current) return true;
    return false;
  };
  window.OCGetAnnouncement = () => current;
  fetch(apiUrl('/api/config')).then((r) => r.json()).then((cfg) => {
    const ann = cfg && cfg.announcement;
    // 自动弹出:公告启用且内容比上次已读更新时
    if (!ann || !ann.enabled || !ann.text) {
      const menuBtn = $('user-menu-announce');
      if (menuBtn) { menuBtn.hidden = true; menuBtn.classList.add('hidden'); }
      return;
    }
    current = ann;
    const menuBtn = $('user-menu-announce');
    if (menuBtn) { menuBtn.hidden = false; menuBtn.classList.remove('hidden'); }
    const seen = Number(localStorage.getItem('oc_announcement_seen')) || 0;
    if (ann.updatedAt && ann.updatedAt <= seen) return;
    showAnnouncement(ann);
  }).catch(() => {});
})();

// ============ API 密钥(OpenAI 兼容出口) ============
function renderApiKeys(keys) {
  const box = $('apikey-list');
  if (!box) return;
  if (!keys.length) { box.innerHTML = '<p class="muted small" style="margin:8px 0 0">还没有 API 密钥</p>'; return; }
  box.innerHTML = keys.map((k) => {
    const last = k.lastUsed ? new Date(k.lastUsed).toLocaleString('zh-CN') : '从未使用';
    return '<div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--hairline)">'
      + '<div style="min-width:0"><div>' + escapeHtml(k.name) + ' <code class="muted small">' + escapeHtml(k.prefix) + '••••</code></div>'
      + '<div class="muted small">创建于 ' + new Date(k.createdAt).toLocaleDateString('zh-CN') + ' · 最后使用 ' + last + '</div></div>'
      + '<button class="btn small danger" data-del-key="' + escapeHtml(k.id) + '" type="button">删除</button></div>';
  }).join('');
  box.querySelectorAll('[data-del-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.OCUI && OCUI.confirm
        ? await OCUI.confirm({ title: '删除 API 密钥', message: '使用该密钥的客户端将立即无法调用。确认删除？', danger: true, confirmText: '删除' })
        : confirm('确认删除该 API 密钥？');
      if (!ok) return;
      try {
        const r = await api('/api/me/apikeys/' + encodeURIComponent(btn.dataset.delKey), { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
        toast('已删除'); loadApiKeys();
      } catch (e) { toast('删除失败: ' + e.message, true); }
    });
  });
}
function apiKeyLimitText(d) {
  const parts = [];
  const keyLimit = Number(d && d.keyRateLimitPerMin);
  const userLimit = Number(d && d.userRateLimitPerMin);
  const maxKeys = Number(d && d.maxKeys) || 5;
  parts.push('单密钥限流 ' + (keyLimit > 0 ? keyLimit + ' 次/分钟' : '不限'));
  if (userLimit > 0) parts.push('账号合计 ' + userLimit + ' 次/分钟');
  parts.push('最多 ' + maxKeys + ' 个密钥');
  if (d && d.exposeRestricted) parts.push('仅部分模型对开放接口开放');
  return parts.join(' · ');
}
function loadApiKeys() {
  const box = $('apikey-list');
  if (!box) return;
  api('/api/me/apikeys').then((r) => r.json()).then((d) => {
    const note = $('apikey-limit-note');
    const enabled = d.enabled !== false;
    if (note) {
      note.textContent = enabled ? ('本站限制：' + apiKeyLimitText(d)) : '管理员已关闭 API 密钥功能';
    }
    if ($('apikey-create')) $('apikey-create').disabled = !enabled;
    renderApiKeys(enabled ? (d.keys || []) : []);
    if ($('acc-api-base')) $('acc-api-base').textContent = location.origin + '/v1';
  }).catch(() => {});
}
// 关闭设置弹窗时清空"仅显示一次"的密钥框,避免下次打开仍能看到明文
function resetApiKeySecret() {
  const val = $('apikey-new-value');
  const box = $('apikey-new-box');
  if (val) val.textContent = '';
  if (box) box.classList.add('hidden');
}
(function initApiKeysUI() {
  const create = $('apikey-create');
  if (!create) return;
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const r = await api('/api/me/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ($('apikey-name') && $('apikey-name').value.trim()) || '' }),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '创建失败', true);
      const box = $('apikey-new-box');
      const val = $('apikey-new-value');
      if (box && val) { val.textContent = d.secret; box.classList.remove('hidden'); }
      const input = $('apikey-name');
      if (input) input.value = '';
      loadApiKeys();
      toast('密钥已生成，请立即复制保存');
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally { create.disabled = false; }
  });
  if ($('sp-apikeys') && window.MutationObserver) {
    new MutationObserver(() => { if ($('sp-apikeys').classList.contains('active')) loadApiKeys(); })
      .observe($('sp-apikeys'), { attributes: true, attributeFilter: ['class'] });
  }
})();

// ============ 空状态建议 ============
(function initEmptySuggests() {
  const wrap = $('empty-suggests');
  if (!wrap) return;
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.empty-suggest');
    if (!btn) return;
    const text = btn.getAttribute('data-q') || '';
    const input = $('input');
    if (!input || !text) return;
    input.value = text;
    autosizeInput();
    updateSendBtn();
    input.focus();
    const end = input.value.length;
    if (input.setSelectionRange) input.setSelectionRange(end, end);
  });
})();

// ============ 附件上传 ============
state.pendingAttachments = [];
// 进度变化只定点更新对应卡片,避免整块重建导致图片缩略图反复重载而闪烁
const ATTACH_ELS = new WeakMap();
function renderAttachments() {
  const box = $('attach-previews');
  box.innerHTML = '';
  state.pendingAttachments.forEach((a, idx) => {
    let el;
    if (a.type === 'image') {
      el = document.createElement('div');
      el.className = 'attach-img-preview';
      el.innerHTML = '<img src="' + a.dataUrl + '" alt="">'
        + '<button class="fc-remove" title="移除">' + window.OC.icon('close', 10) + '</button>';
    } else {
      el = document.createElement('div');
      el.className = 'file-card' + (a.parsing ? ' is-parsing' : '');
      const meta = a.meta || {};
      const size = window.OCMultimodal.formatSize(a.size);
      const status = a.parsing ? (a.parseLabel || '正在解析') : size;
      const fileName = String(a.name || '未命名文件');
      el.innerHTML = '<span class="fc-icon" style="background:' + (meta.color || '#94a3b8') + '22">' + (meta.svg || window.OC.icon('file', 15)) + '</span>'
        + '<span class="fc-info"><span class="fc-name" title="' + escapeHtml(fileName) + '">' + escapeHtml(fileName) + '</span><span class="fc-size">' + escapeHtml(status) + '</span>'
        + (a.parsing ? '<span class="fc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + (a.parsePct || 0) + '"><span style="width:' + (a.parsePct || 8) + '%"></span></span>' : '')
        + '</span>'
        + '<button class="fc-remove">' + window.OC.icon('close', 10) + '</button>';
    }
    el.querySelector('.fc-remove').addEventListener('click', () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachments();
      updateSendBtn();
    });
    ATTACH_ELS.set(a, {
      root: el,
      fill: el.querySelector('.fc-progress > span'),
      bar: el.querySelector('.fc-progress'),
      status: el.querySelector('.fc-size'),
    });
    box.appendChild(el);
  });
}
function setParseProgress(attach, pct, label) {
  attach.parsePct = pct;
  attach.parseLabel = label;
  if (ACTIVE_PARSE_MODAL && ACTIVE_PARSE_MODAL.attach === attach) ACTIVE_PARSE_MODAL.update(pct, label);
  const els = ATTACH_ELS.get(attach);
  if (els && els.root && els.root.isConnected && els.fill) {
    if (els.bar) els.bar.setAttribute('aria-valuenow', String(pct));
    els.fill.style.width = pct + '%';
    if (els.status && label) els.status.textContent = label;
  } else {
    renderAttachments();
  }
}
// 粗略判断当前模型是否支持图片输入(多模态)。判断不准时,图片解析弹窗里仍可手动选择发送方式。
const VISION_MODEL_RE = /(vision|omni|多模态|gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|(^|[^a-z0-9])(o1|o3|o4-mini|o4)($|[^a-z0-9])|gemini|claude-(3|4|sonnet|opus|haiku)|glm-4v|glm-[0-9][0-9.]*v($|[^a-z0-9])|qwen[^ ]{0,8}(vl|qvq)|qvq|(^|[^a-z0-9])vl($|[^a-z0-9])|doubao[^ ]*vision|seed-1\.[567]|kimi-latest|kimi[^ ]*vision|moonshot[^ ]*vision|grok-(2-vision|4)|step-1v|step-1o|yi-vision|internvl|hunyuan[^ ]*vision|ernie[^ ]*(vt|vision)|pixtral|llama-3\.2[^ ]*vision|llama-?4|mistral-small-3)/i;
function modelSupportsVision() {
  const id = String(state.currentModel || '');
  const m = state.models.find((x) => x.id === id) || {};
  const s = (id + ' ' + (m.name || '')).toLowerCase();
  if (!s.trim()) return false;
  if (/o1-mini|o1-preview|deepseek-(v[23]|r\d|chat)(?![a-z]*vl)/.test(s)) return /vision|vl/.test(s);
  return VISION_MODEL_RE.test(s);
}

// MinerU 解析进度弹窗。关闭方式:取消解析 / 后台解析(遮罩与 Esc 视为后台,不打断解析)。
let ACTIVE_PARSE_MODAL = null;
function showParseModal(attach, opts = {}) {
  const mm = window.OCMultimodal;
  const isImg = attach.type === 'image';
  const meta = attach.meta || {};
  const modeText = mm.mineruMode() === 'precise' ? '精准' : '轻量';
  const mask = document.createElement('div');
  mask.className = 'modal-mask oc-parse-mask';
  mask.innerHTML =
    '<div class="modal oc-parse-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>' + (isImg ? '正在提取图片文字' : '正在解析文档') + '</h3></div>'
    + '<div class="modal-body">'
    + '<div class="parse-file-row">'
    + '<span class="fc-icon" style="background:' + (meta.color || '#94a3b8') + '22">' + (meta.svg || window.OC.icon('file', 16)) + '</span>'
    + '<span class="parse-file-name">' + escapeHtml(attach.name || '文件') + '</span>'
    + '<span class="parse-file-size">' + escapeHtml(mm.formatSize(attach.size || 0)) + '</span>'
    + '</div>'
    + '<div class="parse-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div>'
    + '<div class="parse-meta"><span class="parse-label">正在上传</span><span class="parse-pct">0%</span></div>'
    + '<p class="parse-hint">' + (isImg
      ? '当前模型可能不支持图片输入，将使用 MinerU' + modeText + '解析提取图中文字后发送；也可以直接按原图发送。'
      : escapeHtml(mm.mineruLimitText()))
    + '</p>'
    + '</div>'
    + '<div class="modal-footer">'
    + (isImg ? '<button class="btn" data-act="image">直接按图片发送</button>' : '')
    + '<button class="btn" data-act="cancel">取消解析</button>'
    + '<button class="btn primary" data-act="background">后台解析</button>'
    + '</div></div>';
  document.body.appendChild(mask);
  window.OCUI.openModal(mask);
  const modal = {
    attach,
    update(pct, label) {
      if (!mask.isConnected) return;
      const fill = mask.querySelector('.parse-bar > span');
      if (fill) fill.style.width = pct + '%';
      const bar = mask.querySelector('.parse-bar');
      if (bar) bar.setAttribute('aria-valuenow', String(pct));
      const pctEl = mask.querySelector('.parse-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      const labelEl = mask.querySelector('.parse-label');
      if (labelEl && label) labelEl.textContent = label;
    },
    close() {
      if (ACTIVE_PARSE_MODAL === modal) ACTIVE_PARSE_MODAL = null;
      window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 380);
    },
  };
  mask._onClose = () => { if (ACTIVE_PARSE_MODAL === modal) ACTIVE_PARSE_MODAL = null; };
  mask.addEventListener('click', (e) => {
    if (e.target === mask) { modal.close(); return; } // 点遮罩 = 后台解析,不打断
    const act = e.target.closest('[data-act]');
    if (!act) return;
    e.preventDefault();
    const k = act.dataset.act;
    if (k === 'cancel') { modal.close(); if (opts.onCancel) opts.onCancel(); }
    else if (k === 'image') { modal.close(); if (opts.onSendImage) opts.onSendImage(); }
    else { modal.close(); }
  });
  ACTIVE_PARSE_MODAL = modal;
  return modal;
}

async function attachDocument(file, attach) {
  const mm = window.OCMultimodal;
  const isImage = attach.type === 'image';
  // 多模态模型:图片直接发送,不解析
  if (isImage && modelSupportsVision()) return attach;
  // 生图模型:图片是「参考图」(图生图),保留原图直接发送,不能送去 OCR 解析成文字
  if (isImage && modelIsImage(state.currentModel)) return attach;
  // 文本类等本地可读文件:无需解析
  if (!isImage && !(mm && mm.needsMineru && mm.needsMineru(file))) return attach;
  if (mm.mineruTooBig(file)) {
    toast(mm.mineruLimitText(), true);
    return null;
  }
  attach.parsing = true;
  if (state.pendingAttachments.indexOf(attach) < 0) state.pendingAttachments.push(attach);
  const ac = new AbortController();
  let keepAsImage = false;
  const modal = showParseModal(attach, {
    onCancel() { ac.abort(); },
    onSendImage() { keepAsImage = true; ac.abort(); },
  });
  setParseProgress(attach, 12, '正在上传');
  updateSendBtn();
  const body = new FormData();
  body.append('file', file, file.name);
  let timer = null;
  let result = attach;
  try {
    timer = setInterval(() => {
      const cur = attach.parsePct || 12;
      if (cur < 88) setParseProgress(attach, cur + 4, cur < 28 ? '正在上传' : '正在解析');
    }, 700);
    const r = await api('/api/documents/parse', { method: 'POST', body, signal: ac.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && data.error.message) || '解析失败';
      const limited = /10MB|20 页|200MB|200 页|超过|上限|拆分/.test(msg);
      throw new Error(limited ? (msg + '。MinerU 不支持按页拆开多次解析，请自行拆分后再上传。') : msg);
    }
    attach.content = data.markdown || '';
    attach.parsed = true;
    if (isImage) attach.imageAsText = true; // 图片文字已提取,发送时按文本附件走
    attach.parseMode = data.mode || mm.mineruMode();
    setParseProgress(attach, 100, '解析完成');
  } catch (e) {
    if (ac.signal.aborted && keepAsImage) {
      toast('将按原图发送；若模型不支持图片输入可能无法识别', true);
      result = attach;
    } else if (ac.signal.aborted) {
      toast('已取消解析');
      result = null;
    } else if (isImage) {
      // 图片解析失败时按原图保留,不阻塞发送(模型若为多模态仍可识别)
      toast((e.message || '图片解析失败') + '，已按原图添加', true);
      result = attach;
    } else {
      attach.parsing = false;
      modal.close();
      if (timer) clearInterval(timer);
      const idx = state.pendingAttachments.indexOf(attach);
      if (idx >= 0) state.pendingAttachments.splice(idx, 1);
      renderAttachments();
      updateSendBtn();
      throw e;
    }
  } finally {
    if (timer) clearInterval(timer);
    modal.close();
    attach.parsing = false;
    attach.parseLabel = '';
    attach.parsePct = 0;
    if (result !== attach) {
      const idx = state.pendingAttachments.indexOf(attach);
      if (idx >= 0) state.pendingAttachments.splice(idx, 1);
    }
    renderAttachments();
    updateSendBtn();
  }
  return result;
}
(function initUpload() {
  const attachBtn = $('attach-btn');
  if (!attachBtn) return;
  const { btn, input } = window.OCMultimodal.createUploadButton(async (attach, file) => {
    try {
      const ready = await attachDocument(file, attach);
      if (!ready) return;
      if (state.pendingAttachments.indexOf(ready) < 0) state.pendingAttachments.push(ready);
      renderAttachments();
      updateSendBtn();
    } catch (e) {
      toast(e.message || '解析失败', true);
    }
  });
  attachBtn.innerHTML = btn.innerHTML;
  // 移动 input 到按钮内并保留事件
  attachBtn.appendChild(input);
  attachBtn.addEventListener('click', () => input.click());
  const more = $('composer-more');
  const tools = $('composer-tools');
  const fileTool = $('composer-tool-file');
  const searchTool = $('composer-tool-search');
  const effortTool = $('composer-tool-effort');
  if (more && tools) {
    const closeTools = () => {
      tools.classList.add('hidden');
      more.setAttribute('aria-expanded', 'false');
    };
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = tools.classList.contains('hidden');
      tools.classList.toggle('hidden', !open);
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (fileTool) fileTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      input.click();
    });
    if (searchTool) searchTool.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-websearch]');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      if (!searchReady()) {
        const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
        toast(own ? '还没有可用的自备检索配置' : '管理员尚未配置联网搜索', true);
        return;
      }
      setWebSearchMode(opt.dataset.websearch);
    });
    if (effortTool) effortTool.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-effort]');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      setEffortMode(opt.dataset.effort);
    });
    document.addEventListener('click', (e) => {
      if (tools.classList.contains('hidden')) return;
      if (e.target.closest('#composer-tools') || e.target.closest('#composer-more')) return;
      closeTools();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !tools.classList.contains('hidden')) closeTools();
    });
    const compareTool = $('composer-tool-compare');
    if (compareTool) compareTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openCompareDialog();
    });
    const imageTool = $('composer-tool-image');
    if (imageTool) imageTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openImageDialog();
    });
    const videoTool = $('composer-tool-video');
    if (videoTool) videoTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openVideoDialog();
    });
  }
})();

// ============ 图像生成 ============
// 当前供应商下被判定为生图的模型:显式 image 标记优先,否则按模型名启发式判断
function imageModelsOfCurrentProvider() {
  const p = (state.providers || []).find((x) => x.id === state.currentProviderId);
  if (!p || !Array.isArray(p.models)) return [];
  return p.models.filter((m) => m && m.id && modelIsImage(m.id));
}
// 在动态弹窗里挂一个自定义下拉,替代原生 <select>:样式与全站统一,且支持搜索。
function bindModalSelect(box, getItems, onSelect) {
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = typeof getItems === 'function' ? getItems() : (getItems || []);
    if (!items.length) return;
    OC.openSelect(box, items, {
      selected: box.getAttribute('data-value') || '',
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        box.setAttribute('data-value', val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || val;
        if (onSelect) onSelect(val, item);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
}
// 自定义下拉的 HTML 骨架(与全站 .select-box 同款)
function selectBoxHtml(id, label, value) {
  return '<div class="select-box" id="' + id + '" data-value="' + escapeHtml(value || '') + '" role="button" tabindex="0" aria-haspopup="listbox">'
    + '<span class="sb-label">' + escapeHtml(label || '请选择') + '</span>'
    + '<span class="sb-arrow"><svg class="oc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L12 14.5 17 9.5"/></svg></span>'
    + '</div>';
}

function openImageDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId) { toast('请先在顶部选择供应商', true); return; }
  if (document.querySelector('.img-modal')) return; // 已打开时不重复弹出
  const lastModel = localStorage.getItem('oc_image_model') || '';
  // 常用尺寸快捷项;具体规格可在下方输入框自定义(像素 1024x1024 / 档位 2K / 宽高比 16:9)
  const IMG_SIZE_PRESETS = ['1024x1024', '1792x1024', '1024x1792', '512x512', '2K', '4K', '16:9', '9:16'];
  const storedSize = (localStorage.getItem('oc_image_size') || '').trim();
  const lastSize = storedSize || IMG_SIZE_PRESETS[0];
  // 当前供应商里可用的生图模型(显式标记优先,其次按模型名判断)
  const imageModels = imageModelsOfCurrentProvider();
  const hasModelList = imageModels.length > 0;
  // 默认模型优先级:用户设置的「默认生图模型」(若在本供应商) > 上次使用 > 第一个
  const prefImg = defaultImageModel();
  const prefModelHere = (prefImg && prefImg.providerId === state.currentProviderId && imageModels.some((m) => m.id === prefImg.modelId)) ? prefImg.modelId : '';
  const defaultModel = prefModelHere
    || (imageModels.some((m) => m.id === lastModel) ? lastModel : (imageModels[0] ? imageModels[0].id : ''));

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const iconHtml = (window.OC && OC.logoImg) ? OC.logoImg(imageModelLogo(), 'img-dialog-logo') : '';
  const modelBlock = hasModelList
    ? '<div class="field"><span>图像模型</span>' + selectBoxHtml('img-model-box', '选择生图模型', defaultModel) + '</div>'
      + '<label class="field" id="img-model-custom-row" style="display:none"><span>模型 ID</span>'
      + '<input id="img-model" placeholder="手动输入模型 ID" autocomplete="off"></label>'
    : '<div class="field"><span>图像模型</span>'
      + '<input id="img-model" placeholder="例如 dall-e-3 / gpt-image-1" value="' + escapeHtml(lastModel) + '" autocomplete="off"></div>';

  mask.innerHTML =
    '<div class="modal img-modal" role="dialog" aria-modal="true" aria-labelledby="img-dialog-title">'
    + '<div class="modal-header">'
    + '<h3 id="img-dialog-title">' + iconHtml + 'AI 生图</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="img-modal-tip">描述你想要的画面；上传参考图即可<b>修改图片</b>。结果会插入当前对话，每次按一次调用计费。</p>'
    + '<label class="field"><span>提示词</span>'
    + '<textarea id="img-prompt" rows="3" placeholder="例如：一只戴墨镜的柯基在冲浪，扁平插画风" style="resize:vertical"></textarea>'
    + '</label>'
    + '<div class="img-modal-grid">'
    + modelBlock
    + '<div class="field"><span>图片规格</span>'
    + selectBoxHtml('img-size-box', lastSize, lastSize)
    + '<input class="img-size-input" id="img-size-custom" type="text" placeholder="自定义，如 1024x1024 / 2K / 16:9" autocomplete="off">'
    + '</div>'
    + '</div>'
    + '<div class="field"><span>参考图（选填，最多 4 张；上传后按提示词修改图片）</span>'
    + '<div class="img-refs" id="img-refs"></div>'
    + '<input type="file" id="img-ref-input" accept="image/*" multiple hidden>'
    + '<button class="btn small img-ref-add-btn" id="img-ref-add" type="button">'
    + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>添加图片</span></button>'
    + '</div>'
    + '</div>'
    + '<div class="modal-footer img-modal-footer">'
    + '<span class="img-status" id="img-status" role="status" aria-live="polite"></span>'
    + '<button class="btn primary img-run-btn" id="img-run" type="button">生成图片</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-act="close"]')) close(); });

  // 自定义下拉:模型 + 尺寸
  const modelBox = mask.querySelector('#img-model-box');
  const customRow = mask.querySelector('#img-model-custom-row');
  const sizeBox = mask.querySelector('#img-size-box');
  const syncCustom = () => {
    if (!customRow || !modelBox) return;
    const custom = modelBox.getAttribute('data-value') === '__custom__';
    customRow.style.display = custom ? '' : 'none';
    if (custom) { const inp = mask.querySelector('#img-model'); if (inp) inp.focus(); }
  };
  if (modelBox) {
    const items = imageModels.map((m) => ({ value: m.id, label: m.name || m.id }))
      .concat([{ value: '__custom__', label: '其他（手动输入）' }]);
    bindModalSelect(modelBox, items, () => syncCustom());
    syncCustom();
  }
  // 图片规格:下拉选预设;也可在输入框里自定义。两者联动(改一边同步另一边),
  // readSizeInput 以输入框为准,输入框为空时才用下拉的预设值。
  const sizeInput = mask.querySelector('#img-size-custom');
  if (sizeBox) {
    bindModalSelect(sizeBox, IMG_SIZE_PRESETS.map((s) => ({ value: s, label: s })), (val) => {
      if (sizeInput) sizeInput.value = val === IMG_SIZE_PRESETS[0] ? '' : val;
    });
  }
  if (sizeInput) {
    sizeInput.addEventListener('input', () => {
      const v = sizeInput.value.trim();
      const label = sizeBox && sizeBox.querySelector('.sb-label');
      if (!label) return;
      label.textContent = v || '选择预设';
    });
  }
  const readImageModel = () => {
    if (modelBox) {
      const v = modelBox.getAttribute('data-value') || '';
      if (v && v !== '__custom__') return v;
    }
    return (mask.querySelector('#img-model') && mask.querySelector('#img-model').value.trim()) || '';
  };
  const readSize = () => {
    const typed = sizeInput ? sizeInput.value.trim() : '';
    if (typed) return typed;
    return (sizeBox && sizeBox.getAttribute('data-value')) || lastSize;
  };
  // 参考图(改图用):保存 data URL 列表并渲染缩略图
  const imgRefs = [];
  const refsBox = mask.querySelector('#img-refs');
  const refInput = mask.querySelector('#img-ref-input');
  const IMG_REF_MAX = 4;
  function renderImgRefs() {
    if (!refsBox) return;
    refsBox.innerHTML = imgRefs.map((r, i) =>
      '<span class="img-ref"><img src="' + r + '" alt="">'
      + '<button type="button" class="img-ref-del" data-idx="' + i + '" aria-label="移除">×</button></span>'
    ).join('');
    refsBox.querySelectorAll('[data-idx]').forEach((b) => b.addEventListener('click', () => {
      imgRefs.splice(Number(b.dataset.idx), 1);
      renderImgRefs();
    }));
  }
  const refAdd = mask.querySelector('#img-ref-add');
  if (refAdd && refInput) {
    refAdd.addEventListener('click', () => refInput.click());
    refInput.addEventListener('change', async () => {
      const files = Array.from(refInput.files || []);
      for (const f of files) {
        if (imgRefs.length >= IMG_REF_MAX) { toast('最多 ' + IMG_REF_MAX + ' 张参考图', true); break; }
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 15 * 1024 * 1024) { toast('单张参考图请小于 15MB', true); continue; }
        try { imgRefs.push(await readImageRefCompressed(f)); } catch (e) { /* 跳过读失败的文件 */ }
      }
      refInput.value = '';
      renderImgRefs();
    });
  }
  const run = mask.querySelector('#img-run');
  run.addEventListener('click', async () => {
    const prompt = (mask.querySelector('#img-prompt') && mask.querySelector('#img-prompt').value.trim()) || '';
    const model = readImageModel();
    const spec = parseImageSpec(readSize());
    const status = mask.querySelector('#img-status');
    if (!prompt) return toast('请输入提示词', true);
    if (!model) return toast('请填写图像模型', true);
    localStorage.setItem('oc_image_model', model);
    // 记住「用户实际表达」的规格:像素/档位存 size,宽高比存 ratio,两条入口据此还原
    localStorage.setItem('oc_image_size', spec.ratio || spec.size);
    run.disabled = true;
    status.textContent = '生成中，通常需要 10–60 秒…';
    try {
      const r = await api('/api/proxy/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: state.currentProviderId, model, prompt, size: spec.size, ratio: spec.ratio, n: 1, images: imgRefs.slice() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
      // url / display(同源代理) / b64_json 三种形态统一交给 insertImageResult
      insertImageResult(model, prompt, d.images, imgRefs.length ? '修改要求' : '', imgRefs.slice());
      close();
      toast(imgRefs.length ? '已改图并插入对话' : '已生成并插入对话');
      await refreshMe();
    } catch (e) {
      // 失败原因同时显示在弹窗内(常驻,不会被 toast 错过)与 toast
      const msg = (e && e.message) ? e.message : '未知错误';
      if (status) {
        status.textContent = '生成失败：' + msg;
        status.classList.add('img-status-error');
      }
      toast('生成失败: ' + msg, true);
    } finally { run.disabled = false; }
  });
  setTimeout(() => { const p = mask.querySelector('#img-prompt'); if (p) p.focus(); }, 60);
}

// ============ 视频生成 ============
// 生视频弹窗:提示词 + 模式(文字/首尾帧/参考图) + 时长 + 画面比例 + 参考图。
// 后端建任务并轮询到出片,结果插入当前对话。
function openVideoDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId) { toast('请先在顶部选择供应商', true); return; }
  if (document.querySelector('.vid-modal')) return;
  const videoModels = videoModelsOfCurrentProvider();
  const lastModel = localStorage.getItem('oc_video_model') || '';
  const hasModelList = videoModels.length > 0;
  const defaultModel = videoModels.some((m) => m.id === lastModel) ? lastModel : (videoModels[0] ? videoModels[0].id : '');
  const spec = parseVideoSpec();
  const SECONDS = ['4', '5', '6', '8', '10', '12'];

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const iconHtml = (window.OC && OC.logoImg) ? OC.logoImg(videoModelLogo(), 'img-dialog-logo') : '';
  const modelBlock = hasModelList
    ? '<div class="field"><span>视频模型</span>' + selectBoxHtml('vid-model-box', '选择视频模型', defaultModel) + '</div>'
      + '<label class="field" id="vid-model-custom-row" style="display:none"><span>模型 ID</span>'
      + '<input id="vid-model" placeholder="手动输入模型 ID" autocomplete="off"></label>'
    : '<div class="field"><span>视频模型</span>'
      + '<input id="vid-model" placeholder="例如 agnes-video-2.5-flash" value="' + escapeHtml(lastModel) + '" autocomplete="off"></div>';

  mask.innerHTML =
    '<div class="modal img-modal vid-modal" role="dialog" aria-modal="true" aria-labelledby="vid-dialog-title">'
    + '<div class="modal-header">'
    + '<h3 id="vid-dialog-title">' + iconHtml + 'AI 生视频</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="img-modal-tip">描述你想要的画面与运镜；<b>首尾帧模式</b>上传首帧/尾帧，<b>参考图模式</b>可上传最多 5 张参考图。生成较慢（约 1–5 分钟），完成后插入当前对话，每次按一次调用计费。</p>'
    + '<label class="field"><span>提示词</span>'
    + '<textarea id="vid-prompt" rows="3" placeholder="例如：雨后的未来城市街道，镜头缓慢推进，霓虹倒影" style="resize:vertical"></textarea>'
    + '</label>'
    + '<div class="img-modal-grid">'
    + modelBlock
    + '<div class="field"><span>生成模式</span>' + selectBoxHtml('vid-mode-box', '文字生成', 'text') + '</div>'
    + '</div>'
    + '<div class="img-modal-grid">'
    + '<div class="field"><span>时长（秒）</span>' + selectBoxHtml('vid-sec-box', String(spec.seconds), String(spec.seconds)) + '</div>'
    + '<div class="field"><span>画面比例</span>' + selectBoxHtml('vid-ratio-box', spec.ratio, spec.ratio) + '</div>'
    + '</div>'
    + '<div class="field" id="vid-first-last" style="display:none"><span>首帧 / 尾帧（至少一张）</span>'
    + '<div class="vid-two">'
    + '<div class="vid-slot" data-slot="first_frame"><div class="img-refs" id="vid-first-refs"></div>'
    + '<input type="file" id="vid-first-input" accept="image/*" hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-first-add" type="button">' + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>首帧</span></button></div>'
    + '<div class="vid-slot" data-slot="last_frame"><div class="img-refs" id="vid-last-refs"></div>'
    + '<input type="file" id="vid-last-input" accept="image/*" hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-last-add" type="button">' + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>尾帧</span></button></div>'
    + '</div>'
    + '</div>'
    + '<div class="field" id="vid-refs-field" style="display:none"><span>参考图（最多 5 张）</span>'
    + '<div class="img-refs" id="vid-refs"></div>'
    + '<input type="file" id="vid-ref-input" accept="image/*" multiple hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-ref-add" type="button">'
    + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>添加图片</span></button>'
    + '</div>'
    + '</div>'
    + '<div class="modal-footer img-modal-footer">'
    + '<span class="img-status" id="vid-status" role="status" aria-live="polite"></span>'
    + '<button class="btn primary img-run-btn" id="vid-run" type="button">生成视频</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-act="close"]')) close(); });

  // 自定义下拉:模型 / 模式 / 时长 / 比例
  const modelBox = mask.querySelector('#vid-model-box');
  const customRow = mask.querySelector('#vid-model-custom-row');
  const modeBox = mask.querySelector('#vid-mode-box');
  const secBox = mask.querySelector('#vid-sec-box');
  const ratioBox = mask.querySelector('#vid-ratio-box');
  const MODES = [
    { value: 'text', label: '文字生成', sub: '纯文本生成视频' },
    { value: 'keyframe', label: '首尾帧', sub: '给定首帧/尾帧生成过渡' },
    { value: 'reference', label: '参考图', sub: '以图片/音频为参考' },
  ];
  const syncMode = (val) => {
    const m = val || (modeBox && modeBox.getAttribute('data-value')) || 'text';
    const fl = mask.querySelector('#vid-first-last');
    const rf = mask.querySelector('#vid-refs-field');
    if (fl) fl.style.display = m === 'keyframe' ? '' : 'none';
    if (rf) rf.style.display = m === 'reference' ? '' : 'none';
  };
  const syncCustom = () => {
    if (!customRow || !modelBox) return;
    const custom = modelBox.getAttribute('data-value') === '__custom__';
    customRow.style.display = custom ? '' : 'none';
    if (custom) { const inp = mask.querySelector('#vid-model'); if (inp) inp.focus(); }
  };
  if (modelBox) {
    const items = videoModels.map((m) => ({ value: m.id, label: m.name || m.id }))
      .concat([{ value: '__custom__', label: '其他（手动输入）' }]);
    bindModalSelect(modelBox, items, () => syncCustom());
    syncCustom();
  }
  if (modeBox) bindModalSelect(modeBox, MODES.map((m) => ({ value: m.value, label: m.label, sub: m.sub })), (v) => syncMode(v));
  if (secBox) bindModalSelect(secBox, SECONDS.map((s) => ({ value: s, label: s + ' 秒' })));
  if (ratioBox) bindModalSelect(ratioBox, VIDEO_RATIOS.map((r) => ({ value: r, label: r })));
  syncMode('text');
  const readVideoModel = () => {
    if (modelBox) {
      const v = modelBox.getAttribute('data-value') || '';
      if (v && v !== '__custom__') return v;
    }
    return (mask.querySelector('#vid-model') && mask.querySelector('#vid-model').value.trim()) || '';
  };
  const readVal = (box, fallback) => (box && box.getAttribute('data-value')) || fallback;

  // 参考图:refs(参考图模式)/ first/last(首尾帧模式)
  const refs = [];
  const firstRef = [];
  const lastRef = [];
  const renderRefs = (box, arr, onDel) => {
    if (!box) return;
    box.innerHTML = arr.map((r, i) =>
      '<span class="img-ref"><img src="' + r + '" alt="">'
      + '<button type="button" class="img-ref-del" data-idx="' + i + '" aria-label="移除">×</button></span>'
    ).join('');
    box.querySelectorAll('[data-idx]').forEach((b) => b.addEventListener('click', () => { onDel(Number(b.dataset.idx)); }));
  };
  const bindRefInput = (addId, inputId, paneId, arr, max) => {
    const add = mask.querySelector(addId), input = mask.querySelector(inputId), pane = mask.querySelector(paneId);
    if (!add || !input || !pane) return;
    const redraw = () => renderRefs(pane, arr, (i) => { arr.splice(i, 1); redraw(); });
    add.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      for (const f of files) {
        if (arr.length >= max) { toast('最多 ' + max + ' 张', true); break; }
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 15 * 1024 * 1024) { toast('单张图片请小于 15MB', true); continue; }
        try { arr.push(await readImageRefCompressed(f)); } catch (e) { /* 跳过读失败的文件 */ }
      }
      input.value = '';
      redraw();
    });
  };
  bindRefInput('#vid-ref-add', '#vid-ref-input', '#vid-refs', refs, 5);
  bindRefInput('#vid-first-add', '#vid-first-input', '#vid-first-refs', firstRef, 1);
  bindRefInput('#vid-last-add', '#vid-last-input', '#vid-last-refs', lastRef, 1);

  const run = mask.querySelector('#vid-run');
  run.addEventListener('click', async () => {
    const prompt = (mask.querySelector('#vid-prompt') && mask.querySelector('#vid-prompt').value.trim()) || '';
    const model = readVideoModel();
    const mode = readVal(modeBox, 'text');
    const seconds = parseInt(readVal(secBox, '5'), 10) || 5;
    const ratio = readVal(ratioBox, '16:9');
    const status = mask.querySelector('#vid-status');
    if (!prompt) return toast('请输入提示词', true);
    if (!model) return toast('请填写视频模型', true);
    if (mode === 'keyframe' && !firstRef.length && !lastRef.length) return toast('首尾帧模式至少上传首帧或尾帧', true);
    localStorage.setItem('oc_video_model', model);
    localStorage.setItem('oc_video_seconds', String(seconds));
    localStorage.setItem('oc_video_ratio', ratio);
    run.disabled = true;
    status.textContent = '生成中，通常需要 1–5 分钟，请勿关闭页面…';
    try {
      const payload = { providerId: state.currentProviderId, model, prompt, mode, seconds, aspect_ratio: ratio, n: 1 };
      if (mode === 'reference') payload.images = refs.slice();
      if (mode === 'keyframe') {
        if (firstRef[0]) payload.first_frame = firstRef[0];
        if (lastRef[0]) payload.last_frame = lastRef[0];
      }
      const r = await api('/api/proxy/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
      insertVideoResult(model, prompt, d.videos, mode);
      close();
      toast('已生成视频并插入对话');
      await refreshMe();
    } catch (e) {
      const msg = (e && e.message) ? e.message : '未知错误';
      if (status) { status.textContent = '生成失败：' + msg; status.classList.add('img-status-error'); }
      toast('生成失败: ' + msg, true);
    } finally { run.disabled = false; }
  });
  setTimeout(() => { const p = mask.querySelector('#vid-prompt'); if (p) p.focus(); }, 60);
}
// 把生视频结果插入当前对话
function insertVideoResult(model, prompt, videos, mode) {
  const links = videoLinksFromResults(videos, prompt);
  if (!links) throw new Error('未返回可用的视频数据');
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  const userMsg = { role: 'user', content: prompt || '（视频）', text: prompt, attachments: [], createdAt: Date.now() };
  chat.messages.push(userMsg);
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = '视频 · ' + String(prompt || '生成视频').slice(0, 18);
    renderChatList();
  }
  const modes = { text: '提示词', keyframe: '首尾帧', reference: '参考图' };
  const head = '**' + (modes[mode] || '提示词') + '：** ' + prompt;
  const reply = { role: 'assistant', content: head + '\n\n' + links, model: model + ' (视频)', createdAt: Date.now() };
  chat.messages.push(reply);
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  return links;
}

// 把生图结果插入当前对话(绘图弹窗路径)。与输入框路径一样,先落用户消息再落结果,
// 保证两条入口在对话里的呈现一致;refUrls 为参考图(改图时)的 data URL 列表。
function insertImageResult(model, prompt, images, kindLabel, refUrls) {
  const links = imageLinksFromResults(images, prompt);
  if (!links) throw new Error('未返回可用的图像数据');
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  const refs = (refUrls || []).filter(Boolean).slice(0, 4);
  const parts = [];
  if (prompt) parts.push(prompt);
  refs.forEach((u, i) => parts.push('![参考图' + (i + 1) + '](' + u + ')'));
  const userMsg = {
    role: 'user',
    content: parts.join('\n\n') || '（参考图）',
    text: prompt,
    attachments: refs.map((u, i) => ({ type: 'image', name: '参考图' + (i + 1), dataUrl: u })),
    createdAt: Date.now(),
  };
  chat.messages.push(userMsg);
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = (kindLabel || '绘画') + ' · ' + String(prompt || '参考图').slice(0, 18);
    renderChatList();
  }
  const head = kindLabel ? '**' + kindLabel + '：** ' + (prompt || '参考图') : '**提示词：** ' + prompt;
  const reply = { role: 'assistant', content: head + '\n\n' + links, model: model + ' (图像)', createdAt: Date.now() };
  chat.messages.push(reply);
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  return links;
}

// 对话内生图:生图模型下在输入框发指令(纯文本=文生图,带图=图生图)。
// 与绘图弹窗共用同一接口与时序:先落一条用户消息(带附件则在气泡里显示参考图),
// 再放一个占位的助手消息,拿到图片后替换为结果。
async function sendImageTurn(prompt, imageAtts, opts) {
  opts = opts || {};
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const model = state.currentModel;
  const providerId = state.currentProviderId;
  const text = String(prompt || '').trim();
  const atts = (imageAtts || []).slice(0, 4);
  if (!text && !atts.length) return;

  // 落用户消息,让输入框里的提示词与参考图和弹窗路径表现一致
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();

  // 参考图:优先用本次附的图;用户没附图时,追问自动把本会话上一张生成图作为参考图(改图)。
  // 取到后统一压缩(长边 1536 / JPEG),与绘图弹窗走同一逻辑,发给上游的图片一致。
  // opts.autoRef === false 时不做「自动带上上一张图」(用于纯文生图的新画,避免误当作改图)。
  let refUrls = (await Promise.all(atts.map((a) => compressImageRef(a.dataUrl || a)))).filter(Boolean);
  let autoRef = false;
  if (!refUrls.length && text && opts.autoRef !== false) {
    const prev = lastImageSourceInChat(chat);
    if (prev) {
      const dataUrl = await imageSourceToDataUrl(prev);
      const comp = dataUrl ? await compressImageRef(dataUrl) : '';
      // 只有确实拿到可用的图片才作为参考图;取不到(过期/跨域失败/非图片)就静默回退为纯文生图
      if (comp && /^data:image\//i.test(comp)) { refUrls = [comp]; autoRef = true; }
    }
  }
  const hasRefs = refUrls.length > 0;
  if (!hasRefs && !text) { toast('请输入画面描述', true); return; }

  // 展示用附件:用户附图沿用其文件名;自动参考的上一张图给一个可读名字
  const refAtts = autoRef
    ? [{ type: 'image', name: '上一张图', size: 0, meta: {}, dataUrl: refUrls[0] }]
    : atts.map((a, i) => Object.assign({}, a, { dataUrl: refUrls[i] || a.dataUrl }));

  const parts = [];
  if (text) parts.push(text);
  if (refAtts.length && window.OCMultimodal) refAtts.forEach((a) => parts.push(window.OCMultimodal.toMarkdown(a)));
  const userMsg = { role: 'user', content: parts.join('\n\n') || '（参考图）', text, attachments: refAtts, createdAt: Date.now() };
  chat.messages.push(userMsg);
  const placeholder = { role: 'assistant', content: '', imagePending: true, model, providerId, createdAt: Date.now() };
  chat.messages.push(placeholder);
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = (hasRefs ? '改图' : '绘画') + ' · ' + String(text || '参考图').slice(0, 18);
    renderChatList();
  }
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  if (autoRef) toast('已把上一张图作为参考图，可直接描述要修改的地方');

  // 图片规格沿用「绘图弹窗」里最近一次的选择(尺寸或宽高比),两条入口共用同一偏好
  const spec = parseImageSpec(localStorage.getItem('oc_image_size') || '');
  state.streaming = true;
  updateSendBtn();
  try {
    const r = await api('/api/proxy/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model, prompt: text, n: 1, size: spec.size, ratio: spec.ratio, images: refUrls }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
    // 解析图片地址(display 同源代理 / url / b64_json 三种形态)
    const links = imageLinksFromResults(d.images, text);
    if (!links) throw new Error('未返回可用的图像数据');
    const head = '**' + (hasRefs ? '修改要求' : '提示词') + '：** ' + (text || '参考图');
    placeholder.content = head + '\n\n' + links;
    placeholder.imagePending = false;
    placeholder.createdAt = Date.now();
    saveChats();
    renderMessages();
    toast(hasRefs ? '已改图并插入对话' : '已生成并插入对话');
    await refreshMe();
  } catch (e) {
    placeholder.imagePending = false;
    placeholder.error = true;
    placeholder.content = '生图失败：' + ((e && e.message) || '未知错误');
    saveChats();
    renderMessages();
    toast('生图失败: ' + ((e && e.message) || '未知错误'), true);
  } finally {
    state.streaming = false;
    updateSendBtn();
    refreshModelHealth();
  }
}
// 从生图接口返回项里取出可用的 Markdown 图片链接(url / 同源代理 display / b64)
function imageLinksFromResults(images, prompt) {
  const alt = String(prompt || '').replace(/[\[\]]/g, '').slice(0, 60);
  return (images || []).map((im) => {
    const src = imageSourceOf(im);
    return src ? '![' + alt + '](' + src + ')' : '';
  }).filter(Boolean).join('\n\n');
}
// 视频结果 → Markdown 链接(渲染端识别 .mp4/.webm/.mov 后缀渲染为 <video>)
function videoSourceOf(v) {
  if (!v) return '';
  return v.display || v.url || '';
}
function videoLinksFromResults(videos, prompt) {
  const alt = String(prompt || '').replace(/[()\[\]]/g, '').slice(0, 60) || '生成视频';
  return (videos || []).map((v) => {
    const src = videoSourceOf(v);
    return src ? '[' + alt + '](' + src + ')' : '';
  }).filter(Boolean).join('\n\n');
}
// 对话内生视频:视频模型下在输入框发指令(纯文本=文生视频,带图=以图生视频)。
// 后端建任务并轮询到出片后返回视频地址;期间显示「正在生成视频…」占位。
async function sendVideoTurn(prompt, imageAtts) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const model = state.currentModel;
  const providerId = state.currentProviderId;
  const text = String(prompt || '').trim();
  const atts = (imageAtts || []).slice(0, 5);
  if (!text && !atts.length) return;

  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();

  const refUrls = (await Promise.all(atts.map((a) => compressImageRef(a.dataUrl || a)))).filter(Boolean);
  const refAtts = atts.map((a, i) => Object.assign({}, a, { dataUrl: refUrls[i] || a.dataUrl }));
  const hasRefs = refUrls.length > 0;
  if (!text && !hasRefs) { toast('请输入画面描述', true); return; }
  if (!hasRefs && !text) { toast('请输入画面描述', true); return; }

  const parts = [];
  if (text) parts.push(text);
  if (refAtts.length && window.OCMultimodal) refAtts.forEach((a) => parts.push(window.OCMultimodal.toMarkdown(a)));
  const userMsg = { role: 'user', content: parts.join('\n\n') || '（参考图）', text, attachments: refAtts, createdAt: Date.now() };
  chat.messages.push(userMsg);
  const placeholder = { role: 'assistant', content: '', imagePending: true, pendingKind: 'video', model, providerId, createdAt: Date.now() };
  chat.messages.push(placeholder);
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = '视频 · ' + String(text || '参考图').slice(0, 18);
    renderChatList();
  }
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });

  // 视频规格沿用绘图弹窗里最近一次的选择(时长 / 比例)
  const spec = parseVideoSpec();
  state.streaming = true;
  updateSendBtn();
  try {
    const r = await api('/api/proxy/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model, prompt: text, mode: hasRefs ? 'reference' : 'text', seconds: spec.seconds, aspect_ratio: spec.ratio, images: refUrls }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
    const links = videoLinksFromResults(d.videos, text);
    if (!links) throw new Error('未返回可用的视频数据');
    const head = '**' + (hasRefs ? '参考图视频' : '提示词') + '：** ' + (text || '参考图');
    placeholder.content = head + '\n\n' + links;
    placeholder.imagePending = false;
    placeholder.createdAt = Date.now();
    saveChats();
    renderMessages();
    toast('已生成视频并插入对话');
    await refreshMe();
  } catch (e) {
    placeholder.imagePending = false;
    placeholder.error = true;
    placeholder.content = '生视频失败：' + ((e && e.message) || '未知错误');
    saveChats();
    renderMessages();
    toast('生视频失败: ' + ((e && e.message) || '未知错误'), true);
  } finally {
    state.streaming = false;
    updateSendBtn();
    refreshModelHealth();
  }
}
function imageSourceOf(im) {
  if (!im) return '';
  if (im.display) return im.display;                       // 同源代理地址(优先:fetch 不受跨域限制)
  if (im.url) return im.url;
  if (im.b64_json) return 'data:image/png;base64,' + im.b64_json;
  return '';
}
// 找本会话最近一张生成图的地址:从最新的助手消息往前找,取消息里的最后一张图。
// 追问改图时用它作为参考图(用户没另外附图时)。
function lastImageSourceInChat(chat) {
  const msgs = (chat && chat.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const re = /!\[[^\]]*\]\(([^)]+)\)/g;
    let hit = '';
    let match;
    while ((match = re.exec(m.content))) hit = match[1];
    if (hit) return hit;
  }
  return '';
}
// 把图片来源转成 data URL:data: 直接用;同源代理地址 / 公网地址则 fetch 回来。
// 失败返回 '',调用方据此回退为「纯文生图」,不会因参考图取不到而中断。
function imageSourceToDataUrl(src) {
  const s = String(src || '');
  if (!s) return Promise.resolve('');
  if (/^data:image\//i.test(s)) return Promise.resolve(s);
  return new Promise((resolve) => {
    fetch(s, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      })
      .catch(() => resolve(''));
  });
}

// ============ 多模型并答对比 ============
// 独立于流式管线:非流式并行请求,结果并排展示并支持投票(计入模型评价)。每个所选模型各计费一次。
function openCompareDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const models = availableModels();
  if (models.length < 2) return toast('至少需要两个可用模型才能对比', true);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const options = models.map((item) => {
    const on = item.providerId === state.currentProviderId && item.model === state.currentModel;
    return '<label class="compare-model-opt"><input type="checkbox" value="' + escapeHtml(item.providerId + '\n' + item.model) + '"' + (on ? ' checked' : '') + '>'
      + '<span>' + escapeHtml(item.provider + ' · ' + item.model) + '</span></label>';
  }).join('');
  mask.innerHTML =
    '<div class="modal modal-lg compare-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>多模型对比</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button></div>'
    + '<div class="modal-body" id="compare-body">'
    + '<label class="field"><span>问题（发送给每个所选模型，各自按标准计费）</span><textarea id="compare-q" rows="3" style="resize:vertical"></textarea></label>'
    + '<div class="section-title">选择模型（2–3 个）</div>'
    + '<div class="compare-model-list" id="compare-models">' + options + '</div>'
    + '<div class="form-actions" style="margin-top:10px"><button class="btn primary" id="compare-run" type="button">开始对比</button><span class="muted small" id="compare-status"></span></div>'
    + '<div class="compare-results" id="compare-results"></div>'
    + '</div></div>';
  document.body.appendChild(mask);
  const qEl = mask.querySelector('#compare-q');
  const input = $('input');
  if (qEl && input && input.value.trim()) qEl.value = input.value.trim();
  if (qEl) setTimeout(() => qEl.focus(), 60);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-act="close"]')) mask.remove();
  });
  mask.querySelector('#compare-run').addEventListener('click', async () => {
    const question = (qEl && qEl.value.trim()) || '';
    if (!question) return toast('请先输入问题', true);
    const picks = [];
    mask.querySelectorAll('#compare-models input:checked').forEach((inp) => {
      const [providerId, model] = inp.value.split('\n');
      picks.push({ providerId, model });
    });
    if (picks.length < 2) return toast('请至少勾选 2 个模型', true);
    if (picks.length > 3) return toast('最多对比 3 个模型', true);
    const runBtn = mask.querySelector('#compare-run');
    const status = mask.querySelector('#compare-status');
    const results = mask.querySelector('#compare-results');
    runBtn.disabled = true;
    status.textContent = '正在并行询问 ' + picks.length + ' 个模型…';
    results.innerHTML = picks.map((p, i) =>
      '<div class="compare-card" data-ci="' + i + '"><div class="compare-card-head"><b>' + escapeHtml(p.model) + '</b><span class="muted small" data-el="' + i + '">生成中…</span></div><div class="compare-card-body muted">…</div>'
      + '<div class="compare-card-actions hidden"><button class="btn small" data-vote="up" type="button">👍 这个更好</button><button class="btn small" data-copy type="button">复制</button></div></div>'
    ).join('');
    const cap = Math.min(128000, Math.max(256, Number((state.chatLimits || {}).maxOutputTokens) || 8192));
    const started = Date.now();
    const answers = picks.map((p) => {
      const prov = (state.providers || []).find((x) => x.id === p.providerId);
      const format = (prov && prov.apiFormat) || 'chat';
      const body = { model: p.model, providerId: p.providerId, stream: false, max_tokens: cap, messages: [{ role: 'user', content: question }] };
      return api(ENDPOINT_BY_FORMAT[format] || '/api/proxy/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
        return extractText(data, format) || '（空回复）';
      }).catch((e) => ({ error: (e && e.message) || '请求失败' }));
    });
    const settled = await Promise.all(answers.map((p) => p.catch(() => ({ error: '请求失败' }))));
    const elapsed = Date.now() - started;
    settled.forEach((res, i) => {
      const card = results.querySelector('[data-ci="' + i + '"]');
      if (!card) return;
      const el = card.querySelector('[data-el]');
      const bodyEl = card.querySelector('.compare-card-body');
      const isErr = res && typeof res === 'object' && res.error;
      if (el) el.textContent = isErr ? '失败' : (elapsed + ' ms');
      if (bodyEl) {
        if (isErr) { bodyEl.textContent = '请求失败：' + res.error; bodyEl.classList.add('muted'); }
        else { bodyEl.textContent = res; bodyEl.classList.remove('muted'); }
      }
      const actions = card.querySelector('.compare-card-actions');
      if (actions && !isErr) {
        actions.classList.remove('hidden');
        const voteBtn = actions.querySelector('[data-vote]');
        if (voteBtn) voteBtn.addEventListener('click', async () => {
          voteBtn.disabled = true;
          voteBtn.textContent = '已投票 ✓';
          try { await api('/api/votes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: picks[i].model, to: 'up' }) }); } catch (e) { /* 投票失败不影响对比 */ }
        });
        const copyBtn = actions.querySelector('[data-copy]');
        if (copyBtn) copyBtn.addEventListener('click', () => {
          if (navigator.clipboard) navigator.clipboard.writeText(res).then(() => toast('已复制')).catch(() => {});
        });
      }
    });
    status.textContent = '完成，用时 ' + elapsed + ' ms。点击"这个更好"为满意的模型投票（计入模型评价）。';
    runBtn.disabled = false;
    runBtn.textContent = '再来一轮';
  });
}

// 键盘快捷键
window.OCConversations.initShortcuts({
  onNewChat: () => newChat(),
  onFocusInput: () => { const i = $('input'); i.focus(); },
  onToggleSidebar: () => toggleSidebar(),
  onSend: () => sendMessage(),
});
// ============ 侧边栏折叠 ============
function setSidebarCollapsed(collapsed) {
  const sidebar = $('sidebar');
  sidebar.classList.toggle('collapsed', collapsed);
  const floatBtn = $('sidebar-float-btn');
  if (floatBtn) floatBtn.classList.toggle('hidden', !collapsed);
  // 侧边栏头部按钮图标方向
  localStorage.setItem('oc_sidebar_collapsed', collapsed ? '1' : '0');
}
function toggleSidebar() {
  setSidebarCollapsed(!$('sidebar').classList.contains('collapsed'));
}
(function initSidebar() {
  // 恢复折叠状态
  const saved = localStorage.getItem('oc_sidebar_collapsed');
  if (saved === '1') setSidebarCollapsed(true);
  else setSidebarCollapsed(false);
  const t = $('toggle-sidebar');
  if (t) t.addEventListener('click', toggleSidebar);
  const f = $('sidebar-float-btn');
  if (f) f.addEventListener('click', toggleSidebar);

  // 移动端:侧边栏抽屉 + 遮罩
  const sidebar = $('sidebar');
  const mask = $('sidebar-mask');
  const menuBtn = $('mobile-menu-btn');
  const openMobile = () => {
    sidebar.classList.add('mobile-open');
    if (mask) mask.classList.remove('hidden');
    if (mask) mask.classList.add('show');
  };
  const closeMobile = () => {
    sidebar.classList.remove('mobile-open');
    if (mask) { mask.classList.remove('show'); mask.classList.add('hidden'); }
  };
  if (menuBtn) menuBtn.addEventListener('click', openMobile);
  if (mask) mask.addEventListener('click', closeMobile);
  // 移动端点击会话或选中后自动收起
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 768) return;
    if (e.target.closest('.chat-item') || e.target.closest('.model-picker')) closeMobile();
  });
  // 窗口放大回桌面时重置
  window.addEventListener('resize', () => { if (window.innerWidth > 768) closeMobile(); });

  const toc = $('chat-toc');
  const area = $('chat-area');
  const main = document.querySelector('main.main');
  if (toc && main) {
    let tocLeaveTimer = 0;
    const canShow = () => main.classList.contains('has-toc') && !toc.classList.contains('hidden');
    const enterToc = () => {
      if (tocLeaveTimer) { clearTimeout(tocLeaveTimer); tocLeaveTimer = 0; }
      if (canShow()) toc.classList.add('open');
    };
    const leaveToc = () => {
      tocLeaveTimer = setTimeout(() => toc.classList.remove('open'), 160);
    };
    toc.addEventListener('mouseenter', enterToc);
    toc.addEventListener('mouseleave', leaveToc);
    toc.addEventListener('focusin', enterToc);
    toc.addEventListener('focusout', (e) => {
      if (!toc.contains(e.relatedTarget)) leaveToc();
    });
  }
  if (area) {
    area.addEventListener('scroll', () => {
      if (syncTocTimer) cancelAnimationFrame(syncTocTimer);
      syncTocTimer = requestAnimationFrame(syncTocActive);
    }, { passive: true });
  }

  // ============ 侧边栏拖拽调宽 ============
  const resizer = $('sidebar-resizer');
  if (resizer && sidebar) {
    const MIN_W = 200;
    const MAX_W = 480;
    // 恢复上次宽度
    const savedW = parseInt(localStorage.getItem('oc_sidebar_width') || '', 10);
    if (savedW >= MIN_W && savedW <= MAX_W) {
      sidebar.style.setProperty('--sidebar-w', savedW + 'px');
    }
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      sidebar.classList.add('resizing');
      document.body.classList.add('sidebar-resizing');
      const onMove = (ev) => {
        const w = Math.min(MAX_W, Math.max(MIN_W, startW + (ev.clientX - startX)));
        sidebar.style.setProperty('--sidebar-w', w + 'px');
      };
      const onUp = () => {
        const w = sidebar.getBoundingClientRect().width;
        localStorage.setItem('oc_sidebar_width', String(Math.round(w)));
        sidebar.classList.remove('resizing');
        document.body.classList.remove('sidebar-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ============ 对话列两侧拖拽调宽 ============
  (function initChatResizers() {
    const left = $('chat-resizer-left');
    const right = $('chat-resizer-right');
    const mainEl = document.querySelector('main.main');
    if (!left || !right || !mainEl) return;

    const MIN_W = 480;
    const PAD = 48;
    const root = document.documentElement;

    function mainMax() {
      return Math.max(MIN_W, Math.floor(mainEl.getBoundingClientRect().width - PAD));
    }
    function clampW(w) {
      return Math.round(Math.min(mainMax(), Math.max(MIN_W, w)));
    }
    function applyW(w) {
      root.style.setProperty('--content-w', clampW(w) + 'px');
    }

    const saved = parseInt(localStorage.getItem('oc_content_width') || '', 10);
    if (saved >= MIN_W) applyW(saved);

    function persist() {
      const cur = parseInt(getComputedStyle(root).getPropertyValue('--content-w'), 10);
      if (cur >= MIN_W) localStorage.setItem('oc_content_width', String(cur));
    }

    function startDrag(e, side) {
      if (window.innerWidth <= 768) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(root).getPropertyValue('--content-w'), 10) || 820;
      const sign = side === 'left' ? -2 : 2;
      left.classList.add('active');
      right.classList.add('active');
      document.body.classList.add('chat-resizing');
      const onMove = (ev) => {
        applyW(startW + (ev.clientX - startX) * sign);
      };
      const onUp = () => {
        persist();
        left.classList.remove('active');
        right.classList.remove('active');
        document.body.classList.remove('chat-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    left.addEventListener('mousedown', (e) => startDrag(e, 'left'));
    right.addEventListener('mousedown', (e) => startDrag(e, 'right'));

    function nudge(delta) {
      const cur = parseInt(getComputedStyle(root).getPropertyValue('--content-w'), 10) || 820;
      applyW(cur + delta);
      persist();
    }
    [left, right].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(el === left ? 16 : -16); }
        if (e.key === 'ArrowRight') { e.preventDefault(); nudge(el === left ? -16 : 16); }
      });
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth <= 768) return;
      const cur = parseInt(getComputedStyle(root).getPropertyValue('--content-w'), 10);
      if (cur > mainMax()) applyW(mainMax());
    });
  })();
})();
// 阻止侧边栏收起在移动端的默认行为无碍

const inputEl = $('input');
(function syncComposerPlaceholder() {
  const desktop = inputEl.dataset.placeholderDesktop || '';
  const mobile = inputEl.dataset.placeholderMobile || '';
  const apply = () => {
    const narrow = window.matchMedia('(max-width: 768px)').matches;
    inputEl.placeholder = narrow ? mobile : desktop;
  };
  apply();
  const mq = window.matchMedia('(max-width: 768px)');
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else mq.addListener(apply);
})();
inputEl.addEventListener('input', () => {
  autosizeInput();
  updateSendBtn();
  syncMentionFromInput();
});
function updateSendBtn() {
  const btn = $('send-btn');
  if (!btn) return;
  const readyAttach = (state.pendingAttachments || []).filter((a) => a && !a.parsing);
  const hasText = !!inputEl.value.trim();
  const hasAttach = readyAttach.length > 0;
  const canSend = hasText || hasAttach;
  btn.disabled = !canSend && !state.streaming;
  btn.classList.toggle('muted', !canSend && !state.streaming);
}
(function bindComposerEffort() {
  const btn = $('composer-effort');
  const pop = $('effort-pop');
  if (!btn || !pop) return;
  const close = () => {
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    syncComposerEffort();
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop.classList.contains('hidden')) open();
    else close();
  });
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-effort]');
    if (!opt) return;
    e.preventDefault();
    setEffortMode(opt.dataset.effort);
    close();
  });
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (e.target.closest('.effort-wrap')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  syncComposerEffort();
})();
(function bindComposerWebSearch() {
  const btn = $('composer-websearch');
  const pop = $('websearch-pop');
  if (!btn || !pop) return;
  const close = () => {
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    syncComposerWebSearch();
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!searchReady()) {
      const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
      toast(own ? '还没有可用的自备检索配置' : '管理员尚未配置联网搜索', true);
      return;
    }
    if (pop.classList.contains('hidden')) open();
    else close();
  });
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-websearch]');
    if (!opt) return;
    e.preventDefault();
    setWebSearchMode(opt.dataset.websearch);
    close();
  });
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (e.target.closest('.websearch-wrap')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  syncComposerWebSearch();
})();
function assistantCatName(id) {
  const c = (state.assistantCategories || []).find((x) => x.id === id);
  return c ? c.name : '';
}
function mentionQuery() {
  const el = inputEl;
  if (!el) return null;
  // 生图/生视频模型不使用助手,选中时不再弹出 @助手 候选
  if (modelIsVisual(state.currentModel)) return null;
  const pos = typeof el.selectionStart === 'number' ? el.selectionStart : String(el.value || '').length;
  const before = String(el.value || '').slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at === 0 ? '' : before.charAt(at - 1);
  if (prev && /[^\s(\[（【]/.test(prev)) return null;
  const q = before.slice(at + 1);
  if (/[\s\n]/.test(q)) return null;
  if (q.length > 24) return null;
  return { start: at, q: q };
}
function mentionCandidates(q) {
  const kw = String(q || '').trim().toLowerCase();
  const list = (state.assistants || []).filter((a) => {
    if (!kw) return true;
    return [a.name, a.desc, assistantCatName(a.categoryId)].some((s) => String(s || '').toLowerCase().includes(kw));
  });
  const none = { id: '', name: '不使用助手', desc: '普通对话，不注入系统提示', icon: '💬', _none: true };
  const ranked = list.slice().sort((a, b) => {
    const an = String(a.name || '');
    const bn = String(b.name || '');
    if (!kw) return (a.sort - b.sort) || an.localeCompare(bn, 'zh');
    const ap = an.toLowerCase().startsWith(kw) ? 0 : 1;
    const bp = bn.toLowerCase().startsWith(kw) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.sort - b.sort) || an.localeCompare(bn, 'zh');
  });
  return [none].concat(ranked.slice(0, 12));
}
function closeMention() {
  state.mention = { open: false, q: '', index: 0, start: -1 };
  const pop = $('mention-pop');
  if (pop) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }
}
function renderMention() {
  const pop = $('mention-pop');
  if (!pop) return;
  if (!state.mention.open) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
    return;
  }
  const items = mentionCandidates(state.mention.q);
  if (!items.length) {
    pop.innerHTML = '<div class="mention-empty">没有匹配的助手</div>';
    pop.classList.remove('hidden');
    return;
  }
  if (state.mention.index < 0) state.mention.index = 0;
  if (state.mention.index >= items.length) state.mention.index = items.length - 1;
  pop.innerHTML = '<div class="mention-head"><b>选择助手</b><span>↑↓ 回车 · Esc</span></div>' + items.map((a, i) =>
    '<button type="button" class="mention-item' + (i === state.mention.index ? ' active' : '') + '" data-idx="' + i + '" role="option" aria-selected="' + (i === state.mention.index ? 'true' : 'false') + '">'
    + '<span class="mention-ico">' + escapeHtml(a.icon || '✨') + '</span>'
    + '<span class="mention-text"><span class="mention-name">' + escapeHtml(a.name || '') + '</span>'
    + '<span class="mention-desc">' + escapeHtml(a.desc || assistantCatName(a.categoryId) || '') + '</span></span></button>'
  ).join('');
  pop.classList.remove('hidden');
  const active = pop.querySelector('.mention-item.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function openMention(q, start) {
  state.mention = { open: true, q: q || '', index: 0, start: start == null ? -1 : start };
  renderMention();
}
function syncMentionFromInput() {
  const hit = mentionQuery();
  if (!hit) {
    if (state.mention.open) closeMention();
    return;
  }
  state.mention.open = true;
  state.mention.q = hit.q;
  state.mention.start = hit.start;
  if (!state.mention.index) state.mention.index = 0;
  renderMention();
}
function pickMention(item) {
  const el = inputEl;
  const start = state.mention.start;
  if (el && start >= 0) {
    const pos = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    el.value = el.value.slice(0, start) + el.value.slice(pos);
    el.selectionStart = el.selectionEnd = start;
  }
  closeMention();
  if (item && item._none) useAssistantOnChat(null);
  else if (item) useAssistantOnChat(item);
  autosizeInput();
  updateSendBtn();
  if (el) el.focus();
}
function ensureAssistantsLoaded() {
  if ((state.assistants || []).length) return Promise.resolve();
  return loadDefaultAssistant();
}
const mentionPop = $('mention-pop');
if (mentionPop) {
  mentionPop.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.mention-item');
    if (!btn) return;
    e.preventDefault();
    const items = mentionCandidates(state.mention.q);
    pickMention(items[Number(btn.dataset.idx)]);
  });
}
inputEl.addEventListener('keydown', (e) => {
  if (state.mention.open) {
    const items = mentionCandidates(state.mention.q);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.mention.index = Math.min(items.length - 1, state.mention.index + 1);
      renderMention();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.mention.index = Math.max(0, state.mention.index - 1);
      renderMention();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(items[state.mention.index] || items[0]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const chat = currentChat();
    const hasAssistant = !!(chat && chat.assistantId);
    const caretAtStart = (inputEl.selectionStart || 0) === 0 && (inputEl.selectionEnd || 0) === 0;
    const empty = !String(inputEl.value || '');
    if (hasAssistant && (empty || (e.key === 'Backspace' && caretAtStart))) {
      const now = Date.now();
      if (state.clearAssistantAt && now - state.clearAssistantAt < 700) {
        e.preventDefault();
        state.clearAssistantAt = 0;
        useAssistantOnChat(null);
        return;
      }
      state.clearAssistantAt = now;
    } else {
      state.clearAssistantAt = 0;
    }
  } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
    state.clearAssistantAt = 0;
  }
});
inputEl.addEventListener('focus', () => {
  if (mentionQuery()) syncMentionFromInput();
});
inputEl.addEventListener('blur', () => {
  setTimeout(() => closeMention(), 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '@' && !(e.shiftKey && e.key === '2' && e.code === 'Digit2')) return;
  if (document.activeElement !== inputEl) return;
  ensureAssistantsLoaded().then(() => {
    setTimeout(() => syncMentionFromInput(), 0);
  });
});
function autosizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

// ============ 游客 / 未登录 ============
let AUTH_MODAL_BOUND = false;
function openAuthModal(message) {
  const modal = $('auth-modal');
  if (!modal) { location.href = apiUrl('/login'); return; }
  const err = $('auth-modal-error');
  if (err) {
    err.textContent = message || '';
    err.classList.toggle('hidden', !message);
  }
  if (!AUTH_MODAL_BOUND && window.OCUI) {
    AUTH_MODAL_BOUND = true;
    window.OCUI.bindModal(modal, { closeId: 'auth-modal-close' });
    const form = $('auth-modal-login');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('am-name') && $('am-name').value.trim()) || '';
      const pass = ($('am-pass') && $('am-pass').value) || '';
      if (!name || !pass) { if (err) { err.textContent = '请输入用户名和密码'; err.classList.remove('hidden'); } return; }
      const btn = $('am-login-btn');
      if (btn) btn.disabled = true;
      try {
        const r = await fetch(apiUrl('/api/auth/login'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password: pass }),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '登录失败');
        localStorage.setItem('oc_token', d.token);
        localStorage.setItem('oc_user', JSON.stringify(d.user || {}));
        location.reload();
      } catch (ex) {
        if (err) { err.textContent = ex.message; err.classList.remove('hidden'); }
        if (btn) btn.disabled = false;
      }
    });
    const goReg = $('am-go-register');
    if (goReg) goReg.addEventListener('click', (e) => { e.preventDefault(); location.href = apiUrl('/login'); });
  }
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}
function showGuestBar() {
  const bar = $('guest-bar');
  if (!bar) return;
  const txt = $('guest-bar-text');
  const left = state.user ? state.user.quota : 0;
  if (txt) {
    txt.textContent = (state.isGuestExpired || (Number.isFinite(left) && left <= 0))
      ? '游客体验次数已用完，登录后可继续对话'
      : '您正在以游客身份体验，剩余 ' + left + ' 轮'
        + (state.guestRounds ? '（开通账号可无限使用）' : '');
  }
  bar.classList.remove('hidden');
  const btn = $('guest-bar-login');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => openAuthModal());
  }
}
// 未登录且未开启游客模式:正常显示对话主页(只读),点击输入框/发送弹出登录弹窗
function enterReadonlyHome() {
  state.readonlyGuest = true;
  document.body.classList.add('readonly-guest');
  const composer = document.querySelector('.composer-wrap') || document.querySelector('.composer');
  if (composer) {
    composer.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAuthModal();
    }, true);
  }
  const input = $('input');
  if (input) {
    input.setAttribute('readonly', 'readonly');
    input.addEventListener('focus', (e) => { input.blur(); openAuthModal(); });
  }
  const send = $('send-btn');
  if (send) send.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAuthModal(); }, true);
  document.querySelectorAll('#new-chat, #assistant-lib-btn, #account-chip').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAuthModal(); }, true);
  });
}

// ============ 启动 ============
(async function init() {
  initTheme();
  if (!state.token) {
    let cfg = null;
    try {
      const cr = await fetch(apiUrl('/api/config'));
      cfg = await readJsonSafe(cr);
    } catch (e) { cfg = null; }
    if (cfg && cfg.guestEnabled) {
      // 开启游客模式:为本次访客自动创建一个独立游客账号,便于后台管理
      try {
        const gr = await fetch(apiUrl('/api/auth/guest'), { method: 'POST' });
        const gd = await readJsonSafe(gr);
        if (gr.ok && gd.token) {
          state.token = gd.token;
          localStorage.setItem('oc_token', gd.token);
          state.isGuest = true;
          state.guestRounds = gd.rounds || 0;
        }
      } catch (e) { /* 落到只读首页 */ }
    }
    if (!state.token) {
      // 未开启游客:直接显示对话主页(不再强制跳转登录页),点击输入框再弹登录
      enterReadonlyHome();
      return;
    }
  }
  try {
    const r = await api('/api/auth/me');
    const data = await r.json();
    if (!r.ok) throw new Error('invalid');
    state.user = data.user;
    if (state.user && state.user.guest) { state.isGuest = true; state.guestRounds = state.guestRounds || 0; }
    if (data.tools) state.tools = data.tools;
    // 启动时必须带上用量数据,否则设置→用量/账户面板在首次刷新前显示为 0
    state.usage = Array.isArray(data.usage) ? data.usage : [];
    renderUser();
    renderUsageLedger();
    loadChats();
    renderChatList();
    state._scrollHistoryToBottom = true;
    renderMessages();
    renderEmptyState();
    // 云同步:登录后先拉取云端聊天记录并合并(await 保证完成,避免后续盲推覆盖云端)
    await pullChatsFromCloud();
    try { await loadProviders(); } catch (e) { toast('供应商加载失败，已保留登录状态，请稍后重试', true); }
    await loadDefaultAssistant();
    if (ensureDefaultAssistantOnBlank()) {
      saveChats();
      updateAssistantChip();
    }
    resumePendingTasks();
    if (!state.currentProviderId) {
      toast('暂无可用的 API 供应商,请点击左下角「设置」添加,或等待管理员配置', true);
    }
    // 拉取合并后 push 由 saveChats/scheduleCloudSync 增量触发,无需盲推
    updateSendBtn();
    if (typeof syncComposerEffort === 'function') syncComposerEffort();
    if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
    if (state.isGuest) showGuestBar();
  } catch (e) {
    // 令牌失效或接口异常:清掉令牌回到只读首页并提示登录,而不是硬跳转到独立登录页
    localStorage.removeItem('oc_token');
    localStorage.removeItem('oc_user');
    state.token = '';
    state.user = null;
    enterReadonlyHome();
    openAuthModal('登录状态已失效，请重新登录');
  }
})();