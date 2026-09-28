<?php
/**
 * TinyChat PHP 核心：配置、JSON 库、JWT、密码、日志、限流。
 */
if (!defined('TC_ROOT')) {
    define('TC_ROOT', dirname(__DIR__));
}

define('TC_VERSION', '1.7.1');
define('TC_DB_VERSION', 2);
define('TC_PBKDF2_ITER', 120000);
define('TC_LOG_LIMIT', 500);
// 邮件默认模板版本:升级默认样式时 +1,旧默认(或为空)会自动换成新版,自定义模板不受影响
define('TC_MAIL_TPL_VERSION', 2);

// 默认邮件模板:同一套卡片式外壳,占位符 {siteName} {name} {link} {expires}
function tc_mail_default_templates() {
    $shell = function ($title, $introHtml, $buttonText, $noteText) {
        return '<!DOCTYPE html>'
            . '<html lang="zh-CN"><body style="margin:0;padding:0;background:#eef1f6;">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f6;padding:36px 16px;">'
            . '<tr><td align="center">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">'
            . '<tr><td style="background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',Helvetica,Arial,sans-serif;">'
            . '<div style="height:5px;background:#4f46e5;line-height:5px;font-size:0;">&nbsp;</div>'
            . '<div style="padding:34px 40px 0;">'
            . '<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:#eef2ff;color:#4f46e5;font-size:12px;font-weight:600;letter-spacing:0.5px;">{siteName}</span>'
            . '<h1 style="margin:18px 0 0;font-size:21px;line-height:1.4;color:#0f172a;font-weight:700;">' . $title . '</h1>'
            . '<div style="margin:14px 0 0;font-size:14px;line-height:1.85;color:#475569;">' . $introHtml . '</div>'
            . '</div>'
            . '<div style="padding:26px 40px 0;text-align:center;">'
            . '<a href="{link}" style="display:inline-block;background:#4f46e5;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 38px;border-radius:12px;">' . $buttonText . '</a>'
            . '</div>'
            . '<div style="padding:22px 40px 0;">'
            . '<p style="margin:0;font-size:12.5px;line-height:1.8;color:#94a3b8;word-break:break-all;">若按钮无法点击，请复制以下链接到浏览器打开：<br><a href="{link}" style="color:#4f46e5;text-decoration:none;">{link}</a></p>'
            . '<p style="margin:12px 0 0;font-size:12.5px;line-height:1.8;color:#94a3b8;">' . $noteText . '如果这不是你本人操作，可以放心忽略这封邮件。</p>'
            . '</div>'
            . '<div style="padding:26px 40px 30px;">'
            . '<div style="height:1px;background:#e8ecf3;line-height:1px;font-size:0;">&nbsp;</div>'
            . '<p style="margin:14px 0 0;font-size:12px;color:#b6c0cf;text-align:center;">此邮件由 {siteName} 系统发送，请勿直接回复</p>'
            . '</div>'
            . '</td></tr></table>'
            . '</td></tr></table>'
            . '</body></html>';
    };
    return array(
        'tplVersion' => TC_MAIL_TPL_VERSION,
        'verifySubject' => '验证你的 {siteName} 账号',
        'verifyHtml' => $shell(
            '验证你的邮箱',
            '<p style="margin:0;">你好，<b style="color:#0f172a;">{name}</b>：</p><p style="margin:10px 0 0;">感谢注册 {siteName}。点击下方按钮完成邮箱验证，即可开始使用全部功能。</p>',
            '验证邮箱',
            '链接 {expires} 内有效。'
        ),
        'resetSubject' => '重置你的 {siteName} 密码',
        'resetHtml' => $shell(
            '重置你的密码',
            '<p style="margin:0;">你好，<b style="color:#0f172a;">{name}</b>：</p><p style="margin:10px 0 0;">我们收到了你重置 {siteName} 账号密码的请求。点击下方按钮设置新密码。</p>',
            '重置密码',
            '链接 {expires} 内有效。'
        ),
    );
}

$TC_SETTINGS_DEFAULTS = array(
    'siteName' => 'TinyChat',
    'allowRegister' => true,
    'freeQuota' => 100,
    'freeQuotaUnlimited' => false,
    'allowUserProviders' => true,
    'emailVerificationEnabled' => false,
    'passwordResetEnabled' => false,
    'smtp' => array(),
    'mailTemplates' => null, // 下面统一赋值,避免默认数组里塞大段 HTML
    'packages' => array(),
    'proxyTimeoutMs' => 120000,
    'loginMaxFails' => 5,
    'loginLockMs' => 60000,
    'webSearchEnabled' => false,
    'webSearchProvider' => 'tavily',
    'webSearchTavilyKey' => '',
    'webSearchSearxUrl' => '',
    'webSearchMaxResults' => 5,
    'webSearchAllowUser' => false,
    'urlReadEnabled' => true,
    'urlReadMax' => 3,
    'mineruToken' => '',
    'mineruAllowUser' => false,
    'defaultGroupId' => '',
    'contextMessages' => 40,
    'maxContextMessages' => 200,
    'maxOutputTokens' => 12800,
    // 全局采样温度: null = 不发送该参数(用模型默认);设置后 0-2
    'temperature' => null,
    // 数据备份:每日自动备份 data/db.json,保留最近 N 份
    'backupEnabled' => true,
    'backupKeep' => 7,
    // 代理接口限流:每用户每分钟最大请求数,0 = 不限制
    'rateLimitPerMin' => 30,
    // 会话:登录态有效天数;authEpoch 递增可强制全站重新登录
    'sessionDays' => 7,
    'authEpoch' => 1,
    // 从上游 context length 报错自动回填模型的 maxContext(不覆盖手动设置)
    'contextAutoLearn' => true,
    // 内容审核:发送前对用户消息做敏感词过滤
    'moderation' => array('enabled' => false, 'words' => ''),
    // 用户协议:启用后注册页需勾选同意,/agreement 展示协议正文
    'agreementEnabled' => false,
    'agreementHtml' => '',
    // 隐私:关闭后服务器不保存对话记录(客户端仅本地留存)
    'persistChats' => true,
    // 全站公告:enabled 且 text 非空时前台展示
    'announcement' => array('enabled' => false, 'text' => '', 'updatedAt' => 0),
    // OpenAI 兼容 API 出口:允许用户生成 sk- 密钥通过第三方客户端调用
    'apiKeysEnabled' => true,
    // 注册邀请码:开启后注册必须提供有效邀请码
    'registerInviteRequired' => false,
);
$TC_SETTINGS_DEFAULTS['mailTemplates'] = tc_mail_default_templates();

function tc_load_config() {
    $cfg = array(
        'admin_name' => getenv('ADMIN_NAME') ?: 'admin',
        'admin_password' => getenv('ADMIN_PASSWORD') ?: '',
        'jwt_secret' => getenv('JWT_SECRET') ?: '',
        'cors_origin' => getenv('CORS_ORIGIN') ?: '*',
        'data_dir' => getenv('DATA_DIR') ?: '',
        'site_url' => getenv('SITE_URL') ?: '',
    );
    $file = TC_ROOT . '/config.php';
    if (is_file($file)) {
        $user = include $file;
        if (is_array($user)) $cfg = array_merge($cfg, $user);
    }
    return $cfg;
}

function tc_cfg($key = null) {
    static $cfg = null;
    if ($cfg === null) $cfg = tc_load_config();
    if ($key === null) return $cfg;
    return isset($cfg[$key]) ? $cfg[$key] : null;
}

function tc_data_dir() {
    $dir = tc_cfg('data_dir');
    if (!$dir) $dir = TC_ROOT . '/data';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_cacert_path() {
    static $path = null;
    if ($path !== null) return $path;
    $candidates = array(
        TC_ROOT . '/lib/cacert.pem',
        ini_get('curl.cainfo'),
        ini_get('openssl.cafile'),
        getenv('SSL_CERT_FILE'),
        getenv('CURL_CA_BUNDLE'),
    );
    foreach ($candidates as $c) {
        if ($c && is_file($c) && is_readable($c)) {
            $path = $c;
            return $path;
        }
    }
    $path = '';
    return $path;
}

function tc_now() {
    return (int) round(microtime(true) * 1000);
}

function tc_public_base_url() {
    $configured = trim((string) tc_cfg('site_url'));
    if ($configured !== '') return rtrim($configured, '/');
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = isset($_SERVER['HTTP_HOST']) ? preg_replace('/[^A-Za-z0-9.:-]/', '', (string) $_SERVER['HTTP_HOST']) : 'localhost';
    $script = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/'));
    $script = rtrim($script, '/');
    return $scheme . '://' . $host . ($script === '/' ? '' : $script);
}

function tc_public_link($path, $token) {
    return tc_public_base_url() . '/' . ltrim($path, '/') . '?token=' . rawurlencode($token);
}

function tc_uid($len = 16) {
    return bin2hex(random_bytes($len));
}

function tc_today_key($ms = null) {
    $t = $ms ? (int) floor($ms / 1000) : time();
    return date('Y-m-d', $t);
}

function tc_b64url($bin) {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function tc_b64url_decode($str) {
    $b = strtr((string) $str, '-_', '+/');
    $pad = strlen($b) % 4;
    if ($pad) $b .= str_repeat('=', 4 - $pad);
    return base64_decode($b);
}

function tc_json_encode($obj) {
    return json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

// AI 思考策略:全局默认 + 按模型规则(自动学习/手动配置),保证各上游都能接受推理参数
function tc_normalize_thinking($raw) {
    $t = is_array($raw) ? $raw : array();
    $efforts = array('off', 'low', 'medium', 'high');
    $def = isset($t['defaultEffort']) && in_array($t['defaultEffort'], $efforts, true) ? $t['defaultEffort'] : 'medium';
    $rules = array();
    foreach ((array) (isset($t['rules']) ? $t['rules'] : array()) as $r) {
        if (!is_array($r)) continue;
        $match = substr(trim((string) (isset($r['match']) ? $r['match'] : '')), 0, 80);
        if ($match === '') continue;
        $mode = (isset($r['mode']) && in_array($r['mode'], array('map', 'force', 'off'), true)) ? $r['mode'] : 'map';
        $levels = array();
        foreach ((array) (isset($r['levels']) ? $r['levels'] : array()) as $lv) {
            $lv = strtolower(trim((string) $lv));
            if (in_array($lv, array('minimal', 'none', 'low', 'medium', 'high', 'max'), true) && !in_array($lv, $levels, true)) $levels[] = $lv;
        }
        $force = strtolower(trim((string) (isset($r['forceEffort']) ? $r['forceEffort'] : '')));
        $rules[] = array(
            'id' => substr(trim((string) (isset($r['id']) ? $r['id'] : '')), 0, 24) ?: tc_uid(8),
            'match' => $match,
            'mode' => $mode,
            'levels' => $levels,
            'forceEffort' => in_array($force, array('low', 'medium', 'high', 'max'), true) ? $force : '',
            'enabled' => !array_key_exists('enabled', $r) || !empty($r['enabled']),
            'source' => ((isset($r['source']) ? $r['source'] : 'manual') === 'auto') ? 'auto' : 'manual',
            'updatedAt' => (int) (isset($r['updatedAt']) ? $r['updatedAt'] : tc_now()),
        );
    }
    return array(
        'defaultEffort' => $def,
        'allowUserOverride' => !array_key_exists('allowUserOverride', $t) || !empty($t['allowUserOverride']),
        'autoLearn' => !array_key_exists('autoLearn', $t) || !empty($t['autoLearn']),
        'rules' => $rules,
    );
}

// 档位序(从轻到重);取离当前档位最近的受支持档位,优先向上取
function tc_nearest_effort($cur, $levels) {
    $order = array('minimal', 'none', 'low', 'medium', 'high', 'max');
    $idx = array_search(strtolower((string) $cur), $order, true);
    if ($idx === false) return (string) $levels[0];
    for ($i = $idx + 1; $i < count($order); $i++) if (in_array($order[$i], $levels, true)) return $order[$i];
    for ($i = $idx - 1; $i >= 0; $i--) if (in_array($order[$i], $levels, true)) return $order[$i];
    return (string) $levels[0];
}

function tc_thinking_effort_set(&$body, $value) {
    if (array_key_exists('reasoning_effort', $body)) $body['reasoning_effort'] = $value;
    if (array_key_exists('thinking_effort', $body)) $body['thinking_effort'] = $value;
    if (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning'])) $body['reasoning']['effort'] = $value;
    if (isset($body['output_config']) && is_array($body['output_config']) && array_key_exists('effort', $body['output_config'])) $body['output_config']['effort'] = $value;
}

// 请求发出前套用思考策略:规则匹配模型 ID(包含匹配),首个命中的生效
// 规则:off=移除推理参数;force=强制档位;map=当前档位不在支持列表内时就近修正
// 无规则命中时:若管理员关闭了"用户自选",统一改写为全局默认档位
function tc_apply_thinking_rules(&$body, $thinking) {
    $model = strtolower((string) (isset($body['model']) ? $body['model'] : ''));
    if ($model === '' || !is_array($thinking)) return;
    $rules = is_array(isset($thinking['rules']) ? $thinking['rules'] : null) ? $thinking['rules'] : array();
    foreach ($rules as $rule) {
        if (empty($rule['enabled'])) continue;
        $match = strtolower((string) (isset($rule['match']) ? $rule['match'] : ''));
        if ($match === '' || strpos($model, $match) === false) continue;
        $mode = isset($rule['mode']) ? $rule['mode'] : 'map';
        if ($mode === 'off') {
            tc_strip_reasoning_params($body, array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'output_config'));
            return;
        }
        if ($mode === 'force') {
            $force = (string) (isset($rule['forceEffort']) ? $rule['forceEffort'] : '');
            if ($force !== '') tc_thinking_effort_set($body, $force);
            return;
        }
        $levels = is_array(isset($rule['levels']) ? $rule['levels'] : null) ? array_map('strtolower', $rule['levels']) : array();
        if (!$levels) return;
        foreach (array('reasoning_effort', 'thinking_effort') as $key) {
            if (array_key_exists($key, $body) && !in_array(strtolower((string) $body[$key]), $levels, true)) $body[$key] = tc_nearest_effort($body[$key], $levels);
        }
        if (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning']) && !in_array(strtolower((string) $body['reasoning']['effort']), $levels, true)) {
            $body['reasoning']['effort'] = tc_nearest_effort($body['reasoning']['effort'], $levels);
        }
        if (isset($body['output_config']) && is_array($body['output_config']) && array_key_exists('effort', $body['output_config']) && !in_array(strtolower((string) $body['output_config']['effort']), $levels, true)) {
            $body['output_config']['effort'] = tc_nearest_effort($body['output_config']['effort'], $levels);
        }
        return;
    }
    if (empty($thinking['allowUserOverride'])) {
        $def = (string) (isset($thinking['defaultEffort']) ? $thinking['defaultEffort'] : 'medium');
        if ($def === 'off') tc_strip_reasoning_params($body, array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'output_config'));
        else tc_thinking_effort_set($body, $def);
    }
}

function tc_normalize_settings($raw) {
    global $TC_SETTINGS_DEFAULTS;
    $s = array_merge($TC_SETTINGS_DEFAULTS, is_array($raw) ? $raw : array());
    $s['thinking'] = tc_normalize_thinking(isset($s['thinking']) ? $s['thinking'] : null);
    $s['siteName'] = substr((string) (isset($s['siteName']) ? $s['siteName'] : $TC_SETTINGS_DEFAULTS['siteName']), 0, 40);
    $s['allowRegister'] = !empty($s['allowRegister']);
    $s['allowUserProviders'] = !empty($s['allowUserProviders']);
    $s['freeQuotaUnlimited'] = !empty($s['freeQuotaUnlimited']);
    $s['freeQuota'] = max(0, (int) $s['freeQuota']);
    $s['emailVerificationEnabled'] = !empty($s['emailVerificationEnabled']);
    $s['passwordResetEnabled'] = !empty($s['passwordResetEnabled']);
    $smtp = is_array($s['smtp']) ? $s['smtp'] : array();
    $tpl = is_array($s['mailTemplates']) ? $s['mailTemplates'] : array();
    // 模板版本升级:仅当存储的仍是旧版默认(或为空)时换成新版默认,管理员自定义的不动
    if (((int) ($tpl['tplVersion'] ?? 0)) < TC_MAIL_TPL_VERSION) {
        $oldVerify = '<p>你好，{name}：</p><p>请点击下面的链接验证邮箱：</p><p><a href="{link}">验证邮箱</a></p>';
        $oldReset = '<p>你好，{name}：</p><p>请点击下面的链接重置密码：</p><p><a href="{link}">重置密码</a></p>';
        $verifyIsPristine = ((string) ($tpl['verifyHtml'] ?? '') === '' || (string) ($tpl['verifyHtml'] ?? '') === $oldVerify);
        $resetIsPristine = ((string) ($tpl['resetHtml'] ?? '') === '' || (string) ($tpl['resetHtml'] ?? '') === $oldReset);
        if ($verifyIsPristine && $resetIsPristine) $tpl = array();
        $tpl['tplVersion'] = TC_MAIL_TPL_VERSION;
    }
    $s['mailTemplates'] = array_merge($TC_SETTINGS_DEFAULTS['mailTemplates'], $tpl);
    $s['smtp'] = array('host' => substr(trim((string) ($smtp['host'] ?? '')), 0, 180), 'port' => min(65535, max(1, (int) ($smtp['port'] ?? 587))), 'username' => substr(trim((string) ($smtp['username'] ?? '')), 0, 180), 'password' => (string) ($smtp['password'] ?? ''), 'encryption' => in_array(($smtp['encryption'] ?? 'tls'), array('none','ssl','tls'), true) ? ($smtp['encryption'] ?? 'tls') : 'tls', 'fromName' => substr(trim((string) ($smtp['fromName'] ?? 'TinyChat')), 0, 80), 'fromEmail' => substr(trim((string) ($smtp['fromEmail'] ?? '')), 0, 180));
    $timeout = isset($s['proxyTimeoutMs']) ? (int) $s['proxyTimeoutMs'] : $TC_SETTINGS_DEFAULTS['proxyTimeoutMs'];
    $s['proxyTimeoutMs'] = min(600000, max(5000, $timeout ?: $TC_SETTINGS_DEFAULTS['proxyTimeoutMs']));
    $s['loginMaxFails'] = min(50, max(0, (int) $s['loginMaxFails']));
    $s['loginLockMs'] = min(3600000, max(0, (int) $s['loginLockMs']));
    $s['webSearchEnabled'] = !empty($s['webSearchEnabled']);
    $prov = strtolower(trim((string) (isset($s['webSearchProvider']) ? $s['webSearchProvider'] : 'tavily')));
    $s['webSearchProvider'] = ($prov === 'searxng') ? 'searxng' : 'tavily';
    $s['webSearchTavilyKey'] = substr(trim((string) (isset($s['webSearchTavilyKey']) ? $s['webSearchTavilyKey'] : '')), 0, 200);
    $s['webSearchSearxUrl'] = tc_searx_urls_text(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '');
    $max = isset($s['webSearchMaxResults']) ? (int) $s['webSearchMaxResults'] : 5;
    $s['webSearchMaxResults'] = min(8, max(1, $max ?: 5));
    $s['webSearchAllowUser'] = !empty($s['webSearchAllowUser']);
    // 链接读取:用户消息里的 http(s) 链接自动抓取正文作为回答材料
    $s['urlReadEnabled'] = !array_key_exists('urlReadEnabled', $s) || !empty($s['urlReadEnabled']);
    $s['urlReadMax'] = min(5, max(1, (int) (isset($s['urlReadMax']) ? $s['urlReadMax'] : 3) ?: 3));
    $s['mineruToken'] = substr(trim((string) (isset($s['mineruToken']) ? $s['mineruToken'] : '')), 0, 300);
    $s['mineruAllowUser'] = !empty($s['mineruAllowUser']);
    $s['defaultGroupId'] = substr(trim((string) (isset($s['defaultGroupId']) ? $s['defaultGroupId'] : '')), 0, 64);
    $maxCtx = isset($s['maxContextMessages']) ? (int) $s['maxContextMessages'] : $TC_SETTINGS_DEFAULTS['maxContextMessages'];
    $s['maxContextMessages'] = min(500, max(2, $maxCtx ?: $TC_SETTINGS_DEFAULTS['maxContextMessages']));
    $ctx = isset($s['contextMessages']) ? (int) $s['contextMessages'] : $TC_SETTINGS_DEFAULTS['contextMessages'];
    $s['contextMessages'] = min($s['maxContextMessages'], max(2, $ctx ?: $TC_SETTINGS_DEFAULTS['contextMessages']));
    $out = isset($s['maxOutputTokens']) ? (int) $s['maxOutputTokens'] : $TC_SETTINGS_DEFAULTS['maxOutputTokens'];
    $s['maxOutputTokens'] = min(128000, max(256, $out ?: $TC_SETTINGS_DEFAULTS['maxOutputTokens']));
    $temp = isset($s['temperature']) && $s['temperature'] !== '' && $s['temperature'] !== null ? (float) $s['temperature'] : null;
    $s['temperature'] = $temp === null ? null : min(2, max(0, $temp));
    $s['backupEnabled'] = !array_key_exists('backupEnabled', $s) || !empty($s['backupEnabled']);
    $s['backupKeep'] = min(30, max(1, (int) (isset($s['backupKeep']) ? $s['backupKeep'] : 7) ?: 7));
    $s['rateLimitPerMin'] = min(600, max(0, (int) (isset($s['rateLimitPerMin']) ? $s['rateLimitPerMin'] : 30)));
    $s['sessionDays'] = min(30, max(1, (int) (isset($s['sessionDays']) ? $s['sessionDays'] : 7) ?: 7));
    $s['authEpoch'] = max(1, (int) (isset($s['authEpoch']) ? $s['authEpoch'] : 1));
    $s['contextAutoLearn'] = !array_key_exists('contextAutoLearn', $s) || !empty($s['contextAutoLearn']);
    $mod = isset($s['moderation']) && is_array($s['moderation']) ? $s['moderation'] : array();
    $s['moderation'] = array(
        'enabled' => !empty($mod['enabled']),
        'words' => tc_moderation_words_text(isset($mod['words']) ? $mod['words'] : ''),
    );
    $s['agreementEnabled'] = !empty($s['agreementEnabled']);
    $s['agreementHtml'] = substr((string) (isset($s['agreementHtml']) ? $s['agreementHtml'] : ''), 0, 200000);
    $s['persistChats'] = !array_key_exists('persistChats', $s) || !empty($s['persistChats']);
    $ann = isset($s['announcement']) && is_array($s['announcement']) ? $s['announcement'] : array();
    $annText = trim((string) (isset($ann['text']) ? $ann['text'] : ''));
    $annChanged = isset($ann['updatedAt']) ? (int) $ann['updatedAt'] : 0;
    $s['announcement'] = array(
        'enabled' => !empty($ann['enabled']) && $annText !== '',
        'text' => substr($annText, 0, 2000),
        'updatedAt' => $annChanged,
    );
    $s['apiKeysEnabled'] = !array_key_exists('apiKeysEnabled', $s) || !empty($s['apiKeysEnabled']);
    $s['registerInviteRequired'] = !empty($s['registerInviteRequired']);
    return $s;
}

function tc_searx_urls_text($raw) {
    $out = array();
    $seen = array();
    foreach (preg_split('/[\s,;]+/', (string) $raw) as $part) {
        $u = rtrim(trim($part), '/');
        if ($u === '' || !preg_match('#^https?://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $u;
        if (count($out) >= 12) break;
    }
    return substr(implode("\n", $out), 0, 2400);
}

function tc_searx_url_list($raw) {
    $text = tc_searx_urls_text($raw);
    if ($text === '') return array();
    return explode("\n", $text);
}

function tc_web_search_ready($s) {
    if (empty($s['webSearchEnabled'])) return false;
    if (isset($s['webSearchProvider']) && $s['webSearchProvider'] === 'searxng') {
        return tc_searx_url_list(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '') !== array();
    }
    return trim((string) (isset($s['webSearchTavilyKey']) ? $s['webSearchTavilyKey'] : '')) !== '';
}

function tc_mineru_token($s) {
    return trim((string) (isset($s['mineruToken']) ? $s['mineruToken'] : ''));
}

function tc_user_tools($u) {
    $raw = (isset($u['tools']) && is_array($u['tools'])) ? $u['tools'] : array();
    $src = isset($raw['webSearchSource']) ? (string) $raw['webSearchSource'] : 'platform';
    $parse = isset($raw['parseSource']) ? (string) $raw['parseSource'] : 'platform';
    $provider = isset($raw['webSearchProvider']) && $raw['webSearchProvider'] === 'searxng' ? 'searxng' : 'tavily';
    $max = isset($raw['webSearchMaxResults']) ? (int) $raw['webSearchMaxResults'] : 5;
    return array(
        'webSearchSource' => $src === 'own' ? 'own' : 'platform',
        'webSearchProvider' => $provider,
        'webSearchTavilyKey' => substr(trim((string) (isset($raw['webSearchTavilyKey']) ? $raw['webSearchTavilyKey'] : '')), 0, 200),
        'webSearchSearxUrl' => tc_searx_urls_text(isset($raw['webSearchSearxUrl']) ? $raw['webSearchSearxUrl'] : ''),
        'webSearchMaxResults' => min(8, max(1, $max ?: 5)),
        'parseSource' => $parse === 'own' ? 'own' : 'platform',
        'mineruToken' => substr(trim((string) (isset($raw['mineruToken']) ? $raw['mineruToken'] : '')), 0, 300),
    );
}

function tc_user_search_settings($user, $site) {
    $tools = tc_user_tools($user);
    if (!empty($site['webSearchAllowUser']) && $tools['webSearchSource'] === 'own') {
        return array(
            'webSearchEnabled' => true,
            'webSearchProvider' => $tools['webSearchProvider'],
            'webSearchTavilyKey' => $tools['webSearchTavilyKey'],
            'webSearchSearxUrl' => $tools['webSearchSearxUrl'],
            'webSearchMaxResults' => $tools['webSearchMaxResults'],
        );
    }
    return $site;
}

function tc_user_mineru_token($user, $site) {
    $tools = tc_user_tools($user);
    if (!empty($site['mineruAllowUser']) && $tools['parseSource'] === 'own') return $tools['mineruToken'];
    return tc_mineru_token($site);
}

function tc_user_tools_public($user, $site) {
    $tools = tc_user_tools($user);
    $ownSearch = $tools['webSearchProvider'] === 'searxng'
        ? ($tools['webSearchSearxUrl'] !== '')
        : ($tools['webSearchTavilyKey'] !== '');
    return array(
        'webSearch' => array(
            'allowOwn' => !empty($site['webSearchAllowUser']),
            'platformReady' => tc_web_search_ready($site),
            'source' => $tools['webSearchSource'],
            'provider' => $tools['webSearchProvider'],
            'hasKey' => $tools['webSearchTavilyKey'] !== '',
            'keyMask' => $tools['webSearchTavilyKey'] !== '' ? tc_mask_key($tools['webSearchTavilyKey']) : '',
            'searxUrl' => $tools['webSearchSearxUrl'],
            'maxResults' => $tools['webSearchMaxResults'],
            'ownReady' => $ownSearch,
        ),
        'parse' => array(
            'allowOwn' => !empty($site['mineruAllowUser']),
            'platformMode' => tc_mineru_token($site) !== '' ? 'precise' : 'lite',
            'source' => $tools['parseSource'],
            'hasToken' => $tools['mineruToken'] !== '',
            'tokenMask' => $tools['mineruToken'] !== '' ? tc_mask_key($tools['mineruToken']) : '',
        ),
    );
}

function tc_mineru_public($s) {
    return array(
        'enabled' => true,
        'mode' => tc_mineru_token($s) !== '' ? 'precise' : 'lite',
        'allowOwn' => !empty($s['mineruAllowUser']),
    );
}

function tc_web_search_public($s) {
    return array(
        'enabled' => tc_web_search_ready($s),
        'provider' => (isset($s['webSearchProvider']) && $s['webSearchProvider'] === 'searxng') ? 'searxng' : 'tavily',
        'allowOwn' => !empty($s['webSearchAllowUser']),
    );
}

function tc_admin_settings_public($s) {
    $out = is_array($s) ? $s : array();
    if (!empty($out['webSearchTavilyKey'])) $out['webSearchTavilyKey'] = tc_mask_key($out['webSearchTavilyKey']);
    if (!empty($out['mineruToken'])) $out['mineruToken'] = tc_mask_key($out['mineruToken']);
    if (!empty($out['smtp']['password'])) $out['smtp']['password'] = tc_mask_key($out['smtp']['password']);
    $out['webSearchAllowUser'] = !empty($out['webSearchAllowUser']);
    $out['mineruAllowUser'] = !empty($out['mineruAllowUser']);
    return $out;
}

function tc_empty_db() {
    return array(
        'version' => TC_DB_VERSION,
        'users' => array(),
        'providers' => array(),
        'defaultProviderId' => null,
        'stats' => array('totalCalls' => 0, 'totalQuotaGiven' => 0, 'callsByDay' => new stdClass(), 'modelVotes' => new stdClass(), 'usageLedger' => new stdClass(), 'modelHealth' => new stdClass()),
        'settings' => tc_normalize_settings(null),
        'userChats' => new stdClass(),
        'shares' => new stdClass(),
        'userGroups' => array(),
        'accessRules' => array(),
        'assistantCategories' => array(),
        'assistants' => array(),
        'packages' => array(),
        'redemptionCodes' => array(),
        'quotaLedger' => array(),
        'inviteCodes' => array(),
    );
}

function tc_assoc($v) {
    if (is_object($v)) $v = (array) $v;
    return is_array($v) ? $v : array();
}

function tc_object_map($v) {
    if ($v instanceof stdClass) return $v;
    if (!is_array($v)) return new stdClass();
    $o = new stdClass();
    foreach ($v as $k => $val) $o->{$k} = $val;
    return $o;
}

function tc_group_by_id($db, $id) {
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['id']) && (string) $g['id'] === (string) $id) return $g;
    }
    return null;
}

function tc_grant_group_all_globals(&$db, $gid) {
    $seen = array();
    foreach ((isset($db['accessRules']) ? $db['accessRules'] : array()) as $r) {
        if (isset($r['groupId']) && $r['groupId'] === $gid && isset($r['providerId'])) $seen[$r['providerId']] = true;
    }
    $added = false;
    foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
        if (!isset($p['scope']) || $p['scope'] !== 'global' || empty($p['id'])) continue;
        if (isset($seen[$p['id']])) continue;
        $db['accessRules'][] = array('id' => tc_uid(), 'groupId' => $gid, 'providerId' => $p['id'], 'modelIds' => array('*'));
        $added = true;
    }
    return $added;
}

function tc_find_builtin_group($db, $role) {
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['role']) && $g['role'] === $role) return $g;
    }
    return null;
}

function tc_ensure_builtin_group(&$db, $role, $name) {
    $groups = isset($db['userGroups']) && is_array($db['userGroups']) ? $db['userGroups'] : array();
    $idx = -1;
    foreach ($groups as $i => $g) {
        if ((isset($g['role']) && $g['role'] === $role) || (isset($g['name']) && $g['name'] === $name)) {
            $idx = $i;
            break;
        }
    }
    $fresh = false;
    if ($idx < 0) {
        $db['userGroups'][] = array(
            'id' => tc_uid(), 'name' => $name, 'createdAt' => tc_now(),
            'builtin' => true, 'role' => $role,
        );
        $idx = count($db['userGroups']) - 1;
        $fresh = true;
    } else {
        if (empty($db['userGroups'][$idx]['builtin'])) $db['userGroups'][$idx]['builtin'] = true;
        if (!isset($db['userGroups'][$idx]['role']) || $db['userGroups'][$idx]['role'] !== $role) {
            $db['userGroups'][$idx]['role'] = $role;
        }
        if (!isset($db['userGroups'][$idx]['name']) || $db['userGroups'][$idx]['name'] !== $name) {
            $db['userGroups'][$idx]['name'] = $name;
        }
    }
    $gid = $db['userGroups'][$idx]['id'];
    if ($fresh) tc_grant_group_all_globals($db, $gid);
    return $gid;
}

function tc_ensure_default_group(&$db) {
    $userGid = tc_ensure_builtin_group($db, 'user', '默认用户组');
    $adminGid = tc_ensure_builtin_group($db, 'admin', '管理员');
    tc_grant_group_all_globals($db, $adminGid);
    foreach ($db['users'] as &$u) {
        $gid = isset($u['groupId']) ? (string) $u['groupId'] : '';
        if (!empty($u['admin'])) {
            if ($gid === '' || !tc_group_by_id($db, $gid)) $u['groupId'] = $adminGid;
        } elseif ($gid === '' || !tc_group_by_id($db, $gid)) {
            $u['groupId'] = $userGid;
        }
    }
    unset($u);
    $current = isset($db['settings']['defaultGroupId']) ? (string) $db['settings']['defaultGroupId'] : '';
    if ($current === '' || $current === $adminGid || !tc_group_by_id($db, $current)) {
        $db['settings']['defaultGroupId'] = $userGid;
    }
    return true;
}

function tc_default_register_group($db) {
    $id = isset($db['settings']['defaultGroupId']) ? (string) $db['settings']['defaultGroupId'] : '';
    if ($id !== '' && tc_group_by_id($db, $id)) return $id;
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['name']) && $g['name'] === '默认用户组') return $g['id'];
    }
    return null;
}

function tc_migrate_db($raw) {
    $base = tc_empty_db();
    $db = array_merge($base, is_array($raw) ? $raw : array());
    $db['version'] = TC_DB_VERSION;
    foreach (array('users', 'providers', 'userGroups', 'accessRules', 'assistantCategories', 'assistants', 'packages', 'redemptionCodes', 'quotaLedger', 'inviteCodes') as $k) {
        $db[$k] = isset($db[$k]) && is_array($db[$k]) ? array_values($db[$k]) : array();
    }
    tc_migrate_provider_keys($db);
    $db['userChats'] = tc_object_map(isset($db['userChats']) ? $db['userChats'] : array());
    $db['shares'] = tc_object_map(isset($db['shares']) ? $db['shares'] : array());
    $stats = tc_assoc(isset($db['stats']) ? $db['stats'] : array());
    $votes = array();
    foreach (tc_assoc(isset($stats['modelVotes']) ? $stats['modelVotes'] : array()) as $model => $row) {
        $name = substr(trim((string) $model), 0, 80);
        if ($name === '') continue;
        $row = tc_assoc($row);
        $up = isset($row['up']) ? (int) $row['up'] : 0;
        $down = isset($row['down']) ? (int) $row['down'] : 0;
        if ($up < 0) $up = 0;
        if ($down < 0) $down = 0;
        if ($up === 0 && $down === 0) continue;
        $votes[$name] = array('up' => $up, 'down' => $down);
    }
    $db['stats'] = array(
        'totalCalls' => isset($stats['totalCalls']) ? (int) $stats['totalCalls'] : 0,
        'totalQuotaGiven' => isset($stats['totalQuotaGiven']) ? (int) $stats['totalQuotaGiven'] : 0,
        'callsByDay' => tc_object_map(isset($stats['callsByDay']) ? $stats['callsByDay'] : array()),
        'modelVotes' => tc_object_map($votes),
        'usageLedger' => tc_object_map(tc_assoc(isset($stats['usageLedger']) ? $stats['usageLedger'] : array())),
        'modelHealth' => tc_object_map(tc_assoc(isset($stats['modelHealth']) ? $stats['modelHealth'] : array())),
    );
    $db['settings'] = tc_normalize_settings(isset($db['settings']) ? $db['settings'] : null);
    unset($db['sessions']);
    foreach ($db['users'] as &$u) {
        if (!isset($u['tv']) || !is_numeric($u['tv'])) $u['tv'] = 0;
        if (isset($u['quota']) && (string) $u['quota'] === '-1') $u['quota'] = -1;
        elseif (!isset($u['quota']) || !is_numeric($u['quota'])) $u['quota'] = 0;
        if (!array_key_exists('email', $u)) $u['email'] = '';
        if (!array_key_exists('emailVerifiedAt', $u)) $u['emailVerifiedAt'] = 1;
        if (!array_key_exists('groupId', $u)) $u['groupId'] = null;
        $u['admin'] = !empty($u['admin']);
        $u['tools'] = tc_user_tools($u);
    }
    unset($u);
    foreach ($db['providers'] as &$p) {
        if (!isset($p['models']) || !is_array($p['models'])) $p['models'] = array();
        if (!isset($p['costPerCall']) || !is_numeric($p['costPerCall'])) $p['costPerCall'] = 1;
        if (!isset($p['scope']) || $p['scope'] !== 'global') $p['scope'] = 'user';
        if (!array_key_exists('enabled', $p)) $p['enabled'] = true;
        if (empty($p['createdAt'])) $p['createdAt'] = tc_now();
    }
    unset($p);
    if (!empty($db['defaultProviderId'])) {
        $found = false;
        foreach ($db['providers'] as $p) {
            if ($p['id'] === $db['defaultProviderId']) { $found = true; break; }
        }
        if (!$found) $db['defaultProviderId'] = null;
    }
    tc_ensure_default_group($db);
    return $db;
}

function tc_db_file() { return tc_data_dir() . '/db.json'; }
function tc_lock_file() { return tc_data_dir() . '/db.lock'; }

// ---- 数据备份:data/backup/db-YYYYMMDD-HHMMSS.json,自动每日一份并按 backupKeep 轮换 ----
function tc_backup_dir() {
    $dir = tc_data_dir() . '/backup';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_backup_list() {
    $dir = tc_backup_dir();
    $out = array();
    foreach ((is_dir($dir) ? scandir($dir) : array()) as $f) {
        if (!preg_match('/^db-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.json$/', (string) $f)) continue;
        $full = $dir . '/' . $f;
        $out[] = array('name' => $f, 'size' => (int) @filesize($full), 'time' => (int) @filemtime($full));
    }
    usort($out, function ($a, $b) { return $b['time'] - $a['time']; });
    return $out;
}

function tc_backup_create() {
    $dbFile = tc_db_file();
    if (!is_file($dbFile)) return null;
    $name = 'db-' . date('Ymd-His') . '.json';
    if (is_file(tc_backup_dir() . '/' . $name)) {
        // 同一秒内多次备份:追加短随机后缀避免覆盖
        $name = 'db-' . date('Ymd-His') . '-' . substr(bin2hex(random_bytes(2)), 0, 4) . '.json';
    }
    if (!@copy($dbFile, tc_backup_dir() . '/' . $name)) return null;
    return $name;
}

function tc_backup_prune($settings) {
    $keep = isset($settings['backupKeep']) ? (int) $settings['backupKeep'] : 7;
    if ($keep < 1) $keep = 1;
    $list = tc_backup_list();
    foreach (array_slice($list, $keep) as $old) {
        @unlink(tc_backup_dir() . '/' . $old['name']);
    }
}

// 管理后台加载时惰性触发:距最近一份备份超过 24 小时(或还没有)就自动备份一次
function tc_backup_maybe($settings) {
    if (empty($settings['backupEnabled'])) return;
    try {
        $list = tc_backup_list();
        if ($list && (tc_now() - (int) $list[0]['time']) < 24 * 3600 * 1000) return;
        if (tc_backup_create() !== null) tc_backup_prune($settings);
    } catch (Throwable $e) { /* 备份失败不影响主流程 */ }
}

function tc_backup_path($name) {
    if (!preg_match('/^db-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.json$/', (string) $name)) return '';
    $full = tc_backup_dir() . '/' . $name;
    return is_file($full) ? $full : '';
}

// ---- 接口限流:滑动窗口(每用户每分钟) ----
// 计数按 key 分片存 data/ratelimit/{hash}.json:写锁只串行化同一用户,不同用户互不阻塞
function tc_rate_limit_file($key) {
    $dir = tc_data_dir() . '/ratelimit';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir . '/' . hash('sha256', (string) $key) . '.json';
}

function tc_rate_limit_check($key, $limitPerMin) {
    $limit = (int) $limitPerMin;
    if ($limit <= 0 || $key === '') return true;
    $fp = @fopen(tc_rate_limit_file($key), 'c+');
    if (!$fp) return true; // 计数存储不可用时不拦截主流程
    @flock($fp, LOCK_EX);
    $data = json_decode((string) stream_get_contents($fp), true);
    $now = tc_now();
    $window = 60 * 1000;
    $mine = array();
    foreach ((is_array($data) ? $data : array()) as $t) {
        if ((int) $t > $now - $window) $mine[] = (int) $t;
    }
    $allowed = count($mine) < $limit;
    if ($allowed) {
        $mine[] = $now;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, tc_json_encode($mine));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $allowed;
}

// ---- 内容审核:本地敏感词表(每行一个,也支持逗号分隔),发送前对用户消息匹配 ----
function tc_moderation_words_text($raw) {
    $out = array();
    $seen = array();
    foreach (preg_split('/[\r\n,;，；]+/u', (string) $raw) as $w) {
        $w = trim((string) $w);
        if ($w === '' || mb_strlen($w, 'UTF-8') > 100) continue;
        $k = strtolower($w);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $w;
        if (count($out) >= 5000) break;
    }
    return implode("\n", $out);
}

function tc_moderation_hit($moderation, $text) {
    if (empty($moderation['enabled'])) return '';
    $words = (string) (isset($moderation['words']) ? $moderation['words'] : '');
    if (trim($words) === '') return '';
    $haystack = (string) $text;
    if ($haystack === '') return '';
    if (function_exists('mb_stripos')) {
        foreach (preg_split('/[\r\n]+/u', $words, -1, PREG_SPLIT_NO_EMPTY) as $w) {
            if (mb_stripos($haystack, $w, 0, 'UTF-8') !== false) return $w;
        }
        return '';
    }
    $haystack = strtolower($haystack);
    foreach (preg_split('/[\r\n]+/u', $words, -1, PREG_SPLIT_NO_EMPTY) as $w) {
        if (strpos($haystack, strtolower($w)) !== false) return $w;
    }
    return '';
}

// ---- 用户 API 密钥(sk-tc-...):哈希落库,仅创建时完整展示一次,用于 OpenAI 兼容出口 ----
function tc_api_key_generate() {
    return 'sk-tc-' . tc_uid(24);
}

function tc_api_key_hash($key) {
    return hash_hmac('sha256', (string) $key, tc_secret() . '|api-key-v1');
}

function tc_api_key_prefix($key) {
    return substr((string) $key, 0, 12);
}

// 按明文 Key 定位用户:key 哈希比对(每用户最多 5 把)。返回 ['userId','keyIndex'] 或 null
function tc_find_api_key_owner($db, $key) {
    if ((string) $key === '' || strpos((string) $key, 'sk-tc-') !== 0) return null;
    $hash = tc_api_key_hash($key);
    foreach ($db['users'] as $ui => $u) {
        if (empty($u['apiKeys']) || !is_array($u['apiKeys'])) continue;
        foreach ($u['apiKeys'] as $ki => $k) {
            if (!is_array($k) || !isset($k['hash'])) continue;
            if (hash_equals((string) $k['hash'], $hash)) return array('userId' => (string) $u['id'], 'keyIndex' => $ki);
        }
    }
    return null;
}

function tc_read_db_unlocked() {
    $file = tc_db_file();
    if (!is_file($file)) return tc_empty_db();
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') return tc_empty_db();
    $json = json_decode($raw, true);
    if (!is_array($json)) return tc_empty_db();
    return tc_migrate_db($json);
}

function tc_write_db_unlocked($db) {
    $file = tc_db_file();
    $tmp = $file . '.tmp';
    $json = json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) throw new RuntimeException('数据库序列化失败');
    if (file_put_contents($tmp, $json, LOCK_EX) === false) throw new RuntimeException('数据库写入失败');
    if (!@rename($tmp, $file)) {
        @unlink($file);
        if (!@rename($tmp, $file)) throw new RuntimeException('数据库替换失败');
    }
}

function tc_with_db($write, $fn) {
    $lockPath = tc_lock_file();
    $fp = fopen($lockPath, 'c+');
    if (!$fp) throw new RuntimeException('无法打开数据锁');
    if (!flock($fp, $write ? LOCK_EX : LOCK_SH)) {
        fclose($fp);
        throw new RuntimeException('无法锁定数据库');
    }
    $db = tc_read_db_unlocked();
    $GLOBALS['_tc_db'] = &$db;
    $GLOBALS['_tc_db_ctx'] = array('fp' => $fp, 'write' => $write, 'committed' => false);
    try {
        $ret = $fn($db);
        tc_db_commit();
        return $ret;
    } finally {
        tc_db_release();
    }
}

function tc_db_skip_write() {
    if (!empty($GLOBALS['_tc_db_ctx'])) $GLOBALS['_tc_db_ctx']['write'] = false;
}

function tc_db_commit() {
    if (empty($GLOBALS['_tc_db_ctx']) || !empty($GLOBALS['_tc_db_ctx']['committed'])) return;
    $GLOBALS['_tc_db_ctx']['committed'] = true;
    if (!empty($GLOBALS['_tc_db_ctx']['write']) && isset($GLOBALS['_tc_db'])) {
        tc_write_db_unlocked($GLOBALS['_tc_db']);
    }
}

function tc_db_release() {
    tc_db_commit();
    if (empty($GLOBALS['_tc_db_ctx']['fp'])) {
        unset($GLOBALS['_tc_db'], $GLOBALS['_tc_db_ctx']);
        return;
    }
    $fp = $GLOBALS['_tc_db_ctx']['fp'];
    $GLOBALS['_tc_db_ctx']['fp'] = null;
    flock($fp, LOCK_UN);
    fclose($fp);
    unset($GLOBALS['_tc_db'], $GLOBALS['_tc_db_ctx']);
}

function tc_secret() {
    static $secret = null;
    if ($secret !== null) return $secret;
    $fromCfg = tc_cfg('jwt_secret');
    if ($fromCfg) {
        $secret = (string) $fromCfg;
        return $secret;
    }
    $file = tc_data_dir() . '/secret';
    if (is_file($file)) {
        $secret = trim((string) file_get_contents($file));
        if ($secret !== '') return $secret;
    }
    $secret = tc_uid(32);
    @file_put_contents($file, $secret, LOCK_EX);
    return $secret;
}

function tc_jwt_sign($payload) {
    $header = tc_b64url(tc_json_encode(array('alg' => 'HS256', 'typ' => 'JWT')));
    $body = tc_b64url(tc_json_encode($payload));
    $sig = tc_b64url(hash_hmac('sha256', $header . '.' . $body, tc_secret(), true));
    return $header . '.' . $body . '.' . $sig;
}

function tc_jwt_verify($token) {
    $parts = explode('.', (string) $token);
    if (count($parts) !== 3) return null;
    list($h, $b, $s) = $parts;
    $expect = tc_b64url(hash_hmac('sha256', $h . '.' . $b, tc_secret(), true));
    if (!hash_equals($expect, $s)) return null;
    $json = tc_b64url_decode($b);
    $payload = json_decode($json, true);
    return is_array($payload) ? $payload : null;
}

function tc_hash_password($password, $salt) {
    return hash_pbkdf2('sha256', substr((string) $password, 0, 256), $salt, TC_PBKDF2_ITER, 64, false);
}

function tc_verify_password($password, $user) {
    $h = tc_hash_password($password, isset($user['salt']) ? $user['salt'] : '');
    $expect = isset($user['passwordHash']) ? (string) $user['passwordHash'] : '';
    if (strlen($h) !== strlen($expect) || $expect === '') return false;
    return hash_equals($expect, $h);
}

function tc_set_password(&$user, $password) {
    $salt = tc_uid(8);
    $user['salt'] = $salt;
    $user['passwordHash'] = tc_hash_password($password, $salt);
    $user['tv'] = (isset($user['tv']) ? (int) $user['tv'] : 0) + 1;
}

function tc_mail_send($settings, $to, $subject, $html, $text = '', &$err = null) {
    $err = '';
    $smtp = isset($settings['smtp']) && is_array($settings['smtp']) ? $settings['smtp'] : array();
    if (empty($smtp['host'])) { $err = '未配置 SMTP 服务器'; return false; }
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) { $err = '收件邮箱无效'; return false; }
    $from = str_replace(array("\r", "\n"), '', $smtp['fromEmail'] ?: $smtp['username']);
    $fromName = str_replace(array("\r", "\n"), '', $smtp['fromName'] ?: 'TinyChat');
    $subject = str_replace(array("\r", "\n"), '', $subject);
    if (!filter_var($from, FILTER_VALIDATE_EMAIL)) { $err = '发件人邮箱无效: ' . $from; return false; }
    $body = "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nFrom: " . $fromName . " <" . $from . ">\r\nTo: " . $to . "\r\nSubject: =?UTF-8?B?" . base64_encode($subject) . "?=\r\n\r\n" . $html . "\r\n.";
    $transport = $smtp['encryption'] === 'ssl' ? 'ssl://' : '';
    $fp = @stream_socket_client($transport . $smtp['host'] . ':' . (int) $smtp['port'], $errno, $errstr, 8);
    if (!$fp) {
        $err = '连接 SMTP 服务器失败: ' . ($errstr !== '' ? $errstr : '超时') . ' (' . $smtp['host'] . ':' . (int) $smtp['port'] . ')';
        return function_exists('mail') ? @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $html, 'MIME-Version: 1.0\r\nContent-type: text/html; charset=UTF-8\r\nFrom: ' . $fromName . ' <' . $from . '>\r\n') : false;
    }
    stream_set_timeout($fp, 8);
    $lastLine = '';
    $read = function () use ($fp, &$lastLine) { $out=''; while (($line=fgets($fp, 512)) !== false) { $out.=$line; if (isset($line[3]) && $line[3] === ' ') break; } $lastLine = trim($out); return $out; };
    $ok = function ($response, $codes) use (&$err, &$lastLine) { $code = (int) substr(trim((string) $response), 0, 3); if (!in_array((int) $code, array_map('intval', $codes), true)) { $err = 'SMTP 响应异常 (' . $code . '): ' . $lastLine; return false; } return true; };
    $write = function ($cmd, $codes) use ($fp, $read, $ok) { if (fwrite($fp, $cmd . "\r\n") === false) { $err = 'SMTP 连接中断'; return false; } return $ok($read(), $codes); };
    if (!$ok($read(), array(220))) { fclose($fp); return false; }
    if (!$write('EHLO localhost', array(250))) { fclose($fp); return false; }
    if ($smtp['encryption'] === 'tls') { if (!$write('STARTTLS', array(220)) || @stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT) !== true || !$write('EHLO localhost', array(250))) { if ($err === '') $err = 'STARTTLS 加密失败'; fclose($fp); return false; } }
    if ($smtp['username'] !== '') { if (!$write('AUTH LOGIN', array(334)) || !$write(base64_encode($smtp['username']), array(334)) || !$write(base64_encode($smtp['password']), array(235))) { if ($err === '') $err = 'SMTP 认证失败，请检查用户名和密码'; fclose($fp); return false; } }
    if (!$write('MAIL FROM:<' . $from . '>', array(250)) || !$write('RCPT TO:<' . $to . '>', array(250,251)) || !$write('DATA', array(354))) { fclose($fp); return false; }
    if (fwrite($fp, $body . "\r\n") === false || !$ok($read(), array(250))) { if ($err === '') $err = '邮件内容未被服务器接受'; fclose($fp); return false; }
    $write('QUIT', array(221,250)); fclose($fp); return true;
}

function tc_issue_token($user, $settings = null) {
    $s = is_array($settings) ? $settings : array();
    $days = isset($s['sessionDays']) ? max(1, (int) $s['sessionDays']) : 7;
    $epoch = isset($s['authEpoch']) ? max(1, (int) $s['authEpoch']) : 1;
    return tc_jwt_sign(array(
        'sub' => $user['id'],
        'name' => $user['name'],
        'admin' => !empty($user['admin']),
        'tv' => isset($user['tv']) ? (int) $user['tv'] : 0,
        'ep' => $epoch,
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
}

function tc_sanitize_user($u) {
    return array(
        'id' => $u['id'],
        'name' => $u['name'],
        // 展示"有效额度":已过期分账的剩余量即时扣减(落库回收在下次扣费/领取时完成)
        'quota' => isset($u['quota']) ? tc_quota_effective($u) : 0,
        // 生命周期调用计数(服务器台账口径,清空对话不影响)
        'totalCalls' => isset($u['totalCalls']) ? (int) $u['totalCalls'] : 0,
        'email' => isset($u['email']) ? $u['email'] : '',
        'emailVerified' => !empty($u['emailVerifiedAt']),
        'createdAt' => isset($u['createdAt']) ? $u['createdAt'] : 0,
        'lastSeen' => isset($u['lastSeen']) ? (float) $u['lastSeen'] : 0,
        'admin' => !empty($u['admin']),
        'groupId' => isset($u['groupId']) ? $u['groupId'] : null,
    );
}

function tc_touch_user(&$db, $userId) {
    $userId = (string) $userId;
    if ($userId === '') return;
    foreach ($db['users'] as &$u) {
        if (!isset($u['id']) || $u['id'] !== $userId) continue;
        $u['lastSeen'] = tc_now();
        return;
    }
    unset($u);
}

function tc_mask_key($k) {
    if (!$k) return '';
    if (strlen($k) <= 8) return '••••';
    return substr($k, 0, 4) . '••••••' . substr($k, -4);
}

// ---- 供应商 API Key 静态加密(AES-256-GCM,密钥来自 data/secret,密文与供应商/属主绑定) ----
function tc_provider_key_aad($p) {
    $owner = isset($p['ownerId']) && $p['ownerId'] ? (string) $p['ownerId'] : '';
    return (isset($p['id']) ? (string) $p['id'] : '') . '|' . $owner;
}

function tc_is_encrypted_secret($v) {
    return is_string($v) && (bool) preg_match('/^enc1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/', $v);
}

function tc_encrypt_secret($plaintext, $aad) {
    $key = hash_hmac('sha256', 'provider-apikey-v1', tc_secret(), true);
    $iv = random_bytes(12);
    $tag = '';
    $ct = openssl_encrypt((string) $plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, (string) $aad);
    if ($ct === false) return false;
    return 'enc1.' . tc_b64url($iv) . '.' . tc_b64url($tag) . '.' . tc_b64url($ct);
}

function tc_decrypt_secret($blob, $aad) {
    if (!is_string($blob) || strpos($blob, 'enc1.') !== 0) return (string) $blob;
    $parts = explode('.', $blob);
    if (count($parts) !== 4) return '';
    $iv = tc_b64url_decode($parts[1]);
    $tag = tc_b64url_decode($parts[2]);
    $ct = tc_b64url_decode($parts[3]);
    if ($iv === false || $tag === false || $ct === false || strlen($iv) !== 12 || strlen($tag) !== 16) return '';
    $key = hash_hmac('sha256', 'provider-apikey-v1', tc_secret(), true);
    $plain = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, (string) $aad);
    return $plain === false ? '' : $plain;
}

// 读取供应商明文 Key:enc1. 密文按 AAD 解密,旧明文原样返回(兼容未迁移数据)
function tc_provider_key($p) {
    $k = isset($p['apiKey']) ? (string) $p['apiKey'] : '';
    if ($k === '') return '';
    if (strpos($k, 'enc1.') === 0) return tc_decrypt_secret($k, tc_provider_key_aad($p));
    return $k;
}

// 将明文 Key 加密后写入供应商记录;失败时返回 false 且不改动记录
function tc_provider_set_key(&$p, $plain) {
    $enc = tc_encrypt_secret($plain, tc_provider_key_aad($p));
    if ($enc === false) return false;
    $p['apiKey'] = $enc;
    return true;
}

function tc_migrate_provider_keys(&$db) {
    if (!isset($db['providers']) || !is_array($db['providers'])) return;
    foreach ($db['providers'] as &$p) {
        if (!is_array($p) || !isset($p['apiKey']) || !is_string($p['apiKey']) || $p['apiKey'] === '') continue;
        if (strpos($p['apiKey'], 'enc1.') === 0) continue;
        tc_provider_set_key($p, $p['apiKey']);
    }
    unset($p);
}

function tc_client_ip() {
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($parts[0]);
    }
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

function tc_bearer() {
    $h = '';
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) $h = $_SERVER['HTTP_AUTHORIZATION'];
    elseif (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) $h = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    elseif (function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        foreach ($headers as $k => $v) {
            if (strtolower($k) === 'authorization') { $h = $v; break; }
        }
    }
    if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) return $m[1];
    return '';
}

function tc_auth_user($db) {
    $token = tc_bearer();
    if ($token === '') return null;
    $payload = tc_jwt_verify($token);
    if (!$payload || empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return null;
    // 全站会话纪元:authEpoch 递增后旧令牌全部失效(缺 ep 的老令牌视为纪元 1)
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    $payloadEpoch = isset($payload['ep']) ? (int) $payload['ep'] : 1;
    if ($payloadEpoch !== $epoch) return null;
    foreach ($db['users'] as $u) {
        if ($u['id'] === $payload['sub']) {
            $tv = isset($u['tv']) ? (int) $u['tv'] : 0;
            $ptv = isset($payload['tv']) ? (int) $payload['tv'] : 0;
            if ($ptv !== $tv) return null;
            return $u;
        }
    }
    return null;
}

function tc_json($code, $obj, $extraHeaders = array()) {
    tc_db_commit();
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    foreach ($extraHeaders as $k => $v) header($k . ': ' . $v);
    echo tc_json_encode($obj);
    exit;
}

function tc_fail($code, $msg) {
    tc_db_skip_write();
    tc_json($code, array('error' => array('message' => $msg)));
}

function tc_require_auth($db) {
    $user = tc_auth_user($db);
    if (!$user) tc_fail(401, '未登录或登录已过期');
    return $user;
}

function tc_require_admin($db) {
    $user = tc_require_auth($db);
    if (empty($user['admin'])) tc_fail(403, '需要管理员权限');
    return $user;
}

function tc_read_json_body($limit = 2097152) {
    $raw = file_get_contents('php://input');
    if ($raw === false) $raw = '';
    if (strlen($raw) > $limit) tc_fail(400, '请求体过大');
    if ($raw === '') return array();
    $json = json_decode($raw, true);
    if (!is_array($json)) tc_fail(400, '请求体格式错误');
    return $json;
}

function tc_query() {
    return $_GET;
}

function tc_send_cors() {
    $origin = tc_cfg('cors_origin') ?: '*';
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Expose-Headers: X-Oc-Cost, X-Oc-Quota, X-Oc-Elapsed, X-Oc-Citations');
    header('Access-Control-Max-Age: 86400');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // 页面含内联脚本/样式(主题色预置、各页面内嵌 JS),CSP 需保留 unsafe-inline;
    // 站点资源全部本地化,外部来源仅放行聊天内容里的 https 图片
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
}

function tc_login_file() { return tc_data_dir() . '/login-fails.json'; }

function tc_login_key($name) {
    return tc_client_ip() . '|' . strtolower((string) $name);
}

function tc_login_state() {
    $file = tc_login_file();
    if (!is_file($file)) return array();
    $j = json_decode((string) file_get_contents($file), true);
    return is_array($j) ? $j : array();
}

function tc_save_login_state($state) {
    file_put_contents(tc_login_file(), tc_json_encode($state), LOCK_EX);
}

function tc_check_login_lock($settings, $name) {
    $max = isset($settings['loginMaxFails']) ? (int) $settings['loginMaxFails'] : 0;
    if (!$max) return null;
    $state = tc_login_state();
    $k = tc_login_key($name);
    if (empty($state[$k]['lockedUntil'])) return null;
    $until = (int) $state[$k]['lockedUntil'];
    if ($until > tc_now()) return (int) ceil(($until - tc_now()) / 1000);
    return null;
}

function tc_note_login_fail($settings, $name) {
    $max = isset($settings['loginMaxFails']) ? (int) $settings['loginMaxFails'] : 0;
    if (!$max) return;
    $state = tc_login_state();
    $k = tc_login_key($name);
    $rec = isset($state[$k]) ? $state[$k] : array('count' => 0, 'lockedUntil' => 0);
    $rec['count'] = (isset($rec['count']) ? (int) $rec['count'] : 0) + 1;
    if ($rec['count'] >= $max) {
        $rec['lockedUntil'] = tc_now() + (int) $settings['loginLockMs'];
        $rec['count'] = 0;
    }
    $state[$k] = $rec;
    if (count($state) > 5000) {
        $now = tc_now();
        foreach ($state as $key => $v) {
            if (empty($v['lockedUntil']) || $v['lockedUntil'] < $now) unset($state[$key]);
        }
    }
    tc_save_login_state($state);
}

function tc_clear_login_fail($name) {
    $state = tc_login_state();
    unset($state[tc_login_key($name)]);
    tc_save_login_state($state);
}

function tc_logs_file() { return tc_data_dir() . '/logs.json'; }

function tc_push_log($entry) {
    $file = tc_logs_file();
    $fp = fopen($file, 'c+');
    if (!$fp) return;
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $data = json_decode($raw, true);
    if (!is_array($data)) $data = array('seq' => 0, 'items' => array());
    $data['seq'] = (isset($data['seq']) ? (int) $data['seq'] : 0) + 1;
    $item = $entry;
    $item['id'] = $data['seq'];
    $item['t'] = tc_now();
    $data['items'][] = $item;
    if (count($data['items']) > TC_LOG_LIMIT) {
        $data['items'] = array_slice($data['items'], -TC_LOG_LIMIT);
    }
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, tc_json_encode($data));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
}

function tc_list_logs($limit) {
    $n = min(TC_LOG_LIMIT, max(1, (int) $limit ?: 100));
    $file = tc_logs_file();
    if (!is_file($file)) return array();
    $data = json_decode((string) file_get_contents($file), true);
    $items = (isset($data['items']) && is_array($data['items'])) ? $data['items'] : array();
    $slice = array_slice($items, -$n);
    return array_reverse($slice);
}

function tc_clear_logs() {
    file_put_contents(tc_logs_file(), tc_json_encode(array('seq' => 0, 'items' => array())), LOCK_EX);
}

function tc_provider_cost($provider) {
    $c = isset($provider['costPerCall']) ? (float) $provider['costPerCall'] : 1;
    if (!is_numeric($c) || is_nan($c) || $c == INF || $c == -INF) $c = 1;
    return max(0, $c);
}

function tc_is_unlimited_quota($user) {
    return isset($user['quota']) && (string) $user['quota'] === '-1';
}

function tc_add_quota(&$db, &$user, $amount, $expiresAt = 0) {
    if ((string) $amount === '-1' || tc_is_unlimited_quota($user)) {
        $user['quota'] = -1;
        tc_replace_user($db, $user);
        return;
    }
    $n = (float) $amount;
    if ($n <= 0) return;
    $user['quota'] = max(0, (isset($user['quota']) ? (float) $user['quota'] : 0) + $n);
    $db['stats']['totalQuotaGiven'] = (isset($db['stats']['totalQuotaGiven']) ? (float) $db['stats']['totalQuotaGiven'] : 0) + $n;
    // 分笔记账:带有效期的额度单独成桶,到期按剩余量回收(tc_enforce_quota_expiry)
    if ($expiresAt > 0) {
        $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
        $grants[] = array('amount' => $n, 'remaining' => $n, 'expiresAt' => (int) $expiresAt, 'createdAt' => tc_now());
        $user['quotaGrants'] = $grants;
    }
    tc_replace_user($db, $user);
}

// 有效额度 = 账面额度 − 已过期未用完的分账(只读不落库;落库回收见 tc_enforce_quota_expiry)
function tc_quota_effective($user, $now = null) {
    if (tc_is_unlimited_quota($user)) return -1;
    $quota = (float) (isset($user['quota']) ? $user['quota'] : 0);
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    if (!$grants) return $quota;
    $now = $now === null ? tc_now() : $now;
    foreach ($grants as $g) {
        if (!empty($g['expiresAt']) && (int) $g['expiresAt'] <= $now && isset($g['remaining']) && (float) $g['remaining'] > 0) {
            $quota = max(0, $quota - (float) $g['remaining']);
        }
    }
    return $quota;
}

// 到期回收:从账面额度扣掉过期分账的剩余量,并清掉过期分账。需在写模式下调用。
function tc_enforce_quota_expiry(&$db, &$user, $now = null) {
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    if (!$grants) return 0;
    $now = $now === null ? tc_now() : $now;
    $reclaimed = 0;
    $kept = array();
    foreach ($grants as $g) {
        if (!empty($g['expiresAt']) && (int) $g['expiresAt'] <= $now && isset($g['remaining']) && (float) $g['remaining'] > 0) {
            $reclaimed += (float) $g['remaining'];
        } else {
            $kept[] = $g;
        }
    }
    if (count($kept) === count($grants)) return 0;
    $user['quotaGrants'] = $kept;
    if ($reclaimed > 0 && !tc_is_unlimited_quota($user)) {
        $user['quota'] = max(0, (float) $user['quota'] - $reclaimed);
    }
    tc_replace_user($db, $user);
    return $reclaimed;
}

// 扣费时按"先到期先用"从分账里核销,返回核销总量(其余部分扣的是无期限额度)
function tc_consume_quota_grants(&$user, $n) {
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    $live = array();
    foreach ($grants as $g) if (isset($g['remaining']) && (float) $g['remaining'] > 0) $live[] = $g;
    if (!$live) return 0;
    usort($live, function ($a, $b) {
        $ea = !empty($a['expiresAt']) ? (int) $a['expiresAt'] : PHP_INT_MAX;
        $eb = !empty($b['expiresAt']) ? (int) $b['expiresAt'] : PHP_INT_MAX;
        if ($ea !== $eb) return $ea - $eb;
        return ((isset($a['createdAt']) ? $a['createdAt'] : 0) <=> (isset($b['createdAt']) ? $b['createdAt'] : 0));
    });
    $remaining = $n;
    foreach ($live as $i => $g) {
        if ($remaining <= 0) break;
        $take = min((float) $g['remaining'], $remaining);
        $live[$i]['remaining'] = (float) $g['remaining'] - $take;
        $remaining -= $take;
    }
    $kept = array();
    foreach ($live as $g) if ((float) $g['remaining'] > 0) $kept[] = $g;
    $user['quotaGrants'] = $kept;
    return $n - $remaining;
}

function tc_replace_user(&$db, $user) {
    foreach ($db['users'] as $i => $u) {
        if ($u['id'] === $user['id']) { $db['users'][$i] = $user; return; }
    }
}

function tc_charge_user(&$db, &$user, $cost, $model = '') {
    $n = max(0, (float) $cost);
    $unlimited = tc_is_unlimited_quota($user);
    if (!$unlimited) tc_enforce_quota_expiry($db, $user);
    // 0 成本(自有 Key)与无限额度的调用不扣额度,但同样计入调用次数
    if ($n > 0 && !$unlimited) {
        // 按 token 计费会出现小数额度,4 位舍入避免浮点尘埃累积
        $user['quota'] = max(0, round((isset($user['quota']) ? (float) $user['quota'] : 0) - $n, 4));
        tc_consume_quota_grants($user, $n);
    }
    // 生命周期调用计数:存用户记录上,清空对话也不丢失
    if (!isset($user['totalCalls'])) {
        // 首次建立计数:用台账里可查的历史调用打底,避免老用户计数从 0 跳变
        $seed = 0;
        $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
        $mine = tc_assoc(isset($ledger[$user['id']]) ? $ledger[$user['id']] : array());
        foreach ($mine as $day) {
            $day = tc_assoc($day);
            foreach ($day as $cell) {
                $cell = tc_assoc($cell);
                $seed += (int) (isset($cell['calls']) ? $cell['calls'] : 0);
            }
        }
        $user['totalCalls'] = $seed;
    }
    $user['totalCalls'] = (int) $user['totalCalls'] + 1;
    $db['stats']['totalCalls'] = (isset($db['stats']['totalCalls']) ? (int) $db['stats']['totalCalls'] : 0) + 1;
    $k = tc_today_key();
    $by = tc_assoc($db['stats']['callsByDay']);
    $by[$k] = (isset($by[$k]) ? (int) $by[$k] : 0) + 1;
    $db['stats']['callsByDay'] = tc_object_map($by);
    tc_replace_user($db, $user);
    return $unlimited ? 0 : $n;
}

function tc_health_key($providerId, $model) {
    $pid = substr(trim((string) $providerId), 0, 80);
    $name = substr(trim((string) $model), 0, 80);
    if ($pid === '' || $name === '') return '';
    return $pid . "\n" . $name;
}

function tc_health_prune($events, $now = null) {
    $cut = ($now === null ? tc_now() : (int) $now) - 4 * 3600 * 1000;
    $kept = array();
    foreach ((array) $events as $ev) {
        if (!is_array($ev)) continue;
        $t = isset($ev['t']) ? (int) $ev['t'] : 0;
        if ($t < $cut) continue;
        $kept[] = array('t' => $t, 'ok' => !empty($ev['ok']) ? 1 : 0);
    }
    if (count($kept) > 400) $kept = array_slice($kept, -400);
    return $kept;
}

function tc_record_model_health(&$db, $providerId, $model, $ok) {
    $key = tc_health_key($providerId, $model);
    if ($key === '') return;
    $now = tc_now();
    $health = tc_assoc(isset($db['stats']['modelHealth']) ? $db['stats']['modelHealth'] : array());
    $row = tc_health_prune(isset($health[$key]) ? $health[$key] : array(), $now);
    $row[] = array('t' => $now, 'ok' => $ok ? 1 : 0);
    if (count($row) > 400) $row = array_slice($row, -400);
    $health[$key] = $row;
    if (count($health) > 800) {
        $slim = array();
        foreach ($health as $k => $events) {
            $events = tc_health_prune($events, $now);
            if ($events) $slim[$k] = $events;
        }
        $health = $slim;
    }
    $db['stats']['modelHealth'] = tc_object_map($health);
}

function tc_model_health_summary($db, $providerId) {
    $pid = substr(trim((string) $providerId), 0, 80);
    $now = tc_now();
    $health = tc_assoc(isset($db['stats']['modelHealth']) ? $db['stats']['modelHealth'] : array());
    $prefix = $pid . "\n";
    $out = array();
    foreach ($health as $key => $events) {
        if ($pid !== '' && strpos((string) $key, $prefix) !== 0) continue;
        $model = $pid !== '' ? substr((string) $key, strlen($prefix)) : (string) $key;
        $events = tc_health_prune($events, $now);
        $calls = count($events);
        if ($calls <= 0 || $model === '') continue;
        $ok = 0;
        foreach ($events as $ev) if (!empty($ev['ok'])) $ok++;
        $rate = $ok / $calls;
        $out[$model] = array(
            'state' => $rate > 0.75 ? 'ok' : 'bad',
            'calls' => $calls,
            'ok' => $ok,
            'rate' => round($rate, 4),
        );
    }
    return $out;
}

// 用量台账:流式结束后由代理调用,记录 调用次数/计费额度/上下行 token(按 用户+日期+模型 聚合)
function tc_record_usage_entry(&$db, $userId, $model, $cost, $prompt, $completion) {
    $uid = (string) $userId;
    if ($uid === '') return;
    $name = substr(trim((string) $model), 0, 80);
    if ($name === '') $name = '未知模型';
    $day = tc_today_key();
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $mine = tc_assoc(isset($ledger[$uid]) ? $ledger[$uid] : array());
    $row = tc_assoc(isset($mine[$day]) ? $mine[$day] : array());
    $cell = tc_assoc(isset($row[$name]) ? $row[$name] : array());
    $cell['calls'] = (isset($cell['calls']) ? (int) $cell['calls'] : 0) + 1;
    $cell['cost'] = (isset($cell['cost']) ? (float) $cell['cost'] : 0) + max(0, (float) $cost);
    if ($prompt > 0) $cell['prompt'] = (isset($cell['prompt']) ? (int) $cell['prompt'] : 0) + (int) $prompt;
    if ($completion > 0) $cell['completion'] = (isset($cell['completion']) ? (int) $cell['completion'] : 0) + (int) $completion;
    $row[$name] = $cell;
    $mine[$day] = tc_object_map($row);
    if (count($mine) > 45) {
        ksort($mine);
        $mine = array_slice($mine, -45, null, true);
    }
    $ledger[$uid] = tc_object_map($mine);
    $db['stats']['usageLedger'] = tc_object_map($ledger);
}

function tc_admin_usage_rows($db, $days) {
    $names = array();
    foreach ((isset($db['users']) ? $db['users'] : array()) as $u) {
        if (isset($u['id'])) $names[(string) $u['id']] = isset($u['name']) ? (string) $u['name'] : '';
    }
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $out = array();
    foreach ($ledger as $uid => $daysMap) {
        $rows = tc_usage_rows($db, $uid, $days);
        $calls = 0;
        $cost = 0;
        $byModel = array();
        foreach ($rows as $row) {
            $calls += $row['calls'];
            $cost += $row['cost'];
            foreach ($row['models'] as $m) {
                $key = $m['model'];
                if (!isset($byModel[$key])) $byModel[$key] = array('model' => $key, 'calls' => 0, 'cost' => 0);
                $byModel[$key]['calls'] += $m['calls'];
                $byModel[$key]['cost'] += $m['cost'];
            }
        }
        if ($calls <= 0 && $cost <= 0) continue;
        $models = array_values($byModel);
        usort($models, function ($a, $b) {
            if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
            return ($a['cost'] < $b['cost']) ? 1 : -1;
        });
        $out[] = array(
            'userId' => (string) $uid,
            'name' => isset($names[$uid]) && $names[$uid] !== '' ? $names[$uid] : '已删除用户',
            'calls' => $calls,
            'cost' => $cost,
            'models' => array_slice($models, 0, 6),
        );
    }
    usort($out, function ($a, $b) {
        if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
        return ($a['cost'] < $b['cost']) ? 1 : -1;
    });
    return array_slice($out, 0, 12);
}

function tc_usage_rows($db, $userId, $days) {
    $uid = (string) $userId;
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $mine = tc_assoc(isset($ledger[$uid]) ? $ledger[$uid] : array());
    $out = array();
    foreach ($days as $day) {
        $row = tc_assoc(isset($mine[$day]) ? $mine[$day] : array());
        $models = array();
        $calls = 0;
        $cost = 0;
        $prompt = 0;
        $completion = 0;
        foreach ($row as $model => $cell) {
            $cell = tc_assoc($cell);
            $c = isset($cell['calls']) ? (int) $cell['calls'] : 0;
            $spent = isset($cell['cost']) ? (float) $cell['cost'] : 0;
            $pt = isset($cell['prompt']) ? (int) $cell['prompt'] : 0;
            $ct = isset($cell['completion']) ? (int) $cell['completion'] : 0;
            if ($c <= 0 && $spent <= 0 && $pt <= 0 && $ct <= 0) continue;
            $models[] = array('model' => (string) $model, 'calls' => $c, 'cost' => $spent, 'prompt' => $pt, 'completion' => $ct);
            $calls += $c;
            $cost += $spent;
            $prompt += $pt;
            $completion += $ct;
        }
        usort($models, function ($a, $b) {
            if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
            return ($a['cost'] < $b['cost']) ? 1 : -1;
        });
        if ($models) $out[] = array('day' => $day, 'calls' => $calls, 'cost' => $cost, 'prompt' => $prompt, 'completion' => $completion, 'models' => $models);
    }
    return array_reverse($out);
}

function tc_apply_model_vote(&$db, $model, $from, $to) {
    $name = substr(trim((string) $model), 0, 80);
    if ($name === '') return;
    $from = ($from === 'up' || $from === 'down') ? $from : '';
    $to = ($to === 'up' || $to === 'down') ? $to : '';
    if ($from === $to) return;
    $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
    $row = tc_assoc(isset($votes[$name]) ? $votes[$name] : array());
    $up = isset($row['up']) ? (int) $row['up'] : 0;
    $down = isset($row['down']) ? (int) $row['down'] : 0;
    if ($from === 'up') $up = max(0, $up - 1);
    if ($from === 'down') $down = max(0, $down - 1);
    if ($to === 'up') $up++;
    if ($to === 'down') $down++;
    if ($up === 0 && $down === 0) unset($votes[$name]);
    else $votes[$name] = array('up' => $up, 'down' => $down);
    $db['stats']['modelVotes'] = tc_object_map($votes);
}

function tc_model_vote_rows($db) {
    $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
    $rows = array();
    foreach ($votes as $model => $row) {
        $row = tc_assoc($row);
        $up = isset($row['up']) ? (int) $row['up'] : 0;
        $down = isset($row['down']) ? (int) $row['down'] : 0;
        $rows[] = array('model' => (string) $model, 'up' => $up, 'down' => $down);
    }
    usort($rows, function ($a, $b) {
        $da = ($b['up'] + $b['down']) - ($a['up'] + $a['down']);
        if ($da !== 0) return $da;
        return strcmp($a['model'], $b['model']);
    });
    return $rows;
}

function tc_valid_name($name) {
    return (bool) preg_match('/^[A-Za-z0-9_\x{4e00}-\x{9fa5}.@-]{2,32}$/u', $name);
}

function tc_uptime_sec() {
    $file = tc_data_dir() . '/.uptime';
    if (!is_file($file)) @file_put_contents($file, (string) time());
    $start = (int) @file_get_contents($file);
    if ($start <= 0) $start = time();
    return max(0, time() - $start);
}

function tc_seed_admin(&$db) {
    $password = (string) tc_cfg('admin_password');
    if ($password === '' || $password === '请改成你的密码') return false;
    $name = (string) (tc_cfg('admin_name') ?: 'admin');
    foreach ($db['users'] as $u) {
        if (!empty($u['admin'])) return false;
    }
    $user = array(
        'id' => tc_uid(),
        'name' => $name,
        'salt' => '',
        'passwordHash' => '',
        'quota' => 1e15,
        'createdAt' => tc_now(),
        'admin' => true,
        'groupId' => null,
        'tv' => 0,
    );
    tc_set_password($user, $password);
    $db['users'][] = $user;
    return true;
}

function tc_catalog() {
    static $cat = null;
    if ($cat !== null) return $cat;
    $file = __DIR__ . '/catalog.json';
    $j = json_decode((string) file_get_contents($file), true);
    $cat = is_array($j) ? $j : array('categories' => array(), 'assistants' => array(), 'DEFAULT_ASSISTANT_ID' => 'as-present');
    return $cat;
}
