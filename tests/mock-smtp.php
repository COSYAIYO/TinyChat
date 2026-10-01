<?php
/**
 * 测试用模拟 SMTP 服务器。php -S 不支持原始 socket,这里用 stream_socket_server 起独立进程。
 * 用法:php tests/mock-smtp.php <port> [mode]
 *   ok           正常投递(默认)
 *   authfail     认证直接失败(535)
 *   gbk          用 GBK 回错误文本(复现中文服务商:非法 UTF-8 曾让 json_encode 失败)
 *   gmail535     复现 Gmail 对错误凭据的多行 535 响应
 *   requirepass  仅当密码(去空格后)是 16 位小写字母时通过 —— 用于验证空格被正确剥离
 *   reset        连接后立刻断开(模拟端口不通/防火墙)
 *   stall        连接后不回复,用于验证发送中途超时能把原因带回调用方
 *   capture      正常投递,并把收到的 DATA 原文写到第 3 个参数指定的文件
 */
$port = (int) ($argv[1] ?? 2525);
$mode = (string) ($argv[2] ?? 'ok');
$captureFile = (string) ($argv[3] ?? '');

$server = @stream_socket_server('tcp://127.0.0.1:' . $port, $errno, $errstr);
if (!$server) {
    fwrite(STDERR, "无法监听 $port: $errstr\n");
    exit(1);
}
echo "mock-smtp listening on $port (mode=$mode)\n";
flush();

    $handle = function ($conn) use ($mode, $captureFile) {
    if ($mode === 'reset') { fclose($conn); return; }
    fwrite($conn, "220 mock.local ESMTP ready\r\n");
    if ($mode === 'stall') { sleep(30); return; }
    $inData = false;
    $captured = '';
    while (($line = fgets($conn, 8192)) !== false) {
        $cmd = strtoupper(trim($line));
        if ($inData) {
            if ($mode === 'capture') $captured .= $line;
            if ($cmd === '.') {
                $inData = false;
                if ($mode === 'capture' && $captureFile !== '') {
                    file_put_contents($captureFile, $captured);
                }
                fwrite($conn, "250 OK queued\r\n");
                continue;
            }
            continue;
        }
        if (strpos($cmd, 'EHLO') === 0 || strpos($cmd, 'HELO') === 0) {
            fwrite($conn, "250-mock.local\r\n250-AUTH LOGIN PLAIN\r\n250-STARTTLS\r\n250 SIZE 10485760\r\n");
        } elseif (strpos($cmd, 'STARTTLS') === 0) {
            // 不真做 TLS 握手:测试只覆盖非 TLS 路径,收到即断开以触发 STARTTLS 失败分支
            fwrite($conn, "220 Ready to start TLS\r\n");
            return;
        } elseif (strpos($cmd, 'AUTH LOGIN') === 0) {
            if ($mode === 'authfail') { fwrite($conn, "535 Authentication failed\r\n"); return; }
            if ($mode === 'gmail535') {
                fwrite($conn, "535-5.7.8 Username and Password not accepted. For more information, go to\r\n");
                fwrite($conn, "535 5.7.8 https://support.google.com/mail/?p=BadCredentials 5a478bee46e8 - gsmtp\r\n");
                return;
            }
            if ($mode === 'gbk') {
                $gbk = "\xd3\xc3\xbb\xa7\xc3\xfb\xbb\xf2\xc3\xdc\xc2\xeb\xb2\xbb\xd5\xfd\xc8\xb7"; // GBK:"用户名或密码不正确"
                fwrite($conn, "535 " . $gbk . "\r\n");
                return;
            }
            // 下面几个模式都要走完整的 AUTH LOGIN 两步(334 用户名 → 334 密码)
            fwrite($conn, "334 VXNlcm5hbWU6\r\n");
            fgets($conn, 2048); // username(base64)
            fwrite($conn, "334 UGFzc3dvcmQ6\r\n");
            $pw = base64_decode(trim((string) fgets($conn, 2048)), true);
            if ($mode === 'requirepass') {
                if ($pw === false || !preg_match('/^[a-z]{16}$/', (string) $pw)) {
                    fwrite($conn, "535 5.7.8 Username and Password not accepted.\r\n");
                    return;
                }
                fwrite($conn, "235 2.7.0 Accepted\r\n");
                continue; // 继续走完 MAIL/RCPT/DATA
            }
            fwrite($conn, "235 Authentication successful\r\n");
        } elseif (strpos($cmd, 'MAIL FROM') === 0) {
            fwrite($conn, "250 OK\r\n");
        } elseif (strpos($cmd, 'RCPT TO') === 0) {
            fwrite($conn, "250 OK\r\n");
        } elseif (strpos($cmd, 'DATA') === 0) {
            fwrite($conn, "354 End data with <CR><LF>.<CR><LF>\r\n");
            $inData = true;
        } elseif (strpos($cmd, 'QUIT') === 0) {
            fwrite($conn, "221 Bye\r\n");
            return;
        } else {
            fwrite($conn, "250 OK\r\n");
        }
    }
};

while (true) {
    $conn = @stream_socket_accept($server, -1);
    if (!$conn) continue;
    $handle($conn);
    @fclose($conn);
}
