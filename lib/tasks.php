<?php
require_once __DIR__ . '/core.php';

// 任务文件:断线恢复用,存储一次流式响应的原始 SSE 分片。
// 旧实现是单 JSON 对象,每收到一个 chunk 都要整文件读出→追加→整体重写,
// 长回复的磁盘写随响应长度平方增长;现改为 NDJSON 追加写:
//   {id}.ndjson  首行 header(t=h),之后每行一条事件(t=e)或字段覆盖(t=m)
//   {id}.st      状态旁车文件(仅 status/error/updatedAt),供追加时低成本探测取消
// 旧格式 {id}.json 在 6 小时 GC 窗口内仍可读,升级无需停机。

function tc_task_dir() {
    $dir = tc_data_dir() . '/tasks';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// 任务文件在流结束后仍需保留一段时间供断线恢复重放;这里惰性清理超过 6 小时的旧任务。
// 以二十分之一的概率触发,分摊目录扫描成本;文件含完整对话内容,不可无限堆积
function tc_task_gc() {
    static $ran = false;
    if ($ran) return;
    $ran = true;
    if (random_int(1, 20) !== 1) return;
    $dir = tc_task_dir();
    if (!is_dir($dir)) return;
    $cut = time() - 6 * 3600;
    foreach ((array) @scandir($dir) as $f) {
        $f = (string) $f;
        if (preg_match('/^[A-Za-z0-9_-]{1,32}\.(ndjson|st|json)$/', $f) || strpos($f, '.tmp.') !== false) {
            $full = $dir . '/' . $f;
            if (@filemtime($full) < $cut) @unlink($full);
        }
    }
}

function tc_task_paths($id) {
    $base = tc_task_dir() . '/' . preg_replace('/[^A-Za-z0-9_-]/', '', (string) $id);
    return array('log' => $base . '.ndjson', 'state' => $base . '.st', 'legacy' => $base . '.json');
}

// 状态旁车:独立于 ndjson 的小文件,追加方每个窗口读一次即可感知取消,不必折整包
function tc_task_state_read($paths) {
    $j = json_decode((string) @file_get_contents($paths['state']), true);
    return is_array($j) ? $j : null;
}

function tc_task_state_write($paths, $fields) {
    @file_put_contents($paths['state'], tc_json_encode($fields), LOCK_EX);
}

// 逐行折叠 ndjson 为旧版任务结构;读侧加共享锁避免读到半行
function tc_task_fold($file) {
    $fp = @fopen($file, 'r');
    if (!$fp) return null;
    @flock($fp, LOCK_SH);
    $task = null;
    $seq = 0;
    $events = array();
    while (($line = fgets($fp)) !== false) {
        $line = trim($line);
        if ($line === '') continue;
        $j = json_decode($line, true);
        if (!is_array($j)) continue;
        $type = isset($j['t']) ? (string) $j['t'] : '';
        if ($type === 'h') {
            $task = $j;
        } elseif ($type === 'e') {
            $seq = (int) (isset($j['seq']) ? $j['seq'] : $seq + 1);
            $events[] = array('seq' => $seq, 'data' => (string) (isset($j['data']) ? $j['data'] : ''));
        } elseif ($type === 'm' && is_array($task)) {
            foreach ($j as $k => $v) if ($k !== 't') $task[$k] = $v;
        }
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    if (!is_array($task)) return null;
    unset($task['t']);
    if (count($events) > 8000) $events = array_slice($events, -8000);
    $task['seq'] = $seq;
    $task['events'] = $events;
    return $task;
}

function tc_task_read($id) {
    $paths = tc_task_paths($id);
    $task = null;
    if (is_file($paths['log'])) {
        $task = tc_task_fold($paths['log']);
    } elseif (is_file($paths['legacy'])) {
        // 升级前创建、尚在 GC 窗口内的旧格式任务
        $j = json_decode((string) @file_get_contents($paths['legacy']), true);
        if (is_array($j)) $task = $j;
    }
    if (!is_array($task)) return null;
    $st = tc_task_state_read($paths);
    if ($st) foreach ($st as $k => $v) if ($k !== 't') $task[$k] = $v;
    return $task;
}

function tc_task_create($id, $userId, $meta = array()) {
    tc_task_gc();
    $now = tc_now();
    $paths = tc_task_paths($id);
    @unlink($paths['legacy']);
    $task = array_merge(array(
        'id' => (string) $id, 'userId' => (string) $userId, 'status' => 'running',
        'seq' => 0, 'createdAt' => $now, 'updatedAt' => $now,
        'error' => '', 'charged' => 0, 'quota' => null,
    ), $meta);
    $header = $task;
    $header['t'] = 'h';
    @file_put_contents($paths['log'], tc_json_encode($header) . "\n", LOCK_EX);
    tc_task_state_write($paths, array('status' => 'running', 'error' => '', 'updatedAt' => $now));
    return $task;
}

// 追加一条 SSE 分片:O(1) 追加写。取消探测与 seq 计数按任务 id 维护在本请求内
// (任务由同一次请求创建并独占追加,seq 从 0 起与前端 after= 游标约定一致)
function tc_task_append($id, $chunk) {
    static $req = array();
    $chunk = (string) $chunk;
    if ($chunk === '') return;
    $st = isset($req[$id]) ? $req[$id] : null;
    if ($st === null) $st = $req[$id] = array('seq' => 0, 'cancelled' => false, 'checkAt' => 0);
    if ($st['cancelled']) return;
    $now = tc_now();
    if ($now - $st['checkAt'] > 500) {
        $st['checkAt'] = $now;
        $side = tc_task_state_read(tc_task_paths($id));
        if ($side && isset($side['status']) && $side['status'] !== 'running') {
            $st['cancelled'] = true;
            $req[$id] = $st;
            return;
        }
    }
    $req[$id] = $st;
    $paths = tc_task_paths($id);
    // 体积护栏:超过 32MB 视为异常流,停止追加保住磁盘(正常对话远达不到)
    if (@filesize($paths['log']) > 33554432) { $st['cancelled'] = true; $req[$id] = $st; return; }
    $st['seq'] = (int) $st['seq'] + 1;
    $req[$id] = $st;
    $line = '{"t":"e","seq":' . (int) $st['seq'] . ',"data":' . tc_json_encode(substr($chunk, 0, 100000)) . '}' . "\n";
    @file_put_contents($paths['log'], $line, FILE_APPEND | LOCK_EX);
}

function tc_task_update($id, $fn) {
    $task = tc_task_read($id);
    if (!$task) return null;
    $next = $fn($task);
    if (!is_array($next)) $next = $task;
    $next['updatedAt'] = tc_now();
    // 标量字段变化追加一条覆盖行;事件只增不改,不随 update 落盘
    $meta = array('t' => 'm');
    foreach ($next as $k => $v) {
        if ($k === 'events' || $k === 't' || $k === 'id') continue;
        if (!array_key_exists($k, $task) || $task[$k] !== $v) $meta[$k] = $v;
    }
    $paths = tc_task_paths($id);
    if (count($meta) > 1) @file_put_contents($paths['log'], tc_json_encode($meta) . "\n", FILE_APPEND | LOCK_EX);
    tc_task_state_write($paths, array(
        'status' => isset($next['status']) ? (string) $next['status'] : 'running',
        'error' => isset($next['error']) ? (string) $next['error'] : '',
        'updatedAt' => $next['updatedAt'],
    ));
    return $next;
}

function tc_task_finish($id, $status, $error = '') {
    return tc_task_update($id, function ($task) use ($status, $error) {
        $task['status'] = in_array($status, array('completed','failed','cancelled'), true) ? $status : 'failed';
        $task['error'] = substr((string) $error, 0, 500);
        return $task;
    });
}
