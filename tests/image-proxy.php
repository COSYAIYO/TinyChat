<?php
/**
 * 生图图片代理自检: php tests/image-proxy.php
 * 覆盖: 代理地址生成与验签、SSRF 防护(内网/保留地址拒绝、公网放行、非 http(s) 拒绝)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-imgpx-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };

// 1) 代理地址:data: 原样返回,http(s) 生成带签名的同源路径
$dataUrl = 'data:image/png;base64,AAAA';
if (tc_img_proxy_path($dataUrl) === $dataUrl) $ok('data: 地址无需代理'); else $bad('data: 地址被错误代理');

$src = 'https://platform-outputs.agnes-ai.space/images/t2i/task_x/output_y.png';
$path = tc_img_proxy_path($src);
if (strpos($path, '/api/proxy/image?u=') === 0) $ok('http(s) 生成同源代理路径'); else $bad('代理路径前缀不对: ' . $path);
if (strpos($path, 's=') !== false) $ok('代理路径带签名'); else $bad('代理路径缺少签名');
// 签名可复算且对 URL 敏感
if (strpos($path, tc_img_proxy_token($src)) !== false) $ok('签名可复算'); else $bad('签名不可复算');
if (tc_img_proxy_token($src) !== tc_img_proxy_token($src . 'x')) $ok('签名对不同 URL 不同'); else $bad('签名与 URL 无关(危险)');

// 2) SSRF 防护
$deny = array(
    'http://127.0.0.1/x.png',
    'http://localhost/x.png',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/a.png',
    'http://192.168.1.1/a.png',
    'http://172.16.0.1/a.png',
    'http://[::1]/a.png',
    'file:///etc/passwd',
    'gopher://x/1',
    '',
);
foreach ($deny as $u) {
    if (!tc_url_is_public_http($u)) $ok('拒绝 ' . ($u === '' ? '(空)' : $u));
    else $bad('未拒绝内网/非法地址: ' . $u);
}
$allow = array('https://platform-outputs.agnes-ai.space/a.png', 'http://8.8.8.8/a.png');
foreach ($allow as $u) {
    if (tc_url_is_public_http($u)) $ok('允许 ' . $u);
    else $bad('误拒公网地址: ' . $u);
}
// 非常规端口与网页抓取同一套白名单,即使地址本身是公网也不放行
$ports = array('http://8.8.8.8:22/a.png', 'https://example.com:8444/a.png', 'http://1.1.1.1:8080/a.png');
if (!tc_url_is_public_http($ports[0]) && !tc_url_is_public_http($ports[1])) $ok('拒绝非常规端口');
else $bad('非常规端口被放行');
if (tc_url_is_public_http($ports[2])) $ok('允许 8080'); else $bad('误拒 8080');

$html = '<p>条款</p><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(2)">点</a><img src="http://127.0.0.1/a.png">';
$clean = tc_agreement_html($html);
if (strpos($clean, '条款') !== false && strpos($clean, '<script') === false && stripos($clean, 'onclick') === false && stripos($clean, 'javascript:') === false) {
    $ok('协议页去掉脚本、事件和危险链接');
} else {
    $bad('协议页清洗不完整: ' . $clean);
}
if (trim(tc_agreement_html('   ')) === '') $ok('空协议清洗后为空'); else $bad('空白协议未被视为空');

// 3) 图片结果解析后应带 display(同源代理)字段
$items = tc_image_results_from_payload(array('data' => array(array('url' => $src))), 1);
// 解析函数本身不补 display(由生图流程补),这里只校验 url 解析正确
if (!empty($items[0]['url']) && $items[0]['url'] === $src) $ok('url 结果解析正确'); else $bad('url 结果解析失败');

echo "\n" . ($fail ? '✗ 生图图片代理自检失败: ' . $fail . ' 项' : '✓ 生图图片代理自检通过') . "\n";
exit($fail ? 1 : 0);
