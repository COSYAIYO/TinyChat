'use strict';
const $ = (id) => document.getElementById(id);

const cacheKey = 'oc_token';

if (window.OCUI && typeof window.OCUI.initTheme === 'function') {
  window.OCUI.initTheme();
}

function showError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
function clearError() {
  $('auth-error').classList.add('hidden');
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.classList.toggle('is-loading', busy);
  btn.textContent = busy ? '请稍候…' : label;
}

async function submitAuth(api, name, password, btn, label, email, extra) {
  clearError();
  setBusy(btn, true, label);
  try {
    const r = await fetch(apiUrl(api), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(email ? { name, password, email } : { name, password }, typeof extra === 'object' && extra ? extra : {})),
    });
    const data = await r.json();
    if (!r.ok) {
      showError((data.error && data.error.message) || '请求失败');
      return;
    }
    if (data.pendingVerification) {
      showError('注册成功，请查收验证邮件并完成邮箱验证后登录');
      return;
    }
    localStorage.setItem(cacheKey, data.token);
    localStorage.setItem('oc_user', JSON.stringify(data.user));
    location.href = apiUrl('/');
  } catch (e) {
    showError('网络错误: ' + e.message + (location.protocol === 'file:' ? '（file:// 打开时请先设置 localStorage.setItem(\'oc_api_base\', \'http://你的地址:3000\')）' : ''));
  } finally {
    setBusy(btn, false, label);
  }
}

function switchAuthForm(showId, hideId, focusId) {
  ['forgot-form', 'reset-form'].forEach((id) => { const e=$(id); if(e) e.classList.add('hidden'); });
  const show = $(showId);
  const hide = $(hideId);
  if (!show || !hide) return;
  hide.classList.add('hidden');
  show.classList.remove('hidden');
  show.classList.remove('auth-form-switching');
  void show.offsetWidth;
  show.classList.add('auth-form-switching');
  const switchEl = $('login-switch');
  if (switchEl) switchEl.classList.toggle('hidden', showId === 'register-form');
  clearError();
  const focus = $(focusId);
  if (focus) setTimeout(() => focus.focus(), 40);
}

function bindPasswordToggles() {
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.for);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.title = show ? '隐藏密码' : '显示密码';
      const off = btn.querySelector('.eye-off');
      const on = btn.querySelector('.eye-on');
      if (off) off.classList.toggle('hidden', show);
      if (on) on.classList.toggle('hidden', !show);
    });
  });
}

const verifyToken = new URLSearchParams(location.search).get('verify');
const resetToken = new URLSearchParams(location.search).get('reset');
// 游客持令牌访问登录页:不重定向,并直接展示注册表单(游客无密码,登录表单对其无用)。
// 若这里把游客弹回首页,从游客条点「注册」就会陷入
// 「跳转登录页 → 判定已登录 → 跳回首页」的死循环,永远进不了注册表单。
let guestSession = false;
function showRegisterForGuest() {
  if (!guestSession) return;
  const reg = $('register-form');
  if (reg && !reg.classList.contains('hidden')) return;   // 已在注册表单
  if ($('show-register')) switchAuthForm('register-form', 'login-form', 'reg-name');
}
if (!verifyToken && !resetToken && localStorage.getItem(cacheKey)) {
  fetch(apiUrl('/api/auth/me'), { headers: { Authorization: 'Bearer ' + localStorage.getItem(cacheKey) } })
    .then((r) => r.ok ? r.json() : Promise.reject())
    .then((d) => {
      if (d && d.user && d.user.guest) { guestSession = true; showRegisterForGuest(); return; }
      location.href = apiUrl('/');
    })
    .catch(() => localStorage.removeItem(cacheKey));
}

fetch(apiUrl('/api/config')).then((r) => r.json()).then((cfg) => {
  // 找回密码依赖邮件功能:开关关闭或未配置 SMTP 时,前台不展示"忘记密码"入口
  if (cfg && (cfg.passwordResetEnabled === false || cfg.mailReady === false)) {
    const forgotLink = $('show-forgot');
    const wrap = forgotLink ? forgotLink.closest('.auth-switch') : null;
    if (wrap) wrap.classList.add('hidden');
  }
  // 站点关闭注册时,隐藏注册切换与注册表单(后端同样会拒绝,这里提前不给入口)
  if (cfg && cfg.allowRegister === false) {
    const showReg = $('show-register');
    const regWrap = showReg ? showReg.closest('.auth-switch') : null;
    if (regWrap) regWrap.classList.add('hidden');
    const reg = $('register-form');
    if (reg) { reg.classList.add('hidden'); }
    const login = $('login-form');
    if (login) login.classList.remove('hidden');
  }
  // 用户协议:启用时注册页展示勾选项
  if (cfg && cfg.agreementEnabled) {
    const row = $('reg-agree-row');
    if (row) row.classList.remove('hidden');
  }
  // 注册邀请码:启用时注册页展示输入框
  if (cfg && cfg.registerInviteRequired) {
    const row = $('reg-invite-row');
    if (row) row.classList.remove('hidden');
  }
  // 配置就绪后再兜一次(此时注册表单的协议/邀请码等已按需显示)
  showRegisterForGuest();
  if (!cfg || !cfg.needsSetup) return;
  showEnvGate();
}).catch(() => {
  // 配置读取失败(如存储引擎不可用)时同样展示自检,便于定位
  showEnvGate();
});

// 首次安装流程:先展示环境自检,全部通过并点击「下一步」后才进入管理员创建
function showEnvGate() {
  const box = $('env-check-box');
  const setup = $('setup-form');
  const login = $('login-form');
  const reg = $('register-form');
  const sw = $('login-switch');
  if (box) box.classList.remove('hidden');
  if (setup) setup.classList.add('hidden');
  if (login) login.classList.add('hidden');
  if (reg) reg.classList.add('hidden');
  if (sw) sw.classList.add('hidden');
  runEnvCheck();
}
function proceedToSetup() {
  const box = $('env-check-box');
  if (box) box.classList.add('hidden');
  const setup = $('setup-form');
  if (setup) {
    setup.classList.remove('hidden');
    const name = $('setup-name');
    if (name) setTimeout(() => name.focus(), 40);
  }
}
function escLogin(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function runEnvCheck() {
  const box = $('env-check-box');
  const list = $('env-check-list');
  if (!box || !list) return;
  box.classList.remove('hidden');
  list.innerHTML = '<span class="muted">正在检查运行环境…</span>';
  const next = $('env-check-next');
  if (next) next.classList.add('hidden');
  fetch(apiUrl('/api/env-check')).then((r) => r.json()).then((d) => {
    const checks = d.checks || [];
    list.innerHTML = checks.map((c) => {
      const mark = c.ok ? '<span style="color:#16a34a">✓</span>' : (c.critical ? '<span style="color:#dc2626">✗</span>' : '<span style="color:#d97706">△</span>');
      return '<div>' + mark + ' ' + escLogin(c.name) + (c.detail ? ' <span class="muted small">' + escLogin(c.detail) + '</span>' : '') + '</div>';
    }).join('');
    const blocked = (checks || []).some((c) => c.critical && !c.ok);
    const status = $('env-check-status');
    const retry = $('env-check-retry');
    const setup = $('setup-form');
    if (status) status.textContent = blocked
      ? '存在未通过的关键项，请按提示处理后点「重新检查」'
      : '环境检查全部通过';
    if (retry) retry.classList.toggle('hidden', !blocked);
    if (next) next.classList.toggle('hidden', blocked);
    if (setup && !blocked) return; // 等待用户点「下一步」
  }).catch(() => {
    const list2 = $('env-check-list');
    if (list2) list2.innerHTML = '<span style="color:#dc2626">✗ 无法读取环境检查结果，请刷新重试</span>';
  });
}
if ($('env-check-retry')) $('env-check-retry').addEventListener('click', () => runEnvCheck());
if ($('env-check-next')) $('env-check-next').addEventListener('click', () => proceedToSetup());

bindPasswordToggles();
const forgotForm = $('forgot-form');
const resetForm = $('reset-form');
const showForgot = $('show-forgot');
if (showForgot) showForgot.addEventListener('click', (e) => { e.preventDefault(); $('login-form').classList.add('hidden'); $('register-form').classList.add('hidden'); forgotForm.classList.remove('hidden'); clearError(); });
if ($('forgot-back')) $('forgot-back').addEventListener('click', (e) => { e.preventDefault(); forgotForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (forgotForm) forgotForm.addEventListener('submit', async (e) => { e.preventDefault(); const r=await fetch(apiUrl('/api/auth/forgot-password'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('forgot-email').value.trim()})}); const d=await r.json(); if(!r.ok)return showError((d.error&&d.error.message)||'发送失败'); showError('如果邮箱存在，重置链接已发送。'); });
if (resetToken) { $('login-form').classList.add('hidden'); $('register-form').classList.add('hidden'); resetForm.classList.remove('hidden'); }
if ($('reset-back')) $('reset-back').addEventListener('click', (e) => { e.preventDefault(); resetForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (resetForm) resetForm.addEventListener('submit', async (e) => { e.preventDefault(); if($('reset-password').value !== $('reset-password2').value)return showError('两次密码不一致'); const r=await fetch(apiUrl('/api/auth/reset-password'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:resetToken,password:$('reset-password').value})}); const d=await r.json(); if(!r.ok)return showError((d.error&&d.error.message)||'重置失败'); showError('密码已重置，请返回登录。'); resetForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (verifyToken) fetch(apiUrl('/api/auth/verify-email'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: verifyToken }) }).then((r) => r.json().then((d) => r.ok ? showError('邮箱验证成功，请登录') : showError((d.error && d.error.message) || '验证失败'))).catch(() => showError('验证请求失败'));

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth('/api/auth/login', $('login-name').value.trim(), $('login-password').value, $('login-btn'), '登录');
});

if ($('setup-form')) {
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAuth('/api/setup', $('setup-name').value.trim(), $('setup-password').value, $('setup-btn'), '创建管理员');
  });
}

$('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth('/api/auth/register', $('reg-name').value.trim(), $('reg-password').value, $('register-btn'), '注册并登录', $('reg-email') ? $('reg-email').value.trim() : '', {
    agreementAccepted: !!($('reg-agree') && $('reg-agree').checked),
    invite: ($('reg-invite') && $('reg-invite').value.trim()) || '',
  });
});

$('show-register').addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthForm('register-form', 'login-form', 'reg-name');
});
$('show-login').addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthForm('login-form', 'register-form', 'login-name');
});
