<?php
/**
 * E2E 测试用 mock OAuth 提供商:模拟微信 / QQ / LinuxDO / NodeLoc 四家的端点。
 * 用法:php -S 127.0.0.1:8104 tests/mock-oauth.php
 * 配合环境变量(见 tests/e2e.sh)把各提供商的 authorize/token/userinfo 指向本服务。
 *
 * 固定测试数据:
 *   用户 uid=90001 昵称=E2E 测试用户 邮箱=e2e@example.com
 *   特殊 code: code=deny 时返回错误;code=used 时 token 端点报 invalid_grant
 */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$query = $_GET;
$raw = (string) file_get_contents('php://input');

function mj($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
// 统一取参(支持 GET 与表单 POST)
function mparam($k, $raw) {
    if (isset($_GET[$k])) return (string) $_GET[$k];
    $b = array();
    parse_str($raw, $b);
    return isset($b[$k]) ? (string) $b[$k] : '';
}

$UITOKEN = 'MOCK_OAUTH_TOKEN';
$PROFILE = array(
    'id' => 90001,
    'openid' => 'mock-openid-90001',
    'unionid' => 'mock-unionid-90001',
    'username' => 'e2e_oauth_user',
    'name' => 'E2E 测试用户',
    'nickname' => 'E2E 测试用户',
    'avatar_url' => 'https://example.com/e2e-avatar.png',
    'headimgurl' => 'https://example.com/e2e-avatar.png',
    'email' => 'e2e@example.com',
    'trust_level' => 2,
);

// —— 授权端点(四家路径不同) ——
$authPaths = array(
    '/connect/qrconnect',            // 微信
    '/oauth2.0/authorize',           // QQ
    '/oauth2/authorize',             // LinuxDO
    '/oauth-provider/authorize',     // NodeLoc
);
foreach ($authPaths as $ap) {
    if (strpos($uri, $ap) !== false) {
        $redirect = isset($query['redirect_uri']) ? (string) $query['redirect_uri'] : '';
        $state = isset($query['state']) ? (string) $query['state'] : '';
        // 校验必需参数,缺失时报错(便于断言拼参正确)
        $clientId = '';
        foreach (array('appid', 'client_id') as $k) if (isset($query[$k])) $clientId = (string) $query[$k];
        if ($redirect === '' || $clientId === '') {
            http_response_code(400);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'missing redirect_uri or client_id';
            exit;
        }
        if (isset($query['code_hint']) && $query['code_hint'] === 'deny') {
            header('Location: ' . $redirect . '?error=access_denied&error_description=user+denied&state=' . rawurlencode($state));
            exit;
        }
        header('Location: ' . $redirect . '?code=MOCK_OAUTH_CODE&state=' . rawurlencode($state));
        exit;
    }
}

// —— 取 access_token ——
// 微信:GET /sns/oauth2/access_token;QQ:GET /oauth2.0/token;LinuxDO/NodeLoc:POST /oauth2/token 或 /oauth-provider/token
if (strpos($uri, '/sns/oauth2/access_token') !== false) {
    if (mparam('appid', $raw) === '' || mparam('secret', $raw) === '' || mparam('code', $raw) === '') {
        mj(array('errcode' => 40029, 'errmsg' => 'invalid code'), 400);
    }
    mj(array('access_token' => $UITOKEN, 'expires_in' => 7200, 'refresh_token' => 'r', 'openid' => $PROFILE['openid'], 'scope' => 'snsapi_login', 'unionid' => $PROFILE['unionid']));
}
if (preg_match('#/oauth2\.0/token$#', $uri)) {
    if (mparam('code', $raw) === 'used') mj(array('error' => 'invalid_grant', 'error_description' => 'code already used'), 400);
    if (mparam('client_id', $raw) === '' || mparam('client_secret', $raw) === '') {
        mj(array('error' => 'invalid_client', 'error_description' => 'missing client'), 400);
    }
    // QQ 默认返回 urlencoded,带 fmt=json 时返回 JSON
    if (mparam('fmt', $raw) === 'json') mj(array('access_token' => $UITOKEN, 'expires_in' => 7776000, 'refresh_token' => 'r'));
    header('Content-Type: text/plain; charset=utf-8');
    echo 'access_token=' . $UITOKEN . '&expires_in=7776000&refresh_token=r';
    exit;
}
if (preg_match('#/(oauth2/token|oauth-provider/token)$#', $uri)) {
    $grant = mparam('grant_type', $raw);
    if ($grant !== 'authorization_code') mj(array('error' => 'unsupported_grant_type'), 400);
    if (mparam('code', $raw) === 'used') mj(array('error' => 'invalid_grant', 'error_description' => 'code already used'), 400);
    foreach (array('code', 'redirect_uri', 'client_id', 'client_secret') as $k) {
        if (mparam($k, $raw) === '') mj(array('error' => 'invalid_request', 'error_description' => 'missing ' . $k), 400);
    }
    mj(array('access_token' => $UITOKEN, 'token_type' => 'Bearer', 'expires_in' => 7200, 'scope' => 'openid profile email'));
}

// —— 取 OpenID(QQ 专属) ——
if (preg_match('#/oauth2\.0/me$#', $uri)) {
    if (isset($query['fmt']) && $query['fmt'] === 'json') mj(array('client_id' => 'mock-app', 'openid' => $PROFILE['openid']));
    header('Content-Type: text/plain; charset=utf-8');
    echo 'callback( {"client_id":"mock-app","openid":"' . $PROFILE['openid'] . '"} );';
    exit;
}

// —— 取用户资料 ——
if (strpos($uri, '/sns/userinfo') !== false) {
    if (isset($query['access_token']) && $query['access_token'] !== $UITOKEN) mj(array('errcode' => 40001, 'errmsg' => 'invalid token'), 400);
    mj(array('openid' => $PROFILE['openid'], 'nickname' => $PROFILE['nickname'], 'sex' => 1, 'headimgurl' => $PROFILE['headimgurl'], 'unionid' => $PROFILE['unionid']));
}
if (strpos($uri, '/user/get_user_info') !== false) {
    if (mparam('openid', $raw) === '') mj(array('ret' => 1002, 'msg' => 'missing openid'), 200);
    mj(array('ret' => 0, 'msg' => '', 'nickname' => $PROFILE['nickname'], 'figureurl_qq_2' => $PROFILE['headimgurl'], 'gender' => '男'));
}
if (preg_match('#/(api/user|oauth-provider/userinfo)$#', $uri)) {
    $auth = isset($_SERVER['HTTP_AUTHORIZATION']) ? (string) $_SERVER['HTTP_AUTHORIZATION'] : '';
    if ($auth !== 'Bearer ' . $UITOKEN) mj(array('error' => 'invalid_token'), 401);
    mj(array(
        'id' => $PROFILE['id'], 'sub' => (string) $PROFILE['id'],
        'username' => $PROFILE['username'], 'name' => $PROFILE['name'],
        'preferred_username' => $PROFILE['username'],
        'avatar_url' => $PROFILE['avatar_url'], 'picture' => $PROFILE['avatar_url'],
        'email' => $PROFILE['email'], 'trust_level' => $PROFILE['trust_level'],
    ));
}

mj(array('error' => 'not_found', 'path' => $uri), 404);
