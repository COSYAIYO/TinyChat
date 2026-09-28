<?php
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/api.php';

function tc_endpoints() {
    return array(
        'chat' => '/chat/completions',
        'completions' => '/completions',
        'responses' => '/responses',
        'anthropic' => '/messages',
    );
}

function tc_upstream_path($baseUrl, $format) {
    $ends = tc_endpoints();
    $endpoint = isset($ends[$format]) ? $ends[$format] : $ends['chat'];
    return tc_api_url($baseUrl, $endpoint);
}

// 拼一个上游接口地址:baseUrl 已带版本段(如 /v1)就直接拼,否则补上 /v1。
// 生图、获取模型等路径都必须走这里,否则用户按平台文档填「不带 /v1 的 Base URL」时会拼错路径(404)。
function tc_api_url($baseUrl, $path) {
    $base = rtrim(trim((string) $baseUrl), '/');
    if ($base === '') return (string) $path;
    $p = '/' . ltrim((string) $path, '/');
    // 已含版本段(/v1、/v1beta、/v2…):直接拼接
    if (preg_match('#/v\d+[a-z]*$#i', $base)) return $base . $p;
    // 若 base 尾部已包含要拼的路径段(如用户填了 .../v1/images/generations),不再重复
    if (preg_match('#/images/generations$#i', $base) && stripos($p, 'images/generations') !== false) return $base;
    if (preg_match('#/models$#i', $base) && stripos($p, 'models') !== false) return $base;
    if (preg_match('#/chat/completions$#i', $base) && stripos($p, 'chat/completions') !== false) return $base;
    return $base . '/v1' . $p;
}

define('TC_MINERU_LITE', 'https://mineru.net/api/v1/agent');
define('TC_MINERU_PRECISE', 'https://mineru.net/api/v4');

function tc_mineru_ext($name) {
    $base = strtolower(pathinfo((string) $name, PATHINFO_EXTENSION));
    return preg_replace('/[^a-z0-9]/', '', $base);
}

function tc_mineru_parseable($name) {
    return in_array(tc_mineru_ext($name), array('pdf', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html', 'htm'), true);
}

function tc_mineru_safe_name($name) {
    $base = basename(str_replace(chr(92), '/', (string) $name));
    $base = preg_replace('/[^\p{L}\p{N}._\- ()]+/u', '_', $base);
    $base = trim((string) $base, " ._");
    if ($base === '' || $base === '.' || $base === '..') $base = 'document.pdf';
    if (function_exists('mb_substr')) $base = mb_substr($base, 0, 120, 'UTF-8');
    else $base = substr($base, 0, 120);
    return $base;
}

function tc_mineru_json($url, $method, $headers, $body, $timeoutMs) {
    $res = tc_http_request($url, $method, $headers, $body, $timeoutMs);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    $json = json_decode(isset($res['body']) ? $res['body'] : '', true);
    if (!is_array($json)) {
        if ($status === 429) return array('ok' => false, 'error' => 'MinerU 请求过于频繁，请稍后再试', 'code' => 429);
        return array('ok' => false, 'error' => 'MinerU 返回无法解析 (HTTP ' . $status . ')', 'code' => 502);
    }
    $code = isset($json['code']) ? (int) $json['code'] : 0;
    if ($status === 429 || $code === 429) return array('ok' => false, 'error' => 'MinerU 请求过于频繁，请稍后再试', 'code' => 429);
    if ($status >= 400 || $code !== 0) {
        $msg = isset($json['msg']) ? (string) $json['msg'] : '';
        if ($msg === '' && isset($json['message'])) $msg = (string) $json['message'];
        if ($msg === '') $msg = 'MinerU 请求失败 (HTTP ' . $status . ')';
        return array('ok' => false, 'error' => $msg, 'code' => $status >= 400 ? $status : 502);
    }
    return array('ok' => true, 'data' => isset($json['data']) && is_array($json['data']) ? $json['data'] : array());
}

function tc_mineru_put_file($url, $bytes, $timeoutMs) {
    $res = tc_http_request($url, 'PUT', array(), $bytes, $timeoutMs, false, null, false);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    if ($status < 200 || $status >= 300) return array('ok' => false, 'error' => '文件上传到 MinerU 失败 (HTTP ' . $status . ')', 'code' => 502);
    return array('ok' => true);
}

function tc_mineru_state_of($data, $batch) {
    if (!$batch) return isset($data['state']) ? (string) $data['state'] : '';
    $rows = isset($data['extract_result']) && is_array($data['extract_result']) ? $data['extract_result'] : array();
    $row = isset($rows[0]) && is_array($rows[0]) ? $rows[0] : array();
    return isset($row['state']) ? (string) $row['state'] : '';
}

function tc_mineru_poll($url, $headers, $deadline, $batch) {
    $sleep = 1;
    while (time() < $deadline) {
        $res = tc_mineru_json($url, 'GET', $headers, null, 20000);
        if (empty($res['ok'])) return $res;
        $data = $res['data'];
        $state = tc_mineru_state_of($data, $batch);
        if ($state === 'done') {
            if ($batch) {
                $rows = $data['extract_result'];
                $zip = isset($rows[0]['full_zip_url']) ? (string) $rows[0]['full_zip_url'] : '';
                if ($zip === '') return array('ok' => false, 'error' => 'MinerU 已完成但没有返回结果包', 'code' => 502);
                return array('ok' => true, 'url' => $zip, 'zip' => true);
            }
            $md = isset($data['markdown_url']) ? (string) $data['markdown_url'] : '';
            if ($md === '') return array('ok' => false, 'error' => 'MinerU 已完成但没有返回 Markdown', 'code' => 502);
            return array('ok' => true, 'url' => $md, 'zip' => false);
        }
        if ($state === 'failed') {
            $msg = '';
            if ($batch && isset($data['extract_result'][0]['err_msg'])) $msg = (string) $data['extract_result'][0]['err_msg'];
            if ($msg === '' && isset($data['err_msg'])) $msg = (string) $data['err_msg'];
            if ($msg === '') $msg = '文档解析失败';
            return array('ok' => false, 'error' => $msg, 'code' => 422);
        }
        sleep($sleep);
        if ($sleep < 3) $sleep++;
    }
    return array('ok' => false, 'error' => '文档解析超时，请稍后重试或缩小文件', 'code' => 504);
}

function tc_zip_slice($b, $o, $n) { return substr($b, $o, $n); }
function tc_zip_u16($b, $o) { $v = unpack("v", tc_zip_slice($b, $o, 2)); return $v ? (int) $v[1] : 0; }
function tc_zip_u32($b, $o) { $v = unpack("V", tc_zip_slice($b, $o, 4)); return $v ? (int) $v[1] : 0; }

function tc_zip_read_stored($b, $offset, $nameLen, $extraLen, $size) {
    $start = $offset + 30 + $nameLen + $extraLen;
    return substr($b, $start, $size);
}

function tc_zip_inflate($bytes) {
    $out = @gzinflate($bytes);
    if ($out !== false) return $out;
    return @gzuncompress($bytes);
}

function tc_zip_find_markdown($b) {
    $len = strlen($b);
    $pos = 0;
    $best = '';
    $full = '';
    while ($pos + 30 <= $len) {
        if (substr($b, $pos, 4) !== "PK") break;
        $method = tc_zip_u16($b, $pos + 8);
        $comp = tc_zip_u32($b, $pos + 20);
        $nameLen = tc_zip_u16($b, $pos + 28);
        $extraLen = tc_zip_u16($b, $pos + 30);
        if ($nameLen < 0 || $extraLen < 0 || $comp < 0) break;
        $nameAt = $pos + 32;
        if ($nameAt + $nameLen + $extraLen + $comp > $len) break;
        $name = substr($b, $nameAt, $nameLen);
        $data = substr($b, $nameAt + $nameLen + $extraLen, $comp);
        $pos = $nameAt + $nameLen + $extraLen + $comp;
        if (!preg_match('/\.md$/i', $name)) continue;
        if ($method === 0) $text = $data;
        elseif ($method === 8) $text = tc_zip_inflate($data);
        else continue;
        if (!is_string($text) || trim($text) === '') continue;
        if (preg_match('#(^|/)full\.md$#i', $name)) { $full = $text; break; }
        if ($best === '' || strlen($text) > strlen($best)) $best = $text;
    }
    $text = $full !== '' ? $full : $best;
    if (trim($text) === '') return array('ok' => false, 'error' => '结果包里没有 Markdown', 'code' => 502);
    return array('ok' => true, 'markdown' => $text);
}

function tc_mineru_fetch_text($url) {
    if (!preg_match('#^https://#i', (string) $url)) return array('ok' => false, 'error' => '解析结果地址无效', 'code' => 502);
    $res = tc_http_request($url, 'GET', array('Accept' => '*/*'), null, 30000);
    if (empty($res['ok'])) return $res;
    $status = isset($res['status']) ? (int) $res['status'] : 0;
    if ($status < 200 || $status >= 300) return array('ok' => false, 'error' => '下载解析结果失败 (HTTP ' . $status . ')', 'code' => 502);
    $body = isset($res['body']) ? (string) $res['body'] : '';
    if (strncmp($body, "PK\x03\x04", 4) === 0) return tc_zip_find_markdown($body);
    if (trim($body) === '') return array('ok' => false, 'error' => '解析结果是空的', 'code' => 502);
    return array('ok' => true, 'markdown' => $body);
}

function tc_mineru_clip($markdown) {
    $markdown = str_replace(chr(0), '', (string) $markdown);
    if (strlen($markdown) > 80000) {
        $markdown = substr($markdown, 0, 80000) . chr(10) . chr(10) . '[文档过长，已截断]';
    }
    return $markdown;
}

function tc_mineru_parse_lite($name, $bytes, $deadline) {
    $signed = tc_mineru_json(TC_MINERU_LITE . '/parse/file', 'POST', array('Content-Type' => 'application/json', 'Accept' => 'application/json'), tc_json_encode(array(
        'file_name' => $name,
        'language' => 'ch',
        'enable_table' => true,
        'is_ocr' => false,
        'enable_formula' => true,
    )), 20000);
    if (empty($signed['ok'])) return $signed;
    $data = $signed['data'];
    $taskId = isset($data['task_id']) ? (string) $data['task_id'] : '';
    $fileUrl = isset($data['file_url']) ? (string) $data['file_url'] : '';
    if ($taskId === '' || $fileUrl === '') return array('ok' => false, 'error' => '轻量解析没有返回上传地址', 'code' => 502);
    $put = tc_mineru_put_file($fileUrl, $bytes, 40000);
    if (empty($put['ok'])) return $put;
    $polled = tc_mineru_poll(TC_MINERU_LITE . '/parse/' . rawurlencode($taskId), array('Accept' => 'application/json'), $deadline, false);
    if (empty($polled['ok'])) return $polled;
    $text = tc_mineru_fetch_text($polled['url']);
    if (empty($text['ok'])) return $text;
    return array('ok' => true, 'markdown' => tc_mineru_clip($text['markdown']), 'mode' => 'lite', 'name' => $name);
}

function tc_mineru_parse_precise($name, $bytes, $token, $deadline) {
    $ext = tc_mineru_ext($name);
    $headers = array(
        'Content-Type' => 'application/json',
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $token,
    );
    $model = ($ext === 'html' || $ext === 'htm') ? 'MinerU-HTML' : 'vlm';
    $signed = tc_mineru_json(TC_MINERU_PRECISE . '/file-urls/batch', 'POST', $headers, tc_json_encode(array(
        'files' => array(array('name' => $name, 'data_id' => 'f1')),
        'model_version' => $model,
        'language' => 'ch',
        'enable_table' => true,
        'enable_formula' => true,
        'is_ocr' => false,
    )), 20000);
    if (empty($signed['ok'])) return $signed;
    $data = $signed['data'];
    $batchId = isset($data['batch_id']) ? (string) $data['batch_id'] : '';
    $fileUrl = (isset($data['file_urls']) && is_array($data['file_urls']) && isset($data['file_urls'][0])) ? (string) $data['file_urls'][0] : '';
    if ($batchId === '' || $fileUrl === '') return array('ok' => false, 'error' => '精准解析没有返回上传地址，请检查 Token', 'code' => 502);
    $put = tc_mineru_put_file($fileUrl, $bytes, 60000);
    if (empty($put['ok'])) return $put;
    $polled = tc_mineru_poll(TC_MINERU_PRECISE . '/extract-results/batch/' . rawurlencode($batchId), array(
        'Accept' => 'application/json',
        'Authorization' => 'Bearer ' . $token,
    ), $deadline, true);
    if (empty($polled['ok'])) return $polled;
    $text = tc_mineru_fetch_text($polled['url']);
    if (empty($text['ok'])) return $text;
    return array('ok' => true, 'markdown' => tc_mineru_clip($text['markdown']), 'mode' => 'precise', 'name' => $name);
}

function tc_mineru_parse($name, $bytes, $token, $budgetSec) {
    $name = tc_mineru_safe_name($name);
    if (!tc_mineru_parseable($name)) return array('ok' => false, 'error' => 'MinerU 不支持这个格式', 'code' => 400);
    $size = strlen($bytes);
    if ($size <= 0) return array('ok' => false, 'error' => '文件是空的', 'code' => 400);
    $precise = trim((string) $token) !== '';
    $limit = $precise ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
    if ($size > $limit) {
        return array('ok' => false, 'error' => '文件超过 ' . ($precise ? '200MB' : '10MB') . '，' . ($precise ? '请拆分后再试' : '轻量解析上限 10MB、20 页'), 'code' => 400);
    }
    $deadline = time() + max(20, (int) $budgetSec);
    if ($precise) return tc_mineru_parse_precise($name, $bytes, trim((string) $token), $deadline);
    return tc_mineru_parse_lite($name, $bytes, $deadline);
}

function tc_prepare_upstream_body($b, $provider, $format) {
    $out = array();
    foreach ($b as $k => $v) {
        if ($k === 'providerId' || $k === 'anthropicVersion' || $k === 'webSearch' || strncmp((string) $k, '_', 1) === 0) continue;
        $out[$k] = $v;
    }
    $model = isset($out['model']) ? $out['model'] : (isset($provider['models'][0]['id']) ? $provider['models'][0]['id'] : null);
    if ($model) $out['model'] = $model;
    if ($format === 'anthropic' && empty($out['max_tokens'])) $out['max_tokens'] = 8192;
    return $out;
}

function tc_unsupported_param_names($raw) {
    $text = strtolower((string) $raw);
    if ($text === '') return array();
    $known = array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'temperature');
    $found = array();
    if (preg_match_all('/[`\'"]([a-z0-9_.]+)[`\'"]/i', (string) $raw, $m)) {
        foreach ($m[1] as $name) {
            $name = strtolower($name);
            if (in_array($name, $known, true) && !in_array($name, $found, true)) $found[] = $name;
        }
    }
    // 上游对"不支持某参数"的表述五花八门(如 Kimi:"Unsupported Kimi K3 thinking_effort=...; supported values are ..."),
    // 只要错误文本表达了"不支持"且点名了已知参数,就纳入去参重试的范围
    if (strpos($text, 'unsupported') !== false || strpos($text, 'not supported') !== false || strpos($text, 'supported values') !== false) {
        if (preg_match_all('/\b(enable_thinking|reasoning_effort|thinking_effort|thinking|reasoning|temperature)\b/', $text, $m2)) {
            foreach ($m2[0] as $name) if (!in_array($name, $found, true)) $found[] = $name;
        }
    }
    if (!$found && strpos($text, 'unsupported parameter') !== false) {
        foreach ($known as $name) {
            if (strpos($text, $name) !== false) $found[] = $name;
        }
    }
    return $found;
}

// 从上游报错里解析"该模型支持的 effort 档位",把当前请求的档位就近改写后重试,
// 比直接删参数更好——保留推理强度控制。支持 thinking_effort / reasoning_effort / reasoning.effort 三种载体。
function tc_effort_remap_from_error(&$body, $raw, &$levelsOut = null) {
    $text = strtolower((string) $raw);
    if ($text === '' || strpos($text, 'unsupported') === false && strpos($text, 'not supported') === false && strpos($text, 'supported values') === false) return false;
    $param = '';
    foreach (array('thinking_effort', 'reasoning_effort') as $p) {
        if (strpos($text, $p) !== false) { $param = $p; break; }
    }
    // 有的上游把字段名写成空格形式("reasoning effort is not supported")
    if ($param === '' && strpos($text, 'reasoning effort') !== false) $param = 'reasoning_effort';
    if ($param === '') return false;
    $values = array();
    // 只截取到句末,避免贪婪回溯吃掉整个列表只剩最后一个词
    if (preg_match('/supported values?\s*(?:are|:|is)?\s*([^.;\n]+)/i', (string) $raw, $m) || preg_match('/must be (?:one of|between)[^.\n:;]*[:\s]+([^.;\n]+)/i', (string) $raw, $m)) {
        if (preg_match_all('/\b(minimal|none|low|medium|high|max)\b/i', $m[1], $vm)) {
            foreach ($vm[1] as $v) { $v = strtolower($v); if (!in_array($v, $values, true)) $values[] = $v; }
        }
    }
    if (!$values) return false;
    $order = array('minimal', 'none', 'low', 'medium', 'high', 'max');
    $cur = null; $slot = '';
    if ($param === 'thinking_effort') {
        if (array_key_exists('thinking_effort', $body)) { $cur = $body['thinking_effort']; $slot = 'thinking_effort'; }
    } else {
        if (array_key_exists('reasoning_effort', $body)) { $cur = $body['reasoning_effort']; $slot = 'reasoning_effort'; }
        elseif (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning'])) { $cur = $body['reasoning']['effort']; $slot = 'reasoning.effort'; }
    }
    if ($cur === null || $slot === '') return false;
    if (in_array(strtolower((string) $cur), $values, true)) return false;
    $target = tc_nearest_effort($cur, $values);
    if ($slot === 'reasoning.effort') $body['reasoning']['effort'] = $target;
    else $body[$slot] = $target;
    if (func_num_args() >= 3) $levelsOut = $values;
    return true;
}

// 自动学习:上游报错暴露了某模型可用的 effort 档位(或明确不收推理参数)时,
// 把结论沉淀为自动规则,后续请求在发出前就完成适配,不再依赖报错往返。
function tc_thinking_learn($model, $levels, $disable) {
    $model = strtolower(trim((string) $model));
    if ($model === '') return;
    try {
        tc_with_db(true, function (&$db) use ($model, $levels, $disable) {
            $cfg = tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null);
            if (empty($cfg['autoLearn'])) return;
            // 手动规则已覆盖该模型时,尊重管理员意图,不学习
            foreach ($cfg['rules'] as $r) {
                if (!empty($r['enabled']) && ($r['source'] ?? '') === 'manual' && strpos($model, strtolower((string) $r['match'])) !== false) return;
            }
            $match = substr($model, 0, 80);
            $mode = $disable ? 'off' : 'map';
            $levels = is_array($levels) ? array_values(array_filter(array_map('strtolower', $levels))) : array();
            if ($mode === 'map' && !$levels) return;
            $updatedAt = tc_now();
            $found = false;
            foreach ($cfg['rules'] as $i => $r) {
                if (($r['source'] ?? '') !== 'auto' || strtolower((string) $r['match']) !== $match) continue;
                $found = true;
                if (($r['mode'] ?? '') === $mode) {
                    if ($mode === 'map') {
                        $merged = array_values(array_unique(array_merge((array) ($r['levels'] ?? array()), $levels)));
                        sort($merged);
                        $cfg['rules'][$i]['levels'] = $merged;
                    }
                    $cfg['rules'][$i]['updatedAt'] = $updatedAt;
                } else {
                    // 同一模型报错性质变了(从可映射变为完全不支持,或反之):替换为最新结论
                    $cfg['rules'][$i] = array('id' => $r['id'], 'match' => $match, 'mode' => $mode, 'levels' => $levels, 'forceEffort' => '', 'enabled' => true, 'source' => 'auto', 'updatedAt' => $updatedAt);
                }
                break;
            }
            if (!$found) {
                // 规则数量上限:超出时淘汰最旧的自动规则
                $auto = array_values(array_filter($cfg['rules'], function ($r) { return ($r['source'] ?? '') === 'auto'; }));
                if (count($auto) >= 60) {
                    usort($auto, function ($a, $b) { return ($a['updatedAt'] ?? 0) - ($b['updatedAt'] ?? 0); });
                    $drop = $auto[0]['id'] ?? '';
                    $cfg['rules'] = array_values(array_filter($cfg['rules'], function ($r) use ($drop) { return ($r['id'] ?? '') !== $drop; }));
                }
                $cfg['rules'][] = array('id' => tc_uid(8), 'match' => $match, 'mode' => $mode, 'levels' => $levels, 'forceEffort' => '', 'enabled' => true, 'source' => 'auto', 'updatedAt' => $updatedAt);
            }
            $db['settings']['thinking'] = $cfg;
        });
    } catch (Throwable $e) { /* 学习失败不影响主流程 */ }
}

function tc_strip_reasoning_params(&$body, $names) {
    $changed = false;
    foreach ($names as $name) {
        if ($name === 'enable_thinking' && array_key_exists('enable_thinking', $body)) {
            unset($body['enable_thinking']);
            $changed = true;
        } elseif ($name === 'temperature' && array_key_exists('temperature', $body)) {
            unset($body['temperature']);
            $changed = true;
        } elseif ($name === 'reasoning_effort' && array_key_exists('reasoning_effort', $body)) {
            unset($body['reasoning_effort']);
            $changed = true;
        } elseif ($name === 'thinking_effort' && array_key_exists('thinking_effort', $body)) {
            unset($body['thinking_effort']);
            $changed = true;
        } elseif ($name === 'thinking' && array_key_exists('thinking', $body)) {
            unset($body['thinking']);
            $changed = true;
        } elseif ($name === 'reasoning' && array_key_exists('reasoning', $body)) {
            unset($body['reasoning']);
            $changed = true;
        }
    }
    return $changed;
}

// $force=true 时无条件写入(模型级 max_tokens 覆盖),否则只在缺失或超上限时压回
function tc_clamp_output_tokens(&$body, $format, $cap, $force = false) {
    $cap = (int) $cap;
    if ($cap < 256) return;
    if ($format === 'anthropic') {
        $want = isset($body['max_tokens']) ? (int) $body['max_tokens'] : 1024;
        if ($want <= 0) $want = 1024;
        $body['max_tokens'] = $force ? $cap : min($cap, max(256, $want));
        if (!empty($body['thinking']['budget_tokens'])) {
            $budget = (int) $body['thinking']['budget_tokens'];
            if ($budget >= $body['max_tokens']) {
                if ($body['max_tokens'] < 2) $body['max_tokens'] = 2;
                $body['thinking']['budget_tokens'] = $body['max_tokens'] - 1;
            }
        }
        return;
    }
    if ($format === 'responses') {
        $current = isset($body['max_output_tokens']) ? (int) $body['max_output_tokens'] : 0;
        if ($force || $current <= 0 || $current > $cap) $body['max_output_tokens'] = $cap;
        return;
    }
    if ($format === 'chat' || $format === 'completions') {
        $current = isset($body['max_tokens']) ? (int) $body['max_tokens'] : 0;
        if ($force || $current <= 0 || $current > $cap) $body['max_tokens'] = $cap;
    }
}

// 全局温度:管理员未设置(null)时不发送,避免影响不接受该参数的推理型模型
function tc_apply_temperature(&$body, $format, $temperature) {
    if ($temperature === null || $temperature === '') return;
    $t = (float) $temperature;
    if ($t < 0) $t = 0;
    // Anthropic 的温度取值范围是 0-1
    if ($format === 'anthropic') $t = min(1, $t);
    $body['temperature'] = $t;
}

// 粗略 token 估算:中日韩字符按 1 token/字,其余按 4 字符/token(宁可略高估,保证输出预算留足)
function tc_estimate_text_tokens($s) {
    if ($s === '' || !is_string($s)) return 0;
    $len = mb_strlen($s, 'UTF-8');
    if ($len === 0) return 0;
    $cjk = @preg_match_all('/[\x{3000}-\x{30ff}\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{ac00}-\x{d7a3}\x{f900}-\x{faf6}\x{ff00}-\x{ffef}]/u', $s);
    $cjk = $cjk === false ? 0 : (int) $cjk;
    return (int) round($cjk + ($len - $cjk) / 4);
}

// 递归估算请求体 token:图片/文件等多模态部分按固定 1024 计,base64 数据不计(避免把图片体积当文本)
function tc_estimate_body_tokens($v) {
    if (is_string($v)) {
        $v = preg_replace('#data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+#', '', (string) $v);
        $v = preg_replace('#\b[A-Za-z0-9+/=]{512,}\b#', '', (string) $v);
        return tc_estimate_text_tokens($v);
    }
    if (is_array($v)) {
        $type = isset($v['type']) && is_string($v['type']) ? $v['type'] : '';
        if (in_array($type, array('image_url', 'input_image', 'image', 'file', 'input_file', 'document'), true)) return 1024;
        $sum = 0;
        foreach ($v as $val) $sum += tc_estimate_body_tokens($val);
        return $sum;
    }
    return 0;
}

function tc_disable_buffers() {
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) @ob_end_flush();
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    header('X-Accel-Buffering: no');
}

// 把 curl 失败翻译成带诊断信息的结果:区分「连不上」与「响应慢」,便于用户定位
function tc_curl_failure($ch, $errno, $err, $status, $url, $connectSec, $timeoutSec) {
    $connectTime = (float) curl_getinfo($ch, CURLINFO_CONNECT_TIME);
    $totalTime = (float) curl_getinfo($ch, CURLINFO_TOTAL_TIME);
    $host = parse_url((string) $url, PHP_URL_HOST);
    $port = parse_url((string) $url, PHP_URL_PORT);
    $hostLabel = $host ? ($host . ($port ? ':' . $port : '')) : (string) $url;
    // curl 常量在不同 PHP/curl 构建里未必齐全,统一用 defined() 兜底成标准数值
    $c = function ($name, $fallback) { return defined($name) ? constant($name) : $fallback; };
    $errResolveHost = $c('CURLE_COULDNT_RESOLVE_HOST', 6);
    $errResolveProxy = $c('CURLE_COULDNT_RESOLVE_PROXY', 5);
    $errConnect = $c('CURLE_COULDNT_CONNECT', 7);
    $errTimeout = $c('CURLE_OPERATION_TIMEDOUT', 28);
    $tlsErrs = array(
        $c('CURLE_SSL_CONNECT_ERROR', 35),
        $c('CURLE_SSL_CERTPROBLEM', 58),
        $c('CURLE_SSL_CIPHER', 59),
        $c('CURLE_PEER_FAILED_VERIFICATION', 60),
        $c('CURLE_SSL_CACERT', 60),
        $c('CURLE_SSL_CACERT_BADFILE', 77),
    );
    $kind = 'other';
    $code = 502;
    if ($errno === $errResolveHost || $errno === $errResolveProxy) {
        $kind = 'dns';
    } elseif ($errno === $errConnect) {
        $kind = 'connect';
    } elseif (in_array($errno, $tlsErrs, true)) {
        $kind = 'tls';
    } elseif ($errno === $errTimeout) {
        // 连接从未建立(connectTime 为 0)= 连不上/DNS 卡住;已建立则是在等响应
        $kind = $connectTime <= 0 ? 'connect_timeout' : 'read_timeout';
        $code = 504;
    }
    return array(
        'ok' => false,
        'error' => $err ?: '无法连接上游 API',
        'code' => $code,
        'status' => (int) $status,
        'kind' => $kind,
        'host' => $hostLabel,
        'connect_timeout' => $connectSec,
        'timeout' => $timeoutSec,
        'connect_time' => round($connectTime, 2),
        'elapsed' => round($totalTime, 2),
    );
}

// 把上游连接失败结果翻译成可操作的中文提示(带主机名与秒数,指明该查什么)
function tc_upstream_fail_message($res, $providerName = '') {
    $label = ($providerName !== '' ? '「' . $providerName . '」' : '');
    $host = (isset($res['host']) && $res['host'] !== '') ? $res['host'] : '上游地址';
    $kind = isset($res['kind']) ? $res['kind'] : 'other';
    $ct = isset($res['connect_timeout']) ? (int) $res['connect_timeout'] : 0;
    $tt = isset($res['timeout']) ? (int) $res['timeout'] : 0;
    $detail = isset($res['error']) ? (string) $res['error'] : '';
    switch ($kind) {
        case 'connect_timeout':
            return $label . '连接上游超时：' . $ct . ' 秒内无法与 ' . $host . ' 建立连接。请确认该地址与端口正确、服务已启动，且服务器能访问外网（境外平台常被防火墙/网络出口拦截）。';
        case 'read_timeout':
            return $label . '上游响应超时：已连接 ' . $host . '，但超过 ' . $tt . ' 秒未返回内容。可在「对话设置 → 请求超时」调大该值，或改用响应更快的模型。';
        case 'dns':
            return $label . '无法解析上游域名 ' . $host . '。请检查 Base URL 拼写与服务器 DNS。';
        case 'connect':
            return $label . '无法连接上游 ' . $host . '（' . $detail . '）。请确认服务已启动、端口开放且地址可访问。';
        case 'tls':
            return $label . '与上游建立 HTTPS 连接失败：' . $detail . '。请检查证书链是否完整，或改用 http。';
        default:
            return $label . '无法连接上游 API（' . $host . '）：' . ($detail !== '' ? $detail : '未知错误');
    }
}

function tc_http_request($url, $method, $headers, $body, $timeoutMs, $stream = false, $onChunk = null, $sendExpect = true, $connectTimeoutMs = null) {
    if (!function_exists('curl_init')) {
        return array('ok' => false, 'error' => '服务器未启用 curl 扩展，无法请求上游 API', 'code' => 0);
    }
    $ch = curl_init($url);
    $hdrs = array();
    foreach ($headers as $k => $v) $hdrs[] = $k . ': ' . $v;
    $timeoutSec = max(5, (int) ceil($timeoutMs / 1000));
    // 连接超时:默认 20 秒;显式传入时以传入为准(不超过总超时)
    $connectSec = $connectTimeoutMs === null ? 20 : max(3, (int) ceil($connectTimeoutMs / 1000));
    $opts = array(
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $hdrs,
        CURLOPT_RETURNTRANSFER => !$stream,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => $connectSec,
        CURLOPT_TIMEOUT => $stream ? 0 : $timeoutSec,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADER => false,
    );
    $ca = tc_cacert_path();
    if ($ca) $opts[CURLOPT_CAINFO] = $ca;
    curl_setopt_array($ch, $opts);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    if (!$sendExpect) curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge($hdrs, array('Expect:', 'Content-Type:')));
    $status = 0;
    $raw = '';
    if ($stream && is_callable($onChunk)) {
        $errBody = '';
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use ($onChunk, &$status, &$errBody) {
            if (!$status) $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($status >= 400) {
                $errBody .= $data;
                return strlen($data);
            }
            $onChunk($data);
            return strlen($data);
        });
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        $errno = curl_errno($ch);
        $fail = $ok === false ? tc_curl_failure($ch, $errno, $err, $status, $url, $connectSec, 0) : null;
        curl_close($ch);
        if ($fail !== null) return $fail;
        return array('ok' => true, 'status' => $status, 'body' => $errBody, 'ctype' => '');
    }
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $err = curl_error($ch);
    $errno = curl_errno($ch);
    $fail = $raw === false ? tc_curl_failure($ch, $errno, $err, $status, $url, $connectSec, $timeoutSec) : null;
    curl_close($ch);
    if ($fail !== null) return $fail;
    return array('ok' => true, 'status' => $status, 'body' => $raw, 'ctype' => $ctype);
}

function tc_upstream_error_message($raw, $status) {
    $msg = '上游 API 错误 (HTTP ' . $status . ')';
    $j = json_decode($raw, true);
    if (is_array($j)) {
        if (isset($j['error']['message'])) return (string) $j['error']['message'];
        if (isset($j['error']['code'])) return (string) $j['error']['code'];
        if (isset($j['message'])) return (string) $j['message'];
    }
    return $msg;
}

function tc_plain_text($s, $limit = 360) {
    $s = html_entity_decode(strip_tags((string) $s), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = preg_replace('/\s+/u', ' ', $s);
    $s = trim((string) $s);
    if ($limit > 0 && function_exists('mb_substr')) return mb_substr($s, 0, $limit, 'UTF-8');
    if ($limit > 0) return substr($s, 0, $limit);
    return $s;
}

function tc_web_search_query_from_body($body, $format) {
    $text = '';
    if ($format === 'responses' && isset($body['input'])) {
        if (is_string($body['input'])) $text = $body['input'];
        elseif (is_array($body['input'])) {
            for ($i = count($body['input']) - 1; $i >= 0; $i--) {
                $m = $body['input'][$i];
                if (!is_array($m)) continue;
                $role = isset($m['role']) ? $m['role'] : '';
                if ($role && $role !== 'user') continue;
                $c = isset($m['content']) ? $m['content'] : '';
                if (is_string($c)) { $text = $c; break; }
                if (is_array($c)) {
                    $parts = array();
                    foreach ($c as $p) {
                        if (is_string($p)) $parts[] = $p;
                        elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                    }
                    $text = implode("\n", $parts);
                    if (trim($text) !== '') break;
                }
            }
        }
    } elseif ($format === 'completions' && isset($body['prompt'])) {
        $text = (string) $body['prompt'];
    } elseif (isset($body['messages']) && is_array($body['messages'])) {
        for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
            $m = $body['messages'][$i];
            if (!is_array($m) || (isset($m['role']) && $m['role'] !== 'user')) continue;
            $c = isset($m['content']) ? $m['content'] : '';
            if (is_string($c)) { $text = $c; break; }
            if (is_array($c)) {
                $parts = array();
                foreach ($c as $p) {
                    if (is_string($p)) $parts[] = $p;
                    elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                }
                $text = implode("\n", $parts);
                if (trim($text) !== '') break;
            }
        }
    }
    $text = tc_plain_text($text, 240);
    if ($text === '') return '';
    if (function_exists('mb_strlen') && mb_strlen($text, 'UTF-8') < 2) return '';
    if (strlen($text) < 2) return '';
    return $text;
}

// 提取最后一条用户消息的纯文本(用于内容审核,不做截断压缩)
function tc_last_user_text($body, $format) {
    $text = '';
    if ($format === 'responses' && isset($body['input'])) {
        if (is_string($body['input'])) $text = $body['input'];
        elseif (is_array($body['input'])) {
            for ($i = count($body['input']) - 1; $i >= 0; $i--) {
                $m = $body['input'][$i];
                if (!is_array($m)) continue;
                $role = isset($m['role']) ? $m['role'] : '';
                if ($role && $role !== 'user') continue;
                $c = isset($m['content']) ? $m['content'] : '';
                if (is_string($c)) { $text = $c; break; }
                if (is_array($c)) {
                    $parts = array();
                    foreach ($c as $p) {
                        if (is_string($p)) $parts[] = $p;
                        elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                    }
                    $text = implode("\n", $parts);
                    if (trim($text) !== '') break;
                }
            }
        }
    } elseif ($format === 'completions' && isset($body['prompt'])) {
        $text = (string) $body['prompt'];
    } elseif (isset($body['messages']) && is_array($body['messages'])) {
        for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
            $m = $body['messages'][$i];
            if (!is_array($m) || (isset($m['role']) && $m['role'] !== 'user')) continue;
            $c = isset($m['content']) ? $m['content'] : '';
            if (is_string($c)) { $text = $c; break; }
            if (is_array($c)) {
                $parts = array();
                foreach ($c as $p) {
                    if (is_string($p)) $parts[] = $p;
                    elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
                }
                $text = implode("\n", $parts);
                if (trim($text) !== '') break;
            }
        }
    }
    return tc_plain_text($text, 20000);
}

function tc_normalize_search_hits($rows, $max) {
    $out = array();
    $seen = array();
    foreach ($rows as $r) {
        if (!is_array($r)) continue;
        $url = trim((string) (isset($r['url']) ? $r['url'] : (isset($r['href']) ? $r['href'] : (isset($r['link']) ? $r['link'] : ''))));
        if ($url === '' || !preg_match('#^https?://#i', $url)) continue;
        $key = strtolower($url);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $title = tc_plain_text(isset($r['title']) ? $r['title'] : $url, 120);
        $snippet = tc_plain_text(isset($r['content']) ? $r['content'] : (isset($r['snippet']) ? $r['snippet'] : (isset($r['description']) ? $r['description'] : '')), 360);
        $out[] = array(
            'id' => (string) (count($out) + 1),
            'title' => $title !== '' ? $title : $url,
            'url' => $url,
            'snippet' => $snippet,
        );
        if (count($out) >= $max) break;
    }
    return $out;
}

function tc_search_tavily($key, $query, $max, $timeoutMs = 18000) {
    $payload = tc_json_encode(array(
        'api_key' => $key,
        'query' => $query,
        'search_depth' => 'basic',
        'max_results' => $max,
        'include_answer' => false,
    ));
    $res = tc_http_request('https://api.tavily.com/search', 'POST', array(
        'Content-Type' => 'application/json',
        'Accept' => 'application/json',
    ), $payload, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'Tavily 搜索失败');
    }
    $j = json_decode($res['body'], true);
    $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
    return array('ok' => true, 'hits' => tc_normalize_search_hits($rows, $max));
}

function tc_search_searxng($base, $query, $max, $timeoutMs = 18000) {
    $base = rtrim((string) $base, '/');
    if ($base === '' || !preg_match('#^https?://#i', $base)) {
        return array('ok' => false, 'error' => 'SearXNG 地址无效');
    }
    $url = $base . '/search?' . http_build_query(array(
        'q' => $query,
        'format' => 'json',
        'language' => 'zh-CN',
        'safesearch' => 0,
    ));
    $res = tc_http_request($url, 'GET', array(
        'Accept' => 'application/json',
        'User-Agent' => 'TinyChat/1.0 (SearXNG JSON)',
    ), null, $timeoutMs, false);
    if (!$res['ok'] || $res['status'] >= 400) {
        $msg = !$res['ok'] ? $res['error'] : tc_upstream_error_message($res['body'], $res['status']);
        return array('ok' => false, 'error' => $msg ?: 'SearXNG 搜索失败');
    }
    $j = json_decode($res['body'], true);
    $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
    return array('ok' => true, 'hits' => tc_normalize_search_hits($rows, $max));
}

function tc_search_searxng_failover($raw, $query, $max, $timeoutMs = 12000) {
    $urls = tc_searx_url_list($raw);
    if (!$urls) return array('ok' => false, 'error' => '请先填写 SearXNG 地址');
    $errors = array();
    foreach ($urls as $i => $url) {
        $found = tc_search_searxng($url, $query, $max, $timeoutMs);
        $hits = (!empty($found['ok']) && isset($found['hits']) && is_array($found['hits'])) ? $found['hits'] : array();
        if (!empty($found['ok']) && $hits) {
            return array('ok' => true, 'hits' => $hits, 'url' => $url);
        }
        $msg = !empty($found['ok']) ? '没有返回可用结果' : (isset($found['error']) ? (string) $found['error'] : 'SearXNG 搜索失败');
        $errors[] = $url . '：' . $msg;
        if ($i >= 5) break;
    }
    return array('ok' => false, 'error' => implode('；', array_slice($errors, 0, 3)));
}

function tc_search_local_verdict($query) {
    $q = trim((string) $query);
    if ($q === '') return false;
    $fresh = '/(天气|气温|新闻|头条|股价|汇率|金价|油价|比分|赛程|赛果|最新消息|最新新闻|最新版本|最近发生|今天|今日|昨天|刚才|现在几点|当前版本|实时|官网|网页|版本号|更新了什么|发生了什么|多少钱|报价)/u';
    if (preg_match($fresh, $q)) return true;
    if (preg_match('/https?:\/\/|www\./i', $q)) return true;
    $stable = '/(翻译成|润色|改写一下|续写|扩写|缩写|总结一下|概括一下|写一首|写一篇|写一段|写一份|写一封|写一个|写个|写作文|写诗|写代码|代码|函数|脚本|报错|调试|解释一下|什么是|是什么意思|怎么理解|举个例子|帮我算|计算|证明|闲聊|你好|谢谢)/u';
    if (preg_match($stable, $q)) return false;
    return null;
}

function tc_search_needs_web($query, $provider, $format, $model) {
    $q = trim((string) $query);
    if ($q === '') return false;
    $local = tc_search_local_verdict($q);
    if ($local !== null) return $local;
    $len = function_exists('mb_strlen') ? mb_strlen($q, 'UTF-8') : strlen($q);
    if ($len > 240) $q = function_exists('mb_substr') ? mb_substr($q, 0, 240, 'UTF-8') : substr($q, 0, 240);
    $prompt = "你是检索闸门。只有当这句话离开互联网上的最新事实就答不好时才回答 YES。YES 仅限：新闻、天气、股价、汇率、比分、今天或最近发生的事、最新版本、具体网页、人物或机构的近况。写作、润色、翻译、改写、闲聊、代码、数学、解释概念、基于用户已给出材料的任务，一律回答 NO。拿不准时回答 NO。只输出 YES 或 NO。\n\n" . $q;
    $model = trim((string) $model);
    if ($model === '' && isset($provider['models'][0]['id'])) $model = $provider['models'][0]['id'];
    if ($model === '') return false;
    $fmt = ($format === 'anthropic' || $format === 'responses' || $format === 'completions') ? 'chat' : $format;
    $url = tc_upstream_path(rtrim((string) $provider['baseUrl'], '/'), $fmt);
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($fmt === 'anthropic') {
        $headers['x-api-key'] = $provider['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $provider['apiKey'];
    }
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode(array(
        'model' => $model,
        'stream' => false,
        'max_tokens' => 4,
        'temperature' => 0,
        'messages' => array(array('role' => 'user', 'content' => $prompt)),
    )), 8000, false);
    if (empty($res['ok']) || (isset($res['status']) && (int) $res['status'] >= 400)) return false;
    $j = json_decode(isset($res['body']) ? $res['body'] : '', true);
    $text = '';
    if (is_array($j) && isset($j['choices'][0]['message']['content'])) $text = trim((string) $j['choices'][0]['message']['content']);
    if ($text === '') return false;
    if (preg_match('/^\s*NO\b/i', $text)) return false;
    return (bool) preg_match('/^\s*YES\b/i', $text);
}

function tc_run_web_search($settings, $query) {
    $query = trim((string) $query);
    if ($query === '') return array('ok' => false, 'error' => '没有可检索的问题');
    if (!tc_web_search_ready($settings)) return array('ok' => false, 'error' => '管理员尚未配置联网搜索');
    $max = isset($settings['webSearchMaxResults']) ? (int) $settings['webSearchMaxResults'] : 5;
    if ($settings['webSearchProvider'] === 'searxng') {
        return tc_search_searxng_failover($settings['webSearchSearxUrl'], $query, $max);
    }
    return tc_search_tavily($settings['webSearchTavilyKey'], $query, $max);
}

function tc_search_today() {
    try {
        $dt = new DateTime('now', new DateTimeZone('Asia/Shanghai'));
    } catch (Exception $e) {
        $dt = new DateTime('now');
    }
    $week = array('日', '一', '二', '三', '四', '五', '六');
    return $dt->format('Y年n月j日') . ' 星期' . $week[(int) $dt->format('w')];
}

function tc_html_to_text($html) {
    $html = (string) $html;
    $html = preg_replace('#<(script|style|noscript|svg|iframe|template)\b[^>]*>.*?</\1>#is', ' ', $html);
    if (preg_match('#<article\b[^>]*>(.*?)</article>#is', $html, $m)) $html = $m[1];
    elseif (preg_match('#<main\b[^>]*>(.*?)</main>#is', $html, $m)) $html = $m[1];
    $html = preg_replace('#</?(br|p|div|li|h[1-6]|tr|section|article|header|footer)\b[^>]*>#i', "\n", $html);
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace("/[ \t\x{00A0}]+/u", ' ', (string) $text);
    $text = preg_replace("/\n[ \t]+/u", "\n", (string) $text);
    $text = preg_replace("/\n{3,}/u", "\n\n", (string) $text);
    return trim((string) $text);
}

// 服务端从 SSE 流里解析 token 用量(镜像前端 captureStreamUsage 的逻辑)
// 兼容 OpenAI(prompt_tokens/completion_tokens)与 Anthropic(input_tokens/output_tokens)两种字段
function tc_capture_stream_usage(&$target, $chunk, $format) {
    if ($chunk === '' || strpos($chunk, '_tokens') === false) return;
    foreach (explode("\n", $chunk) as $line) {
        $line = trim($line);
        if (strpos($line, 'data:') !== 0) continue;
        $payload = trim(substr($line, 5));
        if ($payload === '' || $payload === '[DONE]') continue;
        $j = json_decode($payload, true);
        if (!is_array($j)) continue;
        $cands = array();
        if (isset($j['usage']) && is_array($j['usage'])) $cands[] = $j['usage'];
        if (isset($j['message']) && is_array($j['message']) && isset($j['message']['usage']) && is_array($j['message']['usage'])) $cands[] = $j['message']['usage'];
        if (isset($j['response']) && is_array($j['response']) && isset($j['response']['usage']) && is_array($j['response']['usage'])) $cands[] = $j['response']['usage'];
        foreach ($cands as $u) {
            $prompt = (int) (isset($u['prompt_tokens']) ? $u['prompt_tokens'] : (isset($u['input_tokens']) ? $u['input_tokens'] : 0));
            $completion = (int) (isset($u['completion_tokens']) ? $u['completion_tokens'] : (isset($u['output_tokens']) ? $u['output_tokens'] : 0));
            // message_delta 里的 output_tokens 是累计值,取较大者即为最终用量
            if ($prompt > (isset($target['prompt']) ? $target['prompt'] : 0)) $target['prompt'] = $prompt;
            if ($completion > (isset($target['completion']) ? $target['completion'] : 0)) $target['completion'] = $completion;
        }
    }
}

// SSRF 防护:校验 URL 指向公网地址 —— 拒绝内网/保留 IP(含 127.0.0.1、云元数据 169.254.169.254)、
// localhost 类主机名、非常规端口;域名会做真实 DNS 解析,返回选定 IP 供请求固定解析结果
function tc_url_public_host($url) {
    $p = @parse_url((string) $url);
    if (!$p || empty($p['host'])) return false;
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if (!in_array($scheme, array('http', 'https'), true)) return false;
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
    if (!in_array($port, array(80, 443, 8080, 8443), true)) return false;
    $host = strtolower((string) $p['host']);
    $host = trim($host, '[]');
    if ($host === '' || $host === 'localhost' || preg_match('/\.(local|internal|intranet|lan|home\.arpa|arpa)$/i', $host)) return false;
    $ipOk = function ($ip) {
        return is_string($ip) && $ip !== '' && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    };
    $ips = array();
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        if ($ipOk($host)) $ips[] = $host;
    } else {
        foreach ((array) @gethostbynamel($host) as $ip) if ($ipOk($ip)) $ips[] = $ip;
        if (!$ips && function_exists('dns_get_record')) {
            foreach ((array) @dns_get_record($host, DNS_AAAA) as $rec) {
                $v6 = isset($rec['ipv6']) ? $rec['ipv6'] : '';
                if ($ipOk($v6)) $ips[] = $v6;
            }
        }
    }
    return $ips ? array('ip' => $ips[0], 'port' => $port, 'host' => $host) : false;
}

function tc_fetch_pages_parallel($urls, $timeoutMs = 8000, $maxChars = 1800) {
    $out = array();
    $entries = array();
    foreach ((array) $urls as $u) {
        $out[$u] = '';
        $guard = tc_url_public_host($u);
        if (!$guard) continue; // 内网/保留地址/非法端口:静默跳过
        $entries[] = array('url' => $u, 'resolve' => $guard['host'] . ':' . $guard['port'] . ':' . $guard['ip']);
    }
    if (!$entries) return $out;
    if (!function_exists('curl_multi_init')) {
        foreach ($entries as $e) {
            $res = tc_http_request($e['url'], 'GET', array(
                'Accept' => 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8',
                'User-Agent' => 'Mozilla/5.0 (compatible; TinyChat/1.0)',
            ), null, $timeoutMs, false);
            if (empty($res['ok']) || $res['status'] >= 400) continue;
            $out[$e['url']] = tc_html_to_text(isset($res['body']) ? $res['body'] : '');
        }
        return $out;
    }
    $mh = curl_multi_init();
    $handles = array();
    $ca = tc_cacert_path();
    foreach ($entries as $e) {
        $ch = curl_init($e['url']);
        $opts = array(
            CURLOPT_HTTPHEADER => array(
                'Accept: text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8',
                'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
            ),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => max(4, (int) ceil($timeoutMs / 1000)),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // 固定已校验的解析结果,防 DNS 重绑定;限制协议;限制下载体积
            CURLOPT_RESOLVE => array($e['resolve']),
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_MAXFILESIZE => 4194304,
        );
        if ($ca) $opts[CURLOPT_CAINFO] = $ca;
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($mh, $ch);
        $handles[] = $ch;
    }
    $running = null;
    do {
        $status = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running && $status === CURLM_OK);
    foreach ($handles as $i => $ch) {
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $ctype = strtolower((string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
        $raw = curl_multi_getcontent($ch);
        // 重定向后可能落到内网:对最终生效地址再做一次校验,不通过则丢弃内容
        $eff = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        if ($eff !== '' && !tc_url_public_host($eff)) { curl_multi_remove_handle($mh, $ch); curl_close($ch); continue; }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
        if ($code < 200 || $code >= 400 || !is_string($raw) || $raw === '') continue;
        if ($ctype !== '' && strpos($ctype, 'html') === false && strpos($ctype, 'text/plain') === false && strpos($ctype, 'xml') === false) continue;
        if (strlen($raw) > 800000) $raw = substr($raw, 0, 800000);
        $text = (strpos($ctype, 'text/plain') !== false) ? trim($raw) : tc_html_to_text($raw);
        $text = trim((string) preg_replace('/[ \t]+/u', ' ', $text));
        $len = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
        if ($len < 80) continue;
        $out[$entries[$i]['url']] = function_exists('mb_substr') ? mb_substr($text, 0, $maxChars, 'UTF-8') : substr($text, 0, $maxChars);
    }
    curl_multi_close($mh);
    return $out;
}

function tc_enrich_search_pages(&$hits) {
    $want = array();
    foreach ($hits as $i => $h) {
        if (count($want) >= 3) break;
        $url = isset($h['url']) ? (string) $h['url'] : '';
        if ($url === '' || preg_match('/\.(pdf|zip|png|jpe?g|gif|webp|mp4|mp3)(\?|$)/i', $url)) continue;
        $want[$i] = $url;
    }
    if (!$want) return;
    $pages = tc_fetch_pages_parallel(array_values($want), 8000);
    foreach ($want as $i => $url) {
        if (!empty($pages[$url])) $hits[$i]['page'] = $pages[$url];
    }
}

function tc_format_search_context($hits) {
    $lines = array(
        '今天是 ' . tc_search_today() . '（北京时间）。用户已打开联网搜索。',
        '下列材料包含检索摘要，以及已经打开的网页正文摘录。回答事实、日期和数字时只依据这些材料；材料里没有的就说明没查到，不要改用你的训练截止日期，也不要说自己无法浏览网页。',
        '在正文用 [1]、[2] 标注对应条目，不要编造未列出的网址。',
    );
    foreach ($hits as $i => $h) {
        $n = $i + 1;
        $block = '[' . $n . '] ' . $h['title'] . "\nURL: " . $h['url'];
        if (!empty($h['snippet'])) $block .= "\n摘要: " . $h['snippet'];
        if (!empty($h['page'])) $block .= "\n正文摘录: " . $h['page'];
        $lines[] = $block;
    }
    return implode("\n\n", $lines);
}

// ============ 链接读取:用户消息里带网址时,自动打开并提取正文作为回答材料 ============
function tc_urls_from_last_user_message($body, $format) {
    $text = tc_web_search_query_from_body($body, $format);
    if ($text === '' || stripos($text, 'http://') === false && stripos($text, 'https://') === false) return array();
    // 只匹配 URL 合法字符:遇到中文等自然语言字符即视为链接结束
    if (!preg_match_all('~https?://[A-Za-z0-9\-._%!$&\'()*+,;=:@/?#\[\]\~]+~u', $text, $m)) return array();
    $urls = array();
    foreach ($m[0] as $u) {
        $u = rtrim($u, '.,;:!?\'"');
        // 括号失衡时去掉尾部括号(维基百科类成对括号路径保留)
        while ($u !== '' && substr_count($u, '(') !== substr_count($u, ')') && substr($u, -1) === ')') $u = substr($u, 0, -1);
        while ($u !== '' && substr_count($u, '[') !== substr_count($u, ']') && substr($u, -1) === ']') $u = substr($u, 0, -1);
        if ($u === '' || !preg_match('#^https?://[^\s]+\.[^\s]+$#i', $u)) continue;
        if (!in_array($u, $urls, true)) $urls[] = $u;
    }
    return $urls;
}

function tc_read_urls_to_citations($urls, $settings) {
    $max = max(1, min(5, (int) (isset($settings['urlReadMax']) ? $settings['urlReadMax'] : 3) ?: 3));
    $urls = array_slice($urls, 0, $max);
    if (!$urls) return array();
    $pages = tc_fetch_pages_parallel($urls, 9000);
    $out = array();
    foreach ($urls as $u) {
        $text = trim((string) (isset($pages[$u]) ? $pages[$u] : ''));
        if ($text === '') continue;
        $host = (string) parse_url($u, PHP_URL_HOST);
        $out[] = array('url' => $u, 'title' => $host !== '' ? $host : $u, 'snippet' => '', 'page' => mb_substr($text, 0, 8000));
    }
    return $out;
}

function tc_format_url_read_context($hits, $start) {
    $lines = array(
        '用户消息中包含以下链接，已打开并提取正文。回答这些链接相关的问题时以正文为准；正文里没有的信息就说明没抓到，不要编造。',
        '在正文用 [' . ($start + 1) . ']、[' . ($start + 2) . '] 标注对应条目。',
    );
    foreach ($hits as $i => $h) {
        $n = $start + $i + 1;
        $block = '[' . $n . '] ' . $h['title'] . "\nURL: " . $h['url'];
        if (!empty($h['page'])) $block .= "\n正文摘录: " . $h['page'];
        $lines[] = $block;
    }
    return implode("\n\n", $lines);
}

function tc_append_system_text(&$body, $format, $extra) {
    $extra = trim((string) $extra);
    if ($extra === '') return;
    if ($format === 'anthropic') {
        $cur = isset($body['system']) ? (string) $body['system'] : '';
        $body['system'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    if ($format === 'responses') {
        $cur = isset($body['instructions']) ? (string) $body['instructions'] : '';
        $body['instructions'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    if ($format === 'completions') {
        $cur = isset($body['prompt']) ? (string) $body['prompt'] : '';
        $body['prompt'] = $extra . "\n\n" . $cur;
        return;
    }
    if (!isset($body['messages']) || !is_array($body['messages'])) $body['messages'] = array();
    if (isset($body['messages'][0]) && is_array($body['messages'][0]) && isset($body['messages'][0]['role']) && $body['messages'][0]['role'] === 'system') {
        $cur = isset($body['messages'][0]['content']) ? (string) $body['messages'][0]['content'] : '';
        $body['messages'][0]['content'] = $cur === '' ? $extra : ($cur . "\n\n" . $extra);
        return;
    }
    array_unshift($body['messages'], array('role' => 'system', 'content' => $extra));
}

function tc_public_searx_fallback() {
    return array(
        'https://baresearch.org',
        'https://etsi.me',
        'https://opnxng.com',
        'https://paulgo.io',
        'https://priv.au',
        'https://search.inetol.net',
        'https://search.mdosch.de',
        'https://searx.tiekoetter.com',
        'https://searx.namejeff.xyz',
        'https://searxng.site',
        'https://searxng.website',
        'https://sx.catgirl.cloud',
    );
}

function tc_public_searx_instances() {
    $file = tc_data_dir() . '/searx-instances.json';
    $fresh = is_file($file) && (time() - (int) @filemtime($file)) < 6 * 3600;
    $text = $fresh ? (string) @file_get_contents($file) : '';
    if ($text === '') {
        $sources = array(
            'https://cdn.jsdelivr.net/gh/searxng/searx-instances@master/searxinstances/instances.yml',
            'https://fastly.jsdelivr.net/gh/searxng/searx-instances@master/searxinstances/instances.yml',
        );
        foreach ($sources as $src) {
            $res = tc_http_request($src, 'GET', array('Accept' => 'text/yaml, text/plain, */*'), null, 8000, false);
            if (!empty($res['ok']) && $res['status'] < 400 && !empty($res['body']) && strpos($res['body'], 'https://') !== false) {
                $text = $res['body'];
                break;
            }
        }
    }
    $urls = array();
    if ($text !== '' && $text[0] === '[') {
        $cached = json_decode($text, true);
        if (is_array($cached)) $urls = $cached;
    } elseif ($text !== '') {
        if (preg_match_all('/^(https:\/\/[^\s:#]+)\s*:/m', $text, $m)) $urls = $m[1];
    }
    $out = array();
    $seen = array();
    foreach ($urls as $u) {
        $u = rtrim(trim((string) $u), '/');
        if (!preg_match('#^https://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $u;
    }
    if (!$out) $out = tc_public_searx_fallback();
    if (!$fresh && $out && $text !== '') {
        @file_put_contents($file, tc_json_encode($out), LOCK_EX);
    }
    return $out;
}

function tc_probe_searx_many($urls, $query, $max, $timeoutMs = 6000) {
    if (!function_exists('curl_multi_init') || !$urls) {
        $out = array();
        foreach ($urls as $u) $out[] = tc_probe_search_endpoint('searxng', $query, '', $u, $max, $timeoutMs);
        return $out;
    }
    $mh = curl_multi_init();
    $handles = array();
    $started = tc_now();
    foreach ($urls as $i => $base) {
        $base = rtrim((string) $base, '/');
        $url = $base . '/search?' . http_build_query(array(
            'q' => $query,
            'format' => 'json',
            'language' => 'zh-CN',
            'safesearch' => 0,
        ));
        $ch = curl_init($url);
        $opts = array(
            CURLOPT_HTTPHEADER => array('Accept: application/json', 'User-Agent: TinyChat/1.0 (SearXNG JSON)'),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 2,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => max(2, (int) ceil($timeoutMs / 1000)),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADER => false,
        );
        $ca = tc_cacert_path();
        if ($ca) $opts[CURLOPT_CAINFO] = $ca;
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($mh, $ch);
        $handles[$i] = array('ch' => $ch, 'base' => $base);
    }
    $running = null;
    do {
        $stat = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 0.4);
    } while ($running && $stat === CURLM_OK);
    $ms = tc_now() - $started;
    $out = array();
    foreach ($handles as $h) {
        $ch = $h['ch'];
        $raw = curl_multi_getcontent($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
        $hits = array();
        $error = '';
        if ($raw === false || $raw === null || $err || $status === 0) {
            $error = $err ?: '连接失败或超时';
        } elseif ($status >= 400) {
            $error = tc_upstream_error_message((string) $raw, $status);
        } else {
            $j = json_decode($raw, true);
            $rows = (is_array($j) && isset($j['results']) && is_array($j['results'])) ? $j['results'] : array();
            $hits = tc_normalize_search_hits($rows, $max);
            if (!$hits) $error = '没有返回可用结果';
        }
        $sample = array();
        foreach (array_slice($hits, 0, 2) as $hit) $sample[] = array('title' => $hit['title'], 'url' => $hit['url']);
        $out[] = array(
            'ok' => count($hits) > 0,
            'provider' => 'searxng',
            'url' => $h['base'],
            'ms' => $ms,
            'count' => count($hits),
            'error' => $error,
            'sample' => $sample,
        );
    }
    curl_multi_close($mh);
    usort($out, function ($a, $b) {
        if ($a['ok'] === $b['ok']) return $a['ms'] - $b['ms'];
        return $a['ok'] ? -1 : 1;
    });
    return $out;
}

function tc_probe_search_endpoint($provider, $query, $key, $url, $max, $timeoutMs = 8000) {
    $started = tc_now();
    if ($provider === 'searxng') {
        $found = tc_search_searxng($url, $query, $max, $timeoutMs);
    } else {
        $found = tc_search_tavily($key, $query, $max, $timeoutMs);
    }
    $ms = tc_now() - $started;
    $hits = (!empty($found['ok']) && isset($found['hits']) && is_array($found['hits'])) ? $found['hits'] : array();
    $sample = array();
    foreach (array_slice($hits, 0, 3) as $h) {
        $sample[] = array('title' => $h['title'], 'url' => $h['url']);
    }
    return array(
        'ok' => !empty($found['ok']) && count($hits) > 0,
        'provider' => $provider,
        'url' => $provider === 'searxng' ? rtrim((string) $url, '/') : 'https://api.tavily.com',
        'ms' => $ms,
        'count' => count($hits),
        'error' => !empty($found['ok']) ? (count($hits) ? '' : '没有返回可用结果') : (isset($found['error']) ? (string) $found['error'] : '搜索失败'),
        'sample' => $sample,
    );
}

function tc_api_admin_test_search() {
    $ctx = tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $provider = strtolower(trim((string) (isset($b['provider']) ? $b['provider'] : 'tavily')));
        if ($provider !== 'searxng') $provider = 'tavily';
        $query = tc_plain_text(isset($b['query']) ? $b['query'] : 'openai', 120);
        if ($query === '') $query = 'openai';
        $max = isset($b['max']) ? (int) $b['max'] : 3;
        $max = min(5, max(1, $max ?: 3));
        $scan = !empty($b['scan']);
        $key = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        if ($key === '' || strpos($key, '••') !== false) {
            $key = isset($db['settings']['webSearchTavilyKey']) ? (string) $db['settings']['webSearchTavilyKey'] : '';
        }
        $url = trim((string) (isset($b['url']) ? $b['url'] : ''));
        if ($url === '') $url = isset($db['settings']['webSearchSearxUrl']) ? (string) $db['settings']['webSearchSearxUrl'] : '';
        $url = tc_searx_urls_text($url);
        return array(
            'provider' => $provider,
            'query' => $query,
            'max' => $max,
            'scan' => $scan,
            'key' => $key,
            'url' => $url,
        );
    });
    if ($ctx['provider'] === 'tavily') {
        if ($ctx['key'] === '') tc_fail(400, '请先填写 Tavily API Key');
        tc_json(200, array('result' => tc_probe_search_endpoint('tavily', $ctx['query'], $ctx['key'], '', $ctx['max'])));
    }
    if (!$ctx['scan']) {
        $mine = tc_searx_url_list($ctx['url']);
        if (!$mine) tc_fail(400, '请先填写 SearXNG 地址');
        $results = array();
        foreach ($mine as $u) $results[] = tc_probe_search_endpoint('searxng', $ctx['query'], '', $u, $ctx['max']);
        tc_json(200, array('query' => $ctx['query'], 'results' => $results));
    }
    $urls = array();
    $seen = array();
    $candidates = array_merge(tc_searx_url_list($ctx['url']), tc_public_searx_instances());
    foreach ($candidates as $u) {
        $u = rtrim(trim((string) $u), '/');
        if ($u === '' || !preg_match('#^https://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $urls[] = $u;
    }
    @set_time_limit(40);
    $results = array();
    foreach (array_chunk($urls, 24) as $chunk) {
        foreach (tc_probe_searx_many($chunk, $ctx['query'], $ctx['max'], 5000) as $row) $results[] = $row;
    }
    usort($results, function ($a, $b) {
        if ($a['ok'] === $b['ok']) return $a['ms'] - $b['ms'];
        return $a['ok'] ? -1 : 1;
    });
    tc_json(200, array(
        'query' => $ctx['query'],
        'total' => count($urls),
        'results' => $results,
    ));
}

function tc_model_reply_text($data, $format) {
    if (!is_array($data)) return '';
    if ($format === 'anthropic') {
        $parts = array();
        if (isset($data['content']) && is_array($data['content'])) {
            foreach ($data['content'] as $p) {
                if (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
            }
        }
        return tc_plain_text(implode("\n", $parts), 240);
    }
    if ($format === 'responses') {
        if (isset($data['output_text'])) return tc_plain_text($data['output_text'], 240);
        $parts = array();
        if (isset($data['output']) && is_array($data['output'])) {
            foreach ($data['output'] as $o) {
                if (!is_array($o) || !isset($o['content']) || !is_array($o['content'])) continue;
                foreach ($o['content'] as $c) {
                    if (is_array($c) && isset($c['text'])) $parts[] = $c['text'];
                }
            }
        }
        return tc_plain_text(implode("\n", $parts), 240);
    }
    if ($format === 'completions') {
        return tc_plain_text(isset($data['choices'][0]['text']) ? $data['choices'][0]['text'] : '', 240);
    }
    $choice = isset($data['choices'][0]) ? $data['choices'][0] : array();
    $msg = isset($choice['message']) ? $choice['message'] : array();
    $content = isset($msg['content']) ? $msg['content'] : (isset($choice['text']) ? $choice['text'] : '');
    if (is_array($content)) {
        $parts = array();
        foreach ($content as $p) {
            if (is_string($p)) $parts[] = $p;
            elseif (is_array($p) && isset($p['text'])) $parts[] = $p['text'];
        }
        $content = implode("\n", $parts);
    }
    return tc_plain_text($content, 240);
}

function tc_api_admin_test_model() {
    $ctx = tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $baseUrl = rtrim(trim((string) (isset($b['baseUrl']) ? $b['baseUrl'] : '')), '/');
        $format = (isset($b['apiFormat']) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true))
            ? $b['apiFormat'] : 'chat';
        $model = trim((string) (isset($b['model']) ? $b['model'] : ''));
        $prompt = tc_plain_text(isset($b['prompt']) ? $b['prompt'] : '回复一个字：好', 400);
        if ($prompt === '') $prompt = '回复一个字：好';
        if ($baseUrl === '') tc_fail(400, '请先填写 Base URL');
        if ($model === '') tc_fail(400, '请选择要测试的模型');
        if (!preg_match('/^https?:\/\//i', $baseUrl)) tc_fail(400, 'Base URL 需以 http:// 或 https:// 开头');
        $apiKey = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        if (($apiKey === '' || strpos($apiKey, '••') !== false) && !empty($b['providerId'])) {
            foreach ($db['providers'] as $p) {
                if ($p['id'] === (string) $b['providerId']) {
                    $apiKey = tc_provider_key($p);
                    break;
                }
            }
        }
        if ($apiKey === '') tc_fail(400, '请先填写 API Key');
        return array(
            'baseUrl' => $baseUrl,
            'format' => $format,
            'model' => substr($model, 0, 120),
            'prompt' => $prompt,
            'apiKey' => $apiKey,
        );
    });
    $body = array('model' => $ctx['model'], 'stream' => false);
    if ($ctx['format'] === 'anthropic') {
        $body['max_tokens'] = 64;
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
    } elseif ($ctx['format'] === 'responses') {
        $body['input'] = $ctx['prompt'];
        $body['max_output_tokens'] = 64;
    } elseif ($ctx['format'] === 'completions') {
        $body['prompt'] = $ctx['prompt'];
        $body['max_tokens'] = 64;
    } else {
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
        $body['max_tokens'] = 64;
    }
    $url = tc_upstream_path($ctx['baseUrl'], $ctx['format']);
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($ctx['format'] === 'anthropic') {
        $headers['x-api-key'] = $ctx['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $ctx['apiKey'];
    }
    $started = tc_now();
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), 25000, false);
    $ms = tc_now() - $started;
    if (!$res['ok']) {
        tc_json(200, array('result' => array(
            'ok' => false,
            'model' => $ctx['model'],
            'ms' => $ms,
            'error' => tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : ''),
        )));
    }
    if ($res['status'] >= 400) {
        tc_json(200, array('result' => array(
            'ok' => false,
            'model' => $ctx['model'],
            'ms' => $ms,
            'status' => $res['status'],
            'error' => tc_upstream_error_message($res['body'], $res['status']),
        )));
    }
    $j = json_decode($res['body'], true);
    $reply = tc_model_reply_text($j, $ctx['format']);
    tc_json(200, array('result' => array(
        'ok' => $reply !== '',
        'model' => $ctx['model'],
        'ms' => $ms,
        'reply' => $reply,
        'error' => $reply === '' ? '上游已响应，但没有读到文本回复' : '',
    )));
}

function tc_model_test_safe_error($message, $apiKey) {
    $message = (string) $message;
    $apiKey = (string) $apiKey;
    if ($apiKey !== '') $message = str_replace($apiKey, '[已隐藏]', $message);
    return substr($message, 0, 200);
}

function tc_api_user_test_model() {
    $ctx = tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body(65536);
        $providerId = trim((string) (isset($b['providerId']) ? $b['providerId'] : ''));
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 120);
        $prompt = tc_plain_text(isset($b['prompt']) ? $b['prompt'] : '回复一个字：好', 400);
        if ($providerId === '') tc_fail(400, '请选择要测试的个人供应商');
        if ($model === '') tc_fail(400, '请选择要测试的模型');
        if ($prompt === '') $prompt = '回复一个字：好';

        $provider = null;
        foreach ($db['providers'] as $p) {
            if ($p['id'] === $providerId && isset($p['ownerId']) && $p['ownerId'] === $user['id'] && (!isset($p['scope']) || $p['scope'] === 'user')) {
                $provider = $p;
                break;
            }
        }
        if (!$provider) tc_fail(403, '只能测试自己添加的供应商');
        $found = false;
        foreach ((isset($provider['models']) ? $provider['models'] : array()) as $m) {
            if (is_array($m) && isset($m['id']) && $m['id'] === $model) { $found = true; break; }
        }
        if (!$found) tc_fail(403, '该模型不在供应商的已保存模型列表中');
        $apiKey = trim((string) tc_provider_key($provider));
        if ($apiKey === '') tc_fail(400, '该供应商没有可用的 API Key');
        return array(
            'user' => $user,
            'provider' => $provider,
            'format' => (isset($provider['apiFormat']) && in_array($provider['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true)) ? $provider['apiFormat'] : 'chat',
            'model' => $model,
            'prompt' => $prompt,
            'apiKey' => $apiKey,
        );
    });

    $format = $ctx['format'];
    $body = array('model' => $ctx['model'], 'stream' => false);
    if ($format === 'anthropic') {
        $body['max_tokens'] = 64;
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
    } elseif ($format === 'responses') {
        $body['input'] = $ctx['prompt'];
        $body['max_output_tokens'] = 64;
    } elseif ($format === 'completions') {
        $body['prompt'] = $ctx['prompt'];
        $body['max_tokens'] = 64;
    } else {
        $body['messages'] = array(array('role' => 'user', 'content' => $ctx['prompt']));
        $body['max_tokens'] = 64;
    }

    $baseUrl = rtrim(trim((string) (isset($ctx['provider']['baseUrl']) ? $ctx['provider']['baseUrl'] : '')), '/');
    if (!preg_match('/^https?:\/\//i', $baseUrl)) tc_fail(400, '供应商 Base URL 无效');
    $url = tc_upstream_path($baseUrl, $format);
    $headers = array('Content-Type' => 'application/json', 'Accept' => 'application/json');
    if ($format === 'anthropic') {
        $headers['x-api-key'] = $ctx['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $ctx['apiKey'];
    }

    $started = tc_now();
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), 25000, false);
    $ms = tc_now() - $started;
    $provider = $ctx['provider'];
    $baseLog = array(
        'kind' => 'model-test',
        'userName' => isset($ctx['user']['name']) ? $ctx['user']['name'] : '',
        'userId' => isset($ctx['user']['id']) ? $ctx['user']['id'] : '',
        'provider' => isset($provider['name']) ? $provider['name'] : '',
        'providerId' => isset($provider['id']) ? $provider['id'] : '',
        'model' => $ctx['model'],
        'format' => $format,
        'ms' => $ms,
        'cost' => 0,
    );
    if (!$res['ok']) {
        $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
        $safeMsg = tc_model_test_safe_error($msg, $ctx['apiKey']);
        $baseLog['status'] = 0;
        $baseLog['ok'] = false;
        $baseLog['error'] = $safeMsg;
        tc_push_log($baseLog);
        tc_fail($res['code'] === 504 ? 504 : 502, $safeMsg);
    }
    if ($res['status'] >= 400) {
        $msg = tc_upstream_error_message($res['body'], $res['status']);
        $safeMsg = tc_model_test_safe_error($msg, $ctx['apiKey']);
        $baseLog['status'] = $res['status'];
        $baseLog['ok'] = false;
        $baseLog['error'] = $safeMsg;
        tc_push_log($baseLog);
        tc_fail($res['status'] >= 500 ? 502 : 400, $safeMsg);
    }

    $j = json_decode($res['body'], true);
    $reply = tc_model_reply_text($j, $format);
    $ok = $reply !== '';
    $baseLog['status'] = $res['status'] ?: 200;
    $baseLog['ok'] = $ok;
    if (!$ok) $baseLog['error'] = '上游已响应，但没有读到文本回复';
    tc_push_log($baseLog);
    tc_json(200, array('result' => array(
        'ok' => $ok,
        'model' => $ctx['model'],
        'ms' => $ms,
        'reply' => $reply,
        'error' => $ok ? '' : '上游已响应，但没有读到文本回复',
    )));
}

function tc_api_fetch_models() {
    $started = tc_now();
    $ctx = tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $baseUrl = rtrim(trim((string) (isset($b['baseUrl']) ? $b['baseUrl'] : '')), '/');
        $format = (isset($b['apiFormat']) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true))
            ? $b['apiFormat'] : 'chat';
        if ($baseUrl === '') tc_fail(400, '请先填写 Base URL');
        if ($format === 'anthropic') tc_fail(400, 'Anthropic 不支持自动获取模型，请手动填写模型列表');
        $apiKey = trim((string) (isset($b['apiKey']) ? $b['apiKey'] : ''));
        if (($apiKey === '' || strpos($apiKey, '••') !== false) && !empty($b['providerId'])) {
            foreach ($db['providers'] as $p) {
                if ($p['id'] === (string) $b['providerId'] && ((isset($p['ownerId']) && $p['ownerId'] === $user['id']) || !empty($user['admin']))) {
                    $apiKey = tc_provider_key($p);
                    break;
                }
            }
        }
        if ($apiKey === '') tc_fail(400, '请先填写 API Key');
        $url = tc_api_url($baseUrl, '/models');
        return array('url' => $url, 'apiKey' => $apiKey);
    });
    $res = tc_http_request($ctx['url'], 'GET', array(
        'Authorization' => 'Bearer ' . $ctx['apiKey'],
        'Accept' => 'application/json',
    ), null, 20000, false);
    if (!$res['ok']) {
        tc_fail($res['code'] === 504 ? 504 : 502, tc_upstream_fail_message($res));
    }
    if ($res['status'] >= 400) tc_fail(400, tc_upstream_error_message($res['body'], $res['status']));
    $j = json_decode($res['body'], true);
    if (!is_array($j)) tc_fail(400, '无法解析模型列表响应');
    $arr = array();
    if (isset($j['data']) && is_array($j['data'])) $arr = $j['data'];
    elseif (isset($j['models']) && is_array($j['models'])) $arr = $j['models'];
    $mapped = array();
    foreach ($arr as $m) {
        if (!is_array($m)) continue;
        $mapped[] = array('id' => isset($m['id']) ? $m['id'] : (isset($m['name']) ? $m['name'] : ''), 'name' => isset($m['name']) ? $m['name'] : (isset($m['id']) ? $m['id'] : ''));
    }
    unset($started);
    tc_json(200, array('models' => tc_normalize_models($mapped)));
}

// 计费结算:billingMode=call 按次;=token 按 (prompt+completion)/1000 × pricePer1k。
// 按 token 时若上游未返回用量(如部分流式),回退按次计费,避免漏计
function tc_final_cost($provider, $baseCost, $usage) {
    $mode = isset($provider['billingMode']) ? $provider['billingMode'] : 'call';
    if ($mode !== 'token') return $baseCost;
    $price = isset($provider['pricePer1k']) ? (float) $provider['pricePer1k'] : 0;
    if ($price <= 0) return 0;
    $prompt = isset($usage['prompt']) ? (int) $usage['prompt'] : 0;
    $completion = isset($usage['completion']) ? (int) $usage['completion'] : 0;
    if ($prompt <= 0 && $completion <= 0) return $baseCost;
    return round(($prompt + $completion) / 1000 * $price, 4);
}

// 流式按 token 计费结算:首字节时刻用量未知,已按次预扣;流结束按实际用量多退少补。
// 返回最终扣费额(供台账);无限额度与按次模式是 no-op(delta=0)。
function tc_settle_stream_charge(&$db, $userId, $provider, $baseCost, $charged, $usage) {
    $trueCost = tc_final_cost($provider, $baseCost, $usage);
    $delta = round($trueCost - (float) $charged, 4);
    if (abs($delta) < 0.0001) return $trueCost;
    $fresh = null;
    foreach ($db['users'] as &$u) {
        if (isset($u['id']) && (string) $u['id'] === (string) $userId) { $fresh = &$u; break; }
    }
    unset($u);
    if (!$fresh) return $charged;
    if (tc_is_unlimited_quota($fresh)) return 0;
    if ($delta > 0) {
        $fresh['quota'] = max(0, round((float) $fresh['quota'] - $delta, 4));
    } else {
        // 预扣高于实际用量:返还差额(只动余额,不动发放统计)
        $fresh['quota'] = round((float) $fresh['quota'] + (-$delta), 4);
    }
    $GLOBALS['_tc_quota_after'] = $fresh['quota'];
    return $trueCost;
}

function tc_api_proxy($format, $apiKeyOwner = null) {
    $started = tc_now();
    $ctx = tc_with_db(false, function ($db) use ($format, $apiKeyOwner) {
        if ($apiKeyOwner !== null) {
            // OpenAI 兼容出口:密钥已在外层验证,取最新用户记录
            $user = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === (string) $apiKeyOwner['userId']) { $user = $u; break; }
            }
            if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        } else {
            $user = tc_require_auth($db);
        }
        $rateLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
        if (!tc_rate_limit_check('u:' . $user['id'], $rateLimit)) {
            tc_fail(429, '请求太频繁了，请稍后再试（当前上限 ' . $rateLimit . ' 次/分钟）');
        }
        $b = tc_read_json_body(20 * 1024 * 1024);
        $resolved = tc_resolve_provider($db, $user, $b);
        if (!empty($resolved['error'])) tc_fail(400, $resolved['error']);
        $provider = $resolved['provider'];
        // 开放接口的对外模型白名单:仅对 API 密钥调用生效,网页端不受影响
        if ($apiKeyOwner !== null) {
            $reqModel = isset($b['model']) ? (string) $b['model'] : '';
            if (!tc_api_model_exposed($db['settings'], isset($provider['id']) ? $provider['id'] : '', $reqModel)) {
                tc_fail(403, '模型 ' . $reqModel . ' 未对开放接口开放，请联系管理员');
            }
        }
        // 熔断:该模型近期持续全失败时快速失败,给出清晰提示(管理员豁免,便于现场排查)
        if (empty($user['admin'])) {
            $circuitModel = isset($b['model']) ? (string) $b['model'] : (isset($provider['models'][0]['id']) ? (string) $provider['models'][0]['id'] : '');
            $circuitMsg = tc_model_circuit_message($db, isset($provider['id']) ? $provider['id'] : '', $circuitModel);
            if ($circuitMsg !== '') tc_fail(503, $circuitMsg);
        }
        $cost = tc_provider_cost($provider);
        // 内容审核:开启敏感词过滤时,先检查最后一条用户消息
        $modHit = tc_moderation_hit(isset($db['settings']['moderation']) && is_array($db['settings']['moderation']) ? $db['settings']['moderation'] : array(), tc_last_user_text($b, $format));
        if ($modHit !== '') tc_fail(400, '消息包含被禁止的内容，请修改后重试');
        // 用户自备供应商(自己的 Key):不扣站点次数,也不设额度门槛
        if (isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id']) $cost = 0;
        if (!tc_is_unlimited_quota($user) && (isset($user['quota']) ? (float) $user['quota'] : 0) < $cost) {
            $msg = $cost > 1
                ? '剩余次数不足（本次需要 ' . $cost . ' 次，当前 ' . (isset($user['quota']) ? $user['quota'] : 0) . ' 次），请联系管理员充值'
                : '剩余次数不足（当前 ' . (isset($user['quota']) ? $user['quota'] : 0) . ' 次），请联系管理员充值';
            tc_json(402, array(
                'error' => array('message' => $msg),
                'quota' => isset($user['quota']) ? $user['quota'] : 0,
                'need' => $cost,
            ));
        }
        // 生图模型自动路由:调用对话接口但命中的是生图模型时,改走 images/generations。
        // 上游对这种请求会直接报错(如 "xxx is an image model. Use /v1/images/generations"),
        // 这里在发起对话请求前就分流,用户/客户端无需自己判断模型类型。
        $isImageModel = false;
        if (in_array($format, array('chat', 'completions', 'responses'), true)) {
            $reqModel = isset($b['model']) ? (string) $b['model'] : '';
            if ($reqModel === '' && !empty($provider['models'][0]['id'])) $reqModel = (string) $provider['models'][0]['id'];
            $isImageModel = tc_model_is_image($provider, $reqModel);
        }
        return array(
            'user' => $user,
            'provider' => $provider,
            'body' => tc_prepare_upstream_body($b, $provider, $format),
            'cost' => $cost,
            'timeout' => $db['settings']['proxyTimeoutMs'],
            'wantSearch' => (!empty($b['webSearch']) && $b['webSearch'] !== 'off' && $b['webSearch'] !== false) ? (string) $b['webSearch'] : '',
            'settings' => tc_user_search_settings($user, $db['settings']),
            'maxOutputTokens' => isset($db['settings']['maxOutputTokens']) ? (int) $db['settings']['maxOutputTokens'] : 8192,
            'temperature' => isset($db['settings']['temperature']) ? $db['settings']['temperature'] : null,
            'thinking' => tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null),
            'imageGen' => $isImageModel,
        );
    });

    // 生图模型自动改走生图接口(tc_generate_images 自带鉴权/限流/额度/审核与计费)
    if (!empty($ctx['imageGen'])) {
        if ($apiKeyOwner !== null) {
            $out = tc_generate_images($apiKeyOwner);
            $data = array();
            foreach ((isset($out['images']) ? $out['images'] : array()) as $im) {
                $row = array();
                if (!empty($im['url'])) $row['url'] = $im['url'];
                elseif (!empty($im['b64_json'])) $row['b64_json'] = $im['b64_json'];
                if (isset($im['revised_prompt'])) $row['revised_prompt'] = $im['revised_prompt'];
                if ($row) $data[] = $row;
            }
            tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
        }
        tc_json(200, tc_generate_images(null));
    }

    $provider = $ctx['provider'];
    $user = $ctx['user'];
    $body = $ctx['body'];
    $cost = $ctx['cost'];
    $citations = array();
    $searchMode = isset($ctx['wantSearch']) ? (string) $ctx['wantSearch'] : '';
    if ($searchMode === '1' || $searchMode === 'true') $searchMode = 'on';
    if ($searchMode === 'on' || $searchMode === 'auto') {
        $query = tc_web_search_query_from_body($body, $format);
        if ($searchMode === 'auto') {
            $judgeModel = isset($body['model']) ? $body['model'] : '';
            try {
                if (!tc_search_needs_web($query, $provider, $format, $judgeModel)) $query = '';
            } catch (Throwable $e) {
            }
        }
        $found = $query === '' ? array('ok' => true, 'hits' => array()) : tc_run_web_search($ctx['settings'], $query);
        if (empty($found['ok'])) {
            if ($searchMode !== 'auto') {
                $err = isset($found['error']) ? $found['error'] : '联网搜索失败';
                tc_fail(502, '联网搜索失败: ' . $err);
            }
            $found = array('ok' => true, 'hits' => array());
        }
        $citations = isset($found['hits']) ? $found['hits'] : array();
        if ($citations) {
            @set_time_limit(90);
            tc_enrich_search_pages($citations);
            tc_append_system_text($body, $format, tc_format_search_context($citations));
            foreach ($citations as &$hit) unset($hit['page']);
            unset($hit);
        }
    }
    // 链接读取:用户消息里带网址时自动抓取正文作为回答材料(独立于联网搜索开关)
    if (empty($ctx['settings']['urlReadEnabled']) === false) {
        $readUrls = tc_urls_from_last_user_message($body, $format);
        if ($readUrls && $citations) {
            // 搜索管线已打开过的链接不重复读取
            $seenUrls = array();
            foreach ($citations as $h) if (!empty($h['url'])) $seenUrls[strtolower((string) $h['url'])] = true;
            $readUrls = array_values(array_filter($readUrls, function ($u) use ($seenUrls) { return !isset($seenUrls[strtolower($u)]); }));
        }
        if ($readUrls) {
            @set_time_limit(90);
            $readHits = tc_read_urls_to_citations($readUrls, $ctx['settings']);
            if ($readHits) {
                tc_append_system_text($body, $format, tc_format_url_read_context($readHits, count($citations)));
                foreach ($readHits as $hit) { unset($hit['page']); $citations[] = $hit; }
            }
        }
    }
    // 模型级 max_tokens / 最大上下文优先于全局输出上限;未配置时沿用全局钳制。
    // 配置了最大上下文时,先粗估输入 token,输出上限压到「窗口 − 预估输入」内,避免总量超窗
    $modelMaxTokens = 0;
    $modelMaxContext = 0;
    $reqModel = isset($body['model']) ? (string) $body['model'] : '';
    foreach ((isset($provider['models']) ? $provider['models'] : array()) as $m) {
        if (!is_array($m) || !isset($m['id']) || (string) $m['id'] !== $reqModel) continue;
        if (!empty($m['maxTokens'])) $modelMaxTokens = (int) $m['maxTokens'];
        if (!empty($m['maxContext'])) $modelMaxContext = (int) $m['maxContext'];
        break;
    }
    $outCap = $modelMaxTokens > 0 ? $modelMaxTokens : (isset($ctx['maxOutputTokens']) ? (int) $ctx['maxOutputTokens'] : 8192);
    if ($modelMaxContext > 0) {
        $promptEst = tc_estimate_body_tokens($body);
        $outCap = min($outCap, max(256, $modelMaxContext - $promptEst));
    }
    tc_clamp_output_tokens($body, $format, $outCap, $modelMaxTokens > 0 || $modelMaxContext > 0);
    tc_apply_temperature($body, $format, isset($ctx['temperature']) ? $ctx['temperature'] : null);
    tc_apply_thinking_rules($body, isset($ctx['thinking']) ? $ctx['thinking'] : null);
    $url = tc_upstream_path(rtrim((string) $provider['baseUrl'], '/'), $format);
    $isStream = !empty($body['stream']);
    $headers = array(
        'Content-Type' => 'application/json',
        'Accept' => 'text/event-stream, application/json',
    );
    if ($format === 'anthropic') {
        $headers['x-api-key'] = $provider['apiKey'];
        $headers['anthropic-version'] = '2023-06-01';
    } else {
        $headers['Authorization'] = 'Bearer ' . $provider['apiKey'];
    }
    $payload = tc_json_encode($body);
    $reasoningRetried = false;
    $ends = tc_endpoints();
    $ep = isset($ends[$format]) ? $ends[$format] : $format;

    if ($isStream) {
        @ignore_user_abort(true);
        @set_time_limit(0);
        $taskId = tc_uid(12);
        tc_task_create($taskId, $user['id'], array('provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '', 'format' => $format));
        header('X-Oc-Task-Id: ' . $taskId);
        header('X-Oc-Task-Format: ' . $format);
        @ini_set('default_socket_timeout', '600');
        $errorBuf = '';
        $headersSent = false;
        $charged = 0;
        $streamUsage = array('prompt' => 0, 'completion' => 0);
        // 429/5xx 一次自动重试:错误响应不会进入 onChunk(未计费未发送),重试安全
        $attempt = 0;
        do {
            $attempt++;
            $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], true, function ($chunk) use (&$errorBuf, &$headersSent, &$charged, $user, $provider, $body, $cost, $started, $format, $isStream, $citations, $taskId, &$streamUsage) {
            tc_capture_stream_usage($streamUsage, $chunk, $format);
            if (!$headersSent) {
                // First successful bytes: charge then start SSE.
                $ms = tc_now() - $started;
                $charged = 0;
                tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage) {
                    $fresh = null;
                    foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
                    if (!$fresh) return;
                    $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $cost, $streamUsage), isset($body['model']) ? $body['model'] : '');
                    tc_touch_user($db, $user['id']);
                    $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
                });
                tc_push_log(array(
                    'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                    'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                    'format' => $format, 'status' => 200, 'ms' => $ms, 'cost' => $charged, 'stream' => $isStream,
                ));
                tc_note_model_health($provider, $body, true);
                tc_disable_buffers();
                header('Content-Type: text/event-stream; charset=utf-8');
                header('Cache-Control: no-cache, no-transform');
                header('Connection: keep-alive');
                header('X-Oc-Cost: ' . $charged);
                header('X-Oc-Quota: ' . (isset($GLOBALS['_tc_quota_after']) ? $GLOBALS['_tc_quota_after'] : 0));
                header('X-Oc-Elapsed: ' . $ms);
                header('X-Oc-Task-Id: ' . $taskId);
        header('X-Oc-Task-Format: ' . $format);
                if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
                $headersSent = true;
            }
            tc_task_append($taskId, $chunk);
            echo $chunk;
            if (function_exists('ob_flush')) @ob_flush();
            flush();
        });
            if (!( !empty($res['ok']) && !empty($res['status']) && in_array((int) $res['status'], array(429, 500, 502, 503, 504), true) && $attempt < 2 )) break;
            sleep(1);
        } while (true);

        // 流结束:按实际用量与首字节预扣额多退少补,并把最终费用写入台账
        if ($headersSent) {
            $modelStr = isset($body['model']) ? $body['model'] : '';
            tc_with_db(true, function (&$db) use ($user, $modelStr, $provider, $cost, &$charged, $streamUsage) {
                $final = tc_settle_stream_charge($db, $user['id'], $provider, $cost, $charged, $streamUsage);
                tc_record_usage_entry($db, $user['id'], $modelStr, $final, $streamUsage['prompt'], $streamUsage['completion']);
            });
        }

        if (!$res['ok']) {
            tc_task_finish($taskId, 'failed', $res['error'] ?? 'upstream_error');
            $ms = tc_now() - $started;
            $code = $res['code'] ?: 502;
            $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
            tc_push_log(array(
                'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                'format' => $format, 'status' => 0, 'ms' => $ms, 'cost' => 0, 'stream' => $isStream, 'error' => $msg,
            ));
            tc_note_model_health($provider, $body, false);
            if (!$headersSent) tc_fail($code, $msg);
            exit;
        }
        if (!empty($res['status']) && $res['status'] >= 400) {
            $errBody = isset($res['body']) ? $res['body'] : '';
            tc_context_learn($provider, $body, $errBody);
            $unsupported = tc_unsupported_param_names($errBody);
            $learnLevels = null;
            $effortRemapped = false;
            $reasoningStripped = false;
            if (!$reasoningRetried) {
                $effortRemapped = tc_effort_remap_from_error($body, $errBody, $learnLevels);
                if (!$effortRemapped && $unsupported) $reasoningStripped = tc_strip_reasoning_params($body, $unsupported);
                if ($effortRemapped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', $learnLevels, false);
                elseif ($reasoningStripped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', array(), true);
            }
            if (!$reasoningRetried && ($effortRemapped || $reasoningStripped)) {
                $reasoningRetried = true;
                tc_task_finish($taskId, 'failed', 'retry_without_reasoning');
                $payload = tc_json_encode($body);
                $taskId = tc_uid(12);
                tc_task_create($taskId, $user['id'], array('provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '', 'format' => $format));
                header('X-Oc-Task-Id: ' . $taskId);
                $errorBuf = '';
                $headersSent = false;
                $charged = 0;
                $streamUsage = array('prompt' => 0, 'completion' => 0);
                $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], true, function ($chunk) use (&$errorBuf, &$headersSent, &$charged, $user, $provider, $body, $cost, $started, $format, $isStream, $citations, $taskId, &$streamUsage) {
                    tc_capture_stream_usage($streamUsage, $chunk, $format);
                    if (!$headersSent) {
                        $ms = tc_now() - $started;
                        $charged = 0;
                        tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage) {
                            $fresh = null;
                            foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
                            if (!$fresh) return;
                            $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $cost, $streamUsage), isset($body['model']) ? $body['model'] : '');
                            tc_touch_user($db, $user['id']);
                            $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
                        });
                        tc_push_log(array(
                            'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                            'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                            'format' => $format, 'status' => 200, 'ms' => $ms, 'cost' => $charged, 'stream' => $isStream,
                        ));
                        tc_note_model_health($provider, $body, true);
                        tc_disable_buffers();
                        header('Content-Type: text/event-stream; charset=utf-8');
                        header('Cache-Control: no-cache, no-transform');
                        header('Connection: keep-alive');
                        header('X-Oc-Cost: ' . $charged);
                        header('X-Oc-Quota: ' . (isset($GLOBALS['_tc_quota_after']) ? $GLOBALS['_tc_quota_after'] : 0));
                        header('X-Oc-Elapsed: ' . $ms);
                        header('X-Oc-Task-Id: ' . $taskId);
                        header('X-Oc-Task-Format: ' . $format);
                        if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
                        $headersSent = true;
                    }
                    tc_task_append($taskId, $chunk);
                    echo $chunk;
                    if (function_exists('ob_flush')) @ob_flush();
                    flush();
                });
                if (!empty($res['ok']) && (empty($res['status']) || $res['status'] < 400)) {
                    if (!$headersSent) {
                        tc_task_finish($taskId, 'completed');
                        $ms = tc_now() - $started;
                        $charged = 0;
                        tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage) {
                            $fresh = null;
                            foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
                            if (!$fresh) return;
                            $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $cost, $streamUsage), isset($body['model']) ? $body['model'] : '');
                            tc_touch_user($db, $user['id']);
                            $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
                            tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $charged, $streamUsage['prompt'], $streamUsage['completion']);
                        });
                        header('Content-Type: text/event-stream; charset=utf-8');
                        header('Cache-Control: no-cache, no-transform');
                        header('X-Oc-Cost: ' . $charged);
                        header('X-Oc-Quota: ' . (isset($GLOBALS['_tc_quota_after']) ? $GLOBALS['_tc_quota_after'] : 0));
                        header('X-Oc-Elapsed: ' . $ms);
                        if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
                        echo "data: [DONE]\n\n";
                    }
                    if ($headersSent) {
                        tc_with_db(true, function (&$db) use ($user, $body, $provider, $cost, &$charged, $streamUsage) {
                            $final = tc_settle_stream_charge($db, $user['id'], $provider, $cost, $charged, $streamUsage);
                            tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $final, $streamUsage['prompt'], $streamUsage['completion']);
                        });
                        tc_task_finish($taskId, 'completed');
                    }
                    exit;
                }
            }
            tc_task_finish($taskId, 'failed', 'upstream_http_' . $res['status']);
            $ms = tc_now() - $started;
            $msg = (isset($provider['name']) && $provider['name'] !== '' ? '「' . $provider['name'] . '」' : '') . tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', $res['status']);
            tc_push_log(array(
                'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
                'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => 0, 'stream' => $isStream,
                'error' => substr($msg, 0, 200),
            ));
            tc_note_model_health($provider, $body, false);
            if (!$headersSent) tc_fail($res['status'], $msg);
            exit;
        }
        if (!$headersSent) {
            tc_task_finish($taskId, 'completed');
            $ms = tc_now() - $started;
            $charged = 0;
            tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, $provider, $streamUsage) {
                $fresh = null;
                foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
                if (!$fresh) return;
                $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $cost, $streamUsage), isset($body['model']) ? $body['model'] : '');
                tc_touch_user($db, $user['id']);
                $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
                tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $cost, $streamUsage['prompt'], $streamUsage['completion']);
            });
            header('Content-Type: text/event-stream; charset=utf-8');
            header('Cache-Control: no-cache, no-transform');
            header('X-Oc-Cost: ' . $charged);
            header('X-Oc-Quota: ' . (isset($GLOBALS['_tc_quota_after']) ? $GLOBALS['_tc_quota_after'] : 0));
            header('X-Oc-Elapsed: ' . $ms);
            if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
            echo "data: [DONE]\n\n";
        }
        if ($headersSent) tc_task_finish($taskId, 'completed');
        exit;
    }

    // 429/5xx 一次自动重试(非流式):响应未返回给客户端前,重试安全
    $attempt = 0;
    do {
        $attempt++;
        $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], false);
        if (!( !empty($res['ok']) && !empty($res['status']) && in_array((int) $res['status'], array(429, 500, 502, 503, 504), true) && $attempt < 2 )) break;
        sleep(1);
    } while (true);
    if (!empty($res['ok']) && !empty($res['status']) && $res['status'] >= 400) {
        $errBody = isset($res['body']) ? $res['body'] : '';
        tc_context_learn($provider, $body, $errBody);
        $unsupported = tc_unsupported_param_names($errBody);
        $learnLevels = null;
        $effortRemapped = tc_effort_remap_from_error($body, $errBody, $learnLevels);
        $reasoningStripped = false;
        if (!$effortRemapped && $unsupported) $reasoningStripped = tc_strip_reasoning_params($body, $unsupported);
        if ($effortRemapped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', $learnLevels, false);
        elseif ($reasoningStripped) tc_thinking_learn(isset($body['model']) ? $body['model'] : '', array(), true);
        if ($effortRemapped || $reasoningStripped) {
            $payload = tc_json_encode($body);
            $res = tc_http_request($url, 'POST', $headers, $payload, $ctx['timeout'], false);
        }
    }
    $ms = tc_now() - $started;
    if (!$res['ok']) {
        $code = $res['code'] ?: 502;
        $msg = tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : '');
        tc_push_log(array(
            'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
            'format' => $format, 'status' => 0, 'ms' => $ms, 'cost' => 0, 'stream' => false, 'error' => $msg,
        ));
        tc_note_model_health($provider, $body, false);
        tc_fail($code, $msg);
    }
    if ($res['status'] >= 400) {
        $msg = (isset($provider['name']) && $provider['name'] !== '' ? '「' . $provider['name'] . '」' : '') . tc_upstream_error_message($res['body'], $res['status']);
        tc_push_log(array(
            'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
            'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => 0, 'stream' => false,
            'error' => substr($msg, 0, 200),
        ));
        tc_note_model_health($provider, $body, false);
        tc_fail($res['status'], $msg);
    }

    $charged = 0;
    $quota = 0;
    $bodyUsage = array('prompt' => 0, 'completion' => 0);
    $jBody = json_decode(isset($res['body']) ? $res['body'] : '', true);
    if (is_array($jBody) && isset($jBody['usage']) && is_array($jBody['usage'])) {
        $u = $jBody['usage'];
        $bodyUsage['prompt'] = (int) (isset($u['prompt_tokens']) ? $u['prompt_tokens'] : (isset($u['input_tokens']) ? $u['input_tokens'] : 0));
        $bodyUsage['completion'] = (int) (isset($u['completion_tokens']) ? $u['completion_tokens'] : (isset($u['output_tokens']) ? $u['output_tokens'] : 0));
    }
    tc_with_db(true, function (&$db) use ($user, $cost, $body, &$charged, &$quota, $bodyUsage, $provider) {
        $fresh = null;
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        if (!$fresh) return;
        $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $cost, $bodyUsage), isset($body['model']) ? $body['model'] : '');
        tc_touch_user($db, $user['id']);
        $quota = isset($fresh['quota']) ? $fresh['quota'] : 0;
        tc_record_usage_entry($db, $user['id'], isset($body['model']) ? $body['model'] : '', $charged, $bodyUsage['prompt'], $bodyUsage['completion']);
    });
    tc_push_log(array(
        'kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'],
        'provider' => $provider['name'], 'model' => isset($body['model']) ? $body['model'] : '',
        'format' => $format, 'status' => $res['status'], 'ms' => $ms, 'cost' => $charged, 'stream' => false,
    ));
    tc_note_model_health($provider, $body, true);
    $ctype = $res['ctype'];
    if (strpos($ctype, 'application/json') !== false) $ct = 'application/json; charset=utf-8';
    elseif ($ctype) $ct = $ctype;
    else $ct = 'application/json';
    http_response_code($res['status'] ?: 200);
    header('Content-Type: ' . $ct);
    header('Cache-Control: no-store');
    header('X-Oc-Cost: ' . $charged);
    header('X-Oc-Quota: ' . $quota);
    header('X-Oc-Elapsed: ' . $ms);
    if ($citations) header('X-Oc-Citations: ' . rawurlencode(tc_json_encode($citations)));
    echo $res['body'];
    exit;
}

function tc_note_model_health($provider, $body, $ok) {
    $pid = isset($provider['id']) ? $provider['id'] : '';
    $model = isset($body['model']) ? $body['model'] : '';
    if ($pid === '' || $model === '') return;
    try {
        tc_with_db(true, function (&$db) use ($pid, $model, $ok) {
            tc_record_model_health($db, $pid, $model, $ok);
        });
    } catch (Throwable $e) {
    }
}

// 熔断判定:近 4 小时内该模型调用 ≥5 次且全部失败 → 视为持续不可用。
// 熔断期间快速失败,不再打上游,因此不会再产生失败事件,事件随 4 小时窗口老化后自动恢复
function tc_model_circuit_message($db, $providerId, $model) {
    if ($providerId === '' || $model === '') return '';
    $summary = tc_model_health_summary($db, $providerId);
    $row = isset($summary[$model]) ? $summary[$model] : null;
    if (!$row || (int) $row['calls'] < 5 || (int) $row['ok'] > 0) return '';
    return '模型 ' . $model . ' 当前持续不可用（近 4 小时连续 ' . $row['calls'] . ' 次调用全部失败），请换一个模型或稍后再试';
}

// 从上游报错中提取模型上下文窗口上限
function tc_context_limit_from_error($raw) {
    $text = (string) $raw;
    if ($text === '') return 0;
    $candidates = array();
    // OpenAI: "This model's maximum context length is 8192 tokens"
    if (preg_match('/maximum context length is (\d+)/i', $text, $m)) $candidates[] = (int) $m[1];
    // Anthropic: "... 205063 tokens > 200000 maximum"
    if (preg_match('/(\d{3,})\s*tokens?\s*>\s*(\d{3,})\s*maximum/i', $text, $m)) $candidates[] = (int) $m[2];
    // 通用: context length/window/size 后跟数字(≥4 位,降低误报)
    if (preg_match('/(?:context[_ ](?:length|window|size)|max(?:imum)?[_ ](?:context|tokens?))[^\d]{0,40}(\d{4,})/i', $text, $m)) $candidates[] = (int) $m[1];
    if (!$candidates) return 0;
    $limit = max($candidates);
    if ($limit < 256) return 0;
    return min(2000000, $limit);
}

// 自动学习上下文窗口:仅当管理员开启且该模型尚未配置 maxContext 时回填,不覆盖手动设置
function tc_context_learn($provider, $body, $errBody) {
    $model = isset($body['model']) ? (string) $body['model'] : '';
    $pid = isset($provider['id']) ? $provider['id'] : '';
    if ($model === '' || $pid === '' || (string) $errBody === '') return;
    $limit = tc_context_limit_from_error($errBody);
    if ($limit <= 0) return;
    try {
        tc_with_db(true, function (&$db) use ($pid, $model, $limit) {
            if (empty($db['settings']['contextAutoLearn'])) return;
            foreach ($db['providers'] as $pi => $p) {
                if (!isset($p['id']) || $p['id'] !== $pid || empty($p['models']) || !is_array($p['models'])) continue;
                foreach ($p['models'] as $mi => $m) {
                    if (!is_array($m) || !isset($m['id']) || (string) $m['id'] !== $model) continue;
                    if (empty($m['maxContext'])) $db['providers'][$pi]['models'][$mi]['maxContext'] = $limit;
                    return;
                }
                return;
            }
        });
    } catch (Throwable $e) {
    }
}

// ---- OpenAI 兼容出口:Bearer sk-tc- 密钥鉴权,计费/限流/熔断与网页端完全一致 ----
function tc_v1_authenticate() {
    $auth = tc_with_db(true, function (&$db) {
        if (empty($db['settings']['apiKeysEnabled'])) tc_fail(403, '管理员已关闭 API 密钥功能');
        $token = tc_bearer();
        $owner = tc_find_api_key_owner($db, $token);
        if (!$owner) tc_fail(401, '无效的 API 密钥');
        // 开放接口限流:按"密钥"独立计数(与网页端按用户计数互不影响),
        // 使后台设置的频率限制对每个 API 密钥各自生效
        $keyLimit = isset($db['settings']['apiKeyRateLimitPerMin']) ? (int) $db['settings']['apiKeyRateLimitPerMin'] : 60;
        if ($keyLimit > 0) {
            $keyTag = substr(hash('sha256', $token), 0, 24);
            if (!tc_rate_limit_check('k:' . $keyTag, $keyLimit)) {
                tc_fail(429, '请求太频繁了，请稍后再试（当前密钥上限 ' . $keyLimit . ' 次/分钟）');
            }
        }
        // 用户级限流同样生效,防止用多把密钥绕过站点总量限制
        $userLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
        if ($userLimit > 0 && !tc_rate_limit_check('u:' . $owner['userId'], $userLimit)) {
            tc_fail(429, '请求太频繁了，请稍后再试（当前账号上限 ' . $userLimit . ' 次/分钟）');
        }
        // lastUsed 分钟级节流:避免每次 API 调用都全量重写数据库
        $changed = false;
        foreach ($db['users'] as &$u) {
            if (!isset($u['id']) || (string) $u['id'] !== (string) $owner['userId']) continue;
            $k = &$u['apiKeys'][$owner['keyIndex']];
            if (isset($k) && is_array($k) && (int) (isset($k['lastUsed']) ? $k['lastUsed'] : 0) < tc_now() - 60000) {
                $k['lastUsed'] = tc_now();
                $changed = true;
            }
            unset($k);
            break;
        }
        unset($u);
        if (!$changed) tc_db_skip_write();
        return array('userId' => (string) $owner['userId']);
    });
    return $auth;
}

// 开放接口是否对外暴露某个 provider/model:白名单为空表示不限制
function tc_api_model_exposed($settings, $providerId, $modelId) {
    $list = isset($settings['apiExposedModels']) && is_array($settings['apiExposedModels']) ? $settings['apiExposedModels'] : array();
    if (!$list) return true;
    return in_array($providerId . '|' . $modelId, $list, true);
}

// ---- 图像生成代理:POST {baseUrl}/images/generations(OpenAI 兼容),按次计费 ----
// 说明:图像模型不进对话模型清单,因此不做模型成员校验;鉴权/限流/额度/审核与对话一致。
// $apiKeyOwner 非 null 时走开放接口(密钥)路径,并额外校验对外模型白名单。
function tc_generate_images($apiKeyOwner = null) {
    $started = tc_now();
    $authUserId = $apiKeyOwner !== null ? (string) $apiKeyOwner['userId'] : '';
    $ctx = tc_with_db(false, function ($db) use ($apiKeyOwner, $authUserId) {
        if ($apiKeyOwner !== null) {
            $user = null;
            foreach ($db['users'] as $u) {
                if ((string) $u['id'] === $authUserId) { $user = $u; break; }
            }
            if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        } else {
            $user = tc_require_auth($db);
        }
        $rateLimit = isset($db['settings']['rateLimitPerMin']) ? (int) $db['settings']['rateLimitPerMin'] : 30;
        if (!tc_rate_limit_check('u:' . $user['id'], $rateLimit)) {
            tc_fail(429, '请求太频繁了，请稍后再试（当前上限 ' . $rateLimit . ' 次/分钟）');
        }
        $b = tc_read_json_body(1024 * 1024);
        // 支持两种入参:原生 {prompt} 与 OpenAI 对话格式 {messages/input}(生图模型自动路由时会用到)
        $promptText = isset($b['prompt']) ? (string) $b['prompt'] : '';
        if (trim($promptText) === '' && (isset($b['messages']) || isset($b['input']))) {
            $promptText = tc_last_user_text($b, isset($b['messages']) ? 'chat' : 'responses');
        }
        $modHit = tc_moderation_hit(isset($db['settings']['moderation']) && is_array($db['settings']['moderation']) ? $db['settings']['moderation'] : array(), $promptText);
        if ($modHit !== '') tc_fail(400, '提示词包含被禁止的内容，请修改后重试');
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 120);
        // 解析供应商:显式指定 providerId 优先;开放接口/未指定时按模型归属查找
        $resolved = tc_resolve_provider($db, $user, array(
            'providerId' => isset($b['providerId']) ? $b['providerId'] : null,
            'model' => $model,
        ));
        if (!empty($resolved['error'])) tc_fail(400, $resolved['error']);
        $provider = $resolved['provider'];
        if ((isset($provider['apiFormat']) ? $provider['apiFormat'] : 'chat') === 'anthropic') {
            tc_fail(400, '该供应商为 Anthropic 格式，暂不支持图像生成');
        }
        if ($apiKeyOwner !== null && !tc_api_model_exposed($db['settings'], isset($provider['id']) ? $provider['id'] : '', $model)) {
            tc_fail(403, '模型 ' . $model . ' 未对开放接口开放，请联系管理员');
        }
        $cost = tc_provider_cost($provider);
        if (isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id']) $cost = 0;
        if (!tc_is_unlimited_quota($user) && (isset($user['quota']) ? (float) $user['quota'] : 0) < $cost) {
            tc_fail(402, '剩余次数不足，请联系管理员充值');
        }
        // 透传常见可选参数(仅白名单键,避免污染上游请求)
        $extra = array();
        foreach (array('quality', 'style', 'response_format', 'background') as $k) {
            if (isset($b[$k]) && is_string($b[$k]) && $b[$k] !== '') $extra[$k] = substr($b[$k], 0, 40);
        }
        // 尺寸:接受「1024x1024」这类精确值,也接受「1K/2K/3K/4K」这类档位(部分平台推荐用档位)
        $size = '1024x1024';
        if (isset($b['size']) && is_string($b['size'])) {
            $s = trim($b['size']);
            if (preg_match('/^\d{3,4}x\d{3,4}$/i', $s) || preg_match('/^[1-4]K$/i', $s)) $size = $s;
        }
        // 宽高比(部分平台如 Agnes 用 ratio 而非 size 表达构图)
        $ratio = '';
        if (isset($b['ratio']) && is_string($b['ratio']) && preg_match('#^\d{1,2}:\d{1,2}$#', trim($b['ratio']))) $ratio = trim($b['ratio']);
        return array(
            'user' => $user,
            'provider' => $provider,
            'cost' => $cost,
            'model' => $model,
            'prompt' => substr(trim($promptText), 0, 4000),
            'size' => $size,
            'ratio' => $ratio,
            'n' => min(4, max(1, (int) (isset($b['n']) ? $b['n'] : 1) ?: 1)),
            'extra' => $extra,
            'timeout' => $db['settings']['proxyTimeoutMs'],
        );
    });
    $provider = $ctx['provider'];
    $user = $ctx['user'];
    if ($ctx['model'] === '' || $ctx['prompt'] === '') tc_fail(400, '请填写模型和提示词');
    // 关键:生图也必须补齐 /v1(用户常按平台文档只填 https://host,不写 /v1)
    $url = tc_api_url($provider['baseUrl'], '/images/generations');
    $headers = array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . $provider['apiKey']);
    $body = array(
        'model' => $ctx['model'],
        'prompt' => $ctx['prompt'],
        'n' => $ctx['n'],
        'size' => $ctx['size'],
    );
    if (!empty($ctx['ratio'])) $body['ratio'] = $ctx['ratio'];
    // 透传常见可选参数(如 quality / style / response_format);仅收录白名单键,避免污染上游请求
    foreach (array('quality', 'style', 'response_format', 'background') as $k) {
        if (isset($ctx['extra'][$k])) $body[$k] = $ctx['extra'][$k];
    }
    // 不同平台对可选参数的容忍度差异很大(有的拒绝 response_format,有的拒绝 size/style;
    // 还有的(如 Agnes)要求把 response_format 放进 extra_body 而不是顶层)。
    // 先按完整参数请求,若被上游以 4xx 拒绝,则逐级降级/换形态重试。
    // 降级顺序刻意「先丢冷门可选参数、最后才丢 size」——因为 size 是很多平台的必填项。
    // 允许「网络类连接错误」重试一次(提高网络抖动/冷启动的成功率),但参数类错误不重试。
    $attempts = array();
    $attempts[] = $body;                                                    // 0. 完整参数
    if (isset($body['response_format'])) {                                  // 1. response_format 挪进 extra_body
        $alt = $body;
        unset($alt['response_format']);
        $alt['extra_body'] = array('response_format' => $body['response_format']);
        $attempts[] = $alt;
    }
    $strip = function ($src, $keys) {                                        // 去掉指定键,保留其余
        $out = $src;
        foreach ($keys as $k) unset($out[$k]);
        return $out;
    };
    $optional = array('quality', 'style', 'background', 'response_format', 'extra_body', 'ratio');
    $attempts[] = $strip($body, $optional);                                  // 2. 去可选参数,保留 size/n
    $attempts[] = $strip($body, array_merge($optional, array('n')));         // 3. 再去 n,保留 size
    $attempts[] = array('model' => $ctx['model'], 'prompt' => $ctx['prompt']); // 4. 最后只剩必填(极端平台)
    $seen = array();
    $res = null;
    $status = 0;
    $lastMsg = '';
    foreach ($attempts as $idx => $b) {
        $sig = tc_json_encode($b);
        if (isset($seen[$sig])) continue;
        $seen[$sig] = true;
        $res = tc_http_request($url, 'POST', $headers, $sig, $ctx['timeout'], false, null, true, 30000);
        if (empty($res['ok'])) {
            // 连接层失败:网络类(超时/连接)重试一次,其余直接报错
            $retryable = in_array(isset($res['kind']) ? $res['kind'] : '', array('connect_timeout', 'read_timeout', 'connect'), true);
            if ($retryable && $idx < 2) { sleep(1); continue; }
            tc_fail(isset($res['code']) && $res['code'] ? $res['code'] : 502, tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : ''));
        }
        $status = (int) (isset($res['status']) ? $res['status'] : 0);
        if ($status < 400) break;
        $lastMsg = tc_upstream_error_message(isset($res['body']) ? $res['body'] : '', $status);
        // 仅 400/422(参数不被接受)降级重试;401/403/404/429 等直接返回,重试无意义
        if ($status !== 400 && $status !== 422) {
            tc_fail($status, $lastMsg);
        }
    }
    if ($status >= 400) {
        // 降级重试后仍被拒,直接返回上游原始错误
        tc_fail($status, $lastMsg !== '' ? $lastMsg : ('上游 API 错误 (HTTP ' . $status . ')'));
    }
    $j = json_decode((string) (isset($res['body']) ? $res['body'] : ''), true);
    $items = tc_image_results_from_payload($j, $ctx['n']);
    if (!$items) {
        // 有的平台把图片放在非标准字段,或干脆是重定向后的二进制图片地址;给出可操作提示
        tc_fail(502, '上游未返回可识别的图像数据（已兼容 data[].url / data[].b64_json / images 等形态），请确认该模型支持 images/generations 接口');
    }
    $usage = array('prompt' => 0, 'completion' => 0);
    tc_with_db(true, function (&$db) use ($user, $provider, $ctx, $usage, $started) {
        $fresh = null;
        foreach ($db['users'] as $u) if ($u['id'] === $user['id']) { $fresh = $u; break; }
        if (!$fresh) return;
        $charged = tc_charge_user($db, $fresh, tc_final_cost($provider, $ctx['cost'], $usage), $ctx['model'] . ' (图像)');
        tc_touch_user($db, $user['id']);
        $GLOBALS['_tc_quota_after'] = isset($fresh['quota']) ? $fresh['quota'] : 0;
        tc_record_usage_entry($db, $user['id'], $ctx['model'] . ' (图像)', $charged, 0, 0);
        tc_push_log(array('kind' => 'chat', 'userName' => $user['name'], 'userId' => $user['id'], 'provider' => $provider['name'], 'model' => $ctx['model'] . ' (图像)', 'format' => 'images', 'status' => 200, 'ms' => tc_now() - $started, 'cost' => $charged, 'stream' => false));
    });
    return array('ok' => true, 'model' => $ctx['model'], 'images' => $items);
}

// 从不同平台的图像响应里提取图片,兼容多种常见形态:
//   {data:[{url|b64_json, revised_prompt}]} / {images:[...]} / {output:[...]} /
//   {data:{url}} / 顶层 {url} / data[] 里直接是字符串 URL 或 data: base64
// 返回 [{url?|b64_json?, revised_prompt?}],最多 $limit 条。
function tc_image_results_from_payload($j, $limit = 1) {
    $items = array();
    $limit = max(1, (int) $limit);
    $push = function ($node) use (&$items, $limit) {
        if (count($items) >= $limit) return;
        if (is_string($node)) {
            $s = trim($node);
            if ($s === '') return;
            if (strpos($s, 'data:image/') === 0) {
                $pos = strpos($s, 'base64,');
                if ($pos !== false) { $items[] = array('b64_json' => substr($s, $pos + 7)); return; }
            }
            if (preg_match('#^https?://#i', $s)) { $items[] = array('url' => $s); return; }
            return;
        }
        if (!is_array($node)) return;
        $item = array();
        if (!empty($node['url']) && is_string($node['url'])) $item['url'] = $node['url'];
        elseif (!empty($node['b64_json'])) $item['b64_json'] = (string) $node['b64_json'];
        elseif (!empty($node['image_url']) && is_string($node['image_url'])) $item['url'] = $node['image_url'];
        elseif (!empty($node['image']) && is_string($node['image'])) {
            // image 字段可能是裸 base64 或 data URL
            $v = $node['image'];
            if (strpos($v, 'data:image/') === 0) {
                $pos = strpos($v, 'base64,');
                if ($pos !== false) $item['b64_json'] = substr($v, $pos + 7);
            } elseif (preg_match('#^https?://#i', $v)) {
                $item['url'] = $v;
            } else {
                $item['b64_json'] = $v;
            }
        }
        if (isset($node['revised_prompt']) && is_string($node['revised_prompt'])) $item['revised_prompt'] = $node['revised_prompt'];
        if ($item) $items[] = $item;
    };
    if (!is_array($j)) return $items;
    foreach (array('data', 'images', 'output', 'artifacts', 'results', 'image') as $key) {
        if (!array_key_exists($key, $j)) continue;
        $v = $j[$key];
        if (is_array($v)) {
            // 关联数组且自身带 url/b64_json,视为单个对象
            if (isset($v['url']) || isset($v['b64_json']) || isset($v['image']) || isset($v['image_url'])) $push($v);
            else foreach ($v as $one) $push($one);
        } else {
            $push($v);
        }
        if (count($items) >= $limit) break;
    }
    // 顶层直接是单张图片
    if (!$items && (isset($j['url']) || isset($j['b64_json']) || isset($j['image']))) $push($j);
    return $items;
}

// 网页端入口:返回 {ok, model, images:[{url|b64_json}]}
function tc_api_proxy_images() {
    tc_json(200, tc_generate_images(null));
}

// 开放接口入口:POST /v1/images/generations,返回 OpenAI 规范形状
function tc_api_v1_images_generations() {
    $auth = tc_v1_authenticate();
    $out = tc_generate_images($auth);
    $data = array();
    foreach ((isset($out['images']) ? $out['images'] : array()) as $im) {
        $row = array();
        if (!empty($im['url'])) $row['url'] = $im['url'];
        elseif (!empty($im['b64_json'])) $row['b64_json'] = $im['b64_json'];
        if (isset($im['revised_prompt'])) $row['revised_prompt'] = $im['revised_prompt'];
        if ($row) $data[] = $row;
    }
    tc_json(200, array('created' => (int) floor(tc_now() / 1000), 'data' => $data));
}

function tc_api_v1_chat_completions() {
    $auth = tc_v1_authenticate();
    tc_api_proxy('chat', $auth);
}

function tc_api_v1_models() {
    $auth = tc_v1_authenticate();
    tc_with_db(false, function ($db) use ($auth) {
        $user = null;
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === $auth['userId']) { $user = $u; break; }
        }
        if (!$user) tc_fail(401, 'API 密钥对应的用户不存在');
        $allowed = tc_user_access($db, $user);
        $data = array();
        foreach (tc_visible_providers_of($db, $user) as $p) {
            $vis = tc_visible_provider($user, $p, $allowed);
            if (!$vis) continue;
            $ownerName = (isset($p['name']) && $p['name'] !== '' ? $p['name'] : 'tinychat');
            foreach ((isset($vis['models']) ? $vis['models'] : array()) as $m) {
                if (!is_array($m) || !isset($m['id']) || $m['id'] === '') continue;
                // 对外模型白名单:未开放的模型不出现在 /v1/models 里
                if (!tc_api_model_exposed($db['settings'], isset($p['id']) ? $p['id'] : '', (string) $m['id'])) continue;
                $data[] = array('id' => (string) $m['id'], 'object' => 'model', 'created' => 0, 'owned_by' => $ownerName);
            }
        }
        tc_json(200, array('object' => 'list', 'data' => $data));
    });
}
