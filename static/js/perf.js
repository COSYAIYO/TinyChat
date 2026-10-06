'use strict';
/**
 * perf.js — 前台性能优化门控
 *
 * 后台「平台配置 → 性能优化」可开启若干开关(默认关闭)。前台需要尽早决定是否加载
 * 渲染引擎依赖(markdown-it 始终需要;KaTeX / highlight.js 可关),因此这里:
 *   1. 从 localStorage['oc_cfg'] 同步读取上次缓存的公开配置(后端 /api/config 已写入);
 *   2. 用同步 document.write 按需注入渲染依赖(必须在 <head> 里同步执行);
 *   3. 页面就绪后异步刷新配置;若性能开关相对缓存有变化,则整页重载一次(带重入保护)。
 *
 * 必须在 index.html / login.html / share.html 的 <head> 中、渲染依赖之前同步引入。
 */
(function () {
  var perf = { noWebfonts: false, noKatex: false, noHighlight: false, noMermaid: false };
  try {
    var cached = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
    if (cached && cached.perf && typeof cached.perf === 'object') {
      perf = {
        noWebfonts: !!cached.perf.noWebfonts,
        noKatex: !!cached.perf.noKatex,
        noHighlight: !!cached.perf.noHighlight,
        noMermaid: !!cached.perf.noMermaid,
      };
    }
  } catch (e) { /* 忽略 */ }
  window.OC_PERF = perf;

  // 按需注入渲染引擎依赖。顺序敏感:markdown-it 基础 → 插件 → KaTeX/highlight。
  // 仅在文档解析阶段(本脚本在 <head> 同步执行)调用 document.write 才是安全的。
  // 分享页在 /s/、/n/(笔记分享)路径下,资源用绝对路径;主站用相对路径。
  var base = (location.pathname.indexOf('/s/') === 0 || location.pathname.indexOf('/n/') === 0) ? '/vendor/' : './vendor/';
  function ws(path) {
    // 静态资源走长缓存,发版靠 ?v= 刷新(theme-boot.js 从自身 URL 提取版本)
    var v = window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : '';
    document.write('<script defer src="' + base + path + v + '"><\/script>');
  }
  ws('markdown-it/markdown-it.min.js');
  ws('markdown-it/markdown-it-footnote.min.js');
  ws('markdown-it/markdown-it-emoji.min.js');
  // HTML 消毒(对话页/分享页允许模型与用户输出原始 HTML,渲染前必须过它)。
  // 始终加载:不是可关闭的性能项,而是渲染管线的安全底线。
  ws('dompurify/purify.min.js');
  if (!perf.noKatex) {
    ws('katex/katex.min.js');
    ws('katex/auto-render.min.js');
  }
  if (!perf.noHighlight) ws('highlight/highlight.min.js');

  // 后台可能刚改过设置:异步拉一次最新配置,与缓存比对;开关变化则重载生效。
  function refresh() {
    try {
      fetch((window.API_BASE || '') + '/api/config', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          if (!cfg || typeof cfg !== 'object') return;
          try { localStorage.setItem('oc_cfg', JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
          var p = cfg.perf || {};
          var cur = window.OC_PERF || {};
          var changed = !!p.noKatex !== !!cur.noKatex
            || !!p.noHighlight !== !!cur.noHighlight
            || !!p.noWebfonts !== !!cur.noWebfonts
            || !!p.noMermaid !== !!cur.noMermaid;
          if (changed && sessionStorage.getItem('oc_perf_reloaded') !== '1') {
            sessionStorage.setItem('oc_perf_reloaded', '1');
            location.reload();
          } else if (!changed) {
            sessionStorage.removeItem('oc_perf_reloaded');
          }
        })
        .catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();

  // ---- 拓展开关的按人判定入口 ----
  // 「仅管理员 / 仅名单」这层判定因人而异,/api/config 是匿名的发不出来,所以由 /api/me
  // 的结果写进 oc_cfg.features。各功能模块在自己入口处问这里,并在 oc:features 事件里重判 ——
  // 否则会出现「入口已渲染、权限随后才到」时该隐藏却没隐藏。
  window.OCFeatures = {
    allowed: function (name) {
      try {
        var cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
        var f = cfg && cfg.features;
        if (f && typeof f[name] === 'boolean') return f[name];
      } catch (e) { /* 忽略 */ }
      return true;   // 拿不到按人结果时先放行,由服务端兜底(它有权威判定)
    },
    // app.js 拿到 /api/me 后调用:写入并广播,让已经渲染过的入口重新对齐
    set: function (features) {
      if (!features || typeof features !== 'object') return;
      try {
        var cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
        if (!cfg || typeof cfg !== 'object') cfg = {};
        cfg.features = features;
        localStorage.setItem('oc_cfg', JSON.stringify(cfg));
      } catch (e) { /* 忽略 */ }
      try { window.dispatchEvent(new CustomEvent('oc:features', { detail: features })); } catch (e) { /* 忽略 */ }
    },
  };
})();
