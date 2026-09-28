<?php
/**
 * TinyChat 署名完整性检查。
 *
 * 目的:项目的作者署名 / 仓库链接是原创者的劳动成果标识。若部署方把它替换成
 * 其它仓库地址或直接删掉,这里会判定为「署名被篡改」,由入口暂停程序并给出提示,
 * 提醒部署者尊重他人成果。
 *
 * 说明:
 *  - 本检查只针对「署名链接」这一处,不校验其它任何文件,避免误伤正常二次开发;
 *  - 期望值以 SHA-256 摘要保存(不是明文),目的是让随手 grep 替换不容易绕过——
 *    这是「混淆」而非「加密」,PHP 源码在部署方手里,不存在真正的秘密;
 *  - 出错一律「放行」(失败不影响站点),宁可漏判也不能因为本模块自身问题把站点弄挂;
 *  - 合法的二次开发 / 换名部署,可在 config.php 里显式声明 'allow_rebrand' => true,
 *    这是对署名条款的明确接受,而不是静默抹除。
 */
if (!defined('TC_ROOT')) {
    define('TC_ROOT', dirname(__DIR__));
}

// 认可的署名仓库(小写 owner/repo),以 SHA-256 摘要形式保存,避免明文被直接检索替换
// 当前包含:上游主仓库、维护者 fork。
function tc_attribution_accepted_hashes() {
    return array(
        'eb09bd856ed75b09d7a987540627fd14e7def6954efd326b47d4368073a2b257', // 上游主仓库
        'a39db956a435bacd3d7058f0fcdeb68a9e73858add7439e0428d8719483607c1', // 维护者 fork
    );
}

// 把关联的 GitHub 地址归一化成 "owner/repo"(小写、去协议/域名/后缀);无法识别返回 ''
function tc_attribution_normalize($url) {
    $u = trim((string) $url);
    if ($u === '') return '';
    if (!preg_match('~github\.com[/:]([^/]+)/([^/?#]+)~i', $u, $m)) return '';
    $owner = strtolower($m[1]);
    $repo = strtolower(preg_replace('/\.git$/i', '', $m[2]));
    if ($owner === '' || $repo === '') return '';
    return $owner . '/' . $repo;
}

// 从 index.html 中取出署名链接的 href;取不到返回 null(文件不存在时返回 null)
function tc_attribution_link_href() {
    $file = TC_ROOT . '/index.html';
    if (!is_file($file)) return null;
    $html = (string) @file_get_contents($file);
    if ($html === '') return null;
    // 优先取带 id 的署名菜单项;退化时取任意 github.com 链接
    if (preg_match('#<a[^>]*id="user-menu-github"[^>]*href="([^"]*)"#i', $html, $m)) return $m[1];
    if (preg_match('#<a[^>]*href="([^"]*)"[^>]*id="user-menu-github"#i', $html, $m)) return $m[1];
    if (preg_match('#href="(https?://github\.com/[^"]+)"#i', $html, $m)) return $m[1];
    return '';
}

/**
 * 返回违规原因(空字符串表示正常)。
 * 仅在「明确检测到署名被替换 / 删除」时返回原因;文件缺失等部署异常一律放行。
 */
function tc_attribution_violation($config = null) {
    try {
        if ($config === null) $config = tc_cfg();
        // 合法二次开发:显式声明接受署名条款
        if (!empty($config['allow_rebrand'])) return '';
        $href = tc_attribution_link_href();
        if ($href === null) return '';           // 文件缺失 -> 部署异常,放行
        if ($href === '') return '署名链接被移除';  // 文件在但链接没了 -> 违规

        $norm = tc_attribution_normalize($href);
        if ($norm === '') return '署名链接被改为非 GitHub 地址';
        $hash = hash('sha256', $norm);
        if (in_array($hash, tc_attribution_accepted_hashes(), true)) return '';
        // 允许 config.php 里的 github_repo 作为合法来源(便于镜像/私有分发)
        $cfgRepo = isset($config['github_repo']) ? tc_attribution_normalize('github.com/' . trim((string) $config['github_repo'])) : '';
        if ($cfgRepo !== '' && $norm === $cfgRepo) return '';
        return '署名仓库被改为 ' . $norm;
    } catch (Throwable $e) {
        return ''; // 自身异常不得影响站点
    }
}

// 违规提示页:说明原因、给出恢复方式,并提醒尊重原作者成果
function tc_attribution_notice_html($reason) {
    $site = function_exists('tc_cfg') ? (string) tc_cfg('site_name') : '';
    $reasonHtml = htmlspecialchars((string) $reason, ENT_QUOTES, 'UTF-8');
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>程序已暂停 · 署名完整性校验未通过</title>'
        . '<style>body{margin:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#0f172a}'
        . '.wrap{max-width:640px;margin:0 auto;padding:56px 20px}'
        . '.card{background:#fff;border-radius:16px;padding:30px 28px;box-shadow:0 1px 3px rgba(15,23,42,.08)}'
        . 'h1{margin:0 0 14px;font-size:20px}p{line-height:1.9;font-size:14px;color:#334155;margin:0 0 12px}'
        . 'code{background:#f1f5f9;padding:2px 6px;border-radius:5px;font-size:13px}'
        . '.reason{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:10px;padding:10px 14px;font-size:13.5px;margin:0 0 14px}'
        . '.muted{color:#64748b;font-size:12.5px}</style></head><body><div class="wrap"><div class="card">'
        . '<h1>程序已暂停运行</h1>'
        . '<div class="reason">检测到原因：' . $reasonHtml . '</div>'
        . '<p>TinyChat 是开源项目，作者允许自由使用、修改与二次分发（MIT 许可），'
        . '但<b>请保留项目的作者署名与仓库链接</b>——那是对他人劳动成果的基本尊重。</p>'
        . '<p>若你在改动主题/品牌时误删了署名链接，把 <code>index.html</code> 里用户菜单中的'
        . ' <code>id="user-menu-github"</code> 链接恢复为原仓库地址即可继续运行。</p>'
        . '<p>确实需要换名部署（如内部定制、镜像站点），请在 <code>config.php</code> 中显式声明'
        . ' <code>\'allow_rebrand\' => true</code>，表示你已知晓并接受署名条款；'
        . '这比静默抹掉出处更妥当。</p>'
        . '<p class="muted">' . ($site !== '' ? htmlspecialchars($site, ENT_QUOTES, 'UTF-8') : '') . '</p>'
        . '</div></div></body></html>';
}
