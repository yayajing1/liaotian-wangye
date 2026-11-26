#!/bin/bash
# ============================================================
#  抢窗口部署：连接一旦通，立刻在同一条 SSH 会话里做完所有事
#  （git pull → 重启 → 自检 → 数据核对），不浪费往返
# ============================================================
set -uo pipefail

TARGET="root@8.222.185.143"
REMOTE_SCRIPT='
set -uo pipefail
cd /opt/chat-room/app || exit 1
echo "===== 版本 ====="
git log --oneline -1
git pull --ff-only 2>&1 | tail -3
echo "拉到版本：$(git rev-parse --short HEAD)"
echo "本地 HEAD ：$(git rev-parse --short HEAD)"

echo "===== 重启服务 ====="
systemctl restart chat-room 2>&1 | tail -2
sleep 2
echo -n "chat-room : "; systemctl is-active chat-room
echo -n "nginx     : "; systemctl is-active nginx
echo -n "开机自启  : "; systemctl is-enabled chat-room

echo "===== 端口与页面 ====="
ss -lntp 2>/dev/null | grep -E ":8000|:443" | head -4
echo -n "回环 8000 : "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:8000/chat
echo -n "本机 HTTPS : "; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 6 https://127.0.0.1/chat
echo -n "线上 app.js 含新功能 : "; curl -s --max-time 6 http://127.0.0.1:8000/app.js | grep -c "clearHistBtn\|keyResolved"

echo "===== 数据核对（必须和部署前一致）====="
echo "头像文件数 : $(ls -1 data/avatars 2>/dev/null | wc -l)"
echo "数据库大小 : $(du -h data/chat.db 2>/dev/null | cut -f1)"
echo -n "用户数     : "; node -e "
const {DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(\"data/chat.db\",{readOnly:true});
console.log(db.prepare(\"SELECT COUNT(*) c FROM users\").get().c);
" 2>&1 | tail -1
echo -n "消息数     : "; node -e "
const {DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(\"data/chat.db\",{readOnly:true});
console.log(db.prepare(\"SELECT COUNT(*) c FROM messages WHERE kind != \x27system\x27\").get().c);
" 2>&1 | tail -1
echo -n "账号数     : "; node -e "
const {DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(\"data/chat.db\",{readOnly:true});
console.log(db.prepare(\"SELECT COUNT(*) c FROM accounts\").get().c);
" 2>&1 | tail -1
echo -n "房间口令   : "; head -c 12 data/room.key 2>/dev/null; echo

echo "===== 证书 ====="
echo | openssl s_client -connect 127.0.0.1:443 -servername 8.222.185.143 2>/dev/null \
  | openssl x509 -noout -subject -dates 2>/dev/null
echo "===== DONE ====="
'

echo "开始抢窗口（每轮最多连 12 次）..."
for round in 1 2 3 4 5 6 7 8 9 10; do
  for i in $(seq 1 12); do
    T=$(date +%H:%M:%S)
    OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=6 \
              -o ServerAliveInterval=15 -o ServerAliveCountMax=6 \
              "$TARGET" "$REMOTE_SCRIPT" 2>/dev/null)
    if echo "$OUT" | grep -q "===== DONE ====="; then
      echo "[$T] 第 $round 轮第 $i 次：连上并完成部署 ✅"
      echo "$OUT"
      exit 0
    fi
  done
  echo "[$(date +%H:%M:%S)] 第 $round 轮全部失败，继续等…"
  sleep 5
done

echo "所有轮次都没抢到窗口"
exit 1
