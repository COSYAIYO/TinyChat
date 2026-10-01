'use strict';
/**
 * reasoning.js — 思考与过程可视化
 *  - 思维链（Chain of Thought）：折叠/展开分步展示
 *  - 工具调用（Tool Calling）：工具名/参数/结果卡片，可折叠
 *  - 多阶段思考状态：Searching → Analyzing → Synthesizing
 *  - 自定义组件注册到 OCRenderer
 */

(function () {
  const R = window.OCRenderer;

  // ============ 思维链组件 ============
  // ::: reasoning
  // step1 内容
  // step2 内容
  // ...
  // :::
  // 每行以 "步骤标题\n缩进内容" 或简单行分隔
  R.registerComponent('thinking', function ({ params, body }) {
    return buildReasoning(body, params, 'thinking');
  });
  R.registerComponent('reasoning', function ({ params, body }) {
    return buildReasoning(body, params, 'thinking');
  });

  function buildReasoning(content, params, type) {
    // 折叠状态：默认折叠，可用参数 expanded
    const expanded = /expanded|open/i.test(params || '');
    // 解析步骤：按 "### 标题" 或 "#### " 分段，或按行分隔
    const steps = [];
    const lines = (content || '').split('\n');
    let current = null;
    const orderedTitle = /^#+\s+(.+)$/;

    lines.forEach((line) => {
      const m = line.match(orderedTitle);
      if (m) {
        current = { title: m[1].trim(), body: [] };
        steps.push(current);
      } else if (current) {
        current.body.push(line);
      } else {
        // 无标题行，作为单一步骤
        current = { title: '', body: [line] };
        steps.push(current);
        current = null;
      }
    });

    const html = steps.map((s, i) => {
      const title = s.title || '步骤 ' + (i + 1);
      const renderedBody = R.render(s.body.join('\n'));
      return '<details class="reasoning-step" ' + (expanded || i === 0 ? '' : '') + '>'
        + '<summary><span class="step-num">' + (i + 1) + '</span>' + escapeHtml(title)
        + '<span class="step-toggle">' + (expanded ? '▾' : '▸') + '</span></summary>'
        + '<div class="reasoning-body">' + renderedBody + '</div>'
        + '</details>';
    }).join('');

    const open = expanded ? 'open' : '';
    return '<div class="reasoning-wrap ' + type + (expanded ? ' open' : '') + '" data-role="reasoning">'
      + '<div class="reasoning-header" onclick="var w=this.parentElement;w.classList.toggle(\'open\');var s=w.querySelector(\'.reasoning-steps\');if(s)s.style.display=w.classList.contains(\'open\')?\'\':\'none\';">'
      + '<span class="reasoning-icon">' + window.OC.icon('think', 14) + '</span>'
      + '<span class="reasoning-title">思考过程<' + '/span>'
      + '<span class="reasoning-count">' + steps.length + ' 步</span>'
      + '<span class="reasoning-chev">' + window.OC.icon('chevronDown', 14) + '</span>'
      + '</div>'
      + '<div class="reasoning-steps" style="' + (expanded ? '' : 'display:none') + '">' + html + '</div>'
      + '</div>';
  }

  // ============ 工具调用组件 ============
  // ::: tool name=xxx
  // ## 调用参数
  // ```json
  // {...}
  // ```
  // ## 返回结果
  // ```json
  // {...}
  // ```
  // :::
  R.registerComponent('tool_call', function ({ params, body }) {
    return buildToolCall(params, body);
  });
  R.registerComponent('tool', function ({ params, body }) {
    return buildToolCall(params, body);
  });

  function buildToolCall(params, content) {
    const nameMatch = params.match(/name\s*=?\s*["']?([^"'\s]+)/i);
    const name = nameMatch ? nameMatch[1] : '工具';
    const defaultOpen = /expanded|open/i.test(params);

    // 分隔参数与结果
    const argMatch = content.match(/##\s*(?:调用)?参数\s*[\r\n]+([\s\S]*?)(?:##|$)/i);
    const resultMatch = content.match(/##\s*(?:返回)?结果\s*[\r\n]+([\s\S]*?)(?:##|$)/i);
    const argsHtml = argMatch ? R.render(argMatch[1].trim()) : '';
    const resultHtml = resultMatch ? R.render(resultMatch[1].trim()) : '';

    return '<div class="tool-call ' + (defaultOpen ? 'open' : '') + '">'
      + '<div class="tool-call-header" onclick="this.parentElement.classList.toggle(\'open\');">'
      + '<span class="tool-icon">' + window.OC.icon('wrench', 14) + '</span>'
      + '<span class="tool-name">' + escapeHtml(name) + '</span>'
      + '<span class="tool-status">已调用</span>'
      + '<span class="reasoning-chev">' + window.OC.icon('chevronDown', 14) + '</span>'
      + '</div>'
      + '<div class="tool-call-body" style="' + (defaultOpen ? '' : 'display:none') + '">'
      + (argsHtml ? '<div class="tool-section"><div class="tool-section-title">调用参数</div>' + argsHtml + '</div>' : '')
      + (resultHtml ? '<div class="tool-section"><div class="tool-section-title">返回结果</div>' + resultHtml + '</div>' : '')
      + '</div>'
      + '</div>';
  }

  // ============ 多阶段思考状态（流式期间） ============
  // 阶段循环：检索中 → 分析中 → 整理中(中文界面,占位文案不再用英文)
  const PHASES = ['思考中', '分析中', '整理中'];

  function createPhaseIndicator() {
    const el = document.createElement('div');
    el.className = 'phase-indicator';
    el.innerHTML = '<span class="phase-spinner"></span><span class="phase-text"></span>';
    return el;
  }

  function startPhases(container, phases) {
    const list = phases || PHASES;
    const el = createPhaseIndicator();
    let idx = 0;
    el.querySelector('.phase-text').textContent = list[0];
    el.dataset.phaseIdx = '0';
    container.appendChild(el);
    const timer = setInterval(() => {
      idx = (idx + 1) % list.length;
      el.querySelector('.phase-text').textContent = list[idx];
      el.dataset.phaseIdx = String(idx);
    }, 2400);
    return {
      el,
      stop() { clearInterval(timer); el.remove(); },
      setPhase(p) { el.querySelector('.phase-text').textContent = p; }
    };
  }

  window.OCReasoning = {
    buildReasoning,
    buildToolCall,
    startPhases,
    PHASES,
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();