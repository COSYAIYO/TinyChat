/* logos.js 图标匹配自检:
 *   node tests/logos-check.js
 * 1) 规则里引用的每个图标文件都必须存在于 static/logo/;
 * 2) 关键模型/供应商文本必须命中预期图标(防止名字改动后静默回退到站点 logo)。
 * 任何一项不通过即以非 0 退出,供 CI 使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'js', 'logos.js'), 'utf8');

// 在最小沙箱里执行 logos.js,拿到 OC 上的解析函数
const warnings = [];
const sandbox = {
  console: { warn: (...a) => warnings.push(a.join(' ')), log: () => {} },
  window: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const OC = sandbox.OC;
if (!OC || typeof OC.logoMatch !== 'function') {
  console.error('✗ logos.js 未正确导出 OC.logoMatch');
  process.exit(1);
}

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// 1. 规则目标文件存在性(库内已跳过缺失项,这里直接检查告警列表)
if (OC.logoMissingRules.length) {
  bad('存在指向缺失文件的规则: ' + OC.logoMissingRules.join(', '));
} else {
  ok('全部规则目标文件均存在');
}

// 1b. FILES 清单必须与 static/logo 实际文件一致:防止新增图标后忘记补清单,
//     导致新图标被当成"缺失"而在运行时被跳过。
const dirFiles = fs.readdirSync(path.join(root, 'static', 'logo'))
  .filter((f) => f.endsWith('.svg')).sort();
const declared = [...src.matchAll(/'([^']+\.svg)':\s*1/g)].map((m) => m[1]).sort();
const notDeclared = dirFiles.filter((f) => declared.indexOf(f) < 0);
const notOnDisk = declared.filter((f) => dirFiles.indexOf(f) < 0);
if (notDeclared.length) bad('static/logo 下这些图标未登记进 FILES,会被当成缺失: ' + notDeclared.join(', '));
if (notOnDisk.length) bad('FILES 登记了磁盘上不存在的图标: ' + notOnDisk.join(', '));
if (!notDeclared.length && !notOnDisk.length) ok('FILES 清单与 static/logo 实际文件一致(' + dirFiles.length + ' 个)');

// 2. 关键命中用例:文本 -> 期望图标文件(不含 static/logo/ 前缀)
const CASES = [
  ['agnes', 'agnesai.svg'],
  ['agnes-ai/agnes-pro', 'agnesai.svg'],
  ['Agnes AI', 'agnesai.svg'],
  ['AgnesAI', 'agnesai.svg'],
  ['deepseek/deepseek-chat', 'deepseek-color.svg'],
  ['claude-3-5-sonnet', 'claude-color.svg'],
  ['claude-opus-4', 'claude-color.svg'],
  // 模型 id + 供应商名同时出现时,具体品牌应胜过公司层图标
  ['anthropic/claude-haiku', 'claude-color.svg'],
  ['claude-3-5-sonnet Claude 3.5 Anthropic', 'claude-color.svg'],
  ['anthropic', 'anthropic.svg'],
  ['doubao-seed-1.6 Doubao ByteDance', 'doubao-color.svg'],
  ['llama-3.1-70b Meta', 'meta-color.svg'],
  ['gemini-2.5-pro Google', 'gemini-color.svg'],
  ['gpt-4o', 'openai.svg'],
  ['o3-mini', 'openai.svg'],
  ['chatgpt-4o-latest', 'openai.svg'],
  ['gemini-2.5-pro', 'gemini-color.svg'],
  ['qwen-max', 'qwen-color.svg'],
  ['Qwen/Qwen3', 'qwen-color.svg'],
  ['glm-4-plus', 'zhipu-color.svg'],
  ['moonshot-v1-8k', 'kimi-color.svg'],
  ['doubao-seed-1.6', 'doubao-color.svg'],
  ['hunyuan-turbo', 'hunyuan-color.svg'],
  ['grok-4', 'grok.svg'],
  ['llama-3.1-70b', 'meta-color.svg'],
  ['mixtral-8x7b', 'mistral-color.svg'],
  ['command-r-plus', 'cohere-color.svg'],
  ['sonar-pro', 'perplexity-color.svg'],
  ['flux-1.1-pro', 'flux.svg'],
  ['stable-diffusion-xl', 'stability-color.svg'],
  ['kling-v2', 'kling-color.svg'],
  ['yi-large', 'yi-color.svg'],
  ['lingyiwanwu/yi-lightning', 'yi-color.svg'],
  ['openrouter/auto', 'openrouter-color.svg'],
  ['replicate/foo', 'replicate.svg'],
  ['tavily-search', 'tavily-color.svg'],
  ['xiaomi/mimo-7b', 'xiaomimimo.svg'],
  ['unknown-model-xyz', ''],       // 未命中应为空(调用方回退站点 logo)
];
CASES.forEach(([text, want]) => {
  const got = OC.logoMatch(text);
  if (got === want) ok('匹配 ' + JSON.stringify(text) + ' -> ' + (got || '(站点 logo)'));
  else bad('匹配 ' + JSON.stringify(text) + ' 期望 [' + want + '] 实际 [' + got + ']');
});

// 3. modelLogo 的站点回退与缓存不应出错
if (OC.modelLogo('definitely-not-a-real-brand') === ':site:') ok('未命中回退站点 logo');
else bad('未命中未回退站点 logo');

// 3b. 模型优先、供应商兜底:模型命中时供应商名不得盖过它
const fb1 = OC.modelLogoWithFallback('claude-3-5-sonnet Claude Sonnet', 'Agnes AI');
if (fb1 === 'static/logo/claude-color.svg') ok('模型优先于供应商名(claude vs Agnes AI)');
else bad('模型优先规则失效,实际 ' + fb1);
const fb2 = OC.modelLogoWithFallback('some-unknown-model', 'Agnes AI');
if (fb2 === 'static/logo/agnesai.svg') ok('模型未命中时回退供应商名');
else bad('供应商兜底失效,实际 ' + fb2);

if (warnings.length) console.log('\n(warn) ' + warnings.join('\n(warn) '));
console.log('\n' + (fail ? '✗ logos 自检失败: ' + fail + ' 项' : '✓ logos 自检通过'));
process.exit(fail ? 1 : 0);
