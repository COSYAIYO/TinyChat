<?php
/**
 * 第三方一键登录(微信 / QQ / LinuxDO Connect / NodeLoc OAuth)。
 *
 * 设计要点:
 *  - 无 PHP Session:用 HMAC 签名的 state 防 CSRF,用短时效 JWT 做一次性登录票据;
 *  - 统一抽象:每个提供商实现 authorize_url / exchange_code / fetch_profile 三步;
 *  - 账号绑定:第三方 uid 存在用户记录的 oauth 字段里({provider: uid}),未绑定时按设置自动注册。
 */

// 提供商注册表:字段名 / 显示名 / 图标 / 默认端点(端点可被环境变量覆盖以便测试)
function tc_oauth_providers() {
    $env = function ($k, $def) { $v = getenv($k); return ($v !== false && $v !== '') ? rtrim($v, '/') : $def; };
    return array(
        'wechat' => array(
            'name' => '微信',
            'logo' => 'static/logo/weixin.svg',
            'fields' => array('appId' => 'AppID', 'appSecret' => 'AppSecret'),
            'authorize' => $env('TC_WECHAT_OAUTH_BASE', 'https://open.weixin.qq.com') . '/connect/qrconnect',
            'token' => $env('TC_WECHAT_API_BASE', 'https://api.weixin.qq.com') . '/sns/oauth2/access_token',
            'userinfo' => $env('TC_WECHAT_API_BASE', 'https://api.weixin.qq.com') . '/sns/userinfo',
            'scope' => 'snsapi_login',
        ),
        'qq' => array(
            'name' => 'QQ',
            'logo' => 'static/logo/qq.svg',
            'fields' => array('appId' => 'AppID', 'appKey' => 'AppKey'),
            'authorize' => $env('TC_QQ_OAUTH_BASE', 'https://graph.qq.com') . '/oauth2.0/authorize',
            'token' => $env('TC_QQ_OAUTH_BASE', 'https://graph.qq.com') . '/oauth2.0/token',
            'openid' => $env('TC_QQ_OAUTH_BASE', 'https://graph.qq.com') . '/oauth2.0/me',
            'userinfo' => $env('TC_QQ_OAUTH_BASE', 'https://graph.qq.com') . '/user/get_user_info',
            'scope' => 'get_user_info',
        ),
        'linuxdo' => array(
            'name' => 'LINUX DO',
            'logo' => 'static/logo/linuxdo.png',
            'fields' => array('clientId' => 'Client ID', 'clientSecret' => 'Client Secret'),
            'authorize' => $env('TC_LINUXDO_OAUTH_BASE', 'https://connect.linux.do') . '/oauth2/authorize',
            'token' => $env('TC_LINUXDO_OAUTH_BASE', 'https://connect.linux.do') . '/oauth2/token',
            'userinfo' => $env('TC_LINUXDO_OAUTH_BASE', 'https://connect.linux.do') . '/api/user',
            'scope' => 'openid profile email',
        ),
        'nodeloc' => array(
            'name' => 'NodeLoc',
            'logo' => 'static/logo/nodeloc.png',
            'fields' => array('clientId' => 'Client ID', 'clientSecret' => 'Client Secret'),
            'authorize' => $env('TC_NODELOC_OAUTH_BASE', 'https://www.nodeloc.com') . '/oauth-provider/authorize',
            'token' => $env('TC_NODELOC_OAUTH_BASE', 'https://www.nodeloc.com') . '/oauth-provider/token',
            'userinfo' => $env('TC_NODELOC_OAUTH_BASE', 'https://www.nodeloc.com') . '/oauth-provider/userinfo',
            'scope' => 'openid profile email',
        ),
    );
}

function tc_oauth_provider($id) {
    $all = tc_oauth_providers();
    return isset($all[$id]) ? $all[$id] : null;
}

// 某个提供商是否已启用且配置完整
function tc_oauth_ready($settings, $id) {
    $p = tc_oauth_provider($id);
    if (!$p) return false;
    $cfg = isset($settings['oauthProviders'][$id]) && is_array($settings['oauthProviders'][$id])
        ? $settings['oauthProviders'][$id] : array();
    if (empty($cfg['enabled'])) return false;
    foreach (array_keys($p['fields']) as $f) {
        if (trim((string) (isset($cfg[$f]) ? $cfg[$f] : '')) === '') return false;
    }
    return true;
}

// 已启用的提供商清单(用于 /api/config 下发登录页图标)
function tc_oauth_enabled_providers($settings) {
    $out = array();
    foreach (tc_oauth_providers() as $id => $p) {
        if (!tc_oauth_ready($settings, $id)) continue;
        $out[] = array('id' => $id, 'name' => $p['name'], 'logo' => $p['logo']);
    }
    return $out;
}

// 回调地址:优先用当前请求推导,保证与用户实际访问的域名一致(微信/QQ 对域名校验严格)
function tc_oauth_redirect_uri($id) {
    return tc_public_base_url() . '/auth/' . $id . '/callback';
}

// 网页回跳地址:登录完成后带一次性票据回到前台
function tc_oauth_landing_url() {
    return tc_public_base_url() . '/';
}

// —— state:HMAC 签名,防 CSRF;不依赖 PHP Session ——
// 回调侧另有一次性消费(usedOauthStates),同一 state 二次回调会被拒,防重放
function tc_oauth_make_state($id, $bindUserId = '') {
    $payload = tc_b64url(tc_json_encode(array(
        'p' => (string) $id,
        'n' => bin2hex(random_bytes(8)),
        't' => (int) floor(tc_now() / 1000),
        // 绑定模式:带上要绑定的本站用户 id(回调时据此走绑定而不是登录)
        'b' => (string) $bindUserId,
    )));
    return $payload . '.' . tc_b64url(hash_hmac('sha256', $payload, tc_secret(), true));
}

function tc_oauth_check_state($state) {
    $parts = explode('.', (string) $state);
    if (count($parts) !== 2) return null;
    list($payload, $sig) = $parts;
    $expect = tc_b64url(hash_hmac('sha256', $payload, tc_secret(), true));
    if (!hash_equals($expect, $sig)) return null;
    $json = json_decode(tc_b64url_decode($payload), true);
    if (!is_array($json) || empty($json['p'])) return null;
    // 10 分钟有效期
    if ((int) $json['t'] < (int) floor(tc_now() / 1000) - 600) return null;
    return $json;
}

// state 一次性消费:成功校验后把随机 nonce 记入已用清单(带 15 分钟剪枝)。
// 放在绑定/建号的同一写事务里调用,避免额外加锁。
function tc_oauth_consume_state(&$db, $state) {
    $parts = explode('.', (string) $state);
    if (count($parts) !== 2) return;
    $json = json_decode(tc_b64url_decode($parts[0]), true);
    if (!is_array($json) || empty($json['n'])) return;
    $nonce = (string) $json['n'];
    $used = (isset($db['usedOauthStates']) && is_array($db['usedOauthStates'])) ? $db['usedOauthStates'] : array();
    if (!empty($used[$nonce])) return; // 已消费:调用方会把 result 置为失败
    $now = tc_now();
    foreach ($used as $n => $t) if ((int) $t < $now - 900000) unset($used[$n]);
    $used[$nonce] = $now;
    $db['usedOauthStates'] = $used;
}

function tc_oauth_state_was_used(&$db, $state) {
    $parts = explode('.', (string) $state);
    if (count($parts) !== 2) return false;
    $json = json_decode(tc_b64url_decode($parts[0]), true);
    if (!is_array($json) || empty($json['n'])) return false;
    $used = (isset($db['usedOauthStates']) && is_array($db['usedOauthStates'])) ? $db['usedOauthStates'] : array();
    return !empty($used[(string) $json['n']]);
}

// —— 一次性登录票据:短时效 JWT + 服务端已用清单,避免重放 ——
function tc_oauth_make_ticket($userId) {
    return tc_jwt_sign(array(
        'sub' => (string) $userId,
        'ot' => 1,
        'jti' => bin2hex(random_bytes(8)),
        'exp' => tc_now() + 120000,
    ));
}

// 校验并消费票据:同一张票据只能成功兑换一次
function tc_oauth_consume_ticket(&$db, $ticket) {
    $d = tc_jwt_verify($ticket);
    if (!is_array($d) || empty($d['ot']) || empty($d['sub']) || empty($d['jti'])) return '';
    $jti = (string) $d['jti'];
    $used = (isset($db['usedOauthTickets']) && is_array($db['usedOauthTickets'])) ? $db['usedOauthTickets'] : array();
    if (isset($used[$jti])) return '';
    // 顺带清理过期条目,避免无限增长
    $now = (int) floor(tc_now() / 1000);
    foreach ($used as $k => $ts) {
        if ($now - (int) $ts > 600) unset($used[$k]);
    }
    $used[$jti] = $now;
    $db['usedOauthTickets'] = $used;
    return (string) $d['sub'];
}

// —— 第一步:拼授权地址 ——
function tc_oauth_authorize_url($id, $cfg, $state) {
    $p = tc_oauth_provider($id);
    if (!$p) return '';
    $redirect = tc_oauth_redirect_uri($id);
    if ($id === 'wechat') {
        // 微信要求 redirect_uri 做 urlencode 且末尾带 #wechat_redirect
        return $p['authorize'] . '?' . http_build_query(array(
            'appid' => $cfg['appId'],
            'redirect_uri' => $redirect,
            'response_type' => 'code',
            'scope' => $p['scope'],
            'state' => $state,
        )) . '#wechat_redirect';
    }
    if ($id === 'qq') {
        return $p['authorize'] . '?' . http_build_query(array(
            'response_type' => 'code',
            'client_id' => $cfg['appId'],
            'redirect_uri' => $redirect,
            'state' => $state,
            'scope' => $p['scope'],
        ));
    }
    return $p['authorize'] . '?' . http_build_query(array(
        'client_id' => $cfg['clientId'],
        'redirect_uri' => $redirect,
        'response_type' => 'code',
        'scope' => $p['scope'],
        'state' => $state,
    ));
}

// —— 第二步:code 换 token ——
function tc_oauth_exchange($id, $cfg, $code) {
    $p = tc_oauth_provider($id);
    if (!$p) return array('ok' => false, 'error' => '未知的登录方式');
    $redirect = tc_oauth_redirect_uri($id);
    if ($id === 'wechat') {
        $url = $p['token'] . '?' . http_build_query(array(
            'appid' => $cfg['appId'],
            'secret' => $cfg['appSecret'],
            'code' => $code,
            'grant_type' => 'authorization_code',
        ));
        $res = tc_http_request($url, 'GET', array('Accept' => 'application/json'), null, 15000, false);
        $j = tc_oauth_json($res);
        if (!is_array($j)) return tc_oauth_err($res, '微信');
        if (!empty($j['errcode'])) return array('ok' => false, 'error' => '微信: ' . (isset($j['errmsg']) ? $j['errmsg'] : ('错误码 ' . $j['errcode'])));
        if (empty($j['access_token']) || empty($j['openid'])) return array('ok' => false, 'error' => '微信没有返回 access_token');
        return array('ok' => true, 'token' => (string) $j['access_token'], 'uid' => (string) $j['openid'], 'unionid' => isset($j['unionid']) ? (string) $j['unionid'] : '');
    }
    if ($id === 'qq') {
        $url = $p['token'] . '?' . http_build_query(array(
            'grant_type' => 'authorization_code',
            'client_id' => $cfg['appId'],
            'client_secret' => $cfg['appKey'],
            'code' => $code,
            'redirect_uri' => $redirect,
            'fmt' => 'json',
        ));
        $res = tc_http_request($url, 'GET', array('Accept' => 'application/json'), null, 15000, false);
        $j = tc_oauth_json($res);
        if (!is_array($j)) return tc_oauth_err($res, 'QQ');
        if (isset($j['error'])) return array('ok' => false, 'error' => 'QQ: ' . (isset($j['error_description']) ? $j['error_description'] : $j['error']));
        if (empty($j['access_token'])) return array('ok' => false, 'error' => 'QQ 没有返回 access_token');
        // QQ 的用户标识是 OpenID,需要再调一次 /oauth2.0/me
        $meUrl = $p['openid'] . '?' . http_build_query(array('access_token' => $j['access_token'], 'fmt' => 'json'));
        $meRes = tc_http_request($meUrl, 'GET', array('Accept' => 'application/json'), null, 15000, false);
        $me = tc_oauth_json($meRes, true);
        if (!is_array($me) || empty($me['openid'])) return tc_oauth_err($meRes, 'QQ');
        return array('ok' => true, 'token' => (string) $j['access_token'], 'uid' => (string) $me['openid'], 'unionid' => '');
    }
    // LinuxDO / NodeLoc:标准 OAuth2 authorization_code,POST 表单
    $body = http_build_query(array(
        'grant_type' => 'authorization_code',
        'code' => $code,
        'redirect_uri' => $redirect,
        'client_id' => $cfg['clientId'],
        'client_secret' => $cfg['clientSecret'],
    ));
    $res = tc_http_request($p['token'], 'POST', array(
        'Content-Type' => 'application/x-www-form-urlencoded',
        'Accept' => 'application/json',
    ), $body, 20000, false);
    $j = tc_oauth_json($res);
    if (!is_array($j)) return tc_oauth_err($res, $p['name']);
    if (!empty($j['error'])) return array('ok' => false, 'error' => $p['name'] . ': ' . (isset($j['error_description']) ? $j['error_description'] : $j['error']));
    if (empty($j['access_token'])) return array('ok' => false, 'error' => $p['name'] . ' 没有返回 access_token');
    return array('ok' => true, 'token' => (string) $j['access_token'], 'uid' => '', 'unionid' => '');
}

// —— 第三步:取用户资料 ——
function tc_oauth_fetch_profile($id, $cfg, $token, $uid) {
    $p = tc_oauth_provider($id);
    if (!$p) return array('ok' => false, 'error' => '未知的登录方式');
    if ($id === 'wechat') {
        $url = $p['userinfo'] . '?' . http_build_query(array('access_token' => $token, 'openid' => $uid, 'lang' => 'zh_CN'));
        $res = tc_http_request($url, 'GET', array('Accept' => 'application/json'), null, 15000, false);
        $j = tc_oauth_json($res);
        if (!is_array($j)) return tc_oauth_err($res, '微信');
        if (!empty($j['errcode'])) return array('ok' => false, 'error' => '微信: ' . (isset($j['errmsg']) ? $j['errmsg'] : ''));
        return array('ok' => true, 'uid' => (string) (isset($j['openid']) ? $j['openid'] : $uid), 'name' => (string) (isset($j['nickname']) ? $j['nickname'] : '微信用户'), 'avatar' => (string) (isset($j['headimgurl']) ? $j['headimgurl'] : ''), 'email' => '');
    }
    if ($id === 'qq') {
        $url = $p['userinfo'] . '?' . http_build_query(array('access_token' => $token, 'oauth_consumer_key' => $cfg['appId'], 'openid' => $uid, 'fmt' => 'json'));
        $res = tc_http_request($url, 'GET', array('Accept' => 'application/json'), null, 15000, false);
        $j = tc_oauth_json($res);
        if (!is_array($j)) return tc_oauth_err($res, 'QQ');
        if (isset($j['ret']) && (int) $j['ret'] !== 0) return array('ok' => false, 'error' => 'QQ: ' . (isset($j['msg']) ? $j['msg'] : ('错误码 ' . $j['ret'])));
        $avatar = '';
        foreach (array('figureurl_qq_2', 'figureurl_qq_1', 'figureurl_2', 'figureurl') as $k) {
            if (!empty($j[$k])) { $avatar = (string) $j[$k]; break; }
        }
        return array('ok' => true, 'uid' => $uid, 'name' => (string) (isset($j['nickname']) ? $j['nickname'] : 'QQ 用户'), 'avatar' => $avatar, 'email' => '');
    }
    // LinuxDO / NodeLoc:GET userinfo,Bearer
    $res = tc_http_request($p['userinfo'], 'GET', array(
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $token,
    ), null, 20000, false);
    $j = tc_oauth_json($res);
    if (!is_array($j)) return tc_oauth_err($res, $p['name']);
    $pid = isset($j['id']) ? (string) $j['id'] : (isset($j['sub']) ? (string) $j['sub'] : '');
    if ($pid === '') return array('ok' => false, 'error' => $p['name'] . ' 没有返回用户标识');
    $name = isset($j['name']) ? (string) $j['name'] : '';
    if ($name === '' && isset($j['username'])) $name = (string) $j['username'];
    if ($name === '' && isset($j['preferred_username'])) $name = (string) $j['preferred_username'];
    if ($name === '') $name = $p['name'] . '用户';
    $email = isset($j['email']) ? strtolower(trim((string) $j['email'])) : '';
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) $email = '';
    return array(
        'ok' => true,
        'uid' => $pid,
        'name' => $name,
        'avatar' => (string) (isset($j['avatar_url']) ? $j['avatar_url'] : (isset($j['picture']) ? $j['picture'] : '')),
        'email' => $email,
    );
}

// 解析 HTTP 响应为 JSON;QQ 的 /oauth2.0/me 在未指定 fmt 时会包成 callback( {...} );
function tc_oauth_json($res, $allowCallbackWrap = false) {
    if (empty($res['ok']) || (int) $res['status'] >= 400) {
        // QQ 有些错误也用 200 + callback 包裹,这里继续尝试解析正文
        if (empty($res['body'])) return null;
    }
    $body = trim((string) (isset($res['body']) ? $res['body'] : ''));
    if ($body === '') return null;
    if ($allowCallbackWrap && strpos($body, 'callback') === 0) {
        if (preg_match('/callback\s*\(\s*(\{.*\})\s*\)/s', $body, $m)) $body = $m[1];
    }
    $j = json_decode($body, true);
    return is_array($j) ? $j : null;
}

function tc_oauth_err($res, $who) {
    if (empty($res['ok'])) return array('ok' => false, 'error' => $who . ' 请求失败: ' . (isset($res['error']) ? $res['error'] : '网络错误'));
    $msg = tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', isset($res['status']) ? (int) $res['status'] : 0);
    return array('ok' => false, 'error' => $who . ' 返回错误 (' . (isset($res['status']) ? (int) $res['status'] : 0) . ')' . ($msg ? ': ' . $msg : ''));
}

// —— 账号绑定与创建 ——

// 按第三方 uid 找已绑定用户
function tc_oauth_find_user($db, $id, $uid) {
    foreach ($db['users'] as $u) {
        if (empty($u['oauth']) || !is_array($u['oauth'])) continue;
        if (!empty($u['oauth'][$id]) && (string) $u['oauth'][$id] === (string) $uid) return $u;
    }
    return null;
}

// 生成一个不与现有用户重名的用户名
function tc_oauth_unique_name($db, $base) {
    $base = trim((string) $base);
    $base = preg_replace('/\s+/u', '', $base);
    if ($base === '' || !tc_valid_name($base)) $base = 'user';
    if (function_exists('mb_substr')) $base = mb_substr($base, 0, 24, 'UTF-8');
    $name = $base;
    $i = 1;
    while (true) {
        $taken = false;
        foreach ($db['users'] as $u) {
            if (strtolower((string) $u['name']) === strtolower($name)) { $taken = true; break; }
        }
        if (!$taken) return $name;
        $i++;
        $name = $base . $i;
    }
}

// 自动注册:第三方账号首次登录时建号(沿用注册默认组与免费额度)
function tc_oauth_create_user(&$db, $id, $profile) {
    $name = tc_oauth_unique_name($db, $profile['name']);
    $quota = isset($db['settings']['freeQuota']) ? (int) $db['settings']['freeQuota'] : 0;
    if (!empty($db['settings']['freeQuotaUnlimited'])) $quota = -1;
    $user = array(
        'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
        'quota' => $quota, 'email' => isset($profile['email']) ? (string) $profile['email'] : '',
        'createdAt' => tc_now(), 'admin' => false, 'groupId' => tc_default_register_group($db), 'tv' => 0,
        'emailVerifiedAt' => 1, // 第三方登录已由提供商验证身份,视为已验证
        'oauth' => array($id => (string) $profile['uid']),
        'oauthName' => (string) $profile['name'],
        'oauthAvatar' => isset($profile['avatar']) ? (string) $profile['avatar'] : '',
    );
    $db['users'][] = $user;
    if ($quota > 0) {
        $db['stats']['totalQuotaGiven'] = (isset($db['stats']['totalQuotaGiven']) ? (int) $db['stats']['totalQuotaGiven'] : 0) + $quota;
    }
    return $user;
}

// 把第三方账号绑定到已登录用户(供设置页「绑定」使用)
function tc_oauth_bind(&$db, $userId, $id, $uid) {
    foreach ($db['users'] as $i => $u) {
        if ((string) $u['id'] !== (string) $userId) continue;
        $oauth = isset($u['oauth']) && is_array($u['oauth']) ? $u['oauth'] : array();
        $oauth[$id] = (string) $uid;
        $db['users'][$i]['oauth'] = $oauth;
        return true;
    }
    return false;
}

// 解除绑定
function tc_oauth_unbind(&$db, $userId, $id) {
    foreach ($db['users'] as $i => $u) {
        if ((string) $u['id'] !== (string) $userId) continue;
        $oauth = isset($u['oauth']) && is_array($u['oauth']) ? $u['oauth'] : array();
        if (!isset($oauth[$id])) return false;
        unset($oauth[$id]);
        $db['users'][$i]['oauth'] = $oauth;
        return true;
    }
    return false;
}

// 该用户已绑定的提供商
function tc_oauth_user_bindings($user) {
    $out = array();
    if (empty($user['oauth']) || !is_array($user['oauth'])) return $out;
    foreach ($user['oauth'] as $pid => $uid) {
        if (tc_oauth_provider($pid)) $out[$pid] = (string) $uid;
    }
    return $out;
}

// 跳转回前台并带上一次性票据(# 片段不发给服务器,读完即清)
function tc_oauth_redirect_with_ticket($userId, $flags = array()) {
    $ticket = tc_oauth_make_ticket($userId);
    $hash = '#oauth_ticket=' . rawurlencode($ticket);
    // 附加标记:created=本次新建了账号(前端据此明确提示,避免用户不知情)
    if (!empty($flags['created'])) $hash .= '&oauth_created=1';
    header('Location: ' . tc_oauth_landing_url() . $hash);
    exit;
}

// 跳转回登录页并带上错误提示
function tc_oauth_redirect_error($msg) {
    header('Location: ' . tc_oauth_landing_url() . '#oauth_error=' . rawurlencode((string) $msg));
    exit;
}

// —— 绑定票据:证明「发起绑定的浏览器就是该账号本人」——
// 绑定入口是导航跳转(不带 Authorization 头),所以前端先带 token 调
// /api/auth/oauth/bind-ticket 换取票据,再带着票据跳转;5 分钟内有效、绑定 uid+provider。
function tc_oauth_make_bind_ticket($userId, $providerId) {
    return tc_jwt_sign(array(
        'sub' => (string) $userId,
        'bt' => 1,
        'pv' => (string) $providerId,
        'jti' => bin2hex(random_bytes(8)),
        'exp' => tc_now() + 300000,
    ));
}

function tc_oauth_check_bind_ticket($ticket, $userId, $providerId) {
    $d = tc_jwt_verify((string) $ticket);
    return is_array($d) && !empty($d['bt']) && (string) $d['sub'] === (string) $userId
        && (string) $d['pv'] === (string) $providerId;
}

// —— 入口一:发起授权 GET /auth/<provider> ——
function tc_oauth_start($id) {
    $id = strtolower((string) $id);
    $settings = null;
    tc_with_db(false, function ($db) use (&$settings) {
        $settings = $db['settings'];
    });
    if (!tc_oauth_ready($settings, $id)) {
        tc_oauth_redirect_error('该登录方式未启用或配置不完整');
    }
    $cfg = $settings['oauthProviders'][$id];
    // 绑定模式:设置页发起绑定时带 ?bind=<uid>&t=<票据>,回调据此走"绑定到已有账号"分支。
    // 必须校验本人:否则任何人拿到目标 uid 就能把自己的第三方身份绑上去接管账号。
    $bindUserId = isset($_GET['bind']) ? trim((string) $_GET['bind']) : '';
    if ($bindUserId !== '') {
        $bindTicket = isset($_GET['t']) ? trim((string) $_GET['t']) : '';
        if ($bindTicket === '' || !tc_oauth_check_bind_ticket($bindTicket, $bindUserId, $id)) {
            tc_oauth_redirect_error('绑定请求无效或已过期，请在设置页重新发起绑定');
        }
    }
    $state = tc_oauth_make_state($id, $bindUserId);
    $url = tc_oauth_authorize_url($id, $cfg, $state);
    if ($url === '') tc_oauth_redirect_error('无法生成授权地址');
    header('Location: ' . $url);
    exit;
}

// —— 入口二:处理回调 GET /auth/<provider>/callback?code=&state= ——
function tc_oauth_callback($id) {
    $id = strtolower((string) $id);
    $code = isset($_GET['code']) ? trim((string) $_GET['code']) : '';
    $state = isset($_GET['state']) ? trim((string) $_GET['state']) : '';
    if (!empty($_GET['error'])) {
        $desc = isset($_GET['error_description']) ? (string) $_GET['error_description'] : (string) $_GET['error'];
        tc_oauth_redirect_error('授权被拒绝或失败：' . $desc);
    }
    if ($code === '') tc_oauth_redirect_error('回调缺少授权码');
    $st = tc_oauth_check_state($state);
    if (!$st || (string) $st['p'] !== $id) tc_oauth_redirect_error('登录状态校验失败，请重新发起');

    // 读取配置并换 token
    $ctx = tc_with_db(false, function ($db) use ($id) {
        if (!tc_oauth_ready($db['settings'], $id)) return array('ok' => false, 'error' => '该登录方式未启用或配置不完整');
        return array('ok' => true, 'cfg' => $db['settings']['oauthProviders'][$id]);
    });
    if (empty($ctx['ok'])) tc_oauth_redirect_error($ctx['error']);

    $ex = tc_oauth_exchange($id, $ctx['cfg'], $code);
    if (empty($ex['ok'])) tc_oauth_redirect_error($ex['error']);
    $profile = tc_oauth_fetch_profile($id, $ctx['cfg'], $ex['token'], isset($ex['uid']) ? $ex['uid'] : '');
    if (empty($profile['ok'])) tc_oauth_redirect_error($profile['error']);

    // 绑定/建号(写库)
    $result = array('ok' => false, 'error' => '登录失败');
    $userId = '';
    $bindUid = isset($st['b']) ? (string) $st['b'] : '';
    tc_with_db(true, function (&$db) use ($id, $profile, $bindUid, $state, &$result, &$userId) {
        // state 一次性消费:同一授权回调只能成功走一次,防截获 state 重放
        if (tc_oauth_state_was_used($db, $state)) {
            $result = array('ok' => false, 'error' => '登录状态已失效，请重新发起');
            return;
        }
        tc_oauth_consume_state($db, $state);
        // 绑定模式:把第三方账号挂到指定本站账号上(要求该账号存在且未被占用)
        if ($bindUid !== '') {
            $target = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === $bindUid) { $target = $u; break; }
            }
            if (!$target) { $result = array('ok' => false, 'error' => '要绑定的账号不存在'); return; }
            $occupied = tc_oauth_find_user($db, $id, $profile['uid']);
            if ($occupied && (string) $occupied['id'] !== $bindUid) {
                $result = array('ok' => false, 'error' => '该' . tc_oauth_provider($id)['name'] . '账号已绑定到其他用户');
                return;
            }
            tc_oauth_bind($db, $bindUid, $id, $profile['uid']);
            foreach ($db['users'] as $i => $u) {
                if ((string) $u['id'] !== $bindUid) continue;
                $db['users'][$i]['oauthName'] = (string) $profile['name'];
                if (!empty($profile['avatar'])) $db['users'][$i]['oauthAvatar'] = (string) $profile['avatar'];
                break;
            }
            tc_log_auth_event('auth', isset($target['name']) ? $target['name'] : '', '绑定第三方账号(' . $id . ')', $bindUid);
            $result = array('ok' => true, 'created' => false, 'bound' => true, 'name' => isset($target['name']) ? $target['name'] : '');
            $userId = $bindUid;
            return;
        }
        $found = tc_oauth_find_user($db, $id, $profile['uid']);
        if ($found) {
            // 已绑定:刷新第三方昵称/头像,更新登录时间
            foreach ($db['users'] as $i => $u) {
                if ((string) $u['id'] !== (string) $found['id']) continue;
                $db['users'][$i]['oauthName'] = (string) $profile['name'];
                if (!empty($profile['avatar'])) $db['users'][$i]['oauthAvatar'] = (string) $profile['avatar'];
                if (!empty($profile['email']) && empty($u['email'])) $db['users'][$i]['email'] = (string) $profile['email'];
                tc_touch_user($db, $found['id']);
                break;
            }
            $result = array('ok' => true, 'created' => false, 'name' => $found['name']);
            $userId = (string) $found['id'];
            return;
        }
        if (empty($db['settings']['oauthAutoRegister'])) {
            $result = array('ok' => false, 'error' => '该第三方账号尚未绑定本站账号，请先登录后在「设置 → 账号」中绑定，或联系管理员开启自动注册');
            return;
        }
        $user = tc_oauth_create_user($db, $id, $profile);
        tc_log_auth_event('auth', $user['name'], '第三方登录注册(' . $id . ')', $user['id']);
        $result = array('ok' => true, 'created' => true, 'name' => $user['name']);
        $userId = (string) $user['id'];
    });
    if (empty($result['ok'])) tc_oauth_redirect_error($result['error']);
    if ($userId === '') tc_oauth_redirect_error('登录失败：无法定位账号');
    // 绑定模式:本地已有登录态,回设置页提示即可(不发登录票据,避免无谓换号)
    if (!empty($result['bound'])) {
        header('Location: ' . tc_oauth_landing_url() . '#oauth_bound=' . rawurlencode($id));
        exit;
    }
    if (empty($result['created'])) {
        tc_log_auth_event('auth', isset($result['name']) ? $result['name'] : '', '第三方登录(' . $id . ')', $userId);
    }
    tc_oauth_redirect_with_ticket($userId, array('created' => !empty($result['created'])));
}

// —— API:用一次性票据换正式登录态 POST /api/auth/oauth/exchange ——
function tc_api_oauth_exchange() {
    $b = tc_read_json_body();
    $ticket = trim((string) (isset($b['ticket']) ? $b['ticket'] : ''));
    if ($ticket === '') tc_fail(400, '缺少登录票据');
    $user = null;
    $settings = null;
    $ticketOk = false;
    tc_with_db(true, function (&$db) use ($ticket, &$user, &$settings, &$ticketOk) {
        $uid = tc_oauth_consume_ticket($db, $ticket);
        if ($uid === '') return;
        $ticketOk = true;
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === $uid) { $user = $u; break; }
        }
        if (!$user) return;
        tc_touch_user($db, $uid);
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === $uid) { $user = $u; break; }
        }
        $settings = $db['settings'];
    });
    if (!$ticketOk) tc_fail(401, '登录票据无效、已使用或已过期，请重新登录');
    if (!$user) tc_fail(401, '账号不存在');
    // 后台要求补全资料、且该账号还没设过密码时,前端进入补全流程
    $needsProfile = !empty($settings['oauthRequireProfile'])
        && (!isset($user['passwordHash']) || (string) $user['passwordHash'] === '');
    $pub = tc_sanitize_user($user);
    tc_json(200, array(
        'token' => tc_issue_token($user, $settings),
        'user' => $pub,
        'needsProfile' => $needsProfile,
    ));
}

// —— API:当前用户已绑定的第三方账号 GET /api/me/oauth ——
function tc_api_me_oauth() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $list = array();
        foreach (tc_oauth_providers() as $pid => $p) {
            $list[] = array(
                'id' => $pid,
                'name' => $p['name'],
                'logo' => $p['logo'],
                'enabled' => tc_oauth_ready($db['settings'], $pid),
                'bound' => !empty($user['oauth'][$pid]),
                'boundName' => !empty($user['oauth'][$pid]) ? (string) (isset($user['oauthName']) ? $user['oauthName'] : '') : '',
            );
        }
        tc_json(200, array('providers' => $list, 'autoRegister' => !empty($db['settings']['oauthAutoRegister'])));
    });
}

// —— API:解绑 DELETE /api/me/oauth/<provider> ——
function tc_api_me_oauth_unbind($id) {
    $id = strtolower((string) $id);
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        if (!tc_oauth_provider($id)) tc_fail(404, '不支持的登录方式');
        // 防呆:没有密码、且解绑后就没有任何第三方绑定时,解绑会让账号彻底无法登录。
        // 明确让用户先设置密码,而不是解绑完才发现登不进来。
        $hasPwd = isset($user['passwordHash']) && (string) $user['passwordHash'] !== '';
        $bindings = tc_oauth_user_bindings($user);
        if (!$hasPwd && count($bindings) <= 1 && isset($bindings[$id])) {
            tc_fail(400, '你还没有设置密码，解绑后此账号将无法登录。请先在「修改密码」中设置密码，再回来解绑。');
        }
        if (!tc_oauth_unbind($db, $user['id'], $id)) tc_fail(400, '该账号未绑定此登录方式');
        tc_json(200, array('ok' => true));
    });
}

// —— 管理端:查看某个用户的第三方绑定情况(后台用户编辑用) ——
function tc_api_admin_user_oauth_list() {
    tc_with_db(false, function ($db) {
        // 第三方绑定属账号隐私(能看出某用户的社交/社区身份),演示管理员不可查看
        tc_demo_guard(tc_require_admin($db), '演示管理员不可查看用户的第三方绑定');
        $q = tc_query();
        $userId = trim((string) (isset($q['userId']) ? $q['userId'] : ''));
        if ($userId === '') tc_fail(400, '缺少 userId');
        $target = null;
        foreach ($db['users'] as $u) if ((string) $u['id'] === $userId) { $target = $u; break; }
        if (!$target) tc_fail(404, '用户不存在');
        $list = array();
        foreach (tc_oauth_providers() as $pid => $p) {
            $bound = !empty($target['oauth'][$pid]);
            $list[] = array(
                'id' => $pid,
                'name' => $p['name'],
                'logo' => $p['logo'],
                'enabled' => tc_oauth_ready($db['settings'], $pid),
                'bound' => $bound,
                'boundName' => $bound ? (string) (isset($target['oauthName']) ? $target['oauthName'] : '') : '',
                // 管理员据此生成绑定链接:让用户在自己浏览器里完成授权,管理员不接触第三方凭据
                'bindUrl' => tc_oauth_start_url_for_admin($pid, $userId),
            );
        }
        $hasPwd = isset($target['passwordHash']) && (string) $target['passwordHash'] !== '';
        tc_json(200, array(
            'user' => array('id' => $target['id'], 'name' => $target['name'], 'hasPassword' => $hasPwd),
            'providers' => $list,
        ));
    });
}

// 生成"由某用户完成绑定"的授权起始链接(管理员复制给用户打开)
function tc_oauth_start_url_for_admin($providerId, $userId) {
    return tc_public_base_url() . '/auth/' . rawurlencode($providerId) . '?bind=' . rawurlencode((string) $userId);
}

// —— 管理端:解除某用户的第三方绑定 ——
function tc_api_admin_user_oauth_unbind($userId, $providerId) {
    tc_with_db(true, function (&$db) use ($userId, $providerId) {
        tc_require_admin($db);
        $providerId = strtolower((string) $providerId);
        if (!tc_oauth_provider($providerId)) tc_fail(404, '不支持的登录方式');
        $target = null;
        foreach ($db['users'] as $u) if ((string) $u['id'] === (string) $userId) { $target = $u; break; }
        if (!$target) tc_fail(404, '用户不存在');
        // 同样防呆:该用户没有密码且这是唯一绑定 → 解绑后他无法登录
        $hasPwd = isset($target['passwordHash']) && (string) $target['passwordHash'] !== '';
        $bindings = tc_oauth_user_bindings($target);
        if (!$hasPwd && count($bindings) <= 1 && isset($bindings[$providerId])) {
            tc_fail(400, '该用户还没有设置密码，解绑后他将无法登录。请先让他在「设置 → 账户」设置密码。');
        }
        if (!tc_oauth_unbind($db, $userId, $providerId)) tc_fail(400, '该用户未绑定此登录方式');
        foreach ($db['users'] as $u) if ((string) $u['id'] === (string) $userId) { $target = $u; break; }
        tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($target)));
    });
}
