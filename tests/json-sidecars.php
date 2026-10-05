<?php
/**
 * JSON 边车文件并发自检: php tests/json-sidecars.php
 * data/ 下有几类不走 SQLite 的小文件(登录失败计数、笔记附件索引、笔记 AI 每日配额)。
 * 旧实现是「file_get_contents 读 → 改 → file_put_contents(..., LOCK_EX) 写」:
 * LOCK_EX 只锁得住「写」,读在锁外,并发请求会互相覆盖(附件索引丢映射、
 * 配额超发、失败计数少记)。tc_json_mutate 把读改写放进同一把锁。
 * 这里真起多个进程同时改,验证不丢更新。退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-sidecar-' . bin2hex(random_bytes(4));
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';

$fail = 0;
$check = function ($name, $got, $want) use (&$fail) {
    if ($got === $want) {
        echo "  ✓ " . $name . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . " 期望 " . var_export($want, true) . "，实际 " . var_export($got, true) . "\n";
    }
};
@mkdir($dataDir, 0755, true);

// ---------- 基础行为 ----------
$f = $dataDir . '/basic.json';
$r = tc_json_mutate($f, function ($cur) { $cur['a'] = 1; return $cur; }, array());
$check('新建文件写入', $r, array('a' => 1));
$r = tc_json_mutate($f, function ($cur) { $cur['b'] = 2; return $cur; }, array());
$check('已有文件增量修改', $r, array('a' => 1, 'b' => 2));
$r = tc_json_mutate($f, function ($cur) { return null; }, array());
$check('回调返回 null 时保持原值', $r, array('a' => 1, 'b' => 2));
$check('返回 null 时不落盘', json_decode((string) file_get_contents($f), true), array('a' => 1, 'b' => 2));

// 覆盖写要截断:新内容更短时不能留旧尾巴
$long = $dataDir . '/trunc.json';
file_put_contents($long, json_encode(array('k' => str_repeat('x', 500))));
tc_json_mutate($long, function ($cur) { return array('k' => 'y'); }, array());
$check('短内容覆盖后仍是合法 JSON', json_decode((string) file_get_contents($long), true), array('k' => 'y'));

// 损坏文件按默认值处理,不炸
$bad = $dataDir . '/bad.json';
file_put_contents($bad, '{not json');
$r = tc_json_mutate($bad, function ($cur) { $cur['ok'] = true; return $cur; }, array());
$check('损坏文件按默认值继续', $r, array('ok' => true));

// ---------- 并发 ----------
$workers = 6;
$iters = 60;

// --- 登录失败计数:6 进程 × 60 次,每个 worker 的 key 必须记满 60 ---
$loginFile = $dataDir . '/login-fails.json';
@unlink($loginFile);
$procs = array();
for ($w = 0; $w < $workers; $w++) {
    $script = $dataDir . '/worker-login-' . $w . '.php';
    file_put_contents($script, "<?php\n"
        . "define('TC_ROOT', " . var_export(TC_ROOT, true) . ");\n"
        . "require " . var_export(__DIR__ . '/json-sidecars-worker.php', true) . ";\n"
        . "tc_sidecar_worker(" . var_export($dataDir, true) . ", 'login', " . var_export((string) $w, true) . ", $iters);\n");
    $procs[] = popen(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($script) . ' 2>&1', 'r');
}
$errs = '';
foreach ($procs as $p) { $errs .= (string) stream_get_contents($p); pclose($p); }
$state = json_decode((string) @file_get_contents($loginFile), true);
$counts = array();
foreach ((array) $state as $v) $counts[] = (int) ($v['count'] ?? 0);
sort($counts);
$check('登录失败计数: worker 数量', count($counts), $workers);
$check('登录失败计数: 每个 key 记满 ' . $iters . ' 次(无丢更新)', $counts, array_fill(0, $workers, $iters));

// --- 附件索引:6 进程 × 60 个键,一个都不能丢 ---
$idxFile = $dataDir . '/notesidx.json';
@unlink($idxFile);
$procs = array();
for ($w = 0; $w < $workers; $w++) {
    $script = $dataDir . '/worker-notes-' . $w . '.php';
    file_put_contents($script, "<?php\n"
        . "define('TC_ROOT', " . var_export(TC_ROOT, true) . ");\n"
        . "require " . var_export(__DIR__ . '/json-sidecars-worker.php', true) . ";\n"
        . "tc_sidecar_worker(" . var_export($dataDir, true) . ", 'notes', " . var_export((string) $w, true) . ", $iters);\n");
    $procs[] = popen(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($script) . ' 2>&1', 'r');
}
$errs2 = '';
foreach ($procs as $p) { $errs2 .= (string) stream_get_contents($p); pclose($p); }
$idx = json_decode((string) @file_get_contents($idxFile), true);
$check('附件索引: 写入键数(无丢更新)', count((array) ($idx['files'] ?? array())), $workers * $iters);

// --- 笔记 AI 配额:并发下不能超发 ---
// 30 个进程同时冲一个上限 10 的配额:旧实现(锁外读、锁内写)会明显超过 10。
// 进程就绪后由主进程创建 go 文件放行,尽量对齐起跑线。
$aiFile = $dataDir . '/notes/ai-usage.json';
@unlink($aiFile);
$limit = 10;
$racerCount = 30;
$procs = array();
for ($w = 0; $w < $racerCount; $w++) {
    $script = $dataDir . '/worker-ai-' . $w . '.php';
    file_put_contents($script, "<?php\n"
        . "define('TC_ROOT', " . var_export(TC_ROOT, true) . ");\n"
        . "require " . var_export(__DIR__ . '/json-sidecars-worker.php', true) . ";\n"
        . "tc_ai_worker(" . var_export($dataDir, true) . ", $limit);\n");
    $procs[] = popen(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($script) . ' 2>&1', 'r');
}
// 等全部就绪(最多 15 秒),再放行
$deadline = microtime(true) + 15;
while (count((array) @glob($dataDir . '/ready-*.txt')) < $racerCount && microtime(true) < $deadline) usleep(20000);
$readyN = count((array) @glob($dataDir . '/ready-*.txt'));
file_put_contents($dataDir . '/go', '1');
$errs3 = '';
foreach ($procs as $p) { $errs3 .= (string) stream_get_contents($p); pclose($p); }
$granted = count((array) @glob($dataDir . '/granted-*.txt'));
$stored = json_decode((string) @file_get_contents($aiFile), true);
$storedN = (int) ($stored['uX']['n'] ?? 0);
$check('笔记 AI 配额: 全部 worker 就绪', $readyN, $racerCount);
$check('笔记 AI 配额: 放行次数不超过上限 ' . $limit, $granted <= $limit, true);
$check('笔记 AI 配额: 计数与放行次数一致', $storedN, $granted);
$check('笔记 AI 配额: 确实发生了并发争抢(放行 > 0)', $granted > 0, true);

// 配额被拒时 worker 会输出 tc_fail 的 JSON(预期路径),只报告真正的错误
$noise = trim($errs . $errs2 . $errs3);
$noise = trim(str_replace('{"error":{"message":"今日笔记 AI 次数已用完（10 次），可在后台调整上限"}}', '', $noise));
if ($noise !== '') echo "  ! worker 输出: " . $noise . "\n";

// ---------- 清理 ----------
foreach ((array) @glob($dataDir . "/notes/*") as $p) { @unlink($p); }
@rmdir($dataDir . "/notes");
foreach ((array) @glob($dataDir . "/*") as $p) { if (is_file($p)) @unlink($p); }
@rmdir($dataDir);

echo $fail ? "\n$fail 项未通过\n" : "\n全部通过\n";
exit($fail ? 1 : 0);
