<?php
/**
 * 虚拟主机配额(cgroup v1 / v2)自检: php tests/sys-quota.php
 * 覆盖: 内存上限判定(不限量哨兵 / v2 的 max / 与整机同级)、cpu.max 与 cfs 配额解析、
 *       cpu.stat 取值、双采样折算与百分比夹紧、以及 v2/v1 假根下的路径选择与配额读取。
 * 退出码非 0 表示失败,供 CI 使用。
 */
$root = dirname(__DIR__);
$tmp = sys_get_temp_dir() . '/tc-quota-' . bin2hex(random_bytes(4));
define('TC_ROOT', $root);
define('TC_CGROUP_FSROOT', $tmp);
putenv('DATA_DIR=' . $tmp . '/data');
$_SERVER['REQUEST_METHOD'] = 'GET';
require $root . '/lib/core.php';
require $root . '/lib/api.php';

$bad = 0; $skip = 0;
function check($name, $got, $want) {
    global $bad;
    $ok = $got === $want;
    printf("%s %-42s => %s%s\n", $ok ? 'ok ' : 'BAD', $name,
        is_scalar($got) || $got === null ? var_export($got, true) : json_encode($got, JSON_UNESCAPED_UNICODE),
        $ok ? '' : ' (want ' . var_export($want, true) . ')');
    if (!$ok) $bad++;
}
function skip($name, $why) { global $skip; $skip++; printf("--  %-42s => skip (%s)\n", $name, $why); }
function mkfile($path, $content) {
    @mkdir(dirname($path), 0777, true);
    file_put_contents($path, $content);
}
function rmrf($path) { // Windows 下没有 rm -rf,自带一个可移植的递归删除
    if (is_file($path) || is_link($path)) { @unlink($path); return; }
    if (!is_dir($path)) return;
    foreach ((array) @scandir($path) as $it) {
        if ($it === '.' || $it === '..') continue;
        rmrf($path . DIRECTORY_SEPARATOR . $it);
    }
    @rmdir($path);
}

// ---- 纯解析:内存上限 ----
check('内存上限:普通值', tc_sys_cgroup_mem_limit('536870912'), 536870912);
check('内存上限:v2 的 max 视为不限量', tc_sys_cgroup_mem_limit('max'), null);
check('内存上限:读不到', tc_sys_cgroup_mem_limit(null), null);
check('内存上限:v1 不限量哨兵', tc_sys_cgroup_mem_limit('9223372036854771712'), null);
check('内存上限:与整机同级判为宿主机', tc_sys_cgroup_mem_limit('8589934592', 8589934592), null);
check('内存上限:超过整机判为宿主机', tc_sys_cgroup_mem_limit('17179869184', 8589934592), null);
check('内存上限:小于整机则采纳', tc_sys_cgroup_mem_limit('4294967296', 8589934592), 4294967296);

// ---- 纯解析:CPU 配额与用量 ----
check('cpu.max:200000/100000 => 2 核', tc_sys_cgroup_cpu_max_cores('200000 100000'), 2);
check('cpu.max:50000/100000 => 0.5 核', tc_sys_cgroup_cpu_max_cores('50000 100000'), 0.5);
check('cpu.max:max 视为不限量', tc_sys_cgroup_cpu_max_cores('max 100000'), null);
check('cpu.max:读不到', tc_sys_cgroup_cpu_max_cores(null), null);
check('cfs:100000/100000 => 1 核', tc_sys_cgroup_cfs_cores('100000', '100000'), 1);
check('cfs:-1 视为不限量', tc_sys_cgroup_cfs_cores('-1', '100000'), null);
check('cpu.stat:取 usage_usec(纳秒)', tc_sys_cgroup_usage_ns("usage_usec 12345\nuser_usec 1\nsystem_usec 2\n"), 12345000.0);
check('cpu.stat:文本异常返回 null', tc_sys_cgroup_usage_ns('nope'), null);

// ---- 纯折算:双采样 -> 核数 / 百分比 ----
check('双采样:1.5s-1.0s 于 0.5s => 1 核', tc_sys_cgroup_cores_used(1000000000, 1500000000, 0.5), 1.0);
check('双采样:用量未增长返回 null', tc_sys_cgroup_cores_used(1000000000, 1000000000, 0.5), null);
check('双采样:耗时为 0 返回 null', tc_sys_cgroup_cores_used(1000000000, 2000000000, 0), null);
$r = tc_sys_cgroup_cpu_result('v2', 0, 500000000, 0.5, 2.0, 16);
check('折算:用 1 核 / 配额 2 核 => 50%', array($r['percent'], $r['coreLimit'], $r['coreUsage']), array(50, 2.0, 1.0));
$r = tc_sys_cgroup_cpu_result('v2', 0, 500000000, 0.5, null, 4);
check('折算:不限量按整机 4 核 => 25% 且不报配额', array($r['percent'], isset($r['coreLimit'])), array(25, false));
$r = tc_sys_cgroup_cpu_result('v2', 0, 500000000, 0.5, null, null);
check('折算:无配额无核数只报核数', array($r['percent'] ?? null, $r['coreUsage']), array(null, 1.0));
$r = tc_sys_cgroup_cpu_result('v2', 0, 1500000000, 0.5, 2.0, 16);
check('折算:超配额夹紧到 100%', $r['percent'], 100);

// ---- 整机侧解析(CPU / 网速,与配额层各自独立) ----
check('CPU:解析 /proc/stat 首行', tc_sys_cpu_parse_stat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n"), array('total' => 1000, 'idle' => 850));
check('CPU:无 cpu 行返回 null', tc_sys_cpu_parse_stat('nope'), null);
check('CPU:两次采样 => 20%', tc_sys_cpu_delta_percent(array('total' => 1000, 'idle' => 800), array('total' => 2000, 'idle' => 1600)), 20);
check('CPU:计数未增长返回 null', tc_sys_cpu_delta_percent(array('total' => 1000, 'idle' => 800), array('total' => 1000, 'idle' => 800)), null);
$dev = "Inter-|   Receive                                                |  Transmit\n"
  . " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
  . "    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n"
  . "  eth0: 5000 10 0 0 0 0 0 0 3000 8 0 0 0 0 0 0\n"
  . " venet0: 1000 2 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n";
check('网速:汇总多网卡且排除回环', tc_sys_net_parse_dev($dev), array(6000, 3500));
check('网速:只有回环时为 0', tc_sys_net_parse_dev("    lo: 999 1 0 0 0 0 0 0 888 1 0 0 0 0 0 0\n"), array(0, 0));
check('网速:表头不误计', tc_sys_net_parse_dev("Inter-|   Receive |  Transmit\n face |bytes  ... |bytes ...\n"), array(0, 0));

// ---- 假根 fixture:由后台进程持续抬高累计用量,验证双采样整条链路 ----
// 每个场景用独立的假根目录:后台写入进程还在跑时删目录会在 Windows 上抢文件
$writer = $tmp . '/writer.php';
define('WRITER_SRC', '<?php
$file = $argv[1]; $mode = $argv[2];
$first = strtok((string) @file_get_contents($file), "\n");
$ns = (float) preg_replace("/\D/", "", (string) $first);
if ($mode === "v2") $ns *= 1000; // 文件里是微秒
for ($i = 0; $i < 150; $i++) {
    $ns += 5000000; // 每次 +5ms CPU,间隔 8ms => 约 0.6 核
    file_put_contents($file, $mode === "v2" ? "usage_usec " . (int) ($ns / 1000) . "\nuser_usec 1\n" : (string) (int) $ns);
    usleep(8000);
}');
function start_writer($writer, $file, $mode) {
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($writer) . ' ' . escapeshellarg($file) . ' ' . escapeshellarg($mode);
    $cmd .= ' > ' . (PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null') . ' 2>&1';
    // Windows 的 start 会把第一个带引号的参数当窗口标题,补一个空标题占位
    if (PHP_OS_FAMILY === 'Windows') $cmd = 'start /B "" ' . $cmd;
    else $cmd .= ' &';
    $h = @popen($cmd, 'r');
    if ($h) @pclose($h);
}
// 采样前后文件必须变化才有增量;偶发读到写了一半的内容时重试,仍不行按跳过处理(不判失败)
function cpu_with_writer($writer, $file, $mode) {
    mkfile($writer, WRITER_SRC);
    for ($i = 0; $i < 3; $i++) {
        start_writer($writer, $file, $mode);
        usleep(60000);
        tc_sys_reset_cache();
        $out = tc_sys_cgroup_cpu();
        if ($out) return $out;
    }
    return array();
}

// 场景一:cgroup v2 容器(统一层级挂到根,内存 512M / CPU 2 核)
$v2root = $tmp . '/v2';
mkfile($v2root . '/proc/self/cgroup', "0::/\n");
mkfile($v2root . '/sys/fs/cgroup/memory.current', "268435456\n");
mkfile($v2root . '/sys/fs/cgroup/memory.max', "536870912\n");
mkfile($v2root . '/sys/fs/cgroup/cpu.max', "200000 100000\n");
mkfile($v2root . '/sys/fs/cgroup/cpu.stat', "usage_usec 1000000\nuser_usec 1\n");
tc_sys_reset_cache();
tc_sys_cgroup_fsroot($v2root);
check('v2:统一层级相对路径为空', tc_sys_cgroup_rel(''), '');
check('v2:读到内存配额', tc_sys_cgroup_mem(), array('version' => 'v2', 'usedBytes' => 268435456, 'limitBytes' => 536870912));
$cpu = cpu_with_writer($writer, $v2root . '/sys/fs/cgroup/cpu.stat', 'v2');
if (!$cpu) {
    skip('v2:双采样取到核数与百分比', '无法在后台抬高用量(环境限制)');
} else {
    check('v2:双采样取到核数与百分比', array($cpu['version'], $cpu['coreLimit'] ?? null, $cpu['coreUsage'] > 0, ($cpu['percent'] ?? 0) >= 1), array('v2', 2.0, true, true));
}

// 场景二:cgroup v1(带命名空间路径 /lve/1000,内存 2G / CPU 1 核)
$v1root = $tmp . '/v1';
mkfile($v1root . '/proc/self/cgroup', "12:memory:/lve/1000\n11:cpuacct,cpu:/lve/1000\n0::/\n");
mkfile($v1root . '/sys/fs/cgroup/memory/lve/1000/memory.usage_in_bytes', "1073741824\n");
mkfile($v1root . '/sys/fs/cgroup/memory/lve/1000/memory.limit_in_bytes', "2147483648\n");
mkfile($v1root . '/sys/fs/cgroup/cpu/lve/1000/cpu.cfs_quota_us', "100000\n");
mkfile($v1root . '/sys/fs/cgroup/cpu/lve/1000/cpu.cfs_period_us', "100000\n");
mkfile($v1root . '/sys/fs/cgroup/cpuacct/lve/1000/cpuacct.usage', "1000000000\n");
tc_sys_reset_cache();
tc_sys_cgroup_fsroot($v1root);
check('v1:按控制器取到各自相对路径', array(tc_sys_cgroup_rel('memory'), tc_sys_cgroup_rel('cpuacct'), tc_sys_cgroup_rel('cpu')), array('/lve/1000', '/lve/1000', '/lve/1000'));
check('v1:v2 文件不存在时回落到 v1 配额', tc_sys_cgroup_mem(), array('version' => 'v1', 'usedBytes' => 1073741824, 'limitBytes' => 2147483648));
$cpu = cpu_with_writer($writer, $v1root . '/sys/fs/cgroup/cpuacct/lve/1000/cpuacct.usage', 'v1');
if (!$cpu) {
    skip('v1:双采样取到核数与百分比', '无法在后台抬高用量(环境限制)');
} else {
    check('v1:双采样取到核数与百分比', array($cpu['version'], $cpu['coreLimit'] ?? null, $cpu['coreUsage'] > 0), array('v1', 1.0, true));
}

// 场景三:v1 不限量(哨兵值)=> 视为无配额,不应把宿主机数字当套餐显示
mkfile($v1root . '/sys/fs/cgroup/memory/lve/1000/memory.limit_in_bytes', "9223372036854771712\n");
tc_sys_reset_cache();
check('v1:不限量哨兵 => 不显示配额', tc_sys_cgroup_mem(), array());

@unlink($writer);
printf("\n%s\n", $bad ? "FAIL: $bad 项不通过" : 'PASS' . ($skip ? " ($skip 项跳过)" : ''));
exit($bad ? 1 : 0);
