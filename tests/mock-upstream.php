<?php
/**
 * E2E 测试用 mock 上游:模拟 OpenAI 兼容 chat/completions(含 SSE 流式)与 images/generations。
 * 用法:php -S 127.0.0.1:8100 tests/mock-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$body = json_decode((string) file_get_contents('php://input'), true);
header('Content-Type: application/json');
if (strpos($uri, 'images/generations') !== false) {
    // b64_json 也覆盖到:按 response_format 返回,顺带验证参数透传
    $d = array(array('url' => 'https://example.com/mock.png'));
    if (is_array($body) && isset($body['response_format']) && $body['response_format'] === 'b64_json') {
        $d = array(array('b64_json' => base64_encode('PNGDATA')));
    }
    echo json_encode(array('created' => time(), 'data' => $d));
    return;
}
if (strpos($uri, '/models') !== false && strpos($uri, 'chat') === false) {
    echo json_encode(array('object' => 'list', 'data' => array(
        array('id' => 'mock-model', 'object' => 'model'),
        array('id' => 'mock-image', 'object' => 'model'),
    )));
    return;
}
// 对话接口收到生图模型时,复现真实上游的报错,用于验证自动路由
if (is_array($body) && isset($body['model']) && strpos((string) $body['model'], 'mock-image') !== false) {
    http_response_code(400);
    echo json_encode(array('error' => array('message' => $body['model'] . ' is an image model. Use /v1/images/generations instead.')));
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
