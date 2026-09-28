#!/usr/bin/env bash
# TinyChat E2E 冒烟测试:起真实 PHP 服务 + mock 上游,跑完整业务流断言。
# 覆盖:登录/设置、备份(含越权与穿越防护)、邀请码注册、按次与按 token 计费、
#       敏感词审核、接口限流、API 密钥与 /v1 出口、图像生成、协议页、安全响应头。
# 用法:bash tests/e2e.sh   (需要 php、curl;端口可用 E2E_PORT / E2E_MOCK_PORT 覆盖)
set -u
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8099}"
MOCK_PORT="${E2E_MOCK_PORT:-8100}"
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); say "  ✗ $1"; }
assert_contains() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (missing: $3 | got: $(printf '%s' "$2" | head -c 180))"; fi
}
# 固定字符串包含断言:断言里含 [ ] 等正则元字符时用它,避免被 grep 当字符组解析
assert_has() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (missing literal: $3 | got: $(printf '%s' "$2" | head -c 180))"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3] got [$2])"; fi
}
jget() { # 从 stdin JSON 提取 "key":"value" 或 "key":value 的值
  sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" | head -1
}

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

say "== 启动服务 (app :$PORT / mock :$MOCK_PORT) =="
DATA_DIR="$TMP/data" ADMIN_NAME=admin ADMIN_PASSWORD=e2e-pass php -S "127.0.0.1:$PORT" router.php >"$TMP/app.log" 2>&1 &
APP_PID=$!
php -S "127.0.0.1:$MOCK_PORT" tests/mock-upstream.php >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!

wait_for() {
  local i code
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)
    if [ "$code" != "000" ] && [ -n "$code" ]; then return 0; fi
    sleep 0.2
  done
  return 1
}
wait_for "$BASE/api/config" || { say "app 服务未启动"; exit 1; }

# ---------- 基础页面与安全头 ----------
say "== 基础 =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
assert_eq "首页 200" "$code" "200"
cfg=$(curl -s "$BASE/api/config")
assert_contains "config 返回版本" "$cfg" '"version":"2.'
assert_contains "环境自检通过" "$(curl -s "$BASE/api/env-check")" '"allOk":true'
assert_contains "config 返回公告字段" "$cfg" '"announcement"'
hdr=$(curl -s -D - -o /dev/null "$BASE/api/config")
assert_contains "CSP 头" "$hdr" "Content-Security-Policy:"
assert_contains "X-Frame-Options DENY" "$hdr" "X-Frame-Options: DENY"

# ---------- 登录与设置 ----------
say "== 登录与设置 =="
login_json=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"admin","password":"e2e-pass"}')
assert_contains "管理员登录返回合法 JSON" "$login_json" '"token":"'
TOKEN=$(printf '%s' "$login_json" | jget token)
[ -n "$TOKEN" ] && ok "管理员登录" || bad "管理员登录"
AUTH="Authorization: Bearer $TOKEN"
cat > "$TMP/settings1.json" <<'EOF'
{"temperature":0.7,"rateLimitPerMin":50,"backupKeep":3,"agreementEnabled":true,"agreementHtml":"<p>测试协议</p>","registerInviteRequired":true,"registerLimitPerHour":100,"announcement":{"enabled":true,"text":"E2E announcement"}}
EOF
res=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/settings1.json")
assert_contains "设置: temperature 保存" "$res" '"temperature":0.7'
assert_contains "设置: 限流保存" "$res" '"rateLimitPerMin":50'
assert_contains "设置: 协议启用" "$res" '"agreementEnabled":true'
assert_contains "设置: 公告保存" "$res" '"text":"E2E announcement"'
assert_contains "config 回读公告" "$(curl -s "$BASE/api/config")" '"text":"E2E announcement"'
empty_ann=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"announcement":{"enabled":true,"text":""}}')
assert_contains "空公告启用被拒" "$empty_ann" '启用公告时请填写公告内容'
# 协议页(启用后)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/agreement")
assert_eq "协议页 200" "$code" "200"
page=$(curl -s "$BASE/agreement")
assert_contains "协议页渲染正文" "$page" "测试协议"

# ---------- 备份 ----------
say "== 数据备份 =="
bn=$(curl -s -X POST "$BASE/api/admin/backup" -H "$AUTH" | jget created)
[ -n "$bn" ] && ok "创建备份 ($bn)" || bad "创建备份"
assert_contains "备份列表" "$(curl -s "$BASE/api/admin/backup" -H "$AUTH")" 'db-'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/backup/download?id=$bn" -H "$AUTH")
assert_eq "备份下载 200" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/backup/download?id=$bn")
assert_eq "未登录下载 401" "$code" "401"
assert_contains "路径穿越被拦截" "$(curl -s "$BASE/api/admin/backup/download?id=..%2F..%2Fdb.json" -H "$AUTH")" '备份不存在'
assert_contains "恢复成功" "$(curl -s -X POST "$BASE/api/admin/backup/restore" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$bn\"}")" '"ok":true'

# ---------- 邀请码与注册 ----------
say "== 邀请码与注册 =="
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":2}' > /dev/null
codes=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | grep -o '"code":"[A-F0-9]*"' | cut -d'"' -f4)
INV1=$(printf '%s' "$codes" | sed -n 1p)
INV2=$(printf '%s' "$codes" | sed -n 2p)
[ -n "$INV1" ] && [ -n "$INV2" ] && ok "生成邀请码 ($INV1 / $INV2)" || bad "生成邀请码"
assert_contains "无邀请码注册被拒" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"name":"tester1","password":"pass1234","agreementAccepted":true}')" '邀请码'
cat > "$TMP/reg1.json" <<EOF
{"name":"tester1","password":"pass1234","invite":"$INV1","agreementAccepted":true}
EOF
UTOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg1.json" | jget token)
[ -n "$UTOKEN" ] && ok "邀请码注册成功" || bad "邀请码注册成功"
UAUTH="Authorization: Bearer $UTOKEN"
cat > "$TMP/reg2.json" <<EOF
{"name":"tester2","password":"pass1234","invite":"$INV1","agreementAccepted":true}
EOF
assert_contains "邀请码复用被拒" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg2.json")" '无效或已被使用'
# 多次有效邀请码:一张码可用 2 次,第 3 次拒绝
curl -s -X POST "$BASE/api/admin/invites" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":1,"maxUses":2,"prefix":"MULTI"}' > /dev/null
MCODE=$(curl -s "$BASE/api/admin/invites" -H "$AUTH" | grep -o '"code":"MULTI-[A-F0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$MCODE" ] && ok "生成多次邀请码 ($MCODE)" || bad "生成多次邀请码"
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi1\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}" > /dev/null
m2=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi2\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}")
assert_contains "多次邀请码第 2 次可用" "$m2" '"token"'
assert_contains "多次邀请码用尽后拒绝" "$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"name\":\"multi3\",\"password\":\"pass1234\",\"invite\":\"$MCODE\",\"agreementAccepted\":true}")" '无效或已被使用'
assert_contains "邀请码使用次数记录" "$(curl -s "$BASE/api/admin/invites" -H "$AUTH")" '"usedCount":2'

# ---------- 供应商与按次计费 ----------
say "== 供应商与计费 =="
cat > "$TMP/prov.json" <<'EOF'
{"name":"Mock","baseUrl":"http://127.0.0.1:MOCKPORT/v1","apiKey":"sk-mock","apiFormat":"chat","models":[{"id":"mock-model","name":"Mock"}],"costPerCall":1,"scope":"global"}
EOF
sed -i "s/MOCKPORT/$MOCK_PORT/" "$TMP/prov.json"
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov.json" > /dev/null
PROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"Mock"' | cut -d'"' -f4)
[ -n "$PROV" ] && ok "创建全局供应商" || bad "创建全局供应商"
# 用户组 ID 必须跨请求稳定(否则授权规则会全部失效)
GID1=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
GID2=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
assert_eq "用户组 ID 跨请求稳定" "$GID1" "$GID2"
# 新建全局供应商应默认授权给各用户组(规则里出现该供应商且为通配)
assert_has "新供应商默认对所有分组开放" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]"
# 收窄授权后再次读取必须仍然生效
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
assert_has "模型授权保存后可回读" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]"
cat > "$TMP/chat1.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":false,"messages":[{"role":"user","content":"hello"}]}
EOF
cost=$(curl -s -D - -o /dev/null -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json" | grep -i '^X-Oc-Cost' | tr -d '\r' | awk '{print $2}')
assert_eq "按次计费 X-Oc-Cost=1" "$cost" "1"
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "额度扣减 100->99" "$quota" "99"
# 按 token 计费:2000 tokens × 0.002/1K = 0.004
curl -s -X POST "$BASE/api/admin/providers/$PROV" -H "$AUTH" -H "Content-Type: application/json" -d '{"billingMode":"token","pricePer1k":0.002}' > /dev/null
cost=$(curl -s -D - -o /dev/null -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json" | grep -i '^X-Oc-Cost' | tr -d '\r' | awk '{print $2}')
assert_eq "按 token 计费 0.004" "$cost" "0.004"
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "额度扣减 99->98.996" "$quota" "98.996"

# 流式 + token 计费:首字节用量未知按次预扣 1,流结束按 2000 token 结算 0.004 并退差价 → 净扣 0.004,额度 98.996-0.004=98.992
cat > "$TMP/chat-stream.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":true,"messages":[{"role":"user","content":"hello"}]}
EOF
body=$(curl -s -N -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat-stream.json")
assert_contains "流式输出内容" "$body" 'MOCK-REPLY'
assert_contains "流式正常收尾" "$body" '\[DONE\]'
quota=$(curl -s "$BASE/api/auth/me" -H "$UAUTH" | jget quota)
assert_eq "流式按 token 结算(净扣 0.004) 98.992" "$quota" "98.992"

# ---------- 敏感词审核 ----------
say "== 内容审核 =="
cat > "$TMP/mod.json" <<'EOF'
{"moderation":{"enabled":true,"words":"坏词"}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mod.json" > /dev/null
cat > "$TMP/chat2.json" <<'EOF'
{"model":"mock-model","messages":[{"role":"user","content":"这句话包含坏词测试"}]}
EOF
assert_contains "敏感词命中被拒" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat2.json")" '被禁止的内容'

# ---------- API 密钥与 /v1 出口 ----------
say "== API 密钥与 /v1 出口 =="
KEY=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"e2e"}' | jget secret)
[ -n "$KEY" ] && ok "生成 API 密钥" || bad "生成 API 密钥"
assert_contains "/v1/models 列表" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY")" 'mock-model'
assert_contains "/v1/chat/completions 正常应答" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" 'MOCK-REPLY'
assert_contains "无效密钥 401" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer sk-tc-deadbeefdeadbeefdeadbeefdeadbeef" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" '无效的 API 密钥'

# ---------- 图像生成 ----------
say "== 图像生成 =="
cat > "$TMP/img.json" <<EOF
{"providerId":"$PROV","model":"mock-image","prompt":"a corgi surfing","size":"1024x1024","n":1}
EOF
assert_contains "图像生成返回 URL" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/img.json")" 'example.com/mock.png'

# ---------- 接口限流(tester2 全新窗口:3 次/分钟) ----------
say "== 接口限流 =="
cat > "$TMP/reg3.json" <<EOF
{"name":"tester2","password":"pass1234","invite":"$INV2","agreementAccepted":true}
EOF
T2TOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d @"$TMP/reg3.json" | jget token)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"rateLimitPerMin":3}' > /dev/null
c1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
c4=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/proxy/chat" -H "Authorization: Bearer $T2TOKEN" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
assert_eq "限流: 前 3 次放行" "$c1/$c2/$c3" "200/200/200"
assert_eq "限流: 第 4 次 429" "$c4" "429"

# ---------- 开放 API:每密钥限流与对外模型白名单 ----------
say "== 开放 API 限制 =="
assert_contains "密钥接口返回限制信息" "$(curl -s "$BASE/api/me/apikeys" -H "$UAUTH")" '"keyRateLimitPerMin"'
# 先把账号级限流放宽,避免上一节残留的 3 次/分钟窗口干扰"每密钥限流"断言
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiKeyRateLimitPerMin":2,"rateLimitPerMin":600,"apiExposedModels":[]}' > /dev/null
KEY2=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"rl"}' | jget secret)
k1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
k2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
k3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY2" -H "Content-Type: application/json" -d @"$TMP/chat1.json")
assert_eq "每密钥限流: 前 2 次放行" "$k1/$k2" "200/200"
assert_eq "每密钥限流: 第 3 次 429" "$k3" "429"
# 白名单只开放 mock-model,则 /v1/models 只出现它
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"apiExposedModels\":[\"$PROV|mock-model\"],\"apiKeyRateLimitPerMin\":0}" > /dev/null
assert_contains "白名单内模型可见" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" 'mock-model'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d "{\"apiExposedModels\":[\"$PROV|not-exist\"]}" > /dev/null
assert_has "白名单外模型不可见" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" '"data":[]'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":[]}' > /dev/null

# ---------- 演示管理员 ----------
say "== 演示管理员 =="
dm=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoadmin","password":"demo1234","demo":true}')
assert_contains "创建演示管理员" "$dm" '"demo":true'
DTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"demoadmin","password":"demo1234"}' | jget token)
DAUTH="Authorization: Bearer $DTOKEN"
assert_contains "演示管理员可保存设置" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"siteName":"DemoSite"}')" '"siteName":"DemoSite"'
assert_contains "演示管理员不可改密码" "$(curl -s -X POST "$BASE/api/auth/password" -H "$DAUTH" -H "Content-Type: application/json" -d '{"oldPassword":"demo1234","newPassword":"other1234"}')" '演示账号不允许修改密码'
assert_contains "演示管理员不可强制下线" "$(curl -s -X POST "$BASE/api/admin/session/invalidate" -H "$DAUTH")" '演示账号不能强制全站下线'
assert_contains "演示管理员不可删用户" "$(curl -s -X DELETE "$BASE/api/admin/users/$GID1" -H "$DAUTH")" '演示账号不能删除用户'
assert_contains "演示管理员不可改公告" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"announcement":{"enabled":true,"text":"x"}}')" '演示管理员不能修改公告'
assert_contains "演示管理员不可查看用户对话" "$(curl -s "$BASE/api/admin/users/chats" -H "$DAUTH")" '演示管理员不能查看用户对话'
assert_contains "演示管理员不可创建用户" "$(curl -s -X POST "$BASE/api/admin/users" -H "$DAUTH" -H "Content-Type: application/json" -d '{"name":"zzz","password":"pass1234"}')" '演示管理员不能管理用户账号'
assert_contains "config 暴露 demoMode" "$(curl -s "$BASE/api/config")" '"demoMode":true'
# 演示管理员额度必须尊重填入值(此前会被强制写成 1e15)
dq=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoq","password":"demo1234","demo":true,"quota":9999,"demoMinutes":5}' | jget quota)
assert_eq "演示管理员额度按填入值" "$dq" "9999"
assert_contains "演示管理员可配复原时长" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":5'

# ---------- 游客模式 ----------
say "== 游客模式 =="
assert_contains "游客默认关闭被拒" "$(curl -s -X POST "$BASE/api/auth/guest")" '游客体验已关闭'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"guestEnabled":true,"guestRounds":4}' > /dev/null
assert_contains "config 暴露游客开关" "$(curl -s "$BASE/api/config")" '"guestEnabled":true'
glog=$(curl -s -X POST "$BASE/api/auth/guest")
assert_contains "游客自动登录" "$glog" '"guest":true'
GTOKEN=$(printf '%s' "$glog" | jget token)
[ -n "$GTOKEN" ] && ok "游客获取令牌" || bad "游客获取令牌"
assert_contains "游客命名带前缀" "$glog" '"name":"游客'
assert_contains "游客按轮数发放额度" "$glog" '"quota":4'
GAUTH="Authorization: Bearer $GTOKEN"
# 游客可看到全局供应商,说明游客组默认授权生效
assert_contains "游客组可见全局模型" "$(curl -s "$BASE/api/providers" -H "$GAUTH")" 'Mock'
# 后台用户列表展示游客标记与 IP
assert_contains "用户列表含 IP 字段" "$(curl -s "$BASE/api/admin/users" -H "$AUTH")" '"lastIp":'

say ""
say "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
