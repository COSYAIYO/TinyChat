<?php
/**
 * 在线聊天(IM)数据层与触发规则自检: php tests/im-social.php
 * 覆盖:AI 召唤触发的边界(压住 "airpod" 这类误触)、好友请求的权威存储与
 * 自动匹配语义、单聊复用、消息落库与会话预览、immsg:/imdel: 分片落库回环。
 * Handler 依赖 HTTP 上下文会 exit,这里直接驱动 lib/im.php 的纯逻辑函数与
 * tc_with_db 数据层;退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-im-' . bin2hex(random_bytes(4));
putenv('DATA_DIR=' . $dataDir);
@mkdir($dataDir, 0755, true);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/integrity.php';   // tc_with_db 里的完整性闸门
require __DIR__ . '/../lib/api.php';   // tc_utf_cut 等
require __DIR__ . '/../lib/im.php';

$fail = 0;
$check = function ($name, $got, $want) use (&$fail) {
    if ($got === $want) {
        echo "  ✓ " . $name . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . " 期望 " . var_export($want, true) . "，实际 " . var_export($got, true) . "\n";
    }
};

// ---------- AI 召唤触发边界(@AI 提及词) ----------
echo "== AI 召唤触发 ==\n";
list($on, $q) = tc_im_ai_trigger('@AI 你好，介绍下自己');
$check('@AI+空格 触发并剥离提及词', array($on, $q), array(true, '你好，介绍下自己'));
list($on, $q) = tc_im_ai_trigger('@ai：1+1等于几');
$check('小写 @ai+全角冒号 触发', array($on, $q), array(true, '1+1等于几'));
list($on, $q) = tc_im_ai_trigger('@AI');
$check('裸 @AI 触发(问题为空,走上下文)', array($on, $q), array(true, ''));
list($on, $q) = tc_im_ai_trigger('@AI,帮我想个标题');
$check('@AI+英文逗号 触发', array($on, $q), array(true, '帮我想个标题'));
list($on, $q) = tc_im_ai_trigger('@AI你好');   // 选完提及不补空格也能用
$check('@AI 紧跟问题触发', array($on, $q), array(true, '你好'));
list($on, $q) = tc_im_ai_trigger('＠ＡＩ 全角也能用');   // 全角 @
$check('全角 @ 触发', $on, true);
list($on, $q) = tc_im_ai_trigger('你好 @AI 帮我总结');
$check('句中提及也触发', array($on, $q), array(true, '你好 帮我总结'));
$check('普通消息不触发', tc_im_ai_trigger('帮我总结一下')[0], false);
$check('airpod 不触发(没有 @)', tc_im_ai_trigger('airpod 多少钱')[0], false);
$check('旧式 AI 开头不再触发', tc_im_ai_trigger('AI 你好')[0], false);
$check('邮箱里的 @ 不触发', tc_im_ai_trigger('发到 me@aitech.com')[0], false);
$check('空串不触发', tc_im_ai_trigger('')[0], false);
$check('纯空格不触发', tc_im_ai_trigger('   ')[0], false);

// ---------- 造三个用户 ----------
$U = array(
    'aaaaaaaaaaaaaaaa' => array('id' => 'aaaaaaaaaaaaaaaa', 'name' => 'Alice', 'salt' => '', 'passwordHash' => '', 'quota' => 100, 'createdAt' => tc_now(), 'lastSeen' => tc_now()),
    'bbbbbbbbbbbbbbbb' => array('id' => 'bbbbbbbbbbbbbbbb', 'name' => 'Bob', 'salt' => '', 'passwordHash' => '', 'quota' => 100, 'createdAt' => tc_now(), 'lastSeen' => tc_now()),
    'cccccccccccccccc' => array('id' => 'cccccccccccccccc', 'name' => 'Cathy', 'salt' => '', 'passwordHash' => '', 'quota' => 100, 'createdAt' => tc_now(), 'lastSeen' => tc_now()),
);
tc_with_db(true, function (&$db) use ($U) { $db['users'] = $U; });

// ---------- 好友请求:权威存储 / 自动匹配 / 幂等 ----------
echo "== 好友请求 ==\n";
$alice = $U['aaaaaaaaaaaaaaaa'];
$bob = $U['bbbbbbbbbbbbbbbb'];
$cathy = $U['cccccccccccccccc'];
tc_with_db(true, function (&$db) use ($alice, $bob, $cathy, $check) {
    // Alice → Bob:发出(附验证消息),请求躺在 Bob 的收件箱
    list($status, $err) = tc_im_friend_request_apply($db, $alice, $bob, '我是 Alice,加个好友');
    $check('首次请求 sent', array($status, $err), array('sent', ''));
    $bobDoc = tc_im_friends_doc($db, 'bbbbbbbbbbbbbbbb');
    $check('请求存在收件方文档', count($bobDoc['reqs']), 1);
    $check('请求记录了 from', (string) $bobDoc['reqs'][0]['from'], 'aaaaaaaaaaaaaaaa');
    $check('请求保存了验证消息', (string) $bobDoc['reqs'][0]['msg'], '我是 Alice,加个好友');
    // 「我发出的」:请求落在收件方文档,必须按 from 匹配才能被发起方看到
    $out = tc_im_requests_out($db, 'aaaaaaaaaaaaaaaa');
    $check('发起方能看到自己发出的请求', count($out), 1);
    $check('发出请求指向正确对象', $out[0]['uid'], 'bbbbbbbbbbbbbbbb');
    $check('发出的请求带验证消息', (string) $out[0]['req']['msg'], '我是 Alice,加个好友');
    $check('收件方自己没有「发出」记录', count(tc_im_requests_out($db, 'bbbbbbbbbbbbbbbb')), 0);
    // 重复请求:幂等
    list($status, $err) = tc_im_friend_request_apply($db, $alice, $bob);
    $check('重复请求返回 dup 不重复落库', array($status, $err, count(tc_im_friends_doc($db, 'bbbbbbbbbbbbbbbb')['reqs'])), array('sent', 'dup', 1));
    // 反向:Bob 也请求 Alice → 自动匹配
    list($status, $err) = tc_im_friend_request_apply($db, $bob, $alice);
    $check('反向请求自动匹配', array($status, $err), array('matched', ''));
    $aDoc = tc_im_friends_doc($db, 'aaaaaaaaaaaaaaaa');
    $bDoc = tc_im_friends_doc($db, 'bbbbbbbbbbbbbbbb');
    $check('双方互为好友', array(count($aDoc['friends']), count($bDoc['friends'])), array(1, 1));
    $check('请求已清除', array(count($aDoc['reqs']), count($bDoc['reqs'])), array(0, 0));
    // 已是好友
    list($status, $err) = tc_im_friend_request_apply($db, $alice, $bob);
    $check('再请求返回 already', $err, 'already');
    // Cathy → Alice;Alice 同意(走 respond 的核心语义:删请求 + 双方加好友)
    tc_im_friend_request_apply($db, $cathy, $alice);
    $aDoc = tc_im_friends_doc($db, 'aaaaaaaaaaaaaaaa');
    $reqId = (string) $aDoc['reqs'][0]['id'];
    $aDoc['friends'][] = array('uid' => 'cccccccccccccccc', 'since' => tc_now());
    array_splice($aDoc['reqs'], 0, 1);
    tc_im_put_friends_doc($db, 'aaaaaaaaaaaaaaaa', $aDoc);
    $cDoc = tc_im_friends_doc($db, 'cccccccccccccccc');
    $cDoc['friends'][] = array('uid' => 'aaaaaaaaaaaaaaaa', 'since' => tc_now());
    tc_im_put_friends_doc($db, 'cccccccccccccccc', $cDoc);
    $check('同意后 Cathy 也是好友', count(tc_im_friends_doc($db, 'cccccccccccccccc')['friends']), 1);
    $check('请求 id 非空', $reqId !== '', true);
    // 不传验证消息时不落 msg 字段(保持存储精简)
    tc_im_friend_request_apply($db, $cathy, $bob);
    $cReq = tc_im_friends_doc($db, 'bbbbbbbbbbbbbbbb')['reqs'][0];
    $check('无验证消息则不存 msg', isset($cReq['msg']), false);
    $check('无验证消息时 from 正常', (string) $cReq['from'], 'cccccccccccccccc');
});

// ---------- 单聊复用与消息落库 ----------
echo "== 会话与消息 ==\n";
tc_with_db(true, function (&$db) use ($alice, $bob, $check) {
    $existing = tc_im_find_dm($db, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    $check('无会话时查找为空', $existing === null, true);
    $t = array(
        'id' => 'dm0000000001', 'type' => 'dm', 'members' => array('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'),
        'ownerId' => 'aaaaaaaaaaaaaaaa', 'aiEnabled' => false, 'createdAt' => tc_now(),
        'lastMsgId' => 0, 'lastMsgAt' => 0, 'lastMsgFrom' => '', 'lastMsgText' => '',
    );
    $map = tc_im_threads_all($db);
    $map['dm0000000001'] = $t;
    $db['imThreads'] = tc_object_map($map);
    $again = tc_im_find_dm($db, 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa');   // 参数顺序无关
    $check('同对好友复用同一会话', $again === null ? '' : (string) $again['id'], 'dm0000000001');

    $t2 = $t;
    $m1 = array('id' => 1, 'from' => 'aaaaaaaaaaaaaaaa', 'name' => 'Alice', 'text' => '你好，在吗', 'at' => tc_now(), 'kind' => 'user');
    tc_im_store_msg($db, $t2, $m1);
    $m2 = array('id' => 2, 'from' => 'ai', 'name' => 'AI', 'text' => '在的，有什么可以帮你', 'at' => tc_now(), 'kind' => 'ai');
    tc_im_store_msg($db, $t2, $m2);
    $check('lastMsgId 推进', $t2['lastMsgId'], 2);
    $check('lastMsgFrom 为 ai', $t2['lastMsgFrom'], 'ai');
    // 预览不带发送者前缀:前端会单独渲染 lastMsgName,避免重复
    $check('预览取最后一条', $t2['lastMsgText'], '在的，有什么可以帮你');
    $doc = tc_im_msgs_doc($db, 'dm0000000001');
    $check('消息条数', count($doc['msgs']), 2);
    $t['aiEnabled'] = false;
    $map = tc_im_threads_all($db);
    $map['dm0000000001'] = $t2;
    $db['imThreads'] = tc_object_map($map);

    // 消息上限:超过 TC_IM_THREAD_MSG_CAP 丢弃最旧,id 保持单调
    for ($i = 3; $i <= TC_IM_THREAD_MSG_CAP + 5; $i++) {
        $t2['lastMsgId'] = $i - 1;
        tc_im_store_msg($db, $t2, array('id' => $i, 'from' => 'aaaaaaaaaaaaaaaa', 'name' => 'Alice', 'text' => 'm' . $i, 'at' => tc_now(), 'kind' => 'user'));
    }
    $doc = tc_im_msgs_doc($db, 'dm0000000001');
    $check('消息条数封顶', count($doc['msgs']), TC_IM_THREAD_MSG_CAP);
    $check('最旧被丢弃(首条 id 正确)', (int) $doc['msgs'][0]['id'], 6);
    $check('lastMsgId 继续单调', $t2['lastMsgId'], TC_IM_THREAD_MSG_CAP + 5);
});

// ---------- 分片落库回环:immsg: / imdel: 行真实落盘,重开事务读得回 ----------
echo "== 分片落库回环 ==\n";
tc_with_db(true, function (&$db) use ($check) {
    // 双向删除在一个全新的小会话上验证:原文进留档,原地脱敏
    $t = array(
        'id' => 'dm0000000002', 'type' => 'dm', 'members' => array('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'),
        'ownerId' => 'aaaaaaaaaaaaaaaa', 'aiEnabled' => false, 'createdAt' => tc_now(),
        'lastMsgId' => 0, 'lastMsgAt' => 0, 'lastMsgFrom' => '', 'lastMsgText' => '',
    );
    $map = tc_im_threads_all($db);
    $map['dm0000000002'] = $t;
    $db['imThreads'] = tc_object_map($map);
    $t2 = $t;
    tc_im_store_msg($db, $t2, array('id' => 1, 'from' => 'aaaaaaaaaaaaaaaa', 'name' => 'Alice', 'text' => '第一条', 'at' => tc_now(), 'kind' => 'user'));
    tc_im_store_msg($db, $t2, array('id' => 2, 'from' => 'ai', 'name' => 'AI', 'text' => '第二条(将被删除)', 'at' => tc_now(), 'kind' => 'ai'));
    tc_im_store_msg($db, $t2, array('id' => 3, 'from' => 'bbbbbbbbbbbbbbbb', 'name' => 'Bob', 'text' => '第三条', 'at' => tc_now(), 'kind' => 'user'));
    $map['dm0000000002'] = $t2;
    $db['imThreads'] = tc_object_map($map);
    $doc = tc_im_msgs_doc($db, 'dm0000000002');
    $arch = tc_im_arch_doc($db, 'dm0000000002');
    foreach ($doc['msgs'] as $i => $m) {
        if ((int) $m['id'] !== 2) continue;
        $arch['msgs'][] = $m;
        $doc['msgs'][$i] = array(
            'id' => 2, 'from' => 'ai', 'name' => 'AI', 'at' => $m['at'], 'kind' => 'ai',
            'deleted' => true, 'deletedBy' => 'aaaaaaaaaaaaaaaa', 'deletedAt' => tc_now(),
        );
        break;
    }
    $arch['events'][] = array('type' => 'msgs', 'ids' => array(2), 'by' => 'aaaaaaaaaaaaaaaa', 'byName' => 'Alice', 'at' => tc_now());
    tc_im_put_msgs_doc($db, 'dm0000000002', $doc);
    tc_im_put_arch_doc($db, 'dm0000000002', $arch);
    $check('留档行已构造', count($arch['msgs']), 1);
});
$pdo = tc_db();
$rows = array();
foreach ($pdo->query('SELECT k, v FROM store') as $row) {
    $rows[(string) $row['k']] = (string) $row['v'];
}
$check('消息按 immsg:{threadId} 分片落盘', isset($rows['immsg:dm0000000002']), true);
$check('留档按 imdel:{threadId} 分片落盘', isset($rows['imdel:dm0000000002']), true);
$check('好友文档落盘(userFriends 整键行)', isset($rows['userFriends']) && strpos($rows['userFriends'], 'bbbbbbbbbbbbbbbb') !== false, true);
$check('用户落盘', isset($rows['users']), true);
tc_with_db(false, function ($db) use ($check) {
    $doc = tc_im_msgs_doc($db, 'dm0000000002');
    $second = null;
    foreach ($doc['msgs'] as $m) { if ((int) $m['id'] === 2) $second = $m; }
    $check('脱敏后正文不外发', isset($second['text']), false);
    $check('占位带删除标记', !empty($second['deleted']), true);
    $arch = tc_im_arch_doc($db, 'dm0000000002');
    $check('留档保留原文', (string) $arch['msgs'][0]['text'], '第二条(将被删除)');
    $check('留档事件记录操作者', (string) $arch['events'][0]['byName'], 'Alice');
    // 大会话在留档外保持完好(上限裁剪不影响未删除的消息)
    $big = tc_im_msgs_doc($db, 'dm0000000001');
    $check('大会话消息仍在', count($big['msgs']) > 0, true);
});

// ---------- 预览截断 ----------
echo "== 预览与长度 ==\n";
$check('长文本预览截断', strlen(tc_im_preview_of(str_repeat('好', 200), null)) <= 260, true);
$check('图片预览前缀', tc_im_preview_of('', array('image' => true, 'name' => 'a.png')), '[图片] a.png');
$check('文件预览前缀', tc_im_preview_of('', array('image' => false, 'name' => 'a.zip')), '[文件] a.zip');
$check('空消息预览兜底', tc_im_preview_of('', null), '[消息]');

// ---------- AI 提示词组装:上下文开关 ----------
echo "== AI 上下文开关 ==\n";
$planA = array(
    'senderName' => 'Alice', 'question' => '那呢', 'model' => 'm',
    'context' => array(
        array('name' => 'Bob', 'kind' => 'user', 'text' => '今天天气不错'),
        array('name' => 'AI', 'kind' => 'ai', 'text' => '是的，挺晴朗'),
    ),
);
$withCtx = tc_im_ai_build_body($planA, 'completions');
$check('开启上下文:带上历史原文', strpos($withCtx['prompt'], '今天天气不错') !== false, true);
$check('开启上下文:AI 历史记为助手内容', strpos($withCtx['prompt'], 'AI: 是的，挺晴朗') !== false, true);
$check('开启上下文:提问带发言人', strpos($withCtx['prompt'], 'Alice 提问：那呢') !== false, true);

$planB = $planA;
$planB['context'] = array();
$noCtx = tc_im_ai_build_body($planB, 'completions');
$check('关闭上下文:不含历史原文', strpos($noCtx['prompt'], '今天天气不错') === false, true);
$check('关闭上下文:仍带本次提问', strpos($noCtx['prompt'], 'Alice 提问：那呢') !== false, true);
$check('关闭上下文:系统提示不再要求结合上下文', strpos($noCtx['prompt'], '结合聊天上下文') === false, true);
$check('开启上下文:系统提示要求结合上下文', strpos($withCtx['prompt'], '结合聊天上下文') !== false, true);

// 无提问 + 无上下文时的兜底措辞不应再提「以上聊天内容」
$planC = $planB;
$planC['question'] = '';
$noQ = tc_im_ai_build_body($planC, 'completions');
$check('无上下文无提问:兜底不提高聊天内容', strpos($noQ['prompt'], '以上聊天内容') === false, true);

// chat(默认)格式同样遵守开关
$chat = tc_im_ai_build_body($planA, 'chat');
$check('chat 格式:system + 2 条历史 + 提问 = 4 段', count($chat['messages']), 4);
$check('chat 格式:首段为 system', $chat['messages'][0]['role'], 'system');
$check('chat 格式:末段为本次提问', $chat['messages'][3]['content'], 'Alice 提问：那呢');
$chatNo = tc_im_ai_build_body($planB, 'chat');
$check('chat 格式关闭上下文:仅 system + 提问', count($chatNo['messages']), 2);

echo $fail ? "\n有 " . $fail . " 项失败\n" : "\n全部通过\n";
exit($fail ? 1 : 0);
