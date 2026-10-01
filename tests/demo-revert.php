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

// 2) 生效中的快照:属主继续活动应「顺延到期」(滑动窗口),但基准不得被改写
//    —— 不打断正在进行的演示;他人活动不得顺延不属于他的快照
$db['settings']['siteName'] = 'CHANGED-1';
$db['providers'][0]['costPerCall'] = 99;
// 把到期时间收紧到 1 秒后:活动应把它重新推回「现在 + 有效期」
$db['demoSnapshot']['expireAt'] = tc_now() + 1000;
$expire1 = (int) $db['demoSnapshot']['expireAt'];
$again = tc_demo_arm($db, $demo);
$eq('生效中继续活动:顺延到期(滑动窗口)', $again, true);
$eq('顺延后到期时间不早于原值', (int) $db['demoSnapshot']['expireAt'] >= $expire1, true);
$eq('顺延到完整的有效窗口', (int) $db['demoSnapshot']['expireAt'] > tc_now() + 30000, true);
$eq('生效中基准仍是原值', $db['demoSnapshot']['settings']['siteName'], 'ORIGINAL');
$other = tc_demo_arm($db, array('id' => 'demo2', 'admin' => true, 'demo' => true));
$eq('他人活动不顺延别人的快照', $other, false);
$eq('他人活动后快照仍归原属主', $db['demoSnapshot']['userId'], 'demo1');

// 3) 未到期不还原
$eq('未到期不还原', tc_demo_revert($db), false);
$eq('未到期保持改动', $db['settings']['siteName'], 'CHANGED-1');

// 4) 到期还原(并把「已还原」标记写给客户端,用于整体采纳云端)
$db['demoSnapshot']['expireAt'] = 1; // 强制过期
$eq('到期触发还原', tc_demo_revert($db), true);
$eq('还原 siteName', $db['settings']['siteName'], 'ORIGINAL');
$eq('还原 demoMode', !empty($db['settings']['demoMode']), false);
$eq('还原 providers.costPerCall', $db['providers'][0]['costPerCall'], 1);
$eq('清空快照', $db['demoSnapshot'], null);
$reverted = tc_assoc($db['demoReverted']);
$eq('还原后写入客户端还原标记', isset($reverted['demo1']) && (int) $reverted['demo1'] > 0, true);

// 5) 关键回归:还原后再次改动应能重新拍摄并再次还原(旧实现只保护第一轮)。
//    真实顺序是「先拍摄(改动前) → 再应用改动」,这里按同样顺序模拟。
$rearm = tc_demo_arm($db, $demo);
$eq('到期后可再次拍摄(反复还原)', $rearm, true);
$eq('新快照基准为还原后的原值', $db['demoSnapshot']['settings']['siteName'], 'ORIGINAL');
$db['settings']['siteName'] = 'CHANGED-2';   // 拍摄之后才应用改动
$db['demoSnapshot']['expireAt'] = 1;
$eq('第二轮到期还原', tc_demo_revert($db), true);
$eq('第二轮还原 siteName', $db['settings']['siteName'], 'ORIGINAL');

// 5b) 「把已有用户转为演示管理员」:force 重拍,以转换那一刻为新原点
$db3 = tc_empty_db();
$db3['settings'] = tc_normalize_settings(array('siteName' => 'LIVE-A', 'demoExpireMinutes' => 1));
tc_demo_arm($db3, array('id' => 'd0', 'admin' => true, 'demo' => true));   // 上一轮遗留快照
$oldExpire = (int) $db3['demoSnapshot']['expireAt'];
$db3['settings']['siteName'] = 'LIVE-B';                                   // 站点已被改成 LIVE-B
// 现在把另一个用户转为演示管理员:应以 LIVE-B 为基准重拍,而不是沿用旧的 LIVE-A
$forced = tc_demo_arm($db3, array('id' => 'd1', 'admin' => true, 'demo' => true), true);
$eq('force 重拍快照', $forced, true);
$eq('force 后基准为转换时的现值', $db3['demoSnapshot']['settings']['siteName'], 'LIVE-B');
$eq('force 后归属新的演示账号', $db3['demoSnapshot']['userId'], 'd1');
$eq('force 后重新计时', (int) $db3['demoSnapshot']['expireAt'] >= $oldExpire, true);

// 5c) 演示管理员的个人数据(对话/额度)在转换那一刻定格,到期一并恢复
$dbp = tc_empty_db();
$dbp['settings'] = tc_normalize_settings(array('siteName' => 'S', 'demoExpireMinutes' => 1));
$demoUser = array('id' => 'du1', 'name' => 'demoacc', 'admin' => true, 'demo' => true, 'quota' => 100);
$dbp['users'] = array($demoUser);
$dbp['userChats'] = tc_object_map(array('du1' => array(array('id' => 'c0', 'title' => '旧对话', 'messages' => array()))));
tc_demo_arm($dbp, $demoUser);
$eq('快照记录演示账号对话', count($dbp['demoSnapshot']['demoChats']), 1);
$eq('快照记录演示账号额度', $dbp['demoSnapshot']['demoQuota'], 100);
// 演示期间:新增对话、花掉额度
$map = tc_assoc($dbp['userChats']);
$map['du1'][] = array('id' => 'c1', 'title' => '演示期间新对话', 'messages' => array());
$dbp['userChats'] = tc_object_map($map);
foreach ($dbp['users'] as &$u) if ($u['id'] === 'du1') $u['quota'] = 40;
unset($u);
$dbp['demoSnapshot']['expireAt'] = 1;   // 强制到期
$eq('到期触发还原(含个人数据)', tc_demo_revert($dbp), true);
$revertedChats = tc_assoc($dbp['userChats']);
$eq('演示期间新增对话被回收', count($revertedChats['du1']), 1);
$eq('回收后剩的是转换时那份', $revertedChats['du1'][0]['title'], '旧对话');
foreach ($dbp['users'] as $u) if ($u['id'] === 'du1') $eq('演示期间消耗的额度被恢复', $u['quota'], 100);

// 5d) 真实管理员的改动成为新的还原基准(且不固化演示管理员在途改动)
$dbr = tc_empty_db();
$dbr['settings'] = tc_normalize_settings(array('siteName' => 'REAL-A', 'temperature' => 0.1, 'demoExpireMinutes' => 1));
$dbr['users'] = array(array('id' => 'du2', 'name' => 'demo2', 'admin' => true, 'demo' => true, 'quota' => 0));
$dbr['userChats'] = new stdClass();
$dbr['userChatRevisions'] = new stdClass();
tc_demo_arm($dbr, array('id' => 'du2', 'admin' => true, 'demo' => true));
$eq('基线初始 siteName', $dbr['demoSnapshot']['settings']['siteName'], 'REAL-A');
// 演示管理员改了 siteName(在途,未到期)
$dbr['settings']['siteName'] = 'DEMO-C';
// 真实管理员接着只改了 temperature:记录改动前基线,再应用改动
$before = tc_demo_capture($dbr);
$dbr['settings']['temperature'] = 0.9;
$rebased = tc_demo_rebaseline($dbr, $before);
$eq('真实管理员改动触发写回基线', $rebased, true);
$eq('基线采纳真实管理员的新值(temperature)', $dbr['demoSnapshot']['settings']['temperature'], 0.9);
$eq('基线未被演示在途改动污染(siteName)', $dbr['demoSnapshot']['settings']['siteName'], 'REAL-A');
// 到期还原:演示改的 siteName 被收回,真实管理员改的 temperature 保留
$dbr['demoSnapshot']['expireAt'] = 1;
tc_demo_revert($dbr);
$eq('还原后演示改动被收回', $dbr['settings']['siteName'], 'REAL-A');
$eq('还原后真实管理员改动仍在', $dbr['settings']['temperature'], 0.9);

// 5e) 演示账号改为普通用户后,个人数据保留、不再被还原
$dbn = tc_empty_db();
$dbn['settings'] = tc_normalize_settings(array('siteName' => 'N', 'demoExpireMinutes' => 1));
$dbn['users'] = array(array('id' => 'du3', 'name' => 'n3', 'admin' => true, 'demo' => true, 'quota' => 5));
$dbn['userChats'] = tc_object_map(array('du3' => array()));
tc_demo_arm($dbn, array('id' => 'du3', 'admin' => true, 'demo' => true));
$map = tc_assoc($dbn['userChats']);
$map['du3'][] = array('id' => 'keep1', 'title' => '改成普通用户后应保留', 'messages' => array());
$dbn['userChats'] = tc_object_map($map);
// 转为普通用户
foreach ($dbn['users'] as &$u) if ($u['id'] === 'du3') unset($u['demo']);
unset($u);
$dbn['demoSnapshot']['expireAt'] = 1;
tc_demo_revert($dbn);
$kept = tc_assoc($dbn['userChats']);
$eq('转普通用户后数据保留', count($kept['du3']), 1);
$eq('保留的是转换后的新对话', $kept['du3'][0]['title'], '改成普通用户后应保留');

// 6) 非演示管理员不参与
$db2 = tc_empty_db();
$db2['settings'] = tc_normalize_settings(array('siteName' => 'X'));
$eq('普通管理员不拍摄', tc_demo_arm($db2, array('id' => 'u', 'admin' => true)), false);
$eq('无快照时还原为 no-op', tc_demo_revert($db2), false);

// 7) 回归:快照被消费后,演示管理员只要继续活动(如在前台聊天)就要重新拍摄。
// 缺陷背景:快照原先只在 tc_require_admin(后台操作)里拍摄,演示管理员纯聊天时不经过那里,
// 第一次到期还原后快照被消费、永久不再重建 —— 他之后产生的对话就再也不会被自动清除。
$db4 = tc_empty_db();
$db4['settings'] = tc_normalize_settings(array('siteName' => 'S', 'demoExpireMinutes' => 10));
$demo4 = array('id' => 'du4', 'name' => 'chatdemo', 'admin' => true, 'demo' => true, 'quota' => 5);
$db4['users'] = array($demo4);
$db4['userChats'] = tc_object_map(array('du4' => array()));
tc_demo_arm($db4, $demo4);
$eq('首轮快照已建立', is_array($db4['demoSnapshot']), true);
// 首轮到期:还原并消费快照
$db4['demoSnapshot']['expireAt'] = 1;
tc_demo_revert($db4);
$eq('首轮还原后快照被消费', $db4['demoSnapshot'], null);
// 演示期间又聊了一轮(模拟前台保存对话触发的写入)
$map4 = tc_assoc($db4['userChats']);
$map4['du4'][] = array('id' => 'r2', 'title' => '第二轮对话', 'messages' => array());
$db4['userChats'] = tc_object_map($map4);
// 写入路径下必须自动重建快照(修复点)
$rearm = tc_demo_arm($db4, $demo4);
$eq('继续活动后快照自动重建', $rearm, true);
$eq('重建的快照仍是原始基准', count($db4['demoSnapshot']['demoChats']), 0);
// 第二轮到期:新产生的对话同样被回收
$db4['demoSnapshot']['expireAt'] = 1;
tc_demo_revert($db4);
$after4 = tc_assoc($db4['userChats']);
$eq('第二轮新对话也被清除', count($after4['du4']), 0);

// 清理
foreach (glob($dataDir . '/*') as $f) @unlink($f);
@rmdir($dataDir);

echo "\n" . ($fail ? '✗ 演示还原自检失败: ' . $fail . ' 项' : '✓ 演示还原自检通过') . "\n";
exit($fail ? 1 : 0);
