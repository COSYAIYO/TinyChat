<?php
/**
 * web.php — 在线浏览器:服务端反向代理 + 网页 AI 总结。
 *
 * 为什么必须走服务端代理,而不是在 iframe 里直嵌目标站:
 *   1) 目标站自己的 X-Frame-Options / CSP frame-ancestors 会拒绝被嵌(Google、百度、知乎、B 站皆然),
 *      内嵌只会得到一张空白页;
 *   2) 本站 CSP 的 default-src 'self' 也不允许外部 frame。
 * 于是由虚拟主机的出网能力取回页面,改写链接后在同源下渲染 —— 用户看到的是「主机出口 IP 的视图」。
 *
 * 安全边界(改动这里前请先读):
 *   - 被代理页面运行在 sandbox 且**不带 allow-same-origin** 的 iframe 里。沙箱使其成为不透明源,
 *     页面脚本读不到本站 localStorage 里的登录令牌(oc_token),所以即使目标站被注入 XSS,
 *     也无法冒充当前用户调用本站接口。代价:该页面没有可持久化的 storage/cookie,
 *     站点会话改由服务端 cookie jar(每用户一份)维持,并由 shim 把 jar 快照注入回页面。
 *   - 服务端出网必须过 SSRF 闸门(tc_url_public_host):拒绝内网/保留 IP、云元数据 169.254.169.254、
 *     非常规端口,并把 DNS 结果 pin 住(CURLOPT_RESOLVE)避免解析后再被劫持。跳转逐跳校验。
 *   - 鉴权用无状态票据(uid.exp.HMAC),而不是 Bearer 头:iframe 与 <img>/<link> 发起的请求
 *     带不上 Authorization 头,票据放进 URL 才能让子资源也通过同一套校验。
 *   - 路由与文件命名避开 "chat" 关键字(免费主机 WAF 惯例,见 .htaccess)。
 *
 * 与图片/视频代理(lib/proxy.php)的关系:那两处是「签名直传字节」,面向已知的生成结果;
 * 这里要的是「改写 + 抓取会话 + 子资源遍历」,所以另立一套,但复用同一套 SSRF 判定。
 */

require_once __DIR__ . '/core.php';
require_once __DIR__ . '/proxy.php';

define('TC_WEB_MAX_BYTES', 8 * 1024 * 1024);    // 单次抓取上限(页面/资源)
define('TC_WEB_TEXT_MAX', 12000);               // 送去总结的正文截断(字符)
define('TC_WEB_TITLE_MAX', 300);
define('TC_WEB_TIMEOUT_MS', 20000);             // 单跳超时
define('TC_WEB_MAX_HOPS', 5);                   // 最大跳转次数(逐跳都要过 SSRF 闸门)
// 注意:tc_now() 返回毫秒,票据的 exp 与之同单位;而 cookie 的 Expires/Max-Age 按 RFC 是秒,
// 那部分一律用 time() 计算 —— 两套时间单位混用会让票据「签完就过期」或 cookie 永不过期。
define('TC_WEB_TICKET_TTL', 8 * 3600 * 1000);  // 票据有效期(毫秒,与 tc_now() 同单位)
define('TC_WEB_MAX_POST', 1024 * 1024);         // 表单转发体积上限
define('TC_WEB_AI_TEXT_MAX', 16000);            // AI 回复文本截断(字符)

// 目标站普遍按 UA 决定是否给完整页面(无 UA 或奇怪 UA 会拿到降级页或 403),
// 因此这里用常见的桌面浏览器 UA;这不是伪装身份,是让站点走正常渲染分支。
function tc_web_ua() {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}

// ============ 总开关 ============

function tc_web_feature_guard($db) {
    if (empty($db['settings']['browserEnabled'])) tc_fail(403, '本站未开放在线浏览器功能');
}

// 收藏夹内置站点。用户自己的收藏另存 data/web/{uid}/bookmarks.json;
// 这里是「出厂默认」,管理端可用 settings.webBookmarks 覆盖。
function tc_web_default_bookmarks() {
    return array(
        array('name' => 'Google 学术', 'url' => 'https://scholar.google.com/'),
        array('name' => 'arXiv', 'url' => 'https://arxiv.org/'),
        array('name' => 'PubMed', 'url' => 'https://pubmed.ncbi.nlm.nih.gov/'),
        array('name' => 'Semantic Scholar', 'url' => 'https://www.semanticscholar.org/'),
        array('name' => 'Google', 'url' => 'https://www.google.com/'),
        array('name' => '必应', 'url' => 'https://www.bing.com/'),
        array('name' => '百度', 'url' => 'https://www.baidu.com/'),
        array('name' => '维基百科', 'url' => 'https://zh.wikipedia.org/'),
        array('name' => 'GitHub', 'url' => 'https://github.com/'),
        array('name' => 'Stack Overflow', 'url' => 'https://stackoverflow.com/'),
        array('name' => '知乎', 'url' => 'https://www.zhihu.com/'),
        array('name' => '哔哩哔哩', 'url' => 'https://www.bilibili.com/'),
        array('name' => 'Hacker News', 'url' => 'https://news.ycombinator.com/'),
        array('name' => 'Nature', 'url' => 'https://www.nature.com/'),
    );
}

function tc_web_bookmarks_of($db) {
    $custom = isset($db['settings']['webBookmarks']) && is_array($db['settings']['webBookmarks']) ? $db['settings']['webBookmarks'] : array();
    $out = array();
    foreach ($custom as $b) {
        if (!is_array($b)) continue;
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $u = trim((string) (isset($b['url']) ? $b['url'] : ''));
        if ($name === '' || $u === '') continue;
        $out[] = array('name' => tc_utf_cut($name, 40), 'url' => tc_utf_cut($u, 500));
    }
    return $out ? $out : tc_web_default_bookmarks();
}

// ============ 票据(无状态,子资源请求也能带上) ============

function tc_web_b64e($s) {
    return rtrim(strtr(base64_encode((string) $s), '+/', '-_'), '=');
}

function tc_web_b64d($s) {
    $s = strtr((string) $s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    $out = base64_decode($s, true);
    return is_string($out) ? $out : '';
}

function tc_web_ticket_sig($uid, $exp) {
    return substr(hash_hmac('sha256', $uid . '|' . $exp, tc_secret()), 0, 32);
}

function tc_web_ticket_make($uid) {
    $exp = tc_now() + TC_WEB_TICKET_TTL;
    return (string) $uid . '.' . $exp . '.' . tc_web_ticket_sig((string) $uid, $exp);
}

// 校验票据:返回 uid;无效/过期返回 ''。
function tc_web_ticket_uid($ticket) {
    $parts = explode('.', (string) $ticket);
    if (count($parts) !== 3) return '';
    list($uid, $exp, $sig) = $parts;
    if ($uid === '' || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $uid)) return '';
    if (!preg_match('/^\d{10,16}$/', $exp) || (int) $exp < tc_now()) return '';
    if (!hash_equals(tc_web_ticket_sig($uid, $exp), (string) $sig)) return '';
    return $uid;
}

function tc_web_proxy_url($kind, $url, $ticket) {
    return '/api/web/' . ($kind === 'page' ? 'page' : 'res') . '?u=' . tc_web_b64e($url) . '&t=' . $ticket;
}

// ============ 每用户 cookie jar ============
// 目标站的会话(登录态、同意墙、CSRF 令牌)保存在服务端。沙箱页面自己存不住 cookie,
// 所以由服务端在每次出网时带上、在响应里摘下,再把快照注入回页面给 shim 的 document.cookie 用。

function tc_web_user_dir($userId, $create = true) {
    $dir = tc_data_dir() . '/web/' . preg_replace('/[^A-Za-z0-9_-]/', '', (string) $userId);
    if ($create && !is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_web_jar_path($userId) {
    return tc_web_user_dir($userId) . '/cookies.json';
}

function tc_web_jar_load($userId) {
    $j = json_decode((string) @file_get_contents(tc_web_jar_path($userId)), true);
    if (!is_array($j)) return array();
    $now = time();   // cookie 的 Expires/Max-Age 单位是秒(不是 tc_now() 的毫秒)
    $out = array();
    foreach ($j as $c) {
        if (!is_array($c) || !isset($c['n'])) continue;
        if (!empty($c['e']) && (int) $c['e'] > 0 && (int) $c['e'] < $now) continue;
        $out[] = $c;
    }
    return $out;
}

function tc_web_jar_put($userId, $jar) {
    $dir = tc_web_user_dir($userId);
    if (!is_dir($dir)) return;
    // 只留未过期项,并按域名数量兜底(避免目标站狂写 cookie 把文件撑爆)
    if (count($jar) > 400) $jar = array_slice($jar, -400);
    @file_put_contents(tc_web_jar_path($userId), tc_json_encode(array_values($jar)), LOCK_EX);
}

// 域名匹配:Domain 属性存在时按后缀匹配(含子域),否则仅主机名精确匹配。
function tc_web_host_matches($host, $cookie, $urlHost) {
    $host = strtolower(trim((string) $host, '.'));
    $urlHost = strtolower((string) $urlHost);
    if ($host === '') return false;
    if (!empty($cookie)) return $urlHost === $host || substr($urlHost, -strlen($host) - 1) === '.' . $host;
    return $urlHost === $host;
}

function tc_web_jar_header($userId, $url, $extra = '') {
    $p = @parse_url($url);
    if (!$p || empty($p['host'])) return trim((string) $extra);
    $host = $p['host'];
    $path = isset($p['path']) ? (string) $p['path'] : '/';
    $secure = strtolower((string) (isset($p['scheme']) ? $p['scheme'] : '')) === 'https';
    $pairs = array();
    foreach (tc_web_jar_load($userId) as $c) {
        if (!tc_web_host_matches(isset($c['d']) ? $c['d'] : '', !empty($c['dom']), $host)) continue;
        if (!empty($c['sec']) && !$secure) continue;
        $cp = isset($c['p']) ? (string) $c['p'] : '/';
        if ($cp !== '/' && strpos($path, $cp) !== 0) continue;
        $pairs[$c['n']] = (string) (isset($c['v']) ? $c['v'] : '');
    }
    $extra = trim((string) $extra);
    if ($extra !== '') {
        foreach (explode(';', $extra) as $kv) {
            $kv = trim($kv);
            if ($kv === '' || strpos($kv, '=') === false) continue;
            $n = substr($kv, 0, strpos($kv, '='));
            $pairs[trim($n)] = trim(substr($kv, strpos($kv, '=') + 1));
        }
    }
    $out = array();
    foreach ($pairs as $n => $v) $out[] = $n . '=' . $v;
    return implode('; ', $out);
}

// 摘 Set-Cookie 并合并进 jar。同一 (domain,name,path) 覆盖旧值;Max-Age=0 / 过期时间在过去 = 删除。
function tc_web_jar_store($userId, $url, $setCookies) {
    if (!$setCookies) return;
    $p = @parse_url($url);
    if (!$p || empty($p['host'])) return;
    $urlHost = strtolower($p['host']);
    $jar = tc_web_jar_load($userId);
    $index = array();
    foreach ($jar as $i => $c) $index[$i] = strtolower((string) (isset($c['d']) ? $c['d'] : '')) . '|' . (string) $c['n'] . '|' . (string) (isset($c['p']) ? $c['p'] : '/');
    foreach ((array) $setCookies as $raw) {
        $bits = explode(';', (string) $raw);
        $first = trim(array_shift($bits));
        if ($first === '' || strpos($first, '=') === false) continue;
        $name = trim(substr($first, 0, strpos($first, '=')));
        $value = trim(substr($first, strpos($first, '=') + 1));
        if ($name === '') continue;
        $domain = '';
        $path = '/';
        $expires = 0;
        $hasExpiry = false;
        $secure = false;
        $isDomain = false;
        foreach ($bits as $b) {
            $b = trim($b);
            if ($b === '') continue;
            $eq = strpos($b, '=');
            $k = strtolower($eq === false ? $b : trim(substr($b, 0, $eq)));
            $v = $eq === false ? '' : trim(substr($b, $eq + 1));
            if ($k === 'domain' && $v !== '') { $domain = ltrim($v, '.'); $isDomain = true; }
            elseif ($k === 'path' && $v !== '') $path = $v;
            // Max-Age=0 就是删除语义(比 Expires 优先),直接记成已过期
            elseif ($k === 'max-age' && is_numeric($v)) { $expires = (int) $v === 0 ? time() - 10 : time() + (int) $v; $hasExpiry = true; }
            // Expires 必须认 0 值(1970-01-01 即删除);strtotime 失败才忽略
            elseif ($k === 'expires' && $v !== '') { $ts = @strtotime($v); if ($ts !== false) { $expires = $ts; $hasExpiry = true; } }
            elseif ($k === 'secure') $secure = true;
        }
        if ($domain === '') $domain = $urlHost;
        $key = strtolower($domain) . '|' . $name . '|' . $path;
        // 没有到期时间的是会话 cookie(会话由服务端维持,这里长期保留);
        // 有到期时间的才判断是否已过期。
        $dead = $hasExpiry && $expires < time() - 1;
        $hit = null;
        foreach ($index as $i => $k) if ($k === $key) { $hit = $i; break; }
        if ($dead) {
            if ($hit !== null) unset($jar[$hit]);
            continue;
        }
        $row = array('d' => $domain, 'dom' => $isDomain ? 1 : 0, 'n' => $name, 'v' => tc_utf_cut($value, 4000), 'p' => $path, 'e' => $expires, 'sec' => $secure ? 1 : 0);
        if ($hit !== null) $jar[$hit] = $row;
        else $jar[] = $row;
    }
    tc_web_jar_put($userId, array_values($jar));
}

// 页面里 shim 的 document.cookie 需要一份初始快照(目标站 JS 常读 cookie 判断登录态)
function tc_web_jar_snapshot($userId, $url) {
    $p = @parse_url($url);
    if (!$p || empty($p['host'])) return array();
    $out = array();
    foreach (tc_web_jar_load($userId) as $c) {
        if (!tc_web_host_matches(isset($c['d']) ? $c['d'] : '', !empty($c['dom']), $p['host'])) continue;
        $out[(string) $c['n']] = (string) (isset($c['v']) ? $c['v'] : '');
    }
    return $out;
}

// ============ URL 处理 ============

// 相对地址 → 绝对地址。已是绝对(带 scheme)的原样返回;无法解析返回 ''。
function tc_web_abs($u, $base) {
    $u = trim((string) $u);
    if ($u === '') return '';
    if (preg_match('#^[a-zA-Z][a-zA-Z0-9+.\-]*:#', $u)) return $u;
    $b = @parse_url($base);
    if (!$b || empty($b['host'])) return '';
    $scheme = strtolower((string) (isset($b['scheme']) ? $b['scheme'] : 'https'));
    if ($scheme !== 'http' && $scheme !== 'https') return '';
    $host = (string) $b['host'];
    if (strpos($host, ':') !== false) $host = '[' . $host . ']';
    $authority = $scheme . '://' . $host . (isset($b['port']) ? ':' . (int) $b['port'] : '');
    if (strpos($u, '//') === 0) return $scheme . ':' . $u;
    $bpath = isset($b['path']) ? (string) $b['path'] : '/';
    if ($u[0] === '/') return $authority . $u;
    if ($u[0] === '?') return $authority . $bpath . $u;
    if ($u[0] === '#') return $authority . $bpath . (isset($b['query']) && $b['query'] !== '' ? '?' . $b['query'] : '') . $u;
    if ($u[0] === ';') return $authority . $bpath . $u;
    $dir = substr($bpath, 0, strrpos($bpath, '/') === false ? 0 : strrpos($bpath, '/') + 1);
    if ($dir === '') $dir = '/';
    $stack = array();
    foreach (explode('/', $dir . $u) as $seg) {
        if ($seg === '.') continue;
        if ($seg === '..') { if (count($stack) > 1) array_pop($stack); continue; }
        $stack[] = $seg;
    }
    $path = implode('/', $stack);
    if ($path === '' || $path[0] !== '/') $path = '/' . $path;
    return $authority . $path;
}

// 仅放行「全球可路由」地址:用二进制前缀比较(inet_pton + CIDR)自己判,不依赖 filter_var 的版本差异。
// 除了常规私有段,这里还堵上 filter_var 的 NO_PRIV/NO_RES 掩码覆盖不到、但在主机环境里恰恰是
// 内网的几段:100.64.0.0/10(RFC6598 CGNAT,共享主机内网常用)、198.18.0.0/15(基准测试)、
// 192.0.0.0/24、192.88.99.0/24;以及能把 IPv4 内网地址藏在里面的 IPv6 过渡/隧道段 ——
// 6to4 2002::/16、Teredo 2001::/32、NAT64 64:ff9b::/96、IPv4 兼容/映射 ::/96 与 ::ffff:0:0/96,
// 外加文档段 2001:db8::/32、丢弃段 100::/64。
function tc_web_cidr_match($bin, $net, $bits) {
    if (!is_string($bin) || $bin === '') return false;
    $netBin = @inet_pton($net);
    if ($netBin === false || strlen($netBin) !== strlen($bin)) return false;
    $full = intdiv($bits, 8);
    if ($full > 0 && substr($bin, 0, $full) !== substr($netBin, 0, $full)) return false;
    $rem = $bits % 8;
    if ($rem === 0) return true;
    $mask = (0xFF << (8 - $rem)) & 0xFF;
    return (ord($bin[$full]) & $mask) === (ord($netBin[$full]) & $mask);
}

function tc_web_ip_public($ip) {
    $bin = @inet_pton((string) $ip);
    if ($bin === false) return false;
    static $v4 = array(
        array('0.0.0.0', 8), array('10.0.0.0', 8), array('100.64.0.0', 10), array('127.0.0.0', 8),
        array('169.254.0.0', 16), array('172.16.0.0', 12), array('192.0.0.0', 24), array('192.0.2.0', 24),
        array('192.88.99.0', 24), array('192.168.0.0', 16), array('198.18.0.0', 15), array('198.51.100.0', 24),
        array('203.0.113.0', 24), array('224.0.0.0', 4), array('240.0.0.0', 4),
    );
    static $v6 = array(
        array('::', 128), array('::', 96), array('::ffff:0:0', 96), array('64:ff9b::', 96), array('100::', 64),
        array('2001::', 32), array('2001:db8::', 32), array('2002::', 16), array('fc00::', 7),
        array('fe80::', 10), array('ff00::', 8),
    );
    foreach (strlen($bin) === 4 ? $v4 : $v6 as $c) {
        if (tc_web_cidr_match($bin, $c[0], $c[1])) return false;
    }
    return true;
}

// 「本系统自己」的标识集合:请求 Host、服务器名/地址、本机主机名及其解析、网卡地址。
// 用户拿代理回环访问本站(哪怕填的是本站自己的公网域名或公网 IP)必须被拒 ——
// 那等于绕过站点自身的鉴权与 WAF,直接摸内部接口与 data/ 目录。
// 缓存是因为子资源每次抓取都会问一次,而 DNS 解析不该在每个 <img> 上重来。
function tc_web_self_hosts() {
    static $cache = null;
    if ($cache !== null) return $cache;
    $set = array();
    $add = function ($v) use (&$set) {
        $v = strtolower(trim((string) $v, " \t\n\r\0\x0B[]"));
        if ($v === '') return;
        $v = preg_replace('/:\d+$/', '', $v);          // 带端口的形式(HTTP_HOST 常见)
        $v = preg_replace('/%.*$/', '', $v);           // IPv6 的 %eth0 作用域后缀
        if ($v !== '') $set[$v] = 1;
    };
    foreach (array('HTTP_HOST', 'SERVER_NAME', 'SERVER_ADDR') as $k) {
        if (isset($_SERVER[$k])) $add($_SERVER[$k]);
    }
    $hn = @gethostname();
    if ($hn) {
        $add($hn);
        foreach ((array) @gethostbynamel((string) $hn) as $ip) $add($ip);
    }
    if (function_exists('net_get_interfaces')) {
        foreach ((array) @net_get_interfaces() as $iface) {
            foreach ((array) (isset($iface['unicast']) ? $iface['unicast'] : array()) as $u) {
                if (!empty($u['address'])) $add($u['address']);
            }
        }
    }
    return $cache = array_keys($set);
}

// 出网闸门:SSRF 校验 + DNS pin。测试钩子(TC_WEB_FETCH_BASE)在校验通过之后才改写,
// 所以被拦下的地址照样进不来。
function tc_web_guard($url) {
    $p0 = @parse_url((string) $url);
    if (!$p0 || empty($p0['host'])) return false;
    // 带 userinfo 的地址直接拒:http://public.com@127.0.0.1/ 这类写法在各类客户端里解析歧义最多
    if (isset($p0['user']) || isset($p0['pass'])) return false;
    $host = strtolower(trim((string) $p0['host'], '[]'));
    // 单标签主机名(内网 NetBIOS / mDNS / APIPA 短名)不放行:域名至少得有一个点
    if ($host === '' || (strpos($host, '.') === false && !filter_var($host, FILTER_VALIDATE_IP))) return false;
    $g = tc_url_public_host($url);
    if (!$g) return false;
    if (!tc_web_ip_public($g['ip'])) return false;   // 复核解析结果(补上共享主机内网段)
    foreach (tc_web_self_hosts() as $self) {
        if ($host === $self || strtolower((string) $g['ip']) === $self) return false;
    }
    $testBase = rtrim((string) (getenv('TC_WEB_FETCH_BASE') ?: ''), '/');
    if ($testBase !== '') {
        $t = @parse_url($testBase);
        if ($t && !empty($t['host'])) {
            $p = @parse_url($url);
            $path = isset($p['path']) ? (string) $p['path'] : '/';
            $port = isset($t['port']) ? (int) $t['port'] : (strtolower((string) $t['scheme']) === 'https' ? 443 : 80);
            return array('url' => $testBase . $path . (isset($p['query']) && $p['query'] !== '' ? '?' . $p['query'] : ''), 'resolve' => $t['host'] . ':' . $port . ':127.0.0.1');
        }
    }
    return array('url' => $url, 'resolve' => $g['host'] . ':' . $g['port'] . ':' . $g['ip']);
}

// 把 href/src 里的地址变成走代理的地址;不该代理的(hash/javascript:/data:/已是代理地址)原样返回。
// 约定:返回值一律是**未做 HTML 转义**的原始值 —— 调用方负责在写回属性时统一转义一次。
// 这条约定很重要:导航类替换跑在通用替换之前,通用替换会再看到 `href="/api/web/page?u=..&amp;t=.."`,
// 若这里把已转义文本原样回吐、调用方又转义一遍,就会得到 `&amp;amp;`(t 参数失效)。
function tc_web_proxify($u, $base, $ticket, $kind = 'res') {
    $decoded = html_entity_decode(trim((string) $u), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if ($decoded === '') return $decoded;
    $low = strtolower($decoded);
    foreach (array('#', 'javascript:', 'data:', 'mailto:', 'tel:', 'sms:', 'about:', 'blob:', 'file:', 'chrome:') as $p) {
        if (strpos($low, $p) === 0) return $decoded;
    }
    if (strpos($decoded, '/api/web/') === 0) return $decoded;
    $abs = tc_web_abs($decoded, $base);
    if (!preg_match('#^https?://#i', (string) $abs)) return $decoded;
    return tc_web_proxy_url($kind, $abs, $ticket);
}

// CSS 里的 url() / @import 也要走代理,否则图片与字体直连目标站(font 还会被 CORS 拦)。
function tc_web_rewrite_css_urls($css, $base, $ticket) {
    $css = (string) $css;
    $css = preg_replace_callback('#url\(\s*(["\']?)([^"\')]+?)\1\s*\)#i', function ($m) use ($base, $ticket) {
        return 'url("' . str_replace('"', '%22', tc_web_proxify($m[2], $base, $ticket)) . '")';
    }, $css);
    $css = preg_replace_callback('#(@import\s+)(["\'])([^"\']+)\2#i', function ($m) use ($base, $ticket) {
        return $m[1] . $m[2] . tc_web_proxify($m[3], $base, $ticket) . $m[2];
    }, $css);
    return $css;
}

// srcset 是逗号分隔的「地址 + 描述符」列表,逐项改写后拼回。
function tc_web_rewrite_srcset($value, $base, $ticket) {
    $parts = array();
    foreach (explode(',', (string) $value) as $item) {
        $item = trim($item);
        if ($item === '') continue;
        if (!preg_match('#^(\S+)(\s+.*)?$#', $item, $m)) { $parts[] = $item; continue; }
        $parts[] = tc_web_proxify($m[1], $base, $ticket) . (isset($m[2]) ? $m[2] : '');
    }
    return implode(', ', $parts);
}

// 探测页面字符集:优先响应头,其次 <meta>。转成 UTF-8 后我们统一按 utf-8 输出,
// 否则中文站点(GBK)注入 shim 后会出现乱码。
function tc_web_charset($body, $ctype) {
    if (preg_match('#charset\s*=\s*["\']?([A-Za-z0-9_\-]+)#i', (string) $ctype, $m)) return strtolower($m[1]);
    if (preg_match('#<meta[^>]+charset\s*=\s*["\']?([A-Za-z0-9_\-]+)#i', substr((string) $body, 0, 8192), $m)) return strtolower($m[1]);
    return '';
}

function tc_web_to_utf8($body, $charset) {
    if ($charset === '' || $charset === 'utf-8' || $charset === 'utf8') return $body;
    if (function_exists('mb_convert_encoding')) {
        $o = @mb_convert_encoding($body, 'UTF-8', $charset);
        if (is_string($o) && $o !== '') return $o;
    }
    if (function_exists('iconv')) {
        $o = @iconv($charset, 'UTF-8//IGNORE', $body);
        if (is_string($o) && $o !== '') return $o;
    }
    return $body;
}

// ============ 抓取(逐跳校验,带 cookie) ============

function tc_web_fetch($url, $userId, $opts = array()) {
    $maxBytes = (int) (isset($opts['maxBytes']) ? $opts['maxBytes'] : TC_WEB_MAX_BYTES);
    $timeoutMs = (int) (isset($opts['timeoutMs']) ? $opts['timeoutMs'] : TC_WEB_TIMEOUT_MS);
    $method = strtoupper((string) (isset($opts['method']) ? $opts['method'] : 'GET'));
    $body = isset($opts['body']) ? $opts['body'] : null;
    $reqCtype = (string) (isset($opts['ctype']) ? $opts['ctype'] : '');
    $accept = (string) (isset($opts['accept']) ? $opts['accept'] : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
    $lang = (string) (isset($opts['lang']) ? $opts['lang'] : 'zh-CN,zh;q=0.9,en;q=0.8');
    $range = (string) (isset($opts['range']) ? $opts['range'] : '');
    $clientCookie = (string) (isset($opts['cookie']) ? $opts['cookie'] : '');
    $referer = (string) (isset($opts['referer']) ? $opts['referer'] : '');
    $cur = (string) $url;
    $from = $referer;
    for ($hop = 0; $hop <= TC_WEB_MAX_HOPS; $hop++) {
        $guard = tc_web_guard($cur);
        if (!$guard) return array('ok' => false, 'error' => '该地址不允许访问(仅支持公网 http/https 地址)', 'code' => 400);
        if (!function_exists('curl_init')) return array('ok' => false, 'error' => '服务器未启用 cURL,无法访问外部网站', 'code' => 500);
        $target = $guard['url'];
        $ch = curl_init($target);
        $hdrs = array(
            'User-Agent: ' . tc_web_ua(),
            'Accept: ' . $accept,
            'Accept-Language: ' . $lang,
            'Upgrade-Insecure-Requests: 1',
        );
        // 不要自己写 Accept-Encoding:手工发这个头会让 curl 关闭自动解压,拿回来的是压缩字节,
        // 正文抽取与 HTML 改写会全部落空(实测 example.com 返回 gzip 后正文为空)。
        // 交给 CURLOPT_ENCODING = '' 让它自己声明并自动解码。
        $cookie = tc_web_jar_header($userId, $cur, $clientCookie);
        if ($cookie !== '') $hdrs[] = 'Cookie: ' . $cookie;
        if ($from !== '') $hdrs[] = 'Referer: ' . $from;
        // 表单/接口请求的 Origin 要指向目标站,否则站点的 CSRF 校验会拒(浏览器侧发来的 Origin 是 null)
        if ($method !== 'GET' && $method !== 'HEAD') {
            $p = @parse_url($cur);
            if ($p && !empty($p['host'])) $hdrs[] = 'Origin: ' . strtolower((string) $p['scheme']) . '://' . $p['host'] . (isset($p['port']) ? ':' . (int) $p['port'] : '');
        }
        if ($reqCtype !== '') $hdrs[] = 'Content-Type: ' . preg_replace('/[\r\n]+/', '', $reqCtype);
        if ($range !== '') $hdrs[] = 'Range: ' . preg_replace('/[\r\n]+/', '', $range);
        $optsCurl = array(
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $hdrs,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false,   // 自己逐跳走,每一跳都要过闸门
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => max(5, (int) ceil($timeoutMs / 1000)),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_RESOLVE => array($guard['resolve']),
            CURLOPT_ENCODING => '',   // 自己声明可接受压缩并由 curl 自动解码
        );
        $ca = tc_cacert_path();
        if ($ca) $optsCurl[CURLOPT_CAINFO] = $ca;
        if ($body !== null) $optsCurl[CURLOPT_POSTFIELDS] = $body;
        curl_setopt_array($ch, $optsCurl);
        $buf = '';
        $tooBig = false;
        $ctype = '';
        $setCookies = array();
        $location = '';
        $contentRange = '';
        $status = 0;
        curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$ctype, &$setCookies, &$location, &$status, &$contentRange) {
            $trim = trim($line);
            if (preg_match('#^HTTP/\d(?:\.\d)?\s+(\d{3})#', $trim, $m)) { $status = (int) $m[1]; return strlen($line); }
            $eq = strpos($trim, ':');
            if ($eq === false) return strlen($line);
            $k = strtolower(trim(substr($trim, 0, $eq)));
            $v = trim(substr($trim, $eq + 1));
            if ($k === 'content-type') $ctype = $v;
            elseif ($k === 'location') $location = $v;
            elseif ($k === 'set-cookie') $setCookies[] = $v;
            elseif ($k === 'content-range') $contentRange = $v;
            return strlen($line);
        });
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$buf, &$tooBig, $maxBytes) {
            if (strlen($buf) + strlen($data) > $maxBytes) { $tooBig = true; return 0; }
            $buf .= $data;
            return strlen($data);
        });
        @curl_exec($ch);
        $status = $status ?: (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $eff = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $errno = curl_errno($ch);
        $err = curl_error($ch);
        curl_close($ch);
        if ($setCookies) tc_web_jar_store($userId, $cur, $setCookies);
        if ($tooBig) return array('ok' => false, 'error' => '目标内容超过单次抓取上限', 'code' => 413);
        // 只在「已经拿到有效响应」时才把 errno 当失败:写回调返回 0 主动中断也会置错误码
        if ($status === 0) return array('ok' => false, 'error' => '无法连接目标站点(' . ($err !== '' ? $err : '网络错误 ' . $errno) . ')', 'code' => 502);
        if ($status >= 300 && $status < 400 && $location !== '' && $hop < TC_WEB_MAX_HOPS) {
            $next = tc_web_abs($location, $eff !== '' ? $eff : $cur);
            if ($next === '' || !preg_match('#^https?://#i', $next)) return array('ok' => false, 'error' => '目标站点返回了非法跳转地址', 'code' => 502);
            $from = $eff !== '' ? $eff : $cur;
            $cur = $next;
            // 307/308 要求保持方法与请求体;其余跳转按浏览器惯例转 GET(表单不再重发)
            if ($status !== 307 && $status !== 308) {
                $method = 'GET';
                $body = null;
                $reqCtype = '';
            }
            continue;
        }
        return array('ok' => true, 'status' => $status, 'body' => $buf, 'ctype' => $ctype, 'url' => $eff !== '' ? $eff : $cur, 'range' => $contentRange);
    }
    return array('ok' => false, 'error' => '目标站点跳转次数过多', 'code' => 508);
}

// ============ HTML 改写 ============

function tc_web_shim_js() {
    static $js = null;
    if ($js !== null) return $js;
    $js = '';
    foreach (array('/static/js/web-shim.min.js', '/static/js/web-shim.js') as $f) {
        $p = TC_ROOT . $f;
        if (is_file($p) && is_readable($p)) { $js = (string) file_get_contents($p); break; }
    }
    return $js;
}

function tc_web_inject($html, $payload) {
    if (preg_match('#<head\b[^>]*>#i', $html, $m, PREG_OFFSET_CAPTURE)) {
        $at = $m[0][1] + strlen($m[0][0]);
        return substr($html, 0, $at) . $payload . substr($html, $at);
    }
    if (preg_match('#<html\b[^>]*>#i', $html, $m, PREG_OFFSET_CAPTURE)) {
        $at = $m[0][1] + strlen($m[0][0]);
        return substr($html, 0, $at) . $payload . substr($html, $at);
    }
    return $payload . $html;
}

/**
 * 改写某一类属性的取值,统一支持 "值" / '值' / 裸值 三种写法。
 * 裸值必须支持:minified 页面普遍写成 <script src=/s.js>(实测 example.com 就是),
 * 只认带引号的写法会整页漏改写。统一按双引号输出(代理地址里不含空格/引号/尖括号)。
 * $transform 缺省时按 $kind 走 tc_web_proxify;给了就交给它(用于 srcset / style)。
 */
function tc_web_rewrite_attr($html, $prefixRe, $base, $ticket, $kind = 'res', $transform = null) {
    $re = '#(' . $prefixRe . '\s*=\s*)("([^"]*)"|\'([^\']*)\'|([^\s>"\']+))#is';
    return preg_replace_callback($re, function ($m) use ($base, $ticket, $kind, $transform) {
        // 尾部分组在未参与匹配时会被 PHP 省略,只能从后往前取
        $inner = isset($m[5]) ? $m[5] : (isset($m[4]) ? $m[4] : (isset($m[3]) ? $m[3] : ''));
        $new = $transform !== null
            ? call_user_func($transform, $inner, $base, $ticket)
            : tc_web_proxify($inner, $base, $ticket, $kind);
        return $m[1] . '"' . htmlspecialchars((string) $new, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"';
    }, $html);
}

/**
 * 改写页面:
 *  - 摘掉目标站自己的 CSP meta / integrity(SRI 会因为我们改过内容而拒绝执行)/ base(相对基准由我们掌控)
 *  - href/src/action/srcset/style/... 全部指向代理;CSS 的 url() 同理
 *  - 注入 shim:补上运行时才产生的地址(JS 里 new URL / fetch / pushState 等)
 * 注意:内联与外链 JS 的**源码**这里不改写(那需要 JS 解析器),交给 shim 在运行时拦截。
 */
function tc_web_rewrite_html($html, $base, $ticket, $converted) {
    $html = (string) $html;
    // 目标站的 CSP 会把注入的 shim 与改写后的资源全挡掉,必须摘掉;安全由 iframe sandbox 保证
    $html = preg_replace('#<meta[^>]+http-equiv\s*=\s*(["\']?)content-security-policy\1[^>]*>#is', '', $html);
    $html = preg_replace('#<base\b[^>]*>#is', '', $html);
    // SRI 摘要针对原始字节,改写后必然不匹配(浏览器会拒绝加载脚本/样式)
    $html = preg_replace('#\s(?:integrity|nonce)\s*=\s*(["\'])(?:(?!\1).)*\1#is', '', $html);
    $html = preg_replace('#\scrossorigin(\s*=\s*(["\'])(?:(?!\2).)*\2)?#is', '', $html);
    if ($converted) {
        $html = preg_replace('#(<meta[^>]+charset\s*=\s*["\']?)[A-Za-z0-9_\-]+#i', '${1}utf-8', $html);
        $html = preg_replace('#(charset=)[A-Za-z0-9_\-]+#i', '${1}utf-8', $html);
    }
    // 导航类属性先处理:同一个属性在不同标签上含义不同 —— <a href> / <form action> / <iframe src>
    // 是「换文档」,要走 page 端点(只有它做功能开关与用户校验);其余资源走 res。
    // 先跑针对性替换,后面的通用替换看到已是代理地址会原样跳过(见 tc_web_proxify)。
    foreach (array('<a\b[^>]*?\shref', '<area\b[^>]*?\shref', '<form\b[^>]*?\saction', '<iframe\b[^>]*?\ssrc') as $navPrefix) {
        $html = tc_web_rewrite_attr($html, $navPrefix, $base, $ticket, 'page');
    }
    // 普通属性(资源)
    $html = tc_web_rewrite_attr(
        $html,
        '\s(?:href|src|action|poster|formaction|background|cite|manifest|longdesc|data-src|data-original|data-lazy-src|data-url|data-href)',
        $base,
        $ticket,
        'res'
    );
    // srcset 是「地址 + 描述符」列表,不能整串当 URL 处理
    $html = tc_web_rewrite_attr($html, '\s(?:srcset|data-srcset|imagesrcset)', $base, $ticket, 'res', function ($v, $b, $t) {
        return tc_web_rewrite_srcset($v, $b, $t);
    });
    // 内联 style 属性与 <style> 块里的 url()
    $html = tc_web_rewrite_attr($html, '\sstyle', $base, $ticket, 'res', function ($v, $b, $t) {
        return tc_web_rewrite_css_urls($v, $b, $t);
    });
    $html = preg_replace_callback('#(<style\b[^>]*>)(.*?)(</style>)#is', function ($m) use ($base, $ticket) {
        return $m[1] . tc_web_rewrite_css_urls($m[2], $base, $ticket) . $m[3];
    }, $html);
    // meta refresh 跳转(改写后的地址要转义一次写回属性)
    $html = preg_replace_callback('#(<meta[^>]+http-equiv\s*=\s*(["\']?)refresh\2[^>]*content\s*=\s*(["\'])(?:(?!\3).)*\3[^>]*>)#is', function ($m) use ($base, $ticket) {
        return preg_replace_callback('#(url\s*=\s*)([^"\';]+)#i', function ($mm) use ($base, $ticket) {
            return $mm[1] . htmlspecialchars(tc_web_proxify($mm[2], $base, $ticket, 'page'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        }, $m[1]);
    }, $html);
    return $html;
}

// shim 配置与代码一起注入。配置用 JSON_HEX_TAG 等转义,避免页面内容拼出 </script> 提前收尾。
function tc_web_shim_payload($base, $ticket, $cookies) {
    $cfg = array('o' => $base, 't' => $ticket, 'p' => '/api/web/page', 'r' => '/api/web/res', 'ck' => $cookies);
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
    if (defined('JSON_HEX_TAG')) $flags |= JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
    $json = json_encode($cfg, $flags);
    if (!is_string($json)) $json = '{}';
    $shim = tc_web_shim_js();
    $out = '<script>window.__OCW=' . $json . ';</script>';
    if ($shim !== '') $out .= '<script>' . $shim . '</script>';
    return $out;
}

// ============ 服务代理响应 ============

// 从代理地址里反推「原始页面地址」,用来给下游资源带正确的 Referer
// (图片/字体常做防盗链,Referer 是本站地址会被拒)。
function tc_web_referer_of($ref) {
    $ref = (string) $ref;
    $q = @parse_url($ref, PHP_URL_QUERY);
    if (!$q) return '';
    $params = array();
    parse_str($q, $params);
    if (empty($params['u'])) return '';
    $u = tc_web_b64d($params['u']);
    return preg_match('#^https?://#i', (string) $u) ? $u : '';
}

function tc_web_fail_page($msg) {
    $m = htmlspecialchars((string) $msg, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1"><title>无法打开该网页</title>'
        . '<style>body{margin:0;background:#0f172a;color:#e2e8f0;font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}'
        . '.w{max-width:560px;margin:0 auto;padding:20vh 24px}h1{font-size:17px;margin:0 0 10px}p{color:#94a3b8;margin:0 0 8px}</style></head>'
        . '<body><div class="w"><h1>无法打开该网页</h1><p>' . $m . '</p>'
        . '<p>可能是目标站点拒绝了来自服务器出口 IP 的访问,或该地址无法解析。</p></div></body></html>';
}

// GET/POST /api/web/page 与 GET /api/web/res 的共同实现
function tc_web_serve($kind) {
    $q = tc_query();
    $ticket = isset($q['t']) ? (string) $q['t'] : '';
    $uid = tc_web_ticket_uid($ticket);
    if ($uid === '') {
        http_response_code(403);
        header('Content-Type: ' . ($kind === 'page' ? 'text/html' : 'text/plain') . '; charset=utf-8');
        header('Cache-Control: no-store');
        echo $kind === 'page' ? tc_web_fail_page('访问票据无效或已过期,请关闭后重新打开在线浏览器。') : '票据无效';
        exit;
    }
    if (!tc_rate_limit_check('web:' . $uid, 600) || !tc_rate_limit_check('webip:' . tc_client_ip(), 1200)) {
        http_response_code(429);
        header('Content-Type: text/plain; charset=utf-8');
        echo '访问过于频繁,请稍后再试';
        exit;
    }
    $url = tc_web_b64d(isset($q['u']) ? (string) $q['u'] : '');
    if ($url === '' || !preg_match('#^https?://#i', $url)) {
        http_response_code(400);
        header('Content-Type: text/plain; charset=utf-8');
        echo '地址无效';
        exit;
    }
    // 文档请求才查库确认「用户还在、功能还开着」;子资源一次页面加载有几十上百个,
    // 每次都读一遍 JSON 库不划算(票据本身已有时效与签名)。
    if ($kind === 'page') {
        $allowed = false;
        try {
            tc_with_db(false, function ($db) use ($uid, &$allowed) {
                if (!empty($db['settings']['browserEnabled'])) {
                    foreach ($db['users'] as $u) {
                        if ((string) $u['id'] === $uid) { $allowed = true; break; }
                    }
                }
            });
        } catch (Throwable $e) {
            $allowed = false;
        }
        if (!$allowed) {
            http_response_code(403);
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: no-store');
            echo tc_web_fail_page('在线浏览器已关闭或账号已失效。');
            exit;
        }
    }
    $method = strtoupper((string) (isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET'));
    $body = null;
    $reqCtype = '';
    if ($method === 'POST') {
        $raw = (string) @file_get_contents('php://input', false, null, 0, TC_WEB_MAX_POST);
        $body = $raw;
        $reqCtype = isset($_SERVER['CONTENT_TYPE']) ? (string) $_SERVER['CONTENT_TYPE'] : 'application/x-www-form-urlencoded';
    }
    $res = tc_web_fetch($url, $uid, array(
        'method' => $method,
        'body' => $body,
        'ctype' => $reqCtype,
        'cookie' => isset($q['c']) ? (string) $q['c'] : '',
        'referer' => tc_web_referer_of(isset($_SERVER['HTTP_REFERER']) ? $_SERVER['HTTP_REFERER'] : ''),
        'accept' => isset($_SERVER['HTTP_ACCEPT']) ? (string) $_SERVER['HTTP_ACCEPT'] : '',
        'range' => isset($_SERVER['HTTP_RANGE']) ? (string) $_SERVER['HTTP_RANGE'] : '',
    ));
    if (empty($res['ok'])) {
        http_response_code((int) (isset($res['code']) ? $res['code'] : 502));
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Frame-Options: SAMEORIGIN');
        echo tc_web_fail_page(isset($res['error']) ? $res['error'] : '抓取失败');
        exit;
    }
    $ctype = strtolower((string) $res['ctype']);
    $base = (string) $res['url'];
    $isHtml = strpos($ctype, 'text/html') !== false || strpos($ctype, 'application/xhtml') !== false || ($kind === 'page' && $ctype === '');
    $isCss = strpos($ctype, 'text/css') !== false;
    // 只回我们自己的响应头:上游的 CSP / X-Frame-Options / Set-Cookie / 编码头一律不透传。
    // 代理响应绝不缓存:同一地址对不同用户带着不同的 cookie jar,被中间缓存住就是串号。
    header('Cache-Control: no-store, must-revalidate');
    header('X-Robots-Tag: noindex, nofollow');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: SAMEORIGIN');
    // 安全由 iframe sandbox(不透明源)承担,页面内部的 CSP 只负责别把自己弄残:
    // 目标站的资源域名不可枚举,这里放开;frame-ancestors 限定只允许本站页面嵌它。
    header("Content-Security-Policy: default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'");
    if ($isHtml) {
        $charset = tc_web_charset($res['body'], $res['ctype']);
        $converted = ($charset !== '' && $charset !== 'utf-8' && $charset !== 'utf8');
        $html = $converted ? tc_web_to_utf8($res['body'], $charset) : $res['body'];
        $html = tc_web_rewrite_html($html, $base, $ticket, $converted);
        $html = tc_web_inject($html, tc_web_shim_payload($base, $ticket, tc_web_jar_snapshot($uid, $base)));
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
        exit;
    }
    if ($isCss) {
        header('Content-Type: text/css; charset=utf-8');
        echo tc_web_rewrite_css_urls($res['body'], $base, $ticket);
        exit;
    }
    // 其余(JS / 图片 / 字体 / JSON / 媒体)原样透传字节;JS 的地址改写交给 shim 运行时处理。
    // 206 部分响应(音视频拖动)保留 Content-Range,否则播放器会认为源不支持 seek。
    $outCtype = $ctype !== '' ? preg_replace('/[\r\n]+/', '', (string) $res['ctype']) : 'application/octet-stream';
    header('Content-Type: ' . $outCtype);
    if (!empty($res['range'])) header('Content-Range: ' . preg_replace('/[\r\n]+/', '', (string) $res['range']));
    else header('Accept-Ranges: bytes');
    http_response_code((int) $res['status'] >= 200 && (int) $res['status'] < 600 ? (int) $res['status'] : 200);
    echo $res['body'];
    exit;
}

function tc_api_web_page() { tc_web_serve('page'); }
function tc_api_web_res() { tc_web_serve('res'); }

// ============ 接口:票据 / 收藏夹 / 正文 ============

// POST /api/web/ticket — 发一张短期代理票据(需要登录态 Bearer)
function tc_api_web_ticket() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        if (!tc_rate_limit_check('webticket:' . $user['id'], 60)) tc_fail(429, '请求过于频繁，请稍后再试');
        $uid = (string) $user['id'];
        tc_json(200, array(
            'ticket' => tc_web_ticket_make($uid),
            'exp' => tc_now() + TC_WEB_TICKET_TTL,
            'bookmarks' => tc_web_bookmarks_of($db),
            'dailyLimit' => tc_web_ai_limit($db),
            'dailyUsed' => tc_web_ai_used_today($uid),
        ));
    });
}

// GET /api/web/bookmarks — 用户自己的收藏(未保存过返回空数组,由前端用内置默认)
function tc_api_web_bookmarks_get() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        tc_json(200, array('bookmarks' => tc_web_user_bookmarks($user['id'])));
    });
}

// POST /api/web/bookmarks {bookmarks:[{name,url}]} — 覆盖保存(逐项清洗,上限 200 条)
function tc_api_web_bookmarks_save() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        if (!tc_rate_limit_check('webmark:' . $user['id'], 30)) tc_fail(429, '保存过于频繁，请稍后再试');
        $b = tc_read_json_body(262144);
        $list = isset($b['bookmarks']) && is_array($b['bookmarks']) ? $b['bookmarks'] : array();
        $out = array();
        foreach ($list as $item) {
            if (!is_array($item)) continue;
            $name = trim((string) (isset($item['name']) ? $item['name'] : ''));
            $u = trim((string) (isset($item['url']) ? $item['url'] : ''));
            if ($name === '' || $u === '') continue;
            if (!preg_match('#^https?://#i', $u)) $u = 'https://' . ltrim($u, '/');
            if (!preg_match('#^https?://#i', $u)) continue;
            $out[] = array('name' => tc_utf_cut($name, 40), 'url' => tc_utf_cut($u, 500));
            if (count($out) >= 200) break;
        }
        tc_web_user_bookmarks_save($user['id'], $out);
        tc_json(200, array('ok' => true, 'bookmarks' => $out));
    });
}

function tc_web_user_bookmarks_path($userId) {
    return tc_web_user_dir($userId) . '/bookmarks.json';
}

function tc_web_user_bookmarks($userId) {
    $j = json_decode((string) @file_get_contents(tc_web_user_bookmarks_path($userId)), true);
    if (!is_array($j)) return array();
    $out = array();
    foreach ($j as $b) {
        if (!is_array($b)) continue;
        $out[] = array('name' => (string) (isset($b['name']) ? $b['name'] : ''), 'url' => (string) (isset($b['url']) ? $b['url'] : ''));
    }
    return $out;
}

function tc_web_user_bookmarks_save($userId, $list) {
    $dir = tc_web_user_dir($userId);
    if (!is_dir($dir)) return;
    @file_put_contents(tc_web_user_bookmarks_path($userId), tc_json_encode(array_values($list)), LOCK_EX);
}

// GET /api/web/read?u=&t= — 抽取正文(阅读模式 + AI 总结的服务端取数)
function tc_api_web_read() {
    $q = tc_query();
    $uid = tc_web_ticket_uid(isset($q['t']) ? (string) $q['t'] : '');
    if ($uid === '') tc_fail(403, '访问票据无效或已过期，请重新打开在线浏览器');
    if (!tc_rate_limit_check('webread:' . $uid, 120)) tc_fail(429, '请求过于频繁，请稍后再试');
    $url = tc_web_b64d(isset($q['u']) ? (string) $q['u'] : '');
    if ($url === '') tc_fail(400, '地址无效');
    $page = tc_web_extract($url, $uid);
    if (empty($page['ok'])) tc_fail((int) (isset($page['code']) ? $page['code'] : 502), isset($page['error']) ? $page['error'] : '读取失败');
    tc_json(200, array('url' => $page['url'], 'title' => $page['title'], 'text' => $page['text'], 'truncated' => !empty($page['truncated'])));
}

// 抓取 + 抽正文。标题优先 <title>,正文复用全站同一套 tc_html_to_text。
function tc_web_extract($url, $uid) {
    $res = tc_web_fetch($url, $uid, array());
    if (empty($res['ok'])) return $res;
    $charset = tc_web_charset($res['body'], $res['ctype']);
    $html = ($charset !== '' && $charset !== 'utf-8' && $charset !== 'utf8') ? tc_web_to_utf8($res['body'], $charset) : $res['body'];
    $title = '';
    if (preg_match('#<title[^>]*>(.*?)</title>#is', $html, $m)) {
        $title = trim(preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    }
    $text = tc_html_to_text($html);
    $truncated = false;
    if (function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') > TC_WEB_TEXT_MAX : strlen($text) > TC_WEB_TEXT_MAX) {
        $text = tc_utf_cut($text, TC_WEB_TEXT_MAX);
        $truncated = true;
    }
    return array('ok' => true, 'url' => (string) $res['url'], 'title' => tc_utf_cut($title, TC_WEB_TITLE_MAX), 'text' => $text, 'truncated' => $truncated);
}

// ============ AI 总结(与 IM 召唤同一套计费通道:预扣 → 上游 → 结算) ============

function tc_web_ai_usage_path() {
    return tc_data_dir() . '/web-ai-usage.json';
}

function tc_web_ai_limit($db) {
    return (int) (isset($db['settings']['webAiDailyLimit']) ? $db['settings']['webAiDailyLimit'] : 50);
}

function tc_web_ai_used_today($userId) {
    $j = json_decode((string) @file_get_contents(tc_web_ai_usage_path()), true);
    $all = is_array($j) ? $j : array();
    $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
    return (string) (isset($row['date']) ? $row['date'] : '') === date('Y-m-d') ? (int) (isset($row['n']) ? $row['n'] : 0) : 0;
}

// 判上限与计数必须在同一把文件锁内(理由同 tc_im_ai_consume),否则并发下会超发。
function tc_web_ai_consume($db, $userId) {
    $limit = tc_web_ai_limit($db);
    $day = date('Y-m-d');
    $over = false;
    tc_json_mutate(tc_web_ai_usage_path(), function ($all) use ($userId, $day, $limit, &$over) {
        $all = is_array($all) ? $all : array();
        $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
        $n = ((string) (isset($row['date']) ? $row['date'] : '') === $day) ? (int) (isset($row['n']) ? $row['n'] : 0) : 0;
        if ($limit > 0 && $n >= $limit) { $over = true; return null; }
        foreach ($all as $k => $v) {
            if (!is_array($v) || (string) (isset($v['date']) ? $v['date'] : '') !== $day) unset($all[$k]);
        }
        $all[$userId] = array('date' => $day, 'n' => $n + 1);
        return $all;
    }, array());
    return !$over;
}

function tc_web_ai_refund($userId) {
    $day = date('Y-m-d');
    tc_json_mutate(tc_web_ai_usage_path(), function ($all) use ($userId, $day) {
        $all = is_array($all) ? $all : array();
        $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
        if ((string) (isset($row['date']) ? $row['date'] : '') !== $day) return null;
        $row['n'] = max(0, (int) (isset($row['n']) ? $row['n'] : 0) - 1);
        $all[$userId] = $row;
        return $all;
    }, array());
}

function tc_web_usage_of($data, $format) {
    $u = array();
    if (is_array($data) && isset($data['usage']) && is_array($data['usage'])) $u = $data['usage'];
    if ($format === 'anthropic' && is_array($data) && isset($data['message']['usage']) && is_array($data['message']['usage'])) $u = $data['message']['usage'];
    $p = 0;
    $c = 0;
    foreach (array('prompt_tokens', 'input_tokens', 'prompt') as $k) {
        if (isset($u[$k])) { $p = (int) $u[$k]; break; }
    }
    foreach (array('completion_tokens', 'output_tokens', 'completion') as $k) {
        if (isset($u[$k])) { $c = (int) $u[$k]; break; }
    }
    return array('prompt' => $p, 'completion' => $c);
}

// 按供应商格式组装请求:system 提示 + 网页正文 + 本次要求
function tc_web_ai_build_body($plan, $format) {
    $sys = '你是浏览器里的阅读助手。用户正在浏览一个网页,请依据下面给出的网页内容作答。'
        . '要求:使用与用户提问相同的语言;先给结论,再列要点(Markdown 列表);'
        . '只依据网页内容,不要编造网页里没有的信息;若网页内容不足以回答,就直接说明不足。';
    $user = '网页地址:' . (string) $plan['url'] . "\n";
    if (!empty($plan['title'])) $user .= '网页标题:' . (string) $plan['title'] . "\n";
    $user .= "\n===== 网页内容开始 =====\n" . (string) $plan['text'] . "\n===== 网页内容结束 =====\n\n";
    $q = trim((string) (isset($plan['question']) ? $plan['question'] : ''));
    $user .= '用户要求:' . ($q !== '' ? $q : '请总结这个网页的主要内容与关键信息。');
    $body = array('model' => (string) $plan['model'], 'stream' => false);
    if ($format === 'anthropic') {
        $body['system'] = $sys;
        $body['max_tokens'] = 2048;
        $body['messages'] = array(array('role' => 'user', 'content' => $user));
    } elseif ($format === 'responses') {
        $body['max_output_tokens'] = 2048;
        $body['input'] = $sys . "\n\n" . $user;
    } elseif ($format === 'completions') {
        $body['max_tokens'] = 2048;
        $body['prompt'] = $sys . "\n\n" . $user;
    } else {
        $body['max_tokens'] = 2048;
        $body['messages'] = array(
            array('role' => 'system', 'content' => $sys),
            array('role' => 'user', 'content' => $user),
        );
    }
    return $body;
}

// POST /api/web/summary {url, text?, title?, question?, model?, providerId?}
// text 由前端从被代理页面里取出(沙箱内 shim 抓的 innerText)时优先用它 —— 那样才能总结
// 到 JS 渲染出来的内容;没带就服务端重新抓一份。
// 分三段:只读事务校验参数 → 事务外抓网页(网络请求不占写锁) → 写事务扣次数/预扣额度 → 调上游 → 结算。
function tc_api_web_summary() {
    $uid = '';
    $body = array();
    tc_with_db(false, function ($db) use (&$uid, &$body) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        $uid = (string) $user['id'];
        if (!tc_rate_limit_check('websum:' . $uid, 20)) tc_fail(429, '总结过于频繁，请稍后再试');
        $b = tc_read_json_body(1024 * 1024);
        $body['question'] = tc_utf_cut(trim((string) (isset($b['question']) ? $b['question'] : '')), 2000);
        $body['model'] = tc_utf_cut(trim((string) (isset($b['model']) ? $b['model'] : '')), 120);
        $body['providerId'] = (string) (isset($b['providerId']) ? $b['providerId'] : '');
        $body['url'] = tc_utf_cut(trim((string) (isset($b['url']) ? $b['url'] : '')), 2000);
        $body['text'] = tc_utf_cut(trim((string) (isset($b['text']) ? $b['text'] : '')), TC_WEB_TEXT_MAX);
        $body['title'] = tc_utf_cut(trim((string) (isset($b['title']) ? $b['title'] : '')), TC_WEB_TITLE_MAX);
        if ($body['url'] === '' && $body['text'] === '') tc_fail(400, '请先打开一个网页再让 AI 总结');
    });
    // 前端没带正文(例如 JS 站点拿不到 innerText):服务端自己抓一份
    if ($body['text'] === '') {
        $page = tc_web_extract($body['url'], $uid);
        if (empty($page['ok'])) tc_fail((int) (isset($page['code']) ? $page['code'] : 502), isset($page['error']) ? $page['error'] : '读取网页失败');
        $body['text'] = $page['text'];
        if ($body['title'] === '') $body['title'] = $page['title'];
        if ($body['text'] === '') tc_fail(422, '这个网页没有可读正文（可能是需要登录或完全由脚本渲染），可以改用「阅读模式」或在页面上选中文字后总结');
    }
    $plan = null;
    $err = '';
    tc_with_db(true, function (&$db) use (&$plan, &$err, $body) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        if (!tc_web_ai_consume($db, $user['id'])) {
            $err = '今日网页总结次数已用完（上限 ' . tc_web_ai_limit($db) . ' 次），管理员可在后台调整';
            return;
        }
        $resolved = tc_resolve_provider($db, $user, array('providerId' => $body['providerId'], 'model' => $body['model']));
        if (!empty($resolved['error'])) { tc_web_ai_refund($user['id']); $err = $resolved['error']; return; }
        $provider = $resolved['provider'];
        $model = $body['model'];
        if ($model === '') $model = (string) (isset($provider['models'][0]['id']) ? $provider['models'][0]['id'] : '');
        if ($model === '') { tc_web_ai_refund($user['id']); $err = '该供应商没有可用模型'; return; }
        $baseCost = tc_model_cost($provider, $model);
        $free = isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id'];
        if ($free) $baseCost = 0;
        if (!tc_quota_reserve($db, $user['id'], $baseCost)) { tc_web_ai_refund($user['id']); $err = '剩余额度不足，无法总结'; return; }
        $reserved = 0.0;
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === (string) $user['id']) { $reserved = isset($u['_quotaReserved']) ? (float) $u['_quotaReserved'] : 0.0; break; }
        }
        $plan = array(
            'uid' => (string) $user['id'], 'url' => $body['url'], 'title' => $body['title'],
            'text' => $body['text'], 'question' => $body['question'],
            'provider' => $provider, 'providerFull' => $resolved['providerFull'], 'model' => $model,
            'baseCost' => $baseCost, 'free' => $free, 'reserved' => $reserved,
            'timeout' => (int) (isset($db['settings']['proxyTimeoutMs']) ? $db['settings']['proxyTimeoutMs'] : 30000),
        );
    });
    if ($plan === null) tc_fail(400, $err !== '' ? $err : '无法开始总结');
    $out = tc_web_ai_call($plan);
    if (empty($out['ok'])) tc_fail(502, isset($out['error']) ? $out['error'] : 'AI 暂时无法总结');
    tc_json(200, array('ok' => true, 'text' => $out['text'], 'model' => $plan['model'], 'usage' => $out['usage'], 'cost' => $out['cost']));
}

// 调用上游并结算。任何失败都会退回预扣额度与每日次数,不会让用户白付出。
function tc_web_ai_call($plan) {
    $uid = (string) $plan['uid'];
    $provider = $plan['provider'];
    $format = isset($provider['apiFormat']) && in_array($provider['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true) ? $provider['apiFormat'] : 'chat';
    $apiKey = trim((string) tc_provider_key_for_model($plan['providerFull'], (string) $plan['model']));
    $baseUrl = rtrim(trim((string) (isset($provider['baseUrl']) ? $provider['baseUrl'] : '')), '/');
    if ($apiKey === '' || !preg_match('#^https?://#i', $baseUrl)) {
        tc_web_ai_refund($uid);
        tc_quota_refund_pending();
        return array('ok' => false, 'error' => '供应商配置不完整（缺 Key 或地址）');
    }
    $url = tc_upstream_path($baseUrl, $format);
    if (!tc_upstream_url_is_safe($url)) {
        tc_web_ai_refund($uid);
        tc_quota_refund_pending();
        return array('ok' => false, 'error' => '供应商地址不可用');
    }
    tc_quota_mark_pending($uid, (float) $plan['reserved']);
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($format === 'anthropic') {
        $headers['x-api-key'] = $apiKey;
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $apiKey;
    }
    $timeout = min(180000, max(5000, (int) $plan['timeout']));
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode(tc_web_ai_build_body($plan, $format)), $timeout, false);
    $bad = null;
    if (empty($res['ok'])) $bad = tc_model_test_safe_error(tc_upstream_fail_message($res, (string) (isset($provider['name']) ? $provider['name'] : '')), $apiKey);
    elseif ((int) $res['status'] >= 400) $bad = tc_model_test_safe_error(tc_upstream_error_message($res['body'], (int) $res['status']), $apiKey);
    if ($bad !== null) {
        tc_web_ai_refund($uid);
        tc_quota_refund_pending();
        return array('ok' => false, 'error' => $bad);
    }
    $j = json_decode($res['body'], true);
    $text = tc_utf_cut(trim(tc_model_reply_full($j, $format)), TC_WEB_AI_TEXT_MAX);
    if ($text === '') {
        tc_web_ai_refund($uid);
        tc_quota_refund_pending();
        return array('ok' => false, 'error' => '上游已响应，但没有返回文本');
    }
    $usage = tc_web_usage_of($j, $format);
    $cost = tc_final_cost($provider, (float) $plan['baseCost'], $usage, !empty($plan['free']));
    tc_with_db(true, function (&$db) use ($uid, $cost, $usage, $plan) {
        $charged = tc_quota_settle($db, $uid, $cost, (string) $plan['model'], 'web');
        tc_record_usage_entry($db, $uid, (string) $plan['model'], $charged, (int) $usage['prompt'], (int) $usage['completion']);
        foreach ($db['users'] as $i => $u) {
            if ((string) $u['id'] !== $uid) continue;
            $row = $db['users'][$i];
            tc_charge_user_stats($db, $row, (string) $plan['model'], 'web');
            $db['users'][$i] = $row;
            break;
        }
    });
    tc_quota_clear_pending();
    tc_push_log(array('kind' => 'web-ai', 'userId' => $uid, 'model' => (string) $plan['model'], 'cost' => $cost, 'ok' => true));
    return array('ok' => true, 'text' => $text, 'usage' => $usage, 'cost' => $cost);
}

// GET /api/web/usage — 前端展示「今日剩余次数」
function tc_api_web_usage() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_web_feature_guard($db);
        $uid = (string) $user['id'];
        tc_json(200, array('dailyLimit' => tc_web_ai_limit($db), 'dailyUsed' => tc_web_ai_used_today($uid)));
    });
}
