<?php
/**
 * 流式用量/文本采集自检: php tests/stream-capture.php
 * 上游 SSE 事件的边界与 curl 回调的 chunk 边界无关:一条 data: {...} 会被 TCP 拆成
 * 多次回调。早期实现每个 chunk 单独 explode("\n"),被拆开的事件整条丢掉,
 * 现象是「用量统计偏少、API 对话落库的正文缺尾巴」。这里覆盖跨分片拼接、尾部收尾、
 * 非 SSE 响应体不误判等场景。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-stream-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$check = function ($name, $got, $want) use (&$fail) {
    if ($got === $want) {
        echo "  ✓ " . $name . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . " 期望 " . var_export($want, true) . "，实际 " . var_export($got, true) . "\n";
    }
};

// ---------- 用量采集 ----------
// 单块完整事件(基线:修复前后都必须对)
$u = array('prompt' => 0, 'completion' => 0);
$cu = '';
tc_capture_stream_usage($u, "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n", 'openai', $cu);
$check('整块事件解析 prompt', $u['prompt'], 10);
$check('整块事件解析 completion', $u['completion'], 5);
tc_sse_flush_tail($cu, 'tc_capture_stream_usage', $u, 'openai');
$check('整块事件后 carry 清空', $cu, '');

// 事件被拆成两块 —— 修复的核心场景
$u = array('prompt' => 0, 'completion' => 0);
$cu = '';
tc_capture_stream_usage($u, "data: {\"usage\":{\"prompt_to", 'openai', $cu);
$check('半条事件不解析(等拼齐)', $u['prompt'], 0);
$check('半条事件留在 carry', strpos($cu, 'prompt_to') !== false, true);
tc_capture_stream_usage($u, "kens\":42,\"completion_tokens\":7}}\n", 'openai', $cu);
$check('拼齐后解析 prompt', $u['prompt'], 42);
$check('拼齐后解析 completion', $u['completion'], 7);
$check('拼齐后 carry 清空', $cu, '');

// 一条事件被切成三段(长 JSON 落在小 chunk 上)
$u = array('prompt' => 0, 'completion' => 0);
$cu = '';
$full = "data: {\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":2000}}\n";
tc_capture_stream_usage($u, substr($full, 0, 20), 'openai', $cu);
tc_capture_stream_usage($u, substr($full, 20, 20), 'openai', $cu);
tc_capture_stream_usage($u, substr($full, 40), 'openai', $cu);
$check('三段拼接 prompt', $u['prompt'], 1000);
$check('三段拼接 completion', $u['completion'], 2000);

// Anthropic 的 message_delta:output_tokens 是累计值,取较大者
$u = array('prompt' => 0, 'completion' => 0);
$cu = '';
tc_capture_stream_usage($u, "data: {\"usage\":{\"input_tokens\":30,\"output_tokens\":12}}\n", 'anthropic', $cu);
tc_capture_stream_usage($u, "data: {\"usage\":{\"output_tokens\":80}}\n", 'anthropic', $cu);
tc_capture_stream_usage($u, "data: {\"usage\":{\"output_tokens\":40}}\n", 'anthropic', $cu);
$check('anthropic input_tokens', $u['prompt'], 30);
$check('anthropic output_tokens 取累计最大值', $u['completion'], 80);

// message 形态的 usage(部分网关放在 message 里)
$u = array('prompt' => 0, 'completion' => 0);
$cu = '';
tc_capture_stream_usage($u, "data: {\"message\":{\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}}\n", 'openai', $cu);
$check('message.usage 形态', $u['prompt'] . '/' . $u['completion'], '9/4');

// ---------- 文本采集 ----------
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"delta\":{\"content\":\"你", 'openai', $ct);
tc_capture_stream_text($t, "好\"}}]}\n", 'openai', $ct);
$check('跨分片文本拼接', $t, '你好');

// 同一块里多条事件
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\ndata: {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}\n", 'openai', $ct);
$check('同块多条事件', $t, 'AB');

// 末尾无换行:flush 收尾
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"delta\":{\"content\":\"尾\"}}]}", 'openai', $ct);
$check('无换行时尚未解析', $t, '');
tc_sse_flush_tail($ct, 'tc_capture_stream_text', $t, 'openai');
$check('flush 后解析出尾部', $t, '尾');
$check('flush 后 carry 清空', $ct, '');

// 非 SSE 响应体尾部不能被误当成事件
$t = '';
$ct = 'plain body no sse';
tc_sse_flush_tail($ct, 'tc_capture_stream_text', $t, 'openai');
$check('非 SSE 尾部不解析', $t, '');
$check('非 SSE 尾部被丢弃', $ct, '');

// [DONE] 与心跳空行不产生文本
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: [DONE]\n\n", 'openai', $ct);
$check('[DONE] 不产生文本', $t, '');

// anthropic 跨行事件(event: 行 + data: 行)
$t = '';
$ct = '';
tc_capture_stream_text($t, "event: content_block_delta\ndata: {\"delta\":{\"text\":\"hi\"}}\n", 'anthropic', $ct);
$check('anthropic 事件跨行', $t, 'hi');

// responses 格式
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: {\"delta\":\"r1\"}\ndata: {\"delta\":\"r2\"}\n", 'responses', $ct);
$check('responses delta 累加', $t, 'r1r2');

// completions 格式
$t = '';
$ct = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"text\":\"c1\"}]}\n", 'completions', $ct);
$check('completions text', $t, 'c1');

// ---------- 向后兼容 ----------
// 不传 carry(旧调用方式)时按整块解析,行为不变
$t = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"delta\":{\"content\":\"X\"}}]}\n", 'openai');
$check('carry 省略时向后兼容', $t, 'X');

// 不完整的一行在旧调用方式下直接丢弃(不会把垃圾拼进正文)
$t = '';
tc_capture_stream_text($t, "data: {\"choices\":[{\"delta\":{\"conte", 'openai');
$check('缺少 carry 时半行不入正文', $t, '');

echo $fail ? "\n$fail 项未通过\n" : "\n全部通过\n";
exit($fail ? 1 : 0);
