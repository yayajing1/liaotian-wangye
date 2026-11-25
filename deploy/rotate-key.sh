#!/usr/bin/env bash
# ================================================================
#  轮换房间口令
# ---------------------------------------------------------------
#  用途：把房间口令换成一个**不含易混淆字符**的新口令。
#
#  为什么不用随机十六进制：
#    人工从聊天记录往手机里誊口令时，1/l、0/O、b/6 这几组
#    长得几乎一样，看错一位服务端就判"口令不正确"，
#    对方只能反复弹框。这个字符集里根本没有这些字符。
#
#  用法（在服务器上执行）：
#    bash deploy/rotate-key.sh            # 默认 16 位
#    bash deploy/rotate-key.sh 20         # 指定长度
#
#  换完记得用 print-link.sh 重新生成链接发给朋友，
#  旧口令立即失效。
# ================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/chat-room/app}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
SERVICE="${SERVICE:-chat-room}"
LEN="${1:-16}"

# 与 server.js 里的 KEY_ALPHABET 保持一致（去掉 0/O/1/l/I）
ALPHABET='23456789abcdefghjkmnpqrstuvwxyz'

if ! [[ "$LEN" =~ ^[0-9]+$ ]] || [ "$LEN" -lt 8 ] || [ "$LEN" -gt 64 ]; then
  echo "长度不合法：$LEN（请给 8~64 的整数）" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

# 拒绝采样，避免取模带来的偏置
NEW_KEY=$(node -e '
const crypto = require("crypto");
const A = "23456789abcdefghjkmnpqrstuvwxyz";
const len = parseInt(process.argv[1], 10);
const max = Math.floor(256 / A.length) * A.length;
let out = "";
while (out.length < len) {
  const buf = crypto.randomBytes(len * 2);
  for (const b of buf) {
    if (b >= max) continue;
    out += A[b % A.length];
    if (out.length === len) break;
  }
}
process.stdout.write(out);
' "$LEN")

# 先备份旧口令，出问题能回滚
if [ -f "$DATA_DIR/room.key" ]; then
  cp -a "$DATA_DIR/room.key" "$DATA_DIR/room.key.bak.$(date +%Y%m%d%H%M%S)"
fi

printf '%s' "$NEW_KEY" > "$DATA_DIR/room.key"
chown chat-room:chat-room "$DATA_DIR/room.key" 2>/dev/null || true
chmod 600 "$DATA_DIR/room.key" 2>/dev/null || true

systemctl restart "$SERVICE"
sleep 1

# 自检：重启后必须还能用这把口令连上（由 print-link.sh / verify.sh 复核）
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "❌ 服务重启失败，回滚旧口令" >&2
  if ls "$DATA_DIR"/room.key.bak.* >/dev/null 2>&1; then
    cp -a "$(ls -t "$DATA_DIR"/room.key.bak.* | head -1)" "$DATA_DIR/room.key"
    systemctl restart "$SERVICE"
  fi
  exit 1
fi

echo "✅ 新房间口令已生效：$NEW_KEY"
echo "   长度：${#NEW_KEY} 位（字符集无 0/O/1/l/I，人工誊写不会看错）"
echo "   分享链接请用： bash deploy/print-link.sh"
