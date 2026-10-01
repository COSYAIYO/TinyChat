<?php
/**
 * 生成发布包完整性清单 checksums.txt。
 *
 * 在线更新会在解压后、覆盖前逐文件比对 sha256(见 lib/updater.php 的
 * tc_update_verify_checksums),能拦住下载损坏与加速镜像篡改。
 *
 * 发版前必须重跑一次,保证清单与最终代码一致:
 *
 *   php tools/make-checksums.php
 *
 * CI 会在 push 时校验清单是否最新(见 .github/workflows/ci.yml)。
 * 只收录 git 跟踪的文件。工作区里的日志、计划草稿、误生成的空文件
 * 不会进发布包,写进清单后会让干净检出上的重跑和已提交清单对不上。
 */

// 不纳入清单的内容:用户数据/本地配置/开发产物/清单自身
$EXCLUDE_TOP = array('data', 'config.php', '.git', '.tmp', '.github', 'gui-test-screenshots', 'node_modules');
$EXCLUDE_FILES = array('checksums.txt');

chdir(dirname(__DIR__));

$proc = proc_open('git ls-files -z', array(1 => array('pipe', 'w'), 2 => array('pipe', 'w')), $pipes);
if (!is_resource($proc)) { fwrite(STDERR, "无法执行 git ls-files\n"); exit(1); }
$raw = stream_get_contents($pipes[1]);
$err = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
if (proc_close($proc) !== 0) { fwrite(STDERR, "git ls-files 失败: {$err}\n"); exit(1); }

$entries = array();
foreach (explode("\0", $raw) as $rel) {
    if ($rel === '') continue;
    $rel = str_replace('\\', '/', $rel);
    $top = strtok($rel, '/');
    if (in_array($top, $EXCLUDE_TOP, true)) continue;
    if (in_array($rel, $EXCLUDE_FILES, true)) continue;
    if (!is_file($rel)) { fwrite(STDERR, "清单文件缺失: {$rel}\n"); exit(1); }
    $hash = hash_file('sha256', $rel);
    if ($hash === false) { fwrite(STDERR, "无法读取: {$rel}\n"); exit(1); }
    $entries[] = $hash . '  ' . $rel;
}
sort($entries, SORT_STRING);

$header = array(
    '# TinyChat 发布包完整性清单',
    '# 由 tools/make-checksums.php 生成;发版前请重跑: php tools/make-checksums.php',
    '# 格式: <sha256>  <相对路径>',
    '',
);
file_put_contents('checksums.txt', implode("\n", $header) . implode("\n", $entries) . "\n");
echo 'checksums.txt 已生成: ' . count($entries) . " 个文件\n";
