#!/bin/bash
# Phase 1 后端测试脚本
# 使用方法：先启动服务器 (npm start)，再运行此脚本
# bash docs/test-phase1.sh

BASE="http://localhost:4000"
PASS=0
FAIL=0

# 创建临时测试文件
TMPFILE=$(mktemp /tmp/test-upload-XXXXXX.txt 2>/dev/null || echo "/tmp/test-upload-$$.txt")
echo "hello test" > "$TMPFILE"

check() {
  local name="$1"
  local result="$2"
  local expected="$3"
  if echo "$result" | grep -q "$expected"; then
    echo "  ✓ $name"
    PASS=$((PASS+1))
  else
    echo "  ✗ $name"
    echo "    Expected to find: $expected"
    echo "    Got: $result"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "=== Phase 1 Backend Tests ==="
echo ""

# 1. 单文件上传（向后兼容，不带 groupId）
echo "[1] 单文件上传（向后兼容）"
UPLOAD_RESULT=$(curl -s -X POST \
  "$BASE/api/files/upload?uploadId=test001&filename=phase1test.txt" \
  -F "files=@$TMPFILE;filename=phase1test.txt" \
  -F "targetPath=")
check "上传成功返回 success:true" "$UPLOAD_RESULT" '"success":true'
check "上传返回 uploadId" "$UPLOAD_RESULT" '"uploadId":"test001"'

echo ""

# 2. 带 groupId 的文件上传
echo "[2] 带 groupId 的文件上传"
UPLOAD_GROUP_RESULT=$(curl -s -X POST \
  "$BASE/api/files/upload?uploadId=test002&groupId=grp001&relPath=MyFolder%2Fsub%2Fa.txt&groupRoot=MyFolder&rootLabel=MyFolder&filename=phase1a.txt" \
  -F "files=@$TMPFILE;filename=phase1a.txt" \
  -F "targetPath=")
check "带 groupId 上传成功" "$UPLOAD_GROUP_RESULT" '"success":true'

echo ""

# 3. SSE 端点返回 tasks + groups
echo "[3] SSE 返回 tasks + groups 格式"
# 上传一个带 groupId 的文件
curl -s -X POST \
  "$BASE/api/files/upload?uploadId=test003&groupId=grp002&rootLabel=TestFolder&filename=phase1b.txt" \
  -F "files=@$TMPFILE;filename=phase1b.txt" \
  -F "targetPath=" > /dev/null

# 等待 SSE 发送数据（在 8 秒内，服务器保留进度记录）
SSE_DATA=$(curl -s -N --max-time 2 \
  -H "Accept: text/event-stream" \
  "$BASE/api/files/upload-progress" 2>/dev/null)
check "SSE 包含 tasks 字段" "$SSE_DATA" '"tasks"'
check "SSE 包含 groups 字段" "$SSE_DATA" '"groups"'

echo ""

# 4. 取消单文件（含 removeFiles）
echo "[4] 取消单文件（removeFiles）"
CANCEL_RESULT=$(curl -s -X POST "$BASE/api/files/upload/cancel" \
  -H "Content-Type: application/json" \
  -d '{"uploadId":"test001","removeFiles":true}')
check "cancel 返回 success" "$CANCEL_RESULT" '"success":true'
check "cancel 返回 cancelled:true" "$CANCEL_RESULT" '"cancelled":true'

echo ""

# 5. cancel-group 端点存在
echo "[5] cancel-group 端点"
CANCEL_GROUP_RESULT=$(curl -s -X POST "$BASE/api/files/upload/cancel-group" \
  -H "Content-Type: application/json" \
  -d '{"groupId":"grp001","removeFiles":true}')
check "cancel-group 返回 success" "$CANCEL_GROUP_RESULT" '"success":true'
check "cancel-group 返回 cancelled:true" "$CANCEL_GROUP_RESULT" '"cancelled":true'

echo ""

# 6. cancel-group 缺少 groupId 返回 400
echo "[6] cancel-group 参数校验"
CANCEL_GROUP_ERR=$(curl -s -X POST "$BASE/api/files/upload/cancel-group" \
  -H "Content-Type: application/json" \
  -d '{}')
check "缺少 groupId 返回错误" "$CANCEL_GROUP_ERR" '"error"'

echo ""

# 7. speed 字段出现在 SSE tasks 中
echo "[7] SSE tasks 包含 speed 字段"
curl -s -X POST \
  "$BASE/api/files/upload?uploadId=test004&groupId=grp003&rootLabel=SpeedTest&filename=phase1c.txt" \
  -F "files=@$TMPFILE;filename=phase1c.txt" \
  -F "targetPath=" > /dev/null
SSE_DATA2=$(curl -s -N --max-time 2 \
  -H "Accept: text/event-stream" \
  "$BASE/api/files/upload-progress" 2>/dev/null)
check "SSE tasks 条目包含 speed 字段" "$SSE_DATA2" '"speed"'

echo ""
echo "=== 结果: $PASS 通过, $FAIL 失败 ==="
echo ""

# 清理测试文件
curl -s -X DELETE "$BASE/api/files?path=phase1test.txt" > /dev/null
curl -s -X DELETE "$BASE/api/files?path=phase1a.txt" > /dev/null
curl -s -X DELETE "$BASE/api/files?path=phase1b.txt" > /dev/null
curl -s -X DELETE "$BASE/api/files?path=phase1c.txt" > /dev/null
rm -f "$TMPFILE"

if [ $FAIL -eq 0 ]; then
  exit 0
else
  exit 1
fi
