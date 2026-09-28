<?php
require_once __DIR__ . '/core.php';

function tc_provider_enabled($p) {
    return !isset($p['enabled']) || !empty($p['enabled']);
}

function tc_visible_providers_of($db, $user) {
    $out = array();
    foreach ($db['providers'] as $p) {
        // 被管理员停用的供应商对所有用户不可见(后台管理列表除外)
        if (!tc_provider_enabled($p)) continue;
        if ((isset($p['scope']) && $p['scope'] === 'global') || (isset($p['ownerId']) && $p['ownerId'] === $user['id'])) {
            $out[] = $p;
        }
    }
    return $out;
}

function tc_effective_group_id($db, $user) {
    if (!empty($user['admin'])) {
        $admin = tc_find_builtin_group($db, 'admin');
        if ($admin && !empty($admin['id'])) return (string) $admin['id'];
    }
    $gid = isset($user['groupId']) ? (string) $user['groupId'] : '';
    if ($gid !== '' && tc_group_by_id($db, $gid)) return $gid;
    return tc_default_register_group($db);
}

function tc_user_access($db, $user) {
    $allowed = array();
    foreach ($db['providers'] as $p) {
        if (isset($p['ownerId']) && $p['ownerId'] === $user['id']) $allowed[$p['id']] = null;
    }
    // 管理员固定走管理员组；普通用户走自己的组，没有组时用注册默认组。
    $groupId = tc_effective_group_id($db, $user);
    if ($groupId) {
        foreach ($db['accessRules'] as $r) {
            if ($r['groupId'] !== $groupId) continue;
            $exists = false;
            foreach ($db['providers'] as $x) if ($x['id'] === $r['providerId']) { $exists = true; break; }
            if (!$exists) continue;
            $ids = isset($r['modelIds']) && is_array($r['modelIds']) ? $r['modelIds'] : array();
            if (!$ids || in_array('*', $ids, true)) {
                if (!array_key_exists($r['providerId'], $allowed)) $allowed[$r['providerId']] = null;
                continue;
            }
            $set = (isset($allowed[$r['providerId']]) && is_array($allowed[$r['providerId']]))
                ? $allowed[$r['providerId']] : array();
            foreach ($ids as $m) $set[$m] = true;
            $allowed[$r['providerId']] = $set;
        }
    }
    return $allowed;
}

function tc_visible_provider($user, $provider, $allowed) {
    if (!array_key_exists($provider['id'], $allowed)) return null;
    $set = $allowed[$provider['id']];
    if ($set === null) return $provider;
    $models = array();
    foreach ((isset($provider['models']) ? $provider['models'] : array()) as $m) {
        if (isset($set[$m['id']])) $models[] = $m;
    }
    if (!$models) return null;
    $copy = $provider;
    $copy['models'] = $models;
    return $copy;
}

function tc_client_provider($p, $owner = false, $admin = false) {
    $key = tc_provider_key($p);
    $showKey = $owner || $admin;
    return array(
        'id' => $p['id'],
        'name' => $p['name'],
        'baseUrl' => $p['baseUrl'],
        'apiFormat' => isset($p['apiFormat']) ? $p['apiFormat'] : 'chat',
        'models' => isset($p['models']) ? $p['models'] : array(),
        'costPerCall' => tc_provider_cost($p),
        'scope' => isset($p['scope']) ? $p['scope'] : 'user',
        'enabled' => tc_provider_enabled($p),
        'ownerId' => isset($p['ownerId']) ? $p['ownerId'] : null,
        'mine' => $owner,
        // 密钥只以掩码形式下发给属主或管理员;其他用户不回传任何密钥信息
        'apiKey' => $showKey && $key ? tc_mask_key($key) : '',
        'hasKey' => !!$key,
        'keyRevealable' => $showKey ? !empty($p['keyRevealable']) : false,
        'createdAt' => isset($p['createdAt']) ? $p['createdAt'] : null,
        'updatedAt' => isset($p['updatedAt']) ? $p['updatedAt'] : (isset($p['createdAt']) ? $p['createdAt'] : null),
    );
}

function tc_get_default_provider($db, $user, $list) {
    if (!empty($db['defaultProviderId'])) {
        foreach ($list as $p) if ($p['id'] === $db['defaultProviderId']) return $p;
    }
    foreach ($list as $p) if (isset($p['scope']) && $p['scope'] === 'global') return $p;
    foreach ($list as $p) if (isset($p['ownerId']) && $p['ownerId'] === $user['id']) return $p;
    return $list ? $list[0] : null;
}

function tc_resolve_provider($db, $user, $body) {
    $providerId = isset($body['providerId']) ? $body['providerId'] : null;
    $list = tc_visible_providers_of($db, $user);
    $allowed = tc_user_access($db, $user);
    $target = null;
    if ($providerId) {
        foreach ($list as $x) if ($x['id'] === $providerId) { $target = $x; break; }
        if (!$target) {
            foreach ($db['providers'] as $x) if ($x['id'] === $providerId) { if (!tc_provider_enabled($x)) return array('error' => '该供应商已被管理员停用'); break; }
            return array('error' => '指定的供应商不存在或无权访问');
        }
    } else {
        $target = tc_get_default_provider($db, $user, $list);
    }
    if (!$target) return array('error' => '没有可用供应商，请联系管理员配置，或在「设置 → 供应商」中添加自己的 API');
    $vis = tc_visible_provider($user, $target, $allowed);
    if (!$vis) return array('error' => '当前用户组无权访问该供应商或模型');
    if (isset($allowed[$target['id']]) && is_array($allowed[$target['id']])) {
        $reqModel = isset($body['model']) ? $body['model'] : (isset($vis['models'][0]['id']) ? $vis['models'][0]['id'] : null);
        if ($reqModel) {
            $ok = false;
            foreach ($vis['models'] as $m) if ($m['id'] === $reqModel) { $ok = true; break; }
            if (!$ok) return array('error' => '当前用户组无权使用模型 ' . $reqModel);
        }
    }
    // 代理请求需要明文 Key 访问上游;在返回给代理上下文前解密(仅服务端内存,不落库不下发)
    if (isset($vis['apiKey'])) $vis['apiKey'] = tc_provider_key($target);
    return array('provider' => $vis, 'providerFull' => $target);
}

function tc_normalize_models($models) {
    if (!is_array($models)) return array();
    $out = array();
    $seen = array();
    foreach ($models as $m) {
        $id = '';
        if (is_array($m)) $id = trim((string) (isset($m['id']) ? $m['id'] : (isset($m['name']) ? $m['name'] : '')));
        if ($id === '' || isset($seen[$id])) continue;
        $seen[$id] = true;
        $name = is_array($m) && !empty($m['name']) ? trim((string) $m['name']) : $id;
        $row = array('id' => $id, 'name' => $name ?: $id);
        // 模型级最大输出/最大上下文(可选):留空/0 表示跟随全局或不限制
        if (is_array($m) && isset($m['maxTokens']) && (int) $m['maxTokens'] > 0) {
            $row['maxTokens'] = min(128000, max(256, (int) $m['maxTokens']));
        }
        if (is_array($m) && isset($m['maxContext']) && (int) $m['maxContext'] > 0) {
            $row['maxContext'] = min(2000000, max(256, (int) $m['maxContext']));
        }
        $out[] = $row;
        if (count($out) >= 500) break;
    }
    return $out;
}

function tc_normalize_provider_input($b, $base = array()) {
    $p = $base;
    if (array_key_exists('name', $b)) $p['name'] = substr(trim((string) $b['name']), 0, 60);
    if (array_key_exists('baseUrl', $b)) $p['baseUrl'] = rtrim(trim((string) $b['baseUrl']), '/');
    if (array_key_exists('apiKey', $b)) {
        $key = trim((string) $b['apiKey']);
        // 留空或仍是掩码表示「不修改密钥」,保留原值(可能是密文)
        if ($key !== '' && strpos($key, '••') === false) $p['apiKey'] = $key;
    }
    if (array_key_exists('keyRevealable', $b)) $p['keyRevealable'] = !empty($b['keyRevealable']);
    if (array_key_exists('enabled', $b)) $p['enabled'] = !empty($b['enabled']);
    if (array_key_exists('apiFormat', $b) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true)) {
        $p['apiFormat'] = $b['apiFormat'];
    }
    if (array_key_exists('costPerCall', $b)) $p['costPerCall'] = max(0, min(1000, (float) $b['costPerCall']));
    if (array_key_exists('models', $b)) $p['models'] = tc_normalize_models($b['models']);
    if (empty($p['apiFormat'])) $p['apiFormat'] = 'chat';
    if (!isset($p['costPerCall']) || !is_numeric($p['costPerCall'])) $p['costPerCall'] = 1;
    if (empty($p['name'])) $p['name'] = !empty($p['baseUrl']) ? $p['baseUrl'] : '未命名供应商';
    return $p;
}

function tc_validate_provider($p) {
    if (empty($p['baseUrl'])) return 'Base URL 不能为空';
    if (!preg_match('/^https?:\/\//i', $p['baseUrl'])) return 'Base URL 需以 http:// 或 https:// 开头';
    if (empty($p['apiKey'])) return 'API Key 不能为空';
    if (empty($p['models'])) return '请至少提供一个模型';
    return null;
}

function tc_find_editable_provider($db, $user, $id) {
    foreach ($db['providers'] as $p) {
        if ($p['id'] === $id) {
            if ((isset($p['ownerId']) && $p['ownerId'] === $user['id']) || !empty($user['admin'])) return $p;
            tc_fail(403, '只能修改自己添加的供应商');
        }
    }
    tc_fail(404, '供应商不存在');
}

function tc_remove_provider(&$db, $id) {
    $idx = -1;
    foreach ($db['providers'] as $i => $p) if ($p['id'] === $id) { $idx = $i; break; }
    if ($idx < 0) return false;
    array_splice($db['providers'], $idx, 1);
    if (isset($db['defaultProviderId']) && $db['defaultProviderId'] === $id) {
        $next = null;
        foreach ($db['providers'] as $p) if (isset($p['scope']) && $p['scope'] === 'global') { $next = $p['id']; break; }
        if (!$next && $db['providers']) $next = $db['providers'][0]['id'];
        $db['defaultProviderId'] = $next;
    }
    $rules = array();
    foreach ($db['accessRules'] as $r) if ($r['providerId'] !== $id) $rules[] = $r;
    $db['accessRules'] = $rules;
    return true;
}

function tc_sanitize_chats($chats) {
    if (!is_array($chats)) return array();
    $out = array();
    foreach (array_slice($chats, 0, 300) as $c) {
        if (!is_array($c)) continue;
        $id = substr((string) (isset($c['id']) ? $c['id'] : ''), 0, 64);
        if ($id === '') continue;
        $messages = array();
        if (isset($c['messages']) && is_array($c['messages'])) {
            foreach (array_slice($c['messages'], -800) as $m) {
                if (!is_array($m)) continue;
                $role = isset($m['role']) && in_array($m['role'], array('user', 'assistant', 'system'), true) ? $m['role'] : 'assistant';
                $msg = array(
                    'role' => $role,
                    'content' => substr((string) (array_key_exists('content', $m) && $m['content'] !== null ? $m['content'] : ''), 0, 200000),
                );
                foreach (array('vote', 'followUps', 'citations', 'model', 'reasoning', 'error', 'interrupted', 'failNote', 'elapsedMs', 'createdAt', 'usage', 'contextCount', 'contextLimit', 'taskId', 'taskSeq', 'taskStatus', 'taskFormat') as $k) {
                    if (array_key_exists($k, $m) && $m[$k] !== null) $msg[$k] = $m[$k];
                }
                if (isset($msg['usage']) && is_array($msg['usage'])) {
                    $usage = array();
                    foreach (array('prompt', 'completion', 'total') as $uk) {
                        if (isset($msg['usage'][$uk]) && is_numeric($msg['usage'][$uk])) $usage[$uk] = max(0, (int) $msg['usage'][$uk]);
                    }
                    $msg['usage'] = $usage ? $usage : null;
                    if ($msg['usage'] === null) unset($msg['usage']);
                } elseif (isset($msg['usage'])) {
                    unset($msg['usage']);
                }
                if (isset($msg['contextCount'])) $msg['contextCount'] = max(0, (int) $msg['contextCount']);
                if (isset($msg['contextLimit'])) $msg['contextLimit'] = max(0, (int) $msg['contextLimit']);
                if (isset($m['versions']) && is_array($m['versions'])) {
                    $vers = array();
                    foreach (array_slice($m['versions'], -12) as $v) {
                        if (!is_array($v)) continue;
                        $vers[] = array(
                            'content' => substr((string) (isset($v['content']) ? $v['content'] : ''), 0, 200000),
                            'reasoning' => substr((string) (isset($v['reasoning']) ? $v['reasoning'] : ''), 0, 200000),
                            'followUps' => isset($v['followUps']) && is_array($v['followUps']) ? array_slice($v['followUps'], 0, 8) : array(),
                            'citations' => isset($v['citations']) && is_array($v['citations']) ? array_slice($v['citations'], 0, 20) : array(),
                            'vote' => isset($v['vote']) ? $v['vote'] : null,
                            'model' => substr((string) (isset($v['model']) ? $v['model'] : ''), 0, 80),
                            'error' => !empty($v['error']),
                            'interrupted' => !empty($v['interrupted']),
                            'failNote' => substr((string) (isset($v['failNote']) ? $v['failNote'] : ''), 0, 300),
                            'elapsedMs' => isset($v['elapsedMs']) && is_numeric($v['elapsedMs']) ? (int) $v['elapsedMs'] : null,
                            'createdAt' => isset($v['createdAt']) ? (float) $v['createdAt'] : tc_now(),
                            'usage' => (isset($v['usage']) && is_array($v['usage'])) ? array(
                                'prompt' => isset($v['usage']['prompt']) ? max(0, (int) $v['usage']['prompt']) : 0,
                                'completion' => isset($v['usage']['completion']) ? max(0, (int) $v['usage']['completion']) : 0,
                                'total' => isset($v['usage']['total']) ? max(0, (int) $v['usage']['total']) : 0,
                            ) : null,
                            'contextCount' => isset($v['contextCount']) && is_numeric($v['contextCount']) ? max(0, (int) $v['contextCount']) : null,
                            'contextLimit' => isset($v['contextLimit']) && is_numeric($v['contextLimit']) ? max(0, (int) $v['contextLimit']) : null,
                        );
                    }
                    if ($vers) {
                        $msg['versions'] = $vers;
                        $vi = isset($m['versionIndex']) ? (int) $m['versionIndex'] : (count($vers) - 1);
                        if ($vi < 0) $vi = 0;
                        if ($vi >= count($vers)) $vi = count($vers) - 1;
                        $msg['versionIndex'] = $vi;
                    }
                }
                $messages[] = $msg;
            }
        }
        $out[] = array(
            'id' => $id,
            'title' => substr((string) (isset($c['title']) ? $c['title'] : '新对话'), 0, 120),
            'messages' => $messages,
            'pinned' => !empty($c['pinned']),
            'branchOf' => !empty($c['branchOf']) ? substr((string) $c['branchOf'], 0, 64) : null,
            'assistantId' => !empty($c['assistantId']) ? substr((string) $c['assistantId'], 0, 64) : null,
            'assistantName' => !empty($c['assistantName']) ? substr((string) $c['assistantName'], 0, 80) : '',
            'systemPrompt' => !empty($c['systemPrompt']) ? substr((string) $c['systemPrompt'], 0, 20000) : '',
            'createdAt' => isset($c['createdAt']) ? (float) $c['createdAt'] : tc_now(),
            'updatedAt' => isset($c['updatedAt']) ? (float) $c['updatedAt'] : tc_now(),
        );
    }
    return $out;
}

function tc_sanitize_share_messages($messages) {
    if (!is_array($messages)) return array();
    $out = array();
    foreach (array_slice($messages, -200) as $m) {
        if (!is_array($m)) continue;
        $content = substr((string) (isset($m['content']) && $m['content'] !== null ? $m['content'] : ''), 0, 200000);
        if ($content === '') continue;
        $out[] = array(
            'role' => (isset($m['role']) && in_array($m['role'], array('user', 'assistant'), true)) ? $m['role'] : 'assistant',
            'content' => $content,
        );
    }
    return $out;
}

function tc_public_share($share) {
    return array(
        'id' => $share['id'],
        'title' => $share['title'],
        'messages' => $share['messages'],
        'createdAt' => $share['createdAt'],
        'updatedAt' => $share['updatedAt'],
    );
}

function tc_last_n_days($n) {
    $out = array();
    for ($i = $n - 1; $i >= 0; $i--) $out[] = date('Y-m-d', time() - $i * 86400);
    return $out;
}

function tc_chats_of($db, $userId) {
    $map = tc_assoc($db['userChats']);
    return isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
}

function tc_chat_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}

function tc_set_chats(&$db, $userId, $chats) {
    $map = tc_assoc($db['userChats']);
    $map[$userId] = $chats;
    $db['userChats'] = tc_object_map($map);
    $revisions = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    $revisions[$userId] = tc_chat_revision_of($db, $userId) + 1;
    $db['userChatRevisions'] = tc_object_map($revisions);
}

function tc_assistant_icons() {
    return array('bot', 'spark', 'layers', 'paper', 'code', 'table', 'nodes', 'think', 'user', 'wrench', 'edit', 'calendar');
}

function tc_is_allowed_assistant_icon($icon) {
    $s = trim((string) $icon);
    if ($s === '' || strlen($s) > 16) return false;
    if (in_array($s, tc_assistant_icons(), true)) return true;
    return (bool) preg_match('/[^\x00-\x7F]/u', $s);
}

function tc_seed_default_assistants(&$db) {
    $cat = tc_catalog();
    $now = tc_now();
    if (!is_array($db['assistantCategories'])) $db['assistantCategories'] = array();
    if (!is_array($db['assistants'])) $db['assistants'] = array();
    $changed = false;
    foreach ((isset($cat['categories']) ? $cat['categories'] : array()) as $c) {
        $existing = null;
        foreach ($db['assistantCategories'] as $i => $x) if ($x['id'] === $c['id']) { $existing = &$db['assistantCategories'][$i]; break; }
        if (!$existing) {
            $db['assistantCategories'][] = array(
                'id' => $c['id'], 'name' => $c['name'], 'sort' => $c['sort'],
                'icon' => isset($c['icon']) ? $c['icon'] : '',
                'scope' => 'global', 'ownerId' => null, 'createdAt' => $now,
            );
            $changed = true;
        } elseif (isset($existing['scope']) && $existing['scope'] === 'global') {
            $icon = isset($c['icon']) ? $c['icon'] : '';
            if ($existing['name'] !== $c['name'] || $existing['sort'] !== $c['sort'] || (isset($existing['icon']) ? $existing['icon'] : '') !== $icon) {
                $existing['name'] = $c['name'];
                $existing['sort'] = $c['sort'];
                $existing['icon'] = $icon;
                $changed = true;
            }
        }
        unset($existing);
    }
    $i = 0;
    foreach ((isset($cat['assistants']) ? $cat['assistants'] : array()) as $a) {
        $i++;
        $sort = $i * 10;
        $existing = null;
        foreach ($db['assistants'] as $j => $x) if ($x['id'] === $a['id']) { $existing = &$db['assistants'][$j]; break; }
        if (!$existing) {
            $db['assistants'][] = array(
                'id' => $a['id'], 'categoryId' => $a['categoryId'], 'name' => $a['name'],
                'desc' => $a['desc'], 'prompt' => $a['prompt'], 'icon' => $a['icon'],
                'sort' => $sort, 'scope' => 'global', 'ownerId' => null, 'sourceId' => null,
                'createdAt' => $now, 'updatedAt' => $now,
            );
            $changed = true;
        } elseif (isset($existing['scope']) && $existing['scope'] === 'global') {
            if (
                $existing['categoryId'] !== $a['categoryId'] || $existing['name'] !== $a['name']
                || $existing['desc'] !== $a['desc'] || $existing['prompt'] !== $a['prompt']
                || $existing['icon'] !== $a['icon'] || (isset($existing['sort']) ? $existing['sort'] : 0) !== $sort
            ) {
                $existing['categoryId'] = $a['categoryId'];
                $existing['name'] = $a['name'];
                $existing['desc'] = $a['desc'];
                $existing['prompt'] = $a['prompt'];
                $existing['icon'] = $a['icon'];
                $existing['sort'] = $sort;
                $existing['updatedAt'] = $now;
                $changed = true;
            }
        }
        unset($existing);
    }
    return $changed;
}

function tc_visible_assistant_categories($db, $user) {
    $out = array();
    foreach ($db['assistantCategories'] as $c) {
        if ((isset($c['scope']) && $c['scope'] === 'global') || (isset($c['scope']) && $c['scope'] === 'user' && isset($c['ownerId']) && $c['ownerId'] === $user['id'])) {
            $out[] = $c;
        }
    }
    return $out;
}

function tc_visible_assistants($db, $user) {
    $out = array();
    foreach ($db['assistants'] as $a) {
        if ((isset($a['scope']) && $a['scope'] === 'global') || (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'])) {
            $out[] = $a;
        }
    }
    return $out;
}

function tc_public_category($c, $extras = array()) {
    return array_merge(array(
        'id' => $c['id'],
        'name' => $c['name'],
        'sort' => isset($c['sort']) ? (int) $c['sort'] : 0,
        'icon' => isset($c['icon']) ? $c['icon'] : '',
        'scope' => (isset($c['scope']) && $c['scope'] === 'user') ? 'user' : 'global',
        'mine' => isset($c['scope']) && $c['scope'] === 'user',
        'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0,
    ), $extras);
}

function tc_public_assistant($a, $extras = array()) {
    return array_merge(array(
        'id' => $a['id'],
        'categoryId' => $a['categoryId'],
        'name' => $a['name'],
        'desc' => isset($a['desc']) ? $a['desc'] : '',
        'prompt' => isset($a['prompt']) ? $a['prompt'] : '',
        'icon' => isset($a['icon']) ? $a['icon'] : '✨',
        'sort' => isset($a['sort']) ? (int) $a['sort'] : 0,
        'scope' => (isset($a['scope']) && $a['scope'] === 'user') ? 'user' : 'global',
        'mine' => isset($a['scope']) && $a['scope'] === 'user',
        'sourceId' => isset($a['sourceId']) ? $a['sourceId'] : null,
        'createdAt' => isset($a['createdAt']) ? $a['createdAt'] : 0,
        'updatedAt' => isset($a['updatedAt']) ? $a['updatedAt'] : 0,
    ), $extras);
}

function tc_find_owned_category($db, $user, $id, $adminOk = false) {
    foreach ($db['assistantCategories'] as $c) {
        if ($c['id'] !== $id) continue;
        if (isset($c['scope']) && $c['scope'] === 'user' && isset($c['ownerId']) && $c['ownerId'] === $user['id']) return $c;
        if ($adminOk && !empty($user['admin']) && isset($c['scope']) && $c['scope'] === 'global') return $c;
        return null;
    }
    return null;
}

function tc_find_owned_assistant($db, $user, $id, $adminOk = false) {
    foreach ($db['assistants'] as $a) {
        if ($a['id'] !== $id) continue;
        if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id']) return $a;
        if ($adminOk && !empty($user['admin']) && isset($a['scope']) && $a['scope'] === 'global') return $a;
        return null;
    }
    return null;
}

function tc_resolve_category_for_write($db, $user, $categoryId) {
    $id = trim((string) $categoryId);
    if ($id === '') return array('error' => '请选择分类');
    foreach ($db['assistantCategories'] as $c) {
        if ($c['id'] !== $id) continue;
        if (isset($c['scope']) && $c['scope'] === 'global') return array('category' => $c);
        if (isset($c['ownerId']) && $c['ownerId'] === $user['id']) return array('category' => $c);
        return array('error' => '无权使用该分类');
    }
    return array('error' => '分类不存在');
}

function tc_parse_assistant_input($b, $existing = null) {
    $name = substr(trim((string) (isset($b['name']) ? $b['name'] : ($existing ? $existing['name'] : ''))), 0, 40);
    $desc = substr(trim((string) (isset($b['desc']) ? $b['desc'] : ($existing && isset($existing['desc']) ? $existing['desc'] : ''))), 0, 160);
    $prompt = substr(trim((string) (isset($b['prompt']) ? $b['prompt'] : ($existing && isset($existing['prompt']) ? $existing['prompt'] : ''))), 0, 20000);
    $icon = substr(trim((string) (isset($b['icon']) ? $b['icon'] : ($existing && isset($existing['icon']) ? $existing['icon'] : '✨'))), 0, 16);
    if (!tc_is_allowed_assistant_icon($icon)) $icon = '✨';
    $sort = isset($b['sort']) && is_numeric($b['sort']) ? (float) $b['sort'] : ($existing && isset($existing['sort']) ? $existing['sort'] : tc_now());
    if ($name === '') return array('error' => '助手名称不能为空');
    if ($prompt === '') return array('error' => '系统提示词不能为空');
    return array('name' => $name, 'desc' => $desc, 'prompt' => $prompt, 'icon' => $icon, 'sort' => $sort);
}

function tc_parse_category_input($b, $existing = null) {
    $name = substr(trim((string) (isset($b['name']) ? $b['name'] : ($existing ? $existing['name'] : ''))), 0, 40);
    $sort = isset($b['sort']) && is_numeric($b['sort']) ? (float) $b['sort'] : ($existing && isset($existing['sort']) ? $existing['sort'] : tc_now());
    if ($name === '') return array('error' => '分类名称不能为空');
    return array('name' => $name, 'sort' => $sort);
}

function tc_sort_zh($a, $b, $ka, $kb) {
    $sa = isset($a['sort']) ? (float) $a['sort'] : 0;
    $sb = isset($b['sort']) ? (float) $b['sort'] : 0;
    if ($sa !== $sb) return $sa < $sb ? -1 : 1;
    return strcmp((string) (isset($a[$ka]) ? $a[$ka] : ''), (string) (isset($b[$kb]) ? $b[$kb] : ''));
}

function tc_default_assistant_record($db, $user) {
    $cat = tc_catalog();
    $id = isset($cat['DEFAULT_ASSISTANT_ID']) ? $cat['DEFAULT_ASSISTANT_ID'] : null;
    if (!$id) return null;
    $list = tc_visible_assistants($db, $user);
    $override = null;
    $item = null;
    foreach ($list as $a) {
        if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $id) $override = $a;
        if ($a['id'] === $id) $item = $a;
    }
    $pick = $override ?: $item;
    return $pick ? tc_public_assistant($pick) : null;
}

function tc_merge_assistant_catalog($db, $user) {
    $cats = tc_visible_assistant_categories($db, $user);
    usort($cats, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
    $items = tc_visible_assistants($db, $user);
    $hidden = array();
    foreach ($items as $a) {
        if (isset($a['scope']) && $a['scope'] === 'user' && !empty($a['sourceId'])) $hidden[$a['sourceId']] = true;
    }
    $shown = array();
    foreach ($items as $a) {
        if (isset($a['scope']) && $a['scope'] === 'global' && isset($hidden[$a['id']])) continue;
        $shown[] = $a;
    }
    usort($shown, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
    $categories = array();
    foreach ($cats as $c) {
        $count = 0;
        foreach ($shown as $a) if ($a['categoryId'] === $c['id']) $count++;
        $categories[] = tc_public_category($c, array('count' => $count));
    }
    $assistants = array();
    foreach ($shown as $a) $assistants[] = tc_public_assistant($a);
    return array(
        'categories' => $categories,
        'assistants' => $assistants,
        'defaultAssistant' => tc_default_assistant_record($db, $user),
    );
}

function tc_replace_by_id(&$list, $id, $item) {
    foreach ($list as $i => $x) if ($x['id'] === $id) { $list[$i] = $item; return true; }
    return false;
}

function tc_has_admin($db) {
    foreach ($db['users'] as $u) if (!empty($u['admin'])) return true;
    return false;
}

function tc_api_public_config($db) {
    $s = $db['settings'];
    tc_json(200, array(
        'siteName' => $s['siteName'],
        'allowRegister' => $s['allowRegister'],
        'freeQuota' => $s['freeQuota'],
        'version' => TC_VERSION,
        'hasProvider' => count($db['providers']) > 0,
        'needsSetup' => !tc_has_admin($db),
        // 前台据此决定是否展示"忘记密码"入口:功能关闭或未配置邮件时都不展示
        'emailVerificationEnabled' => !empty($s['emailVerificationEnabled']),
        'passwordResetEnabled' => !empty($s['passwordResetEnabled']),
        'mailReady' => !empty($s['smtp']['host']),
        'webSearch' => tc_web_search_public($s),
        'mineru' => tc_mineru_public($s),
        // 全站公告:enabled 且 text 非空时前台展示;updatedAt 变化视为新公告(重新弹出)
        'announcement' => array(
            'enabled' => !empty($s['announcement']['enabled']),
            'text' => isset($s['announcement']['text']) ? (string) $s['announcement']['text'] : '',
            'updatedAt' => (int) (isset($s['announcement']['updatedAt']) ? $s['announcement']['updatedAt'] : 0),
        ),
    ));
}

function tc_api_setup() {
    tc_with_db(true, function (&$db) {
        if (tc_has_admin($db)) tc_fail(409, '管理员已创建，请直接登录');
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : 'admin'));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4) tc_fail(400, '密码至少 4 个字符');
        if (strlen($password) > 128) tc_fail(400, '密码过长');
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        }
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => -1, 'createdAt' => tc_now(), 'admin' => true,
            'groupId' => ($ag = tc_find_builtin_group($db, 'admin')) ? $ag['id'] : tc_default_register_group($db),
            'tv' => 0,
        );
        tc_set_password($user, $password);
        $db['users'][] = $user;
        tc_json(200, array('token' => tc_issue_token($user, $db['settings']), 'user' => tc_sanitize_user($user)));
    });
}

function tc_render_mail_template($settings, $kind, $name, $link, $expiresText = '24 小时') {
    $tpl = $settings['mailTemplates'] ?? array(); $subject = $kind === 'reset' ? ($tpl['resetSubject'] ?? '重置密码') : ($tpl['verifySubject'] ?? '验证邮箱'); $html = $kind === 'reset' ? ($tpl['resetHtml'] ?? '') : ($tpl['verifyHtml'] ?? ''); $vars = array('{siteName}' => $settings['siteName'] ?? 'TinyChat', '{name}' => $name, '{link}' => $link, '{expires}' => $expiresText); return array(strtr($subject, $vars), strtr($html, $vars));
}

function tc_api_register() {
    tc_with_db(true, function (&$db) {
        $b = tc_read_json_body();
        if (empty($db['settings']['allowRegister'])) tc_fail(403, '站点已关闭注册，请联系管理员开通账号');
        if (!empty($db['settings']['agreementEnabled']) && empty($b['agreementAccepted'])) tc_fail(400, '请先阅读并同意用户协议');
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        $email = strtolower(trim((string) ($b['email'] ?? '')));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4) tc_fail(400, '密码至少 4 个字符');
        if (strlen($password) > 128) tc_fail(400, '密码过长');
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        }
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => 0, 'email' => $email, 'createdAt' => tc_now(), 'admin' => false, 'groupId' => tc_default_register_group($db), 'tv' => 0, 'emailVerifiedAt' => '' ,
        );
        tc_set_password($user, $password);
        if (!empty($db['settings']['emailVerificationEnabled'])) {
            if ($email === '') tc_fail(400, '开启邮箱验证后必须填写邮箱');
            $token = bin2hex(random_bytes(24)); $user['emailTokenHash'] = hash('sha256', $token); $user['emailTokenExpires'] = tc_now() + 86400000;
        }
        $db['users'][] = $user;
        tc_add_quota($db, $user, !empty($db['settings']['freeQuotaUnlimited']) ? -1 : $db['settings']['freeQuota']);
        if (!empty($db['settings']['emailVerificationEnabled'])) { $link = tc_public_base_url() . '/login?verify=' . rawurlencode($token); [$subject,$html] = tc_render_mail_template($db['settings'], 'verify', $name, $link, '24 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html)) tc_fail(503, '验证邮件发送失败，请联系管理员'); tc_json(200, array('ok'=>true,'pendingVerification'=>true,'user'=>tc_sanitize_user($user))); }
        tc_json(200, array('token' => tc_issue_token($user, $db['settings']), 'user' => tc_sanitize_user($user)));
    });
}

function tc_api_login() {
    $user = null;
    tc_with_db(false, function ($db) use (&$user) {
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if ($name === '' || $password === '') tc_fail(400, '请输入用户名和密码');
        $locked = tc_check_login_lock($db['settings'], $name);
        if ($locked) tc_fail(429, '登录失败次数过多，请 ' . $locked . ' 秒后重试');
        $found = null;
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) { $found = $u; break; }
        }
        if (!$found || !tc_verify_password($password, $found)) {
            tc_note_login_fail($db['settings'], $name);
            tc_fail(401, '用户名或密码错误');
        }
        tc_clear_login_fail($name);
        if (!empty($db['settings']['emailVerificationEnabled']) && empty($found['emailVerifiedAt'])) tc_fail(403, '请先验证邮箱后再登录');
        $user = $found;
    });
    if (!$user || empty($user['id'])) tc_fail(401, '用户名或密码错误');
    $seenId = $user['id'];
    tc_with_db(true, function (&$db) use ($seenId, &$user) {
        tc_touch_user($db, $seenId);
        foreach ($db['users'] as $u) {
            if ($u['id'] === $seenId) { $user = $u; break; }
        }
    });
    tc_json(200, array('token' => tc_issue_token($user, $db['settings']), 'user' => tc_sanitize_user($user)));
}

function tc_api_verify_email() {
    tc_with_db(true, function (&$db) {
        $b = tc_read_json_body(); $token = (string) ($b['token'] ?? ''); $hash = hash('sha256', $token); $now = tc_now();
        foreach ($db['users'] as &$u) if (!empty($u['emailTokenHash']) && hash_equals($u['emailTokenHash'], $hash) && (int) ($u['emailTokenExpires'] ?? 0) > $now) { $u['emailVerifiedAt'] = $now; $u['emailTokenHash'] = ''; $u['emailTokenExpires'] = 0; tc_json(200, array('ok' => true)); }
        unset($u); tc_fail(400, '验证链接无效或已过期');
    });
}

function tc_api_resend_verification() {
    tc_with_db(true, function (&$db) {
        $b = tc_read_json_body(); $email = strtolower(trim((string) ($b['email'] ?? ''))); if (!filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        foreach ($db['users'] as &$u) if (strtolower((string) ($u['email'] ?? '')) === $email) { if (!empty($u['emailLastSentAt']) && tc_now() - (int) $u['emailLastSentAt'] < 60000) tc_fail(429, '邮件发送过于频繁，请稍后再试'); $token = bin2hex(random_bytes(24)); $u['emailLastSentAt'] = tc_now(); $u['emailTokenHash'] = hash('sha256', $token); $u['emailTokenExpires'] = tc_now() + 86400000; $link = tc_public_base_url() . '/login?verify=' . rawurlencode($token); [$subject, $html] = tc_render_mail_template($db['settings'], 'verify', isset($u['name']) ? $u['name'] : '', $link, '24 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html)) tc_fail(503, '验证邮件发送失败'); break; }
        unset($u); tc_json(200, array('ok' => true));
    });
}

function tc_api_forgot_password() {
    tc_with_db(true, function (&$db) {
        if (empty($db['settings']['passwordResetEnabled'])) tc_fail(403, '找回密码功能未开启');
        $b = tc_read_json_body(); $email = strtolower(trim((string) ($b['email'] ?? ''))); if (!filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        foreach ($db['users'] as &$u) if (strtolower((string) ($u['email'] ?? '')) === $email) { if (!empty($u['resetLastSentAt']) && tc_now() - (int) $u['resetLastSentAt'] < 60000) tc_fail(429, '邮件发送过于频繁，请稍后再试'); $token = bin2hex(random_bytes(24)); $u['resetLastSentAt'] = tc_now(); $u['resetTokenHash'] = hash('sha256', $token); $u['resetTokenExpires'] = tc_now() + 3600000; $link = tc_public_base_url() . '/login?reset=' . rawurlencode($token); [$subject, $html] = tc_render_mail_template($db['settings'], 'reset', isset($u['name']) ? $u['name'] : '', $link, '1 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html)) tc_fail(503, '重置邮件发送失败'); break; }
        unset($u); tc_json(200, array('ok' => true));
    });
}

function tc_api_reset_password() {
    tc_with_db(true, function (&$db) {
        if (empty($db['settings']['passwordResetEnabled'])) tc_fail(403, '找回密码功能未开启');
        $b = tc_read_json_body(); $token = (string) ($b['token'] ?? ''); $pwd = (string) ($b['password'] ?? ''); if (strlen($pwd) < 4 || strlen($pwd) > 128) tc_fail(400, '密码长度需为 4-128 个字符'); $hash = hash('sha256', $token); $now = tc_now();
        foreach ($db['users'] as &$u) if (!empty($u['resetTokenHash']) && hash_equals($u['resetTokenHash'], $hash) && (int) ($u['resetTokenExpires'] ?? 0) > $now) { tc_set_password($u, $pwd); $u['resetTokenHash'] = ''; $u['resetTokenExpires'] = 0; tc_json(200, array('ok' => true)); }
        unset($u); tc_fail(400, '重置链接无效或已过期');
    });
}

function tc_api_logout() {
    tc_with_db(false, function ($db) {
        $user = tc_auth_user($db);
        if ($user) tc_push_log(array('kind' => 'auth', 'userName' => $user['name'], 'action' => '退出登录'));
        tc_json(200, array('ok' => true));
    });
}

function tc_api_me() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_json(200, array(
            'user' => tc_sanitize_user($user),
            'tools' => tc_user_tools_public($user, $db['settings']),
            'usage' => tc_usage_rows($db, $user['id'], tc_last_n_days(14)),
        ));
    });
}

function tc_api_save_tools() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $cur = tc_user_tools($user);
        $next = $cur;
        if (isset($b['webSearchSource'])) $next['webSearchSource'] = $b['webSearchSource'] === 'own' ? 'own' : 'platform';
        if (isset($b['webSearchProvider'])) $next['webSearchProvider'] = $b['webSearchProvider'] === 'searxng' ? 'searxng' : 'tavily';
        if (isset($b['webSearchTavilyKey'])) {
            $key = trim((string) $b['webSearchTavilyKey']);
            if ($key !== '' && strpos($key, '••') === false) $next['webSearchTavilyKey'] = substr($key, 0, 200);
            if ($key === '') $next['webSearchTavilyKey'] = '';
        }
        if (isset($b['webSearchSearxUrl'])) $next['webSearchSearxUrl'] = tc_searx_urls_text($b['webSearchSearxUrl']);
        if (isset($b['webSearchMaxResults'])) $next['webSearchMaxResults'] = (int) $b['webSearchMaxResults'];
        if (isset($b['parseSource'])) $next['parseSource'] = $b['parseSource'] === 'own' ? 'own' : 'platform';
        if (isset($b['mineruToken'])) {
            $token = trim((string) $b['mineruToken']);
            if ($token !== '' && strpos($token, '••') === false) $next['mineruToken'] = substr($token, 0, 300);
            if ($token === '') $next['mineruToken'] = '';
        }
        $user['tools'] = tc_user_tools(array('tools' => $next));
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'tools' => tc_user_tools_public($user, $db['settings'])));
    });
}

function tc_api_change_password() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $oldPwd = (string) (isset($b['oldPassword']) ? $b['oldPassword'] : '');
        $newPwd = (string) (isset($b['newPassword']) ? $b['newPassword'] : '');
        if (!tc_verify_password($oldPwd, $user)) tc_fail(400, '原密码不正确');
        if (strlen($newPwd) < 4) tc_fail(400, '新密码至少 4 个字符');
        if (strlen($newPwd) > 128) tc_fail(400, '新密码过长');
        if ($newPwd === $oldPwd) tc_fail(400, '新密码不能与原密码相同');
        tc_set_password($user, $newPwd);
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'token' => tc_issue_token($user, $db['settings'])));
    });
}

function tc_api_list_providers() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $allowed = tc_user_access($db, $user);
        $list = array();
        $enabledIds = array();
        $seen = array();
        foreach (tc_visible_providers_of($db, $user) as $p) {
            $vis = tc_visible_provider($user, $p, $allowed);
            if (!$vis) continue;
            $list[] = tc_client_provider($vis, isset($p['ownerId']) && $p['ownerId'] === $user['id'], !empty($user['admin']));
            $enabledIds[$p['id']] = true;
            $seen[$p['id']] = true;
        }
        // 已停用的全局供应商仅下发给管理员,后台才能重新启用;普通用户完全不可见
        if (!empty($user['admin'])) {
            foreach ($db['providers'] as $p) {
                if (isset($seen[$p['id']])) continue;
                if (!(isset($p['scope']) && $p['scope'] === 'global')) continue;
                $list[] = tc_client_provider($p, false, true);
                $seen[$p['id']] = true;
            }
        }
        // 默认供应商必须处于启用状态;被停用时对客户端视为无默认
        $defaultProviderId = $db['defaultProviderId'];
        if ($defaultProviderId && !isset($enabledIds[$defaultProviderId])) $defaultProviderId = null;
        tc_json(200, array(
            'providers' => $list,
            'defaultProviderId' => $defaultProviderId,
            'currentUserId' => $user['id'],
            'allowUserProviders' => !empty($db['settings']['allowUserProviders']),
            'isAdmin' => !empty($user['admin']),
            'webSearch' => tc_web_search_public($db['settings']),
            'mineru' => tc_mineru_public($db['settings']),
            'chatLimits' => array(
                'contextMessages' => isset($db['settings']['contextMessages']) ? (int) $db['settings']['contextMessages'] : 40,
                'maxContextMessages' => isset($db['settings']['maxContextMessages']) ? (int) $db['settings']['maxContextMessages'] : 200,
                'maxOutputTokens' => isset($db['settings']['maxOutputTokens']) ? (int) $db['settings']['maxOutputTokens'] : 12800,
            ),
        ));
    });
}

function tc_api_create_provider() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $wantGlobal = isset($b['scope']) && $b['scope'] === 'global' && !empty($user['admin']);
        if (!$wantGlobal && empty($db['settings']['allowUserProviders']) && empty($user['admin'])) {
            tc_fail(403, '管理员已关闭「用户自建供应商」功能');
        }
        $p = tc_normalize_provider_input($b, array('id' => tc_uid(), 'createdAt' => tc_now()));
        $err = tc_validate_provider($p);
        if ($err) tc_fail(400, $err);
        $p['updatedAt'] = tc_now();
        if ($wantGlobal) {
            $p['ownerId'] = null;
            $p['scope'] = 'global';
            if (!empty($b['default']) || empty($db['defaultProviderId'])) $db['defaultProviderId'] = $p['id'];
        } else {
            $p['ownerId'] = $user['id'];
            $p['scope'] = 'user';
        }
        if (!array_key_exists('keyRevealable', $p)) $p['keyRevealable'] = true;
        // Key 以 AES-256-GCM 加密落库,密文与供应商 id/属主绑定
        if (!tc_is_encrypted_secret($p['apiKey']) && !tc_provider_set_key($p, $p['apiKey'])) {
            tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        $db['providers'][] = $p;
        if ($wantGlobal) tc_grant_default_group_provider($db, $p['id']);
        tc_json(200, array('provider' => tc_client_provider($p, true, !empty($user['admin']))));
    });
}

function tc_api_update_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $p = tc_find_editable_provider($db, $user, $id);
        $next = tc_normalize_provider_input($b, $p);
        $err = tc_validate_provider($next);
        if ($err) tc_fail(400, $err);
        $next['updatedAt'] = tc_now();
        if (!tc_is_encrypted_secret($next['apiKey']) && !tc_provider_set_key($next, $next['apiKey'])) {
            tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        tc_replace_by_id($db['providers'], $id, $next);
        tc_json(200, array('provider' => tc_client_provider($next, true, !empty($user['admin']))));
    });
}

function tc_api_delete_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        tc_find_editable_provider($db, $user, $id);
        tc_remove_provider($db, $id);
        tc_json(200, array('ok' => true));
    });
}

// 点击小眼睛查看 Key:仅属主(个人供应商)或管理员(全局供应商),且保存时勾选了「保存后保持显示」
function tc_api_reveal_provider_key($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db);
        $p = null;
        foreach ($db['providers'] as $x) if ($x['id'] === $id) { $p = $x; break; }
        if (!$p) tc_fail(404, '供应商不存在');
        $isOwner = isset($p['ownerId']) && $p['ownerId'] === $user['id'];
        $isAdminGlobal = !empty($user['admin']) && (isset($p['scope']) && $p['scope'] === 'global');
        if (!$isOwner && !$isAdminGlobal) tc_fail(403, '只能查看自己添加的供应商密钥');
        if (empty($p['keyRevealable'])) tc_fail(403, '保存时未勾选「保存后保持显示」，Key 不可查看');
        $plain = tc_provider_key($p);
        if ($plain === '') tc_fail(404, 'Key 缺失或解密失败');
        tc_json(200, array('key' => $plain));
    });
}

function tc_api_get_global_provider() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $g = null;
        foreach ($db['providers'] as $p) {
            if (isset($p['scope']) && $p['scope'] === 'global' && tc_provider_enabled($p)) { $g = $p; break; }
        }
        if (!$g) tc_json(200, array('provider' => null));
        tc_json(200, array('provider' => tc_client_provider($g, false, !empty($user['admin']))));
    });
}

function tc_api_sync_get_chats() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_json(200, array(
            'chats' => tc_chats_of($db, $user['id']),
            'revision' => tc_chat_revision_of($db, $user['id']),
        ));
    });
}

function tc_api_sync_save_chats() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body(50 * 1024 * 1024);
        // 隐私模式:服务器不保存对话记录,客户端仅本地留存
        if (isset($db['settings']['persistChats']) && !$db['settings']['persistChats']) {
            tc_db_skip_write();
            tc_json(200, array('ok' => true, 'count' => 0, 'revision' => tc_chat_revision_of($db, $user['id']), 'persistChats' => false));
        }
        $current = tc_chat_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            tc_json(409, array(
                'error' => array('message' => '聊天记录已在其他页面更新'),
                'chats' => tc_chats_of($db, $user['id']),
                'revision' => $current,
            ));
        }
        $chats = tc_sanitize_chats(isset($b['chats']) ? $b['chats'] : array());
        tc_set_chats($db, $user['id'], $chats);
        tc_json(200, array(
            'ok' => true,
            'count' => count($chats),
            'revision' => tc_chat_revision_of($db, $user['id']),
        ));
    });
}

function tc_api_sync_clear_chats() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_set_chats($db, $user['id'], array());
        tc_json(200, array('ok' => true, 'revision' => tc_chat_revision_of($db, $user['id'])));
    });
}

function tc_api_create_share() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body(8 * 1024 * 1024);
        $title = substr(trim((string) (isset($b['title']) ? $b['title'] : '未命名对话')), 0, 120) ?: '未命名对话';
        $messages = tc_sanitize_share_messages(isset($b['messages']) ? $b['messages'] : array());
        if (!$messages) tc_fail(400, '对话为空，无法分享');
        $share = array(
            'id' => tc_uid(12),
            'ownerId' => $user['id'],
            'title' => $title,
            'messages' => $messages,
            'createdAt' => tc_now(),
            'updatedAt' => tc_now(),
        );
        $map = tc_assoc($db['shares']);
        $map[$share['id']] = $share;
        $db['shares'] = tc_object_map($map);
        tc_json(200, array('share' => tc_public_share($share), 'url' => '/s/' . $share['id']));
    });
}

function tc_api_get_share($id) {
    tc_with_db(false, function ($db) use ($id) {
        $map = tc_assoc($db['shares']);
        if (empty($map[$id])) tc_fail(404, '分享不存在或已失效');
        tc_json(200, array('share' => tc_public_share($map[$id])));
    });
}

function tc_api_admin_stats() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_backup_maybe($db['settings']);
        $days = tc_last_n_days(14);
        $byDay = tc_assoc($db['stats']['callsByDay']);
        $trend = array();
        foreach ($days as $d) $trend[] = array('day' => $d, 'calls' => isset($byDay[$d]) ? (int) $byDay[$d] : 0);
        $top = array();
        foreach ($db['users'] as $u) {
            $top[] = array(
                'id' => $u['id'], 'name' => $u['name'], 'quota' => isset($u['quota']) ? $u['quota'] : 0,
                'admin' => !empty($u['admin']), 'groupId' => isset($u['groupId']) ? $u['groupId'] : null,
            );
        }
        usort($top, function ($a, $b) {
            if ($a['quota'] == $b['quota']) return 0;
            return ($a['quota'] < $b['quota']) ? 1 : -1;
        });
        $top = array_slice($top, 0, 5);
        $adminCount = 0; $globalCount = 0; $globalDisabled = 0;
        foreach ($db['users'] as $u) if (!empty($u['admin'])) $adminCount++;
        foreach ($db['providers'] as $p) {
            if (!(isset($p['scope']) && $p['scope'] === 'global')) continue;
            if (tc_provider_enabled($p)) $globalCount++; else $globalDisabled++;
        }
        $mem = function_exists('memory_get_usage') ? (int) round(memory_get_usage(true) / 1048576) : 0;
        tc_json(200, array(
            'stats' => array(
                'totalCalls' => isset($db['stats']['totalCalls']) ? $db['stats']['totalCalls'] : 0,
                'totalQuotaGiven' => isset($db['stats']['totalQuotaGiven']) ? $db['stats']['totalQuotaGiven'] : 0,
                'userCount' => count($db['users']),
                'adminCount' => $adminCount,
                'providerCount' => count($db['providers']),
                'globalProviderCount' => $globalCount,
                'globalProviderDisabledCount' => $globalDisabled,
                'groupCount' => count($db['userGroups']),
                'defaultProviderId' => $db['defaultProviderId'],
                'todayCalls' => isset($byDay[tc_today_key()]) ? (int) $byDay[tc_today_key()] : 0,
                'trend' => $trend,
                'topUsers' => $top,
                'modelVotes' => tc_model_vote_rows($db),
                'usage' => tc_admin_usage_rows($db, tc_last_n_days(14)),
                'uptimeSec' => tc_uptime_sec(),
                'version' => TC_VERSION,
                'memoryMB' => $mem,
            ),
            'freeQuota' => $db['settings']['freeQuota'],
            'freeQuotaUnlimited' => !empty($db['settings']['freeQuotaUnlimited']),
            'settings' => tc_admin_settings_public($db['settings']),
        ));
    });
}

function tc_api_vote() {
    tc_with_db(true, function (&$db) {
        tc_require_auth($db);
        $b = tc_read_json_body();
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 80);
        if ($model === '') tc_fail(400, '缺少模型');
        $from = isset($b['from']) ? (string) $b['from'] : '';
        $to = isset($b['to']) ? (string) $b['to'] : '';
        if ($from !== '' && $from !== 'up' && $from !== 'down') tc_fail(400, '投票无效');
        if ($to !== '' && $to !== 'up' && $to !== 'down') tc_fail(400, '投票无效');
        tc_apply_model_vote($db, $model, $from, $to);
        $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
        $row = tc_assoc(isset($votes[$model]) ? $votes[$model] : array());
        tc_json(200, array(
            'ok' => true,
            'model' => $model,
            'up' => isset($row['up']) ? (int) $row['up'] : 0,
            'down' => isset($row['down']) ? (int) $row['down'] : 0,
        ));
    });
}

function tc_package_public($p) {
    return array('id' => $p['id'], 'name' => $p['name'], 'quota' => $p['quota'], 'priceLabel' => $p['priceLabel'], 'price' => isset($p['price']) ? $p['price'] : null, 'validityDays' => isset($p['validityDays']) ? (int) $p['validityDays'] : 0, 'limitPerUser' => isset($p['limitPerUser']) ? (int) $p['limitPerUser'] : 1, 'description' => $p['description'], 'purchaseUrl' => $p['purchaseUrl'], 'enabled' => !empty($p['enabled']));
}

function tc_api_list_packages() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $out = array();
        foreach ((array) $db['packages'] as $p) if (!empty($p['enabled'])) {
            $pub = tc_package_public($p);
            $pub['free'] = (isset($p['price']) && $p['price'] !== null && (float) $p['price'] == 0);
            if (!empty($pub['free'])) {
                $limit = isset($p['limitPerUser']) ? (int) $p['limitPerUser'] : 1;
                $claimed = 0;
                foreach ($db['quotaLedger'] as $e) {
                    if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'package_claim') && (isset($e['packageId']) && $e['packageId'] === $p['id'])) $claimed++;
                }
                $pub['claimedCount'] = $claimed;
                $pub['claimed'] = ($limit !== -1 && $claimed >= $limit);
            }
            $out[] = $pub;
        }
        tc_json(200, array('packages' => $out));
    });
}

function tc_api_admin_list_packages() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $pkgs = array(); foreach ((array) $db['packages'] as $p) $pkgs[$p['id']] = $p;
        $users = array(); foreach ((array) $db['users'] as $u) $users[$u['id']] = $u;
        $codes = array();
        foreach ((array) $db['redemptionCodes'] as $c) {
            $isFixed = (isset($c['type']) && $c['type'] === 'fixed');
            $pkg = (!$isFixed && isset($pkgs[$c['packageId']])) ? $pkgs[$c['packageId']] : null;
            $codes[] = array(
                'id' => $c['id'],
                'type' => $isFixed ? 'fixed' : 'random',
                // 固定码明文直接展示;随机码仍只给掩码,明文走导出接口
                'codeMask' => $isFixed ? (isset($c['code']) ? $c['code'] : '') : substr($c['codeHash'], 0, 10) . '…',
                'packageId' => $isFixed ? '' : $c['packageId'],
                'packageName' => $isFixed ? '固定兑换码' : ($pkg ? $pkg['name'] : '已删除套餐'),
                'status' => $c['status'],
                'quota' => $isFixed ? (isset($c['quota']) ? $c['quota'] : 0) : null,
                'maxRedemptions' => $isFixed ? (isset($c['maxRedemptions']) ? (int) $c['maxRedemptions'] : 1) : null,
                'usedCount' => $isFixed ? (isset($c['usedCount']) ? (int) $c['usedCount'] : 0) : null,
                'expiresAt' => $isFixed ? (isset($c['expiresAt']) ? (int) $c['expiresAt'] : 0) : null,
                'perUserLimit' => $isFixed ? !empty($c['perUserLimit']) : null,
                'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : '',
                'usedAt' => isset($c['usedAt']) ? $c['usedAt'] : '',
                'usedByName' => (isset($c['usedBy']) && isset($users[$c['usedBy']])) ? $users[$c['usedBy']]['name'] : '',
            );
        }
        tc_json(200, array('packages' => array_values($db['packages']), 'codes' => $codes));
    });
}

function tc_api_admin_delete_code($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $before = count($db['redemptionCodes']);
        $db['redemptionCodes'] = array_values(array_filter($db['redemptionCodes'], function ($c) use ($id) { return $c['id'] !== $id; }));
        if (count($db['redemptionCodes']) === $before) tc_fail(404, '兑换码不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_prune_codes() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $status = ($b['status'] ?? '') === 'unused' ? 'unused' : 'used';
        $packageId = trim((string) (isset($b['packageId']) ? $b['packageId'] : ''));
        $before = count($db['redemptionCodes']);
        $db['redemptionCodes'] = array_values(array_filter($db['redemptionCodes'], function ($c) use ($status, $packageId) {
            if ((isset($c['status']) ? $c['status'] : 'unused') !== $status) return true;
            if ($packageId !== '' && (isset($c['packageId']) ? $c['packageId'] : '') !== $packageId) return true;
            return false;
        }));
        tc_json(200, array('ok' => true, 'removed' => $before - count($db['redemptionCodes'])));
    });
}

// 按套餐导出未使用兑换码的明文(旧版码只存哈希,无法导出)
function tc_api_admin_export_codes($id) {
    tc_with_db(false, function ($db) use ($id) {
        tc_require_admin($db);
        $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $id) $pkg = $p;
        if (!$pkg) tc_fail(404, '套餐不存在');
        $codes = array(); $missing = 0;
        foreach ((array) $db['redemptionCodes'] as $c) {
            if ((isset($c['packageId']) ? $c['packageId'] : '') !== $id) continue;
            if ((isset($c['status']) ? $c['status'] : 'unused') !== 'unused') continue;
            if (!empty($c['code'])) $codes[] = array('code' => $c['code'], 'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0);
            else $missing++;
        }
        tc_json(200, array('packageName' => $pkg['name'], 'codes' => $codes, 'count' => count($codes), 'missing' => $missing));
    });
}

function tc_api_admin_save_package() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db); $b = tc_read_json_body();
        $id = trim((string) (isset($b['id']) ? $b['id'] : ''));
        $price = (isset($b['price']) && (string) $b['price'] !== '') ? round((float) $b['price'], 2) : null;
        if ($price !== null && $price < 0) $price = 0;
        $validityDays = (isset($b['validityDays']) && (string) $b['validityDays'] !== '') ? max(0, (int) $b['validityDays']) : 0;
        $limitPerUser = (int) (isset($b['limitPerUser']) ? $b['limitPerUser'] : 1);
        $limitPerUser = max(-1, min(999, $limitPerUser));
        $p = array('id' => $id ?: tc_uid(8), 'name' => substr(trim((string) ($b['name'] ?? '')), 0, 80), 'quota' => ((string) ($b['quota'] ?? '') === '-1' ? -1 : max(0, (int) ($b['quota'] ?? 0))), 'priceLabel' => substr(trim((string) ($b['priceLabel'] ?? '')), 0, 60), 'price' => $price, 'validityDays' => $validityDays, 'limitPerUser' => $limitPerUser, 'description' => substr(trim((string) ($b['description'] ?? '')), 0, 500), 'purchaseUrl' => preg_match('/^https?:\/\//i', trim((string) ($b['purchaseUrl'] ?? ''))) ? substr(trim((string) ($b['purchaseUrl'] ?? '')), 0, 500) : '', 'enabled' => !empty($b['enabled']), 'createdAt' => tc_now());
        if ($p['name'] === '' || ($p['quota'] === 0 && $p['quota'] !== -1)) tc_fail(400, '套餐名称和额度不能为空');
        if ($id === '') { foreach ($db['packages'] as $old) if ($old['id'] === $p['id']) tc_fail(409, '套餐 ID 冲突'); }
        $found = false; foreach ($db['packages'] as $i => $old) if ($old['id'] === $p['id']) { $p['createdAt'] = $old['createdAt'] ?? $p['createdAt']; $db['packages'][$i] = $p; $found = true; }
        if (!$found) $db['packages'][] = $p;
        tc_json(200, array('package' => $p));
    });
}

// 0 元套餐直接领取:每个用户每套餐限领一次
function tc_api_claim_package() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db); $b = tc_read_json_body();
        $pid = trim((string) (isset($b['packageId']) ? $b['packageId'] : ''));
        $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $pid) $pkg = $p;
        if (!$pkg) tc_fail(404, '套餐不存在');
        if (empty($pkg['enabled'])) tc_fail(410, '套餐已停用');
        if (!isset($pkg['price']) || $pkg['price'] === null || (float) $pkg['price'] > 0) tc_fail(400, '该套餐不是免费套餐，请通过购买链接或兑换码开通');
        // 每人可领取次数:-1 不限,0 不可领取,>=1 每人限 N 次
        $limit = isset($pkg['limitPerUser']) ? (int) $pkg['limitPerUser'] : 1;
        $claimed = 0;
        foreach ($db['quotaLedger'] as $e) {
            if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'package_claim') && (isset($e['packageId']) && $e['packageId'] === $pid)) $claimed++;
        }
        if ($limit === 0) tc_fail(400, '该套餐未开放领取');
        if ($limit !== -1 && $claimed >= $limit) tc_fail(409, '该套餐每人限领 ' . $limit . ' 次，你已领取 ' . $claimed . ' 次');
        tc_enforce_quota_expiry($db, $user);
        $exp = (!empty($pkg['validityDays']) && $pkg['quota'] !== -1) ? tc_now() + ((int) $pkg['validityDays']) * 86400000 : 0;
        tc_add_quota($db, $user, $pkg['quota'], $exp);
        $entry = array('id' => tc_uid(8), 'userId' => $user['id'], 'amount' => $pkg['quota'], 'source' => 'package_claim', 'packageId' => $pkg['id'], 'packageName' => $pkg['name'], 'createdAt' => tc_now());
        if ($exp > 0) $entry['expiresAt'] = $exp;
        $db['quotaLedger'][] = $entry;
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_thinking() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('thinking' => tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null)));
    });
}

function tc_api_admin_save_thinking() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $t = is_array(isset($b['thinking']) ? $b['thinking'] : null) ? $b['thinking'] : array();
        $cur = tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null);
        $submitted = tc_normalize_thinking(array(
            'defaultEffort' => isset($t['defaultEffort']) ? $t['defaultEffort'] : 'medium',
            'allowUserOverride' => isset($t['allowUserOverride']) ? $t['allowUserOverride'] : true,
            'autoLearn' => isset($t['autoLearn']) ? $t['autoLearn'] : true,
            'rules' => isset($t['rules']) ? $t['rules'] : array(),
        ));
        // 页面打开期间可能有新的自动学习结果:提交里没有、且未被显式删除的自动规则保留
        $deletedAuto = array();
        foreach ((array) (isset($b['deletedAutoIds']) ? $b['deletedAutoIds'] : array()) as $id) $deletedAuto[] = (string) $id;
        $submittedAutoIds = array();
        foreach ($submitted['rules'] as $r) if (($r['source'] ?? '') === 'auto') $submittedAutoIds[] = $r['id'];
        $keptAuto = array();
        foreach ($cur['rules'] as $r) {
            if (($r['source'] ?? '') !== 'auto') continue;
            if (in_array((string) $r['id'], $deletedAuto, true)) continue;
            if (in_array((string) $r['id'], $submittedAutoIds, true)) continue;
            $keptAuto[] = $r;
        }
        $final = $submitted;
        $final['rules'] = array_merge($keptAuto, $submitted['rules']);
        $db['settings']['thinking'] = tc_normalize_thinking($final);
        tc_json(200, array('thinking' => $db['settings']['thinking']));
    });
}

function tc_api_admin_delete_package($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $before = count($db['packages']);
        $db['packages'] = array_values(array_filter($db['packages'], function ($p) use ($id) { return $p['id'] !== $id; }));
        if (count($db['packages']) === $before) tc_fail(404, '套餐不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_generate_codes($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db); $b = tc_read_json_body(); $n = min(500, max(1, (int) ($b['count'] ?? 1))); $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $id) $pkg = $p; if (!$pkg) tc_fail(404, '套餐不存在');
        // 明文与哈希同时保存,供之后按套餐导出未使用兑换码
        $plain = array(); for ($i=0; $i<$n; $i++) { $code = strtoupper(bin2hex(random_bytes(8))); $db['redemptionCodes'][] = array('id'=>tc_uid(8),'packageId'=>$id,'type'=>'random','code'=>$code,'codeHash'=>hash('sha256', $code),'status'=>'unused','createdAt'=>tc_now()); $plain[] = $code; }
        tc_json(200, array('codes' => $plain, 'count' => count($plain)));
    });
}

// 添加固定兑换码:自定义码面,可设置总可兑换次数、每次兑换所得可用次数与有效期
function tc_api_admin_create_fixed_code() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db); $b = tc_read_json_body();
        $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?? '')));
        if (strlen($code) < 4 || strlen($code) > 64) tc_fail(400, '兑换码需为 4-64 位字母或数字');
        $hash = hash('sha256', $code);
        foreach ($db['redemptionCodes'] as $c) if ($c['codeHash'] === $hash) tc_fail(409, '该兑换码已存在');
        $quotaRaw = (string) (isset($b['quota']) ? $b['quota'] : '');
        if ($quotaRaw === '-1') $quota = -1; else { $quota = (int) $quotaRaw; if ($quota < 1) tc_fail(400, '可用次数需大于 0,或填 -1 表示无限'); }
        $maxRedemptions = min(1000000, max(1, (int) ($b['maxRedemptions'] ?? 1)));
        $expiresAt = 0;
        if (isset($b['expiresAt']) && (string) $b['expiresAt'] !== '') {
            $expiresAt = (int) $b['expiresAt'];
            if ($expiresAt <= tc_now()) tc_fail(400, '有效期必须晚于当前时间');
        }
        $row = array('id' => tc_uid(8), 'type' => 'fixed', 'code' => $code, 'codeHash' => $hash, 'status' => 'unused', 'quota' => $quota, 'maxRedemptions' => $maxRedemptions, 'usedCount' => 0, 'perUserLimit' => !empty($b['perUserLimit']), 'expiresAt' => $expiresAt, 'createdAt' => tc_now());
        $db['redemptionCodes'][] = $row;
        tc_json(200, array('ok' => true, 'code' => $row));
    });
}

function tc_api_redeem_package() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db); $b = tc_read_json_body(); $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?? ''))); if ($code === '') tc_fail(400, '请输入兑换码');
        $hash = hash('sha256', $code); $idx = -1; foreach ($db['redemptionCodes'] as $i => $row) if ($row['codeHash'] === $hash) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '兑换码无效'); $row = $db['redemptionCodes'][$idx];
        // 固定兑换码:不挂套餐,按码上设置的总次数/可用次数/有效期兑换
        if (isset($row['type']) && $row['type'] === 'fixed') {
            if ($row['status'] === 'used') tc_fail(409, '兑换码已达兑换次数上限');
            if (!empty($row['expiresAt']) && tc_now() > (int) $row['expiresAt']) tc_fail(410, '兑换码已过期');
            if (!empty($row['perUserLimit'])) {
                foreach ($db['quotaLedger'] as $e) {
                    if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'fixed_code') && (isset($e['codeId']) && $e['codeId'] === $row['id'])) tc_fail(409, '你已经兑换过该兑换码');
                }
            }
            $quota = isset($row['quota']) ? (int) $row['quota'] : 0;
            tc_add_quota($db, $user, $quota);
            $row['usedCount'] = (isset($row['usedCount']) ? (int) $row['usedCount'] : 0) + 1;
            $row['usedAt'] = tc_now(); $row['usedBy'] = $user['id'];
            if ($row['usedCount'] >= (isset($row['maxRedemptions']) ? (int) $row['maxRedemptions'] : 1)) $row['status'] = 'used';
            $db['redemptionCodes'][$idx] = $row;
            $db['quotaLedger'][] = array('id' => tc_uid(8), 'userId' => $user['id'], 'amount' => $quota, 'source' => 'fixed_code', 'codeId' => $row['id'], 'packageName' => '固定兑换码 ' . $code, 'createdAt' => tc_now());
            tc_replace_user($db, $user); tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($user)));
        }
        if ($row['status'] !== 'unused') tc_fail(409, '兑换码已使用'); $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $row['packageId']) $pkg = $p; if (!$pkg) tc_fail(410, '套餐已不存在');
        if (empty($pkg['enabled'])) tc_fail(410, '套餐已停用');
        tc_enforce_quota_expiry($db, $user);
        $exp = (!empty($pkg['validityDays']) && $pkg['quota'] !== -1) ? tc_now() + ((int) $pkg['validityDays']) * 86400000 : 0;
        tc_add_quota($db, $user, $pkg['quota'], $exp); $db['redemptionCodes'][$idx]['status'] = 'used'; $db['redemptionCodes'][$idx]['usedAt'] = tc_now(); $db['redemptionCodes'][$idx]['usedBy'] = $user['id']; $ledgerEntry = array('id'=>tc_uid(8),'userId'=>$user['id'],'amount'=>$pkg['quota'],'source'=>'package','packageId'=>$pkg['id'],'packageName'=>$pkg['name'],'createdAt'=>tc_now());
        if ($exp > 0) $ledgerEntry['expiresAt'] = $exp;
        $db['quotaLedger'][] = $ledgerEntry; tc_replace_user($db, $user); tc_json(200, array('ok'=>true,'user'=>tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_settings() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_backup_maybe($db['settings']);
        tc_json(200, array('settings' => tc_admin_settings_public($db['settings'])));
    });
}

// 强制全站下线:会话纪元 +1,所有已签发的令牌立即失效
function tc_api_admin_invalidate_sessions() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $db['settings']['authEpoch'] = (int) (isset($db['settings']['authEpoch']) ? $db['settings']['authEpoch'] : 1) + 1;
        tc_json(200, array('ok' => true, 'authEpoch' => (int) $db['settings']['authEpoch']));
    });
}

// ---- 用户 API 密钥(OpenAI 兼容出口用) ----
function tc_api_key_public($k) {
    return array(
        'id' => $k['id'],
        'name' => isset($k['name']) ? $k['name'] : '',
        'prefix' => isset($k['prefix']) ? $k['prefix'] : '',
        'createdAt' => isset($k['createdAt']) ? (int) $k['createdAt'] : 0,
        'lastUsed' => isset($k['lastUsed']) ? (int) $k['lastUsed'] : 0,
    );
}

function tc_api_me_apikeys_list() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $keys = array();
        foreach ((isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array()) as $k) {
            if (is_array($k)) $keys[] = tc_api_key_public($k);
        }
        tc_json(200, array('keys' => $keys, 'enabled' => !empty($db['settings']['apiKeysEnabled'])));
    });
}

function tc_api_me_apikeys_create() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        if (empty($db['settings']['apiKeysEnabled'])) tc_fail(403, '管理员已关闭 API 密钥功能');
        $b = tc_read_json_body();
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        $existing = isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array();
        if (count($existing) >= 5) tc_fail(400, '最多保留 5 个 API 密钥，请先删除不再使用的');
        $key = tc_api_key_generate();
        $record = array('id' => tc_uid(8), 'name' => $name !== '' ? $name : 'API Key', 'hash' => tc_api_key_hash($key), 'prefix' => tc_api_key_prefix($key), 'createdAt' => tc_now(), 'lastUsed' => 0);
        $existing[] = $record;
        $user['apiKeys'] = $existing;
        tc_replace_user($db, $user);
        tc_json(200, array('key' => tc_api_key_public($record), 'secret' => $key));
    });
}

function tc_api_me_apikeys_delete($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $list = isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array();
        $kept = array_values(array_filter($list, function ($k) use ($id) { return is_array($k) && isset($k['id']) && $k['id'] !== $id; }));
        if (count($kept) === count($list)) tc_fail(404, '密钥不存在');
        $user['apiKeys'] = $kept;
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true));
    });
}

// 用户协议页(/agreement):展示后台保存的 HTML 正文,未启用时 404
function tc_api_agreement_page() {
    $settings = tc_with_db(false, function ($db) {
        return $db['settings'];
    });
    if (empty($settings['agreementEnabled']) || trim((string) $settings['agreementHtml']) === '') {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '站点未启用用户协议';
        exit;
    }
    $site = htmlspecialchars((string) (isset($settings['siteName']) ? $settings['siteName'] : 'TinyChat'), ENT_QUOTES, 'UTF-8');
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    echo '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>用户协议 · ' . $site . '</title><meta name="robots" content="noindex,nofollow"></head>'
        . '<body style="margin:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">'
        . '<div style="max-width:720px;margin:0 auto;padding:36px 16px;">'
        . '<div style="background:#fff;border-radius:16px;padding:32px 28px;box-shadow:0 1px 3px rgba(15,23,42,.06);">'
        . '<h1 style="margin:0 0 20px;font-size:22px;color:#0f172a;">' . $site . ' 用户协议</h1>'
        . '<div style="font-size:14px;line-height:1.9;color:#334155;word-break:break-word;">' . $settings['agreementHtml'] . '</div>'
        . '<p style="margin:28px 0 0;font-size:12px;color:#94a3b8;text-align:center;">以上内容由 ' . $site . ' 管理员配置</p>'
        . '</div></div></body></html>';
    exit;
}

function tc_api_admin_save_settings() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $src = isset($b['settings']) && is_array($b['settings']) ? $b['settings'] : $b;
        if (isset($src['webSearchTavilyKey']) && strpos((string) $src['webSearchTavilyKey'], '••') !== false) {
            unset($src['webSearchTavilyKey']);
        }
        if (isset($src['mineruToken']) && strpos((string) $src['mineruToken'], '••') !== false) {
            unset($src['mineruToken']);
        }
        if (isset($src['smtp']) && is_array($src['smtp']) && isset($src['smtp']['password']) && strpos((string) $src['smtp']['password'], '••') !== false) {
            $src['smtp']['password'] = $db['settings']['smtp']['password'] ?? '';
        }
        unset($src['defaultGroupId']);
        $db['settings'] = tc_normalize_settings(array_merge($db['settings'], $src));
        tc_json(200, array('settings' => tc_admin_settings_public($db['settings'])));
    });
}

// ---- 在线更新(逻辑在 lib/updater.php)----
function tc_api_admin_update_check() {
    $q = tc_query();
    tc_with_db(false, function ($db) { tc_require_admin($db); });
    try {
        $result = tc_update_check(!empty($q['force']));
    } catch (Exception $e) {
        tc_fail(502, $e->getMessage());
    }
    tc_json(200, $result);
}

function tc_api_admin_update_perform() {
    tc_with_db(false, function ($db) { tc_require_admin($db); });
    tc_update_perform();
}

// 发送测试邮件:用当前"注册验证邮件"模板渲染样例内容,真实走一遍 SMTP 流程
function tc_api_admin_test_email() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_admin($db);
        $b = tc_read_json_body();
        $to = strtolower(trim((string) ($b['to'] ?? '')));
        if ($to === '') $to = strtolower(trim((string) ($user['email'] ?? '')));
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) tc_fail(400, '请填写有效的测试收件邮箱');
        $s = $db['settings'];
        if (empty($s['smtp']['host'])) tc_fail(400, '请先保存 SMTP 服务器配置');
        $link = tc_public_base_url() . '/login';
        [$subject, $html] = tc_render_mail_template($s, 'verify', $user['name'], $link, '30 分钟');
        $ok = tc_mail_send($s, $to, $subject, $html, '', $err);
        tc_push_log(array('kind' => 'mail', 'userName' => $user['name'], 'action' => $ok ? ('发送测试邮件到 ' . $to) : ('测试邮件发送失败: ' . $err)));
        if (!$ok) tc_fail(502, $err !== '' ? $err : '测试邮件发送失败，请检查 SMTP 配置');
        tc_json(200, array('ok' => true, 'to' => $to));
    });
}

// 下发内置默认邮件模板,供后台"恢复默认模板"使用
function tc_api_admin_mail_template_defaults() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('templates' => tc_mail_default_templates()));
    });
}

function tc_api_admin_logs() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $q = tc_query();
        tc_json(200, array('logs' => tc_list_logs(isset($q['limit']) ? $q['limit'] : 100), 'limit' => TC_LOG_LIMIT));
    });
}

function tc_api_admin_delete_logs() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_clear_logs();
        tc_json(200, array('ok' => true));
    });
}

// ---- 数据备份 ----
function tc_api_admin_backup_list() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_backup_maybe($db['settings']);
        tc_json(200, array(
            'backups' => tc_backup_list(),
            'backupEnabled' => !empty($db['settings']['backupEnabled']),
            'backupKeep' => (int) $db['settings']['backupKeep'],
        ));
    });
}

function tc_api_admin_backup_create() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $name = tc_backup_create();
        if ($name === null) tc_fail(500, '备份创建失败，请检查 data/backup 目录写权限');
        tc_backup_prune($db['settings']);
        tc_db_skip_write();
        tc_json(200, array('ok' => true, 'created' => $name, 'backups' => tc_backup_list()));
    });
}

function tc_api_admin_backup_download() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $q = tc_query();
        $full = tc_backup_path(isset($q['id']) ? $q['id'] : '');
        if ($full === '') tc_fail(404, '备份不存在');
        tc_db_commit();
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . basename($full) . '"');
        header('Content-Length: ' . (string) filesize($full));
        header('Cache-Control: no-store');
        readfile($full);
        exit;
    });
}

function tc_api_admin_backup_restore() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $full = tc_backup_path(isset($b['id']) ? $b['id'] : '');
        if ($full === '') tc_fail(404, '备份不存在');
        $raw = @file_get_contents($full);
        $data = json_decode((string) $raw, true);
        if (!is_array($data) || empty($data['users'])) tc_fail(400, '备份文件损坏或不是有效的数据库备份');
        // 用备份内容整体替换当前数据库,走统一的迁移与提交流程
        $db = tc_migrate_db($data);
        tc_json(200, array('ok' => true, 'restoredAt' => tc_now(), 'users' => count($db['users'])));
    });
}

function tc_api_admin_user_chats() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $q = tc_query();
        $userId = isset($q['userId']) ? $q['userId'] : '';
        $targets = array();
        if ($userId) {
            foreach ($db['users'] as $u) if ($u['id'] === $userId) { $targets[] = $u; break; }
            if (!$targets) tc_fail(404, '用户不存在');
        } else {
            $targets = $db['users'];
        }
        $out = array();
        foreach ($targets as $u) {
            $chats = array();
            foreach (tc_chats_of($db, $u['id']) as $c) {
                $msgs = array();
                if (isset($c['messages']) && is_array($c['messages'])) {
                    foreach (array_slice($c['messages'], -50) as $m) {
                        $msgs[] = array(
                            'role' => isset($m['role']) ? $m['role'] : 'assistant',
                            'content' => substr((string) (isset($m['content']) ? $m['content'] : ''), 0, 2000),
                            'error' => !empty($m['error']),
                            'createdAt' => isset($m['createdAt']) ? $m['createdAt'] : 0,
                        );
                    }
                }
                $chats[] = array(
                    'id' => $c['id'],
                    'title' => isset($c['title']) ? $c['title'] : '新对话',
                    'pinned' => !empty($c['pinned']),
                    'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0,
                    'updatedAt' => isset($c['updatedAt']) ? $c['updatedAt'] : 0,
                    'messages' => $msgs,
                );
            }
            if ($chats || $userId) $out[] = array('user' => tc_sanitize_user($u), 'chats' => $chats);
        }
        tc_json(200, array('total' => count($out), 'usersChats' => $out, 'single' => !!$userId));
    });
}

function tc_api_admin_users() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $q = tc_query();
        $kw = strtolower(trim(isset($q['q']) ? $q['q'] : ''));
        $users = array();
        foreach ($db['users'] as $u) {
            $pc = 0;
            foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $u['id']) $pc++;
            $row = tc_sanitize_user($u);
            $row['chatCount'] = count(tc_chats_of($db, $u['id']));
            $row['providerCount'] = $pc;
            if ($kw !== '' && strpos(strtolower($u['name']), $kw) === false) continue;
            $users[] = $row;
        }
        usort($users, function ($a, $b) { return ($b['createdAt'] ?: 0) - ($a['createdAt'] ?: 0); });
        tc_json(200, array('users' => $users, 'total' => count($users)));
    });
}

function tc_api_admin_create_user() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4) tc_fail(400, '密码至少 4 个字符');
        foreach ($db['users'] as $u) if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => 0, 'createdAt' => tc_now(), 'admin' => !empty($b['admin']),
            'groupId' => !empty($b['admin'])
                ? (($ag = tc_find_builtin_group($db, 'admin')) ? $ag['id'] : tc_default_register_group($db))
                : tc_default_register_group($db),
            'tv' => 0,
        );
        tc_set_password($user, $password);
        $db['users'][] = $user;
        $quota = array_key_exists('quota', $b) ? max(0, (float) $b['quota']) : $db['settings']['freeQuota'];
        if ($quota > 0) tc_add_quota($db, $user, $quota);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_update_user() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        if (array_key_exists('password', $b) && (string) $b['password'] !== '') {
            $pwd = (string) $b['password'];
            if (strlen($pwd) < 4) tc_fail(400, '密码至少 4 个字符');
            tc_set_password($user, $pwd);
        }
        if (array_key_exists('admin', $b)) {
            $nextAdmin = !empty($b['admin']);
            if ($user['id'] === $admin['id'] && !$nextAdmin) tc_fail(400, '不能取消自己的管理员权限');
            if (!empty($user['admin']) && !$nextAdmin) {
                $n = 0; foreach ($db['users'] as $u) if (!empty($u['admin'])) $n++;
                if ($n <= 1) tc_fail(400, '至少需要保留一个管理员');
            }
            $user['admin'] = $nextAdmin;
            if ($nextAdmin) {
                $ag = tc_find_builtin_group($db, 'admin');
                if ($ag && !empty($ag['id'])) $user['groupId'] = $ag['id'];
            } else {
                $ag = tc_find_builtin_group($db, 'admin');
                $gid = isset($user['groupId']) ? (string) $user['groupId'] : '';
                if ($ag && $gid === (string) $ag['id']) $user['groupId'] = tc_default_register_group($db);
            }
        }
        if (array_key_exists('name', $b)) {
            $name = trim((string) $b['name']);
            if ($name === '') tc_fail(400, '用户名不能为空');
            foreach ($db['users'] as $u) {
                if ($u['id'] !== $user['id'] && strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
            }
            $user['name'] = $name;
        }
        tc_replace_user($db, $user);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_set_quota() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        tc_enforce_quota_expiry($db, $user);
        if (array_key_exists('delta', $b)) {
            $d = (float) $b['delta'];
            if ($d == 0) tc_fail(400, '增量无效');
            if ($d > 0) tc_add_quota($db, $user, $d);
            else {
                tc_enforce_quota_expiry($db, $user);
                $user['quota'] = max(0, (isset($user['quota']) ? (float) $user['quota'] : 0) + $d);
                // 管理员手动扣减同样核销分账,保持"账面 = 无期限额度 + Σ分账剩余"的等式
                tc_consume_quota_grants($user, -$d);
                tc_replace_user($db, $user);
            }
        } else {
            $q = (float) $b['quota'];
            if ($q < 0) tc_fail(400, '额度必须是 >= 0 的数字');
            tc_enforce_quota_expiry($db, $user);
            $cur = isset($user['quota']) ? (float) $user['quota'] : 0;
            if ($q > $cur) $db['stats']['totalQuotaGiven'] = (isset($db['stats']['totalQuotaGiven']) ? (float) $db['stats']['totalQuotaGiven'] : 0) + ($q - $cur);
            $user['quota'] = $q;
            // 绝对值设置视为管理员全权重覆盖:清空分账,余额不再受有效期约束
            $user['quotaGrants'] = array();
            tc_replace_user($db, $user);
        }
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_delete_user($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $admin = tc_require_admin($db);
        $idx = -1;
        foreach ($db['users'] as $i => $u) if ($u['id'] === $id) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '用户不存在');
        if ($db['users'][$idx]['id'] === $admin['id']) tc_fail(400, '不能删除当前登录的管理员账号');
        array_splice($db['users'], $idx, 1);
        $map = tc_assoc($db['userChats']);
        unset($map[$id]);
        $db['userChats'] = tc_object_map($map);
        $ownIds = array();
        foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $id) $ownIds[] = $p['id'];
        foreach ($ownIds as $pid) tc_remove_provider($db, $pid);
        tc_json(200, array('ok' => true, 'removedProviders' => count($ownIds)));
    });
}

function tc_api_admin_groups() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $groups = array();
        foreach ($db['userGroups'] as $g) {
            $mc = 0; $rc = 0;
            foreach ($db['users'] as $u) if (isset($u['groupId']) && $u['groupId'] === $g['id']) $mc++;
            foreach ($db['accessRules'] as $r) if ($r['groupId'] === $g['id']) $rc++;
            $groups[] = array(
                'id' => $g['id'],
                'name' => $g['name'],
                'createdAt' => $g['createdAt'],
                'builtin' => !empty($g['builtin']),
                'memberCount' => $mc,
                'ruleCount' => $rc,
            );
        }
        tc_json(200, array('groups' => $groups, 'defaultGroupId' => tc_default_register_group($db)));
    });
}

function tc_api_admin_create_group() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        if ($name === '') tc_fail(400, '组名不能为空');
        foreach ($db['userGroups'] as $g) if ($g['name'] === $name) tc_fail(409, '组名已存在');
        $group = array('id' => tc_uid(), 'name' => $name, 'createdAt' => tc_now());
        $db['userGroups'][] = $group;
        tc_json(200, array('group' => array_merge($group, array('memberCount' => 0, 'ruleCount' => 0))));
    });
}

function tc_api_admin_update_group($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $g = null;
        foreach ($db['userGroups'] as $x) if ($x['id'] === $id) { $g = $x; break; }
        if (!$g) tc_fail(404, '组不存在');
        if (!empty($g['builtin'])) tc_fail(400, '系统用户组不能改名');
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        if ($name === '') tc_fail(400, '组名不能为空');
        foreach ($db['userGroups'] as $x) if ($x['id'] !== $id && $x['name'] === $name) tc_fail(409, '组名已存在');
        $g['name'] = $name;
        tc_replace_by_id($db['userGroups'], $id, $g);
        tc_json(200, array('group' => $g));
    });
}

function tc_api_admin_delete_group($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $idx = -1;
        foreach ($db['userGroups'] as $i => $g) if ($g['id'] === $id) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '组不存在');
        if (!empty($db['userGroups'][$idx]['builtin'])) tc_fail(400, '系统用户组不能删除');
        array_splice($db['userGroups'], $idx, 1);
        foreach ($db['users'] as &$u) if (isset($u['groupId']) && $u['groupId'] === $id) $u['groupId'] = null;
        unset($u);
        $rules = array();
        foreach ($db['accessRules'] as $r) if ($r['groupId'] !== $id) $rules[] = $r;
        $db['accessRules'] = $rules;
        if (isset($db['settings']['defaultGroupId']) && (string) $db['settings']['defaultGroupId'] === (string) $id) {
            $db['settings']['defaultGroupId'] = '';
            tc_ensure_default_group($db);
        }
        tc_json(200, array('ok' => true, 'defaultGroupId' => tc_default_register_group($db)));
    });
}

function tc_grant_default_group_provider(&$db, $providerId) {
    if (!$providerId) return;
    $ids = array();
    $user = tc_find_builtin_group($db, 'user');
    $admin = tc_find_builtin_group($db, 'admin');
    if ($user && !empty($user['id'])) $ids[] = $user['id'];
    if ($admin && !empty($admin['id'])) $ids[] = $admin['id'];
    if (!$ids) {
        $fallback = tc_default_register_group($db);
        if ($fallback) $ids[] = $fallback;
    }
    foreach ($ids as $gid) {
        $exists = false;
        foreach ($db['accessRules'] as $r) {
            if ($r['groupId'] === $gid && $r['providerId'] === $providerId) { $exists = true; break; }
        }
        if ($exists) continue;
        $db['accessRules'][] = array('id' => tc_uid(), 'groupId' => $gid, 'providerId' => $providerId, 'modelIds' => array('*'));
    }
}

function tc_api_admin_set_default_group() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $groupId = isset($b['groupId']) ? trim((string) $b['groupId']) : '';
        $group = $groupId !== '' ? tc_group_by_id($db, $groupId) : null;
        if (!$group) tc_fail(400, '请选择一个用户组');
        if (isset($group['role']) && $group['role'] === 'admin') tc_fail(400, '管理员组不能作为注册默认组');
        $db['settings']['defaultGroupId'] = $groupId;
        tc_json(200, array('defaultGroupId' => $groupId));
    });
}

function tc_api_admin_set_user_group() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        $groupId = !empty($b['groupId']) ? (string) $b['groupId'] : null;
        if ($groupId) {
            $ok = false;
            foreach ($db['userGroups'] as $g) if ($g['id'] === $groupId) { $ok = true; break; }
            if (!$ok) tc_fail(404, '组不存在');
        }
        if (!empty($user['admin'])) {
            $ag = tc_find_builtin_group($db, 'admin');
            if (!$ag || (string) $ag['id'] !== (string) $groupId) tc_fail(400, '管理员只能属于管理员组');
        } elseif ($groupId) {
            $picked = tc_group_by_id($db, $groupId);
            if ($picked && isset($picked['role']) && $picked['role'] === 'admin') tc_fail(400, '普通用户不能加入管理员组');
        }
        $user['groupId'] = $groupId;
        tc_replace_user($db, $user);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_access() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('rules' => $db['accessRules']));
    });
}

function tc_api_admin_set_access() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        if (isset($b['rules']) && is_array($b['rules'])) {
            $rules = array();
            foreach ($b['rules'] as $r) {
                if (!$r || empty($r['groupId']) || empty($r['providerId'])) continue;
                $rules[] = array(
                    'id' => !empty($r['id']) ? $r['id'] : tc_uid(),
                    'groupId' => (string) $r['groupId'],
                    'providerId' => (string) $r['providerId'],
                    'modelIds' => isset($r['modelIds']) && is_array($r['modelIds']) ? array_map('strval', $r['modelIds']) : array(),
                );
            }
            $db['accessRules'] = $rules;
            tc_json(200, array('rules' => $db['accessRules']));
        }
        $groupId = (string) (isset($b['groupId']) ? $b['groupId'] : '');
        $providerId = (string) (isset($b['providerId']) ? $b['providerId'] : '');
        if ($groupId === '' || $providerId === '') tc_fail(400, '请选择用户组和供应商');
        $okG = false; $okP = false;
        foreach ($db['userGroups'] as $g) if ($g['id'] === $groupId) $okG = true;
        foreach ($db['providers'] as $p) if ($p['id'] === $providerId) $okP = true;
        if (!$okG) tc_fail(404, '组不存在');
        if (!$okP) tc_fail(404, '供应商不存在');
        $targetGroup = tc_group_by_id($db, $groupId);
        if ($targetGroup && isset($targetGroup['role']) && $targetGroup['role'] === 'admin') {
            tc_fail(400, '管理员组始终拥有全部模型，不能修改授权');
        }
        $modelIds = isset($b['modelIds']) && is_array($b['modelIds']) ? array_map('strval', $b['modelIds']) : array();
        $idx = -1;
        foreach ($db['accessRules'] as $i => $r) {
            if ($r['groupId'] === $groupId && $r['providerId'] === $providerId) { $idx = $i; break; }
        }
        if (!$modelIds) {
            if ($idx >= 0) array_splice($db['accessRules'], $idx, 1);
        } else {
            $rule = array('id' => $idx >= 0 ? $db['accessRules'][$idx]['id'] : tc_uid(), 'groupId' => $groupId, 'providerId' => $providerId, 'modelIds' => $modelIds);
            if ($idx >= 0) $db['accessRules'][$idx] = $rule; else $db['accessRules'][] = $rule;
        }
        tc_json(200, array('rules' => $db['accessRules']));
    });
}

function tc_api_list_assistants() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_seed_default_assistants($db);
        tc_json(200, tc_merge_assistant_catalog($db, $user));
    });
}

function tc_api_create_assistant_category() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_category_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach (tc_visible_assistant_categories($db, $user) as $c) {
            if ($c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $category = array(
            'id' => tc_uid(), 'name' => $parsed['name'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'createdAt' => tc_now(),
        );
        $db['assistantCategories'][] = $category;
        tc_json(200, array('category' => tc_public_category($category, array('count' => 0))));
    });
}

function tc_api_update_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $existing = tc_find_owned_category($db, $user, $id);
        if (!$existing) tc_fail(404, '分类不存在或无权修改');
        $parsed = tc_parse_category_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $existing['name'] = $parsed['name'];
        $existing['sort'] = $parsed['sort'];
        tc_replace_by_id($db['assistantCategories'], $id, $existing);
        tc_json(200, array('category' => tc_public_category($existing)));
    });
}

function tc_api_delete_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $existing = tc_find_owned_category($db, $user, $id);
        if (!$existing) tc_fail(404, '分类不存在或无权删除');
        foreach ($db['assistants'] as $a) {
            if ($a['categoryId'] !== $id) continue;
            $mine = isset($a['scope']) && $a['scope'] === 'user' ? (isset($a['ownerId']) && $a['ownerId'] === $user['id']) : (isset($a['scope']) && $a['scope'] === 'global');
            if ($mine) tc_fail(400, '请先移走或删除该分类下的助手');
        }
        $keep = array();
        foreach ($db['assistantCategories'] as $c) if ($c['id'] !== $id) $keep[] = $c;
        $db['assistantCategories'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_create_assistant() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_assistant_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $cat = tc_resolve_category_for_write($db, $user, isset($b['categoryId']) ? $b['categoryId'] : '');
        if (!empty($cat['error'])) tc_fail(400, $cat['error']);
        $item = array(
            'id' => tc_uid(), 'categoryId' => $cat['category']['id'],
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'sourceId' => null,
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $item;
        tc_json(200, array('assistant' => tc_public_assistant($item)));
    });
}

function tc_api_update_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $existing = tc_find_owned_assistant($db, $user, $id);
        if ($existing) {
            $parsed = tc_parse_assistant_input($b, $existing);
            if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
            if (!empty($b['categoryId'])) {
                $cat = tc_resolve_category_for_write($db, $user, $b['categoryId']);
                if (!empty($cat['error'])) tc_fail(400, $cat['error']);
                $existing['categoryId'] = $cat['category']['id'];
            }
            $existing = array_merge($existing, $parsed);
            $existing['updatedAt'] = tc_now();
            tc_replace_by_id($db['assistants'], $id, $existing);
            tc_json(200, array('assistant' => tc_public_assistant($existing)));
        }
        $global = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $global = $a; break; }
        if (!$global) tc_fail(404, '助手不存在');
        $parsed = tc_parse_assistant_input($b, $global);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $categoryId = $global['categoryId'];
        if (!empty($b['categoryId'])) {
            $cat = tc_resolve_category_for_write($db, $user, $b['categoryId']);
            if (!empty($cat['error'])) tc_fail(400, $cat['error']);
            $categoryId = $cat['category']['id'];
        }
        $prev = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $global['id']) {
                $prev = $a; break;
            }
        }
        if ($prev) {
            $prev = array_merge($prev, $parsed);
            $prev['categoryId'] = $categoryId;
            $prev['updatedAt'] = tc_now();
            tc_replace_by_id($db['assistants'], $prev['id'], $prev);
            tc_json(200, array('assistant' => tc_public_assistant($prev)));
        }
        $copy = array(
            'id' => tc_uid(), 'categoryId' => $categoryId,
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'sourceId' => $global['id'],
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $copy;
        tc_json(200, array('assistant' => tc_public_assistant($copy)));
    });
}

function tc_api_delete_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $existing = tc_find_owned_assistant($db, $user, $id);
        if ($existing) {
            $keep = array();
            foreach ($db['assistants'] as $a) if ($a['id'] !== $id) $keep[] = $a;
            $db['assistants'] = $keep;
            tc_json(200, array('ok' => true));
        }
        $global = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $global = $a; break; }
        if (!$global) tc_fail(404, '助手不存在或无权删除');
        $prev = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $global['id']) {
                $prev = $a; break;
            }
        }
        if (!$prev) tc_fail(403, '公共助手不能删除，可自行复制后再改');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $prev['id']) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true, 'restored' => true));
    });
}

function tc_api_reset_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $bySource = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && !empty($a['sourceId'])) {
                if ($a['id'] === $id || $a['sourceId'] === $id) { $bySource = $a; break; }
            }
        }
        if (!$bySource) tc_fail(404, '没有可还原的个人修改');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $bySource['id']) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_list_assistants() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        tc_seed_default_assistants($db);
        $cats = array(); $items = array();
        foreach ($db['assistantCategories'] as $c) if (isset($c['scope']) && $c['scope'] === 'global') $cats[] = $c;
        foreach ($db['assistants'] as $a) if (isset($a['scope']) && $a['scope'] === 'global') $items[] = $a;
        usort($cats, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
        usort($items, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
        $categories = array();
        foreach ($cats as $c) {
            $count = 0;
            foreach ($items as $a) if ($a['categoryId'] === $c['id']) $count++;
            $categories[] = tc_public_category($c, array('count' => $count));
        }
        $assistants = array();
        foreach ($items as $a) $assistants[] = tc_public_assistant($a);
        tc_json(200, array('categories' => $categories, 'assistants' => $assistants));
    });
}

function tc_api_admin_create_assistant_category() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_category_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach ($db['assistantCategories'] as $c) {
            if (isset($c['scope']) && $c['scope'] === 'global' && $c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $category = array(
            'id' => tc_uid(), 'name' => $parsed['name'], 'sort' => $parsed['sort'],
            'scope' => 'global', 'ownerId' => null, 'createdAt' => tc_now(),
        );
        $db['assistantCategories'][] = $category;
        tc_json(200, array('category' => tc_public_category($category, array('count' => 0))));
    });
}

function tc_api_admin_update_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['assistantCategories'] as $c) if ($c['id'] === $id && isset($c['scope']) && $c['scope'] === 'global') { $existing = $c; break; }
        if (!$existing) tc_fail(404, '分类不存在');
        $parsed = tc_parse_category_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach ($db['assistantCategories'] as $c) {
            if (isset($c['scope']) && $c['scope'] === 'global' && $c['id'] !== $id && $c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $existing['name'] = $parsed['name'];
        $existing['sort'] = $parsed['sort'];
        tc_replace_by_id($db['assistantCategories'], $id, $existing);
        tc_json(200, array('category' => tc_public_category($existing)));
    });
}

function tc_api_admin_delete_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $existing = null;
        foreach ($db['assistantCategories'] as $c) if ($c['id'] === $id && isset($c['scope']) && $c['scope'] === 'global') { $existing = $c; break; }
        if (!$existing) tc_fail(404, '分类不存在');
        foreach ($db['assistants'] as $a) {
            if ($a['categoryId'] === $id && isset($a['scope']) && $a['scope'] === 'global') tc_fail(400, '请先移走或删除该分类下的助手');
        }
        $keep = array();
        foreach ($db['assistantCategories'] as $c) if ($c['id'] !== $id) $keep[] = $c;
        $db['assistantCategories'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_create_assistant() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_assistant_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $category = null;
        foreach ($db['assistantCategories'] as $c) {
            if ($c['id'] === (string) (isset($b['categoryId']) ? $b['categoryId'] : '') && isset($c['scope']) && $c['scope'] === 'global') {
                $category = $c; break;
            }
        }
        if (!$category) tc_fail(400, '请选择公共分类');
        $item = array(
            'id' => tc_uid(), 'categoryId' => $category['id'],
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'global', 'ownerId' => null, 'sourceId' => null,
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $item;
        tc_json(200, array('assistant' => tc_public_assistant($item)));
    });
}

function tc_api_admin_update_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $existing = $a; break; }
        if (!$existing) tc_fail(404, '助手不存在');
        $parsed = tc_parse_assistant_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        if (!empty($b['categoryId'])) {
            $category = null;
            foreach ($db['assistantCategories'] as $c) {
                if ($c['id'] === (string) $b['categoryId'] && isset($c['scope']) && $c['scope'] === 'global') { $category = $c; break; }
            }
            if (!$category) tc_fail(400, '请选择公共分类');
            $existing['categoryId'] = $category['id'];
        }
        $existing = array_merge($existing, $parsed);
        $existing['updatedAt'] = tc_now();
        tc_replace_by_id($db['assistants'], $id, $existing);
        tc_json(200, array('assistant' => tc_public_assistant($existing)));
    });
}

function tc_api_admin_delete_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $existing = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $existing = $a; break; }
        if (!$existing) tc_fail(404, '助手不存在');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $id) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_update_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $admin = tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['providers'] as $p) if ($p['id'] === $id) { $existing = $p; break; }
        if (!$existing) tc_fail(404, '供应商不存在');
        if (isset($b['action']) && $b['action'] === 'set-default') {
            if (!tc_provider_enabled($existing)) tc_fail(400, '供应商已停用，请先启用再设为默认');
            $db['defaultProviderId'] = $id;
            tc_json(200, array('ok' => true, 'defaultProviderId' => $id));
        }
        $next = tc_normalize_provider_input($b, $existing);
        $err = tc_validate_provider($next);
        if ($err) tc_fail(400, $err);
        $next['updatedAt'] = tc_now();
        if (isset($b['scope']) && ($b['scope'] === 'global' || $b['scope'] === 'user')) {
            $next['scope'] = $b['scope'];
            $next['ownerId'] = $b['scope'] === 'global' ? null : $admin['id'];
        }
        $ownerChanged = (string) (isset($next['ownerId']) ? $next['ownerId'] : '') !== (string) (isset($existing['ownerId']) ? $existing['ownerId'] : '');
        if (!tc_is_encrypted_secret($next['apiKey'])) {
            if (!tc_provider_set_key($next, $next['apiKey'])) tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        } elseif ($ownerChanged) {
            // 密文与属主绑定,属主变更时按旧绑定解密、再按新绑定重新加密
            $plain = tc_decrypt_secret($existing['apiKey'], tc_provider_key_aad($existing));
            if ($plain !== '' && !tc_provider_set_key($next, $plain)) tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        tc_replace_by_id($db['providers'], $id, $next);
        tc_json(200, array('provider' => tc_client_provider($next, false, true)));
    });
}

function tc_api_admin_delete_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        if (!tc_remove_provider($db, $id)) tc_fail(404, '供应商不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_list_models() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $providerId = isset($q['provider']) ? $q['provider'] : null;
        $list = tc_visible_providers_of($db, $user);
        $allowed = tc_user_access($db, $user);
        $provider = null;
        if ($providerId) {
            foreach ($list as $p) if ($p['id'] === $providerId) { $provider = $p; break; }
            if (!$provider) tc_fail(404, '供应商不存在或无权访问');
        }
        $target = $provider ?: tc_get_default_provider($db, $user, $list);
        if (!$target) tc_json(200, array('models' => array(), 'providerId' => null));
        $vis = tc_visible_provider($user, $target, $allowed);
        if (!$vis) tc_json(200, array('models' => array(), 'providerId' => null));
        tc_json(200, array(
            'models' => $vis['models'],
            'providerId' => $target['id'],
            'providerName' => $target['name'],
            'apiFormat' => isset($target['apiFormat']) ? $target['apiFormat'] : 'chat',
            'costPerCall' => tc_provider_cost($target),
            'scope' => isset($target['scope']) ? $target['scope'] : 'user',
            'health' => tc_model_health_summary($db, $target['id']),
        ));
    });
}

function tc_api_parse_document() {
    @set_time_limit(150);
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        if (empty($_FILES['file']) || !is_array($_FILES['file'])) tc_fail(400, '请选择要解析的文件');
        $file = $_FILES['file'];
        $err = isset($file['error']) ? (int) $file['error'] : UPLOAD_ERR_NO_FILE;
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) tc_fail(400, '文件超过服务器上传限制');
        if ($err !== UPLOAD_ERR_OK) tc_fail(400, '文件上传失败');
        $tmp = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
        if ($tmp === '' || !is_uploaded_file($tmp)) tc_fail(400, '文件上传无效');
        $name = tc_mineru_safe_name(isset($file['name']) ? $file['name'] : '');
        if (!tc_mineru_parseable($name)) tc_fail(400, 'MinerU 不支持这个格式');
        $token = tc_user_mineru_token($user, $db['settings']);
        $precise = $token !== '';
        $size = isset($file['size']) ? (int) $file['size'] : 0;
        $limit = $precise ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
        if ($size <= 0) tc_fail(400, '文件是空的');
        if ($size > $limit) tc_fail(400, $precise ? '文件超过精准解析 200MB 上限' : '轻量解析单文件不超过 10MB、20 页');
        $bytes = file_get_contents($tmp);
        if ($bytes === false || $bytes === '') tc_fail(400, '文件读取失败');
        $started = tc_now();
        $parsed = tc_mineru_parse($name, $bytes, $token, 110);
        $ms = tc_now() - $started;
        $mode = $precise ? 'precise' : 'lite';
        if (empty($parsed['ok'])) {
            $msg = isset($parsed['error']) ? (string) $parsed['error'] : '文档解析失败';
            tc_push_log(array(
                'kind' => 'parse', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => 'MinerU', 'model' => $mode, 'status' => isset($parsed['code']) ? (int) $parsed['code'] : 502,
                'ms' => $ms, 'cost' => 0, 'error' => substr($name . ' · ' . $msg, 0, 240),
            ));
            tc_fail(isset($parsed['code']) && (int) $parsed['code'] >= 400 && (int) $parsed['code'] < 600 ? (int) $parsed['code'] : 502, $msg);
        }
        $chars = function_exists('mb_strlen') ? mb_strlen($parsed['markdown'], 'UTF-8') : strlen($parsed['markdown']);
        tc_push_log(array(
            'kind' => 'parse', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => 'MinerU', 'model' => $mode, 'status' => 200,
            'ms' => $ms, 'cost' => 0, 'error' => $name . ' · ' . $chars . ' 字',
        ));
        tc_json(200, array(
            'name' => $name,
            'mode' => $mode,
            'markdown' => $parsed['markdown'],
            'chars' => $chars,
            'limits' => $precise
                ? array('maxBytes' => 200 * 1024 * 1024, 'maxPages' => 200)
                : array('maxBytes' => 10 * 1024 * 1024, 'maxPages' => 20),
        ));
    });
}
