<?php
/**
 * E2E 测试用 mock 上游:模拟 OpenAI 兼容 chat/completions(含 SSE 流式)与 images/generations,
 * 以及搜索源 Brave / DuckDuckGo HTML / Jina(配合 TC_BRAVE_SEARCH_BASE 等 base 覆盖)。
 * 用法:php -S 127.0.0.1:8100 tests/mock-upstream.php
 */
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$body = json_decode((string) file_get_contents('php://input'), true);
header('Content-Type: application/json');
// ---- 搜索源 mock(brave / ddg / jina):返回带 query 关键词的固定结果 ----
$q = isset($_GET['q']) ? (string) $_GET['q'] : '';
if (strpos($uri, '/res/v1/web/search') !== false) {
    // Brave:必须带 X-Subscription-Token;结果标题带上查询词便于断言
    if (empty($_SERVER['HTTP_X_SUBSCRIPTION_TOKEN'])) {
        http_response_code(401);
        echo json_encode(array('error' => array('message' => 'missing token')));
        return;
    }
    echo json_encode(array('type' => 'search', 'web' => array('results' => array(
        array('title' => 'Brave:' . $q, 'url' => 'https://example.com/brave1', 'description' => 'brave 第一条 ' . $q),
        array('title' => 'Brave2:' . $q, 'url' => 'https://example.com/brave2', 'description' => 'brave 第二条'),
    ))));
    return;
}
if (strpos($uri, '/html/') !== false && $q !== '') {
    // DuckDuckGo HTML:一条 uddg 包装的正常结果 + 一条应被过滤的广告 + 一条直链结果
    header('Content-Type: text/html; charset=UTF-8');
    $ad = '<div class="result"><h2><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=mock">广告位</a></h2>'
        . '<a class="result__snippet">广告描述</a></div>';
    $r1 = '<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg='
        . rawurlencode('https://example.com/ddg1?q=' . $q) . '&amp;rut=abc">' . htmlspecialchars('DDG:' . $q)
        . '</a></h2><a class="result__snippet">ddg 第一条 ' . htmlspecialchars($q) . '</a></div>';
    $r2 = '<div class="result"><h2><a class="result__a" href="https://example.com/ddg2">直接链接结果</a></h2>'
        . '<a class="result__snippet">ddg 第二条</a></div>';
    echo '<html><body>' . $ad . $r1 . $r2 . '</body></html>';
    return;
}
if (strpos($uri, '/jina-markdown') !== false) {
    // Jina markdown 兜底格式([标题](链接) 列表)
    header('Content-Type: text/markdown');
    echo "Search results:\n\nTitle From Markdown\n\n[MD:" . $q . "](https://example.com/jina-md)\n\nMD 摘要内容 " . $q . "\n";
    return;
}
// ---- 网页正文 mock(配合 TC_PAGE_FETCH_BASE,验证搜索结果正文真的进了模型上下文) ----
// 页面刻意做成「导航在前、正文在后,且正文里带裸 < 与 HTML 注释」:
// 裸 < 曾让 strip_tags 吞掉后面整段正文(真实缺陷),这里作为回归样本保留。
if (strpos($uri, '/page/') !== false) {
    header('Content-Type: text/html; charset=UTF-8');
    $nav = '';
    foreach (array('首页', '预报', '预警', '雷达', '云图', '天气地图', '专业产品', '资讯') as $i => $t) {
        $nav .= '<a href="/nav' . $i . '">' . $t . '</a>';
    }
    echo '<!doctype html><html><head><title>mock page</title>'
        . '<script>var hidden="MOCK-SCRIPT-SHOULD-NOT-APPEAR";</script>'
        . '<style>.x{color:red}</style></head><body>'
        . '<div class="nav">' . $nav . '</div>'
        . '<!-- MOCK-COMMENT-SHOULD-NOT-APPEAR -->'
        . '<div class="content">'
        . '<h1>上海市气象局 今日天气</h1>'
        . '<p>今天上海小雨，气温 21℃，风力<3级，湿度 78%。</p>'
        . '<p>明天阴，24℃/19℃，东北风 3 级。</p>'
        . '<p>后天阴，23℃/19℃。</p>'
        . '<p>本段用于确保正文长度超过提取阈值，避免被当作空页面丢弃。</p>'
        . '<p>MOCK-PAGE-BODY-OK</p>'
        . '</div></body></html>';
    return;
}
// ---- 文档解析 mock(PaddleOCR serving /ocr 与 Mistral /v1/ocr) ----
$rPath = (string) parse_url($uri, PHP_URL_PATH);
if ($rPath === '/ocr') {
    // PaddleX serving 形状:POST {file: base64, fileType} -> result.ocrResults[].prunedResult.rec_texts
    if (!is_array($body) || empty($body['file'])) {
        http_response_code(400);
        echo json_encode(array('errorMsg' => 'file required'));
        return;
    }
    echo json_encode(array('logId' => 'mock', 'errorMsg' => '', 'result' => array('ocrResults' => array(
        array('prunedResult' => array('rec_texts' => array('PaddleOCR 识别 第一行 ' . (isset($body['fileType']) ? ('ft=' . $body['fileType']) : ''), '第二行内容'), 'rec_scores' => array(0.98, 0.97))),
        array('prunedResult' => array('rec_texts' => array('第二页识别'))),
    ))));
    return;
}
if ($rPath === '/v1/ocr') {
    // Mistral OCR 形状:POST {model, document:{type:'document_url'|'image_url', <type>: data-URI}} -> pages[].markdown
    // 严格校验判别字段:漏了 type 就按官方契约报错,让 e2e 能锁住请求形状
    if (!isset($_SERVER['HTTP_AUTHORIZATION']) || strpos((string) $_SERVER['HTTP_AUTHORIZATION'], 'Bearer ') === false) {
        http_response_code(401);
        echo json_encode(array('message' => 'missing api key'));
        return;
    }
    if (strpos((string) $_SERVER['HTTP_AUTHORIZATION'], 'sk-bad-mistral') !== false) {
        http_response_code(401);
        echo json_encode(array('message' => 'invalid mistral key'));
        return;
    }
    $doc = (is_array($body) && isset($body['document']) && is_array($body['document'])) ? $body['document'] : array();
    $dtype = isset($doc['type']) ? (string) $doc['type'] : '';
    if ($dtype !== 'document_url' && $dtype !== 'image_url') {
        http_response_code(422);
        echo json_encode(array('message' => 'invalid document schema: missing type discriminant'));
        return;
    }
    if (!isset($doc[$dtype]) || strpos((string) $doc[$dtype], 'data:') !== 0) {
        http_response_code(422);
        echo json_encode(array('message' => 'invalid document schema: missing data URI for ' . $dtype));
        return;
    }
    echo json_encode(array('model' => 'mistral-ocr-latest', 'pages' => array(
        array('index' => 0, 'markdown' => '# Mistral 第一页'),
        array('index' => 1, 'markdown' => '第二页内容'),
    )));
    return;
}
$pathQ = rawurldecode((string) parse_url($uri, PHP_URL_PATH));
// Jina JSON:GET /<urlencoded 查询> -> {data:[...]}。注意放行 /v1/* 与 agnesapi 等其它 mock 路由
if ($pathQ !== '/' && $pathQ !== '' && strpos($pathQ, '/v1') !== 0 && strpos($pathQ, '/agnesapi') === false) {
    if (isset($_SERVER['HTTP_AUTHORIZATION']) && strpos((string) $_SERVER['HTTP_AUTHORIZATION'], 'Bearer sk-bad-jina') !== false) {
        http_response_code(401);
        echo json_encode(array('error' => array('message' => 'invalid jina key')));
        return;
    }
    $qTitle = ltrim($pathQ, '/');
    echo json_encode(array('code' => 200, 'data' => array(
        array('title' => 'Jina:' . $qTitle, 'url' => 'https://example.com/jina1', 'description' => 'jina 第一条 ' . $qTitle),
    )));
    return;
}
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
// 对话接口:正文回显收到的 system 上下文,便于 e2e 断言「搜索结果正文真的注入了」。
// 仅在请求模型是 mock-echo-system 时开启,不影响其它用例的固定回复。
$sysText = '';
if (is_array($body) && isset($body['messages']) && is_array($body['messages'])) {
    foreach ($body['messages'] as $m) {
        if (!is_array($m) || (isset($m['role']) ? $m['role'] : '') !== 'system') continue;
        $c = isset($m['content']) ? $m['content'] : '';
        if (is_string($c)) $sysText .= $c . "\n";
        elseif (is_array($c)) {
            foreach ($c as $part) if (is_array($part) && isset($part['text'])) $sysText .= $part['text'] . "\n";
        }
    }
}
$echoSystem = is_array($body) && isset($body['model']) && $body['model'] === 'mock-echo-system';
if ($echoSystem) {
    // 把收到的 system 上下文原样落盘(含中文,便于测试直接 grep 真实内容;
    // 放 JSON 响应里会被 \uXXXX 转义,断言不好写)
    $dumpFile = getenv('TC_MOCK_ECHO_FILE');
    if ($dumpFile) @file_put_contents($dumpFile, $sysText);
    echo json_encode(array(
        'id' => 'mock-echo',
        'object' => 'chat.completion',
        'model' => 'mock-echo-system',
        'choices' => array(array('index' => 0, 'message' => array(
            'role' => 'assistant',
            'content' => 'MOCK-ECHO-OK',
        ), 'finish_reason' => 'stop')),
        'usage' => array('prompt_tokens' => 10, 'completion_tokens' => 10),
    ));
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
