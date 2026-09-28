<?php
/**
 * 演示管理员还原逻辑自检: php tests/demo-revert.php
 * 覆盖:快照拍摄 / 到期还原 / 到期后可再次拍摄(反复还原) / 生效中不被覆盖 / 非到期不还原。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-demo-test-' . bin2hex(random_bytes(4));
@mkdir($dataDir, 0777, true);
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ $m\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
};

// 造一个最小 db,settings 里带 demoExpireMinutes
$db = tc_empty_db();
$db['settings'] = tc_normalize_settings(array('siteName' => 'ORIGINAL', 'demoExpireMinutes' => 1));
$db['accessRules'] = array(array('id' => 'r1', 'groupId' => 'g1', 'providerId' => 'p1', 'modelIds' => array('*')));
$db['providers'] = array(array('id' => 'p1', 'name' => 'P', 'baseUrl' => 'https://x/v1', 'apiKey' => 'enc', 'scope' => 'global', 'models' => array(array('id' => 'm1')), 'costPerCall' => 1));
$demo = array('id' => 'demo1', 'name' => 'demo', 'admin' => true, 'demo' => true);

// 1) 拍快照
$armed = tc_demo_arm($db, $demo);
$eq('首次拍摄快照', $armed, true);
$eq('快照标记 demoMode', !empty($db['settings']['demoMode']), true);
$eq('快照记录了基准 siteName', $db['demoSnapshot']['settings']['siteName'], 'ORIGINAL');
$eq('快照记录了 accessRules', count($db['demoSnapshot']['accessRules']), 1);
$eq('快照记录了 providers', count($db['demoSnapshot']['providers']), 1);

// 2) 已有生效快照时再次拍摄不应覆盖
$expire1 = (int) $db['demoSnapshot']['expireAt'];
$db['settings']['siteName'] = 'CHANGED-1';
$db['providers'][0]['costPerCall'] = 99;
$again = tc_demo_arm($db, $demo);
$eq('生效中不重复拍摄', $again, false);
$eq('生效中快照到期时间不变', (int) $db['demoSnapshot']['expireAt'], $expire1);
$eq('生效中基准仍是原值', $db['demoSnapshot']['settings']['siteName'], 'ORIGINAL');

// 3) 未到期不还原
$eq('未到期不还原', tc_demo_revert($db), false);
$eq('未到期保持改动', $db['settings']['siteName'], 'CHANGED-1');

// 4) 到期还原
$db['demoSnapshot']['expireAt'] = 1; // 强制过期
$eq('到期触发还原', tc_demo_revert($db), true);
$eq('还原 siteName', $db['settings']['siteName'], 'ORIGINAL');
$eq('还原 demoMode', !empty($db['settings']['demoMode']), false);
$eq('还原 providers.costPerCall', $db['providers'][0]['costPerCall'], 1);
$eq('清空快照', $db['demoSnapshot'], null);

// 5) 关键回归:还原后再次改动应能重新拍摄并再次还原(旧实现只保护第一轮)。
//    真实顺序是「先拍摄(改动前) → 再应用改动」,这里按同样顺序模拟。
$rearm = tc_demo_arm($db, $demo);
$eq('到期后可再次拍摄(反复还原)', $rearm, true);
$eq('新快照基准为还原后的原值', $db['demoSnapshot']['settings']['siteName'], 'ORIGINAL');
$db['settings']['siteName'] = 'CHANGED-2';   // 拍摄之后才应用改动
$db['demoSnapshot']['expireAt'] = 1;
$eq('第二轮到期还原', tc_demo_revert($db), true);
$eq('第二轮还原 siteName', $db['settings']['siteName'], 'ORIGINAL');

// 6) 非演示管理员不参与
$db2 = tc_empty_db();
$db2['settings'] = tc_normalize_settings(array('siteName' => 'X'));
$eq('普通管理员不拍摄', tc_demo_arm($db2, array('id' => 'u', 'admin' => true)), false);
$eq('无快照时还原为 no-op', tc_demo_revert($db2), false);

// 清理
foreach (glob($dataDir . '/*') as $f) @unlink($f);
@rmdir($dataDir);

echo "\n" . ($fail ? '✗ 演示还原自检失败: ' . $fail . ' 项' : '✓ 演示还原自检通过') . "\n";
exit($fail ? 1 : 0);
