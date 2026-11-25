#!/usr/bin/env bash
# ================================================================
#  生成"可以直接发给朋友"的房间链接
# ---------------------------------------------------------------
#  为什么不手打：
#    口令一旦有一位看错（1/l、0/O、b/6），对方就会一直弹
#    「口令不正确」。这个脚本**从服务器上直接读真值**，
#    生成链接和配套话术，复制粘贴即可，绝不会看错。
#
#  用法（本地执行，需要能 SSH 上服务器）：
#    bash deploy/print-link.sh
#    bash deploy/print-link.sh root@8.222.185.143
#
#  依赖：ssh 能免密登录（之前 grant-ssh.sh 已经配好）
# ================================================================
set -euo pipefail

SERVER="${1:-${CHAT_SERVER:-root@8.222.185.143}}"
APP_DIR="${APP_DIR:-/opt/chat-room/app}"
BASE_URL="${BASE_URL:-https://8.222.185.143/chat}"
GITHUB_URL="${GITHUB_URL:-https://github.com/yayajing1/liaotian-wangye}"

# 从服务器读真实口令（去掉换行）
# 本机在服务器上就直接读文件；否则 SSH 过去读。
if [ -r "$APP_DIR/data/room.key" ]; then
  KEY=$(tr -d '\r\n' < "$APP_DIR/data/room.key")
else
  KEY=$(ssh -o ConnectTimeout=20 -o BatchMode=yes "$SERVER" \
    "cat $APP_DIR/data/room.key 2>/dev/null" | tr -d '\r\n')
fi

if [ -z "$KEY" ]; then
  echo "❌ 没读到房间口令（SSH 或路径不对？）" >&2
  echo "   试： bash deploy/print-link.sh root@8.222.185.143" >&2
  exit 1
fi

LINK="$BASE_URL#key=$KEY"

# 备用口令（如果服务端配了 ROOM_KEY_SPARE）—— 主口令那版失效时的备选链接
SPARE=""
if [ -n "${ROOM_KEY_SPARE:-}" ]; then
  SPARE="$BASE_URL#key=$ROOM_KEY_SPARE"
elif [ -r "$APP_DIR/data/room.key.spare" ]; then
  SPARE_KEY=$(tr -d '\r\n' < "$APP_DIR/data/room.key.spare")
  [ -n "$SPARE_KEY" ] && SPARE="$BASE_URL#key=$SPARE_KEY"
fi

cat <<EOF
────────────────────────────────────────────
  房间链接（直接复制这一行，别手敲）
────────────────────────────────────────────
$LINK
$( [ -n "$SPARE" ] && printf '备用链接：%s\n' "$SPARE" )

  配套话术（可直接转发）
────────────────────────────────────────────
我们的小聊天室，直接点链接就能进，不用注册也不用装 App：

$LINK

需要这个聊天室的源码的话可以看这里：
$GITHUB_URL

（聊天记录都存在服务器上，任何设备打开看到的是同一个房间、同一份历史消息。）

────────────────────────────────────────────
  口令：$KEY （${#KEY} 位）
  ⚠️ 只发给需要进房间的人，别发到群里。
────────────────────────────────────────────
EOF
