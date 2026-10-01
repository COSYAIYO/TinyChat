#!/usr/bin/env node
/**
 * TinyChat 发版工具:发版前跑一次,把「散落的手工同步」全部自动化。
 *
 *   node tools/release.mjs
 *
 * 做四件事:
 *   1) 压缩业务 JS/CSS 为 .min 旁车文件(esbuild,版本固定保证输出可复现);
 *   2) 四个 HTML 里所有静态资源引用统一改写为 .min + ?v=<TC_VERSION>;
 *   3) sw.js 缓存名同步为 tinychat-static-<TC_VERSION>(activate 时清掉旧缓存);
 *   4) 重新生成 checksums.txt(在线更新的包完整性清单)。
 * 版本号读取自 lib/core.php 的 TC_VERSION —— 发版时只需改它,再跑本脚本。
 *
 * CI 里用 `node tools/release.mjs && git diff --exit-code` 校验产物是否忘记刷新。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ESBUILD = 'esbuild@0.24.2';

const coreSrc = readFileSync(join(ROOT, 'lib/core.php'), 'utf8');
const m = coreSrc.match(/define\('TC_VERSION',\s*'([^']+)'\)/);
if (!m) { console.error('无法从 lib/core.php 读取 TC_VERSION'); process.exit(1); }
const VER = m[1];
console.log('TC_VERSION =', VER);

function esbuildMinify(file, out) {
  execFileSync('npx', ['--yes', ESBUILD, file, '--minify', '--allow-overwrite', `--outfile=${out}`],
    { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
}

// 1) 压缩业务 JS/CSS
const minified = [];
for (const dir of ['static/js', 'static/css']) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (!/\.(js|css)$/.test(name) || /\.min\.(js|css)$/.test(name)) continue;
    if (name === 'sw.js') continue; // 手写小文件,保持可读
    const src = join(ROOT, dir, name);
    const out = src.replace(/(\.(js|css))$/, '.min$1');
    esbuildMinify(src, out);
    minified.push({ src: `${dir}/${name}`, out: `${dir}/${name.replace(/(\.(js|css))$/, '.min$1')}` });
  }
}
for (const f of minified) {
  const kb = statSync(join(ROOT, f.out)).size / 1024;
  console.log(`  min: ${f.out} (${kb.toFixed(0)} KB)`);
}

// 2) 重写 HTML 引用:<body> 前的脚本保持同步执行(主题预置/性能门控),
//    <body> 后的业务脚本与全部 CSS 统一 .min + ?v=;vendor 引用补 ?v=(资源已长缓存)
const pages = ['index.html', 'admin.html', 'login.html', 'share.html'];
const assetRe = /((?:\.\/|\/)?static\/(?:js|css)\/[A-Za-z0-9_-]+)(?:\.min)?\.(js|css)(?:\?v=[A-Za-z0-9._-]+)?/g;
const vendorRe = /((?:\.\/|\/)?vendor\/[A-Za-z0-9_./-]+\.(?:js|css))(\?v=[A-Za-z0-9._-]+)?/g;
for (const page of pages) {
  const file = join(ROOT, page);
  let html = readFileSync(file, 'utf8');
  const bodyAt = html.indexOf('<body');
  if (bodyAt < 0) { console.error(`${page} 找不到 <body>`); process.exit(1); }
  const head = html.slice(0, bodyAt)
    .replace(assetRe, (w, base, ext) => `${base}.min.${ext}?v=${VER}`)
    .replace(vendorRe, (w, base, q) => `${base}?v=${VER}`);
  let body = html.slice(bodyAt).replace(assetRe, (w, base, ext) => `${base}.min.${ext}?v=${VER}`)
    .replace(vendorRe, (w, base, q) => `${base}?v=${VER}`);
  // 给 body 部分的业务脚本补 defer(并行下载、按序执行;perf.js/theme-boot 在 head 已保持同步)
  body = body.replace(/<script (src="[^"]*static\/js\/[A-Za-z0-9_-]+\.min\.js\?v=[^"]*")><\/script>/g, (w, attrs) => `<script defer ${attrs}></script>`);
  writeFileSync(file, head + body);
  console.log(`  page: ${page}`);
}

// 3) sw.js 缓存名联动
const swFile = join(ROOT, 'sw.js');
const sw = readFileSync(swFile, 'utf8').replace(/const CACHE = 'tinychat-static-[^']+';/, `const CACHE = 'tinychat-static-${VER}';`);
writeFileSync(swFile, sw);
console.log('  sw.js CACHE → tinychat-static-' + VER);

// 4) 刷新发布包完整性清单
execFileSync('php', ['tools/make-checksums.php'], { cwd: ROOT, stdio: 'inherit' });
console.log('完成。');
