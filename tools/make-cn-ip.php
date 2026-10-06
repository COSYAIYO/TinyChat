<?php
/**
 * 生成「中国 IP 段」数据文件 data/cn-ip.bin(供在线浏览器的「仅限访问中国 IP 网站」开关使用)。
 *
 *   php tools/make-cn-ip.php <ipv4列表> <ipv6列表> [输出文件]
 *
 * 输入是每行一个 CIDR 的纯文本(可用 17mon/china_ip_list 与 china-operator-ip 的 ip-lists):
 * 只读入、只做数学合并,不负责任何下载 —— 数据来源与许可由发布者自行确认。
 *
 * 输出格式(刻意做成定长二进制 + 二分查找,避免上线时解析几十万行文本):
 *   magic  "TCIP" (4B) | ver 1 (1B) | v4Count (4B BE) | v6Count (4B BE)
 *   v4 段:v4Count 组 (start,end),各 4B 大端,按 start 升序、段间不相邻
 *   v6 段:v6Count 组 (start,end),各 16B 网络序,同样升序不相邻
 * 查找时对 4B/16B 定长串做 strcmp 即为无符号字节序比较,128 位地址无需拆高低位。
 */
if (PHP_SAPI !== 'cli') exit(1);
if ($argc < 3) {
    fwrite(STDERR, "用法: php tools/make-cn-ip.php <ipv4.txt> <ipv6.txt> [out.bin]\n");
    exit(2);
}
$out = isset($argv[3]) ? $argv[3] : dirname(__DIR__) . '/data/cn-ip.bin';

function read_lines($file)
{
    $rows = array();
    foreach ((array) @file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim((string) $line);
        if ($line === '' || $line[0] === '#') continue;
        $rows[] = $line;
    }
    return $rows;
}

// CIDR → [start, end](end 含);返回定长二进制串
function cidr_range($cidr)
{
    $parts = explode('/', $cidr, 2);
    if (count($parts) !== 2) return null;
    $ip = $parts[0];
    $bits = (int) $parts[1];
    $packed = @inet_pton($ip);
    if ($packed === false) return null;
    $len = strlen($packed);              // 4 或 16
    if ($bits < 0 || $bits > $len * 8) return null;
    $start = $packed;
    $end = $packed;
    // 把 host 位清零(起点)、置一(终点)
    for ($byte = 0; $byte < $len; $byte++) {
        $bitStart = $byte * 8;
        $keep = max(0, min(8, $bits - $bitStart));      // 本字节保留多少位
        $mask = $keep === 0 ? 0 : (0xFF << (8 - $keep)) & 0xFF;
        $start[$byte] = chr(ord($start[$byte]) & $mask);
        $end[$byte] = chr(ord($end[$byte]) | (~$mask & 0xFF));
    }
    return array($start, $end);
}

// 合并重叠/相邻段(strcmp 对定长串就是无符号比较)
function merge_ranges($ranges)
{
    usort($ranges, function ($a, $b) { return strcmp($a[0], $b[0]); });
    $out = array();
    foreach ($ranges as $r) {
        $n = count($out);
        if ($n > 0 && strcmp($r[0], $out[$n - 1][1]) <= 0) {
            if (strcmp($r[1], $out[$n - 1][1]) > 0) $out[$n - 1][1] = $r[1];
            continue;
        }
        $out[] = array($r[0], $r[1]);
    }
    return $out;
}

$v4 = array();
foreach (read_lines($argv[1]) as $cidr) {
    $r = cidr_range($cidr);
    if ($r && strlen($r[0]) === 4) $v4[] = $r;
}
$v6 = array();
foreach (read_lines($argv[2]) as $cidr) {
    $r = cidr_range($cidr);
    if ($r && strlen($r[0]) === 16) $v6[] = $r;
}
$rawV4 = count($v4);
$rawV6 = count($v6);
$v4 = merge_ranges($v4);
$v6 = merge_ranges($v6);
if (!$v4 && !$v6) {
    fwrite(STDERR, "没有解析到任何网段,未写出文件\n");
    exit(1);
}

$bin = 'TCIP' . chr(1) . pack('N', count($v4)) . pack('N', count($v6));
foreach ($v4 as $r) $bin .= $r[0] . $r[1];
foreach ($v6 as $r) $bin .= $r[0] . $r[1];
if (@file_put_contents($out, $bin) === false) {
    fwrite(STDERR, "写入失败: $out\n");
    exit(1);
}
printf("已写出 %s:v4 %d 段(原始 %d)、v6 %d 段(原始 %d),共 %.1f KB\n",
    $out, count($v4), $rawV4, count($v6), $rawV6, strlen($bin) / 1024);
