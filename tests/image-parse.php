<?php
/**
 * 生图响应解析自检: php tests/image-parse.php
 * 覆盖各平台常见的图像返回形态,确保 tc_image_results_from_payload 都能识别。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-img-parse-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$check = function ($name, $payload, $wantN, $wantKey = '', $limit = 1) use (&$fail) {
    $got = tc_image_results_from_payload($payload, $limit);
    $n = count($got);
    $ok = ($n === $wantN) && ($wantN === 0 || ($wantKey === '' || (isset($got[0][$wantKey]) && $got[0][$wantKey] !== '')));
    if ($ok) {
        echo "  ✓ " . $name . " => " . $n . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . " 期望 " . $wantN . " 条" . ($wantKey ? "，字段 " . $wantKey : "") . "，实际 " . json_encode($got) . "\n";
    }
};

// OpenAI 标准
$check('data[].url', array('data' => array(array('url' => 'https://x/a.png', 'revised_prompt' => 'r'))), 1, 'url');
$check('data[].b64_json', array('data' => array(array('b64_json' => 'AAA'))), 1, 'b64_json');
$check('revised_prompt 透传', array('data' => array(array('url' => 'https://x/a.png', 'revised_prompt' => 'r'))), 1, 'revised_prompt');
// 常见变体
$check('images[] 为 URL 字符串', array('images' => array('https://x/b.png')), 1, 'url');
$check('output[].url', array('output' => array(array('url' => 'https://x/c.png'))), 1, 'url');
$check('顶层 url', array('url' => 'https://x/d.png'), 1, 'url');
$check('data[] 为 URL 字符串', array('data' => array('https://x/e.png')), 1, 'url');
$check('data[] 为 data URL', array('data' => array('data:image/png;base64,ZZZ')), 1, 'b64_json');
$check('data[].image 为对象内 data URL', array('data' => array(array('image' => 'data:image/png;base64,QQ=='))), 1, 'b64_json');
$check('data[].image_url', array('data' => array(array('image_url' => 'https://x/f.png'))), 1, 'url');
$check('data 为单个对象', array('data' => array('url' => 'https://x/g.png')), 1, 'url');
// 多张 + limit
$check('多张按 limit 截断', array('data' => array(array('url' => 'https://x/1.png'), array('url' => 'https://x/2.png'), array('url' => 'https://x/3.png'))), 2, 'url', 2);
// 无法识别
$check('无法识别返回空', array('foo' => 1), 0);
$check('非数组返回空', 'not-an-array', 0);

echo "\n" . ($fail ? '✗ 生图解析自检失败: ' . $fail . ' 项' : '✓ 生图解析自检通过') . "\n";
exit($fail ? 1 : 0);
