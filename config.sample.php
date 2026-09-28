<?php
/**
 * 复制本文件为 config.php 后按需修改。
 * 环境变量优先于本文件；未设置时使用这里的值。
 */
return array(
    // 首次访问时若还没有管理员，会用这对账号创建一个
    'admin_name' => 'admin',
    'admin_password' => '请改成你的密码',

    // 留空则自动写到 data/secret
    'jwt_secret' => '',

    // 一般保持 *。若要收紧跨域，改成具体站点
    'cors_origin' => '*',

    // 留空 = 站点根目录下的 data/
    'data_dir' => '',

    // 在线更新（后台「平台配置 → 版本更新」）。Release tag 建议用 vX.Y.Z 形式
    'github_repo' => 'HCARX/TinyChat',
    // 私有仓库必填；公开仓库留空即可（留空时检查走免 API 方式，不受匿名限流）
    'github_token' => '',
    // 国内主机可换镜像。下载根可填 ghproxy 类加速前缀，
    // 例如 'https://ghproxy.net/https://github.com'
    'github_api_base' => 'https://api.github.com',
    'github_base' => 'https://github.com',
);
