<?php
/**
 * 本地预览：php -S 127.0.0.1:8080 router.php
 * 虚拟主机不需要这个文件。
 *
 * 安全说明:PHP 内置服务器对 `return false` 的请求会直接吐出磁盘原文件。
 * data/ 下有数据库、密钥等敏感内容,绝不能按静态文件输出;
 * 这里只放行确属公开静态资源的路径,其余全部交给 index.php 处理。
 */
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$path = realpath(__DIR__ . $uri);
$root = realpath(__DIR__);
$public = ($path !== false && $root !== false && stripos($path, $root . DIRECTORY_SEPARATOR) === 0)
    ? str_replace('\\', '/', ltrim(substr($path, strlen($root)), '/\\')) : '';

// 静态白名单:static/ 与 vendor/ 下的资源文件,以及根级的安全扩展名文件
// (admin.html / login.html / share.html / logo.svg 等)。
// data/、lib/、config*.php 以及其它一切路径一律交由 index.php 的鉴权路由处理。
if ($public !== '' && is_file($path)) {
    $isRootFile = strpos($public, '/') === false;
    $ok = $isRootFile
        ? (bool) preg_match('#\.(html|svg|png|ico|txt|css|js|webmanifest|woff2?)$#i', $public)
        : (bool) preg_match('#^(static|vendor)/#i', $public);
    if ($ok) return false;
}

require __DIR__ . '/index.php';
