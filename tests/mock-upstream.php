<?php
/**
 * E2E 测试用 mock 上游:模拟 OpenAI 兼容 chat/completions 与 images/generations。
 * 用法:php -S 127.0.0.1:8100 tests/mock-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
header('Content-Type: application/json');
if (strpos($uri, 'images/generations') !== false) {
    echo json_encode(array('created' => time(), 'data' => array(array('url' => 'https://example.com/mock.png'))));
    return;
}
if (strpos($uri, '/models') !== false && strpos($uri, 'chat') === false) {
    echo json_encode(array('object' => 'list', 'data' => array(array('id' => 'mock-model', 'object' => 'model'))));
    return;
}
echo json_encode(array(
    'id' => 'mock',
    'object' => 'chat.completion',
    'model' => 'mock-model',
    'choices' => array(array('index' => 0, 'message' => array('role' => 'assistant', 'content' => 'MOCK-REPLY'), 'finish_reason' => 'stop')),
    'usage' => array('prompt_tokens' => 1500, 'completion_tokens' => 500),
));
