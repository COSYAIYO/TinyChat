<?php
/**
 * 中国 IP 段判定(在线浏览器的「仅限访问中国 IP 网站」开关用)。
 *
 * 数据来自 lib/cn-ip.bin(由 tools/make-cn-ip.php 生成):定长的 IPv4/IPv6 网段表,
 * 按区间起点升序排列、段间不相邻。查找用二分,且**只比对 16 字节定长串**——
 * 对定长二进制串来说 strcmp 的顺序就是无符号字节序,128 位地址因此不必拆高低位比较。
 *
 * 全部为纯函数,不发起网络请求;tests/cn-ip.php 直接回归。
 */

// 判定结果与文件读取结果分开缓存:同一请求里一个页面几十个子资源各判一次,
// 不能每次重读文件或重跑二分。
function tc_cn_ip_table($reload = false)
{
    static $table = null;
    if ($table !== null && !$reload) return $table;
    $file = __DIR__ . '/cn-ip.bin';
    $raw = @file_get_contents($file);
    if (!is_string($raw) || strlen($raw) < 13 || substr($raw, 0, 4) !== 'TCIP') return $table = array();
    $v4 = unpack('N', substr($raw, 5, 4));
    $v6 = unpack('N', substr($raw, 9, 4));
    $n4 = (int) $v4[1];
    $n6 = (int) $v6[1];
    $want = 13 + $n4 * 8 + $n6 * 32;
    if (strlen($raw) !== $want) return $table = array();   // 截断/写坏的文件按「无数据」处理
    return $table = array(
        'v4' => $n4 > 0 ? substr($raw, 13, $n4 * 8) : '',
        'v6' => $n6 > 0 ? substr($raw, 13 + $n4 * 8, $n6 * 32) : '',
        'n4' => $n4,
        'n6' => $n6,
    );
}

function tc_cn_ip_available()
{
    $t = tc_cn_ip_table();
    return !empty($t['n4']) || !empty($t['n6']);
}

// 在定长段表里二分:命中返回 true
function tc_cn_ip_in_table($packed, $blob, $count)
{
    if ($count <= 0 || $packed === false || $packed === null) return false;
    $len = strlen($packed);                 // 4 或 16
    if ($len !== 4 && $len !== 16) return false;
    $lo = 0;
    $hi = $count - 1;
    while ($lo <= $hi) {
        $mid = ($lo + $hi) >> 1;
        $off = $mid * $len * 2;
        $start = substr($blob, $off, $len);
        $end = substr($blob, $off + $len, $len);
        if (strcmp($packed, $start) < 0) { $hi = $mid - 1; continue; }
        if (strcmp($packed, $end) > 0) { $lo = $mid + 1; continue; }
        return true;
    }
    return false;
}

// IP 是否属于中国网段。$ip 可以是 IPv4/IPv6 字面量;解析不了返回 false。
function tc_cn_ip_contains($ip)
{
    $ip = trim((string) $ip);
    if ($ip === '') return false;
    $ip = preg_replace('/%.*$/', '', $ip);       // IPv6 作用域后缀
    $packed = @inet_pton($ip);
    if ($packed === false) return false;
    $t = tc_cn_ip_table();
    if (strlen($packed) === 4) return tc_cn_ip_in_table($packed, $t['v4'], $t['n4']);
    return tc_cn_ip_in_table($packed, $t['v6'], $t['n6']);
}

// 一个地址可能解析出多个 A/AAAA 记录。只要**任一**记录落在中国网段就判为国内站:
// 国内大站常见「国内 CDN + 海外节点」的混合解析,按「全部都在国内」会误伤,
// 而按「有一个在国内」放行,才符合「允许访问中国网站」这个开关的字面意图。
function tc_cn_ips_any($ips)
{
    if (!is_array($ips)) return false;
    foreach ($ips as $ip) {
        if (tc_cn_ip_contains($ip)) return true;
    }
    return false;
}
