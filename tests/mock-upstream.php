<?php
/**
 * E2E 测试用 mock 上游:模拟 OpenAI 兼容 chat/completions(含 SSE 流式)与 images/generations。
 * 用法:php -S 127.0.0.1:8100 tests/mock-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$body = json_decode((string) file_get_contents('php://input'), true);
header('Content-Type: application/json');
if (strpos($uri, 'images/generations') !== false) {
    echo json_encode(array('created' => time(), 'data' => array(array('url' => 'https://example.com/mock.png'))));
    return;
}
if (strpos($uri, '/models') !== false && strpos($uri, 'chat') === false) {
    echo json_encode(array('object' => 'list', 'data' => array(array('id' => 'mock-model', 'object' => 'model'))));
    return;
}
if (is_array($body) && !empty($body['stream'])) {
    // SSE 流式:正文 chunk + 带 usage 的收尾 chunk(用量在最后一帧,复现真实时序)
    header('Content-Type: text/event-stream');
    echo "data: " . json_encode(array('id' => 'mock', 'object' => 'chat.completion.chunk', 'choices' => array(array('index' => 0, 'delta' => array('content' => 'MOCK-REPLY'))))) . "\n\n";
    echo "data: " . json_encode(array('id' => 'mock', 'object' => 'chat.completion.chunk', 'choices' => array(array('index' => 0, 'delta' => array(), 'finish_reason' => 'stop')), 'usage' => array('prompt_tokens' => 1500, 'completion_tokens' => 500))) . "\n\n";
    echo "data: [DONE]\n\n";
    return;
}
echo json_encode(array(
    'id' => 'mock',
    'object' => 'chat.completion',
    'model' => 'mock-model',
    'choices' => array(array('index' => 0, 'message' => array('role' => 'assistant', 'content' => 'MOCK-REPLY'), 'finish_reason' => 'stop')),
    'usage' => array('prompt_tokens' => 1500, 'completion_tokens' => 500),
));
