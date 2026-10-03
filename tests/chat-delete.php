<?php
/**
 * 已删除对话留档(软删除)自检: php tests/chat-delete.php
 * 覆盖:数据形状迁移 / userDeletedChats 分片读写 / 留档覆盖与上限 / 演示快照携带留档 /
 *       注销与清理路径会移除留档。退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-chatdel-test-' . bin2hex(random_bytes(4));
@mkdir($dataDir, 0777, true);
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/api.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ $m\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
};

// 1) 空库与迁移:userDeletedChats 存在且规整为 {chats:[], tombs:{}}
$db = tc_empty_db();
$eq('空库带 userDeletedChats', isset($db['userDeletedChats']), true);
$migrated = tc_migrate_db(array('users' => array(), 'userDeletedChats' => array('u1' => array('chats' => array(array('id' => 'c1'))))));
$eq('迁移补全 tombs', $migrated['userDeletedChats']->u1['tombs'], array());
$eq('迁移保留 chats', count($migrated['userDeletedChats']->u1['chats']), 1);

// 2) 读写往返(按用户分片)
$empty = tc_deleted_of($db, 'u1');
$eq('未删除用户读到空留档', $empty, array('chats' => array(), 'tombs' => array()));
tc_set_deleted_of($db, 'u1', array(
    'chats' => array(array('id' => 'c1', 'title' => 'A', 'updatedAt' => 10)),
    'tombs' => array('c1' => 100),
));
$got = tc_deleted_of($db, 'u1');
$eq('留档写入后读回条数', count($got['chats']), 1);
$eq('墓碑写入后读回', (int) $got['tombs']['c1'], 100);
tc_set_deleted_of($db, 'u1', array('chats' => array(), 'tombs' => array()));
$eq('清空后移除该用户分片', isset(tc_assoc($db['userDeletedChats'])['u1']), false);

// 3) 留档覆盖:同 id 保留内容较新的一份
$arch = array(array('id' => 'c1', 'content' => 'old', 'updatedAt' => 10));
tc_deleted_archive_put($arch, array('id' => 'c1', 'content' => 'new', 'updatedAt' => 20));
$eq('较新副本覆盖旧留档', $arch[0]['content'], 'new');
tc_deleted_archive_put($arch, array('id' => 'c1', 'content' => 'stale', 'updatedAt' => 5));
$eq('较旧副本不覆盖留档', $arch[0]['content'], 'new');
tc_deleted_archive_put($arch, array('id' => 'c2', 'content' => 'x', 'updatedAt' => 30));
$eq('新 id 追加入档', count($arch), 2);

// 4) 上限:墓碑保留最近 N 条,留档保留最近 N 条
$tombs = array();
for ($i = 0; $i < 10; $i++) $tombs['t' . $i] = $i;
$capped = tc_deleted_cap_tombs($tombs, 3);
$eq('墓碑裁剪到上限', count($capped), 3);
$eq('墓碑保留最近的时间戳', array_keys($capped), array('t9', 't8', 't7'));
$chats = array();
for ($i = 0; $i < 10; $i++) $chats[] = array('id' => 'c' . $i, 'updatedAt' => $i);
$cappedChats = tc_deleted_cap_chats($chats, 3);
$eq('留档裁剪到上限', count($cappedChats), 3);
$eq('留档保留最新的对话', $cappedChats[0]['id'], 'c9');

// 5) 分片落库/装配往返:chatdel:{uid} 行独立于 chat:{uid}
$pdo = new PDO('sqlite::memory:');
$pdo->exec('CREATE TABLE store (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
$write = tc_empty_db();
$write['userChats'] = tc_object_map(array('u1' => array(array('id' => 'live1', 'title' => '在聊'))));
$write['userDeletedChats'] = tc_object_map(array(
    'u1' => array('chats' => array(array('id' => 'gone1', 'title' => '已删')), 'tombs' => array('gone1' => 123)),
    'u2' => array('chats' => array(), 'tombs' => array('gone2' => 456)),
));
tc_db_write_snapshot($pdo, $write);
$loaded = tc_db_load_all($pdo);
$eq('装配回在聊对话', count(tc_assoc($loaded['userChats'])['u1']), 1);
$eq('装配回 u1 留档', count($loaded['userDeletedChats']->u1['chats']), 1);
$eq('装配回 u1 墓碑', (int) $loaded['userDeletedChats']->u1['tombs']['gone1'], 123);
$eq('装配回 u2 墓碑', (int) $loaded['userDeletedChats']->u2['tombs']['gone2'], 456);

// 6) 演示快照:演示期间删掉的对话到期还原时一并恢复(留档/墓碑回到快照时刻)
$d3 = tc_empty_db();
$d3['settings'] = tc_normalize_settings(array('demoExpireMinutes' => 1));
$demoUser = array('id' => 'd1', 'name' => 'demo', 'admin' => true, 'demo' => true, 'quota' => 0);
$d3['users'] = array($demoUser);
$d3['userChats'] = tc_object_map(array('d1' => array(array('id' => 'k1', 'title' => '基准对话'))));
tc_demo_arm($d3, $demoUser);
$d3['userChats'] = tc_object_map(array('d1' => array()));                       // 演示中把对话删了
tc_set_deleted_of($d3, 'd1', array('chats' => array(array('id' => 'k1', 'title' => '基准对话')), 'tombs' => array('k1' => 999)));
$snap = $d3['demoSnapshot'];
$eq('快照携带删除留档', array_key_exists('demoDeletedChats', $snap), true);
$snap['expireAt'] = 1;
$d3['demoSnapshot'] = $snap;
tc_demo_revert($d3);
$eq('到期还原恢复对话', count(tc_assoc($d3['userChats'])['d1']), 1);
$after = tc_deleted_of($d3, 'd1');
$eq('到期还原清掉演示期间墓碑', $after['tombs'], array());
$eq('到期还原清掉演示期间留档', $after['chats'], array());

// 7) 演示基准沿用:反复还原不得把演示期间的删除固化进基准
$d3['settings']['demoMode'] = false;
$again = tc_demo_arm($d3, $demoUser);
$eq('到期后可再次拍摄', $again, true);
$eq('新快照沿用最初基准的留档', array_key_exists('demoDeletedChats', $d3['demoSnapshot']), true);

// 8) 注销/清理路径:tc_purge_user / tc_soft_delete_user 会移除留档
$d4 = tc_empty_db();
$d4['users'] = array(array('id' => 'z1', 'name' => 'z', 'admin' => false, 'quota' => 0));
tc_set_deleted_of($d4, 'z1', array('chats' => array(array('id' => 'x', 'updatedAt' => 1)), 'tombs' => array('x' => 1)));
tc_purge_user($d4, 'z1');
$eq('彻底删除用户后留档清除', isset(tc_assoc($d4['userDeletedChats'])['z1']), false);

$d5 = tc_empty_db();
$d5['users'] = array(array('id' => 'z2', 'name' => 'z2', 'admin' => false, 'quota' => 0, 'email' => 'z2@example.com'));
tc_set_deleted_of($d5, 'z2', array('chats' => array(array('id' => 'x', 'updatedAt' => 1)), 'tombs' => array('x' => 1)));
tc_soft_delete_user($d5, 'z2');
$eq('软注销用户后留档清除', isset(tc_assoc($d5['userDeletedChats'])['z2']), false);

// 9) 统计口径
$d6 = tc_empty_db();
tc_set_deleted_of($d6, 'a', array('chats' => array(array('id' => '1')), 'tombs' => array('1' => 1)));
tc_set_deleted_of($d6, 'b', array('chats' => array(array('id' => '2'), array('id' => '3')), 'tombs' => array('2' => 1, '3' => 1)));
$eq('留档总数统计', tc_count_deleted_chats($d6), 3);
$sum = tc_admin_deleted_summary($d6);
$eq('汇总条数', $sum['count'], 3);
$eq('汇总按用户条数降序', $sum['users'][0]['userId'], 'b');

echo $fail ? "\n失败 $fail 项\n" : "\n全部通过\n";
exit($fail ? 1 : 0);
