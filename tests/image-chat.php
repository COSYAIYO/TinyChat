<?php
/**
 * 对话式生图 / 图生图辅助逻辑自检: php tests/image-chat.php
 * 覆盖: 从 chat 响应抽取图片(Markdown/HTML/多模态/裸 data URL)、编辑图引用整理与安全过滤、
 *       编辑消息内容组装、以及「路径不支持」错误识别。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-imgchat-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . '，实际 ' . var_export($got, true));
};

// --- 1) 对话响应抽图 ---
$chat = function ($content) { return array('choices' => array(array('message' => array('role' => 'assistant', 'content' => $content)))); };

$t = '';
$r = tc_images_from_chat_response($chat("Here you go: ![image](https://files.example.com/a.png)"), 1, $t);
$eq('Markdown 图片抽取', isset($r[0]['url']) ? $r[0]['url'] : '', 'https://files.example.com/a.png');
if (strpos($t, 'Here you go') === 0) $ok('同时回填说明文本'); else $bad('说明文本未回填: ' . $t);

$t = '';
$r = tc_images_from_chat_response($chat('<img src="https://x.com/b.png">'), 1, $t);
$eq('HTML img 抽取', isset($r[0]['url']) ? $r[0]['url'] : '', 'https://x.com/b.png');

$t = '';
$r = tc_images_from_chat_response($chat('data:image/png;base64,AAAB'), 1, $t);
$eq('裸 data URL 抽取', isset($r[0]['b64_json']) ? $r[0]['b64_json'] : '', 'AAAB');

$multi = array('choices' => array(array('message' => array('content' => array(
    array('type' => 'text', 'text' => 'done'),
    array('type' => 'image_url', 'image_url' => array('url' => 'https://x.com/c.png')),
)))));
$t = '';
$r = tc_images_from_chat_response($multi, 1, $t);
$eq('多模态分片抽取', isset($r[0]['url']) ? $r[0]['url'] : '', 'https://x.com/c.png');

$t = '';
$r = tc_images_from_chat_response($chat('抱歉，我无法生成该图片。'), 1, $t);
$eq('纯文字回复不产生图片', count($r), 0);
if ($t !== '') $ok('纯文字回复保留文本'); else $bad('纯文字回复未保留文本');

// limit 生效
$two = $chat("![a](https://x.com/1.png) ![b](https://x.com/2.png)");
$r = tc_images_from_chat_response($two, 1, $t);
$eq('limit 截断为 1', count($r), 1);

// --- 2) 编辑图引用整理 + 安全过滤 ---
$refs = tc_edit_image_refs(array(
    'data:image/png;base64,AAA',
    'https://cdn.example.com/x.png',
    'http://127.0.0.1/secret.png',      // 内网必须被丢弃
    'http://169.254.169.254/meta',      // 链路本地必须被丢弃
    'file:///etc/passwd',               // 非 http(s) 丢弃
    array('dataUrl' => 'data:image/jpeg;base64,BBB'),
));
$eq('编辑图引用数量(丢弃内网/非法)', count($refs), 3);
if (in_array('data:image/png;base64,AAA', $refs, true)) $ok('保留 data URL'); else $bad('丢失 data URL');
if (in_array('https://cdn.example.com/x.png', $refs, true)) $ok('保留公网 URL'); else $bad('丢失公网 URL');
if (in_array('data:image/jpeg;base64,BBB', $refs, true)) $ok('支持 dataUrl 字段'); else $bad('未识别 dataUrl 字段');
foreach ($refs as $u) {
    if (strpos($u, '127.0.0.1') !== false || strpos($u, '169.254') !== false || strpos($u, 'file:') !== false) $bad('内网/非法地址泄漏: ' . $u);
}
// 超过 4 张截断
$many = array_fill(0, 7, 'https://cdn.example.com/x.png');
$eq('编辑图上限 4 张', count(tc_edit_image_refs($many)), 4);

// --- 3) 消息内容组装 ---
$c1 = tc_image_edit_message_content('画只猫', array());
if (is_string($c1) && $c1 === '画只猫') $ok('无参考图时为纯文本'); else $bad('无参考图时结构不对');
$c2 = tc_image_edit_message_content('改成红色', array('data:image/png;base64,AAA'));
if (is_array($c2) && $c2[0]['type'] === 'text' && $c2[1]['type'] === 'image_url' && $c2[1]['image_url']['url'] === 'data:image/png;base64,AAA') {
    $ok('有参考图时为多模态数组');
} else $bad('多模态数组结构不对: ' . json_encode($c2));

// --- 4) 路径不支持识别 ---
$cases = array(
    array('所有分组对于模型 x 不支持此 API 路径 [/v1/images/generations]，请更换请求路径', 503, true),
    array('model does not support this endpoint', 400, true),
    array('Unsupported path', 400, true),
    array('not found', 404, true),
    array('', 404, true),
    array('invalid size parameter', 400, false),
    array('size is required', 400, false),
    array('rate limit exceeded', 429, false),
);
foreach ($cases as $i => $c) {
    $got = tc_error_means_path_unsupported($c[0], $c[1]);
    if ($got === $c[2]) $ok('错误识别 #' . ($i + 1) . ' => ' . ($got ? '走对话兜底' : '不兜底'));
    else $bad('错误识别 #' . ($i + 1) . ' 期望 ' . var_export($c[2], true) . ' 实际 ' . var_export($got, true));
}

echo "\n" . ($fail ? '✗ 对话式生图自检失败: ' . $fail . ' 项' : '✓ 对话式生图自检通过') . "\n";
exit($fail ? 1 : 0);
