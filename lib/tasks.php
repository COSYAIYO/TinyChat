<?php
require_once __DIR__ . '/core.php';

function tc_task_dir() {
    $dir = tc_data_dir() . '/tasks';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}
function tc_task_path($id) {
    $id = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $id);
    return tc_task_dir() . '/' . $id . '.json';
}
function tc_task_read($id) {
    $file = tc_task_path($id);
    if (!is_file($file)) return null;
    $raw = @file_get_contents($file);
    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : null;
}
function tc_task_write($id, $data) {
    $file = tc_task_path($id);
    $tmp = $file . '.tmp.' . bin2hex(random_bytes(4));
    $json = tc_json_encode($data);
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) return false;
    if (@rename($tmp, $file)) return true;
    @unlink($file);
    $ok = @rename($tmp, $file);
    if (!$ok) @unlink($tmp);
    return $ok;
}
function tc_task_create($id, $userId, $meta = array()) {
    $now = tc_now();
    return tc_task_write($id, array_merge(array(
        'id' => (string) $id, 'userId' => (string) $userId, 'status' => 'running',
        'seq' => 0, 'events' => array(), 'createdAt' => $now, 'updatedAt' => $now,
        'error' => '', 'charged' => 0, 'quota' => null,
    ), $meta));
}
function tc_task_update($id, $fn) {
    $data = tc_task_read($id);
    if (!$data) return null;
    $next = $fn($data);
    if (!is_array($next)) $next = $data;
    $next['updatedAt'] = tc_now();
    tc_task_write($id, $next);
    return $next;
}
function tc_task_append($id, $chunk) {
    $chunk = (string) $chunk;
    if ($chunk === '') return;
    tc_task_update($id, function ($task) use ($chunk) {
        if (($task['status'] ?? 'running') === 'cancelled') return $task;
        $task['seq'] = (int) ($task['seq'] ?? 0) + 1;
        if (!isset($task['events']) || !is_array($task['events'])) $task['events'] = array();
        $task['events'][] = array('seq' => $task['seq'], 'data' => substr($chunk, 0, 100000));
        if (count($task['events']) > 8000) $task['events'] = array_slice($task['events'], -8000);
        return $task;
    });
}
function tc_task_finish($id, $status, $error = '') {
    return tc_task_update($id, function ($task) use ($status, $error) {
        $task['status'] = in_array($status, array('completed','failed','cancelled'), true) ? $status : 'failed';
        $task['error'] = substr((string) $error, 0, 500);
        return $task;
    });
}
