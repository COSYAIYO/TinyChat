<?php
/**
 * 内置模型元数据自检: php tests/model-meta-builtin.php
 * 覆盖:内置表数值口径(每百万 → 每 token)/ 迁移首次注入 / auto 兜底值被内置真实值替换 /
 *       手工与同步条目不被覆盖 / 同步跳过内置 / 窗口取数命中内置值 / 版本号已达标不重复注入。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-mmbuiltin-' . bin2hex(random_bytes(4));
@mkdir($dataDir, 0777, true);
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/api.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ $m\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
};
$near = function ($label, $got, $want) use ($ok, $bad) {
    if (is_numeric($got) && abs((float) $got - (float) $want) <= abs((float) $want) * 1e-9 + 1e-15) {
        $ok($label . ' ≈ ' . $want);
    } else {
        $bad($label . ': 期望 ≈ ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
    }
};

// 1) 内置表本身:条数与关键数值口径
$builtin = tc_builtin_model_meta();
$eq('内置模型数', count($builtin), 24);
$eq('gpt-6-astra 输入窗口', (int) $builtin['gpt-6-astra']['maxInputTokens'], 1050000);
$eq('gpt-6-astra 输出上限', (int) $builtin['gpt-6-astra']['maxOutputTokens'], 128000);
$near('gpt-6-astra 输入价(每 token)', $builtin['gpt-6-astra']['inputCostPerToken'], 10 / 1e6);
$near('deepseek-v4-pro 缓存读价(每 token)', $builtin['deepseek-v4-pro']['cacheReadCostPerToken'], 0.3 / 1e6);
// DeepSeek 报价统一按美元录入(flash 0.3/1.2,pro 1.32/3.96)
$near('deepseek-flash 输入价', $builtin['deepseek-flash']['inputCostPerToken'], 0.3 / 1e6);
$near('deepseek-flash 输出价', $builtin['deepseek-flash']['outputCostPerToken'], 1.2 / 1e6);
$near('deepseek-v4-pro 输入价', $builtin['deepseek-v4-pro']['inputCostPerToken'], 1.32 / 1e6);
$near('deepseek-v4-pro 输出价', $builtin['deepseek-v4-pro']['outputCostPerToken'], 3.96 / 1e6);
$eq('grok-4.7 输出上限为空(0)', (int) $builtin['grok-4.7']['maxOutputTokens'], 0);
$eq('agnes-2.0-flash 输入窗口', (int) $builtin['agnes-2.0-flash']['maxInputTokens'], 256000);

// 2) 迁移首次注入:空库也能拿到内置条目
$db = tc_migrate_db(array('modelMeta' => array()));
$eq('迁移后写入内置版本号', (int) $db['modelMetaBuiltinVersion'], 1);
$m = tc_model_meta_get($db, 'gpt-6-astra');
$eq('内置条目来源', $m['source'], 'builtin');
$eq('内置条目非待复核', $m['needsReview'], false);
$eq('内置条目默认启用', $m['enabled'], true);
$eq('内置条目已入库数', count($db['modelMeta']), 24);

// 3) 窗口取数:命中内置值,空值回退到兜底常量
list($out, $ctx) = tc_model_meta_caps(tc_model_meta_get($db, 'gemini-2.5-flash'));
$eq('gemini-2.5-flash 输出上限', $out, 65536);
$eq('gemini-2.5-flash 输入窗口', $ctx, 1048576);
list($out2, $ctx2) = tc_model_meta_caps(tc_model_meta_get($db, 'grok-4.6'));
$eq('grok-4.6 输出上限回退兜底常量', $out2, TC_MODEL_META_AUTO_OUTPUT);
$eq('grok-4.6 输入窗口用内置值', $ctx2, 500000);

// 3b) 包含匹配:渠道给模型加前缀/后缀,名字里含该键即命中同一条元数据(边界需为分隔符)
$f1 = tc_model_meta_get($db, 'XXX/deepseek-flash');
$eq('前缀渠道名命中内置条目', $f1['source'], 'builtin');
$eq('前缀渠道名窗口', (int) $f1['maxInputTokens'], 1000000);
$f2 = tc_model_meta_get($db, 'deepseek-flash-2026-preview');
$eq('后缀渠道名命中内置条目', (int) $f2['maxOutputTokens'], 384000);
$f3 = tc_model_meta_get($db, 'openai/gpt-5.6-TERRA:free');
$near('大小写与冒号后缀仍命中', $f3['inputCostPerToken'], 2 / 1e6);
// 多个键同时被包含时取最长(最具体)的那个:lite 不会被 gemini-2.5-flash 截胡
$f4 = tc_model_meta_get($db, 'my-gemini-2.5-flash-lite-2026');
$near('最长键优先(命中 lite 的输入价)', $f4['inputCostPerToken'], 0.1 / 1e6);
// 边界保护:紧贴字母数字不算命中,避免 gpt-4 抢走 gpt-4o 这类误配
$eq('非边界字符不误命中', tc_model_meta_get($db, 'gpt-6-solx'), null);

// 3c) 包含匹配到的模型不再补自动条目;停用的条目也不参与包含匹配
$before = count($db['modelMeta']);
$eq('包含匹配到的模型不再补自动条目', tc_model_meta_ensure_auto($db, array('azure/gpt-6-astra')), 0);
$eq('表条数不变', count($db['modelMeta']), $before);
$dbd = tc_migrate_db(array('modelMeta' => array()));
$dbd['modelMeta']['gpt-6-astra']['enabled'] = false;
$eq('精确键停用后不回退到包含匹配', tc_model_meta_get($dbd, 'gpt-6-astra'), null);
$eq('停用条目对渠道名同样不生效', tc_model_meta_get($dbd, 'azure/gpt-6-astra'), null);

// 4) 已有条目:手工/同步一律不动,仅 auto 兜底值被替换
$db2 = tc_migrate_db(array('modelMeta' => array(
    'gpt-6-astra' => array('maxInputTokens' => 123, 'source' => 'manual', 'enabled' => true, 'updatedAt' => 1),
    'gpt-6-luna' => array('maxInputTokens' => 999, 'source' => 'litellm', 'enabled' => true, 'updatedAt' => 1),
    'gemini-2.5-pro' => array(
        'maxInputTokens' => TC_MODEL_META_AUTO_CONTEXT,
        'maxOutputTokens' => TC_MODEL_META_AUTO_OUTPUT,
        'source' => 'auto', 'needsReview' => true, 'enabled' => true, 'updatedAt' => 1,
    ),
)));
$eq('手工条目不被覆盖', (int) $db2['modelMeta']['gpt-6-astra']['maxInputTokens'], 123);
$eq('手工条目来源保持 manual', $db2['modelMeta']['gpt-6-astra']['source'], 'manual');
$eq('同步条目不被覆盖', (int) $db2['modelMeta']['gpt-6-luna']['maxInputTokens'], 999);
$eq('auto 兜底值被内置真实值替换', (int) $db2['modelMeta']['gemini-2.5-pro']['maxInputTokens'], 1048576);
$eq('替换后来源为 builtin', $db2['modelMeta']['gemini-2.5-pro']['source'], 'builtin');
$eq('替换后待复核标记清除', $db2['modelMeta']['gemini-2.5-pro']['needsReview'], false);

// 5) 幂等:再次迁移不改变条数
$again = tc_migrate_db($db);
$eq('重复迁移条数不变', count($again['modelMeta']), count($db['modelMeta']));

// 6) litellm 同步跳过内置(不被真实价格表覆盖),其余模型照常入库
$raw = array(
    'openai/gpt-6-astra' => array(
        'max_input_tokens' => 7, 'max_output_tokens' => 8,
        'input_cost_per_token' => 9.9e-6, 'output_cost_per_token' => 9.9e-6,
        'litellm_provider' => 'openai', 'mode' => 'chat',
    ),
    'openai/brand-new-xyz' => array(
        'max_input_tokens' => 1000, 'max_output_tokens' => 100,
        'input_cost_per_token' => 1e-6, 'output_cost_per_token' => 2e-6,
        'litellm_provider' => 'openai', 'mode' => 'chat',
    ),
);
$res = tc_model_meta_sync_indexed($again, $raw);
$eq('同步跳过内置条目计数', $res['skipped'], 1);
$eq('内置窗口未被同步覆盖', (int) $again['modelMeta']['gpt-6-astra']['maxInputTokens'], 1050000);
$eq('内置来源未被同步改写', $again['modelMeta']['gpt-6-astra']['source'], 'builtin');
$eq('新模型仍可同步入库', $again['modelMeta']['brand-new-xyz']['source'], 'litellm');

// 7) 版本号已达标:不再注入(管理员删掉的内置条目不会自己复活)
$db3 = tc_migrate_db(array('modelMetaBuiltinVersion' => TC_MODEL_META_BUILTIN_VERSION, 'modelMeta' => array()));
$eq('版本已达标不再注入', isset($db3['modelMeta']['gpt-6-astra']), false);

echo $fail === 0 ? "\n全部通过\n" : "\n失败 $fail 项\n";
exit($fail === 0 ? 0 : 1);
