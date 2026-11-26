#!/bin/bash
# ============================================================
#  线上增量更新（服务器已能 SSH 登录时执行）
#  用法：cd /opt/chat-room/app && bash deploy/update.sh
#
#  做四件事：
#    1. 拉最新代码（git pull）
#    2. 装依赖（package.json 变了才装）
#    3. 重启 chat-room 服务
#    4. 自检：服务状态 + 端口 + HTTPS
#
#  ⚠️ 数据目录 data/ 不在 git 里，不会被覆盖；
#     昵称、头像、聊天记录、账号都在这里，pull 不会碰。
# ============================================================

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/chat-room/app}"
SERVICE="${SERVICE:-chat-room}"
PORT="${PORT:-8000}"
PUBLIC_HOST="${PUBLIC_HOST:-8.222.185.143}"

cd "$APP_DIR" || { echo "目录不存在：$APP_DIR"; exit 1; }

echo "===== 1/4 拉取最新代码 ====="
BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
git pull --ff-only 2>&1 | tail -5
AFTER=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "  版本：$BEFORE → $AFTER"

echo
echo "===== 2/4 依赖 ====="
if [ -f package.json ]; then
  npm install --omit=dev 2>&1 | tail -3
else
  echo "  无 package.json，跳过"
fi

echo
echo "===== 3/4 重启服务 ====="
systemctl restart "$SERVICE" 2>&1 | tail -3
sleep 2
systemctl is-enabled "$SERVICE" >/dev/null 2>&1 && echo "  开机自启：已启用" || echo "  开机自启：未启用"
if systemctl is-active --quiet "$SERVICE"; then
  echo "  服务状态：active ✅"
else
  echo "  服务状态：❌ 没起来，看日志：journalctl -u $SERVICE -n 40 --no-pager"
  exit 1
fi

echo
echo "===== 4/4 自检 ====="
if ss -lntp 2>/dev/null | grep -q ":$PORT"; then
  echo "  端口 $PORT：正在监听 ✅"
else
  echo "  端口 $PORT：❌ 没监听"
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:$PORT/chat")
echo "  本机回环 http://127.0.0.1:$PORT/chat → $CODE"

CODE2=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "https://$PUBLIC_HOST/chat")
echo "  公网 https://$PUBLIC_HOST/chat → $CODE2"

echo
echo "===== 保留数据核对 ====="
echo "  头像目录：$(ls -1 data/avatars 2>/dev/null | wc -l) 个文件"
if [ -f data/chat.db ]; then
  echo "  数据库大小：$(du -h data/chat.db | cut -f1)"
fi

echo
echo "完成。新链接：https://$PUBLIC_HOST/chat#key=$(cat data/room.key 2>/dev/null | head -c 12)"
