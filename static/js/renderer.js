'use strict';
/**
 * renderer.js — 可扩展 Markdown 渲染引擎
 * 基于 markdown-it + 插件体系：
 *  - Markdown 完整渲染（GFM：表格/任务列表/删除线/脚注）
 *  - LaTeX 公式（KaTeX，行内 $...$ 与块级 $$...$$）
 *  - 代码块语法高亮（highlight.js）+ 语言标签 + 复制按钮
 *  - Mermaid 图表渲染
 *  - 自定义组件容器（::: 语法 + 组件注册表，便于扩展）
 *  - 图片灯箱、引用块、锚点
 * 离线可用（依赖本地 vendor 库）
 */

(function () {
  const R = {};

  // ============ 组件注册表（自定义容器，便于扩展） ============
  // 用法：::: component-name 参数
  //        内容
  //       :::
  R.components = {};

  R.registerComponent = function (name, renderer) {
    R.components[name] = renderer;
  };

  // 归一化代码块语言标识:模型常写成 ```Mermaid / ```MERMAID / ```mmd,统一按小写识别
  // 内容兜底识别:语言标识缺失或不被认识时,靠首行关键字判断是不是 mermaid 源码。
  // 只在「第一个非空行」上匹配,避免把正文里提到 xychart 的普通代码块误判成图表。
  const MERMAID_HEAD = /^(xychart-beta|xychart|pie|gantt|timeline|journey|quadrantchart|quadrant-chart|sankey-beta|sankey|packet-beta|packet|architecture-beta|architecture|block-beta|block|kanban|radar-beta|radar|treemap-beta|treemap|gitgraph|mindmap|requirementdiagram|requirement|erdiagram|er|classdiagram|class|statediagram|stateDiagram-v2|state|sequencediagram|sequence|flowchart-v2|flowchart|graph|info|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/i;
  function looksLikeMermaid(code) {
    const firstLine = String(code || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || '';
    if (firstLine === '' || firstLine.length > 60) return false;
    return MERMAID_HEAD.test(firstLine);
  }

  // 归一化代码块语言标识:模型常写成 ```Mermaid / ```MERMAID / ```mmd,统一按小写识别。
  // 模型也常直接用 mermaid 的「图类型」当语言名(```xychart-beta / ```pie / ```gantt),
  // 这些同样要按 mermaid 处理,否则会被当成普通代码块原样显示(图表不渲染)。
  // 清单覆盖 mermaid 11 支持的全部图类型。
  const MERMAID_LANGS = {
    mermaid: 1, mmd: 1,
    graph: 1, flowchart: 1, 'flowchart-v2': 1,
    sequence: 1, sequencediagram: 1, class: 1, classdiagram: 1,
    state: 1, statediagram: 1, 'state-diagram': 1, er: 1, erdiagram: 1,
    pie: 1, quadrant: 1, quadrantchart: 1, xychart: 1, 'xychart-beta': 1,
    gantt: 1, timeline: 1, journey: 1,
    mindmap: 1, mindmap2: 1, gitgraph: 1, requirement: 1, requirementdiagram: 1,
    c4: 1, c4context: 1, c4container: 1, c4component: 1, c4dynamic: 1, c4deployment: 1,
    sankey: 1, 'sankey-beta': 1, packet: 1, 'packet-beta': 1,
    architecture: 1, 'architecture-beta': 1, block: 1, 'block-beta': 1,
    kanban: 1, radar: 1, 'radar-beta': 1, treemap: 1, 'treemap-beta': 1,
  };
  function normalizeFenceLang(lang) {
    const l = String(lang == null ? '' : lang).trim().toLowerCase().split(/\s+/)[0] || '';
    if (MERMAID_LANGS[l]) return 'mermaid';
    if (l === 'mind-map') return 'mindmap';
    return l;
  }

  // 围栏语言位写的是「图类型」时(如 xychart-beta),markdown-it 会把它从内容里剥掉,
  // 而 mermaid 需要它作为首行声明 —— 这里补回去。语言位本来就是 mermaid/mmd 的不用补。
  function restoreMermaidType(code, lang) {
    const l = String(lang == null ? '' : lang).trim().split(/\s+/)[0] || '';
    const lower = l.toLowerCase();
    if (lower === 'mermaid' || lower === 'mmd' || lower === '') return code;
    if (!MERMAID_LANGS[lower]) return code;
    const trimmed = String(code).replace(/^\s*\n/, '');
    // 内容首行已经是图类型声明时不重复添加
    if (looksLikeMermaid(trimmed)) return trimmed;
    return l + '\n' + trimmed;
  }

  // ============ markdown-it 实例 ============
  let md = null;

  function initMarkdown() {
    if (md || typeof markdownit === 'undefined') return md;
    md = markdownit({
      html: true,
      linkify: true,
      typographer: true,
      breaks: true,
      highlight: function (code, lang) {
        // Mermaid / 思维导图特殊处理：保留 language-* class 供后续渲染(语言标识大小写不敏感)
        const fenceLang = normalizeFenceLang(lang);
        if (fenceLang === 'mermaid') {
          // 重要:模型常把图类型写在围栏语言位上(```xychart-beta / ```pie / ```gantt),
          // 而 markdown-it 会把围栏语言从内容里剥掉。mermaid 又要求源码第一行必须是图类型声明,
          // 少了这一行必然解析失败。因此这里把「图类型」补回代码首行。
          const codeWithType = restoreMermaidType(String(code), lang);
          return '<pre class="mermaid-pre"><code class="language-mermaid">' + escapeHtml(codeWithType) + '</code></pre>';
        }
        if (fenceLang === 'mindmap') {
          return '<pre class="mindmap-pre"><code class="language-mindmap">' + escapeHtml(code) + '</code></pre>';
        }
        // 语法高亮(highlight.js 可能被后台关闭:此时降级为转义后的纯文本)
        let highlighted = '';
        const hasHljs = (typeof hljs !== 'undefined') && hljs;
        if (hasHljs && lang && hljs.getLanguage(lang)) {
          try { highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; }
          catch (e) { highlighted = escapeHtml(code); }
        } else if (hasHljs) {
          // 自动识别语言
          try { highlighted = hljs.highlightAuto(code).value; }
          catch (e) { highlighted = escapeHtml(code); }
        } else {
          highlighted = escapeHtml(code);
        }
        // 语言标签 + 复制按钮（由外部 CSS/JS 增强）
        const langLabel = lang || 'text';
        return '<div class="code-block" data-lang="' + escapeAttr(langLabel) + '">'
          + '<div class="code-header"><span class="code-lang">' + escapeHtml(langLabel) + '</span>'
          + copyButtonHtml('复制代码') + '</div>'
          + '<pre><code class="hljs">' + highlighted + '</code></pre>'
          + '</div>';
      },
    });

    // GFM 支持
    if (window.markdownitFootnote) md.use(window.markdownitFootnote);
    if (window.markdownitEmoji) md.use(window.markdownitEmoji);

    // 表格美化 + 滚动容器
    const defaultTableOpen = md.renderer.rules.table_open || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
      return '<div class="table-wrap"><table>';
    };
    md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
      return '</table></div>';
    };

    // 图片：灯箱支持
    const defaultImage = md.renderer.rules.image || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    md.renderer.rules.image = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      const src = token.attrGet('src');
      const alt = token.content || '';
      const title = token.attrGet('title') || alt;
      return '<figure class="md-image"><img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '" loading="lazy" data-lightbox="' + escapeAttr(src) + '">'
        + (title ? '<figcaption>' + escapeHtml(title) + '</figcaption>' : '')
        + '</figure>';
    };

    // 链接：新窗口打开
    const defaultLink = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLink(tokens, idx, options, env, self);
    };

    return md;
  }

  // ============ 自定义容器（::: name）预处理方案 ============
  // 在渲染前提取 ::: 块为占位符，md.render 后再还原为组件 HTML。
  // 相比 block.ruler 更稳，避免 markdown-it 逐行重复触发的问题。
  // 注意：内容会先被 markdown-it 转义，因此组件收到底层 HTML 而非原始文本；
  // 组件内如需原始 Markdown 请在内容中使用 !! 前缀标记为源码模式。
  const COMPONENT_RE = /^:::\s*([\w-]+)(?:\s+([^\n]*))?\n([\s\S]*?)\n:::\s*$/gm;

  function preprocessContainers(text) {
    const placeholders = [];
    let result = text.replace(COMPONENT_RE, function (m, name, params, body) {
      const id = 'OC_COMP_' + placeholders.length;
      placeholders.push({ id, name, params: (params || '').trim(), body });
      return '\n\n' + id + '\n\n';
    });
    return { result, placeholders };
  }

  function renderContainers(html, placeholders) {
    let out = html;
    placeholders.forEach((p) => {
      // 占位符可能会被包进 <p>…</p>，需要去掉外层标签
      const escaped = escapeHtml(p.id);
      const wrapped = new RegExp('<p>' + escaped + '<\\/p>', 'g');
      out = out.replace(wrapped, function () {
        if (R.components[p.name]) {
          const htmlOut = R.components[p.name]({ params: p.params, body: p.body, html: p.body });
          // 组件返回 undefined 时用原始 body
          return htmlOut !== undefined ? htmlOut : '<div class="unknown-component">' + escapeHtml(p.body) + '</div>';
        }
        return '<div class="unknown-component"><strong>' + escapeHtml(p.name) + '</strong>（未注册组件）</div>';
      });
      // 若占位符没被 <p> 包裹，直接替换
      out = out.split(escaped).join(function () {
        return R.components[p.name]
          ? (R.components[p.name]({ params: p.params, body: p.body, html: p.body }) || '')
          : '<div class="unknown-component"><strong>' + escapeHtml(p.name) + '</strong>（未注册组件）</div>';
      });
    });
    return out;
  }

// ============ KaTeX 公式渲染(统一预提取方案) ============
  // 在 markdown-it 渲染前提取所有 $...$ 和 $$...$$ 到占位符,
  // 避免 HTML 标签干扰正则,也避免 markdown-it 破坏公式内部字符。

  // 提取公式并替换为占位符
  function extractMath(text) {
    const placeholders = []; // { id, expr, display }
    let result = text;

    // 1. 块级 $$...$$ (优先,避免被行内捕获)
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, function (m, expr) {
      const id = 'OCMATH_B_' + placeholders.length + '__';
      placeholders.push({ id, expr: expr.trim(), display: true });
      return id;
    });

    // 1b. 方括号块级 \[...\] 或 [...](独立成行的裸方括号公式)
    // 先处理 \[...\]
    result = result.replace(/\\\[([\s\S]+?)\\\]/g, function (m, expr) {
      const id = 'OCMATH_B_' + placeholders.length + '__';
      placeholders.push({ id, expr: expr.trim(), display: true });
      return id;
    });

    // 再处理裸方括号块级:方括号独占一行,如
    //   [
    //   F=G\frac{m_1m_2}{r^2}
    //   ]
    result = result.replace(/(^|\n)\s*\[\n([\s\S]+?)\n\s*\](\n|$)/g, function (m, pre, expr, post) {
      const e = expr.trim();
      // 内容含链接/引用语法则跳过(如 markdown 表格/列表)
      if (!e || /^\[|^!\[|\]\s*\(|\n\s*[-*]/.test(e)) return m;
      const id = 'OCMATH_B_' + placeholders.length + '__';
      placeholders.push({ id, expr: e, display: true });
      return pre + '\n\n' + id + '\n\n' + post;
    });

    // 2. 行内 $...$(避开转义 \$、避开前后紧靠数字/字母的情况)
    result = result.replace(/(^|(?<=\s|[^$\\]))\$((?!\s)[^$]*?[^$\\\s])\$(?=\s|[.,;:!?，。；：！？、）》」』】》〉〕］〕]|$)/g, function (m, pre, expr) {
      // 跳过纯数字 like $5
      if (/^\d+$/.test(expr)) return m;
      const id = 'OCMATH_I_' + placeholders.length + '__';
      placeholders.push({ id, expr: expr.trim(), display: false });
      return pre + id;
    });

    // 修复可能被误伤的反斜杠转义
    result = result.replace(/\\(OCMATH_[BI]_\d+__)/g, '$1');

    // 单 $ 公式如果独立成行,升级为块级显示(如 万有引力:\n\n$F=...$\n)
    for (const p of placeholders) {
      if (p.display) continue;
      const lineRe = new RegExp('(^|\\n)\\s*' + p.id + '\\s*(\\n|$)', 'm');
      if (lineRe.test(result)) p.display = true;
    }

    return { result, placeholders };
  }

  // 替换占位符为 KaTeX HTML
  function restoreMath(html, placeholders) {
    let out = html;
    for (const p of placeholders) {
      const escaped = escapeHtml(p.id);
      // 可能被 <p> 包裹成 <p>OCMATH_...__</p>
      const re = new RegExp('<p>' + escaped + '<\\/p>|' + escaped.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'g');
      out = out.replace(re, function () {
        try {
          return katex.renderToString(p.expr, { displayMode: p.display, throwOnError: false, output: 'htmlAndMathml' });
        } catch (e) {
          // 渲染失败时回退为原始公式文本(保持 $ 定界符让用户识别)
          return (p.display ? '$$' : '$') + escapeHtml(p.expr) + (p.display ? '$$' : '$');
        }
      });
    }
    return out;
  }

  // 兼容旧方案:直接 HTML 后处理(备选,仍保留一些保护)
  function renderLatexLegacy(html) {
    if (typeof katex === 'undefined') return html;
    try {
      // 只处理没有被预提取覆盖的零散 $$...$$
      html = html.replace(/<p>\$\$([\s\S]*?)\$\$<\/p>/g, function (m, expr) {
        try {
          return '<div class="katex-block-wrap">' + katex.renderToString(expr, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' }) + '</div>';
        } catch (e) { return m; }
      });
      return html;
    } catch (e) { return html; }
  }

  // ============ Mermaid 渲染 ============
  let mermaidReady = false;
  let mermaidTheme = '';
  let mermaidSig = '';

  const MERMAID_SOFT = ['#ACE0CF', '#8EBCDB', '#A79FCE', '#FE9F69', '#FEC080'];
  const MERMAID_RICH = ['#898988', '#79CB9B', '#FFC48A', '#547AC0', '#A369B0'];

  function mermaidInk(hex) {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    if (!Number.isFinite(n)) return '#24302c';
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luma > 0.62 ? '#24302c' : '#f7f5f2';
  }

  function mermaidScaleVars(colors) {
    const vars = {};
    colors.forEach((color, i) => {
      vars['cScale' + i] = color;
      vars['pie' + (i + 1)] = color;
      vars['git' + i] = color;
    });
    return vars;
  }

  function mermaidPalette(dark) {
    const colors = dark ? MERMAID_RICH : MERMAID_SOFT;
    const ink = mermaidInk(colors[0]);
    const note = dark ? '#FFC48A' : '#FEC080';
    return Object.assign({
      background: 'transparent',
      primaryColor: colors[0],
      secondaryColor: colors[1],
      tertiaryColor: colors[2],
      primaryTextColor: ink,
      secondaryTextColor: mermaidInk(colors[1]),
      tertiaryTextColor: mermaidInk(colors[2]),
      lineColor: dark ? '#8EBCDB' : '#898988',
      textColor: dark ? '#f4f7f5' : '#24302c',
      mainBkg: colors[0],
      nodeBorder: colors[0],
      clusterBkg: dark ? '#2a2e2d' : '#f7f8f7',
      clusterBorder: dark ? '#3a403e' : '#e6e8e6',
      titleColor: dark ? '#f4f7f5' : '#24302c',
      edgeLabelBackground: dark ? '#1c1f1e' : '#fcfcfc',
      nodeTextColor: ink,
      actorBkg: colors[0],
      actorBorder: colors[0],
      actorTextColor: ink,
      signalColor: dark ? '#8EBCDB' : '#898988',
      signalTextColor: dark ? '#f4f7f5' : '#24302c',
      labelBoxBkgColor: colors[0],
      labelBoxBorderColor: colors[0],
      labelTextColor: ink,
      loopTextColor: dark ? '#f4f7f5' : '#24302c',
      noteBkgColor: note,
      noteTextColor: mermaidInk(note),
      noteBorderColor: note,
      activationBkgColor: colors[2],
      activationBorderColor: colors[2],
      sequenceNumberColor: dark ? '#f7f5f2' : '#24302c',
    }, mermaidScaleVars(colors));
  }

  function mermaidConfig() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      startOnLoad: false,
      // 渲染失败时不注入 mermaid 自带的报错炸弹（由 mermaid-error 降级展示源码）
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: Object.assign(mermaidPalette(dark), {
        // xychart 的默认调色板首个颜色是 #FFF4DD(极浅米色),白底上几乎看不见线条。
        // 注意该键位于 themeVariables.xyChart 下(mermaid 11 的读取路径),放顶层不生效。
        xyChart: {
          plotColorPalette: dark
            ? '#6BA8DC, #F0A868, #7FCFA8, #C79BE0, #E88B8B, #8FB8E8'
            : '#3B82F6, #F59E0B, #10B981, #8B5CF6, #EF4444, #0EA5E9',
        },
      }),
      securityLevel: 'strict',
      fontFamily: 'inherit',
      flowchart: {
        curve: 'basis',
        padding: 16,
        nodeSpacing: 40,
        rankSpacing: 48,
        htmlLabels: true,
        wrappingWidth: 220,
      },
    };
  }

  function ensureMermaid() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    // 指纹里带上配置版本:调色板/图类型支持等改动后能自动重新初始化,
    // 否则 mermaid.initialize 只按主题判断会被跳过,新配置不生效(需刷新页面才看到)
    const sig = dark + '|v2';
    if (mermaidReady && mermaidSig === sig) return true;
    mermaid.initialize(mermaidConfig());
    mermaidReady = true;
    mermaidSig = sig;
    mermaidTheme = dark;
    return true;
  }

  function mermaidNodeShapes(node) {
    return node.querySelectorAll(':scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path, :scope > .label-container');
  }

  function paintMermaidShape(shape, fill, ink) {
    shape.setAttribute('fill', fill);
    shape.setAttribute('stroke', 'none');
    shape.style.fill = fill;
    shape.style.stroke = 'none';
    const label = shape.parentElement && shape.parentElement.querySelector('.nodeLabel, .label, span, foreignObject');
    if (!label) return;
    label.querySelectorAll('span, p, div').forEach((el) => { el.style.color = ink; });
    if (label.tagName === 'SPAN' || label.tagName === 'P') label.style.color = ink;
  }

  function softenMermaid(svg) {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const colors = dark ? MERMAID_RICH : MERMAID_SOFT;
    let n = 0;
    svg.querySelectorAll('g.node, g.actor').forEach((node) => {
      const fill = colors[n % colors.length];
      const ink = mermaidInk(fill);
      n += 1;
      mermaidNodeShapes(node).forEach((shape) => paintMermaidShape(shape, fill, ink));
    });
    svg.querySelectorAll('rect').forEach((rect) => {
      if (rect.closest('.edgeLabel') || rect.closest('.node') || rect.closest('.actor')) return;
      const w = parseFloat(rect.getAttribute('width') || '0');
      const h = parseFloat(rect.getAttribute('height') || '0');
      if (!(w > 8) || !(h > 8)) return;
      const rx = Math.min(14, w / 2, h / 2);
      rect.setAttribute('rx', String(rx));
      rect.setAttribute('ry', String(rx));
      rect.setAttribute('stroke', 'none');
    });
    svg.querySelectorAll('.node rect, .node polygon, .node circle, .node ellipse, .actor, polygon.label-container, .node .label-container').forEach((shape) => {
      shape.setAttribute('stroke', 'none');
      const w = parseFloat(shape.getAttribute('width') || '0');
      const h = parseFloat(shape.getAttribute('height') || '0');
      if (shape.tagName.toLowerCase() === 'rect' && w > 8 && h > 8) {
        const rx = Math.min(14, w / 2, h / 2);
        shape.setAttribute('rx', String(rx));
        shape.setAttribute('ry', String(rx));
      }
    });
  }

  const mermaidWaiters = [];
  let mermaidScriptInjected = false;
  // mermaid 体积大(3.5MB):页面默认不加载,出现图表代码块时才注入脚本。
  // 分享页挂在 /s/ 路径下,沿用该页其他资源的绝对路径约定
  function loadMermaidScript() {
    if (mermaidScriptInjected) return;
    mermaidScriptInjected = true;
    const base = location.pathname.indexOf('/s/') === 0 ? '/vendor/mermaid/mermaid.min.js' : './vendor/mermaid/mermaid.min.js';
    const s = document.createElement('script');
    s.src = base + '?v=11.17.2';
    s.async = true;
    document.head.appendChild(s);
  }
  function whenMermaidReady(run) {
    // 后台开启「不加载 Mermaid」:保持图表代码块为源码显示,不加载、不轮询
    if (window.OC_PERF && window.OC_PERF.noMermaid) return;
    if (typeof mermaid !== 'undefined') {
      run();
      return;
    }
    loadMermaidScript();
    mermaidWaiters.push(run);
    if (mermaidWaiters.length > 1) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (typeof mermaid === 'undefined' && Date.now() - started < 15000) return;
      clearInterval(timer);
      const queued = mermaidWaiters.splice(0);
      queued.forEach((fn) => {
        try { fn(); } catch (e) {}
      });
    }, 60);
  }

  // mermaid 11 的 erDiagram 关系标签含中文等非 ASCII 字符时必须加引号，这里自动补上
  function normalizeMermaidCode(code) {
    const src = String(code || '');
    const trimmed = src.trim();
    if (/^erDiagram\b/.test(trimmed)) return fixErDiagramLabels(src);
    if (/^xychart(-beta)?\b/i.test(trimmed)) return fixXychartSyntax(src);
    return src;
  }

  // xychart 语法容错:模型几乎总把带特殊字符的标签写成裸值(如 x-axis [9/30, 10/1] 或中文标签),
  // 而 mermaid 要求 title / x-axis 的标签 / y-axis 的单位必须加引号,否则整块解析失败、图表不显示。
  // 这里只给「确实需要引号」的部分补上,数字区间 0 --> 9 与已加引号的内容保持不动。
  function fixXychartSyntax(src) {
    const SAFE = /^[A-Za-z0-9_\-]+$/;                 // 无需引号的裸标识符
    const needQuote = (v) => {
      const t = String(v).trim();
      return t !== '' && !/^".*"$/.test(t) && !/^'.*'$/.test(t) && !SAFE.test(t);
    };
    const quote = (v) => '"' + String(v).trim().replace(/"/g, '\\"') + '"';
    const lines = String(src).split('\n');
    const out = lines.map((line) => {
      // title 后跟的内容需要引号
      let m = line.match(/^(\s*title\s+)(.+?)\s*$/i);
      if (m && needQuote(m[2])) return m[1] + quote(m[2]);
      // x-axis [a, b, c]:逐项补引号(逗号分隔,方括号包裹)
      m = line.match(/^(\s*x-axis\s*\[)([^\]]*)(\]\s*)$/i);
      if (m) {
        const items = m[2].split(',').map((it) => (needQuote(it) ? quote(it) : it.trim()));
        return m[1] + items.join(', ') + m[3];
      }
      // y-axis "单位" 0 --> 9:只有单位部分需要引号
      m = line.match(/^(\s*y-axis\s+)(.+?)(\s+\S+\s*-->\s*\S+\s*)$/i);
      if (m && needQuote(m[2])) return m[1] + quote(m[2]) + m[3];
      // 纯 y-axis 单位(不带区间)
      m = line.match(/^(\s*y-axis\s+)([^"'\s][^\s]*)\s*$/i);
      if (m && needQuote(m[2])) return m[1] + quote(m[2]);
      return line;
    });
    return out.join('\n');
  }

  // erDiagram 的关系标签含中文等非 ASCII 字符时必须加引号,这里自动补上
  function fixErDiagramLabels(src) {
    return String(src).replace(/^(\s*\S+\s+\S+\s+\S+\s*:\s*)(.+)$/gm, (m, head, label) => {
      const t = label.trim();
      if (!t || /^".*"$/.test(t)) return m;
      if (!/[^\x00-\x7F]/.test(t)) return m;
      return head + '"' + t + '"';
    });
  }

  function renderMermaidIn(root) {
    // 后台关闭 Mermaid:保留代码块源码显示,不做占位替换(否则会永远停在「渲染图表…」)
    if (window.OC_PERF && window.OC_PERF.noMermaid) return;
    const pending = [];
    // 语言标识为 mermaid 的块(含 xychart-beta / pie 等图类型,已由 normalizeFenceLang 归一化),
    // 另外兜底:语言未知但内容看着就是 mermaid 的块也按图表渲染
    root.querySelectorAll('code.language-mermaid, code.language-text, code.language-\\31 , pre:not([data-lang]) > code').forEach((el) => {
      const raw = el.textContent.trim();
      if (!raw) return;
      const isMermaidBlock = el.classList.contains('language-mermaid');
      if (!isMermaidBlock && !looksLikeMermaid(raw)) return;
      const code = normalizeMermaidCode(raw);
      if (!code) return;
      const parent = el.closest('pre');
      const prev = parent && parent.previousElementSibling;
      if (prev && prev.classList.contains('mermaid-wrap') && prev.getAttribute('data-src') === code) {
        if (parent) parent.remove();
        else el.remove();
        return;
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-wrap';
      wrapper.setAttribute('data-src', code);
      wrapper.innerHTML = '<div class="mermaid-loading">渲染图表…</div>';
      if (parent && parent.parentNode) parent.replaceWith(wrapper);
      else el.replaceWith(wrapper);
      pending.push(wrapper);
    });
    if (!pending.length) return;
    const paint = () => whenMermaidReady(() => paintMermaidWraps(pending));
    if (typeof queueMicrotask === 'function') queueMicrotask(paint);
    else setTimeout(paint, 0);
  }

  function paintMermaidWraps(wrappers) {
    if (typeof mermaid === 'undefined') {
      wrappers.forEach((wrapper) => {
        const code = wrapper.getAttribute('data-src') || '';
        wrapper.innerHTML = '<pre class="mermaid-unavailable">' + escapeHtml(code) + '</pre>';
      });
      return;
    }
    try { ensureMermaid(); } catch (e) {
      wrappers.forEach((wrapper) => {
        const code = wrapper.getAttribute('data-src') || '';
        wrapper.innerHTML = '<pre class="mermaid-unavailable">' + escapeHtml(code) + '</pre>';
      });
      return;
    }
    wrappers.forEach((wrapper, i) => {
      const code = wrapper.getAttribute('data-src') || '';
      if (!code || !wrapper.isConnected) return;
      Promise.resolve()
        .then(() => mermaid.render('mermaid-' + Date.now() + '-' + i, code))
        .then(({ svg }) => {
          if (!wrapper.isConnected || wrapper.getAttribute('data-src') !== code) return;
          wrapper.innerHTML = svg;
          const drawn = wrapper.querySelector('svg');
          if (drawn) softenMermaid(drawn);
          attachDiagramActions(wrapper);
        })
        .catch(() => {
          if (!wrapper.isConnected || wrapper.getAttribute('data-src') !== code) return;
          wrapper.innerHTML = '<pre class="mermaid-error">' + escapeHtml(code) + '</pre>';
        });
    });
  }

  function renderMermaidFallback(root) {
    root.querySelectorAll('code.language-mermaid').forEach((el) => {
      const pre = el.closest('pre');
      if (pre) pre.classList.add('mermaid-unavailable');
    });
  }

  // ============ 思维导图（Markdown 列表，非 Mermaid mindmap） ============
  function parseMindmapForest(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const trees = [];
    let current = null;
    const stack = [];

    function flush() {
      if (current) trees.push(current);
      current = null;
      stack.length = 0;
    }

    lines.forEach((raw) => {
      if (!raw.trim()) {
        if (current) flush();
        return;
      }
      const list = raw.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
      const indent = list ? list[1].replace(/\t/g, '  ').length : 0;
      const text = list ? list[2].trim() : raw.trim();
      if (!text) return;
      const node = { text: text, children: [] };
      if (!current || (!list && !stack.length)) {
        flush();
        current = node;
        stack.push({ indent: -1, node: current });
        return;
      }
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ indent, node });
    });
    flush();
    return trees;
  }

  function splitMindmapLabel(text) {
    const m = String(text || '').match(/^(.*?)(?:\s+[—–-]\s+|\s+[：:]\s+)(.+)$/);
    if (m && m[1].trim() && m[2].trim()) return { title: m[1].trim(), note: m[2].trim() };
    return { title: String(text || '').trim(), note: '' };
  }

  function mindmapNodeHtml(node, depth) {
    const parts = splitMindmapLabel(node.text);
    const kids = (node.children || []).map((c) => mindmapNodeHtml(c, depth + 1)).join('');
    const branch = kids ? '<ul class="mm-children">' + kids + '</ul>' : '';
    return '<li class="mm-node mm-d' + Math.min(depth, 6) + (kids ? ' has-kids' : '') + '">'
      + '<div class="mm-card">'
      + '<span class="mm-title">' + escapeHtml(parts.title) + '</span>'
      + (parts.note ? '<span class="mm-note">' + escapeHtml(parts.note) + '</span>' : '')
      + '</div>'
      + branch
      + '</li>';
  }

  function renderMindmapIn(root) {
    // 后台关闭 Mermaid 时一并关闭思维导图渲染(思维导图依赖 Mermaid 主题风格),保留源码
    if (window.OC_PERF && window.OC_PERF.noMermaid) return;
    root.querySelectorAll('code.language-mindmap').forEach((el) => {
      const src = el.textContent;
      const parent = el.closest('pre');
      const prev = parent && parent.previousElementSibling;
      if (prev && prev.classList.contains('mindmap-wrap') && prev.getAttribute('data-src') === src) {
        if (parent) parent.remove();
        else el.remove();
        return;
      }
      const trees = parseMindmapForest(src);
      const wrap = document.createElement('div');
      wrap.className = 'mindmap-wrap';
      wrap.setAttribute('data-src', src);
      if (!trees.length) {
        wrap.innerHTML = '<div class="mindmap-empty">空思维导图</div>';
      } else {
        wrap.innerHTML = trees.map((tree) =>
          '<div class="mindmap-tree"><ul class="mm-root">' + mindmapNodeHtml(tree, 0) + '</ul></div>'
        ).join('');
      }
      if (parent && parent.parentNode) parent.replaceWith(wrap);
      else el.replaceWith(wrap);
    });
  }

  function liftPresentationalHtmlFences(text) {
    return String(text || '').replace(/```([^\n`]*)\n([\s\S]*?)```/g, function (all, info, code) {
      const lang = String(info || '').trim().split(/\s+/)[0] || 'html';
      if (!isPresentationalHtmlFence(lang, code)) return all;
      return '\n\n<div class="html-present">\n' + code.trim() + '\n</div>\n\n';
    });
  }

  // 视频链接 [标题](地址) → 内嵌 <video> 播放器(生视频结果即是这种形式)。
  // 生视频结果的地址是同源代理 /api/proxy/video?u=...&s=...(原始 .mp4 在 u 参数里被编码),
  // 因此不能只看后缀,连同源代理前缀一起识别。转成原生 HTML 交给 markdown-it 透传。
  const VIDEO_LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;
  const VIDEO_URL = /(\.(?:mp4|webm|mov|m4v|ogv)(?:[?#][^)\s]*)?$)|(\/api\/proxy\/video\?)/i;
  function liftVideoLinks(text) {
    return String(text || '').replace(VIDEO_LINK, function (all, label, url) {
      if (!VIDEO_URL.test(url)) return all;
      const cap = String(label || '').trim();
      return '<figure class="md-video"><video src="' + escapeAttr(url) + '" controls preload="metadata" playsinline></video>'
        + (cap ? '<figcaption>' + escapeHtml(cap) + '</figcaption>' : '')
        + '</figure>';
    });
  }

  function isPresentationalHtmlFence(lang, code) {
    const name = String(lang || '').trim().toLowerCase();
    if (name !== 'html' && name !== 'htm') return false;
    const src = String(code || '');
    if (!/<(div|span|table|section|article|ul|ol|p|h[1-6])[\s>]/i.test(src)) return false;
    if (/<(script|iframe|object|embed|link|meta|form|input|textarea|select|button|html|head|body)\b/i.test(src)) return false;
    if (/\son[a-z]+\s*=/i.test(src) || /javascript\s*:/i.test(src)) return false;
    return true;
  }

  const HTML_BLOCKED_TAGS = /^(script|style|iframe|object|embed|link|meta|base|form|input|textarea|select|button|svg|math|html|head|body|frame|frameset)$/i;
  const HTML_EVENT_ATTR = /^on/i;
  const HTML_BAD_URL = /^(javascript|vbscript|data):/i;
  // 内联图片(data:image/png|jpeg|gif|webp;base64)是合法的:生图结果常以 b64_json 返回,
  // 用户消息里的参考图也是 data URL。放行这几种位图,仍然拦掉 svg+xml(可执行脚本)与 text/html 等。
  const HTML_SAFE_IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
  function urlAllowedForAttr(name, val) {
    const v = String(val || '').trim();
    if (!HTML_BAD_URL.test(v)) return true;
    if ((name === 'src' || name === 'xlink:href') && HTML_SAFE_IMG_DATA.test(v)) return true;
    return false;
  }

  function sanitizeStyleValue(value) {
    const v = String(value || '');
    if (/expression\s*\(|@import|javascript\s*:|vbscript\s*:|behavior\s*:/i.test(v)) return '';
    if (/url\s*\(/i.test(v)) return '';
    return v;
  }

  function sanitizeRenderedHtml(html) {
    if (!html || typeof document === 'undefined') return html;
    const host = document.createElement('div');
    host.innerHTML = html;
    const walk = (node) => {
      const kids = Array.from(node.childNodes);
      kids.forEach((child) => {
        if (child.nodeType !== 1) return;
        const tag = child.tagName;
        const keepCopy = tag === 'BUTTON' && child.classList.contains('code-copy');
        if (HTML_BLOCKED_TAGS.test(tag) && !keepCopy) {
          child.remove();
          return;
        }
        Array.from(child.attributes).forEach((attr) => {
          const name = attr.name;
          const val = attr.value || '';
          if (HTML_EVENT_ATTR.test(name) || name === 'srcdoc' || name === 'srcset') {
            child.removeAttribute(name);
            return;
          }
          if ((name === 'href' || name === 'src' || name === 'xlink:href') && !urlAllowedForAttr(name, val)) {
            child.removeAttribute(name);
            return;
          }
          if (name === 'style') {
            const cleaned = sanitizeStyleValue(val);
            if (cleaned) child.setAttribute('style', cleaned);
            else child.removeAttribute('style');
          }
        });
        walk(child);
      });
    };
    walk(host);
    groupAdjacentPresentCards(host);
    host.querySelectorAll('.html-present').forEach((el) => groupAdjacentPresentCards(el));
    return host.innerHTML;
  }

  function looksLikePresentCard(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== 'DIV') return false;
    if (el.classList.contains('html-present') || el.classList.contains('html-present-row')) return false;
    const style = el.getAttribute('style') || '';
    return /border-radius\s*:/.test(style) || /background\s*:/.test(style) || /padding\s*:/.test(style);
  }

  function groupAdjacentPresentCards(host) {
    const kids = Array.from(host.childNodes).filter((n) => {
      if (n.nodeType === 8) return false;
      if (n.nodeType === 3) return /\S/.test(n.textContent);
      return true;
    });
    const cards = kids.filter((n) => looksLikePresentCard(n));
    if (cards.length < 2) return;
    if (cards.length !== kids.length) return;
    const row = document.createElement('div');
    row.className = 'html-present-row';
    cards.forEach((card) => row.appendChild(card));
    host.appendChild(row);
  }

  // ============ 主渲染入口 ============
  /**
   * 渲染 Markdown 文本到 HTML 字符串
   */
R.render = function (text) {
    initMarkdown();
    if (!md) return '<div class="msg-plain">' + escapeHtml(text) + '</div>';
    // 0. 统一提取公式(占位符保护,避免 markdown-it / HTML 干扰)
    const { result: mathProtected, placeholders: mathPl } = extractMath(text || '');
    const htmlLifted = liftPresentationalHtmlFences(mathProtected);
    // 0b. 视频链接 → 内嵌播放器(在任何 markdown 处理前替换为原生 HTML)
    const videoLifted = liftVideoLinks(htmlLifted);
    // 1. 预处理容器组件
    const { result, placeholders } = preprocessContainers(videoLifted);
    // 2. markdown-it 渲染
    let html = sanitizeRenderedHtml(md.render(result));
    // 3. 恢复公式并渲染 KaTeX
    html = restoreMath(html, mathPl);
    html = renderLatexLegacy(html);
    // 4. 还原组件
    html = renderContainers(html, placeholders);
    // 5. 任务列表 checkbox 修复
    html = html.replace(/<li>\[([ xX])\]/g, function (m, chk) {
      const checked = /[xX]/.test(chk);
      return '<li class="task-item"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ';
    });
    return html;
  };

  /**
   * 渲染并挂载到容器（render + enhance 一步完成）
   * @param {HTMLElement} container
   * @param {string} text
   */
  R.renderInto = function (container, text) {
    container.classList.add('md-prose');
    container.innerHTML = R.render(text || '');
    R.enhance(container);
  };

  function closeOpenHtmlTags(html) {
    const src = String(html || '');
    const stack = [];
    const re = /<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g;
    let m;
    while ((m = re.exec(src))) {
      const raw = m[0];
      const name = m[1].toLowerCase();
      if (raw.startsWith('</')) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i] === name) { stack.splice(i); break; }
        }
        continue;
      }
      if (/\/>$/.test(raw)) continue;
      if (/^(br|hr|img|input|meta|link|source|area|col|embed|wbr)$/.test(name)) continue;
      stack.push(name);
    }
    let out = src;
    while (stack.length) out += '</' + stack.pop() + '>';
    return out;
  }

  function lastOpenFence(text) {
    const src = String(text || '');
    let last = -1;
    const re = /```/g;
    let m;
    let open = false;
    while ((m = re.exec(src))) {
      open = !open;
      last = open ? m.index : -1;
    }
    return last;
  }

  R.prepareStreaming = function (text) {
    let src = String(text || '');
    const start = lastOpenFence(src);
    if (start >= 0) {
      const chunk = src.slice(start);
      const info = (chunk.match(/^```([^\n]*)/) || [])[1] || '';
      const lang = normalizeFenceLang(String(info).trim().split(/\s+/)[0] || '');
      const body = chunk.replace(/^```[^\n]*\r?\n?/, '');
      const htmlLang = lang === 'html' || lang === 'htm';
      const htmlish = htmlLang || (!lang && /<[a-z][\s\S]*>/i.test(body));
      if (htmlish) {
        src = src.slice(0, start) + ( /<[a-z][\s\S]*>/i.test(body) ? '\n\n' + closeOpenHtmlTags(body) : '' );
      } else if (lang === 'mermaid' || lang === 'mindmap' || !body.trim()) {
        src = src.slice(0, start);
      } else {
        src = src.slice(0, start) + '\n\n```' + lang + '\n' + body + '\n```';
      }
    }
    const lastLt = src.lastIndexOf('<');
    const lastGt = src.lastIndexOf('>');
    if (lastLt > lastGt) src = src.slice(0, lastLt);
    return closeOpenHtmlTags(src);
  };

  R.renderStreamingInto = function (container, text) {
    container.classList.add('md-prose', 'md-streaming');
    const prepared = R.prepareStreaming(text || '');
    const html = R.render(prepared) + '<span class="stream-cursor"></span>';
    if (container.getAttribute('data-stream') === prepared) {
      if (!container.querySelector('.stream-cursor')) {
        container.insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>');
      }
      return;
    }
    container.setAttribute('data-stream', prepared);
    const keep = {};
    container.querySelectorAll('.mermaid-wrap[data-src], .mindmap-wrap[data-src]').forEach((el) => {
      keep[el.getAttribute('data-src')] = el;
    });
    container.innerHTML = html;
    container.querySelectorAll('.mermaid-wrap[data-src], .mindmap-wrap[data-src]').forEach((el) => {
      const src = el.getAttribute('data-src');
      if (src && keep[src] && keep[src] !== el) el.replaceWith(keep[src]);
    });
    R.enhance(container);
  };

  /**
   * 渲染并挂载到容器，处理代码复制、图片灯箱、mermaid、锚点等副作用
   * @param {HTMLElement} container 已设置 innerHTML 的容器
   */
  R.enhance = function (container) {
    if (container && container.classList) container.classList.add('md-prose');
    // 代码块复制
    container.querySelectorAll('.code-block').forEach((block) => {
      const btn = block.querySelector('.code-copy');
      const pre = block.querySelector('pre');
      if (!btn || !pre || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => copyBlockText(btn, pre.textContent));
    });
    container.querySelectorAll('.katex-display').forEach((block) => {
      if (!block.querySelector('.code-copy')) {
        const btn = copyButtonEl('复制到 Office');
        const span = btn.querySelector('span');
        if (span) span.textContent = '复制到 Office';
        visualBar(block).appendChild(btn);
        btn.addEventListener('click', () => {
          const math = block.querySelector('math');
          if (window.OCOfficeFormula && math) window.OCOfficeFormula.copy(btn, math);
        });
      }
    });
    container.querySelectorAll('.table-wrap').forEach((block) => {
      if (!block.querySelector('.code-copy')) {
        const btn = copyButtonEl('复制表格');
        visualBar(block).appendChild(btn);
        btn.addEventListener('click', () => copyBlockText(btn, tableToText(block.querySelector('table'))));
      }
      attachExcelButton(block);
    });
    container.querySelectorAll('.html-present, .html-present-row').forEach((block) => {
      if (block.closest('.html-present-row') && block.classList.contains('html-present')) return;
      attachCopyMenu(block, () => block.innerText, '卡片');
      attachImageButton(block, '卡片');
    });

    // 代码折叠（可选：超长代码块折叠）
    container.querySelectorAll('.code-block pre').forEach((pre) => {
      const lines = pre.textContent.split('\n').length;
      if (lines > 30) {
        pre.classList.add('code-collapsed');
        const btn = document.createElement('button');
        btn.className = 'code-expand';
        btn.textContent = '展开全部 (' + lines + ' 行)';
        pre.parentElement.appendChild(btn);
        btn.addEventListener('click', () => {
          pre.classList.remove('code-collapsed');
          btn.remove();
        });
      }
    });

    // 图片灯箱
    container.querySelectorAll('[data-lightbox]').forEach((img) => {
      img.addEventListener('click', () => {
        let lb = document.querySelector('.lightbox');
        if (!lb) {
          lb = document.createElement('div');
          lb.className = 'lightbox';
          lb.innerHTML = '<img alt=""><button class="lightbox-close" aria-label="关闭">' + window.OC.icon('close', 16) + '</button>';
          const hideLb = () => lb.classList.remove('show');
          lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lightbox-close')) hideLb(); });
          // Esc 关闭灯箱:只在灯箱可见时拦截,且不与弹窗 Esc 冲突
          lb._escHandler = (e) => {
            if (e.key !== 'Escape' || !lb.classList.contains('show')) return;
            if (window.OCUI && window.OCUI.isModalOpen && window.OCUI.isModalOpen()) return;
            e.preventDefault();
            e.stopPropagation();
            hideLb();
          };
          document.addEventListener('keydown', lb._escHandler, true);
          document.body.appendChild(lb);
        }
        lb.querySelector('img').src = img.getAttribute('data-lightbox');
        lb.classList.add('show');
      });
    });

    // 表格排序（点击表头）
    container.querySelectorAll('.table-wrap table').forEach((table) => {
      const thead = table.querySelector('thead');
      const tbody = table.querySelector('tbody');
      if (!thead || !tbody) return;
      const ths = thead.querySelectorAll('th');
      ths.forEach((th, colIdx) => {
        th.classList.add('sortable');
        th.title = '点击排序';
        th.addEventListener('click', () => {
          const direction = th.dataset.sort === 'asc' ? 'desc' : 'asc';
          ths.forEach((t) => { delete t.dataset.sort; t.classList.remove('sort-asc', 'sort-desc'); });
          th.dataset.sort = direction;
          th.classList.add(direction === 'asc' ? 'sort-asc' : 'sort-desc');
          // 收集行
          const rows = Array.from(tbody.querySelectorAll('tr'));
          rows.sort((a, b) => {
            const av = a.children[colIdx] ? a.children[colIdx].textContent.trim() : '';
            const bv = b.children[colIdx] ? b.children[colIdx].textContent.trim() : '';
            const an = parseFloat(av);
            const bn = parseFloat(bv);
            let cmp;
            if (!isNaN(an) && !isNaN(bn)) cmp = an - bn;
            else cmp = av.localeCompare(bv, 'zh-CN');
            return direction === 'asc' ? cmp : -cmp;
          });
          rows.forEach((r) => tbody.appendChild(r));
        });
      });
    });

    // Mermaid / mindmap
    renderMermaidIn(container);
    renderMindmapIn(container);
    container.querySelectorAll('.mindmap-wrap, .mermaid-wrap').forEach((block) => {
      if (block.querySelector('.mermaid-loading')) return;
      attachDiagramActions(block);
    });
  };

  function attachDiagramActions(block) {
    if (!block || block.querySelector('.mermaid-loading') || block.querySelector('.mermaid-error')) return;
    const imageName = block.classList.contains('mindmap-wrap') ? '思维导图' : '图表';
    attachCopyMenu(block, () => block.getAttribute('data-src') || block.innerText, imageName);
    attachImageButton(block, imageName);
  }

  function copyButtonHtml(label) {
    const icon = window.OC && window.OC.icon ? window.OC.icon('copy', 14) : '';
    return '<button type="button" class="code-copy" title="' + escapeAttr(label) + '">' + icon + '<span>复制</span></button>';
  }

  function visualBar(block) {
    let bar = block.querySelector(':scope > .visual-actions');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'visual-actions';
    block.insertBefore(bar, block.firstChild);
    return bar;
  }

  function attachCopyButton(block, label, read) {
    if (!block || block.querySelector(':scope > .visual-actions .code-copy, :scope > .code-copy')) return;
    const btn = copyButtonEl(label);
    visualBar(block).appendChild(btn);
    btn.addEventListener('click', () => copyBlockText(btn, read()));
  }

  function attachCopyMenu(block, readSource, imageName) {
    if (!block || block.querySelector(':scope > .visual-actions .copy-menu')) return;
    const holder = document.createElement('div');
    holder.className = 'copy-menu';
    holder.innerHTML = copyButtonHtml('复制');
    const btn = holder.firstChild;
    btn.classList.add('copy-menu-btn');
    const menu = document.createElement('div');
    menu.className = 'copy-menu-list hidden';
    menu.innerHTML = '<button type="button" data-copy="source">复制源代码</button><button type="button" data-copy="image">复制图片</button>';
    holder.appendChild(menu);
    visualBar(block).appendChild(holder);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.contains('hidden');
      document.querySelectorAll('.copy-menu-list').forEach((el) => el.classList.add('hidden'));
      menu.classList.toggle('hidden', !open);
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-copy]');
      if (!item) return;
      e.stopPropagation();
      menu.classList.add('hidden');
      if (item.getAttribute('data-copy') === 'image') copyBlockImage(btn, block);
      else copyBlockText(btn, readSource());
    });
    if (!window.__ocCopyMenuBound) {
      window.__ocCopyMenuBound = true;
      document.addEventListener('click', () => {
        document.querySelectorAll('.copy-menu-list').forEach((el) => el.classList.add('hidden'));
      });
    }
  }

  function imageButtonHtml(label) {
    const icon = window.OC && window.OC.icon ? window.OC.icon('download', 14) : '';
    return '<button type="button" class="code-copy code-image" title="导出 ' + escapeAttr(label) + ' 为 1200dpi PNG">' + icon + '<span>导出图片</span></button>';
  }

  function attachImageButton(block, name) {
    if (!block || block.querySelector(':scope > .visual-actions .code-image, :scope > .code-image')) return;
    const holder = document.createElement('div');
    holder.innerHTML = imageButtonHtml(name);
    const btn = holder.firstChild;
    visualBar(block).appendChild(btn);
    btn.addEventListener('click', () => exportBlockImage(btn, block, name));
  }

  function excelButtonHtml() {
    const icon = window.OC && window.OC.icon ? window.OC.icon('download', 14) : '';
    return '<button type="button" class="code-copy code-excel" title="导出为 Excel">' + icon + '<span>导出 Excel</span></button>';
  }

  function attachExcelButton(block) {
    if (!block || block.querySelector(':scope > .visual-actions .code-excel')) return;
    const holder = document.createElement('div');
    holder.innerHTML = excelButtonHtml();
    const btn = holder.firstChild;
    visualBar(block).appendChild(btn);
    btn.addEventListener('click', () => exportTableExcel(btn, block));
  }

  function xmlEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[c]));
  }

  function colName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  function sheetXml(rows) {
    const body = rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = colName(c) + (r + 1);
        const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        const num = text !== '' && /^-?\d+(\.\d+)?$/.test(text);
        if (num) return '<c r="' + ref + '"><v>' + text + '</v></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(text) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetData>' + body + '</sheetData></worksheet>';
  }

  function crc32(bytes) {
    let c = ~0;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((file) => {
      const name = enc.encode(file.name);
      const data = enc.encode(file.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(8, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      parts.push(local);
      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length;
    });
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const total = offset + centralSize + end.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    parts.concat(central, [end]).forEach((part) => {
      out.set(part, cursor);
      cursor += part.length;
    });
    return out;
  }

  function downloadBytes(name, bytes, type) {
    const blob = new Blob([bytes], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportTableExcel(btn, block) {
    const table = block.querySelector('table');
    const rows = table ? Array.from(table.rows).map((row) =>
      Array.from(row.cells).map((cell) => cell.innerText.replace(/\s+/g, ' ').trim())
    ) : [];
    if (!rows.length) {
      if (window.toast) window.toast('没有可导出的表格', true);
      return;
    }
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="表格" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>';
    const root = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>';
    const bytes = zipStore([
      { name: '[Content_Types].xml', data: root },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: rels },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) },
    ]);
    downloadBytes('表格.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const label = btn.querySelector('span');
    const prev = label ? label.textContent : '';
    if (label) label.textContent = '已导出';
    if (window.toast) window.toast('已导出 Excel');
    setTimeout(() => { if (label) label.textContent = prev || '导出 Excel'; }, 1400);
  }

  const EXPORT_DPI = 1200;
  const EXPORT_TILE = 4096;

  function exportFill(block) {
    const bg = getComputedStyle(block).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    const page = getComputedStyle(document.body).backgroundColor;
    if (page && page !== 'transparent' && page !== 'rgba(0, 0, 0, 0)') return page;
    return '#ffffff';
  }

  function roundedPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function paintBox(ctx, el, origin) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left - origin.x;
    const y = rect.top - origin.y;
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    const bg = style.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = bg;
      roundedPath(ctx, x, y, rect.width, rect.height, radius);
      ctx.fill();
    }
    const bw = parseFloat(style.borderTopWidth) || 0;
    if (bw > 0 && style.borderTopStyle !== 'none' && style.borderTopColor !== 'rgba(0, 0, 0, 0)') {
      ctx.strokeStyle = style.borderTopColor;
      ctx.lineWidth = bw;
      roundedPath(ctx, x + bw / 2, y + bw / 2, Math.max(0, rect.width - bw), Math.max(0, rect.height - bw), radius);
      ctx.stroke();
    }
  }

  function paintLines(ctx, el, origin) {
    if (!el.classList || !el.classList.contains('mm-children')) return;
    const cards = el.querySelectorAll(':scope > .mm-node > .mm-card');
    if (!cards.length) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#5b6cff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'butt';
    const boxes = Array.from(cards).map((card) => card.getBoundingClientRect());
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const spine = first.left - origin.x - 14;
    if (boxes.length > 1) {
      ctx.beginPath();
      ctx.moveTo(spine, first.top + first.height / 2 - origin.y);
      ctx.lineTo(spine, last.top + last.height / 2 - origin.y);
      ctx.stroke();
    }
    boxes.forEach((box) => {
      const y = box.top + box.height / 2 - origin.y;
      ctx.beginPath();
      ctx.moveTo(spine, y);
      ctx.lineTo(box.left - origin.x, y);
      ctx.stroke();
    });
    const parentCard = el.parentElement && el.parentElement.querySelector(':scope > .mm-card');
    if (!parentCard) return;
    const from = parentCard.getBoundingClientRect();
    const y = from.top + from.height / 2 - origin.y;
    ctx.beginPath();
    ctx.moveTo(from.right - origin.x, y);
    ctx.lineTo(spine, y);
    ctx.stroke();
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const chars = Array.from(String(text || ''));
    const lines = [];
    let line = '';
    chars.forEach((ch) => {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else line = next;
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function paintTextBlock(ctx, el, origin) {
    if (!el.classList || (!el.classList.contains('mm-title') && !el.classList.contains('mm-note'))) return;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left - origin.x, rect.top - origin.y, rect.width, rect.height);
    ctx.clip();
    ctx.fillStyle = style.color || '#111';
    ctx.font = style.font || '13px sans-serif';
    ctx.textBaseline = 'top';
    const padTop = parseFloat(style.paddingTop) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    ctx.fillText(el.textContent.replace(/\s+/g, ' ').trim(), rect.left - origin.x + padLeft, rect.top - origin.y + padTop);
    ctx.restore();
  }

  function paintDots(ctx, el, origin) {
    if (!el.classList || !el.classList.contains('mindmap-wrap')) return;
    const rect = el.getBoundingClientRect();
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#24302c';
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = ink;
    for (let y = rect.top - origin.y; y < rect.bottom - origin.y; y += 18) {
      for (let x = rect.left - origin.x; x < rect.right - origin.x; x += 18) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function paintDom(ctx, el, origin) {
    if (!el || el.nodeType !== 1) return;
    if (el.classList && (el.classList.contains('visual-actions') || el.classList.contains('code-copy') || el.classList.contains('code-image') || el.classList.contains('code-excel'))) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (el.tagName && el.tagName.toLowerCase() === 'svg') return;
    paintDots(ctx, el, origin);
    paintBox(ctx, el, origin);
    paintLines(ctx, el, origin);
    paintTextBlock(ctx, el, origin);
    Array.from(el.children).forEach((child) => paintDom(ctx, child, origin));
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(type, 4);
    out.set(data, 8);
    const crc = crc32(out.subarray(4, 8 + data.length));
    view.setUint32(8 + data.length, crc);
    return out;
  }

  async function stitchTiles(tiles, width, height) {
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (const tile of tiles) {
      const ctx = tile.canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, tile.width, tile.height).data;
      for (let y = 0; y < tile.height; y++) {
        const dest = (tile.top + y) * (width * 4 + 1) + 1 + tile.left * 4;
        raw.set(pixels.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), dest);
      }
    }
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, pngChunk([73, 72, 68, 82], ihdr), pngChunk([73, 68, 65, 84], compressed), pngChunk([73, 69, 78, 68], new Uint8Array())];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const png = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => { png.set(part, offset); offset += part.length; });
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < png.length; i += step) {
      binary += String.fromCharCode.apply(null, png.subarray(i, i + step));
    }
    return 'data:image/png;base64,' + btoa(binary);
  }

  async function pngWithDpi(canvas, dpi) {
    const png = canvas.toDataURL('image/png');
    const raw = atob(png.split(',')[1]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ppm = Math.round(dpi / 0.0254);
    const phys = new Uint8Array(9);
    const view = new DataView(phys.buffer);
    view.setUint32(0, ppm);
    view.setUint32(4, ppm);
    phys[8] = 1;
    const chunk = pngChunk([112, 72, 89, 115], phys);
    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, 33), 0);
    out.set(chunk, 33);
    out.set(bytes.subarray(33), 33 + chunk.length);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < out.length; i += step) binary += String.fromCharCode.apply(null, out.subarray(i, i + step));
    return 'data:image/png;base64,' + btoa(binary);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('svg'));
      img.src = url;
    });
  }

  async function loadSvgImage(xml) {
    // Blob URL avoids browser URL-length limits when embedded fonts are large.
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    try { return await loadImage(url); } finally { URL.revokeObjectURL(url); }
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  const exportFontCache = new Map();
  async function fontDataUrl(url) {
    if (!url || /^data:/i.test(url)) return url;
    if (exportFontCache.has(url)) return exportFontCache.get(url);
    const task = fetch(url, { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('font ' + res.status);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        const lower = url.split('?')[0].toLowerCase();
        const mime = lower.endsWith('.otf') ? 'font/otf'
          : lower.endsWith('.woff2') ? 'font/woff2'
          : lower.endsWith('.woff') ? 'font/woff'
          : 'font/ttf';
        return 'data:' + mime + ';base64,' + bytesToBase64(buffer);
      })
      .catch(() => '');
    exportFontCache.set(url, task);
    return task;
  }

  function collectFontFaceRules() {
    const out = [];
    const seen = new Set();
    function walk(rules) {
      if (!rules) return;
      Array.from(rules).forEach((rule) => {
        const text = String(rule.cssText || '');
        if (/^@font-face/i.test(text.trim()) && !seen.has(text)) {
          seen.add(text);
          out.push(text);
        } else if (rule.cssRules) walk(rule.cssRules);
      });
    }
    Array.from(document.styleSheets || []).forEach((sheet) => {
      try { walk(sheet.cssRules); } catch (e) {}
    });
    return out;
  }

  function exportFontFamily(block) {
    const target = block.querySelector('.nodeLabel, .edgeLabel, .label, foreignObject') || block;
    const style = getComputedStyle(target);
    const fallback = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const family = String(style.fontFamily || fallback || 'sans-serif').trim();
    return family && family !== 'inherit' ? family : fallback;
  }

  function assetUrl(name) {
    const base = location.pathname.indexOf('/s/') === 0 ? '/static/' : './static/';
    try { return new URL(base + name, document.baseURI).href; }
    catch (e) { return base + name; }
  }

  async function inlineFontFaces(block) {
    const family = exportFontFamily(block);
    const familyNames = new Set();
    family.replace(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/g, (m, quoted1, quoted2, bare) => {
      const name = String(quoted1 || quoted2 || bare || '').trim();
      if (name && !/^(serif|sans-serif|monospace|system-ui|inherit)$/i.test(name)) familyNames.add(name.toLowerCase());
      return m;
    });
    const rules = collectFontFaceRules().filter((rule) => {
      const match = rule.match(/font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i);
      const name = String(match && (match[1] || match[2] || match[3]) || '').trim().toLowerCase();
      return familyNames.has(name);
    });
    let css = rules.join('\n').replace(/font-display\s*:\s*swap/gi, 'font-display:block');
    const urls = [];
    const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\)\s]+))\s*\)/gi;
    css.replace(re, (whole, quoted1, quoted2, bare) => {
      const raw = quoted1 || quoted2 || bare || '';
      if (raw && !/^data:|^blob:|^local\(/i.test(raw)) urls.push(raw);
      return whole;
    });
    const replacements = new Map();
    await Promise.all(Array.from(new Set(urls)).map(async (raw) => {
      try {
        const absolute = new URL(raw, document.baseURI).href;
        const data = await fontDataUrl(absolute);
        if (data) replacements.set(raw, data);
      } catch (e) {}
    }));
    css = css.replace(re, (whole, quoted1, quoted2, bare) => {
      const raw = quoted1 || quoted2 || bare || '';
      const data = replacements.get(raw);
      return data ? 'url("' + data + '")' : whole;
    });
    const symbol = await fontDataUrl(assetUrl('Times New Roman.ttf'));
    if (symbol) {
      css += '@font-face{font-family:"TinyChat Export Symbols";src:url("' + symbol + '") format("truetype");font-style:normal;font-weight:400 700;font-display:block;unicode-range:U+2190-21FF;}';
    }
    return { css: css, family: family, symbol: !!symbol };
  }

  function wrapExportArrows(root) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!/[↑↓]/.test(String(node.nodeValue || '')) || !parent) continue;
      if (/^(style|script)$/i.test(parent.tagName || '')) continue;
      nodes.push(node);
    }
    nodes.forEach((text) => {
      const fragment = document.createDocumentFragment();
      String(text.nodeValue || '').split(/([↑↓])/).forEach((part) => {
        if (!part) return;
        if (/^[↑↓]$/.test(part)) {
          const inSvgText = text.parentNode.namespaceURI === svgNs && !text.parentElement.closest('foreignObject');
          const el = inSvgText
            ? document.createElementNS(svgNs, 'tspan')
            : document.createElement('span');
          el.setAttribute('class', 'tc-export-arrow');
          el.textContent = part;
          fragment.appendChild(el);
        } else fragment.appendChild(document.createTextNode(part));
      });
      if (text.parentNode) text.parentNode.replaceChild(fragment, text);
    });
  }

  async function paintSvgElement(ctx, svg, origin) {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
    const xml = new XMLSerializer().serializeToString(clone);
    const img = await loadSvgImage(xml);
    ctx.drawImage(img, rect.left - origin.x, rect.top - origin.y, rect.width, rect.height);
  }

  async function rasterizeSvgImage(img, cssW, cssH, fill) {
    const scale = EXPORT_DPI / 96;
    const fullW = Math.max(1, Math.round(cssW * scale));
    const fullH = Math.max(1, Math.round(cssH * scale));
    const cols = Math.ceil(fullW / EXPORT_TILE);
    const rows = Math.ceil(fullH / EXPORT_TILE);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * EXPORT_TILE;
        const top = row * EXPORT_TILE;
        const tileW = Math.min(EXPORT_TILE, fullW - left);
        const tileH = Math.min(EXPORT_TILE, fullH - top);
        const tile = document.createElement('canvas');
        tile.width = tileW;
        tile.height = tileH;
        const ctx = tile.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, -left, -top);
        ctx.fillStyle = fill;
        ctx.fillRect(left / scale, top / scale, tileW / scale, tileH / scale);
        ctx.drawImage(img, 0, 0, cssW, cssH);
        tiles.push({ canvas: tile, left: left, top: top, width: tileW, height: tileH });
      }
    }
    return tiles.length === 1 ? pngWithDpi(tiles[0].canvas, EXPORT_DPI) : stitchTiles(tiles, fullW, fullH);
  }

  async function exportMermaidPng(block) {
    if (!block) return '';
    let drawn = block.querySelector(':scope > svg');
    let holder = null;
    if (!drawn && typeof mermaid !== 'undefined') {
      const code = block.getAttribute('data-src') || '';
      if (!code) return '';
      ensureMermaid();
      const id = 'mermaid-export-' + Date.now();
      const rendered = await mermaid.render(id, code);
      holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
      holder.innerHTML = rendered.svg;
      document.body.appendChild(holder);
      drawn = holder.querySelector('svg');
      if (drawn) softenMermaid(drawn);
    }
    if (!drawn) return '';
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const rect = drawn.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return '';
      const clone = drawn.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(rect.width));
      clone.setAttribute('height', String(rect.height));
      wrapExportArrows(clone);
      const font = await inlineFontFaces(block);
      const family = font.family + (font.symbol ? ', "TinyChat Export Symbols"' : '');
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = font.css
        + 'html,body,div,span,p,foreignObject,.nodeLabel,.edgeLabel,.label,text,tspan{font-family:' + family + ' !important;}'
        + '.tc-export-arrow{font-family:"TinyChat Export Symbols" !important;font-style:normal;font-weight:400 !important;}';
      clone.insertBefore(style, clone.firstChild);
      const xml = new XMLSerializer().serializeToString(clone);
      const img = await loadSvgImage(xml);
      return rasterizeSvgImage(img, rect.width, rect.height, exportFill(block));
    } finally {
      if (holder) holder.remove();
    }
  }

  function cssTextForExport() {
    const chunks = [];
    Array.from(document.styleSheets).forEach((sheet) => {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { return; }
      if (!rules) return;
      Array.from(rules).forEach((rule) => {
        if (!/^@font-face/i.test(String(rule.cssText || '').trim())) chunks.push(rule.cssText);
      });
    });
    chunks.push('.mindmap-wrap{background:transparent !important;border:none !important;box-shadow:none !important;overflow:visible !important;max-height:none !important}');
    chunks.push('.mermaid-wrap,.html-present,.html-present-row{overflow:visible !important;max-height:none !important}');
    chunks.push('.visual-actions,.code-copy,.code-image,.code-excel,.copy-menu{display:none !important}');
    return chunks.join('\n');
  }

  function foreignObjectSvg(markup, width, height) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">'
      + '<foreignObject width="100%" height="100%">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0;background:transparent">'
      + markup + '</div></foreignObject></svg>';
  }

  async function exportRenderedPng(block, opts) {
    const clearChrome = !!(opts && opts.clearChrome);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;background:transparent;overflow:visible';
    const clone = block.cloneNode(true);
    clone.querySelectorAll('.visual-actions, .copy-menu, .code-copy, .code-image, .code-excel').forEach((el) => el.remove());
    clone.style.overflow = 'visible';
    clone.style.maxHeight = 'none';
    clone.style.height = 'auto';
    clone.style.margin = '0';
    if (clearChrome) {
      clone.style.background = 'transparent';
      clone.style.border = 'none';
      clone.style.boxShadow = 'none';
    }
    clone.style.width = Math.max(block.scrollWidth, Math.ceil(block.getBoundingClientRect().width)) + 'px';
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
      const cssW = Math.max(clone.scrollWidth, Math.ceil(clone.getBoundingClientRect().width));
      const cssH = Math.max(clone.scrollHeight, Math.ceil(clone.getBoundingClientRect().height));
      if (cssW < 8 || cssH < 8) return '';
      clone.style.width = cssW + 'px';
      clone.style.height = cssH + 'px';
      const scale = EXPORT_DPI / 96;
      const fullW = Math.max(1, Math.round(cssW * scale));
      const fullH = Math.max(1, Math.round(cssH * scale));
      const theme = (document.documentElement.getAttribute('data-theme') || 'light').replace(/[^a-z]/gi, '');
      const rootStyle = document.documentElement.getAttribute('style') || '';
      const font = await inlineFontFaces(block);
      wrapExportArrows(clone);
      const markup = '<style>' + cssTextForExport() + font.css
        + '.tc-export-arrow{font-family:"TinyChat Export Symbols" !important;font-style:normal;}'
        + '</style>'
        + '<div data-theme="' + theme + '" style="' + rootStyle.replace(/"/g, '') + ';width:' + cssW + 'px;height:' + cssH + 'px;background:transparent">'
        + clone.outerHTML + '</div>';
      const img = await loadSvgImage(foreignObjectSvg(markup, cssW, cssH));
      const cols = Math.ceil(fullW / EXPORT_TILE);
      const rows = Math.ceil(fullH / EXPORT_TILE);
      const tiles = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const left = col * EXPORT_TILE;
          const top = row * EXPORT_TILE;
          const tileW = Math.min(EXPORT_TILE, fullW - left);
          const tileH = Math.min(EXPORT_TILE, fullH - top);
          const tile = document.createElement('canvas');
          tile.width = tileW;
          tile.height = tileH;
          const ctx = tile.getContext('2d');
          ctx.drawImage(img, left / scale, top / scale, tileW / scale, tileH / scale, 0, 0, tileW, tileH);
          tiles.push({ canvas: tile, left: left, top: top, width: tileW, height: tileH });
        }
      }
      return tiles.length === 1 ? pngWithDpi(tiles[0].canvas, EXPORT_DPI) : stitchTiles(tiles, fullW, fullH);
    } finally {
      host.remove();
    }
  }

  async function exportBlockImage(btn, block, name) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const label = btn.querySelector('span');
    const prev = label ? label.textContent : '';
    if (label) label.textContent = '导出中';
    try {
      const shot = block.classList.contains('mindmap-wrap')
        || block.classList.contains('mermaid-wrap')
        || block.classList.contains('html-present')
        || block.classList.contains('html-present-row');
      if (shot) {
        const clearChrome = block.classList.contains('mindmap-wrap');
        let png = '';
        if (block.classList.contains('mermaid-wrap')) {
          try { png = await exportMermaidPng(block); } catch (e) { png = ''; }
        }
        if (!png) {
          try { png = await exportRenderedPng(block, { clearChrome: clearChrome }); } catch (e) { png = ''; }
        }
        if (!png) throw new Error('empty');
        const a = document.createElement('a');
        a.href = png;
        a.download = name + '-1200dpi.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (label) label.textContent = '已导出';
        if (window.toast) window.toast('已导出 1200dpi 图片');
        setTimeout(() => {
          delete btn.dataset.busy;
          if (label) label.textContent = prev || '导出图片';
        }, 1400);
        return;
      }
      const svgOnly = block.querySelector(':scope > svg');
      const target = svgOnly || block;
      const rect = target.getBoundingClientRect();
      const pad = 28;
      const fullCssW = rect.width;
      const fullCssH = rect.height;
      const cssW = Math.ceil(fullCssW + pad * 2);
      const cssH = Math.ceil(fullCssH + pad * 2);
      if (cssW < 8 || cssH < 8) throw new Error('empty');
      const scale = EXPORT_DPI / 96;
      const fullW = Math.max(1, Math.round(cssW * scale));
      const fullH = Math.max(1, Math.round(cssH * scale));
      const fill = exportFill(block);
      const origin = { x: rect.left - pad, y: rect.top - pad };
      const nested = svgOnly ? [] : Array.from(target.querySelectorAll('svg'));
      const cols = Math.ceil(fullW / EXPORT_TILE);
      const rows = Math.ceil(fullH / EXPORT_TILE);
      const tiles = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const left = col * EXPORT_TILE;
          const top = row * EXPORT_TILE;
          const tileW = Math.min(EXPORT_TILE, fullW - left);
          const tileH = Math.min(EXPORT_TILE, fullH - top);
          const tile = document.createElement('canvas');
          tile.width = tileW;
          tile.height = tileH;
          const ctx = tile.getContext('2d');
          ctx.setTransform(scale, 0, 0, scale, -left, -top);
          ctx.fillStyle = fill;
          ctx.fillRect(left / scale, top / scale, tileW / scale, tileH / scale);
          if (svgOnly) await paintSvgElement(ctx, svgOnly, origin);
          else paintDom(ctx, target, origin);
          for (const item of nested) await paintSvgElement(ctx, item, origin);
          tiles.push({ canvas: tile, left: left, top: top, width: tileW, height: tileH });
        }
      }
      const png = tiles.length === 1 ? await pngWithDpi(tiles[0].canvas, EXPORT_DPI) : await stitchTiles(tiles, fullW, fullH);
      const a = document.createElement('a');
      a.href = png;
      a.download = name + '-1200dpi.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (label) label.textContent = '已导出';
      if (window.toast) window.toast('已导出 1200dpi 图片');
    } catch (e) {
      if (label) label.textContent = '导出失败';
      if (window.toast) window.toast('导出图片失败', true);
    }
    setTimeout(() => {
      delete btn.dataset.busy;
      if (label) label.textContent = prev || '导出图片';
    }, 1400);
  }

  function copyButtonEl(label) {
    const holder = document.createElement('div');
    holder.innerHTML = copyButtonHtml(label);
    return holder.firstChild;
  }

  function wordFormulaHtml(block) {
    const math = block.querySelector('math');
    if (!math) return '';
    const clone = math.cloneNode(true);
    clone.querySelectorAll('annotation, annotation-xml').forEach((node) => node.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    const omml = mathmlToOmml(clone);
    if (!omml) return '';
    const fragment = '<m:oMathPara>' + omml + '</m:oMathPara>';
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office"'
      + ' xmlns:w="urn:schemas-microsoft-com:office:word"'
      + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
      + '<head><meta charset="utf-8"><meta name="ProgId" content="Word.Document">'
      + '<meta name="Generator" content="Microsoft Word 16"></head><body>'
      + '<!--StartFragment-->' + fragment + '<!--EndFragment-->'
      + '</body></html>';
  }

  function ommlNode(name, text) {
    const el = document.createElementNS('http://schemas.openxmlformats.org/officeDocument/2006/math', name);
    if (text != null) el.textContent = text;
    return el;
  }

  function ommlRun(text, italic) {
    const r = ommlNode('m:r');
    if (italic === false) {
      const rPr = ommlNode('m:rPr');
      const sty = ommlNode('m:sty');
      sty.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', 'p');
      rPr.appendChild(sty);
      r.appendChild(rPr);
    }
    r.appendChild(ommlNode('m:t', text));
    return r;
  }

  function appendOmml(parent, node) {
    if (!node) return;
    if (Array.isArray(node)) node.forEach((item) => appendOmml(parent, item));
    else parent.appendChild(node);
  }

  function mathmlToOmml(math) {
    const oMath = ommlNode('m:oMath');
    const body = Array.from(math.children).filter((node) => node.localName !== 'annotation' && node.localName !== 'annotation-xml');
    const source = body.length === 1 && body[0].localName === 'semantics' ? body[0] : math;
    appendOmml(oMath, mathmlChildren(source));
    if (!oMath.childNodes.length) return '';
    return new XMLSerializer().serializeToString(oMath);
  }

  function mathmlChildren(el) {
    const out = [];
    const nodes = Array.from(el.childNodes).filter((node) => node.nodeType !== 1 || !node._ommlSkip);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 1 && node._ommlSkip) continue;
      if (isFence(node) && nodes[i + 1] && nodes[i + 1].nodeType === 1 && nodes[i + 1].localName === 'mtable' && isFence(nodes[i + 2])) {
        out.push(ommlMatrix(nodes[i + 1], node.textContent, nodes[i + 2].textContent));
        i += 2;
        continue;
      }
      const built = mathmlToOmmlNode(node);
      if (built && built._nary) {
        built.element.appendChild(ommlWrap('m:e', []));
        out.push(built.element);
      } else if (Array.isArray(built)) {
        out.push.apply(out, built.filter(Boolean));
      } else if (built) {
        out.push(built);
      }
    }
    return out;
  }

  function isFence(node) {
    return node && node.nodeType === 1 && node.localName === 'mo' && node.getAttribute('fence') === 'true';
  }

  function uprightText(node) {
    const variant = node.getAttribute('mathvariant') || '';
    return variant === 'normal' || variant === 'bold';
  }

  function mathmlToOmmlNode(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, ' ');
      return text.trim() ? ommlRun(text, false) : null;
    }
    if (node.nodeType !== 1) return null;
    const tag = node.localName;
    if (tag === 'annotation' || tag === 'annotation-xml') return null;
    if (tag === 'math' || tag === 'semantics' || tag === 'mrow' || tag === 'mstyle' || tag === 'mpadded' || tag === 'menclose') {
      return mathmlChildren(node);
    }
    if (tag === 'mi') return ommlRun(node.textContent, !uprightText(node));
    if (tag === 'mn' || tag === 'mtext' || tag === 'ms') return ommlRun(node.textContent, false);
    if (tag === 'mspace') return ommlRun(' ', false);
    if (tag === 'mfenced') return ommlFenced(node);
    if (tag === 'mo') {
      const text = node.textContent.replace(/[\u2061-\u2064]/g, '').replace(/\s+/g, '');
      return text ? ommlRun(text, false) : null;
    }
    if (tag === 'mfrac') return ommlFrac(node);
    if (tag === 'msqrt') return ommlRad(node, false);
    if (tag === 'mroot') return ommlRad(node, true);
    if (tag === 'msup' || tag === 'msub' || tag === 'msubsup') {
      const nary = ommlNaryScript(node, tag === 'msup' ? 'sup' : (tag === 'msub' ? 'sub' : 'subsup'));
      if (nary) return nary;
      return ommlScript(node, tag === 'msup' ? 'sup' : (tag === 'msub' ? 'sub' : 'subsup'));
    }
    if (tag === 'mover') return ommlLimit(node, 'over');
    if (tag === 'munder') return ommlLimit(node, 'under');
    if (tag === 'munderover') return ommlLimit(node, 'underover');
    if (tag === 'mtable') return ommlMatrix(node, '', '');
    return mathmlChildren(node);
  }

  function ommlWrap(name, children) {
    const el = ommlNode(name);
    appendOmml(el, children);
    return el;
  }

  function ommlFenced(node) {
    const parts = Array.from(node.children);
    const open = node.getAttribute('open');
    const close = node.getAttribute('close');
    const separators = node.getAttribute('separators');
    const out = [];
    if (open) out.push(ommlRun(open, false));
    parts.forEach((part, index) => {
      const built = mathmlToOmmlNode(part);
      if (Array.isArray(built)) out.push.apply(out, built.filter(Boolean));
      else if (built) out.push(built);
      if (index < parts.length - 1 && separators) {
        const sep = separators[index] || separators[separators.length - 1];
        if (sep) out.push(ommlRun(sep, false));
      }
    });
    if (close) out.push(ommlRun(close, false));
    return out;
  }

  function ommlFrac(node) {
    const parts = Array.from(node.children);
    const f = ommlNode('m:f');
    const pr = ommlNode('m:fPr');
    const type = ommlNode('m:type');
    type.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', 'bar');
    pr.appendChild(type);
    f.appendChild(pr);
    f.appendChild(ommlWrap('m:num', mathmlChildren(parts[0] || node)));
    f.appendChild(ommlWrap('m:den', mathmlChildren(parts[1] || node)));
    return f;
  }

  function ommlRad(node, hasIndex) {
    const parts = Array.from(node.children);
    const index = hasIndex ? parts[1] : null;
    const base = hasIndex ? parts[0] : parts[0];
    const rad = ommlNode('m:rad');
    const pr = ommlNode('m:radPr');
    const degHide = ommlNode('m:degHide');
    degHide.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', hasIndex ? '0' : '1');
    pr.appendChild(degHide);
    rad.appendChild(pr);
    rad.appendChild(ommlWrap('m:deg', hasIndex && index ? mathmlChildren(index) : []));
    rad.appendChild(ommlWrap('m:e', mathmlChildren(base || node)));
    return rad;
  }

  function ommlScript(node, kind) {
    const parts = Array.from(node.children);
    const names = { sub: ['m:sSub', 'm:sSubPr'], sup: ['m:sSup', 'm:sSupPr'], subsup: ['m:sSubSup', 'm:sSubSupPr'] };
    const s = ommlNode(names[kind][0]);
    s.appendChild(ommlNode(names[kind][1]));
    s.appendChild(ommlWrap('m:e', mathmlChildren(parts[0] || node)));
    if (kind !== 'sup') s.appendChild(ommlWrap('m:sub', mathmlChildren(parts[1] || node)));
    if (kind !== 'sub') s.appendChild(ommlWrap('m:sup', mathmlChildren(parts[kind === 'subsup' ? 2 : 1] || node)));
    return s;
  }

  function ommlNaryScript(node, kind) {
    const parts = Array.from(node.children);
    const op = naryChar(parts[0]);
    const naryOps = { '∑': 1, '∏': 1, '∫': 1, '∬': 1, '∭': 1, '∮': 1, '⋃': 1, '⋂': 1 };
    if (!naryOps[op]) return null;
    const nary = ommlNode('m:nary');
    const pr = ommlNode('m:naryPr');
    const chr = ommlNode('m:chr');
    chr.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', op);
    pr.appendChild(chr);
    const limLoc = ommlNode('m:limLoc');
    limLoc.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', 'subSup');
    pr.appendChild(limLoc);
    const subHide = ommlNode('m:subHide');
    subHide.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', kind === 'sup' ? '1' : '0');
    const supHide = ommlNode('m:supHide');
    supHide.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', kind === 'sub' ? '1' : '0');
    pr.appendChild(subHide);
    pr.appendChild(supHide);
    nary.appendChild(pr);
    nary.appendChild(ommlWrap('m:sub', kind === 'sup' ? [] : mathmlChildren(parts[1] || node)));
    nary.appendChild(ommlWrap('m:sup', kind === 'sub' ? [] : mathmlChildren(parts[kind === 'subsup' ? 2 : 1] || node)));
    return { _nary: true, element: nary };
  }

  function naryChar(node) {
    if (!node) return '';
    if (node.localName === 'mo') return node.textContent.trim();
    if (node.localName === 'mrow' || node.localName === 'mstyle' || node.localName === 'semantics') {
      const child = Array.from(node.children).find((item) => item.localName !== 'annotation' && item.localName !== 'annotation-xml');
      return child ? naryChar(child) : '';
    }
    return '';
  }

  function ommlLimit(node, kind) {
    const parts = Array.from(node.children);
    const op = naryChar(parts[0]);
    const naryOps = { '∑': 1, '∏': 1, '∫': 1, '∬': 1, '∭': 1, '∮': 1, '⋃': 1, '⋂': 1 };
    if (naryOps[op]) {
      const nary = ommlNode('m:nary');
      const pr = ommlNode('m:naryPr');
      const chr = ommlNode('m:chr');
      chr.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', op);
      pr.appendChild(chr);
      const limLoc = ommlNode('m:limLoc');
      limLoc.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', 'undOvr');
      pr.appendChild(limLoc);
      const subHide = ommlNode('m:subHide');
      subHide.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', kind === 'over' ? '1' : '0');
      const supHide = ommlNode('m:supHide');
      supHide.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', kind === 'under' ? '1' : '0');
      pr.appendChild(subHide);
      pr.appendChild(supHide);
      nary.appendChild(pr);
      const lower = kind === 'over' ? null : parts[1];
      const upper = kind === 'under' ? null : parts[kind === 'over' ? 1 : 2];
      nary.appendChild(ommlWrap('m:sub', lower ? mathmlChildren(lower) : []));
      nary.appendChild(ommlWrap('m:sup', upper ? mathmlChildren(upper) : []));
      return { _nary: true, element: nary };
    }
    if (kind !== 'under' && node.getAttribute('accent') === 'true') {
      const mark = (parts[1] ? parts[1].textContent : '').trim();
      const acc = ommlNode('m:acc');
      const pr = ommlNode('m:accPr');
      const chr = ommlNode('m:chr');
      chr.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', mark || '⃗');
      pr.appendChild(chr);
      acc.appendChild(pr);
      acc.appendChild(ommlWrap('m:e', mathmlChildren(parts[0] || node)));
      return acc;
    }
    const lim = ommlNode(kind === 'over' ? 'm:limUpp' : 'm:limLow');
    lim.appendChild(ommlWrap('m:e', mathmlChildren(parts[0] || node)));
    lim.appendChild(ommlWrap('m:lim', mathmlChildren(parts[1] || node)));
    if (kind !== 'underover') return lim;
    const upper = ommlNode('m:limUpp');
    upper.appendChild(ommlWrap('m:e', [lim]));
    upper.appendChild(ommlWrap('m:lim', mathmlChildren(parts[2] || node)));
    return upper;
  }

  function ommlMatrix(node, open, close) {
    const m = ommlNode('m:m');
    const pr = ommlNode('m:mPr');
    const mcs = ommlNode('m:mcs');
    const mc = ommlNode('m:mc');
    const mcPr = ommlNode('m:mcPr');
    const count = ommlNode('m:count');
    const rows = Array.from(node.children).filter((row) => row.localName === 'mtr' || row.localName === 'mlabeledtr');
    const colCount = rows.reduce((max, row) => Math.max(max, Array.from(row.children).filter((cell) => cell.localName === 'mtd').length), 1);
    count.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', String(colCount));
    mcPr.appendChild(count);
    mc.appendChild(mcPr);
    mcs.appendChild(mc);
    pr.appendChild(mcs);
    if (open || close) {
      const beg = ommlNode('m:begChr');
      beg.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', open);
      const end = ommlNode('m:endChr');
      end.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'm:val', close);
      pr.appendChild(beg);
      pr.appendChild(end);
    }
    m.appendChild(pr);
    Array.from(node.children).forEach((row) => {
      if (row.localName !== 'mtr' && row.localName !== 'mlabeledtr') return;
      const mr = ommlNode('m:mr');
      const cells = Array.from(row.children).filter((cell) => cell.localName === 'mtd');
      cells.forEach((cell) => mr.appendChild(ommlWrap('m:e', mathmlChildren(cell))));
      for (let i = cells.length; i < colCount; i++) mr.appendChild(ommlWrap('m:e', []));
      m.appendChild(mr);
    });
    return m;
  }

  async function copyWordFormula(btn, block) {
    const html = wordFormulaHtml(block);
    const ann = block.querySelector('annotation');
    const plain = String(ann ? ann.textContent : block.innerText || '').replace(/\s+/g, ' ').trim();
    if (!html) {
      copyBlockText(btn, plain);
      return;
    }
    const ok = await copyHtml(html, plain);
    if (!ok) {
      if (window.toast) window.toast('复制失败，请重试', true);
      return;
    }
    const label = btn.querySelector('span');
    const prev = label ? label.textContent : '';
    btn.classList.add('copied');
    if (label) label.textContent = '已复制';
    if (window.toast) window.toast('已复制，可粘贴到 Word');
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = prev || '复制';
    }, 1400);
  }

  async function copyHtml(html, plain) {
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext !== false) {
      try {
        const types = {
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain || ''], { type: 'text/plain' })
        };
        await navigator.clipboard.write([new ClipboardItem(types)]);
        return true;
      } catch (e) {}
    }
    if (copyHtmlRaw(html, plain)) return true;
    return copyHtmlFallback(html, plain);
  }

  function copyHtmlRaw(html, plain) {
    let ok = false;
    const onCopy = (event) => {
      event.preventDefault();
      event.clipboardData.setData('text/html', html);
      event.clipboardData.setData('text/plain', plain || '');
      ok = true;
    };
    document.addEventListener('copy', onCopy, true);
    const holder = document.createElement('textarea');
    holder.value = plain || ' ';
    holder.setAttribute('readonly', '');
    holder.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(holder);
    holder.select();
    try { document.execCommand('copy'); } catch (e) { ok = false; }
    document.removeEventListener('copy', onCopy, true);
    holder.remove();
    return ok;
  }

  function copyHtmlFallback(html, plain) {
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    holder.innerHTML = body ? body[1] : html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    const onCopy = (event) => {
      event.preventDefault();
      event.clipboardData.setData('text/html', html);
      event.clipboardData.setData('text/plain', plain || '');
      ok = true;
    };
    document.addEventListener('copy', onCopy, true);
    try { ok = document.execCommand('copy') || ok; } catch (e) {}
    document.removeEventListener('copy', onCopy, true);
    sel.removeAllRanges();
    holder.remove();
    return ok;
  }

  async function copyBlockImage(btn, block) {
    const label = btn.querySelector('span');
    const prev = label ? label.textContent : '';
    if (label) label.textContent = '复制中';
    try {
      const clearChrome = block.classList.contains('mindmap-wrap');
      let png = '';
      if (block.classList.contains('mermaid-wrap')) {
        try { png = await exportMermaidPng(block); } catch (e) { png = ''; }
      }
      if (!png) {
        try { png = await exportRenderedPng(block, { clearChrome: clearChrome }); } catch (e) { png = ''; }
      }
      if (!png) throw new Error('empty');
      const res = await fetch(png);
      const blob = await res.blob();
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btn.classList.add('copied');
      if (label) label.textContent = '已复制';
      if (window.toast) window.toast('已复制图片');
    } catch (e) {
      if (label) label.textContent = '复制失败';
      if (window.toast) window.toast('复制图片失败', true);
    }
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = prev || '复制';
    }, 1400);
  }

  async function copyBlockText(btn, text) {
    const value = String(text || '').replace(/\n$/, '');
    let ok = false;
    if (window.OCUI && window.OCUI.copyText) ok = await window.OCUI.copyText(value);
    else {
      try { await navigator.clipboard.writeText(value); ok = true; } catch (e) { ok = false; }
    }
    if (!ok) {
      if (window.toast) window.toast('复制失败', true);
      return;
    }
    const label = btn.querySelector('span');
    const prev = label ? label.textContent : '';
    btn.classList.add('copied');
    if (label) label.textContent = '已复制';
    if (window.toast) window.toast('已复制');
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = prev || '复制';
    }, 1400);
  }

  function tableToText(table) {
    if (!table) return '';
    return Array.from(table.rows).map((row) =>
      Array.from(row.cells).map((cell) => cell.innerText.replace(/\s+/g, ' ').trim()).join('\t')
    ).join('\n');
  }

  // ============ 工具 ============
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  R.syncMermaidTheme = function () {
    if (typeof mermaid === 'undefined') return;
    try { ensureMermaid(); } catch (e) { return; }
    document.querySelectorAll('.mermaid-wrap[data-src]').forEach((wrap) => {
      const code = wrap.getAttribute('data-src') || '';
      if (!code) return;
      mermaid.render('mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), code)
        .then(({ svg }) => {
          if (!wrap.isConnected || wrap.getAttribute('data-src') !== code) return;
          const actions = wrap.querySelector(':scope > .visual-actions');
          wrap.innerHTML = svg;
          const drawn = wrap.querySelector('svg');
          if (drawn) softenMermaid(drawn);
          if (actions) wrap.appendChild(actions);
          else attachDiagramActions(wrap);
        })
        .catch(() => {});
    });
  };

  R.wordFormulaHtml = wordFormulaHtml;
  window.OCRenderer = R;
})();
