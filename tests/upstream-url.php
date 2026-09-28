<?php
/**
 * 上游接口地址拼接自检: php tests/upstream-url.php
 * 用户常按平台文档只填域名(不带 /v1),或贴了完整接口地址。tc_api_url 必须两种都对,
 * 否则生图/获取模型会拼出错误路径导致 404(表现为「生图没反应」)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-url-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$check = function ($base, $path, $want) use (&$fail) {
    $got = tc_api_url($base, $path);
    if ($got === $want) {
        echo "  ✓ " . $base . $path . " => " . $got . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $base . $path . " 期望 " . $want . "，实际 " . $got . "\n";
    }
};

// 不带版本段:补 /v1(Agnes 等平台文档的 Base URL 就属于这种)
$check('https://apihub.agnes-ai.com', '/images/generations', 'https://apihub.agnes-ai.com/v1/images/generations');
$check('https://apihub.agnes-ai.com/', '/images/generations', 'https://apihub.agnes-ai.com/v1/images/generations');
// 已带 /v1:直接拼,不重复
$check('https://apihub.agnes-ai.com/v1', '/images/generations', 'https://apihub.agnes-ai.com/v1/images/generations');
$check('https://api.openai.com/v1/', '/images/generations', 'https://api.openai.com/v1/images/generations');
// 用户贴了完整接口地址:原样使用
$check('https://x.com/v1/images/generations', '/images/generations', 'https://x.com/v1/images/generations');
// 其它版本段
$check('https://x.com/v1beta', '/models', 'https://x.com/v1beta/models');
$check('https://x.com/v2', '/models', 'https://x.com/v2/models');
// 其它端点
$check('https://x.com', '/models', 'https://x.com/v1/models');
$check('https://x.com', '/chat/completions', 'https://x.com/v1/chat/completions');
$check('https://x.com/v1', '/models', 'https://x.com/v1/models');
// 聊天路径与 tc_upstream_path 行为一致
$check('https://apihub.agnes-ai.com', '/chat/completions', 'https://apihub.agnes-ai.com/v1/chat/completions');

echo "\n" . ($fail ? '✗ 上游地址拼接自检失败: ' . $fail . ' 项' : '✓ 上游地址拼接自检通过') . "\n";
exit($fail ? 1 : 0);
