<?php
/**
 * TinyChat PHP 入口。
 * Apache / Nginx 把未命中静态文件的请求都交给本文件。
 */
define('TC_ROOT', __DIR__);
require_once __DIR__ . '/lib/core.php';
require_once __DIR__ . '/lib/api.php';
require_once __DIR__ . '/lib/proxy.php';
require_once __DIR__ . '/lib/tasks.php';
require_once __DIR__ . '/lib/updater.php';

tc_send_cors();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD']);
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$path = parse_url($uri, PHP_URL_PATH);
if ($path === false || $path === null || $path === '') $path = '/';
if (strlen($path) > 1 && substr($path, -1) === '/') $path = substr($path, 0, -1);

// 子目录部署：去掉脚本所在前缀
$scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
if ($scriptDir && $scriptDir !== '/' && strpos($path, $scriptDir) === 0) {
    $path = substr($path, strlen($scriptDir)) ?: '/';
}

if ($path === '/favicon.ico') {
    http_response_code(204);
    exit;
}

try {
    tc_with_db(true, function (&$db) {
        $changed = tc_seed_admin($db);
        $changed = tc_seed_default_assistants($db) || $changed;
        // 演示管理员改动的设置在有效期后自动还原
        $changed = tc_demo_revert($db) || $changed;
        tc_uptime_sec();
        if (!$changed) tc_db_skip_write();
    });
} catch (Exception $e) {
    // 首次写库失败时仍允许继续，具体接口会再报错
}

if ($path === '/api' || strpos($path, '/api/') === 0 || $path === '/v1' || strpos($path, '/v1/') === 0) {
    try {
        tc_dispatch($method, $path);
    } catch (Exception $e) {
        if (!headers_sent()) tc_fail(500, '服务器内部错误: ' . $e->getMessage());
    }
    exit;
}

if ($method === 'GET' || $method === 'HEAD') {
    $pages = array(
        '/' => 'index.html',
        '/index.html' => 'index.html',
        '/chat' => 'index.html',
        '/login' => 'login.html',
        '/login.html' => 'login.html',
        '/admin' => 'admin.html',
        '/admin.html' => 'admin.html',
    );
    if (isset($pages[$path])) {
        tc_send_page($pages[$path]);
        exit;
    }
    if (preg_match('/^\/s\/[A-Za-z0-9]+$/', $path)) {
        tc_send_page('share.html');
        exit;
    }
    if ($path === '/agreement') {
        tc_api_agreement_page();
        exit;
    }
}

http_response_code(404);
header('Content-Type: application/json; charset=utf-8');
echo tc_json_encode(array('error' => array('message' => 'Not Found')));
exit;

function tc_send_page($file) {
    $full = TC_ROOT . '/' . $file;
    if (!is_file($full)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '页面不存在';
        return;
    }
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    // SEO 元信息里的 {{SITE_URL}} 占位符替换为站点绝对地址
    $html = file_get_contents($full);
    if (strpos($html, '{{SITE_URL}}') !== false) {
        $html = str_replace('{{SITE_URL}}', tc_public_base_url(), $html);
    }
    echo $html;
}

function tc_dispatch($method, $path) {
    $routes = array(
        array('GET', '#^/api/config$#', 'tc_api_public_config_wrap'),
        array('GET', '#^/api/env-check$#', 'tc_api_env_check'),
        array('POST', '#^/api/setup$#', 'tc_api_setup'),
        array('POST', '#^/api/auth/register$#', 'tc_api_register'),
        array('POST', '#^/api/auth/login$#', 'tc_api_login'),
        array('POST', '#^/api/auth/guest$#', 'tc_api_guest_login'),
        array('POST', '#^/api/auth/verify-email$#', 'tc_api_verify_email'),
        array('POST', '#^/api/auth/resend-verification$#', 'tc_api_resend_verification'),
        array('POST', '#^/api/auth/forgot-password$#', 'tc_api_forgot_password'),
        array('POST', '#^/api/auth/reset-password$#', 'tc_api_reset_password'),
        array('POST', '#^/api/auth/logout$#', 'tc_api_logout'),
        array('GET', '#^/api/auth/me$#', 'tc_api_me'),
        array('GET', '#^/api/me$#', 'tc_api_me'),
        array('POST', '#^/api/me/tools$#', 'tc_api_save_tools'),
        array('GET', '#^/api/me/apikeys$#', 'tc_api_me_apikeys_list'),
        array('POST', '#^/api/me/apikeys$#', 'tc_api_me_apikeys_create'),
        array('DELETE', '#^/api/me/apikeys/([^/]+)$#', 'tc_api_me_apikeys_delete'),
        array('GET', '#^/api/admin/invites$#', 'tc_api_admin_invites_list'),
        array('POST', '#^/api/admin/invites$#', 'tc_api_admin_invites_create'),
        array('DELETE', '#^/api/admin/invites/([^/]+)$#', 'tc_api_admin_invites_delete'),
        array('GET', '#^/api/admin/usage/export$#', 'tc_api_admin_usage_export'),
        array('POST', '#^/api/auth/password$#', 'tc_api_change_password'),
        array('GET', '#^/api/providers$#', 'tc_api_list_providers'),
        array('POST', '#^/api/providers$#', 'tc_api_create_provider'),
        array('GET', '#^/api/providers/global$#', 'tc_api_get_global_provider'),
        array('POST', '#^/api/providers/test$#', 'tc_api_user_test_model'),
        array('POST', '#^/api/providers/([^/]+)/key$#', 'tc_api_reveal_provider_key'),
        array('POST', '#^/api/providers/([^/]+)$#', 'tc_api_update_provider'),
        array('DELETE', '#^/api/providers/([^/]+)$#', 'tc_api_delete_provider'),
        array('GET', '#^/api/sync/chats$#', 'tc_api_sync_get_chats'),
        array('POST', '#^/api/sync/chats$#', 'tc_api_sync_save_chats'),
        array('DELETE', '#^/api/sync/chats$#', 'tc_api_sync_clear_chats'),
        array('POST', '#^/api/votes$#', 'tc_api_vote'),
        array('POST', '#^/api/shares$#', 'tc_api_create_share'),
        array('GET', '#^/api/shares/([^/]+)$#', 'tc_api_get_share'),
        array('GET', '#^/api/assistants$#', 'tc_api_list_assistants'),
        array('POST', '#^/api/assistants/categories$#', 'tc_api_create_assistant_category'),
        array('POST', '#^/api/assistants/categories/([^/]+)$#', 'tc_api_update_assistant_category'),
        array('DELETE', '#^/api/assistants/categories/([^/]+)$#', 'tc_api_delete_assistant_category'),
        array('POST', '#^/api/assistants$#', 'tc_api_create_assistant'),
        array('POST', '#^/api/assistants/([^/]+)/reset$#', 'tc_api_reset_assistant'),
        array('POST', '#^/api/assistants/([^/]+)$#', 'tc_api_update_assistant'),
        array('DELETE', '#^/api/assistants/([^/]+)$#', 'tc_api_delete_assistant'),
        array('GET', '#^/api/admin/stats$#', 'tc_api_admin_stats'),
        array('GET', '#^/api/admin/settings$#', 'tc_api_admin_get_settings'),
        array('POST', '#^/api/admin/settings$#', 'tc_api_admin_save_settings'),
        array('POST', '#^/api/admin/session/invalidate$#', 'tc_api_admin_invalidate_sessions'),
        array('GET', '#^/api/admin/thinking$#', 'tc_api_admin_get_thinking'),
        array('POST', '#^/api/admin/thinking$#', 'tc_api_admin_save_thinking'),
        array('GET', '#^/api/packages$#', 'tc_api_list_packages'),
        array('POST', '#^/api/packages/redeem$#', 'tc_api_redeem_package'),
        array('POST', '#^/api/packages/claim$#', 'tc_api_claim_package'),
        array('GET', '#^/api/admin/packages$#', 'tc_api_admin_list_packages'),
        array('POST', '#^/api/admin/packages$#', 'tc_api_admin_save_package'),
        array('DELETE', '#^/api/admin/packages/([^/]+)$#', 'tc_api_admin_delete_package'),
        array('POST', '#^/api/admin/packages/([^/]+)/codes$#', 'tc_api_admin_generate_codes'),
        array('GET', '#^/api/admin/packages/([^/]+)/codes/export$#', 'tc_api_admin_export_codes'),
        array('DELETE', '#^/api/admin/codes/([^/]+)$#', 'tc_api_admin_delete_code'),
        array('POST', '#^/api/admin/codes/prune$#', 'tc_api_admin_prune_codes'),
        array('POST', '#^/api/admin/codes/fixed$#', 'tc_api_admin_create_fixed_code'),
        array('POST', '#^/api/admin/settings/test-email$#', 'tc_api_admin_test_email'),
        array('GET', '#^/api/admin/settings/mail-template-defaults$#', 'tc_api_admin_mail_template_defaults'),
        array('GET', '#^/api/admin/update/check$#', 'tc_api_admin_update_check'),
        array('POST', '#^/api/admin/update/perform$#', 'tc_api_admin_update_perform'),
        array('POST', '#^/api/admin/search/test$#', 'tc_api_admin_test_search'),
        array('GET', '#^/api/admin/logs$#', 'tc_api_admin_logs'),
        array('DELETE', '#^/api/admin/logs$#', 'tc_api_admin_delete_logs'),
        array('GET', '#^/api/admin/backup$#', 'tc_api_admin_backup_list'),
        array('POST', '#^/api/admin/backup$#', 'tc_api_admin_backup_create'),
        array('GET', '#^/api/admin/backup/download$#', 'tc_api_admin_backup_download'),
        array('POST', '#^/api/admin/backup/restore$#', 'tc_api_admin_backup_restore'),
        array('GET', '#^/api/admin/users$#', 'tc_api_admin_users'),
        array('GET', '#^/api/admin/users/chats$#', 'tc_api_admin_user_chats'),
        array('POST', '#^/api/admin/users$#', 'tc_api_admin_create_user'),
        array('POST', '#^/api/admin/users/update$#', 'tc_api_admin_update_user'),
        array('POST', '#^/api/admin/users/quota$#', 'tc_api_admin_set_quota'),
        array('POST', '#^/api/admin/users/group$#', 'tc_api_admin_set_user_group'),
        array('DELETE', '#^/api/admin/users/([^/]+)$#', 'tc_api_admin_delete_user'),
        array('GET', '#^/api/admin/groups$#', 'tc_api_admin_groups'),
        array('POST', '#^/api/admin/groups$#', 'tc_api_admin_create_group'),
        array('POST', '#^/api/admin/groups/default$#', 'tc_api_admin_set_default_group'),
        array('POST', '#^/api/admin/groups/([^/]+)$#', 'tc_api_admin_update_group'),
        array('DELETE', '#^/api/admin/groups/([^/]+)$#', 'tc_api_admin_delete_group'),
        array('GET', '#^/api/admin/access$#', 'tc_api_admin_get_access'),
        array('POST', '#^/api/admin/access$#', 'tc_api_admin_set_access'),
        array('GET', '#^/api/admin/assistants$#', 'tc_api_admin_list_assistants'),
        array('POST', '#^/api/admin/assistants/categories$#', 'tc_api_admin_create_assistant_category'),
        array('POST', '#^/api/admin/assistants/categories/([^/]+)$#', 'tc_api_admin_update_assistant_category'),
        array('DELETE', '#^/api/admin/assistants/categories/([^/]+)$#', 'tc_api_admin_delete_assistant_category'),
        array('POST', '#^/api/admin/assistants$#', 'tc_api_admin_create_assistant'),
        array('POST', '#^/api/admin/assistants/([^/]+)$#', 'tc_api_admin_update_assistant'),
        array('DELETE', '#^/api/admin/assistants/([^/]+)$#', 'tc_api_admin_delete_assistant'),
        array('POST', '#^/api/admin/providers/test$#', 'tc_api_admin_test_model'),
        array('POST', '#^/api/admin/providers/([^/]+)$#', 'tc_api_admin_update_provider'),
        array('DELETE', '#^/api/admin/providers/([^/]+)$#', 'tc_api_admin_delete_provider'),
        array('POST', '#^/api/documents/parse$#', 'tc_api_parse_document'),
        array('GET', '#^/api/proxy/tasks/([^/]+)$#', 'tc_api_proxy_task'),
        array('GET', '#^/api/proxy/tasks/([^/]+)/events$#', 'tc_api_proxy_task_events'),
        array('POST', '#^/api/proxy/tasks/([^/]+)/cancel$#', 'tc_api_proxy_task_cancel'),
        array('POST', '#^/api/proxy/chat$#', 'tc_api_proxy_chat'),
        array('POST', '#^/api/proxy/completions$#', 'tc_api_proxy_completions'),
        array('POST', '#^/api/proxy/responses$#', 'tc_api_proxy_responses'),
        array('POST', '#^/api/proxy/anthropic$#', 'tc_api_proxy_anthropic'),
        array('GET', '#^/api/proxy/models$#', 'tc_api_list_models'),
        array('POST', '#^/api/proxy/fetch-models$#', 'tc_api_fetch_models'),
        array('POST', '#^/api/proxy/images$#', 'tc_api_proxy_images'),
        array('POST', '#^/v1/chat/completions$#', 'tc_api_v1_chat_completions'),
        array('GET', '#^/v1/models$#', 'tc_api_v1_models'),
        array('POST', '#^/v1/images/generations$#', 'tc_api_v1_images_generations'),
    );
    foreach ($routes as $r) {
        if ($r[0] !== $method) continue;
        if (!preg_match($r[1], $path, $m)) continue;
        $params = array_slice($m, 1);
        foreach ($params as &$p) $p = rawurldecode($p);
        unset($p);
        call_user_func_array($r[2], $params);
        return;
    }
    tc_fail(404, '接口不存在: ' . $method . ' ' . $path);
}

function tc_api_public_config_wrap() {
    // 数据库不可读写(常见于 data/ 目录权限不足)时也要返回可用的最小配置,
    // 让登录页能进入环境自检而不是停在无法注册的注册页。
    try {
        tc_with_db(false, function ($db) { tc_api_public_config($db); });
    } catch (Throwable $e) {
        tc_fail_public_config($e->getMessage());
    }
}

function tc_fail_public_config($reason) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo tc_json_encode(array(
        'siteName' => 'TinyChat',
        'allowRegister' => false,
        'freeQuota' => 0,
        'version' => TC_VERSION,
        'hasProvider' => false,
        'needsSetup' => true,
        'dbError' => (string) $reason,
        'emailVerificationEnabled' => false,
        'passwordResetEnabled' => false,
        'mailReady' => false,
        'webSearch' => array('enabled' => false),
        'mineru' => array('token' => '', 'enabled' => false),
        'announcement' => array('enabled' => false, 'text' => '', 'updatedAt' => 0),
        'registerInviteRequired' => false,
        'demoMode' => false,
        'demoExpireMinutes' => 10,
        'guestEnabled' => false,
        'guestRounds' => 3,
    ));
    exit;
}

function tc_api_proxy_task($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        $out = $task; unset($out['events']); tc_json(200, $out);
    });
}
function tc_api_proxy_task_events($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        $after = max(0, (int) ($_GET['after'] ?? 0)); $events = array_values(array_filter((array) ($task['events'] ?? array()), function ($e) use ($after) { return (int) ($e['seq'] ?? 0) > $after; }));
        tc_json(200, array('status' => $task['status'], 'seq' => (int) ($task['seq'] ?? 0), 'events' => $events, 'error' => $task['error'] ?? ''));
    });
}
function tc_api_proxy_task_cancel($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        tc_task_finish($id, 'cancelled', '用户取消'); tc_json(200, array('ok' => true));
    });
}
function tc_api_proxy_chat() { tc_api_proxy('chat'); }
function tc_api_proxy_completions() { tc_api_proxy('completions'); }
function tc_api_proxy_responses() { tc_api_proxy('responses'); }
function tc_api_proxy_anthropic() { tc_api_proxy('anthropic'); }
