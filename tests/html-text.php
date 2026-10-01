<?php
/**
 * 网页正文提取自检: php tests/html-text.php
 * 覆盖 tc_html_to_text 的关键行为,尤其是「正文里的裸 < 会被 strip_tags 吞掉正文」的回归。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-html-text-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$check = function ($name, $html, $mustHave) use (&$fail) {
    $out = tc_html_to_text($html);
    $missing = array();
    foreach ((array) $mustHave as $needle) {
        if (strpos($out, $needle) === false) $missing[] = $needle;
    }
    if (!$missing) {
        echo "  ✓ " . $name . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . " 缺少 " . json_encode($missing, JSON_UNESCAPED_UNICODE)
            . "，实际输出: " . json_encode(mb_substr($out, 0, 120), JSON_UNESCAPED_UNICODE) . "\n";
    }
};

// —— 回归:正文里的裸 < 不能吃掉后面整段内容 ——
// 天气页用「<3级」表示风力,strip_tags 会把它当标签起点,一路吞到下一个 >
$check('风力「<3级」不吞正文', '<p>今天</p><i><3级</i><p>21℃ 小雨</p>', array('今天', '<3级', '21℃', '小雨'));
$check('比较式「2<3」不吞正文', '<p>a</p>2<3 且 5>4<p>重要内容</p>', array('2<3', '重要内容'));
$check('「a<b」不吞正文', '<p>式子 a<b 比较</p><p>重要内容</p>', array('重要内容'));

// —— 正常标签照常剥离,不能因为防裸 < 而把标签文本漏出来 ——
$check('普通标签正常剥离', '<div class="x"><b>加粗</b>普通</div>', array('加粗', '普通'));
$check('属性里的尖括号不影响', '<p title="a>b">正文</p>', array('正文'));
$check('注释被清理', '<p>前</p><!-- 内部备注 --><p>后</p>', array('前', '后'));

// 注释里的文字不应当出现在结果里(以「有」为失败的单独校验)
$commented = tc_html_to_text('<p>正文</p><!-- 隐藏说明 --><p>结尾</p>');
if (strpos($commented, '隐藏说明') === false) {
    echo "  ✓ 注释内容不进正文\n";
} else {
    $fail++;
    echo "  ✗ 注释内容进了正文: " . json_encode($commented, JSON_UNESCAPED_UNICODE) . "\n";
}

// —— 实体与结构 ——
$check('HTML 实体解码', '<p>2 &lt; 3 且 5 &gt; 4</p>', array('2 < 3', '5 > 4'));
$check('article 优先取正文', '<nav><a href="#">首页</a></nav><article><p>文章正文在这里</p></article>', array('文章正文在这里'));
$check('main 兜底取正文', '<div><main><p>主体内容在这里</p></main></div>', array('主体内容在这里'));
$check('script/style 内容丢弃', '<p>可见</p><script>var a="隐藏脚本";</script><style>.x{color:red}</style>', array('可见'));

$scriptLeak = tc_html_to_text('<p>可见</p><script>var a="隐藏脚本";</script>');
if (strpos($scriptLeak, '隐藏脚本') === false) {
    echo "  ✓ 脚本内容不进正文\n";
} else {
    $fail++;
    echo "  ✗ 脚本内容进了正文\n";
}

// —— 整页抓取时的菜单瘦身:短锚文本被去掉,正文保留 ——
$page = '<div class="nav"><a href="/">首页</a><a href="/a">预报</a><a href="/b">预警</a></div>'
      . '<div class="content"><p>真正的正文内容在这里，需要被保留下来。</p>'
      . '<a href="/x">一条很长的链接说明文字超过十二个字</a></div>';
$navText = tc_html_to_text($page);
if (strpos($navText, '真正的正文内容') !== false) {
    echo "  ✓ 整页抓取保留正文\n";
} else {
    $fail++;
    echo "  ✗ 整页抓取丢了正文\n";
}
if (strpos($navText, '首页') === false) {
    echo "  ✓ 导航短链接被瘦身\n";
} else {
    $fail++;
    echo "  ✗ 导航短链接未被瘦身: " . json_encode(mb_substr($navText, 0, 80), JSON_UNESCAPED_UNICODE) . "\n";
}
if (strpos($navText, '一条很长的链接说明文字') !== false) {
    echo "  ✓ 长锚文本(可能是正文)保留\n";
} else {
    $fail++;
    echo "  ✗ 长锚文本被误删\n";
}

// article 内的短链接不应被误删(已圈定正文时不做链接瘦身)
$scoped = tc_html_to_text('<article><p>正文段落</p><a href="/t">短链</a></article>');
if (strpos($scoped, '短链') !== false) {
    echo "  ✓ article 内短链接不误删\n";
} else {
    $fail++;
    echo "  ✗ article 内短链接被误删\n";
}

// —— 空输入不报错 ——
$empty = tc_html_to_text('');
if (trim($empty) === '') {
    echo "  ✓ 空输入返回空\n";
} else {
    $fail++;
    echo "  ✗ 空输入返回了内容\n";
}

echo $fail === 0 ? "\n全部通过\n" : "\n失败 " . $fail . " 项\n";
exit($fail === 0 ? 0 : 1);
