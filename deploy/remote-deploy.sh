#!/bin/bash
# ============================================================
#  服务器端一键部署（在 SSH 连上后执行）
#  用法：bash deploy/deploy.sh [--https]
#  也可以直接：bash /tmp/remote-deploy.sh --https
# ============================================================

set -uo pipefail

REPO="https://github.com/yayajing1/liaotian-wangye.git"
APP_DIR="/opt/chat-room"
PORT=8000
WITH_HTTPS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --https) WITH_HTTPS=1; shift ;;
    --port)  PORT="$2"; shift 2 ;;
    --dir)   APP_DIR="$2"; shift 2 ;;
    --repo)  REPO="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

echo "############################################"
echo "#  聊天室服务器端部署"
echo "############################################"
echo "仓库   : $REPO"
echo "目录   : $APP_DIR"
echo "端口   : $PORT"
echo "HTTPS  : $WITH_HTTPS"
echo

# ---------- 1. 环境自检 ----------
echo "===== 1/6 环境自检 ====="
echo -n "  系统  : "; grep -E '^PRETTY_NAME' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || echo unknown
echo -n "  架构  : "; uname -m
echo -n "  CPU   : "; nproc 2>/dev/null || echo '?'
echo -n "  内存  : "; free -m 2>/dev/null | awk '/^Mem:/{print $2"MB"}' || echo '?'
echo -n "  磁盘  : "; df -h / | awk 'NR==2{print $4" 可用 ("$5" 已用)"}'
echo -n "  当前  : "; whoami
echo -n "  Node  : "; (command -v node >/dev/null 2>&1 && node -v) || echo "未安装"
echo -n "  npm   : "; (command -v npm >/dev/null 2>&1 && npm -v) || echo "未安装"
echo -n "  git   : "; (command -v git >/dev/null 2>&1 && git --version) || echo "未安装"
echo -n "  curl  : "; (command -v curl >/dev/null 2>&1 && curl --version | head -1) || echo "未安装"
echo

# ---------- 2. 拉代码 ----------
echo "===== 2/6 拉取代码 ====="
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/app/.git" ]; then
  echo "  已有仓库，执行更新 ..."
  (cd "$APP_DIR/app" && git pull --depth 1 origin main) || echo "  更新失败，用现有代码继续"
elif [ -f "$APP_DIR/app/server.js" ]; then
  echo "  已有代码，跳过拉取"
else
  if ! command -v git >/dev/null 2>&1; then
    echo "  安装 git ..."
    (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1) \
      || (yum install -y -q git >/dev/null 2>&1) || true
  fi
  if command -v git >/dev/null 2>&1; then
    echo "  git clone $REPO ..."
    if git clone --depth 1 "$REPO" "$APP_DIR/app" 2>&1 | tail -2; then
      echo "  克隆完成 ✓"
    else
      echo "  克隆失败，尝试压缩包方式 ..."
      mkdir -p "$APP_DIR/app"
      curl -fsSL -m 120 "https://codeload.github.com/yayajing1/liaotian-wangye/tar.gz/refs/heads/main" \
        -o /tmp/app.tar.gz 2>/dev/null \
        && tar -xzf /tmp/app.tar.gz -C "$APP_DIR/app" --strip-components=1 \
        && echo "  压缩包方式完成 ✓" \
        || echo "  ⚠️ 两种方式都失败，请检查服务器能否访问 github.com"
    fi
  else
    echo "  ⚠️ 装不上 git，请手动上传代码"
  fi
fi
echo

if [ ! -f "$APP_DIR/app/server.js" ]; then
  echo "[ERROR] $APP_DIR/app/server.js 不存在，部署中止"
  exit 1
fi

# ---------- 3. 执行部署脚本 ----------
echo "===== 3/6 执行部署脚本 ====="
cd "$APP_DIR/app" || exit 1
bash deploy/deploy.sh --port "$PORT" --dir "$APP_DIR/app"
DEPLOY_RC=$?
echo "  deploy.sh 退出码: $DEPLOY_RC"
echo

# ---------- 4. 服务状态 ----------
echo "===== 4/6 服务状态 ====="
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active chat-room && echo "  chat-room 运行中 ✓" || echo "  ⚠️ chat-room 未运行"
  systemctl status chat-room --no-pager -l 2>/dev/null | tail -8
fi
echo -n "  本机 HTTP : "
curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 "http://127.0.0.1:${PORT}/chat"
echo

# ---------- 5. 房间口令 ----------
echo "===== 5/6 房间信息 ====="
KEYFILE="$APP_DIR/app/data/room.key"
if [ -f "$KEYFILE" ]; then
  KEY=$(cat "$KEYFILE" | tr -d '\r\n')
  echo "  房间口令 : $KEY"
else
  KEY=""
  echo "  ⚠️ 未找到 room.key"
fi
echo

# ---------- 6. HTTPS ----------
if [ "$WITH_HTTPS" -eq 1 ]; then
  echo "===== 6/6 配置 HTTPS ====="
  PUB_IP=$(curl -s -m 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
  [ -z "$PUB_IP" ] && PUB_IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null)
  [ -z "$PUB_IP" ] && PUB_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "  公网 IP : $PUB_IP"
  cd "$APP_DIR/app" && bash deploy/https-setup.sh --ip "$PUB_IP" --port "$PORT" --dir "$APP_DIR/app"
  echo
fi

# ---------- 收尾 ----------
echo "############################################"
echo "#  部署收尾"
echo "############################################"
PUB_IP=$(curl -s -m 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
[ -z "$PUB_IP" ] && PUB_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -f "$APP_DIR/app/data/room.key" ]; then
  KEY=$(cat "$APP_DIR/app/data/room.key" | tr -d '\r\n')
else
  KEY=""
fi

if [ -s /etc/nginx/ssl/chatroom/fullchain.pem ]; then
  echo "  发给朋友的链接："
  echo "  https://${PUB_IP}/chat#key=${KEY}"
else
  echo "  发给朋友的链接："
  echo "  http://${PUB_IP}:${PORT}/chat#key=${KEY}"
fi
echo "############################################"
