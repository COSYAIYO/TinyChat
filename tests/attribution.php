<?php
/**
 * 完整性守卫自检: php tests/attribution.php
 * 覆盖: 原始放行 / 改仓库拦截 / 删链接拦截 / 非 GitHub 拦截 / fork 放行 / .git 后缀放行 /
 *       改名前的旧地址放行(仓库由 HCARX 改名为 TinyNano)/ allow_rebrand 放行 / 两层校验点均存在。
 * 退出码非 0 表示失败,供 CI 使用。
 */
$root = dirname(__DIR__);
define('TC_ROOT', $root);
$_SERVER['REQUEST_METHOD'] = 'GET';
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-attr-' . bin2hex(random_bytes(4)));
require $root . '/lib/core.php';
require $root . '/lib/integrity.php';
$idx = $root . '/index.html';
$orig = file_get_contents($idx);
$cases = array(
  '原始(应放行)'                 => array(null, ''),
  '改为其他仓库(应拦截)'          => array('https://github.com/Evil/Fork', '署名仓库被改为 evil/fork'),
  '删除链接(应拦截)'             => array('', '署名链接被移除'),
  '改为非 github(应拦截)'        => array('https://example.com/x', '署名链接被改为非 GitHub 地址'),
  'fork 仓库(应放行)'            => array('https://github.com/COSYAIYO/TinyChat', ''),
  '带 .git 后缀(应放行)'         => array('https://github.com/TinyNano/TinyChat.git', ''),
  '改名前的旧地址(仍应放行)'     => array('https://github.com/HCARX/TinyChat', ''),
);
$bad = 0;
foreach ($cases as $name => $c) {
  if ($c[0] === null) {
    file_put_contents($idx, $orig);
  } elseif ($c[0] === '') {
    file_put_contents($idx, preg_replace('/<a[^>]*id="user-menu-github".*?<\/a>/s', '', $orig));
  } else {
    file_put_contents($idx, preg_replace('/(id="user-menu-github"[^>]*href=")[^"]*(")/', '${1}' . $c[0] . '${2}', $orig));
  }
  tc_attribution_reset_cache();
  $got = tc_attribution_violation();
  $ok = $got === $c[1];
  printf("%s %-26s => [%s]\n", $ok ? 'ok ' : 'BAD', $name, $got);
  if (!$ok) $bad++;
}
file_put_contents($idx, $orig);
// allow_rebrand 放行
file_put_contents($idx, preg_replace('/(id="user-menu-github"[^>]*href=")[^"]*(")/', '${1}https://github.com/Evil/Fork${2}', $orig));
tc_attribution_reset_cache();
$got = tc_attribution_violation(array('allow_rebrand' => true));
printf("%s %-26s => [%s]\n", $got === '' ? 'ok ' : 'BAD', 'allow_rebrand 显式声明', $got);
if ($got !== '') $bad++;
file_put_contents($idx, $orig);

// 两层校验点存在性:入口 + 数据层各一处,独立生效(删掉其一不足以绕过)
foreach (array('入口' => $root . '/index.php', '数据层' => $root . '/lib/core.php') as $where => $file) {
  $src = (string) file_get_contents($file);
  if (strpos($src, 'tc_integrity_guard()') !== false) {
    printf("%s %-26s => 校验点在位\n", 'ok ', $where . '校验点');
  } else {
    $bad++;
    printf("%s %-26s => 校验点缺失\n", 'BAD', $where . '校验点');
  }
}

echo $bad ? "FAIL $bad\n" : "all ok\n";
