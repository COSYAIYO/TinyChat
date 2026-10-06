<?php
/**
 * 在线浏览器代理自检: php tests/web-proxy.php
 * 覆盖: 票据签发/验签(含篡改与过期)、URL 绝对化与跳过规则、SSRF 闸门、HTML/CSS 改写
 * (链接 / srcset / 内联样式 / meta refresh / 摘 CSP 与 integrity / 注入垫片)、
 * 每用户 cookie jar(域名与路径匹配、过期与 Max-Age=0 删除)、字符集转码、收藏夹。
 * 全部为纯函数与本地文件操作,不发起网络请求,便于在 CI 稳定运行。
 * 退出码非 0 表示失败。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-webpx-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';
require __DIR__ . '/../lib/web.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };
$eq = function ($a, $b, $m) use ($ok, $bad) { if ($a === $b) $ok($m); else $bad($m . ' （期望 ' . var_export($b, true) . '，实际 ' . var_export($a, true) . '）'); };

// ---------- 1) base64url 往返 ----------
$eq(tc_web_b64d(tc_web_b64e('https://例子.example/a?b=1&c=2')), 'https://例子.example/a?b=1&c=2', 'base64url 往返(含中文与查询串)');
$eq(strpos(tc_web_b64e('https://a/b?x=1'), '='), false, 'base64url 无填充字符');
$eq(strpos(tc_web_b64e('https://a/b?x=1'), '+'), false, 'base64url 无 + 号');
$eq(tc_web_b64d('!!!not-base64!!!'), '', '非法 base64 返回空串');

// ---------- 2) 票据:签发 / 验签 / 篡改 / 过期 ----------
$uid = 'u_abc123';
$t = tc_web_ticket_make($uid);
$eq(tc_web_ticket_uid($t), $uid, '自签票据可验签');
$parts = explode('.', $t);
$eq(count($parts), 3, '票据由 uid.exp.sig 三段组成');
if (tc_web_ticket_uid($parts[0] . '.' . $parts[1] . '.' . str_repeat('0', 32)) === '') $ok('签名被篡改时拒绝'); else $bad('签名篡改未被拒绝');
if (tc_web_ticket_uid('other.' . $parts[1] . '.' . $parts[2]) === '') $ok('uid 被替换时拒绝(签名与 uid 绑定)'); else $bad('uid 替换未被拒绝');
$expired = $uid . '.' . (tc_now() - 10) . '.' . tc_web_ticket_sig($uid, tc_now() - 10);
if (tc_web_ticket_uid($expired) === '') $ok('过期票据被拒绝'); else $bad('过期票据未被拒绝');
if (tc_web_ticket_uid('') === '' && tc_web_ticket_uid('a.b') === '' && tc_web_ticket_uid('..') === '') $ok('畸形票据被拒绝'); else $bad('畸形票据未被拒绝');
if (tc_web_ticket_uid(str_repeat('a', 200) . '.' . $parts[1] . '.' . $parts[2]) === '') $ok('超长 uid 被拒绝'); else $bad('超长 uid 未被拒绝');

// ---------- 3) 代理地址 ----------
$p1 = tc_web_proxy_url('page', 'https://example.com/a?b=1', $t);
$eq(strpos($p1, '/api/web/page?u=') === 0, true, '页面代理地址前缀正确');
if (strpos($p1, '&t=' . $t) !== false) $ok('代理地址带上票据'); else $bad('代理地址缺票据');
$eq(strpos(tc_web_proxy_url('res', 'https://example.com/x.png', $t), '/api/web/res?u=') === 0, true, '子资源代理地址前缀正确');

// ---------- 4) URL 绝对化 ----------
$base = 'https://example.com/dir/page.html?q=1';
$eq(tc_web_abs('img.png', $base), 'https://example.com/dir/img.png', '相对路径');
$eq(tc_web_abs('./img.png', $base), 'https://example.com/dir/img.png', './ 相对路径');
$eq(tc_web_abs('../a/b.png', $base), 'https://example.com/a/b.png', '../ 上跳');
$eq(tc_web_abs('/root.css', $base), 'https://example.com/root.css', '根相对路径');
$eq(tc_web_abs('//cdn.example.org/x.js', $base), 'https://cdn.example.org/x.js', '协议相对路径沿用 base 的 scheme');
$eq(tc_web_abs('?x=2', $base), 'https://example.com/dir/page.html?x=2', '仅查询串');
$eq(tc_web_abs('#frag', $base), 'https://example.com/dir/page.html?q=1#frag', '仅锚点');
$eq(tc_web_abs('https://other.org/z', $base), 'https://other.org/z', '已是绝对地址原样返回');
$eq(tc_web_abs('', $base), '', '空地址返回空串');
$eq(tc_web_abs('x', ''), '', '无 base 时返回空串');
$eq(tc_web_abs('/a', 'https://example.com:8443/x'), 'https://example.com:8443/a', '保留非默认端口');
// 深层 .. 不越过根
$eq(tc_web_abs('../../../../a', 'https://example.com/d/e/f'), 'https://example.com/a', '上跳不越过根');

// ---------- 5) 跳过规则(不该代理的必须原样留着) ----------
foreach (array('#top', 'javascript:void(0)', 'data:image/png;base64,AA', 'mailto:a@b.c', 'tel:12345', 'blob:https://x/y', 'about:blank') as $skip) {
    $eq(tc_web_proxify($skip, $base, $t), $skip, '不代理 ' . $skip);
}
$already = '/api/web/res?u=' . tc_web_b64e('https://example.com/a.png') . '&t=' . $t;
$eq(tc_web_proxify($already, $base, $t), $already, '已代理地址不二次代理');
$eq(tc_web_proxify('', $base, $t), '', '空地址原样返回');
$enc = tc_web_proxify('https://example.com/a?b=1&amp;c=2', $base, $t);
if (strpos($enc, tc_web_b64e('https://example.com/a?b=1&c=2')) !== false) $ok('实体转义 &amp; 先解码再代理'); else $bad('实体转义未解码');

// ---------- 6) SSRF 闸门 ----------
// 先假装本站跑在 app.example.test 上,才能验证「不得回环访问本系统」那条(该判定读 $_SERVER)
$_SERVER['HTTP_HOST'] = 'app.example.test';
$_SERVER['SERVER_NAME'] = 'app.example.test';
$deny = array(
    'http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/a', 'http://192.168.1.1/a', 'http://172.16.0.1/a', 'http://[::1]/a',
    'http://0.0.0.0/a', 'file:///etc/passwd', 'gopher://x/1', 'ftp://x/1', 'http://example.com:22/a',
    'http://metadata.internal/a', 'http://x.lan/a', 'javascript:alert(1)', '',
    // 十进制/十六进制/八进制/缩写 等 IP 变体写法(getaddrinfo 能解出来,朴素字符串判定会漏)
    'http://2130706433/a', 'http://0x7f000001/a', 'http://0177.0.0.1/a', 'http://0x7f.0.0.1/a',
    'http://127.1/a',
    // 藏在 IPv6 过渡/隧道段里的内网地址(6to4 / Teredo / NAT64 / IPv4 映射与兼容)
    'http://[::ffff:127.0.0.1]/a', 'http://[::ffff:7f00:1]/a', 'http://[2002:7f00:1::]/a',
    'http://[2001:0:1234::1]/a', 'http://[64:ff9b::127.0.0.1]/a', 'http://[2001:db8::1]/a',
    // 共享主机内网段(RFC6598 CGNAT)与其它保留段
    'http://100.64.0.1/a', 'http://198.18.0.1/a', 'http://192.0.0.5/a', 'http://192.88.99.9/a',
    'http://[fc00::1]/a', 'http://[fe80::1]/a', 'http://[ff02::1]/a',
    // 本系统自身:填本站的公网域名/公网 IP 也要拒,否则等于绕过鉴权直连内部接口与 data/ 目录
    'http://app.example.test/api/admin/settings', 'http://APP.example.test:443/x',
    // 解析歧义与本地文件
    'http://user:pass@93.184.216.34/a', 'http://example.com@127.0.0.1/a',
    'http://127.0.0.1#@example.com/a', 'file:///C:/Windows/win.ini', 'file:///c:/boot.ini',
);
foreach ($deny as $u) {
    if (tc_web_guard($u) === false) $ok('闸门拒绝 ' . ($u === '' ? '(空)' : $u)); else $bad('闸门未拒绝: ' . $u);
}
// 反向断言:闸门不是「一律拒绝」。只用 IP 字面量,不依赖 DNS,离线 CI 同样可跑。
foreach (array('http://93.184.216.34/a', 'http://8.8.8.8/a', 'http://1.1.1.1:8080/x') as $u) {
    if (tc_web_guard($u) !== false) $ok('公网地址放行 ' . $u); else $bad('公网地址被误拒: ' . $u);
}

// ---------- 7) CSS 改写 ----------
$css = 'body{background:url(/img/bg.png) no-repeat}'
    . '@import "/css/other.css";'
    . '.a{background:url("https://cdn.x/y.woff2")}'
    . '.b{background:url(data:image/gif;base64,AA)}';
$out = tc_web_rewrite_css_urls($css, $base, $t);
if (strpos($out, '/api/web/res?u=' . tc_web_b64e('https://example.com/img/bg.png')) !== false) $ok('CSS url() 相对地址改写'); else $bad('CSS url() 相对地址未改写');
if (strpos($out, '/api/web/res?u=' . tc_web_b64e('https://cdn.x/y.woff2')) !== false) $ok('CSS url() 绝对地址改写'); else $bad('CSS 绝对地址未改写');
if (strpos($out, '/api/web/res?u=' . tc_web_b64e('https://example.com/css/other.css')) !== false) $ok('CSS @import 改写'); else $bad('CSS @import 未改写');
if (strpos($out, 'data:image/gif;base64,AA') !== false) $ok('CSS data: 地址保留'); else $bad('CSS data: 被破坏');

// ---------- 8) HTML 改写 ----------
$html = '<!DOCTYPE html><html><head>'
    . '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
    . '<base href="/wrong/">'
    . '<title>标题</title>'
    . '<link rel="stylesheet" href="/a.css" integrity="sha384-xxx" crossorigin="anonymous">'
    . '<style>.x{background:url(/s.png)}</style>'
    . '</head><body>'
    . '<a href="page2.html">下一页</a>'
    . '<a href="#frag">锚点</a>'
    . '<a href="javascript:void(0)">脚本</a>'
    . '<img src="pic.jpg" srcset="pic-2x.jpg 2x, /pic-3x.jpg 3x">'
    . '<form action="/search"><input type="text" name="q"></form>'
    . '<div style="background:url(/inline.png)"></div>'
    . '<iframe src="https://embed.example.org/e"></iframe>'
    . '<meta http-equiv="refresh" content="3;url=/next">'
    . '</body></html>';
$rw = tc_web_rewrite_html($html, $base, $t, false);
if (stripos($rw, 'content-security-policy') === false) $ok('摘掉目标站 CSP meta'); else $bad('CSP meta 未摘掉');
if (stripos($rw, '<base') === false) $ok('摘掉 base 标签'); else $bad('base 标签未摘掉');
if (stripos($rw, 'integrity=') === false && stripos($rw, 'crossorigin') === false) $ok('摘掉 integrity/crossorigin(否则 SRI 拒绝加载)'); else $bad('integrity/crossorigin 未摘掉');
if (strpos($rw, '/api/web/res?u=' . tc_web_b64e('https://example.com/a.css')) !== false) $ok('link href 改写'); else $bad('link href 未改写');
if (strpos($rw, '/api/web/res?u=' . tc_web_b64e('https://example.com/s.png')) !== false) $ok('<style> 内 url() 改写'); else $bad('<style> 内 url() 未改写');
if (strpos($rw, '/api/web/page?u=' . tc_web_b64e('https://example.com/dir/page2.html')) !== false) $ok('<a> 用页面代理(相对当前文档解析)'); else $bad('<a> 未改写或用了错误的代理类型');
if (strpos($rw, 'href="#frag"') !== false) $ok('锚点链接保留'); else $bad('锚点链接被改写');
if (strpos($rw, 'href="javascript:void(0)"') !== false) $ok('javascript: 链接保留'); else $bad('javascript: 链接被改写');
if (strpos($rw, '/api/web/res?u=' . tc_web_b64e('https://example.com/dir/pic.jpg')) !== false) $ok('img src 改写'); else $bad('img src 未改写');
$cast = tc_web_b64e('https://example.com/dir/pic-2x.jpg');
$cast3 = tc_web_b64e('https://example.com/pic-3x.jpg');
if (strpos($rw, $cast) !== false && strpos($rw, $cast3) !== false && strpos($rw, ' 2x') !== false && strpos($rw, ' 3x') !== false) $ok('srcset 逐项改写且保留描述符'); else $bad('srcset 改写不正确');
if (strpos($rw, '/api/web/page?u=' . tc_web_b64e('https://example.com/search')) !== false) $ok('form action 用页面代理'); else $bad('form action 未改写');
if (strpos($rw, '/api/web/res?u=' . tc_web_b64e('https://example.com/inline.png')) !== false) $ok('内联 style 的 url() 改写'); else $bad('内联 style 未改写');
if (strpos($rw, '/api/web/page?u=' . tc_web_b64e('https://embed.example.org/e')) !== false) $ok('iframe src 用页面代理'); else $bad('iframe src 未改写');
if (strpos($rw, '/api/web/page?u=' . tc_web_b64e('https://example.com/next')) !== false) $ok('meta refresh 跳转改写'); else $bad('meta refresh 未改写');
// 未加引号的属性值(minified 页面普遍如此)必须同样改写
$mini = '<script src=/s.js></script><link rel=stylesheet href=/a.css><a href=/next>x</a>'
    . '<img src=/p.png srcset=/p2.png 2x>'
    . '<form action=/go method=post></form>';
$mrw = tc_web_rewrite_html($mini, $base, $t, false);
if (strpos($mrw, '/api/web/res?u=' . tc_web_b64e('https://example.com/s.js')) !== false) $ok('裸值 script src 改写'); else $bad('裸值 script src 未改写');
if (strpos($mrw, '/api/web/res?u=' . tc_web_b64e('https://example.com/a.css')) !== false) $ok('裸值 link href 改写'); else $bad('裸值 link href 未改写');
if (strpos($mrw, '/api/web/page?u=' . tc_web_b64e('https://example.com/next')) !== false) $ok('裸值 <a> 走页面代理'); else $bad('裸值 <a> 未改写');
if ($mrw !== $mini) $ok('裸值属性整体被改写'); else $bad('裸值页面完全未被改写');
if (strpos($mrw, 'method=post') !== false || strpos($mrw, 'method="post"') !== false) $ok('非地址属性不受影响'); else $bad('未涉及的属性被破坏');
// 属性改写不得跨标签边界(标签内的 href 与下一个标签的属性不能串味)
$boundary = '<meta content="a" href="/x"><span data-x="href=javascript:alert(1)">y</span>';
$brw = tc_web_rewrite_html($boundary, $base, $t, false);
if (strpos($brw, '/api/web/res?u=' . tc_web_b64e('https://example.com/x')) !== false) $ok('标签内 href 正常改写'); else $bad('标签内 href 未改写');
if (strpos($brw, 'javascript:alert(1)') !== false) $ok('属性值里的伪 href 文本未被误改'); else $bad('属性值内容被误改');
// 注入位置:垫片必须在 <head> 之后、站点脚本之前
$inject = tc_web_inject($rw, '<script>window.__OCW={};</script>');
$posHead = stripos($inject, '<head');
$posShim = stripos($inject, 'window.__OCW');
$posLink = stripos($inject, '<link');
if ($posShim > $posHead && $posShim < $posLink) $ok('垫片注入在 <head> 之后、站点资源之前'); else $bad('垫片注入位置不对');
// 无 <head> 的碎片页也要注入
$frag = tc_web_inject('<div>hi</div>', '<script>window.__OCW={};</script>');
if (strpos($frag, 'window.__OCW') !== false && strpos($frag, 'window.__OCW') < strpos($frag, '<div>')) $ok('无 head/html 的碎片页前置注入'); else $bad('碎片页未前置注入');
// 配置里的 JSON 不能拼出 </script>:脚本标签数量必须与垫片数量一致(恶意的 </script> 不得多出一个)
$payload = tc_web_shim_payload('https://x/</script><script>alert(1)</script>', $t, array());
if (substr_count($payload, '<script') === substr_count($payload, '</script>')) $ok('注入配置里的 </script> 被转义(不会提前收尾)'); else $bad('注入配置存在 </script> 逃逸风险');
if (strpos($payload, 'https://x/</script>') === false) $ok('注入配置不含原始 </script> 片段'); else $bad('注入配置含原始 </script> 片段');

// 改写必须幂等且只转义一次:导航类替换跑在通用替换之前,通用替换会再看到已改写的 href,
// 若在那里二次转义就会得到 &amp;amp;(t 参数失效、链接点不动)
$once = tc_web_rewrite_html('<a href="/next?a=1&amp;b=2">x</a><img src="/p.png?x=1&amp;y=2">', $base, $t, false);
if (strpos($once, '&amp;amp;') === false) $ok('属性只转义一次(无 &amp;amp;)'); else $bad('出现二次转义: ' . $once);
$twice = tc_web_rewrite_html($once, $base, $t, false);
$eq($twice, $once, '二次改写结果不变(幂等)');
if (strpos($once, '/api/web/page?u=' . tc_web_b64e('https://example.com/next?a=1&b=2') . '&amp;t=') !== false) $ok('带查询串的链接改写且 & 转义为 &amp;'); else $bad('带查询串的链接改写不正确: ' . $once);
if (strpos($once, '&t=') === false) $ok('输出里不残留未转义的裸 &t=(HTML 属性内必须转义)'); else $bad('输出残留裸 &t=');

// ---------- 9) 字符集探测与转码 ----------
$eq(tc_web_charset('<html><head><meta charset="GBK"></head>', ''), 'gbk', '从 meta 探测字符集');
$eq(tc_web_charset('', 'text/html; charset=GB2312'), 'gb2312', '从响应头探测字符集');
$eq(tc_web_charset('<html>', 'text/html'), '', '无声明时返回空');
if (tc_web_to_utf8('abc', 'utf-8') === 'abc') $ok('已是 utf-8 不转码'); else $bad('utf-8 被错误转码');
if (function_exists('mb_convert_encoding')) {
    $gbk = @mb_convert_encoding('中文标题', 'GBK', 'UTF-8');
    if (is_string($gbk) && $gbk !== '') $eq(tc_web_to_utf8($gbk, 'gbk'), '中文标题', 'GBK 转 UTF-8');
} else {
    $ok('跳过 GBK 转码(无 mbstring)');
}
// 转码后 meta 声明要一并改成 utf-8,否则浏览器按旧声明解码成乱码
$conv = tc_web_rewrite_html('<html><head><meta charset="gbk"></head><body>x</body></html>', $base, $t, true);
if (preg_match('#charset\s*=\s*["\']?utf-8#i', $conv) && stripos($conv, 'gbk') === false) $ok('转码后 meta charset 改写为 utf-8'); else $bad('meta charset 未改写: ' . $conv);

// ---------- 10) cookie jar ----------
$u1 = 'u_jar_a';
tc_web_jar_store($u1, 'https://example.com/login', array(
    'sid=abc123; Path=/; Domain=.example.com; Secure; HttpOnly',
    'hostonly=1; Path=/app',
    'gone=1; Path=/; Max-Age=0',
));
$h = tc_web_jar_header($u1, 'https://www.example.com/app/x', '');
if (strpos($h, 'sid=abc123') !== false) $ok('Domain cookie 对子域生效'); else $bad('Domain cookie 未对子域生效: ' . $h);
if (strpos($h, 'hostonly=1') === false) $ok('无 Domain 的 cookie 限定主机名(不发给子域)'); else $bad('host-only cookie 被发到子域: ' . $h);
$hHost = tc_web_jar_header($u1, 'https://example.com/app/x', '');
if (strpos($hHost, 'hostonly=1') !== false) $ok('Path 前缀匹配命中'); else $bad('Path 匹配失败: ' . $hHost);
if (strpos($h, 'gone') === false) $ok('Max-Age=0 视为删除'); else $bad('Max-Age=0 未删除');
$hNoPath = tc_web_jar_header($u1, 'https://example.com/other', '');
if (strpos($hNoPath, 'hostonly=1') === false) $ok('Path 不匹配时不发送'); else $bad('Path 不匹配仍发送: ' . $hNoPath);
$hHttp = tc_web_jar_header($u1, 'http://www.example.com/app/x', '');
if (strpos($hHttp, 'sid=abc123') === false) $ok('Secure cookie 不走 http'); else $bad('Secure cookie 被发到 http');
$hOther = tc_web_jar_header($u1, 'https://other.org/', '');
if (strpos($hOther, 'sid=abc123') === false && strpos($hOther, 'hostonly=1') === false) $ok('无关域名不带任何 cookie'); else $bad('cookie 跨域泄漏: ' . $hOther);
$hExtra = tc_web_jar_header($u1, 'https://other.org/', 'pagec=1; other=2');
if (strpos($hExtra, 'pagec=1') !== false && strpos($hExtra, 'other=2') !== false) $ok('页面侧(shim)交上来的 cookie 合并进请求'); else $bad('页面侧 cookie 未合并: ' . $hExtra);
// 过期 cookie 不再加载
tc_web_jar_store($u1, 'https://example.com/', array('old=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
if (strpos(tc_web_jar_header($u1, 'https://example.com/', ''), 'old=') === false) $ok('已过期 cookie 被清除'); else $bad('过期 cookie 仍在 jar 里');
// 同一 (domain,name,path) 覆盖而非堆积
tc_web_jar_store($u1, 'https://example.com/', array('dup=1; Path=/'));
tc_web_jar_store($u1, 'https://example.com/', array('dup=2; Path=/'));
$nd = 0;
foreach (tc_web_jar_load($u1) as $c) if ($c['n'] === 'dup') $nd++;
$eq($nd, 1, '同名 cookie 覆盖不堆积');
$snap = tc_web_jar_snapshot($u1, 'https://example.com/');
$eq(isset($snap['dup']) ? $snap['dup'] : '', '2', 'jar 快照取到最新值(用于注入回页面的 document.cookie)');

// ---------- 11) 收藏夹 ----------
$db = array('settings' => array());
$def = tc_web_bookmarks_of($db);
$names = array();
foreach ($def as $b) $names[] = $b['name'];
if (in_array('Google 学术', $names, true) && in_array('arXiv', $names, true)) $ok('内置默认收藏夹含 Google 学术 / arXiv'); else $bad('内置收藏夹缺少常用学术站');
$db2 = array('settings' => array(
    'webBookmarks' => array(array('name' => ' 我的站 ', 'url' => 'https://a.example/'), array('name' => '', 'url' => 'https://bad/')),
));
$custom = tc_web_bookmarks_of($db2);
$eq(count($custom), 1, '配置的收藏夹覆盖默认并跳过残缺项');
$eq($custom[0]['name'], '我的站', '收藏夹名称去空白');

// 用户自己的收藏:保存 → 读回(实现里假定已登录,这里直接测读写函数)
$u2 = 'u_bm_a';
tc_web_user_bookmarks_save($u2, array(array('name' => 'A', 'url' => 'https://a.example/')));
$eq(tc_web_user_bookmarks($u2), array(array('name' => 'A', 'url' => 'https://a.example/')), '用户收藏可保存并读回');
$eq(tc_web_user_bookmarks('u_never_saved'), array(), '未保存过的用户返回空数组');

// ---------- 12) 每日次数上限(文件锁内判上限,默认 50) ----------
$db3 = array('settings' => array('webAiDailyLimit' => 2));
$u3 = 'u_limit_a';
$c1 = tc_web_ai_consume($db3, $u3);
$c2 = tc_web_ai_consume($db3, $u3);
$c3 = tc_web_ai_consume($db3, $u3);
$eq(array($c1, $c2, $c3), array(true, true, false), '每日上限 2 次时第 3 次被拒');
$eq(tc_web_ai_used_today($u3), 2, '用量计数为 2');
tc_web_ai_refund($u3);
$eq(tc_web_ai_used_today($u3), 1, '退回后计数减 1');
$db4 = array('settings' => array('webAiDailyLimit' => 0));
$eq(tc_web_ai_consume($db4, $u3), true, '上限 0 表示不限');
$other = 'u_limit_b';
$eq(tc_web_ai_used_today($other), 0, '不同用户各自计数');

// ---------- 13) 子资源短缓存 ----------
foreach (array('image/png', 'image/svg+xml; charset=utf-8', 'font/woff2', 'application/javascript', 'text/javascript', 'video/mp4', 'application/wasm') as $c) {
    if (tc_web_cacheable_ctype($c)) $ok('可缓存类型放行 ' . $c); else $bad('可缓存类型被拒: ' . $c);
}
// HTML/CSS 带票据改写、其它文本/JSON 可能带个性化数据,都不能进缓存
foreach (array('text/html', 'text/css', 'application/json', 'text/plain', 'application/octet-stream', '') as $c) {
    if (!tc_web_cacheable_ctype($c)) $ok('不可缓存类型被拒 ' . ($c === '' ? '(空)' : $c)); else $bad('不可缓存类型被放行: ' . $c);
}
$cdUrl = 'https://example.com/cache-a.png';
if (tc_web_cache_get($cdUrl) === null) $ok('未写入前缓存不命中'); else $bad('未写入就命中缓存');
tc_web_cache_put($cdUrl, 'image/png', 200, 'PNGDATA');
$chit = tc_web_cache_get($cdUrl);
if (is_array($chit) && $chit['ctype'] === 'image/png' && $chit['status'] === 200 && $chit['body'] === 'PNGDATA') $ok('缓存写入后可读回类型与字节'); else $bad('缓存读回不正确');
if (tc_web_cache_get('https://example.com/cache-b.png') === null) $ok('不同地址互不命中'); else $bad('不同地址串了缓存');
tc_web_cache_put('https://example.com/cache-big.bin', 'image/png', 200, str_repeat('x', TC_WEB_CACHE_MAX_BYTES + 1));
if (tc_web_cache_get('https://example.com/cache-big.bin') === null) $ok('超过单条上限的内容不落盘'); else $bad('超大内容被缓存');
// 两份响应用同一 URL 时以新写入的为准(站点资源换了要能覆盖)
tc_web_cache_put($cdUrl, 'image/jpeg', 200, 'NEWBYTES');
$chit2 = tc_web_cache_get($cdUrl);
if (is_array($chit2) && $chit2['ctype'] === 'image/jpeg' && $chit2['body'] === 'NEWBYTES') $ok('同 URL 重复写入覆盖旧缓存'); else $bad('旧缓存未被覆盖');

echo $fail === 0 ? "\n全部通过\n" : "\n失败 {$fail} 项\n";
exit($fail === 0 ? 0 : 1);
