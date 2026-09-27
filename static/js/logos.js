/* 模型/供应商图标解析:按关键词匹配 static/logo 下的 SVG。
 * 用法:
 *   OC.modelLogo('deepseek/deepseek-v4-flash') -> 'static/logo/deepseek-color.svg'
 *   OC.providerLogo(provider.models, provider.name) -> 命中关键词最多的图标
 *   OC.chatLogo(chat) -> 会话最近使用的模型图标
 */
(function () {
  'use strict';
  const BASE = 'static/logo/';

  // [关键词, 图标文件];同一段文本命中多个关键词时,取关键词最长者(更具体)
  const RULES = [
    ['deepseek', 'deepseek-color.svg'],
    ['kimi', 'kimi-color.svg'],
    ['moonshot', 'kimi-color.svg'],
    ['chatglm', 'chatglm-color.svg'],
    ['zhipu', 'zhipu-color.svg'],
    ['glm', 'zhipu-color.svg'],
    ['zai', 'zai.svg'],
    ['claude', 'claude-color.svg'],
    ['anthropic', 'anthropic.svg'],
    ['gemini', 'gemini-color.svg'],
    ['gemma', 'gemma-color.svg'],
    ['vertex', 'vertexai-color.svg'],
    ['deepmind', 'deepmind-color.svg'],
    ['google', 'google-color.svg'],
    ['dall-e', 'dalle-color.svg'],
    ['dalle', 'dalle-color.svg'],
    ['openai', 'openai.svg'],
    ['chatgpt', 'openai.svg'],
    ['codex', 'openai.svg'],
    ['chatgpt', 'openai.svg'],
    ['sora', 'openai.svg'],
    ['o4-', 'openai.svg'],
    ['o3-', 'openai.svg'],
    ['o1-', 'openai.svg'],
    ['gpt', 'openai.svg'],
    ['qwen', 'qwen-color.svg'],
    ['qwq', 'qwen-color.svg'],
    ['qvq', 'qwen-color.svg'],
    ['tongyi', 'qwen-color.svg'],
    ['doubao', 'doubao-color.svg'],
    ['seedance', 'doubao-color.svg'],
    ['seedream', 'doubao-color.svg'],
    ['seed-oss', 'doubao-color.svg'],
    ['bytedance', 'bytedance-color.svg'],
    ['minimax', 'minimax-color.svg'],
    ['abab', 'minimax-color.svg'],
    ['hunyuan', 'hunyuan-color.svg'],
    ['yuanbao', 'yuanbao-color.svg'],
    ['wenxin', 'wenxin-color.svg'],
    ['ernie', 'wenxin-color.svg'],
    ['qingyan', 'qingyan-color.svg'],
    ['baidu', 'baidu-color.svg'],
    ['mistral', 'mistral-color.svg'],
    ['mixtral', 'mistral-color.svg'],
    ['llama', 'meta-color.svg'],
    ['meta-', 'meta-color.svg'],
    ['phi-', 'microsoft-color.svg'],
    ['microsoft', 'microsoft-color.svg'],
    ['azure', 'azureai-color.svg'],
    ['copilot', 'copilot-color.svg'],
    ['grok', 'grok.svg'],
    ['groq', 'groq.svg'],
    ['command-r', 'cohere-color.svg'],
    ['command', 'cohere-color.svg'],
    ['coral', 'cohere-color.svg'],
    ['cohere', 'cohere-color.svg'],
    ['perplexity', 'perplexity-color.svg'],
    ['sonar', 'perplexity-color.svg'],
    ['stable-diffusion', 'stability-color.svg'],
    ['stability', 'stability-color.svg'],
    ['sdxl', 'stability-color.svg'],
    ['sd3', 'stability-color.svg'],
    ['flux', 'flux.svg'],
    ['midjourney', 'midjourney.svg'],
    ['niji', 'midjourney.svg'],
    ['runway', 'runway.svg'],
    ['gen-3', 'runway.svg'],
    ['gen-4', 'runway.svg'],
    ['luma', 'luma-color.svg'],
    ['ray-2', 'luma-color.svg'],
    ['kling', 'kling-color.svg'],
    ['suno', 'suno.svg'],
    ['nano-banana', 'nanobanana-color.svg'],
    ['nanobanana', 'nanobanana-color.svg'],
    ['baichuan', 'baichuan-color.svg'],
    ['tiangong', 'tiangong-color.svg'],
    ['longcat', 'longcat-color.svg'],
    ['xiaomi', 'xiaomimimo.svg'],
    ['mimo', 'xiaomimimo.svg'],
    ['yi-', 'yi-color.svg'],
    ['ollama', 'ollama.svg'],
    ['openrouter', 'openrouter-color.svg'],
    ['huggingface', 'huggingface-color.svg'],
    ['together', 'together-color.svg'],
    ['fireworks', 'fireworks-color.svg'],
    ['hubmix', 'aihubmix-color.svg'],
    ['bocha', 'bocha-color.svg'],
    ['brave', 'brave-color.svg'],
    ['tavily', 'tavily-color.svg'],
    ['searx', 'searxng-color.svg'],
    ['fastgpt', 'fastgpt-color.svg'],
    ['monica', 'monica-color.svg'],
    ['antigravity', 'antigravity-color.svg'],
    ['apple', 'apple.svg'],
    ['aimass', 'aimass-color.svg'],
    ['agnes', 'agnesai-color.svg'],
    ['replicate', 'replicate.svg'],
  ];

  const url = (file) => (file ? BASE + file : '');
  const cache = new Map();
  // 未命中任何关键词时回退到站点 logo(HTML 由 OC.logoImg 输出,深浅主题自动切换)
  const SITE_LOGO = ':site:';

  function matchFile(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return '';
    let bestFile = '';
    let bestLen = 0;
    for (let i = 0; i < RULES.length; i++) {
      const kw = RULES[i][0];
      if (kw.length <= bestLen) continue;
      if (t.indexOf(kw) >= 0) {
        bestFile = RULES[i][1];
        bestLen = kw.length;
      }
    }
    return bestFile;
  }

  function modelLogo(text) {
    const key = String(text || '').toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const file = matchFile(key);
    const u = file ? url(file) : SITE_LOGO;
    cache.set(key, u);
    return u;
  }

  // 供渲染端统一生成 <img>:普通 URL 单图;站点 logo 输出深浅双图,靠 brand-logo-light/dark 类随主题切换
  function logoImg(icon, cls) {
    if (!icon) return '';
    if (icon === SITE_LOGO) {
      return '<img class="' + cls + ' brand-logo-light" src="./logo.svg" alt="" loading="lazy">'
        + '<img class="' + cls + ' brand-logo-dark" src="./logo-dark.svg" alt="" loading="lazy">';
    }
    return '<img class="' + cls + '" src="' + icon + '" alt="" loading="lazy">';
  }

  const modelText = (m) => {
    if (typeof m === 'string') return m;
    if (!m || typeof m !== 'object') return '';
    return String(m.id || m.name || '') + ' ' + String(m.name || '');
  };

  // 供应商图标:统计其模型列表中各图标被命中的次数,取命中最多者;一个没命中时退回按供应商名匹配
  function providerLogo(models, providerName) {
    const counts = new Map();
    (Array.isArray(models) ? models : []).forEach((m) => {
      const t = String(modelText(m)).toLowerCase();
      if (!t) return;
      for (let i = 0; i < RULES.length; i++) {
        if (t.indexOf(RULES[i][0]) >= 0) counts.set(RULES[i][1], (counts.get(RULES[i][1]) || 0) + 1);
      }
    });
    let bestFile = '';
    let bestN = 0;
    RULES.forEach(([kw, file]) => {
      const n = counts.get(file) || 0;
      if (n > bestN || (n > 0 && n === bestN && kw.length > (matchKeyLen(bestFile) || 0))) {
        bestFile = file;
        bestN = n;
      }
    });
    if (bestFile) return url(bestFile);
    return modelLogo(providerName || '');
  }

  const matchKeyLen = (file) => {
    let len = 0;
    RULES.forEach(([kw, f]) => { if (f === file && kw.length > len) len = kw.length; });
    return len;
  };

  // 会话图标:取最后一条带模型信息的消息;没有模型信息或未命中时用站点 logo
  function chatLogo(chat) {
    const msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const model = m && typeof m === 'object' ? String(m.model || '') : '';
      if (model) return modelLogo(model);
    }
    return SITE_LOGO;
  }

  window.OC = window.OC || {};
  window.OC.modelLogo = modelLogo;
  window.OC.providerLogo = providerLogo;
  window.OC.chatLogo = chatLogo;
  window.OC.logoImg = logoImg;
})();
