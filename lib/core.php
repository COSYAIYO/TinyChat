<?php
/**
 * TinyChat PHP 核心：配置、JSON 库、JWT、密码、日志、限流。
 */
if (!defined('TC_ROOT')) {
    define('TC_ROOT', dirname(__DIR__));
}

define('TC_VERSION', '2.0.60');
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
    // 第三方一键登录:每个提供商的开关与凭据;开启且填全后前台登录页出现对应图标
    'oauthProviders' => array(),
    // 第三方登录时若未绑定过本站账号,是否自动建号(关闭则提示先注册并绑定)
    'oauthAutoRegister' => true,
    // 自动建号/首次绑定后是否强制补全用户名与密码(补全后即可脱离第三方用密码登录)
    'oauthRequireProfile' => false,
    'webSearchEnabled' => false,
    'webSearchProvider' => 'tavily',
    'webSearchTavilyKey' => '',
    'webSearchBraveKey' => '',
    'webSearchJinaKey' => '',
    'webSearchSearxUrl' => '',
    'webSearchMaxResults' => 5,
    'webSearchAllowUser' => false,
    'urlReadEnabled' => true,
    'urlReadMax' => 3,
    'mineruToken' => '',
    'mineruAllowUser' => false,
    'paddleOcrUrl' => '',
    'paddleOcrKey' => '',
    'mistralOcrKey' => '',
    'parseChannels' => array('pdf' => 'mineru', 'image' => 'mineru', 'office' => 'mineru'),
    'defaultGroupId' => '',
    'contextMessages' => 12,
    'maxContextMessages' => 200,
    'maxOutputTokens' => 8192,
    // 全局采样温度: null = 不发送该参数(用模型默认);设置后 0-2
    'temperature' => null,
    // 数据备份:每日自动备份整库快照到 data/backup/,保留最近 N 份
    'backupEnabled' => true,
    'backupKeep' => 7,
    // 代理接口限流:每用户每分钟最大请求数,0 = 不限制
    'rateLimitPerMin' => 30,
    // 会话:登录态有效天数;authEpoch 递增可强制全站重新登录
    'sessionDays' => 7,
    'authEpoch' => 1,
    // 从上游 context length 报错自动回填模型的 maxContext(不覆盖手动设置)
    'contextAutoLearn' => true,
    // 模型可用性显示阈值(%):成功率 ≥ healthOkMin 显示「良好」,≥ healthWarnMin 显示「一般」,低于则「较差」
    'healthOkMin' => 75,
    'healthWarnMin' => 40,
    // 内容审核:发送前对用户消息做敏感词过滤
    'moderation' => array('enabled' => false, 'words' => ''),
    // 用户协议:启用后注册页需勾选同意,/agreement 展示协议正文
    'agreementEnabled' => false,
    'agreementHtml' => '',
    // 隐私:关闭后服务器不保存对话记录(客户端仅本地留存)
    'persistChats' => true,
    // 开放 API 调用记录到用户的对话列表(前台可见,便于集中查看与配密钥;需 persistChats 开启)
    'apiSaveChats' => true,
    // 全站公告:enabled 且 text 非空时前台展示
    'announcement' => array('enabled' => false, 'text' => '', 'updatedAt' => 0),
    // OpenAI 兼容 API 出口:允许用户生成 sk- 密钥通过第三方客户端调用
    'apiKeysEnabled' => true,
    // API 密钥(开放接口)限流:每把密钥每分钟最大请求数,0 = 不限制
    'apiKeyRateLimitPerMin' => 60,
    // 开放接口对外暴露的模型白名单,元素形如 "providerId|modelId";为空数组表示全部可用模型
    'apiExposedModels' => array(),
    // 演示模式:演示管理员修改的设置将在演示有效期后自动还原
    'demoMode' => false,
    'demoExpireMinutes' => 10,
    // 游客模式:允许未登录访客直接体验对话;每个访客自动生成独立账号并归入游客组
    'guestEnabled' => false,
    // 游客可进行的有效对话轮数(每轮 1 次调用),新游客账号按此发放额度
    'guestRounds' => 3,
    // 注册邀请码:开启后注册必须提供有效邀请码
    'registerInviteRequired' => false,
    // 注册限流:每 IP 每小时最大注册尝试次数
    'registerLimitPerHour' => 5,
    // 性能优化(默认关闭,开启后减少前台加载体积;改动在用户下次访问时生效)
    // 不加载内置网页字体(思源宋体/阿里巴巴普惠体等,合计约 19MB);不加载 KaTeX 公式渲染;
    // 不加载代码高亮 highlight.js;不加载 Mermaid 图表。
    'perfNoWebfonts' => false,
    'perfNoKatex' => false,
    'perfNoHighlight' => false,
    'perfNoMermaid' => false,
    // 生图结果本地留存(默认开启):出图后即时把图片下载并存到本站 data/,
    // 避免上游图床链接过期导致历史图打不开。
    'imageArchiveEnabled' => true,
    // 本地留存总量上限(MB),超出按最旧优先清理
    'imageArchiveQuotaMb' => 500,
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
    // 第三方登录配置归一化:只接受注册表里的提供商与字段,凭据截断长度。
    // 注册表在 lib/oauth.php;单独加载 core 的场景(如 CI 自检)没有它,
    // 此时按已知字段名兜底,避免让整个数据层硬依赖可选模块。
    $oauthIn = isset($s['oauthProviders']) && is_array($s['oauthProviders']) ? $s['oauthProviders'] : array();
    $oauth = array();
    $oauthRegistry = function_exists('tc_oauth_providers') ? tc_oauth_providers() : array();
    if (!$oauthRegistry) {
        foreach (array('wechat', 'qq', 'linuxdo', 'nodeloc') as $pid) {
            $oauthRegistry[$pid] = array('fields' => array('appId' => 1, 'appSecret' => 1, 'appKey' => 1, 'clientId' => 1, 'clientSecret' => 1));
        }
    }
    foreach ($oauthRegistry as $pid => $prov) {
        $row = isset($oauthIn[$pid]) && is_array($oauthIn[$pid]) ? $oauthIn[$pid] : array();
        $clean = array('enabled' => !empty($row['enabled']));
        foreach (array_keys($prov['fields']) as $f) {
            $clean[$f] = substr(trim((string) (isset($row[$f]) ? $row[$f] : '')), 0, 200);
        }
        $oauth[$pid] = $clean;
    }
    $s['oauthProviders'] = $oauth;
    $s['oauthAutoRegister'] = !array_key_exists('oauthAutoRegister', $s) || !empty($s['oauthAutoRegister']);
    $s['oauthRequireProfile'] = !empty($s['oauthRequireProfile']);
    $s['loginLockMs'] = min(3600000, max(0, (int) $s['loginLockMs']));
    $s['webSearchEnabled'] = !empty($s['webSearchEnabled']);
    $prov = strtolower(trim((string) (isset($s['webSearchProvider']) ? $s['webSearchProvider'] : 'tavily')));
    $s['webSearchProvider'] = in_array($prov, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $prov : 'tavily';
    $s['webSearchTavilyKey'] = substr(trim((string) (isset($s['webSearchTavilyKey']) ? $s['webSearchTavilyKey'] : '')), 0, 200);
    $s['webSearchBraveKey'] = substr(trim((string) (isset($s['webSearchBraveKey']) ? $s['webSearchBraveKey'] : '')), 0, 200);
    $s['webSearchJinaKey'] = substr(trim((string) (isset($s['webSearchJinaKey']) ? $s['webSearchJinaKey'] : '')), 0, 200);
    $s['webSearchSearxUrl'] = tc_searx_urls_text(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '');
    $max = isset($s['webSearchMaxResults']) ? (int) $s['webSearchMaxResults'] : 5;
    $s['webSearchMaxResults'] = min(8, max(1, $max ?: 5));
    $s['webSearchAllowUser'] = !empty($s['webSearchAllowUser']);
    // 链接读取:用户消息里的 http(s) 链接自动抓取正文作为回答材料
    $s['urlReadEnabled'] = !array_key_exists('urlReadEnabled', $s) || !empty($s['urlReadEnabled']);
    $s['urlReadMax'] = min(5, max(1, (int) (isset($s['urlReadMax']) ? $s['urlReadMax'] : 3) ?: 3));
    $s['mineruToken'] = substr(trim((string) (isset($s['mineruToken']) ? $s['mineruToken'] : '')), 0, 300);
    $s['mineruAllowUser'] = !empty($s['mineruAllowUser']);
    // 文档解析通道:PaddleOCR 服务地址/Key、Mistral OCR Key,以及按类别的路由表
    $s['paddleOcrUrl'] = rtrim(trim((string) (isset($s['paddleOcrUrl']) ? $s['paddleOcrUrl'] : '')), '/');
    $s['paddleOcrKey'] = substr(trim((string) (isset($s['paddleOcrKey']) ? $s['paddleOcrKey'] : '')), 0, 300);
    $s['mistralOcrKey'] = substr(trim((string) (isset($s['mistralOcrKey']) ? $s['mistralOcrKey'] : '')), 0, 300);
    $channelsIn = isset($s['parseChannels']) && is_array($s['parseChannels']) ? $s['parseChannels'] : array();
    $channels = array();
    foreach (array('pdf', 'image', 'office') as $pcat) {
        $pval = strtolower(trim((string) (isset($channelsIn[$pcat]) ? $channelsIn[$pcat] : 'mineru')));
        $channels[$pcat] = in_array($pval, array('mineru', 'paddle', 'mistral'), true) ? $pval : 'mineru';
    }
    $s['parseChannels'] = $channels;
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
    $s['apiSaveChats'] = !array_key_exists('apiSaveChats', $s) || !empty($s['apiSaveChats']);
    // 可用性阈值:两个百分比,保证 okMin > warnMin(输入颠倒时自动纠正)
    $okMin = min(100, max(1, (int) (isset($s['healthOkMin']) ? $s['healthOkMin'] : 75) ?: 75));
    $warnMin = min(99, max(0, (int) (isset($s['healthWarnMin']) ? $s['healthWarnMin'] : 40)));
    if ($warnMin >= $okMin) $warnMin = max(0, $okMin - 1);
    $s['healthOkMin'] = $okMin;
    $s['healthWarnMin'] = $warnMin;
    $mod = isset($s['moderation']) && is_array($s['moderation']) ? $s['moderation'] : array();
    $s['moderation'] = array(
        'enabled' => !empty($mod['enabled']),
        'words' => tc_moderation_words_text(isset($mod['words']) ? $mod['words'] : ''),
    );
    $s['agreementEnabled'] = !empty($s['agreementEnabled']);
    $s['agreementHtml'] = substr((string) (isset($s['agreementHtml']) ? $s['agreementHtml'] : ''), 0, 200000);
    // 性能优化开关(默认关闭)
    $s['perfNoWebfonts'] = !empty($s['perfNoWebfonts']);
    $s['perfNoKatex'] = !empty($s['perfNoKatex']);
    $s['perfNoHighlight'] = !empty($s['perfNoHighlight']);
    $s['perfNoMermaid'] = !empty($s['perfNoMermaid']);
    // 生图本地留存:默认开启;总量上限限制在 50MB~10GB
    $s['imageArchiveEnabled'] = !array_key_exists('imageArchiveEnabled', $s) || !empty($s['imageArchiveEnabled']);
    $s['imageArchiveQuotaMb'] = min(10240, max(50, (int) (isset($s['imageArchiveQuotaMb']) ? $s['imageArchiveQuotaMb'] : 500) ?: 500));
    $s['persistChats'] = !array_key_exists('persistChats', $s) || !empty($s['persistChats']);
    $ann = isset($s['announcement']) && is_array($s['announcement']) ? $s['announcement'] : array();
    $annText = trim((string) (isset($ann['text']) ? $ann['text'] : ''));
    if (function_exists('mb_substr')) {
        $annText = mb_substr($annText, 0, 2000, 'UTF-8');
    } elseif (preg_match('/^.{0,2000}/us', $annText, $annSlice)) {
        $annText = $annSlice[0];
    } else {
        $annText = substr($annText, 0, 2000);
    }
    $annChanged = isset($ann['updatedAt']) ? (int) $ann['updatedAt'] : 0;
    $s['announcement'] = array(
        'enabled' => !empty($ann['enabled']) && $annText !== '',
        'text' => $annText,
        'updatedAt' => $annChanged,
    );
    $s['apiKeysEnabled'] = !array_key_exists('apiKeysEnabled', $s) || !empty($s['apiKeysEnabled']);
    $s['apiKeyRateLimitPerMin'] = min(600, max(0, (int) (isset($s['apiKeyRateLimitPerMin']) ? $s['apiKeyRateLimitPerMin'] : $TC_SETTINGS_DEFAULTS['apiKeyRateLimitPerMin'])));
    $exposed = isset($s['apiExposedModels']) && is_array($s['apiExposedModels']) ? $s['apiExposedModels'] : array();
    $exposedList = array();
    foreach ($exposed as $item) {
        $item = trim((string) $item);
        if ($item !== '' && strpos($item, '|') !== false) $exposedList[$item] = true;
    }
    $s['apiExposedModels'] = array_keys($exposedList);
    $s['demoMode'] = !empty($s['demoMode']);
    $s['demoExpireMinutes'] = min(1440, max(1, (int) (isset($s['demoExpireMinutes']) ? $s['demoExpireMinutes'] : 10) ?: 10));
    $s['guestEnabled'] = !empty($s['guestEnabled']);
    $s['guestRounds'] = min(1000, max(1, (int) (isset($s['guestRounds']) ? $s['guestRounds'] : 3) ?: 3));
    $s['registerInviteRequired'] = !empty($s['registerInviteRequired']);
    $s['registerLimitPerHour'] = min(1000, max(1, (int) (isset($s['registerLimitPerHour']) ? $s['registerLimitPerHour'] : 5) ?: 5));
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
    $prov = isset($s['webSearchProvider']) ? (string) $s['webSearchProvider'] : 'tavily';
    if ($prov === 'searxng') {
        return tc_searx_url_list(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '') !== array();
    }
    if ($prov === 'brave') {
        return trim((string) (isset($s['webSearchBraveKey']) ? $s['webSearchBraveKey'] : '')) !== '';
    }
    if ($prov === 'ddg' || $prov === 'jina') {
        return true; // 免 Key;Jina 填 Key 仅为提升配额
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
    $provider = strtolower(trim((string) (isset($raw['webSearchProvider']) ? $raw['webSearchProvider'] : 'tavily')));
    $provider = in_array($provider, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $provider : 'tavily';
    $max = isset($raw['webSearchMaxResults']) ? (int) $raw['webSearchMaxResults'] : 5;
    return array(
        'webSearchSource' => $src === 'own' ? 'own' : 'platform',
        'webSearchProvider' => $provider,
        'webSearchTavilyKey' => substr(trim((string) (isset($raw['webSearchTavilyKey']) ? $raw['webSearchTavilyKey'] : '')), 0, 200),
        'webSearchBraveKey' => substr(trim((string) (isset($raw['webSearchBraveKey']) ? $raw['webSearchBraveKey'] : '')), 0, 200),
        'webSearchJinaKey' => substr(trim((string) (isset($raw['webSearchJinaKey']) ? $raw['webSearchJinaKey'] : '')), 0, 200),
        'webSearchSearxUrl' => tc_searx_urls_text(isset($raw['webSearchSearxUrl']) ? $raw['webSearchSearxUrl'] : ''),
        'webSearchMaxResults' => min(8, max(1, $max ?: 5)),
        'parseSource' => $parse === 'own' ? 'own' : 'platform',
        'mineruToken' => substr(trim((string) (isset($raw['mineruToken']) ? $raw['mineruToken'] : '')), 0, 300),
    );
}

// 各检索源「用户自备配置是否已填完整」:ddg/jina 免 Key,恒可用
function tc_user_search_own_ready($tools) {
    $prov = isset($tools['webSearchProvider']) ? (string) $tools['webSearchProvider'] : 'tavily';
    if ($prov === 'searxng') return $tools['webSearchSearxUrl'] !== '';
    if ($prov === 'brave') return $tools['webSearchBraveKey'] !== '';
    if ($prov === 'ddg' || $prov === 'jina') return true;
    return $tools['webSearchTavilyKey'] !== '';
}

function tc_user_search_settings($user, $site) {
    $tools = tc_user_tools($user);
    if (!empty($site['webSearchAllowUser']) && $tools['webSearchSource'] === 'own') {
        return array(
            'webSearchEnabled' => true,
            'webSearchProvider' => $tools['webSearchProvider'],
            'webSearchTavilyKey' => $tools['webSearchTavilyKey'],
            'webSearchBraveKey' => $tools['webSearchBraveKey'],
            'webSearchJinaKey' => $tools['webSearchJinaKey'],
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
    $ownReady = tc_user_search_own_ready($tools);
    return array(
        'webSearch' => array(
            'allowOwn' => !empty($site['webSearchAllowUser']),
            'platformReady' => tc_web_search_ready($site),
            'source' => $tools['webSearchSource'],
            'provider' => $tools['webSearchProvider'],
            'hasKey' => $tools['webSearchTavilyKey'] !== '',
            'keyMask' => $tools['webSearchTavilyKey'] !== '' ? tc_mask_key($tools['webSearchTavilyKey']) : '',
            'braveKeyMask' => $tools['webSearchBraveKey'] !== '' ? tc_mask_key($tools['webSearchBraveKey']) : '',
            'jinaKeyMask' => $tools['webSearchJinaKey'] !== '' ? tc_mask_key($tools['webSearchJinaKey']) : '',
            'searxUrl' => $tools['webSearchSearxUrl'],
            'maxResults' => $tools['webSearchMaxResults'],
            'ownReady' => $ownReady,
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
    $channels = isset($s['parseChannels']) && is_array($s['parseChannels']) ? $s['parseChannels'] : array();
    return array(
        'enabled' => true,
        'mode' => tc_mineru_token($s) !== '' ? 'precise' : 'lite',
        'allowOwn' => !empty($s['mineruAllowUser']),
        'routes' => array(
            'pdf' => isset($channels['pdf']) ? $channels['pdf'] : 'mineru',
            'image' => isset($channels['image']) ? $channels['image'] : 'mineru',
            'office' => isset($channels['office']) ? $channels['office'] : 'mineru',
        ),
    );
}

function tc_web_search_public($s) {
    $prov = isset($s['webSearchProvider']) ? (string) $s['webSearchProvider'] : 'tavily';
    return array(
        'enabled' => tc_web_search_ready($s),
        'provider' => in_array($prov, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $prov : 'tavily',
        'allowOwn' => !empty($s['webSearchAllowUser']),
    );
}

function tc_admin_settings_public($s) {
    $out = is_array($s) ? $s : array();
    if (!empty($out['webSearchTavilyKey'])) $out['webSearchTavilyKey'] = tc_mask_key($out['webSearchTavilyKey']);
    if (!empty($out['paddleOcrKey'])) $out['paddleOcrKey'] = tc_mask_key($out['paddleOcrKey']);
    if (!empty($out['mistralOcrKey'])) $out['mistralOcrKey'] = tc_mask_key($out['mistralOcrKey']);
    if (!empty($out['webSearchBraveKey'])) $out['webSearchBraveKey'] = tc_mask_key($out['webSearchBraveKey']);
    if (!empty($out['webSearchJinaKey'])) $out['webSearchJinaKey'] = tc_mask_key($out['webSearchJinaKey']);
    if (!empty($out['mineruToken'])) $out['mineruToken'] = tc_mask_key($out['mineruToken']);
    // 第三方登录密钥掩码(前端回显用;保存时按 •• 跳过,不回写)
    if (!empty($out['oauthProviders']) && is_array($out['oauthProviders'])) {
        foreach ($out['oauthProviders'] as $pid => $row) {
            if (!is_array($row)) continue;
            foreach (array('appSecret', 'appKey', 'clientSecret') as $sk) {
                if (!empty($row[$sk])) $out['oauthProviders'][$pid][$sk] = tc_mask_key($row[$sk]);
            }
        }
    }
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
        // 演示模式快照:演示管理员改动前的站点状态,到期后由 tc_demo_revert 还原
        'demoSnapshot' => null,
    );
}

function tc_is_demo_user($u) {
    return is_array($u) && !empty($u['demo']);
}

// 快照覆盖范围:演示管理员能改动的站点内容。settings 含公告/限流/思考等全部设置。
function tc_demo_snapshot_fields() {
    return array('settings', 'accessRules', 'providers', 'packages', 'assistants', 'defaultProviderId');
}

// 拍一张演示快照(改动前的状态),并按设置的有效期计时。
// 已有生效中的快照时不覆盖——必须保留最早那份作为还原基准。
// $force=true 用于「把某个用户转为演示管理员」:以转为演示的那一刻作为还原原点,
// 强制重拍快照并重新计时,而不是沿用上一轮还没到期的旧基准。
function tc_demo_arm(&$db, $user, $force = false) {
    if (!tc_is_demo_user($user)) return false;
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    if (!$force && is_array($snap) && !empty($snap['expireAt']) && tc_now() < (int) $snap['expireAt']) return false;
    $minutes = (int) (isset($db['settings']['demoExpireMinutes']) ? $db['settings']['demoExpireMinutes'] : 10);
    $minutes = min(1440, max(1, $minutes ?: 10));
    $uid = isset($user['id']) ? (string) $user['id'] : '';
    $snapshot = array(
        'expireAt' => tc_now() + $minutes * 60000,
        'userId' => $uid,
        'minutes' => $minutes,
    );
    foreach (tc_demo_snapshot_fields() as $k) {
        $snapshot[$k] = isset($db[$k]) ? $db[$k] : null;
    }
    // 演示管理员的「个人数据」同样在转换那一刻定格:自己的对话与额度,到期后一并恢复。
    $chatsMap = tc_assoc(isset($db['userChats']) ? $db['userChats'] : array());
    $snapshot['demoChats'] = ($uid !== '' && isset($chatsMap[$uid]) && is_array($chatsMap[$uid])) ? $chatsMap[$uid] : array();
    $revMap = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    $snapshot['demoChatRevision'] = isset($revMap[$uid]) ? (int) $revMap[$uid] : 0;
    $snapshot['demoQuota'] = isset($user['quota']) ? $user['quota'] : 0;
    $snapshot['demoQuotaGrants'] = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    $db['demoSnapshot'] = $snapshot;
    $db['settings']['demoMode'] = true;
    return true;
}

// 演示有效期到期后,把演示管理员改动过的内容还原为快照值
function tc_demo_revert(&$db) {
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    if (!is_array($snap) || empty($snap['expireAt'])) return false;
    if (tc_now() < (int) $snap['expireAt']) return false;
    if (isset($snap['settings']) && is_array($snap['settings'])) {
        $db['settings'] = tc_normalize_settings($snap['settings']);
    }
    foreach (array('accessRules', 'providers', 'packages', 'assistants') as $k) {
        if (isset($snap[$k]) && is_array($snap[$k])) $db[$k] = $snap[$k];
    }
    if (array_key_exists('defaultProviderId', $snap)) {
        $db['defaultProviderId'] = $snap['defaultProviderId'];
    }
    // 恢复演示管理员的个人数据(对话 / 额度)到转换那一刻。
    // 若该账号已被改回普通用户,则其数据保留、不还原(见需求:转普通用户后数据保留)。
    $uid = isset($snap['userId']) ? (string) $snap['userId'] : '';
    if ($uid !== '') {
        $stillDemo = false;
        foreach ($db['users'] as $u) {
            if (isset($u['id']) && (string) $u['id'] === $uid) { $stillDemo = !empty($u['demo']); break; }
        }
        if ($stillDemo) {
            if (array_key_exists('demoChats', $snap) && is_array($snap['demoChats'])) {
                $chatsMap = tc_assoc(isset($db['userChats']) ? $db['userChats'] : array());
                $chatsMap[$uid] = $snap['demoChats'];
                $db['userChats'] = tc_object_map($chatsMap);
                $revMap = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
                $revMap[$uid] = (isset($revMap[$uid]) ? (int) $revMap[$uid] : 0) + 1;
                $db['userChatRevisions'] = tc_object_map($revMap);
            }
            foreach ($db['users'] as &$u) {
                if (!isset($u['id']) || (string) $u['id'] !== $uid) continue;
                if (array_key_exists('demoQuota', $snap)) $u['quota'] = $snap['demoQuota'];
                if (array_key_exists('demoQuotaGrants', $snap)) $u['quotaGrants'] = $snap['demoQuotaGrants'];
                break;
            }
            unset($u);
        }
    }
    $db['demoSnapshot'] = null;
    return true;
}

// 采集快照覆盖字段的当前值(供真实管理员改动前后比对)
function tc_demo_capture($db) {
    $out = array();
    foreach (tc_demo_snapshot_fields() as $k) {
        $out[$k] = isset($db[$k]) ? $db[$k] : null;
    }
    return $out;
}

// 真实管理员改动生效后,只把「确实被动过的字段」写回快照基线。
// 这样真实管理员的修改成为新的还原基准(不会被演示到期还原冲掉),
// 又不会把演示管理员在其它字段上的在途改动一并固化。
function tc_demo_rebaseline(&$db, $before) {
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    if (!is_array($snap) || empty($snap['expireAt']) || !is_array($before)) return false;
    $changed = false;
    foreach (tc_demo_snapshot_fields() as $k) {
        $cur = isset($db[$k]) ? $db[$k] : null;
        $old = array_key_exists($k, $before) ? $before[$k] : null;
        if ($k === 'settings' && is_array($cur) && is_array($old)) {
            // settings 逐键比对:演示管理员在别的设置项上的改动不会被顺带固化
            $merged = isset($snap[$k]) && is_array($snap[$k]) ? $snap[$k] : array();
            foreach ($cur as $sk => $sv) {
                $ov = array_key_exists($sk, $old) ? $old[$sk] : null;
                if (tc_json_encode($ov) !== tc_json_encode($sv)) { $merged[$sk] = $sv; $changed = true; }
            }
            foreach ($old as $sk => $ov) {
                if (!array_key_exists($sk, $cur) && array_key_exists($sk, $merged)) { unset($merged[$sk]); $changed = true; }
            }
            $snap[$k] = $merged;
        } elseif (tc_json_encode($cur) !== tc_json_encode($old)) {
            $snap[$k] = $cur;
            $changed = true;
        }
    }
    if ($changed) $db['demoSnapshot'] = $snap;
    return $changed;
}

// 邀请码可用次数:未设置视为 1 次(老数据兼容),<0 表示不限次数
function tc_invite_max_uses($c) {
    if (!is_array($c) || !array_key_exists('maxUses', $c)) return 1;
    $n = (int) $c['maxUses'];
    if ($n < 0) return -1;
    return max(1, $n);
}

function tc_invite_used_count($c) {
    if (!is_array($c)) return 0;
    if (array_key_exists('usedCount', $c)) return max(0, (int) $c['usedCount']);
    return !empty($c['usedBy']) ? 1 : 0;
}

function tc_invite_is_usable($c) {
    if (!is_array($c) || empty($c['code'])) return false;
    $max = tc_invite_max_uses($c);
    if ($max < 0) return true;
    return tc_invite_used_count($c) < $max;
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

// 新添加的全局供应商默认授权给全部用户组(含自定义组),即"新模型默认对所有分组开放"
function tc_grant_all_groups_provider(&$db, $providerId) {
    if (!$providerId) return;
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (empty($g['id'])) continue;
        $exists = false;
        foreach ($db['accessRules'] as $r) {
            if ($r['groupId'] === $g['id'] && $r['providerId'] === $providerId) { $exists = true; break; }
        }
        if ($exists) continue;
        $db['accessRules'][] = array('id' => tc_uid(), 'groupId' => $g['id'], 'providerId' => $providerId, 'modelIds' => array('*'));
    }
}

// 供应商新增模型时,把"本次新出现的模型 ID"补进该供应商已有的授权规则:
// 通配规则('*')本就覆盖新模型;显式清单只追加新模型,
// 不回填管理员此前刻意取消勾选的模型。
function tc_sync_new_models_access(&$db, $providerId, $newModelIds) {
    if (!is_array($newModelIds) || !$newModelIds) return;
    $add = array();
    foreach ($newModelIds as $mid) {
        $mid = (string) $mid;
        if ($mid !== '') $add[$mid] = true;
    }
    if (!$add) return;
    foreach ($db['accessRules'] as &$r) {
        if (!isset($r['providerId']) || $r['providerId'] !== $providerId) continue;
        $ids = isset($r['modelIds']) && is_array($r['modelIds']) ? $r['modelIds'] : array();
        if (!$ids || in_array('*', $ids, true)) continue;
        $changed = false;
        foreach (array_keys($add) as $mid) {
            if (!in_array($mid, $ids, true)) { $ids[] = $mid; $changed = true; }
        }
        if ($changed) $r['modelIds'] = array_values($ids);
    }
    unset($r);
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
    $guestGid = tc_ensure_builtin_group($db, 'guest', '游客');
    tc_grant_group_all_globals($db, $adminGid);
    foreach ($db['users'] as &$u) {
        $gid = isset($u['groupId']) ? (string) $u['groupId'] : '';
        if (!empty($u['admin'])) {
            if ($gid === '' || !tc_group_by_id($db, $gid)) $u['groupId'] = $adminGid;
        } elseif (!empty($u['guest'])) {
            // 游客账号固定归入游客组,便于后台按组限轮数与清理
            $u['groupId'] = $guestGid;
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
    // 默认值一次性迁移(v2.0.52):把「仍等于旧默认值」的存量设置顺移到新默认值。
    // 仅当字段确实存在且等于旧默认值时才改——管理员自定义过的值一律不动。
    // 用独立标记键避免重复执行(该键会由逐键比对机制自动落库)。
    if (empty($db['settingsMigrated52']) && isset($db['settings']) && is_array($db['settings'])) {
        if (array_key_exists('contextMessages', $db['settings']) && (int) $db['settings']['contextMessages'] === 40) {
            $db['settings']['contextMessages'] = 12;
        }
    }
    $db['settingsMigrated52'] = true;
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
    foreach ($db['providers'] as $pi => &$p) {
        if (!isset($p['models']) || !is_array($p['models'])) $p['models'] = array();
        if (!isset($p['costPerCall']) || !is_numeric($p['costPerCall'])) $p['costPerCall'] = 1;
        if (!isset($p['scope']) || $p['scope'] !== 'global') $p['scope'] = 'user';
        if (!array_key_exists('enabled', $p)) $p['enabled'] = true;
        if (empty($p['createdAt'])) $p['createdAt'] = tc_now();
        // 供应商排序:旧数据按当前数组顺序补一个 order,之后可在后台调整
        if (!isset($p['order']) || !is_numeric($p['order'])) $p['order'] = $pi;
    }
    unset($p);
    // 旧数据补的 order 即原数组下标,顺序不变;已排过序的数据保持其顺序
    if (function_exists('tc_sort_providers')) $db['providers'] = tc_sort_providers($db['providers']);
    if (!empty($db['defaultProviderId'])) {
        $found = false;
        foreach ($db['providers'] as $p) {
            if ($p['id'] === $db['defaultProviderId']) { $found = true; break; }
        }
        if (!$found) $db['defaultProviderId'] = null;
    }
    tc_ensure_default_group($db);
    // 清理指向已不存在用户组的授权规则(旧版每次加载重生成组 ID 会留下这类孤儿规则)
    $validGroups = array();
    foreach ($db['userGroups'] as $g) if (!empty($g['id'])) $validGroups[(string) $g['id']] = true;
    $db['accessRules'] = array_values(array_filter($db['accessRules'], function ($r) use ($validGroups) {
        return is_array($r) && !empty($r['groupId']) && isset($validGroups[(string) $r['groupId']]);
    }));
    return $db;
}

function tc_db_file() { return tc_data_dir() . '/tinychat.sqlite'; }

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

function tc_backup_create($db = null) {
    $name = 'db-' . date('Ymd-His') . '.json';
    if (is_file(tc_backup_dir() . '/' . $name)) {
        // 同一秒内多次备份:追加短随机后缀避免覆盖
        $name = 'db-' . date('Ymd-His') . '-' . substr(bin2hex(random_bytes(2)), 0, 4) . '.json';
    }
    try {
        $snapshot = $db !== null ? $db : tc_with_db(false, function ($d) { return $d; });
        $json = tc_json_encode($snapshot);
    } catch (Throwable $e) {
        return null;
    }
    if (file_put_contents(tc_backup_dir() . '/' . $name, $json, LOCK_EX) === false) return null;
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
function tc_backup_maybe($db) {
    $settings = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
    if (empty($settings['backupEnabled'])) return;
    try {
        $list = tc_backup_list();
        if ($list && (tc_now() - (int) $list[0]['time']) < 24 * 3600 * 1000) return;
        if (tc_backup_create($db) !== null) tc_backup_prune($settings);
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

function tc_rate_limit_check($key, $limitPerMin, $windowMs = 60000) {
    $limit = (int) $limitPerMin;
    if ($limit <= 0 || $key === '') return true;
    $window = max(1000, (int) $windowMs);
    $fp = @fopen(tc_rate_limit_file($key), 'c+');
    if (!$fp) return true; // 计数存储不可用时不拦截主流程
    @flock($fp, LOCK_EX);
    $data = json_decode((string) stream_get_contents($fp), true);
    $now = tc_now();
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

// ---- 数据库:SQLite(WAL 模式) ----
// 库表 store(k, v):顶层键各占一行(JSON 编码);userChats 例外——按用户拆成 chat:{uid} 行,
// 聊天保存只重写该用户自己的行。事务由 SQLite 原生保证,不再依赖 flock 与全量重写。
function tc_db() {
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    if (!extension_loaded('pdo_sqlite')) throw new RuntimeException('主机缺少 pdo_sqlite 扩展，无法运行');
    $pdo = new PDO('sqlite:' . tc_db_file(), null, null, array(
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ));
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec('PRAGMA busy_timeout=5000');
    $pdo->exec('PRAGMA synchronous=NORMAL');
    $pdo->exec('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    tc_db_import_legacy($pdo);
    return $pdo;
}

// 一次性导入旧版 db.json(存在且库为空时),导入成功后原文件改名留档
function tc_db_import_legacy($pdo) {
    $legacy = tc_data_dir() . '/db.json';
    if (!is_file($legacy)) return;
    $n = (int) $pdo->query('SELECT COUNT(*) FROM store')->fetchColumn();
    if ($n > 0) return;
    $json = json_decode((string) @file_get_contents($legacy), true);
    if (is_array($json) && isset($json['users']) && is_array($json['users']) && count($json['users']) > 0) {
        try {
            tc_db_write_snapshot($pdo, tc_migrate_db($json));
        } catch (Throwable $e) {
            return; // 导入失败保留原文件,继续以空库运行
        }
    }
    @rename($legacy, $legacy . '.imported-' . date('Ymd-His'));
}

// 从 store 表装配出业务数组(含迁移与默认值),userChats 保持 stdClass 形状
function tc_db_load_all($pdo) {
    $db = tc_empty_db();
    $db['userChats'] = new stdClass();
    $rows = $pdo->query('SELECT k, v FROM store')->fetchAll();
    foreach ($rows as $row) {
        $k = (string) $row['k'];
        if (strncmp($k, 'chat:', 5) === 0) {
            $val = json_decode($row['v'], true);
            if (is_array($val)) {
                $uid = substr($k, 5);
                $db['userChats']->$uid = $val;
            }
            continue;
        }
        $val = json_decode($row['v'], true);
        if ($val === null && $row['v'] !== 'null') continue;
        $db[$k] = $val;
    }
    return tc_migrate_db($db);
}

// 存储层原始快照:顶层键与 chat: 行分别给出 JSON 文本,用于提交时的逐键变更检测
function tc_db_raw_snapshot($pdo) {
    $orig = array();
    $origChats = array();
    foreach ($pdo->query('SELECT k, v FROM store') as $row) {
        $k = (string) $row['k'];
        if (strncmp($k, 'chat:', 5) === 0) {
            $origChats[substr($k, 5)] = (string) $row['v'];
        } else {
            $orig[$k] = (string) $row['v'];
        }
    }
    return array($orig, $origChats);
}

// 整库快照写入(迁移导入 / 恢复备份用):清空后按顶层键落行
function tc_db_write_snapshot($pdo, $db) {
    $pdo->exec('DELETE FROM store');
    $ins = $pdo->prepare('INSERT INTO store (k, v) VALUES (:k, :v)');
    foreach ($db as $k => $v) {
        if ($k === 'userChats') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'chat:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        $ins->execute(array(':k' => $k, ':v' => tc_json_encode($v)));
    }
}

function tc_with_db($write, $fn) {
    // 完整性校验的第二道关卡:即使入口处的检查被移除,任何走数据库的请求也会在此拦截。
    // 结果按请求缓存,不产生额外文件读取开销。
    tc_integrity_guard();
    $pdo = tc_db();
    // 变更检测基线取自"迁移前"的原始存储;若取自迁移后,迁移过程新建的
    // userGroups / defaultGroupId 会被视为"未变化"而永不落库,导致每次请求都生成
    // 新的用户组 ID,授权规则随之全部失效。
    list($orig, $origChats) = tc_db_raw_snapshot($pdo);
    $db = tc_db_load_all($pdo);
    $GLOBALS['_tc_db'] = &$db;
    $GLOBALS['_tc_demo_before'] = null;
    $GLOBALS['_tc_db_ctx'] = array(
        'write' => $write, 'committed' => false, 'pdo' => $pdo,
        'orig' => $orig, 'origChats' => $origChats,
    );
    try {
        if ($write) $pdo->exec('BEGIN IMMEDIATE');
        $ret = $fn($db);
        tc_db_commit();
        return $ret;
    } catch (Throwable $e) {
        if (empty($GLOBALS['_tc_db_ctx']['committed'])) {
            try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) {}
            $GLOBALS['_tc_db_ctx']['committed'] = true;
        }
        throw $e;
    } finally {
        tc_db_release();
    }
}

function tc_db_skip_write() {
    if (empty($GLOBALS['_tc_db_ctx']) || !empty($GLOBALS['_tc_db_ctx']['committed'])) return;
    $GLOBALS['_tc_db_ctx']['committed'] = true;
    if (!empty($GLOBALS['_tc_db_ctx']['write'])) {
        try { $GLOBALS['_tc_db_ctx']['pdo']->exec('ROLLBACK'); } catch (Throwable $e) {}
    }
}

// 提交:只写发生变化的行(逐键比对),userChats 按用户粒度比对
function tc_db_commit() {
    if (empty($GLOBALS['_tc_db_ctx']) || !empty($GLOBALS['_tc_db_ctx']['committed'])) return;
    $ctx = &$GLOBALS['_tc_db_ctx'];
    $ctx['committed'] = true;
    $pdo = $ctx['pdo'];
    if (empty($ctx['write'])) return; // 读请求不落库
    try {
        $db = $GLOBALS['_tc_db'];
        // 真实管理员改动生效后,把被改动的字段写回演示快照基线
        if (!empty($GLOBALS['_tc_demo_before']) && isset($db['demoSnapshot'])) {
            tc_demo_rebaseline($db, $GLOBALS['_tc_demo_before']);
        }
        $GLOBALS['_tc_demo_before'] = null;
        $ups = $pdo->prepare('INSERT INTO store (k, v) VALUES (:k, :v) ON CONFLICT(k) DO UPDATE SET v = :v2');
        $del = $pdo->prepare('DELETE FROM store WHERE k = :k');
        $newChats = tc_assoc(isset($db['userChats']) ? $db['userChats'] : null);
        foreach ($db as $k => $v) {
            if ($k === 'userChats') {
                foreach ($newChats as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($ctx['origChats'][$uid]) && $ctx['origChats'][$uid] === $json) continue;
                    $ups->execute(array(':k' => 'chat:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($ctx['origChats'] as $uid => $json) {
                    if (!array_key_exists($uid, $newChats)) $del->execute(array(':k' => 'chat:' . $uid));
                }
                continue;
            }
            $json = tc_json_encode($v);
            if (isset($ctx['orig'][$k]) && $ctx['orig'][$k] === $json) continue;
            $ups->execute(array(':k' => $k, ':v' => $json, ':v2' => $json));
        }
        foreach ($ctx['orig'] as $k => $json) {
            if (!array_key_exists($k, $db)) $del->execute(array(':k' => $k));
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) {}
        throw new RuntimeException('数据库写入失败: ' . $e->getMessage());
    }
}

function tc_db_release() {
    tc_db_commit();
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
        'demo' => !empty($u['demo']),
        'demoExpireAt' => !empty($u['demoExpireAt']) ? (int) $u['demoExpireAt'] : 0,
        'guest' => !empty($u['guest']),
        'lastIp' => isset($u['lastIp']) ? (string) $u['lastIp'] : '',
        'groupId' => isset($u['groupId']) ? $u['groupId'] : null,
        // 是否已设密码:第三方登录建号的用户为 false,前端据此隐藏「当前密码」并允许直接设置
        'hasPassword' => isset($u['passwordHash']) && (string) $u['passwordHash'] !== '',
    );
}

// 演示管理员敏感操作守卫:账号管理、查看对话、公告等一律拒绝,并给出统一提示。
// $reason 传入完整的拒绝原因文案。
function tc_demo_guard($user, $reason = '演示管理员不可修改此处') {
    if (is_array($user) && !empty($user['demo'])) {
        tc_fail(403, $reason);
    }
}

function tc_touch_user(&$db, $userId) {
    $userId = (string) $userId;
    if ($userId === '') return;
    foreach ($db['users'] as &$u) {
        if (!isset($u['id']) || $u['id'] !== $userId) continue;
        $u['lastSeen'] = tc_now();
        // 记录最近来源 IP,后台用户列表据此展示与排查
        $ip = tc_client_ip();
        if ($ip !== '' && $ip !== 'unknown') $u['lastIp'] = $ip;
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

// 读取供应商明文 Key(默认/第一把):enc1. 密文按 AAD 解密,旧明文原样返回(兼容未迁移数据)
function tc_provider_key($p) {
    $k = isset($p['apiKey']) ? (string) $p['apiKey'] : '';
    if ($k === '') {
        // 多密钥结构:退回第一把密钥
        $keys = tc_provider_keys($p);
        if (!$keys) return '';
        $v = (string) $keys[0]['apiKey'];
        if ($v === '') return '';
        return strpos($v, 'enc1.') === 0 ? tc_decrypt_secret($v, tc_provider_key_aad($p)) : $v;
    }
    if (strpos($k, 'enc1.') === 0) return tc_decrypt_secret($k, tc_provider_key_aad($p));
    return $k;
}

// ---- 多密钥支持:一个供应商可配置多个 Key(各自命名),模型可绑定到指定 Key ----
// 归一化供应商的密钥列表。兼容旧的单 `apiKey` 字段:
// 返回 [['id'=>string,'name'=>string,'apiKey'=>密文或明文], ...];无任何 Key 时返回 []。
function tc_provider_keys($p) {
    $out = array();
    if (isset($p['keys']) && is_array($p['keys'])) {
        foreach ($p['keys'] as $k) {
            if (!is_array($k)) continue;
            $id = substr(trim((string) (isset($k['id']) ? $k['id'] : '')), 0, 40);
            if ($id === '') $id = 'k' . substr(hash('sha256', tc_json_encode($k)), 0, 6);
            $out[] = array(
                'id' => $id,
                'name' => substr(trim((string) (isset($k['name']) ? $k['name'] : '')), 0, 40),
                'apiKey' => isset($k['apiKey']) ? (string) $k['apiKey'] : '',
            );
        }
    }
    if (!$out && isset($p['apiKey']) && (string) $p['apiKey'] !== '') {
        // 旧数据:单 Key 视为一个无名密钥,固定 id 便于模型引用
        $out[] = array('id' => 'k0', 'name' => '', 'apiKey' => (string) $p['apiKey']);
    }
    return $out;
}

// 供应商的默认(第一个)密钥 id;无密钥返回 ''
function tc_provider_default_key_id($p) {
    $keys = tc_provider_keys($p);
    return $keys ? (string) $keys[0]['id'] : '';
}

// 取指定 keyId 的明文密钥;找不到时回退默认密钥
function tc_provider_key_by_id($p, $keyId) {
    $keyId = trim((string) $keyId);
    $keys = tc_provider_keys($p);
    if (!$keys) return '';
    $pick = null;
    if ($keyId !== '') {
        foreach ($keys as $k) if ((string) $k['id'] === $keyId) { $pick = $k; break; }
    }
    if (!$pick) $pick = $keys[0];
    $v = (string) $pick['apiKey'];
    if ($v === '') return '';
    if (strpos($v, 'enc1.') === 0) return tc_decrypt_secret($v, tc_provider_key_aad($p));
    return $v;
}

// 模型绑定的密钥 id 链(按调用优先级排序)。兼容旧的单个 keyId 字段。
function tc_model_key_ids($p, $modelId) {
    $id = trim((string) $modelId);
    if ($id === '' || empty($p['models']) || !is_array($p['models'])) return array();
    foreach ($p['models'] as $m) {
        if (!is_array($m)) continue;
        if ((string) (isset($m['id']) ? $m['id'] : '') !== $id) continue;
        $out = array();
        if (isset($m['keyIds']) && is_array($m['keyIds'])) {
            foreach ($m['keyIds'] as $kid) {
                $kid = trim((string) $kid);
                if ($kid !== '' && !in_array($kid, $out, true)) $out[] = $kid;
            }
        }
        if (!$out && isset($m['keyId']) && trim((string) $m['keyId']) !== '') $out[] = trim((string) $m['keyId']);
        return $out;
    }
    return array();
}

// 按模型解析出「按优先级排列的明文密钥链」:依次尝试,前一把失败自动换下一把。
// 链的组成:模型显式绑定的密钥(按顺序)在前;其后把该供应商「其余尚未入选的密钥」按供应商
// 顺序追加为备用。这样「配了多把 Key」就能天然获得多重保障——即使模型只绑了一把(或没绑),
// 第一把认证失败/连不上时也会自动尝试供应商下的其它 Key,无需逐个模型手动配链。
function tc_provider_key_chain($p, $modelId) {
    $out = array();
    $add = function ($plain) use (&$out) {
        $plain = (string) $plain;
        if ($plain !== '' && !in_array($plain, $out, true)) $out[] = $plain;
    };
    foreach (tc_model_key_ids($p, $modelId) as $kid) {
        $add(tc_provider_key_by_id($p, $kid));
    }
    // 追加供应商下其余密钥作备用(显式绑定的排在最前,保持用户设定的优先级)
    foreach (tc_provider_keys($p) as $k) {
        $add(tc_provider_key_by_id($p, (string) $k['id']));
    }
    if ($out) return $out;
    $def = tc_provider_key($p);
    return $def === '' ? array() : array($def);
}

// 按模型选用密钥:取链中的第一把(调用方需要回退时用 tc_provider_key_chain)。
// 这是「多 Key 下请求必须用用户设置的那把 Key」的落地点。
function tc_provider_key_for_model($p, $modelId) {
    $chain = tc_provider_key_chain($p, $modelId);
    return $chain ? $chain[0] : '';
}

// Key 名称唯一性校验(多 Key 时名称不可重复且不可为空),返回错误信息或 ''
function tc_provider_keys_error($keys) {
    if (count($keys) < 2) return '';
    $seen = array();
    foreach ($keys as $k) {
        $name = trim((string) (isset($k['name']) ? $k['name'] : ''));
        if ($name === '') return '配置了多个 Key 时，每个 Key 都需要填写名称';
        $low = strtolower($name);
        if (isset($seen[$low])) return 'Key 名称不能重复：' . $name;
        $seen[$low] = true;
    }
    return '';
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
    // 演示管理员:每次写入前确保有一张生效中的还原快照。
    // 这样"改动 → 到期还原"可以反复进行,而不是只保护第一轮改动。
    if (!empty($GLOBALS['_tc_db_ctx']['write']) && isset($GLOBALS['_tc_db'])) {
        if (tc_is_demo_user($user)) {
            tc_demo_arm($GLOBALS['_tc_db'], $user);
        } elseif (is_array(isset($GLOBALS['_tc_db']['demoSnapshot']) ? $GLOBALS['_tc_db']['demoSnapshot'] : null)) {
            // 真实管理员的改动要生效,并在提交时把被改动的字段写回快照(成为新的还原基准)
            $GLOBALS['_tc_demo_before'] = tc_demo_capture($db);
        }
    }
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
    // PHP 警告/通知若被 display_errors 直接打印出来,会污染 JSON 响应,
    // 前端就会报 "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"。
    // 这里统一改为只写日志不输出,保证接口响应始终是合法 JSON。
    @ini_set('display_errors', '0');
    @ini_set('html_errors', '0');
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

// 日志内容上限:提示词/回复按字符截断,避免 logs.json 过度膨胀
// (日志文件每次写入都整体重写,内容上限直接决定单次 I/O 大小)
if (!defined('TC_LOG_TEXT_LIMIT')) define('TC_LOG_TEXT_LIMIT', 10000);

function tc_log_clip($s, $n) {
    $s = (string) $s;
    if ($n <= 0 || strlen($s) <= $n) return $s;
    // 按字符边界截断,避免把多字节字符切坏
    $cut = mb_substr($s, 0, $n, 'UTF-8');
    return $cut . "\n…（已截断，共 " . mb_strlen($s, 'UTF-8') . ' 字）';
}

function tc_push_log($entry) {
    $file = tc_logs_file();
    $fp = fopen($file, 'c+');
    if (!$fp) return 0;
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
    return $item['id'];
}

// 回填日志条目(流式对话在收尾时才有完整回复/用量,先记 id 再补内容)
function tc_update_log($id, $patch) {
    $id = (int) $id;
    if ($id <= 0 || !is_array($patch) || !$patch) return false;
    $file = tc_logs_file();
    if (!is_file($file)) return false;
    $fp = fopen($file, 'c+');
    if (!$fp) return false;
    flock($fp, LOCK_EX);
    $data = json_decode((string) stream_get_contents($fp), true);
    if (!is_array($data) || empty($data['items'])) { flock($fp, LOCK_UN); fclose($fp); return false; }
    $hit = false;
    foreach ($data['items'] as &$it) {
        if (isset($it['id']) && (int) $it['id'] === $id) {
            foreach ($patch as $k => $v) $it[$k] = $v;
            $hit = true;
            break;
        }
    }
    unset($it);
    if ($hit) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, tc_json_encode($data));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $hit;
}

// 对话日志的通用元信息:提示词(最后一条用户消息)与来源 IP
function tc_log_chat_meta($body, $format) {
    $prompt = '';
    if (function_exists('tc_last_user_text')) $prompt = tc_last_user_text($body, $format);
    return array(
        'prompt' => tc_log_clip($prompt, 8000),
        'ip' => tc_client_ip(),
    );
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

// 单次调用实际扣费:模型级 cost 优先(实现「同一供应商下各模型不同价格」),未设置时回退供应商的 costPerCall
function tc_model_cost($provider, $modelId) {
    $id = trim((string) $modelId);
    if ($id !== '' && !empty($provider['models']) && is_array($provider['models'])) {
        foreach ($provider['models'] as $m) {
            if (!is_array($m)) continue;
            if ((string) (isset($m['id']) ? $m['id'] : '') !== $id) continue;
            if (array_key_exists('cost', $m)) {
                $c = (float) $m['cost'];
                if (is_numeric($c) && !is_nan($c) && $c != INF && $c != -INF) return max(0, $c);
            }
            break;
        }
    }
    return tc_provider_cost($provider);
}

// 按模型 ID / 名称猜测是否为「生图模型」,用于后台默认勾选与请求自动路由的兜底判断。
// 只做保守匹配:宁可漏判(交给管理员手动勾选),也不要把普通对话/视觉模型误判成生图。
function tc_image_model_name_hint($id) {
    $s = strtolower(trim((string) $id));
    if ($s === '') return false;
    $patterns = array(
        '/dall-?e/',                 // dall-e-3 / dalle3
        '/gpt-image/',               // gpt-image-1
        '/\bimage-?gen(eration)?s?\b/', // image-generation / imagegen
        '/stable-?diffusion/',
        '/\bsdxl\b/', '/\bsd3\b/', '/\bsd-?3(\.5)?\b/', '/sd-?turbo/',
        '/\bflux\b/', '/flux-?\d/',  // flux / flux-1.1
        '/midjourney/', '/\bniji\b/',
        '/seedream/',                // 豆包 Seedream
        '/\bimagen\b/',              // Google Imagen
        '/\bkolors\b/',              // 快手可图
        '/cogview/',                 // 智谱 CogView
        '/qwen-?image/',             // 通义千问生图
        '/\bwanx\b/', '/wan-?\d/',
        '/hunyuan-?image/',
        '/grok-?\d*(-|_)?image/', '/grok-imagine/',
        '/-image\b/',                // 形如 xxx-image 的生图模型
        '/image-generation/',
        '/nano-?banana/',            // Gemini 系「纳米香蕉」生图
        '/\bimagine\b/',             // grok imagine 等
        '/-image-edit/', '/image-edit/', // 图像编辑类模型
        '/\bsora[_-]?image\b/',
        '/\bkling-image/',
        '/\bz-image/',
    );
    foreach ($patterns as $re) {
        if (preg_match($re, $s)) return true;
    }
    return false;
}

// 判断某供应商下的某个模型是否按生图模型处理:
// 优先用供应商配置里的显式 image 标记,未设置时退回名称猜测。
function tc_model_is_image($provider, $modelId) {
    $mid = (string) $modelId;
    if ($mid === '') return false;
    if (isset($provider['models']) && is_array($provider['models'])) {
        foreach ($provider['models'] as $m) {
            if (!is_array($m) || !isset($m['id']) || (string) $m['id'] !== $mid) continue;
            if (array_key_exists('image', $m)) return !empty($m['image']);
            return tc_image_model_name_hint($mid);
        }
    }
    return tc_image_model_name_hint($mid);
}

function tc_is_unlimited_quota($user) {
    return isset($user['quota']) && (string) $user['quota'] === '-1';
}

// —— 余量明细(用户可追溯每次增减) ——
// 写入 quotaLedger:与充值/兑换码共用一张表,用 source 区分:
//   usage=消耗 | package_redeem/package_claim/fixed_code=获得 | admin=管理员调整
// 明细只保留最近 N 条(按用户分片),避免库无限增长。
define('TC_QUOTA_LEDGER_PER_USER', 200);

function tc_quota_note(&$db, $userId, $entry) {
    $userId = (string) $userId;
    if ($userId === '') return;
    if (!isset($db['quotaLedger']) || !is_array($db['quotaLedger'])) $db['quotaLedger'] = array();
    $row = array_merge(array('id' => tc_uid(8), 'userId' => $userId, 'createdAt' => tc_now()), $entry);
    $db['quotaLedger'][] = $row;
    // 超过上限时,只裁该用户最旧的记录(其他人的不动)
    $mine = 0;
    foreach ($db['quotaLedger'] as $e) {
        if (isset($e['userId']) && (string) $e['userId'] === $userId) $mine++;
    }
    if ($mine > TC_QUOTA_LEDGER_PER_USER) {
        $drop = $mine - TC_QUOTA_LEDGER_PER_USER;
        $kept = array();
        foreach ($db['quotaLedger'] as $e) {
            if ($drop > 0 && isset($e['userId']) && (string) $e['userId'] === $userId) { $drop--; continue; }
            $kept[] = $e;
        }
        $db['quotaLedger'] = $kept;
    }
}

// 用途标签:让用户看懂「这笔扣费是因为什么」
function tc_quota_purpose_label($purpose, $model = '') {
    $p = strtolower(trim((string) $purpose));
    $map = array(
        'chat' => '对话',
        'image' => '生图',
        'video' => '生视频',
        'title' => '生成标题',
        'followup' => '生成跟进建议',
        'judge' => 'AI 工具判定',
        'search' => '联网检索',
        'parse' => '文档解析',
        'compare' => '多模型对比',
        'assistant' => '助手对话',
        'api' => 'API 调用',
    );
    if (isset($map[$p])) return $map[$p];
    // 未标注用途时按模型名兜底推断
    $m = strtolower((string) $model);
    if (strpos($m, '(图像)') !== false) return '生图';
    if (strpos($m, '(视频)') !== false) return '生视频';
    return $p !== '' ? $p : '对话';
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

function tc_charge_user(&$db, &$user, $cost, $model = '', $purpose = '') {
    $n = max(0, (float) $cost);
    $unlimited = tc_is_unlimited_quota($user);
    if (!$unlimited) tc_enforce_quota_expiry($db, $user);
    $before = isset($user['quota']) ? (float) $user['quota'] : 0;
    // 0 成本(自有 Key)与无限额度的调用不扣额度,但同样计入调用次数
    if ($n > 0 && !$unlimited) {
        // 按 token 计费会出现小数额度,4 位舍入避免浮点尘埃累积
        $user['quota'] = max(0, round($before - $n, 4));
        tc_consume_quota_grants($user, $n);
        // 余量明细:记录每次实际扣减(含用途与前后余量),供用户追溯
        tc_quota_note($db, (string) $user['id'], array(
            'amount' => -$n,
            'source' => 'usage',
            'purpose' => tc_quota_purpose_label($purpose, $model),
            'model' => (string) $model,
            'before' => round($before, 4),
            'after' => round((float) $user['quota'], 4),
        ));
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
    $settings = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
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
        // 分级阈值由后台「对话设置 → 模型可用性显示」配置(默认 ≥75% 良好,≥40% 一般,其余较差)
        $okMin = min(100, max(1, (int) (isset($settings['healthOkMin']) ? $settings['healthOkMin'] : 75) ?: 75)) / 100;
        $warnMin = min(99, max(0, (int) (isset($settings['healthWarnMin']) ? $settings['healthWarnMin'] : 40))) / 100;
        if ($warnMin >= $okMin) $warnMin = max(0, $okMin - 0.01);
        $state = 'bad';
        if ($rate >= $okMin) $state = 'ok';
        elseif ($rate >= $warnMin) $state = 'warn';
        $out[$model] = array(
            'state' => $state,
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
