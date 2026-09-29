<?php
/**
 * E2E 测试用 mock 上游:模拟 OpenAI 兼容 chat/completions(含 SSE 流式)与 images/generations。
 * 用法:php -S 127.0.0.1:8100 tests/mock-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$body = json_decode((string) file_get_contents('php://input'), true);
header('Content-Type: application/json');
// 多密钥回退:携带 sk-fail 的请求一律 401,用于验证「第一把失败自动回退下一把」
$authHdr = isset($_SERVER['HTTP_AUTHORIZATION']) ? (string) $_SERVER['HTTP_AUTHORIZATION'] : '';
foreach (array('HTTP_X_API_KEY') as $hk) { if ($authHdr === '' && !empty($_SERVER[$hk])) $authHdr = (string) $_SERVER[$hk]; }
if (strpos($authHdr, 'sk-fail') !== false) {
    http_response_code(401);
    echo json_encode(array('error' => array('message' => 'invalid api key')));
    return;
}
// ---- 视频生成(异步任务:POST /v1/videos 建任务,GET /agnesapi 查询) ----
// 建任务:返回 video_id;查询:首次返回 processing,之后返回 completed + url。
if (strpos($uri, 'agnesapi') !== false) {
    $vid = isset($_GET['video_id']) ? (string) $_GET['video_id'] : '';
    echo json_encode(array(
        'id' => $vid, 'object' => 'video', 'status' => 'completed', 'progress' => 100,
        'seconds' => '4', 'size' => '720P', 'url' => 'https://example.com/generated/mock-video.mp4',
    ));
    return;
}
if (strpos($uri, 'videos') !== false && strpos($uri, 'chat/completions') === false) {
    if (!is_array($body) || !isset($body['model'])) { http_response_code(400); echo json_encode(array('error' => array('message' => 'model required'))); return; }
    // 校验必需参数,便于 E2E 断言参数透传
    if (empty($body['mode'])) { http_response_code(400); echo json_encode(array('error' => array('message' => 'mode required'))); return; }
    echo json_encode(array('id' => 'task_mock_video_1', 'task_id' => 'task_mock_video_1', 'video_id' => 'task_mock_video_1', 'object' => 'video', 'status' => 'queued', 'progress' => 0));
    return;
}
// 对话式出图平台:没有 images/generations 路径,图片在 chat 回复里(复现 apilio 等平台)
if (is_array($body) && isset($body['model']) && $body['model'] === 'mock-chat-image'
    && strpos($uri, 'chat/completions') !== false) {
    echo json_encode(array(
        'id' => 'chatcmpl-mock', 'object' => 'chat.completion', 'created' => time(),
        'choices' => array(array('index' => 0, 'message' => array(
            'role' => 'assistant',
            'content' => "Here you go: \n![image](https://example.com/mock-chat.png)",
        ), 'finish_reason' => 'stop')),
        'usage' => array('prompt_tokens' => 1, 'completion_tokens' => 1),
    ));
    return;
}
if (strpos($uri, 'images/generations') !== false) {
    // 该模型只支持对话出图:生图路径返回「不支持此路径」(复现 503)
    if (is_array($body) && isset($body['model']) && $body['model'] === 'mock-chat-image') {
        http_response_code(503);
        echo json_encode(array('error' => array('message' => '所有分组对于模型 ' . $body['model'] . ' 不支持此 API 路径 [/v1/images/generations]，请更换请求路径')));
        return;
    }
    // b64_json 也覆盖到:按 response_format 返回,顺带验证参数透传
    $d = array(array('url' => 'https://example.com/mock.png'));
    if (is_array($body) && isset($body['response_format']) && $body['response_format'] === 'b64_json') {
        $d = array(array('b64_json' => base64_encode('PNGDATA')));
    }
    // 图生图:带 image 数组时返回 i2i 结果,便于验证改图链路
    if (is_array($body) && !empty($body['image'])) {
        $d = array(array('url' => 'https://example.com/mock-edited.png'));
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
