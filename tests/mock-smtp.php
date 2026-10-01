<?php
/**
 * 测试用模拟 SMTP 服务器:php -S 不支持原始 socket,这里用 stream_socket_server 起独立进程。
 * 用法:php tests/mock-smtp.php <port> [mode]
 *   mode=ok       正常投递(默认)
 *   mode=authfail 认证失败(535)
 *   mode=reset    连接后立刻断开(模拟端口不通/防火墙)
 * 每轮交互写入 stdout,便于断言。
 */
$port = (int) ($argv[1] ?? 2525);
$mode = (string) ($argv[2] ?? 'ok');

$server = @stream_socket_server('tcp://127.0.0.1:' . $port, $errno, $errstr);
if (!$server) {
    fwrite(STDERR, "无法监听 $port: $errstr\n");
    exit(1);
}
echo "mock-smtp listening on $port (mode=$mode)\n";
flush();

$handle = function ($conn) use ($mode) {
    if ($mode === 'reset') { fclose($conn); return; }
    fwrite($conn, "220 mock.local ESMTP ready\r\n");
    $inData = false;
    while (($line = fgets($conn, 2048)) !== false) {
        $cmd = strtoupper(trim($line));
        if ($inData) {
            if ($cmd === '.') {
                $inData = false;
                fwrite($conn, "250 OK queued\r\n");
                continue;
            }
            continue;
        }
        if (strpos($cmd, 'EHLO') === 0 || strpos($cmd, 'HELO') === 0) {
            fwrite($conn, "250-mock.local\r\n250-AUTH LOGIN PLAIN\r\n250-STARTTLS\r\n250 SIZE 10485760\r\n");
        } elseif (strpos($cmd, 'STARTTLS') === 0) {
            fwrite($conn, "220 Ready to start TLS\r\n");
            // 不真做 TLS 握手:测试只关心「非 TLS 路径」,若客户端发 STARTTLS 我们直接降级
            return;
        } elseif (strpos($cmd, 'AUTH LOGIN') === 0) {
            if ($mode === 'authfail') { fwrite($conn, "535 Authentication failed\r\n"); return; }
            fwrite($conn, "334 VXNlcm5hbWU6\r\n");
            fgets($conn, 2048); // username
            fwrite($conn, "334 UGFzc3dvcmQ6\r\n");
            fgets($conn, 2048); // password
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
