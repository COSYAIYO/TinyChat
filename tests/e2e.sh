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
  [ -n "${OAUTH_PID:-}" ] && kill "$OAUTH_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

say "== 启动服务 (app :$PORT / mock :$MOCK_PORT) =="
OAUTH_PORT="${E2E_OAUTH_PORT:-8104}"
DATA_DIR="$TMP/data" ADMIN_NAME=admin ADMIN_PASSWORD=e2e-pass \
  TC_BRAVE_SEARCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_DDG_HTML_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_JINA_SEARCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_MISTRAL_OCR_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_PAGE_FETCH_BASE="http://127.0.0.1:$MOCK_PORT" \
  TC_WECHAT_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" TC_WECHAT_API_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_QQ_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_LINUXDO_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  TC_NODELOC_OAUTH_BASE="http://127.0.0.1:$OAUTH_PORT" \
  php -S "127.0.0.1:$PORT" router.php >"$TMP/app.log" 2>&1 &
APP_PID=$!
TC_MOCK_ECHO_FILE="$TMP/pf_echo_out.txt" php -S "127.0.0.1:$MOCK_PORT" tests/mock-upstream.php >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!
OAUTH_PORT="${E2E_OAUTH_PORT:-8104}"
php -S "127.0.0.1:$OAUTH_PORT" tests/mock-oauth.php >"$TMP/mock-oauth.log" 2>&1 &
OAUTH_PID=$!

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
# 模型可用性阈值:可保存,颠倒输入自动纠正,并下发到前端
assert_contains "可用性阈值可保存" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":90,"healthWarnMin":60}')" '"healthOkMin":90'
swapped=$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":30,"healthWarnMin":80}')
assert_contains "阈值颠倒自动纠正(ok)" "$swapped" '"healthOkMin":30'
assert_contains "阈值颠倒自动纠正(warn)" "$swapped" '"healthWarnMin":29'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"healthOkMin":75,"healthWarnMin":40}' > /dev/null
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
{"name":"Mock","baseUrl":"http://127.0.0.1:MOCKPORT/v1","apiKey":"sk-mock","apiFormat":"chat","models":[{"id":"mock-model","name":"Mock"},{"id":"mock-image","name":"Mock Image","image":true},{"id":"mock-chat-image","name":"Chat Image","image":true}],"costPerCall":1,"scope":"global"}
EOF
sed -i "s/MOCKPORT/$MOCK_PORT/" "$TMP/prov.json"
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov.json" > /dev/null
PROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"Mock"' | cut -d'"' -f4)
[ -n "$PROV" ] && ok "创建全局供应商" || bad "创建全局供应商"
# 用户组 ID 必须跨请求稳定(否则授权规则会全部失效)
GID1=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
GID2=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | grep -o '"groups":\[{"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f6)
assert_eq "用户组 ID 跨请求稳定" "$GID1" "$GID2"
# 用户组必须下发 role(前端据此判断「管理员组」;缺失会导致改成演示管理员时误报「用户组更新失败」)
assert_has "用户组下发 admin role" "$(curl -s "$BASE/api/admin/groups" -H "$AUTH")" '"role":"admin"'
assert_has "用户组下发 user role" "$(curl -s "$BASE/api/admin/groups" -H "$AUTH")" '"role":"user"'
ADMINGID=$(curl -s "$BASE/api/admin/groups" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([g['id'] for g in d['groups'] if g.get('role')=='admin'][0])")
# 普通用户设为演示管理员:后端应自动归入管理员组(前端因此无需再多调一次组接口)
DEMOU=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"todemo","password":"pass1234"}')
TU=$(printf '%s' "$DEMOU" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])")
convert=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$TU"'","name":"todemo","admin":true,"demo":true,"demoMinutes":10}')
assert_contains "普通用户转演示管理员成功" "$convert" '"demo":true'
assert_has "转演示后自动归入管理员组" "$convert" "\"groupId\":\"$ADMINGID\""
# 新建全局供应商应默认授权给各用户组(规则里出现该供应商且为通配)
assert_has "新供应商默认对所有分组开放" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]"
# 收窄授权后再次读取必须仍然生效
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
assert_has "模型授权保存后可回读" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]"
# 部分模型授权:先给全部,再收窄为单个模型,验证该组用户只能看到被授权的模型
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}" > /dev/null
full=$(curl -s "$BASE/api/providers" -H "$UAUTH")
assert_contains "全部授权时可见所有模型" "$full" 'mock-image'
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
partial=$(curl -s "$BASE/api/providers" -H "$UAUTH")
assert_contains "部分授权后仍可见被授权模型" "$partial" 'mock-model'
if printf '%s' "$partial" | grep -q 'mock-image'; then bad "部分授权后不应可见未授权模型 mock-image"; else ok "部分授权后不可见未授权模型"; fi
# 恢复为全部模型授权,后续计费/图像等用例需要访问 mock-image
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$GID1\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}" > /dev/null
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
imgresp=$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/img.json")
assert_contains "图像生成返回 URL" "$imgresp" 'example.com/mock.png'
# 结果附带同源代理显示地址(供 <img> 稳定加载,规避第三方存储域不可达)
assert_contains "图像结果附带同源代理地址" "$imgresp" '/api/proxy/image?u='
# b64_json 返回形态(按 response_format 透传)
cat > "$TMP/img-b64.json" <<EOF
{"providerId":"$PROV","model":"mock-image","prompt":"x","n":1,"response_format":"b64_json"}
EOF
assert_contains "图像生成支持 b64_json" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/img-b64.json")" 'b64_json'
# 自定义图片规格:宽高比(只给 ratio、不给 size)、档位(4K)、竖版精确像素都要能出图
assert_contains "图片规格:只给宽高比可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","ratio":"16:9"}')" 'example.com/mock.png'
assert_contains "图片规格:4K 档位可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","size":"4K"}')" 'example.com/mock.png'
assert_contains "图片规格:竖版精确像素可用" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"x","size":"1024x1792"}')" 'example.com/mock.png'
# 生图模型标记持久化(供应商保存 image:true 后能读回)
assert_has "供应商模型生图标记可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"id":"mock-image","name":"Mock Image","image":true'
# 生图多密钥回退:第一把坏 Key(401)→ 应自动换第二把好 Key 出图成功
cat > "$TMP/imgkey.json" <<EOF
{"name":"ImgKeyProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏","apiKey":"sk-fail"},{"id":"k2","name":"好","apiKey":"sk-good"}],
 "models":[{"id":"mock-image","name":"Img","image":true,"keyIds":["k1"]}]}
EOF
imgkey=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/imgkey.json")
IMGKEYPROV=$(printf '%s' "$imgkey" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
assert_contains "生图多密钥: 第一把失败自动回退第二把" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$IMGKEYPROV"'","model":"mock-image","prompt":"x"}')" 'example.com/mock.png'
# 模型级单价:保存后能读回,并在 /api/proxy/models 的 costs 映射中体现
cat > "$TMP/prov-cost.json" <<EOF
{"name":"CostProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-cost","apiFormat":"chat","models":[{"id":"mock-model","name":"Mock","cost":3},{"id":"mock-cheap","name":"Cheap"}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-cost.json" > /dev/null
COSTPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"CostProv"' | cut -d'"' -f4)
assert_has "模型级单价可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"id":"mock-model","name":"Mock","cost":3'
assert_contains "模型单价下发到前端" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"mock-model":3'
assert_contains "未设单价的模型回退供应商价" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"mock-cheap":1'
assert_contains "可用性阈值下发前端" "$(curl -s "$BASE/api/proxy/models?provider=$COSTPROV" -H "$UAUTH")" '"healthOkMin"'
# 开放接口 /v1/images/generations
IMGKEY=$(curl -s -X POST "$BASE/api/me/apikeys" -H "$UAUTH" -H "Content-Type: application/json" -d '{"name":"img"}' | jget secret)
assert_contains "/v1/images/generations 返回图片" "$(curl -s -X POST "$BASE/v1/images/generations" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-image","prompt":"a corgi","size":"1024x1024","n":1}')" 'example.com/mock.png'

# ---------- 生图模型自动路由 ----------
say "== 生图模型自动路由 =="
# 用生图模型调对话接口:应自动改走 images/generations 并返回图片(而不是上游的 "is an image model" 报错)
assert_contains "对话接口自动改走生图" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","messages":[{"role":"user","content":"draw a corgi"}]}')" 'example.com/mock.png'
assert_contains "开放接口自动改走生图" "$(curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-image","messages":[{"role":"user","content":"draw"}]}')" 'example.com/mock.png'
# 对话式出图模型:生图路径不支持时自动回退到 chat/completions 并从回复里提取图片
assert_contains "对话式生图自动回退" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-chat-image","prompt":"draw a cat"}')" 'example.com/mock-chat.png'
# 开放接口同样受益于兜底
assert_contains "开放接口对话式生图兜底" "$(curl -s -X POST "$BASE/v1/images/generations" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-chat-image","prompt":"draw a cat"}')" 'example.com/mock-chat.png'

# 图生图/改图:带 image 数组时应返回改后的图
assert_contains "图生图(带参考图)返回结果" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-image","prompt":"make it red","images":["https://example.com/ref.png"]}')" 'example.com/mock-edited.png'

# 普通文本模型仍走对话,不受影响
assert_contains "文本模型仍走对话" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$PROV"'","model":"mock-model","messages":[{"role":"user","content":"hi"}]}')" 'MOCK-REPLY'
# Base URL 不带 /v1(平台文档常见写法,如 Agnes):生图应自动补 /v1,不能拼成 /images/generations(会 404)
cat > "$TMP/prov-nov1.json" <<EOF
{"name":"NoV1","baseUrl":"http://127.0.0.1:$MOCK_PORT","apiKey":"sk-nov1","apiFormat":"chat","models":[{"id":"mock-image","name":"Mock Image","image":true}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-nov1.json" > /dev/null
NOV1=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"NoV1"' | cut -d'"' -f4)
[ -n "$NOV1" ] && ok "创建无 /v1 供应商" || bad "创建无 /v1 供应商"
assert_contains "Base URL 不带 /v1 也能生图" "$(curl -s -X POST "$BASE/api/proxy/images" -H "$UAUTH" -H "Content-Type: application/json" -d "{\"providerId\":\"$NOV1\",\"model\":\"mock-image\",\"prompt\":\"x\",\"size\":\"2K\",\"ratio\":\"16:9\"}")" 'example.com/mock.png'

# ---------- 视频生成 ----------
say "== 视频生成 =="
cat > "$TMP/prov-video.json" <<EOF
{"name":"MockVideo","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-vid","apiFormat":"video","models":[{"id":"mock-video","name":"Mock Video"}],"costPerCall":1,"scope":"global"}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/prov-video.json" > /dev/null
VIDPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"MockVideo"' | cut -d'"' -f4)
[ -n "$VIDPROV" ] && ok "创建视频供应商" || bad "创建视频供应商"
# 供应商接口格式 video 应能保存并读回
assert_has "视频供应商接口格式可保存" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"apiFormat":"video"'
# 文字生成视频:应返回视频地址 + 同源代理地址
vidresp=$(curl -s -X POST "$BASE/api/proxy/videos" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$VIDPROV"'","model":"mock-video","prompt":"a rainy city street","mode":"text","seconds":5,"aspect_ratio":"16:9"}')
assert_contains "视频生成返回 URL" "$vidresp" 'example.com/generated/mock-video.mp4'
assert_contains "视频结果附同源代理地址" "$vidresp" '/api/proxy/video?u='
# 视频代理:签名校验(错误签名 403)
assert_contains "视频代理拒绝无效签名" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/proxy/video?u=https%3A%2F%2Fexample.com%2Fx.mp4&s=bad")" '403'
# 对话接口自动改走视频(视频模型按名命中时)
assert_contains "对话接口自动改走生视频" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d '{"providerId":"'"$VIDPROV"'","model":"mock-video","messages":[{"role":"user","content":"draw"}]}')" 'example.com/generated/mock-video.mp4'

# ---------- 获取模型列表 ----------
say "== 多密钥供应商 =="
cat > "$TMP/mk.json" <<EOF
{"name":"MultiKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-legacy","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"ka","name":"主号","apiKey":"sk-key-a"},{"id":"kb","name":"副号","apiKey":"sk-key-b"}],
 "models":[{"id":"mock-model","name":"Mock","keyId":"ka"},{"id":"mock-image","name":"Mock Image","keyId":"kb","image":true}]}
EOF
mk=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mk.json")
assert_contains "创建多密钥供应商" "$mk" '"name":"主号"'
assert_contains "密钥二存在" "$mk" '"name":"副号"'
assert_contains "模型绑定密钥" "$mk" '"keyId":"ka"'
MKPROV=$(printf '%s' "$mk" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
# 密钥重名应被拒
cat > "$TMP/mkdup.json" <<EOF
{"name":"DupKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"k1","name":"同名","apiKey":"sk-1"},{"id":"k2","name":"同名","apiKey":"sk-2"}],
 "models":[{"id":"mock-model","name":"M"}]}
EOF
assert_contains "密钥重名被拒" "$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkdup.json")" 'Key 名称不能重复'
# 多密钥未命名应被拒
cat > "$TMP/mknn.json" <<EOF
{"name":"NoName","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"k1","name":"","apiKey":"sk-1"},{"id":"k2","name":"B","apiKey":"sk-2"}],
 "models":[{"id":"mock-model","name":"M"}]}
EOF
assert_contains "多密钥未命名被拒" "$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mknn.json")" '每个 Key 都需要填写名称'
# 模拟「编辑时不动密钥、直接保存」:keys 里 apiKey 为空,应沿用原密文
cat > "$TMP/mkupd.json" <<EOF
{"name":"MultiKey","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,"keyRevealable":true,"keys":[{"id":"ka","name":"主号改名","apiKey":""},{"id":"kb","name":"副号","apiKey":""}],"models":[{"id":"mock-model","name":"Mock","keyId":"ka"}]}
EOF
curl -s -X POST "$BASE/api/admin/providers/$MKPROV" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkupd.json" > /dev/null
assert_contains "未改动密钥保存后仍在" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"name":"主号改名"'
# 按 keyId 取回明文(勾选了「保存后保持显示」)
assert_contains "按 keyId 取回第一把" "$(curl -s -X POST "$BASE/api/providers/$MKPROV/key?keyId=ka" -H "$AUTH")" 'sk-key-a'
assert_contains "按 keyId 取回第二把" "$(curl -s -X POST "$BASE/api/providers/$MKPROV/key?keyId=kb" -H "$AUTH")" 'sk-key-b'
# 模型绑定的 keyId 必须存在:传一个不存在的 keyId 应被清掉(不报错)
cat > "$TMP/mkbadkey.json" <<EOF
{"name":"BadKeyRef","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global",
 "keys":[{"id":"ka","name":"A","apiKey":"sk-a"}],
 "models":[{"id":"mock-model","name":"M","keyId":"nope"}]}
EOF
bk=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkbadkey.json")
if printf '%s' "$bk" | grep -q '"keyId"'; then bad "无效 keyId 应被清除"; else ok "无效 keyId 被清除"; fi

# 同一模型绑定多把密钥(优先级链):keyIds 应原样保存,keyId 取第一把
cat > "$TMP/mkchain.json" <<EOF
{"name":"ChainProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"Chained","keyIds":["k1","k2"]}]}
EOF
chain=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkchain.json")
assert_has "模型密钥链保存" "$chain" '"keyIds":["k1","k2"]'
assert_contains "模型密钥链首把 keyId" "$chain" '"keyId":"k1"'
CHAINPROV=$(printf '%s' "$chain" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
# 上游对第一把返回 401:应自动回退到第二把,请求仍然成功
cat > "$TMP/chain-chat.json" <<EOF
{"model":"mock-model","providerId":"$CHAINPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "密钥链认证失败自动回退下一把" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chain-chat.json")" 'MOCK-REPLY'

# 关键场景:供应商配了两把 Key,但模型只绑了第一把(坏号)→ 也应自动回退到供应商的另一把好号
cat > "$TMP/mkone.json" <<EOF
{"name":"OneBindProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"OneBound","keyIds":["k1"]}]}
EOF
onebind=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mkone.json")
ONEBINDPROV=$(printf '%s' "$onebind" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
cat > "$TMP/onebind-chat.json" <<EOF
{"model":"mock-model","providerId":"$ONEBINDPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "模型只绑一把时也回退到供应商其余 Key" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/onebind-chat.json")" 'MOCK-REPLY'
# 模型完全未绑定 Key(仅有供应商多把)时,同样应有回退保障
cat > "$TMP/mknone.json" <<EOF
{"name":"NoBindProv","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiFormat":"chat","scope":"global","costPerCall":1,
 "keys":[{"id":"k1","name":"坏号","apiKey":"sk-fail"},{"id":"k2","name":"好号","apiKey":"sk-good"}],
 "models":[{"id":"mock-model","name":"NoBound"}]}
EOF
nobind=$(curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/mknone.json")
NOBINDPROV=$(printf '%s' "$nobind" | python -c "import sys,json;print(json.load(sys.stdin)['provider']['id'])")
cat > "$TMP/nobind-chat.json" <<EOF
{"model":"mock-model","providerId":"$NOBINDPROV","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
assert_contains "模型未绑定时也回退到供应商其余 Key" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/nobind-chat.json")" 'MOCK-REPLY'

# ---------- 供应商排序 ----------
say "== 供应商排序 =="
# 建两个供应商,把后建的排到前面,验证列表顺序随 order 变化
for nm in OrderA OrderB; do
  cat > "$TMP/ord-$nm.json" <<EOF
{"name":"$nm","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"sk-ord","apiFormat":"chat","scope":"global","models":[{"id":"mock-model","name":"M"}],"costPerCall":1}
EOF
  curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/ord-$nm.json" > /dev/null
done
OA=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([p['id'] for p in d['providers'] if p['name']=='OrderA'][0])")
OB=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([p['id'] for p in d['providers'] if p['name']=='OrderB'][0])")
# 把 OrderB 排到 OrderA 前面
curl -s -X POST "$BASE/api/admin/providers/$OB" -H "$AUTH" -H "Content-Type: application/json" -d '{"action":"reorder","order":["'"$OB"'","'"$OA"'"]}' > /dev/null
ord=$(curl -s "$BASE/api/providers" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);ids=[p['id'] for p in d['providers']];print(ids.index('$OB')<ids.index('$OA'))")
assert_eq "供应商排序: OrderB 排在 OrderA 之前" "$ord" "True"
assert_contains "供应商列表下发 order 字段" "$(curl -s "$BASE/api/providers" -H "$AUTH")" '"order"'

# ---------- 运行日志:提示词/回复/用量 ----------
say "== 运行日志细节 =="
cat > "$TMP/log-chat.json" <<EOF
{"model":"mock-model","providerId":"$PROV","stream":false,"messages":[{"role":"user","content":"记录一下我的日志提示词"}]}
EOF
curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/log-chat.json" > /dev/null
logs=$(curl -s "$BASE/api/admin/logs?limit=20" -H "$AUTH")
assert_contains "日志记录提示词" "$logs" '记录一下我的日志提示词'
assert_contains "日志记录模型回复" "$logs" 'MOCK-REPLY'
assert_contains "日志记录 token 用量" "$logs" '"usage"'
assert_contains "日志记录来源 IP" "$logs" '"ip"'

# ---------- 后台查看对话:完整不截断 ----------
say "== 后台查看对话完整显示 =="
# 正文超过旧上限(2000 字),末尾埋一个标记:只有不截断才能读到
LONGTXT=$(python -c "print('填充正文' * 700 + 'TAILMARKER-完整尾部')")
CHATUID=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print([u['id'] for u in d['users'] if u['name']=='tester1'][0])")
cat > "$TMP/long-chat.json" <<EOF
{"chats":[{"id":"longchat1","title":"长文本对话","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"$LONGTXT","reasoning":"先想一下再回答"}]}]}
EOF
curl -s -X POST "$BASE/api/sync/chats" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/long-chat.json" > /dev/null
chatsresp=$(curl -s "$BASE/api/admin/users/chats?userId=$CHATUID" -H "$AUTH")
assert_contains "后台对话: 长正文未被截断(读到尾部标记)" "$chatsresp" 'TAILMARKER-完整尾部'
assert_contains "后台对话: 带出思维链" "$chatsresp" '先想一下再回答'

say "== 获取模型列表 ==" 
# Git Bash 的 curl 会搅乱 UTF-8 字面量,掩码占位符用字节转义构造,确保后端收到真实的 ••••
MASKEDKEY=$'sk-\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2'
assert_contains "获取模型: 标准 Base URL" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
assert_contains "获取模型: 不带 /v1 自动补全" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
assert_contains "获取模型: 粘贴完整 /v1/models 不重复拼接" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1/models","apiKey":"sk-mock","apiFormat":"chat"}')" 'mock-model'
# 真实场景是「管理员编辑全局供应商」:掩码 Key + 属主/管理员身份才回退存储密钥;
# 普通用户传全局 providerId 不会回退(否则可借用站点密钥拉取上游模型),由下一条用例保证。
printf '{"baseUrl":"http://127.0.0.1:%s/v1","apiKey":"%s","providerId":"%s","apiFormat":"chat"}' "$MOCK_PORT" "$MASKEDKEY" "$PROV" > "$TMP/masked.json"
assert_contains "获取模型: 掩码 Key 回退存储密钥(管理员)" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/masked.json")" 'mock-model'
assert_contains "获取模型: Anthropic 明确提示手填" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"https://api.anthropic.com","apiKey":"x","apiFormat":"anthropic"}')" '手动填写'
assert_contains "获取模型: 缺 Key 且无 providerId 拒绝" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1","apiKey":"","apiFormat":"chat"}')" '请先填写 API Key'
printf '{"baseUrl":"http://127.0.0.1:%s/v1","apiKey":"%s","providerId":"not-exist","apiFormat":"chat"}' "$MOCK_PORT" "$MASKEDKEY" > "$TMP/masked2.json"
assert_contains "获取模型: 掩码 Key 无匹配 providerId 快速失败" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/masked2.json")" '沿用已保存的密钥'
assert_contains "获取模型: 不可达主机可定位" "$(curl -s -X POST "$BASE/api/proxy/fetch-models" -H "$UAUTH" -H "Content-Type: application/json" -d '{"baseUrl":"http://127.0.0.1:9/nope/v1","apiKey":"x","apiFormat":"chat"}')" '无法连接上游'

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
# 白名单归一化:裸模型 id 唯一命中时自动转成「供应商ID|模型ID」;
# 同名歧义或不存在的模型必须明确报 400,不能静默丢弃(否则白名单悄悄失效)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["mock-cheap"]}' > /dev/null
assert_has "裸模型 id 自动解析为供应商规则" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" "\"$COSTPROV|mock-cheap\""
assert_contains "解析后的白名单对 /v1 生效" "$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY2")" 'mock-cheap'
assert_contains "同名模型裸 id 明确报错" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["mock-model"]}')" '无法唯一匹配'
assert_contains "不存在的模型也明确报错" "$(curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiExposedModels":["no-such-model"]}')" '无法唯一匹配'
# 报错时原白名单不被破坏
assert_has "报错后白名单保持原值" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" "\"$COSTPROV|mock-cheap\""
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
# 真实管理员的改动成为演示的还原基准(不会被演示到期还原冲掉)
snap_site() { # 读 demoSnapshot 里的基准 siteName
  php -r '$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
    $v = $pdo->query("SELECT v FROM store WHERE k = \"demoSnapshot\"")->fetchColumn();
    $j = json_decode($v, true);
    echo isset($j["settings"]["siteName"]) ? $j["settings"]["siteName"] : "";' "$1"
}
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"siteName":"REALBASE"}' > /dev/null
assert_eq "真实管理员改动写入演示基准" "$(snap_site "$TMP/data")" "REALBASE"
# 演示管理员改动不写入基准
curl -s -X POST "$BASE/api/admin/settings" -H "$DAUTH" -H "Content-Type: application/json" -d '{"siteName":"DEMOTMP"}' > /dev/null
assert_eq "演示管理员改动不污染基准" "$(snap_site "$TMP/data")" "REALBASE"
assert_contains "config 暴露 demoMode" "$(curl -s "$BASE/api/config")" '"demoMode":true'
# 已有用户可随时转为/取消演示管理员(不限于创建时)
plain=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"plainadmin","password":"pass1234","admin":true}')
PLAINID=$(printf '%s' "$plain" | jget id)
assert_contains "普通管理员创建时非演示" "$plain" '"demo":false'
upd=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","demo":true,"demoMinutes":7}')
assert_contains "可把已有用户转为演示管理员" "$upd" '"demo":true'
assert_contains "转为演示后成为管理员" "$upd" '"admin":true'
assert_contains "转演示可设复原时长" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":7'
# 取消演示身份:快照与 demoMode 一并清零
undemo=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","demo":false}')
assert_contains "可取消演示身份" "$undemo" '"demo":false'
# 不允许把唯一的非演示管理员变为演示(会失去账号管理能力):
# 先把 plainadmin 降为普通成员,使 admin 成为唯一非演示管理员,再尝试转换。
curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$PLAINID"'","admin":false}' > /dev/null
ADMINID=$(python -c "
import json,urllib.request
req=urllib.request.Request('$BASE/api/admin/users', headers={'Authorization':'Bearer $TOKEN'})
d=json.load(urllib.request.urlopen(req))
print([u['id'] for u in d['users'] if u['name']=='admin'][0])
")
selfdemo=$(curl -s -X POST "$BASE/api/admin/users/update" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"'"$ADMINID"'","demo":true}')
assert_contains "不能把唯一普通管理员变为演示" "$selfdemo" '至少要保留一个非演示的管理员'
# 确认 admin 未被改动为演示
assert_contains "唯一管理员未被改坏" "$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"name":"admin"[^}]*')" '"demo":false'
# 演示管理员额度必须尊重填入值(此前会被强制写成 1e15)
dq=$(curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"demoq","password":"demo1234","demo":true,"quota":9999,"demoMinutes":5}' | jget quota)
assert_eq "演示管理员额度按填入值" "$dq" "9999"
assert_contains "演示管理员可配复原时长" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":5'
# 演示管理员改动设置后应处于 demo 模式,且快照记录了改动前的 siteName
DEMOQTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"demoq","password":"demo1234"}' | jget token)
DQAUTH="Authorization: Bearer $DEMOQTOKEN"
curl -s -X POST "$BASE/api/admin/settings" -H "$DQAUTH" -H "Content-Type: application/json" -d '{"siteName":"DemoRenamed"}' > /dev/null
assert_contains "演示管理员改动后进入 demo 模式" "$(curl -s "$BASE/api/config")" '"demoMode":true'
# 还原逻辑的完整往返(拍摄/到期/反复还原)由 tests/demo-revert.php 覆盖,此处只做冒烟
assert_contains "演示模式提示时长可读" "$(curl -s "$BASE/api/config")" '"demoExpireMinutes":'

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
# 游客不能领取套餐额度 / 兑换码(否则可绕过体验轮数)
cat > "$TMP/pkg-free.json" <<'EOF'
{"name":"FreeTrial","quota":500,"price":0,"enabled":true,"limitPerUser":1}
EOF
FREEPKG=$(curl -s -X POST "$BASE/api/admin/packages" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/pkg-free.json" | jget id)
[ -n "$FREEPKG" ] && ok "创建 0 元套餐" || bad "创建 0 元套餐"
assert_contains "游客不能领取免费套餐" "$(curl -s -X POST "$BASE/api/packages/claim" -H "$GAUTH" -H "Content-Type: application/json" -d '{"packageId":"'"$FREEPKG"'"}')" '游客不能领取套餐'
assert_contains "游客不能兑换额度" "$(curl -s -X POST "$BASE/api/packages/redeem" -H "$GAUTH" -H "Content-Type: application/json" -d '{"code":"ANYCODE"}')" '游客不能兑换额度'
assert_contains "游客额度未被套餐改动" "$(curl -s "$BASE/api/auth/me" -H "$GAUTH")" '"quota":4'
# 一键清除游客:普通成员保留,游客及其对话一并删除
curl -s -X POST "$BASE/api/auth/guest" > /dev/null
GUESTCNT=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"guest":true' | wc -l | tr -d ' ')
[ "$GUESTCNT" -ge 1 ] && ok "存在游客账号($GUESTCNT)" || bad "应存在游客账号"
purge=$(curl -s -X POST "$BASE/api/admin/users/purge-guests" -H "$AUTH")
assert_contains "一键清除游客" "$purge" '"ok":true'
assert_contains "清除后有移除计数" "$purge" '"removed":'
LEFT=$(curl -s "$BASE/api/admin/users" -H "$AUTH" | grep -o '"guest":true' | wc -l | tr -d ' ')
assert_eq "清除后无游客" "$LEFT" "0"

# ---------- 性能优化开关 ----------
say "== 性能优化开关 =="
# 默认全关
perfcfg=$(curl -s "$BASE/api/config")
assert_contains "config 下发 perf 开关" "$perfcfg" '"perf"'
assert_contains "性能开关默认不加载字体为 false" "$perfcfg" '"noWebfonts":false'
# 开启「内置字体默认不加载」后,前台配置应据此把默认字体切到系统字体(用户仍可自选)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":true}' > /dev/null
assert_contains "内置字体默认不加载可开启" "$(curl -s "$BASE/api/config")" '"noWebfonts":true'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":false}' > /dev/null
# 打开若干开关后应下发 true,并能读回
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":true,"perfNoKatex":true,"perfNoHighlight":true,"perfNoMermaid":true}' > /dev/null
perfcfg2=$(curl -s "$BASE/api/config")
assert_contains "不加载字体生效" "$perfcfg2" '"noWebfonts":true'
assert_contains "不加载 KaTeX 生效" "$perfcfg2" '"noKatex":true'
assert_contains "不加载高亮生效" "$perfcfg2" '"noHighlight":true'
assert_contains "不加载 Mermaid 生效" "$perfcfg2" '"noMermaid":true'
assert_contains "后台设置可读回 perf" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"perfNoKatex":true'
# 关回去(不影响后续用例)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"perfNoWebfonts":false,"perfNoKatex":false,"perfNoHighlight":false,"perfNoMermaid":false}' > /dev/null
assert_contains "性能开关可关闭" "$(curl -s "$BASE/api/config")" '"noKatex":false'

# ---------- 生图结果本地留存 ----------
say "== 生图本地留存 =="
# 默认开启
assert_contains "生图本地留存默认开启" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveEnabled":true'
assert_contains "留存配额默认 500MB" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":500'
# 可关闭并读回
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveEnabled":false,"imageArchiveQuotaMb":800}' > /dev/null
assert_contains "留存可关闭" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveEnabled":false'
assert_contains "留存配额可改" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":800'
# 配额越界被夹紧
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveQuotaMb":1}' > /dev/null
assert_contains "留存配额下界夹紧到 50" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"imageArchiveQuotaMb":50'
# 关回去(默认开启;网络不可达时自动回退为按需代理,不影响出图)
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"imageArchiveEnabled":true,"imageArchiveQuotaMb":500}' > /dev/null

# ---------- 开放 API 对话落库 ----------
say "== 开放 API 对话落库 =="
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":true,"persistChats":true}' > /dev/null
# 第一次:全新上下文
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic one"}]}' > /dev/null
# 第二次:同一上下文(客户端带上历史) → 应追加到同一对话,不重复历史
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic one"},{"role":"assistant","content":"MOCK-REPLY"},{"role":"user","content":"and more"}]}' > /dev/null
# 第三次:不同上下文 → 新建对话
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic two"}]}' > /dev/null
CHATS=$(curl -s "$BASE/api/sync/chats" -H "$UAUTH")
assert_contains "API 对话已落库" "$CHATS" 'cellar topic one'
assert_contains "新上下文另建对话" "$CHATS" 'cellar topic two'
MSGCNT=$(printf '%s' "$CHATS" | grep -o '"content":"cellar topic one"' | wc -l | tr -d ' ')
assert_eq "同上下文历史未重复" "$MSGCNT" "1"
# 关闭开关后不再落库
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":false}' > /dev/null
curl -s -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $IMGKEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"cellar topic three"}]}' > /dev/null
assert_contains "关闭后不再落库" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"apiSaveChats":false'
if curl -s "$BASE/api/sync/chats" -H "$UAUTH" | grep -q 'cellar topic three'; then bad "关闭 apiSaveChats 后仍落库"; else ok "关闭 apiSaveChats 后不落库"; fi
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"apiSaveChats":true}' > /dev/null

# ---------- 无限额度(-1) ----------
say "== 无限额度 =="
# 管理员创建 quota=-1 的固定兑换码,用户兑换后应变为无限额度
curl -s -X POST "$BASE/api/admin/codes/fixed" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"code":"UNLIMITED2026","quota":-1,"maxRedemptions":1,"perUserLimit":true}' > /dev/null
redeem=$(curl -s -X POST "$BASE/api/packages/redeem" -H "$UAUTH" -H "Content-Type: application/json" -d '{"code":"UNLIMITED2026"}')
assert_contains "固定兑换码可发放无限额度" "$redeem" '"quota":-1'
# 无限额度用户不受额度拦截,可继续调用
assert_contains "无限额度用户可继续对话" "$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d @"$TMP/chat1.json")" 'MOCK-REPLY'
assert_contains "无限额度在 me 中保持 -1" "$(curl -s "$BASE/api/auth/me" -H "$UAUTH")" '"quota":-1'

# ---------- 上游连接失败提示 ----------
say "== 上游连接失败提示 =="
# 指向无法解析的域名:应返回可定位的中文提示,而不是笼统的 504
cat > "$TMP/badprov.json" <<'EOF'
{"name":"BadHost","baseUrl":"http://no-such-host-xyz123.invalid/v1","apiKey":"sk-bad-123456","apiFormat":"chat","scope":"global","models":[{"id":"bad-model"}]}
EOF
curl -s -X POST "$BASE/api/providers" -H "$AUTH" -H "Content-Type: application/json" -d @"$TMP/badprov.json" > /dev/null
BADPROV=$(curl -s "$BASE/api/providers" -H "$AUTH" | grep -o '"id":"[a-f0-9]*","name":"BadHost"' | cut -d'"' -f4)
[ -n "$BADPROV" ] && ok "创建不可达供应商" || bad "创建不可达供应商"
badmsg=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" -d "{\"providerId\":\"$BADPROV\",\"model\":\"bad-model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_contains "连接失败给出可定位提示" "$badmsg" '无法解析上游域名'

# ---------- 授权规则 API 语义:单组更新 vs 全量替换 ----------
say "== 授权规则语义 =="
# 基准快照。注意:内置管理员组会在每次写库时自动补齐全部供应商授权(管理员永远全量可用),
# 因此断言只针对「非管理员组」的规则增删,不能假设全量替换后总条数为 1。
baseline=$(curl -s "$BASE/api/admin/access" -H "$AUTH")
basecount=$(printf '%s' "$baseline" | grep -o '"groupId"' | wc -l | tr -d ' ')
NG=$(curl -s -X POST "$BASE/api/admin/groups" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"access-sem-group"}' | jget id)
[ -n "$NG" ] && ok "创建语义测试组" || bad "创建语义测试组"
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]}" > /dev/null
assert_has "单组更新写入新规则" "$(curl -s "$BASE/api/admin/access" -H "$AUTH")" "\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"mock-model\"]"
newcount=$(curl -s "$BASE/api/admin/access" -H "$AUTH" | grep -o '"groupId"' | wc -l | tr -d ' ')
assert_eq "单组更新不影响其他组(规则数+1)" "$newcount" "$((basecount + 1))"
# rules 数组 = 全量替换:替换后只剩 NG 一条 + 管理员组自愈规则;其他组(如默认组)的规则必须消失
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"rules\":[{\"groupId\":\"$NG\",\"providerId\":\"$PROV\",\"modelIds\":[\"*\"]}]}" > /dev/null
acc_after=$(curl -s "$BASE/api/admin/access" -H "$AUTH")
assert_has "替换后 NG 规则可回读" "$acc_after" "\"groupId\":\"$NG\""
if printf '%s' "$acc_after" | grep -q "\"groupId\":\"$GID1\""; then bad "全量替换应移除未包含组(默认组)的规则"; else ok "全量替换移除了未包含组的规则"; fi
# 用基准快照整体回滚,验证全量替换可用于安全的批量导入
curl -s -X POST "$BASE/api/admin/access" -H "$AUTH" -H "Content-Type: application/json" -d "{\"rules\":$(printf '%s' "$baseline" | sed 's/^{"rules"://; s/}$//')}" > /dev/null
assert_eq "基准快照可整体回滚" "$(curl -s "$BASE/api/admin/access" -H "$AUTH" | grep -o '"groupId"' | wc -l | tr -d ' ')" "$basecount"

# ---------- 多源联网搜索(brave / ddg / jina,走 mock) ----------
say "== 多源联网搜索 =="
# 注意:请求体含中文,一律走文件(--data-binary),避免 Windows 终端把内联中文转成错误编码
cat > "$TMP/ws_q.json" <<'EOF'
{"query":"上海天气","max":3}
EOF
cat > "$TMP/ws_chat.json" <<EOF
{"providerId":"$PROV","model":"mock-model","webSearch":"1","messages":[{"role":"user","content":"上海天气"}]}
EOF
# brave:key 保存后掩码回显,config 暴露 provider,测试端点命中 mock
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":true,"webSearchProvider":"brave","webSearchBraveKey":"BSA-e2e-key-12345","webSearchMaxResults":3}' > /dev/null
assert_contains "brave 供应商可保存" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"webSearchProvider":"brave"'
assert_has "brave key 掩码回显" "$(curl -s "$BASE/api/admin/settings" -H "$AUTH")" '"webSearchBraveKey":"BSA'
assert_contains "config 暴露 brave" "$(curl -s "$BASE/api/config")" '"provider":"brave"'
cat > "$TMP/ws_brave.json" <<'EOF'
{"provider":"brave","query":"上海天气","max":3}
EOF
BRAVE=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_brave.json")
assert_contains "brave 测试命中 mock" "$BRAVE" '"ok":true'
assert_contains "brave 结果带查询词" "$BRAVE" 'Brave:上海天气'
# ddg:免 key;广告被过滤、uddg 跳转解包
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"ddg"}' > /dev/null
cat > "$TMP/ws_ddg.json" <<'EOF'
{"provider":"ddg","query":"上海天气","max":3}
EOF
DDG=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_ddg.json")
assert_contains "ddg 测试命中 mock" "$DDG" '"ok":true'
assert_contains "ddg 广告被过滤(只剩 2 条)" "$DDG" '"count":2'
assert_contains "ddg uddg 解包" "$DDG" 'example.com/ddg1'
# jina:免 key 也可测,JSON 解析
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"jina","webSearchJinaKey":""}' > /dev/null
cat > "$TMP/ws_jina.json" <<'EOF'
{"provider":"jina","query":"上海天气","max":3}
EOF
JINA=$(curl -s -X POST "$BASE/api/admin/search/test" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_jina.json")
assert_contains "jina 免 key 可用" "$JINA" '"ok":true'
assert_contains "jina JSON 解析" "$JINA" 'Jina:上海天气'
# 对话链路:brave 无 key → ready=false,搜索请求 502 且可定位;ddg → 搜索走通,回复正常
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"brave","webSearchBraveKey":""}' > /dev/null
CHATNS=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_chat.json")
assert_contains "brave 无 key 时搜索失败可定位" "$CHATNS" '联网搜索失败'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchProvider":"ddg"}' > /dev/null
CHATDS=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ws_chat.json")
assert_contains "ddg 搜索走通对话正常" "$CHATDS" 'MOCK-REPLY'
# 用户自备源:ddg 免 key 即 ready
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchAllowUser":true}' > /dev/null
TOOLS=$(curl -s -X POST "$BASE/api/me/tools" -H "$UAUTH" -H "Content-Type: application/json" -d '{"webSearchSource":"own","webSearchProvider":"ddg"}')
assert_contains "用户自备 ddg 即 ready" "$TOOLS" '"ownReady":true'
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchAllowUser":false}' > /dev/null

# ---------- 文档解析通道(PaddleOCR / Mistral OCR,按类别路由,走 mock) ----------
say "== 搜索结果正文抓取 =="
# 用 mock 页面验证整条链路:搜索结果 -> 抓正文 -> 注入模型上下文。
# mock 页面刻意把导航放前面、正文里带裸 "<"(曾让 strip_tags 吞掉整段正文)。
cat > "$TMP/pf_echo.json" <<EOF
{"providerId":"$PROV","model":"mock-echo-system","webSearch":"1","messages":[{"role":"user","content":"上海天气"}]}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":true,"webSearchProvider":"ddg","webSearchMaxResults":3}' > /dev/null
PFRES=$(curl -s -X POST "$BASE/api/proxy/chat" -H "$UAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/pf_echo.json")
assert_contains "联网搜索开启后请求走通" "$PFRES" 'MOCK-ECHO-OK'
assert_contains "搜索结果正文已注入上下文" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" 'MOCK-PAGE-BODY-OK'
assert_contains "正文里的温度数据被保留" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '21℃'
# 裸 <(风力「<3级」)之后的正文不能被 strip_tags 吞掉 —— 本次修复的核心回归
assert_contains "正文裸 < 不再吞掉后续内容" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '明天阴'
assert_contains "风力数据随裸 < 一起保留" "$(cat "$TMP/pf_echo_out.txt" 2>/dev/null)" '3级'
if grep -qF 'MOCK-SCRIPT-SHOULD-NOT-APPEAR' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "脚本内容进了上下文"; else ok "脚本内容不进上下文"; fi
if grep -qF 'MOCK-COMMENT-SHOULD-NOT-APPEAR' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "注释内容进了上下文"; else ok "注释内容不进上下文"; fi
if grep -qF '天气地图' "$TMP/pf_echo_out.txt" 2>/dev/null; then bad "导航菜单未被瘦身"; else ok "导航菜单被瘦身"; fi
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"webSearchEnabled":false}' > /dev/null

say "== 文档解析通道路由 =="
# 路由与凭据保存:pdf->mistral, image->paddle, office->mineru;key 掩码回显
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"pdf":"mistral","image":"paddle","office":"mineru"},"mistralOcrKey":"sk-mistral-e2e","paddleOcrUrl":"http://127.0.0.1:'"$MOCK_PORT"'/ocr","paddleOcrKey":""}' > /dev/null
SR=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_contains "路由表保存" "$SR" '"parseChannels":{"pdf":"mistral","image":"paddle","office":"mineru"}'
assert_has "mistral key 掩码回显" "$SR" '"mistralOcrKey":"sk-m'
assert_contains "config 暴露路由" "$(curl -s "$BASE/api/config")" '"routes":{"pdf":"mistral","image":"paddle","office":"mineru"}'
# 造测试文件(内容不校验,mock 只看路由与请求形状)
printf '%%PDF-1.4 mock pdf bytes' > "$TMP/doc.pdf"
printf 'PNG-mock-image-bytes' > "$TMP/img.png"
printf 'DOCX-mock-bytes' > "$TMP/notes.docx"
# 上传解析:原生 curl 读不了 -F 里 MSYS 风格的 /tmp 路径,统一在 $TMP 下用相对路径发起
parse_upload() { # $1=文件名(位于 $TMP) $2=token
  ( cd "$TMP" && curl -s -X POST "$BASE/api/documents/parse" -H "Authorization: Bearer $2" -F "file=@$1;filename=$1" )
}
# 图片走 paddle:两页 rec_texts 拼接
PADDLE=$(parse_upload img.png "$TOKEN")
assert_contains "图片走 PaddleOCR 通道" "$PADDLE" '"channel":"paddle"'
assert_contains "paddle rec_texts 拼接成 markdown" "$PADDLE" 'PaddleOCR 识别 第一行'
assert_contains "paddle 多页合并" "$PADDLE" '第二页识别'
# pdf 走 mistral:分页 markdown 拼接
MIST=$(parse_upload doc.pdf "$TOKEN")
assert_contains "pdf 走 Mistral 通道" "$MIST" '"channel":"mistral"'
assert_contains "mistral 分页 markdown" "$MIST" 'Mistral 第一页'
assert_contains "mistral 第二页合并" "$MIST" '第二页内容'
# 错误路由:office 指到 paddle → 明确报格式不支持
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"office":"paddle"}}' > /dev/null
MISR=$(parse_upload notes.docx "$TOKEN")
assert_contains "office 误路由 paddle 报格式不支持" "$MISR" 'PaddleOCR 仅支持 PDF 与图片'
# 通道未配置:清空 paddle 地址后图片解析报可定位错误
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"paddleOcrUrl":""}' > /dev/null
NOP=$(parse_upload img.png "$TOKEN")
assert_contains "paddle 未配置报可定位错误" "$NOP" '还没有填写服务地址'
# mistral 坏 key:上游 401 透传
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"mistralOcrKey":"sk-bad-mistral"}' > /dev/null
BADK=$(parse_upload doc.pdf "$TOKEN")
assert_contains "mistral 坏 key 错误透传" "$BADK" 'invalid mistral key'
# 恢复默认路由
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"parseChannels":{"pdf":"mineru","image":"mineru","office":"mineru"},"mistralOcrKey":"","paddleOcrUrl":"http://127.0.0.1:'"$MOCK_PORT"'/ocr"}' > /dev/null

# ---------- 第三方一键登录(微信 / QQ / LinuxDO / NodeLoc,走 mock 提供商) ----------
say "== 第三方一键登录 =="
OAUTHBASE="http://127.0.0.1:$OAUTH_PORT"
# 保存四家配置(含掩码回显与未配置时的行为)
cat > "$TMP/oauth_cfg.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true,"appId":"wx-e2e-app","appSecret":"wx-e2e-secret"},"qq":{"enabled":true,"appId":"123456","appKey":"qq-e2e-key"},"linuxdo":{"enabled":true,"clientId":"ldo-e2e-id","clientSecret":"ldo-e2e-secret"},"nodeloc":{"enabled":true,"clientId":"ndl-e2e-id","clientSecret":"ndl-e2e-secret"}},"oauthAutoRegister":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oauth_cfg.json" > /dev/null
OS=$(curl -s "$BASE/api/admin/settings" -H "$AUTH")
assert_contains "第三方登录:微信可保存" "$OS" '"appId":"wx-e2e-app"'
assert_has "第三方登录:密钥掩码回显" "$OS" '"appSecret":"wx-e'
assert_contains "第三方登录:自动注册开关可保存" "$OS" '"oauthAutoRegister":true'
# config 下发已启用的提供商(登录页据此渲染图标)
OCFG=$(curl -s "$BASE/api/config")
for pid in wechat qq linuxdo nodeloc; do
  assert_contains "config 下发 $pid 图标" "$OCFG" "\"id\":\"$pid\""
done
assert_contains "config 带图标路径" "$OCFG" 'static/logo/weixin.svg'
# 掩码保存不覆盖真实密钥(只传掩码)
cat > "$TMP/oauth_mask.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true,"appSecret":"wx-••••cret"}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oauth_mask.json" > /dev/null
cat > "$TMP/getsecret.php" <<'PHPEOF'
<?php
$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
$s = json_decode($pdo->query('SELECT v FROM store WHERE k = "settings"')->fetchColumn(), true);
echo isset($s["oauthProviders"]["wechat"]["appSecret"]) ? $s["oauthProviders"]["wechat"]["appSecret"] : "";
PHPEOF
php_out=$(php "$TMP/getsecret.php" "$TMP/data")
assert_eq "掩码保存保留原密钥" "$php_out" "wx-e2e-secret"

# 未配置的提供商:发起授权应提示未启用
curl -s -o /dev/null -D "$TMP/h.disabled" "$BASE/auth/wechat?x=1" 2>/dev/null
# (先记下启用状态,再临时关掉微信验证提示)
cat > "$TMP/off.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/off.json" > /dev/null
DIS=$(curl -s -D - -o /dev/null "$BASE/auth/wechat" | grep -i '^location:' | head -1)
assert_has "未启用时提示未配置" "$DIS" 'oauth_error='
cat > "$TMP/on.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":true}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/on.json" > /dev/null

# 全链路(Nodeloc):发起 -> 授权 -> 回调 -> 票据 -> 换登录态
oauth_flow() { # $1=provider, 输出最终 location
  local pid="$1"
  local auth=$(curl -s -D - -o /dev/null "$BASE/auth/$pid" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r')
  local cb=$(curl -s -D - -o /dev/null "$auth" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r')
  curl -s -D - -o /dev/null "$cb" | grep -i '^location:' | sed 's/^[Ll]ocation: //' | tr -d '\r'
}
NODEID=""
for pid in nodeloc linuxdo; do
  LAND=$(oauth_flow "$pid")
  assert_contains "$pid 登录链路到达前台票据" "$LAND" 'oauth_ticket='
  TK=$(printf '%s' "$LAND" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
  cat > "$TMP/tk.json" <<EOF2
{"ticket":"$TK"}
EOF2
  EX=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk.json")
  assert_contains "$pid 票据可换登录态" "$EX" '"token":"'
  UNAME=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
  # 昵称重名时自动加数字后缀去重,因此只断言前缀
  case "$UNAME" in
    E2E测试用户*) ok "$pid 自动建号用户名($UNAME)" ;;
    *) bad "$pid 自动建号用户名(得到 $UNAME)" ;;
  esac
  if [ "$pid" = "nodeloc" ]; then
    NODEID=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
  fi
  # 同一票据只能换一次
  EX2=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk.json")
  assert_contains "$pid 票据不可重放" "$EX2" '已使用'
done
# 同一第三方账号二次登录(仍是 nodeloc):不再建号,直接复用原账号
LAND2=$(oauth_flow nodeloc)
TK2=$(printf '%s' "$LAND2" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/tk2.json" <<EOF3
{"ticket":"$TK2"}
EOF3
EX3=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/tk2.json")
ID3=$(printf '%s' "$EX3" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
assert_eq "同一第三方账号再次登录复用原账号" "$ID3" "$NODEID"

# 关闭自动注册:未绑定的第三方账号应被拒(先解绑 wechat,再关闭自动注册)
BTOKEN_TMP=$(printf '%s' "$EX3" | python -c "import sys,json;print(json.load(sys.stdin)['token'])" 2>/dev/null)
curl -s -X DELETE "$BASE/api/me/oauth/wechat" -H "Authorization: Bearer $BTOKEN_TMP" > /dev/null
cat > "$TMP/off2.json" <<'EOF'
{"oauthAutoRegister":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/off2.json" > /dev/null
LANDNR=$(oauth_flow wechat)
assert_has "关闭自动注册后未绑定账号被拒" "$LANDNR" 'oauth_error='
cat > "$TMP/on2.json" <<'EOF'
{"oauthAutoRegister":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/on2.json" > /dev/null

# 微信链路(独立端点形状:GET 换 token + openid 随 token 返回)
LANDW=$(oauth_flow wechat)
assert_contains "微信登录链路到达前台票据" "$LANDW" 'oauth_ticket='
# QQ 链路(需二次请求取 OpenID)
LANDQ=$(oauth_flow qq)
assert_contains "QQ 登录链路到达前台票据" "$LANDQ" 'oauth_ticket='

# 已登录用户:绑定 / 解绑 / 已绑定列表
# 注意:解绑唯一绑定需要账号已设置密码(防呆保护),这里先设密码再继续
BINDUSER=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
BTOKEN=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['token'])" 2>/dev/null)
cat > "$TMP/bpwd.json" <<'EOF'
{"oldPassword":"","newPassword":"bindsetup1"}
EOF
curl -s -X POST "$BASE/api/auth/password" -H "Authorization: Bearer $BTOKEN" -H "Content-Type: application/json" --data-binary @"$TMP/bpwd.json" > /dev/null
BUNAME=$(printf '%s' "$EX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
cat > "$TMP/blogin.json" <<EOF9
{"name":"$BUNAME","password":"bindsetup1"}
EOF9
BTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/blogin.json" | jget token)
BIND=$(curl -s "$BASE/api/me/oauth" -H "Authorization: Bearer $BTOKEN")
assert_contains "绑定列表含 wechat" "$BIND" '"id":"wechat"'
assert_contains "绑定列表标记已绑定" "$BIND" '"bound":true'
UNB=$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "Authorization: Bearer $BTOKEN")
assert_contains "解绑成功" "$UNB" '"ok":true'
BIND2=$(curl -s "$BASE/api/me/oauth" -H "Authorization: Bearer $BTOKEN")
if printf '%s' "$BIND2" | grep -q '"id":"linuxdo","name":"LINUX DO","logo":"[^"]*","enabled":true,"bound":true'; then
  bad "解绑后 linuxdo 仍显示已绑定"
else
  ok "解绑后状态刷新"
fi
UNB2=$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "Authorization: Bearer $BTOKEN")
assert_contains "重复解绑被拒" "$UNB2" '未绑定'

# ---------- 余量明细与第三方账号资料补全 ----------
say "== 余量明细 / 资料补全 =="
# 造一个有明确额度的用户,验证每笔扣减都带用途与前后余额
cat > "$TMP/qu.json" <<'EOF'
{"name":"ledgeruser","password":"test1234","quota":20}
EOF
curl -s -X POST "$BASE/api/admin/users" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/qu.json" > /dev/null
LT=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"name":"ledgeruser","password":"test1234"}' | jget token)
[ -n "$LT" ] && ok "余量明细测试用户登录" || bad "余量明细测试用户登录"
LAUTH="Authorization: Bearer $LT"
# 普通对话
cat > "$TMP/lc1.json" <<'EOF'
{"providerId":"x","model":"mock-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF
cat > "$TMP/lc1.json" <<EOF2
{"providerId":"$PROV","model":"mock-model","stream":false,"messages":[{"role":"user","content":"hi"}]}
EOF2
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc1.json" > /dev/null
# 带用途:生成标题 / 生成跟进建议
cat > "$TMP/lc2.json" <<EOF3
{"providerId":"$PROV","model":"mock-model","stream":false,"_purpose":"title","messages":[{"role":"user","content":"t"}]}
EOF3
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc2.json" > /dev/null
cat > "$TMP/lc3.json" <<EOF4
{"providerId":"$PROV","model":"mock-model","stream":false,"_purpose":"followup","messages":[{"role":"user","content":"f"}]}
EOF4
curl -s -X POST "$BASE/api/proxy/chat" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lc3.json" > /dev/null
LEDGER=$(curl -s "$BASE/api/me/quota/ledger" -H "$LAUTH")
assert_contains "明细记录普通对话" "$LEDGER" '对话'
assert_contains "明细记录生成标题" "$LEDGER" '生成标题'
assert_contains "明细记录生成跟进建议" "$LEDGER" '生成跟进建议'
assert_contains "明细带余额变化" "$LEDGER" '"before":'
LED_SPENT=$(printf '%s' "$LEDGER" | python -c "import sys,json;print(json.load(sys.stdin)['spent'])" 2>/dev/null)
if [ -n "$LED_SPENT" ] && [ "$LED_SPENT" != "0" ] && [ "$LED_SPENT" != "0.0" ]; then ok "明细汇总消耗为 $LED_SPENT"; else bad "明细汇总消耗为空($LED_SPENT)"; fi
# 分页参数
assert_contains "明细支持 limit" "$(curl -s "$BASE/api/me/quota/ledger?limit=1" -H "$LAUTH")" '"total":3'
# 充值/兑换码也进同一明细
cat > "$TMP/lpkg.json" <<'EOF'
{"name":"明细测试套餐","quota":10,"enabled":true}
EOF
LPKG=$(curl -s -X POST "$BASE/api/admin/packages" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lpkg.json" | jget id)
LCODE=$(curl -s -X POST "$BASE/api/admin/packages/$LPKG/codes" -H "$AUTH" -H "Content-Type: application/json" -d '{"count":1}' | python -c "import sys,json;print(json.load(sys.stdin)['codes'][0])" 2>/dev/null)
cat > "$TMP/lrd.json" <<EOF5
{"code":"$LCODE"}
EOF5
curl -s -X POST "$BASE/api/packages/redeem" -H "$LAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/lrd.json" > /dev/null
assert_contains "明细记录兑换码获得" "$(curl -s "$BASE/api/me/quota/ledger" -H "$LAUTH")" '兑换码'

# 第三方账号:改用户名 / 设密码(无密码用户不要求旧密码)
cat > "$TMP/ou_cfg.json" <<'EOF'
{"oauthProviders":{"nodeloc":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ou_cfg.json" > /dev/null
OLAND=$(oauth_flow nodeloc)
OTK=$(printf '%s' "$OLAND" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk.json" <<EOF6
{"ticket":"$OTK"}
EOF6
OEX=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk.json")
OT=$(printf '%s' "$OEX" | jget token)
OAUTH="Authorization: Bearer $OT"
assert_contains "第三方用户登录后无密码标记" "$(curl -s "$BASE/api/auth/me" -H "$OAUTH")" '"hasPassword":false'
# 无密码用户:直接设密码(不带 oldPassword)
cat > "$TMP/opw.json" <<'EOF'
{"oldPassword":"","newPassword":"oauthpass1"}
EOF
assert_contains "无密码用户可直接设密码" "$(curl -s -X POST "$BASE/api/auth/password" -H "$OAUTH" -H "Content-Type: application/json" --data-binary @"$TMP/opw.json")" '"ok":true'
# 设密码后 tv 递增,用「自动建号时的实际用户名 + 刚设的密码」重新登录
OUNAME=$(printf '%s' "$OEX" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
cat > "$TMP/ologin.json" <<EOF9
{"name":"$OUNAME","password":"oauthpass1"}
EOF9
OT2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/ologin.json" | jget token)
if [ -n "$OT2" ]; then ok "设密码后可用密码登录($OUNAME)"; else bad "设密码后无法用密码登录($OUNAME)"; fi
OAUTH2="Authorization: Bearer $OT2"
cat > "$TMP/oname.json" <<'EOF'
{"name":"oauthrenamed","password":"oauthpass1"}
EOF
RNAME=$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname.json")
assert_contains "第三方用户可改用户名" "$RNAME" '"name":"oauthrenamed"'
# 改名会让旧会话失效(tv 递增),用返回的新 token 继续做校验用例
AT3=$(printf '%s' "$RNAME" | jget token)
OAUTH2="Authorization: Bearer $AT3"
# 校验:密码错误 / 重名 / 非法名
cat > "$TMP/oname_bad.json" <<'EOF'
{"name":"anothername","password":"wrong"}
EOF
assert_contains "改名校验:密码错误被拒" "$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname_bad.json")" '请输入当前密码'
cat > "$TMP/oname_dup.json" <<'EOF'
{"name":"admin","password":"oauthpass1"}
EOF
assert_contains "改名校验:重名被拒" "$(curl -s -X POST "$BASE/api/auth/name" -H "$OAUTH2" -H "Content-Type: application/json" --data-binary @"$TMP/oname_dup.json")" '用户名已存在'
# 开启「强制补全」:exchange 返回 needsProfile,且已有密码的用户不再要求
cat > "$TMP/reqp.json" <<'EOF'
{"oauthRequireProfile":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/reqp.json" > /dev/null
assert_contains "config 下发补全开关" "$(curl -s "$BASE/api/config")" '"requireProfile":true'
OLAND2=$(oauth_flow wechat)
OTK2=$(printf '%s' "$OLAND2" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk2.json" <<EOF7
{"ticket":"$OTK2"}
EOF7
assert_contains "无密码新用户 exchange 要求补全" "$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk2.json")" '"needsProfile":true'
OLAND3=$(oauth_flow nodeloc)
OTK3=$(printf '%s' "$OLAND3" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otk3.json" <<EOF8
{"ticket":"$OTK3"}
EOF8
assert_contains "已设密码用户不再要求补全" "$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otk3.json")" '"needsProfile":false'
cat > "$TMP/reqp2.json" <<'EOF'
{"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/reqp2.json" > /dev/null

# ---------- 第三方登录回跳与提示标记 ----------
say "== 第三方登录回跳标记 =="
cat > "$TMP/rc.json" <<'EOF'
{"oauthProviders":{"nodeloc":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":true}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/rc.json" > /dev/null
# 未绑定新账号:落地地址应带 oauth_created=1(前端据此提示"已创建新账号")。
# 先清空该第三方 uid 的既有绑定,确保本次是"首次建号"。
cat > "$TMP/rcqq.json" <<'EOF'
{"oauthProviders":{"qq":{"enabled":true}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/rcqq.json" > /dev/null
cat > "$TMP/unbind_all.php" <<'PHPEOF'
<?php
// 清掉所有用户的 oauth 绑定,让后续第三方登录都走"首次建号"分支
$pdo = new PDO("sqlite:" . $argv[1] . "/tinychat.sqlite");
$u = json_decode($pdo->query('SELECT v FROM store WHERE k = "users"')->fetchColumn(), true);
foreach ($u as $i => $x) { $u[$i]["oauth"] = array(); }
$pdo->prepare('UPDATE store SET v = ? WHERE k = "users"')->execute(array(json_encode($u, JSON_UNESCAPED_UNICODE)));
PHPEOF
php "$TMP/unbind_all.php" "$TMP/data"
NEWLAND=$(oauth_flow qq)
assert_contains "新账号落地带 created 标记" "$NEWLAND" 'oauth_created=1'
assert_contains "新账号落地带票据" "$NEWLAND" 'oauth_ticket='
# 已绑定账号:落地不带 created 标记
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" -d '{"oauthRequireProfile":false}' > /dev/null
# 同一第三方账号第二次登录:已绑定,落地不应再带 created 标记
BOUNDLAND=$(oauth_flow qq)
assert_contains "已绑定账号落地带票据" "$BOUNDLAND" 'oauth_ticket='
if printf '%s' "$BOUNDLAND" | grep -q 'oauth_created=1'; then bad "已绑定账号不应带 created 标记"; else ok "已绑定账号不带 created 标记"; fi
cat > "$TMP/oc_off.json" <<'EOF'
{"oauthProviders":{"wechat":{"enabled":false},"linuxdo":{"enabled":false},"qq":{"enabled":false},"nodeloc":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/oc_off.json" > /dev/null

# ---------- 第三方绑定的列表/防呆/后台管理 ----------
say "== 第三方绑定管理 =="
cat > "$TMP/ob_cfg.json" <<'EOF'
{"oauthProviders":{"linuxdo":{"enabled":true}},"oauthAutoRegister":true,"oauthRequireProfile":false}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ob_cfg.json" > /dev/null
# 全新第三方账号:设密码前「解绑唯一绑定」应被拒(否则账号无法登录)
OLANDB=$(oauth_flow linuxdo)
OTKB=$(printf '%s' "$OLANDB" | sed 's/.*oauth_ticket=//' | sed 's/&.*//')
cat > "$TMP/otkb.json" <<EOF2
{"ticket":"$OTKB"}
EOF2
OEXB=$(curl -s -X POST "$BASE/api/auth/oauth/exchange" -H "Content-Type: application/json" --data-binary @"$TMP/otkb.json")
OTB=$(printf '%s' "$OEXB" | jget token)
OUID=$(printf '%s' "$OEXB" | python -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
OB="Authorization: Bearer $OTB"
UNAME_B=$(printf '%s' "$OEXB" | python -c "import sys,json;print(json.load(sys.stdin)['user']['name'])" 2>/dev/null)
assert_contains "绑定列表返回全部平台" "$(curl -s "$BASE/api/me/oauth" -H "$OB")" '"id":"wechat"'
# 接口返回 enabled 标记(前端据此过滤:未启用的平台对用户不可见,已绑定的除外)
assert_contains "绑定接口带 enabled 标记供前端过滤" "$(curl -s "$BASE/api/me/oauth" -H "$OB")" '"enabled":false'
assert_contains "无密码时解绑唯一绑定被拒" "$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "$OB")" '还没有设置密码'
# 管理端:查看该用户绑定(含 bindUrl)
AUSER=$(curl -s "$BASE/api/admin/users/oauth?userId=$OUID" -H "$AUTH")
assert_contains "管理端可见用户绑定" "$AUSER" '"bound":true'
assert_contains "管理端给出绑定链接" "$AUSER" '/auth/linuxdo?bind='
# 管理端解绑同样受防呆保护
assert_contains "管理端解绑也受防呆保护" "$(curl -s -X DELETE "$BASE/api/admin/users/$OUID/oauth/linuxdo" -H "$AUTH")" '还没有设置密码'
# 用户设密码后可解绑
cat > "$TMP/obpw.json" <<'EOF'
{"oldPassword":"","newPassword":"bindpass123"}
EOF
curl -s -X POST "$BASE/api/auth/password" -H "$OB" -H "Content-Type: application/json" --data-binary @"$TMP/obpw.json" > /dev/null
cat > "$TMP/oblogin.json" <<EOF10
{"name":"$UNAME_B","password":"bindpass123"}
EOF10
OTB2=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$TMP/oblogin.json" | jget token)
ob='Authorization: Bearer '"$OTB2"
assert_contains "设密码后可解绑" "$(curl -s -X DELETE "$BASE/api/me/oauth/linuxdo" -H "$ob")" '"ok":true'
cat > "$TMP/ob_off.json" <<'EOF'
{"oauthProviders":{"linuxdo":{"enabled":false}}}
EOF
curl -s -X POST "$BASE/api/admin/settings" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/ob_off.json" > /dev/null

say "== 服务器状态看板 =="
SYS=$(curl -s "$BASE/api/admin/system" -H "$AUTH")
assert_contains "系统接口返回服务器信息" "$SYS" '"phpVersion"'
assert_contains "系统接口返回磁盘信息" "$SYS" '"freeBytes"'
assert_contains "系统接口返回存储分类" "$SYS" '"storage"'
assert_contains "统计在线用户" "$SYS" '"online"'
assert_contains "统计总用户" "$SYS" '"total":'
assert_contains "统计今日调用" "$SYS" '"today"'
assert_contains "统计对话总数" "$SYS" '"chats"'
assert_contains "返回版本号" "$SYS" '"version"'
# 非管理员不可访问
assert_contains "非管理员访问系统接口被拒" "$(curl -s "$BASE/api/admin/system" -H "$UAUTH")" '需要管理员权限'
assert_contains "非管理员访问存储接口被拒" "$(curl -s "$BASE/api/admin/storage" -H "$UAUTH")" '需要管理员权限'

say "== 存储管理 =="
ST=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "存储接口返回分类占用" "$ST" '"categories"'
assert_contains "存储接口返回数据目录" "$ST" '"dataDir"'
assert_contains "存储接口返回备份清单" "$ST" '"backups"'
assert_contains "存储接口返回生图留存清单" "$ST" '"images"'
assert_contains "存储接口返回日志统计" "$ST" '"logs"'
assert_contains "分类含数据库" "$ST" '"key":"database"'
assert_contains "分类含生图留存" "$ST" '"key":"imgstore"'
assert_contains "分类含运行日志" "$ST" '"key":"logs"'
# 时间戳是毫秒(前端直接 new Date 即可,避免 1970 显示)
assert_contains "文件时间戳为毫秒" "$(printf '%s' "$ST" | grep -o '"mtime":[0-9]\{13\}' | head -1)" '"mtime":'
# 未知清理目标应报错
cat > "$TMP/st_bad.json" <<'EOF'
{"target":"nope"}
EOF
assert_contains "未知清理目标被拒" "$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_bad.json")" '未知的清理目标'
# 写入图片缓存与生图留存文件,验证清理真实生效
mkdir -p "$TMP/data/imgcache" "$TMP/data/imgstore"
php -r '$d=$argv[1];file_put_contents($d."/imgcache/e2e-cache.bin",str_repeat("x",2048));file_put_contents($d."/imgstore/e2e-img.bin",str_repeat("y",4096));' "$TMP/data"
ST2=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "生图留存清单可读" "$ST2" '"images":{"items":'
assert_contains "写入的生图留存文件出现在清单" "$ST2" 'e2e-img.bin'
cat > "$TMP/st_imgcache.json" <<'EOF'
{"target":"imagecache"}
EOF
CL1=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_imgcache.json")
assert_contains "清理图片缓存成功" "$CL1" '"ok":true'
assert_contains "清理图片缓存统计到 1 个文件" "$CL1" '"removed":1'
assert_contains "清理后缓存占用归零" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" '"key":"imgcache"'
cat > "$TMP/st_images.json" <<'EOF'
{"target":"images"}
EOF
CL2=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_images.json")
assert_contains "清理生图留存成功" "$CL2" '"ok":true'
assert_contains "生图留存清理标签正确" "$CL2" '"label":"生图留存"'
cat > "$TMP/st_logs.json" <<'EOF'
{"target":"logs"}
EOF
assert_contains "清理运行日志成功" "$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_logs.json")" '"ok":true'
# 更新残留:目录里含子目录(真实结构是 update/backup/lib/... + update/package/...)。
# 递归删除曾因闭包未 use 自身而致命失败(「更新残留清理不了」),这里专门覆盖多级嵌套。
mkdir -p "$TMP/data/update/backup/lib" "$TMP/data/update/package/src" "$TMP/data/imgcache/nested/deep"
php -r '$d=$argv[1];
file_put_contents($d."/update/update-check.json","root");
file_put_contents($d."/update/backup/lib/core.php","backup-a");
file_put_contents($d."/update/backup/CHANGELOG.md","backup-b");
file_put_contents($d."/update/package/src/index.php","pkg");
file_put_contents($d."/imgcache/nested/deep/cache.bin","cache");' "$TMP/data"
ST3=$(curl -s "$BASE/api/admin/storage" -H "$AUTH")
assert_contains "多级子目录文件被计入占用" "$ST3" '"key":"update"'
cat > "$TMP/st_updates.json" <<'EOF'
{"target":"updates"}
EOF
CL3=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_updates.json")
assert_contains "更新残留(含子目录)清理成功" "$CL3" '"ok":true'
assert_contains "更新残留递归删到 4 个文件(含两级子目录)" "$CL3" '"removed":4'
assert_contains "更新残留标签正确" "$CL3" '"label":"更新残留"'
assert_contains "更新残留清理后归零" "$(curl -s "$BASE/api/admin/storage" -H "$AUTH")" '"key":"update"'
# 图片代理缓存的子目录同样要能清掉
cat > "$TMP/st_ic2.json" <<'EOF'
{"target":"imagecache"}
EOF
CL4=$(curl -s -X POST "$BASE/api/admin/storage/clean" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$TMP/st_ic2.json")
assert_contains "图片缓存(含子目录)清理成功" "$CL4" '"ok":true'
assert_contains "图片缓存递归删到 1 个文件" "$CL4" '"removed":1'
# 系统接口在清理后依然可用(不因日志/缓存被清而 500)
assert_contains "清理后系统接口仍正常" "$(curl -s "$BASE/api/admin/system" -H "$AUTH")" '"server"'
say ""
say "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]