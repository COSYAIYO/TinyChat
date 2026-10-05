<?php
/**
 * JSON 边车文件并发自检的 worker 端:被 tests/json-sidecars.php 用多个进程拉起。
 * 不放业务断言,只负责「并发地做同一种修改」,由主测试文件校验最终结果。
 */

// kind=login:反复记录登录失败(期望每个 worker 的 key 计数正好等于 iters)
// kind=notes:反复往索引里加不同键(期望一个都不丢)
function tc_sidecar_worker($dataDir, $kind, $tag, $iters) {
    putenv('DATA_DIR=' . $dataDir);
    $_SERVER['REQUEST_METHOD'] = 'GET';
    require __DIR__ . '/../lib/core.php';
    for ($i = 0; $i < $iters; $i++) {
        if ($kind === 'login') {
            tc_note_login_fail(array('loginMaxFails' => 100000, 'loginLockMs' => 60000), 'u' . $tag);
        } elseif ($kind === 'notes') {
            tc_json_mutate($dataDir . '/notesidx.json', function ($cur) use ($tag, $i) {
                $cur['files']['w' . $tag . '_' . $i] = 'note' . $tag;
                return $cur;
            }, array('owners' => array(), 'files' => array()));
        }
    }
}

// 并发抢笔记 AI 配额:等主进程放行后调一次真实的 tc_note_ai_consume。
// 被放行则进程正常返回并写下标记文件;超限时 tc_fail 会 exit,
// 由 shutdown 钩子兜住(它拿不到「已放行」标记)。标记文件数 == 放行次数。
function tc_ai_worker($dataDir, $limit) {
    putenv('DATA_DIR=' . $dataDir);
    $_SERVER['REQUEST_METHOD'] = 'GET';
    require __DIR__ . '/../lib/api.php';
    // 等所有 worker 就绪,尽量让它们同时冲进临界区
    $ready = $dataDir . '/ready-' . getmypid() . '.txt';
    file_put_contents($ready, '1');
    $go = $dataDir . '/go';
    $deadline = microtime(true) + 10;
    while (!is_file($go) && microtime(true) < $deadline) usleep(2000);

    $db = array('settings' => array('notesAiDailyLimit' => $limit));
    tc_note_ai_consume($db, 'uX');   // 超限时这里 tc_fail → exit
    file_put_contents($dataDir . '/granted-' . getmypid() . '.txt', '1');
}
