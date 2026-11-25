#!/usr/bin/env bash
# ==================================================================
#  聊天室 —— HTTPS 装配脚本（无需域名版）
#
#  做法：
#     Nginx 接管 80/443 → 反代到本机 Node(127.0.0.1:8000)
#     用 Let's Encrypt 给【公网 IP】签证书（shortlived 短周期）
#     → 浏览器地址栏出现小锁，且 wss:// 正常工作
#
#  为什么能不给域名签证书：
#     Let's Encrypt 自 2026-01-15 起开放 IP 地址证书，
#     但只能用 shortlived 配置（有效期 160 小时 ≈ 6.6 天），
#     所以必须配自动续期（下面用 cron + systemd timer 双保险）。
#
#  用法：
#     bash deploy/https-setup.sh                # 自动探测 IP
#     bash deploy/https-setup.sh --ip 1.2.3.4   # 指定 IP
#     bash deploy/https-setup.sh --port 8000   # Node 端口（默认 8000）
# ==================================================================
set -euo pipefail

APP_DIR="/opt/chat-room"
NODE_PORT="8000"
PUB_IP=""
SKIP_CERT=0
APP_DIR_EXPLICIT=0
DOMAIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)   PUB_IP="$2"; shift 2 ;;
    --port) NODE_PORT="$2"; shift 2 ;;
    --dir)  APP_DIR="$2"; APP_DIR_EXPLICIT=1; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --skip-cert) SKIP_CERT=1; shift ;;
    -h|--help)
      echo "用法: bash https-setup.sh [--ip 公网IP] [--port Node端口] [--dir 安装目录] [--domain 自定义域名] [--skip-cert 只配Nginx不签证书]"
      echo ""
      echo "  --domain 你的域名.com   签域名证书（90天有效期，标准 Let's Encrypt）"
      echo "  不带 --domain          签 IP 证书（6天有效期，shortlived 配置）"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

SSL_DIR="/etc/nginx/ssl/chatroom"
WEBROOT="/var/www/letsencrypt"

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_C="\033[36m"; C_0="\033[0m"
say() { printf "%b\n" "$1"; }

# 自动识别安装目录 —— 跟 deploy.sh 保持一致：
# 脚本所在目录就有 server.js 时就地操作，避免代码和 data/ 错位
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$APP_DIR_EXPLICIT" -eq 0 ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
  say "      代码目录：${APP_DIR}"
fi

say ""
say "${C_C}  ============================================${C_0}"
say "${C_C}    Chat Room  -  HTTPS 装配${C_0}"
say "${C_C}  ============================================${C_0}"
say ""

# ---------- 提权 ----------
SUDO=""
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
  say "[提示] 以 sudo 提权执行"
fi

run() { $SUDO "$@"; }

# ---------- 0. 前置检查 ----------
say "[0/6] 前置检查 ..."

if [ ! -f "$APP_DIR/server.js" ]; then
  say "${C_R}[ERROR] $APP_DIR 下没有 server.js，请先跑 deploy.sh${C_0}"
  exit 1
fi

if ! systemctl is-active --quiet chat-room; then
  say "${C_Y}      chat-room 服务未运行，尝试启动 ...${C_0}"
  systemctl restart chat-room 2>/dev/null || true
  sleep 2
  if ! systemctl is-active --quiet chat-room; then
    say "${C_R}[ERROR] chat-room 起不来，先解决它：journalctl -u chat-room -n 50${C_0}"
    exit 1
  fi
fi
say "      Node 服务运行中 ✓"

# ---------- 1. 装 Nginx + acme.sh ----------
say ""
say "[1/6] 安装 Nginx 与 acme.sh ..."

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update -qq && apt-get install -y -qq nginx cron) >/dev/null 2>&1 || true
  else
    (yum install -y -q nginx cronie) >/dev/null 2>&1 || true
  fi
fi

if ! command -v nginx >/dev/null 2>&1; then
  say "${C_R}[ERROR] Nginx 装不上${C_0}"
  exit 1
fi

# cron：acme.sh 靠它自动续期。精简镜像常常没装。
if ! command -v crontab >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update -qq && apt-get install -y -qq cron) >/dev/null 2>&1 || true
  else
    (yum install -y -q cronie) >/dev/null 2>&1 || true
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable cron >/dev/null 2>&1 || true
  systemctl start cron >/dev/null 2>&1 || true
fi

# acme.sh —— 纯 shell，不依赖 Python
if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
  say "      下载 acme.sh ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.acme.sh -o /tmp/acme-install.sh 2>/dev/null \
      || curl -fsSL https://gitee.com/neilpang/acme.sh/raw/master/install.sh -o /tmp/acme-install.sh 2>/dev/null \
      || true
  fi
  if [ -s /tmp/acme-install.sh ]; then
    sh /tmp/acme-install.sh --home "$HOME/.acme.sh" >/dev/null 2>&1 || true
    rm -f /tmp/acme-install.sh
  fi
fi

if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
  say "${C_Y}      ⚠️ acme.sh 没装上，将只配置 Nginx（不签证书）${C_0}"
  SKIP_CERT=1
else
  say "      acme.sh 就绪 ✓"
fi

# ---------- 2. 探测公网 IP ----------
say ""
say "[2/6] 探测公网 IP ..."

if [ -z "$PUB_IP" ]; then
  # 阿里云元数据最可靠
  for META_PATH in public-ipv4 eipv4; do
    if [ -z "$PUB_IP" ]; then
      PUB_IP=$(curl -s -m 3 "http://100.100.100.200/latest/meta-data/${META_PATH}" 2>/dev/null || true)
    fi
  done
  [ -z "$PUB_IP" ] && PUB_IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)
  [ -z "$PUB_IP" ] && PUB_IP=$(curl -s -m 5 http://ifconfig.me/ip 2>/dev/null || true)
  if [ -z "$PUB_IP" ]; then
    PUB_IP=$(ip -4 addr show scope global 2>/dev/null \
      | grep -oE 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
      | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || true)
  fi
fi

if [ -z "$PUB_IP" ]; then
  say "${C_R}[ERROR] 拿不到公网 IP，请手动指定：--ip 1.2.3.4${C_0}"
  exit 1
fi
say "      公网 IP：${PUB_IP}"

# 校验格式 —— 证书签发只接受合法 IP
if ! echo "$PUB_IP" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
  say "${C_R}[ERROR] IP 格式不合法：${PUB_IP}${C_0}"
  exit 1
fi

# ---------- 2.5 域名解析校验 ----------
# 有域名时，必须确认 DNS 已解析到本机 IP，否则 ACME http-01 验证会失败
SERVER_NAME="_"
if [ -n "$DOMAIN" ]; then
  say ""
  say "[2.5/6] 校验域名解析 ..."

  # 去掉可能的协议前缀和路径
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%%/*}"
  DOMAIN="${DOMAIN%%:*}"   # 去掉端口

  if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
    say "${C_R}[ERROR] 域名格式不合法：${DOMAIN}${C_0}"
    say "       应该是 chat.example.com 这种形式"
    exit 1
  fi

  # 查 DNS 解析到的 IP
  RESOLVED=""
  if command -v getent >/dev/null 2>&1; then
    RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
  fi
  if [ -z "$RESOLVED" ] && command -v dig >/dev/null 2>&1; then
    RESOLVED=$(dig +short "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)
  fi
  if [ -z "$RESOLVED" ] && command -v host >/dev/null 2>&1; then
    RESOLVED=$(host -t A "$DOMAIN" 2>/dev/null | awk '/has address/{print $NF; exit}' || true)
  fi
  if [ -z "$RESOLVED" ] && command -v nslookup >/dev/null 2>&1; then
    RESOLVED=$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address: /{print $2; exit}' || true)
  fi

  if [ -z "$RESOLVED" ]; then
    say "${C_Y}      ⚠️ 查不到 ${DOMAIN} 的解析结果${C_0}"
    say "      可能是 DNS 还没生效，或服务器没装 dig/host/nslookup。"
    say "      先在阿里云 DNS 控制台加 A 记录：${DOMAIN} → ${PUB_IP}"
    say "      解析生效后重跑本脚本。"
  elif [ "$RESOLVED" != "$PUB_IP" ]; then
    say "${C_Y}      ⚠️ ${DOMAIN} 当前解析到 ${RESOLVED}，但本机 IP 是 ${PUB_IP}${C_0}"
    say "      ACME 验证会失败。请把 DNS 的 A 记录改成 ${PUB_IP}。"
    say "      DNS 生效通常 10 分钟内，最长 24 小时。"
  else
    say "      ${DOMAIN} → ${RESOLVED} ✓"
  fi

  # server_name 同时接受域名和 IP 直连，两者都能用
  SERVER_NAME="${DOMAIN} ${PUB_IP} _"
fi

# ---------- 3. 先起 Nginx（80 端口，供 ACME 验证 + 临时直连） ----------
say ""
say "[3/6] 配置 Nginx ..."

run mkdir -p "$WEBROOT" "$SSL_DIR"
run chmod 755 "$WEBROOT"

# 第一次：80 端口既提供 ACME 验证目录，也反代到 Node。
# 此时还没证书，所以不跳转 HTTPS，先让 http://IP 能用。
cat > /etc/nginx/sites-available/chat-room <<EOF
# HTTP：ACME 验证目录 + 反代
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};

    # Let's Encrypt http-01 验证路径（续期时也要用，不能删）
    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location /ws {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

run rm -f /etc/nginx/sites-enabled/default
run ln -sf /etc/nginx/sites-available/chat-room /etc/nginx/sites-enabled/chat-room

if ! run nginx -t >/dev/null 2>&1; then
  say "${C_R}[ERROR] Nginx 配置有误：${C_0}"
  run nginx -t || true
  exit 1
fi

run systemctl enable nginx >/dev/null 2>&1 || true
run systemctl restart nginx
sleep 1

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${NODE_PORT}/chat" || echo "000")
if [ "$CODE" = "200" ]; then
  say "      Nginx 反代正常 ✓"
else
  say "${C_Y}      ⚠️ 反代自检返回 ${CODE}（Node 直连返回的是 ${CODE}）${C_0}"
fi

# ---------- 4. 签证书 ----------
# 分两种：
#   有域名 → 标准 Let's Encrypt 证书（90天，--days 60 自动续期）
#   无域名 → IP 证书（shortlived，160小时，必须 --days 3 频繁续）
if [ "$SKIP_CERT" -eq 1 ]; then
  say ""
  say "${C_Y}[跳过] 未签发证书，只配置了 Nginx${C_0}"
else
  say ""
  if [ -n "$DOMAIN" ]; then
    say "[4/6] 签发 Let's Encrypt 域名证书（${DOMAIN}）..."
  else
    say "[4/6] 签发 Let's Encrypt IP 证书 ..."
  fi

  ACME="$HOME/.acme.sh/acme.sh"

  # 签发目标：域名用 -d 域名，IP 用 -d IP + shortlived
  ISSUE_OK=0
  if [ -n "$DOMAIN" ]; then
    # 域名证书：标准配置，有效期 90 天
    # --days 60 = 到期前 60 天开始尝试续期，留足重试余量
    CERT_DOMAIN="$DOMAIN"
    ISSUE_FLAGS="--days 60"
    # 顺手把 www 也签上（如果 DNS 里有 www 解析）
    if [ "${DOMAIN#www.}" != "$DOMAIN" ]; then
      CERT_DOMAIN="${DOMAIN#www.}"
      ISSUE_FLAGS="$ISSUE_FLAGS -d www.$CERT_DOMAIN"
    fi
    if "$ACME" --issue --server letsencrypt \
         -d "$CERT_DOMAIN" $ISSUE_FLAGS \
         -w "$WEBROOT" \
         --keylength ec-256 >/tmp/acme-issue.log 2>&1; then
      ISSUE_OK=1
    fi
  else
    CERT_DOMAIN="$PUB_IP"
    # IP 证书必须用 shortlived 配置（160 小时）
    # --days 3 = 每 3 天检查续期，留出失败重试的余量
    ISSUE_FLAGS="--certificate-profile shortlived --days 3"
    if "$ACME" --issue --server letsencrypt \
         -d "$PUB_IP" \
         -w "$WEBROOT" \
         --certificate-profile shortlived \
         --days 3 \
         --keylength ec-256 >/tmp/acme-issue.log 2>&1; then
      ISSUE_OK=1
    else
      say "${C_Y}      首次签发失败，用测试环境重试排查 ...${C_0}"
      if "$ACME" --issue --server letsencrypt_test \
           -d "$PUB_IP" -w "$WEBROOT" \
           --certificate-profile shortlived --days 3 --keylength ec-256 \
           >/tmp/acme-issue.log 2>&1; then
        say "${C_Y}      测试环境能签 → 说明是正式环境的频率限制，等 1 小时再试${C_0}"
      fi
    fi
  fi

  if [ "$ISSUE_OK" -eq 0 ]; then
    tail -20 /tmp/acme-issue.log | sed 's/^/      /'
    say ""
    say "${C_Y}      ⚠️ 证书未签发。常见原因：${C_0}"
    say "        1. 云控制台没放行 TCP 80（ACME 验证必须能访问 80）"
    say "        2. 服务器本地防火墙拦了 80"
    if [ -n "$DOMAIN" ]; then
      say "        3. 域名没解析到本机 IP（检查 A 记录是否指向 ${PUB_IP}）"
      say "        4. 域名还没生效（DNS 通常 10 分钟内生效，最长 24 小时）"
    else
      say "        3. 正式 CA 频率限制（同一组 IP 每 168 小时最多 5 张）"
    fi
    say "      Nginx 已配好，http://${PUB_IP}/chat 现在就能用。"
    say "      修好后重跑本脚本即可。"
  fi

  if [ "$ISSUE_OK" -eq 1 ]; then
    say "      证书签发成功 ✓"

    # 安装到 Nginx 目录，并绑定「续期后自动重载」
    "$ACME" --install-cert -d "$CERT_DOMAIN" --ecc \
      --key-file "$SSL_DIR/privkey.pem" \
      --fullchain-file "$SSL_DIR/fullchain.pem" \
      --reloadcmd "systemctl reload nginx" >/dev/null 2>&1 || true

    if [ -s "$SSL_DIR/privkey.pem" ]; then
      run chmod 600 "$SSL_DIR/privkey.pem"
      say "      证书已安装到 ${SSL_DIR} ✓"
    else
      say "${C_Y}      ⚠️ 证书安装异常，请检查 ${SSL_DIR}${C_0}"
    fi
  fi
fi

# ---------- 5. 开启 443 ----------
say ""
say "[5/6] 配置 443 HTTPS ..."

if [ -s "$SSL_DIR/fullchain.pem" ] && [ -s "$SSL_DIR/privkey.pem" ]; then
  cat > /etc/nginx/sites-available/chat-room <<EOF
# HTTP：只留 ACME 验证目录，其余跳 HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS：IP 证书 + 反代到 Node
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name ${SERVER_NAME};

    ssl_certificate     ${SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${SSL_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # WebSocket 升级（关键：少了这段聊天发不出去）
    location /ws {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
else
  cat > /etc/nginx/sites-available/chat-room <<EOF
# 尚未拿到证书 —— 先只提供 HTTP
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location /ws {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
EOF
fi

if ! run nginx -t >/dev/null 2>&1; then
  say "${C_R}[ERROR] Nginx 配置有误${C_0}"
  run nginx -t || true
  exit 1
fi
run systemctl reload nginx
say "      Nginx 已生效 ✓"

# ---------- 6. 自动续期 + 收尾 ----------
say ""
say "[6/6] 配置自动续期与收尾 ..."

# 保险 1：acme.sh 自带的 cron（已带 --days 3 参数）
if command -v crontab >/dev/null 2>&1; then
  CRON_LINE="0 3 * * * \"$HOME/.acme.sh/acme.sh\" --cron --home \"$HOME/.acme.sh\" > /dev/null 2>&1"
  ( crontab -l 2>/dev/null | grep -v "acme.sh.*--cron" || true; echo "$CRON_LINE" ) | crontab -
  say "      cron 续期任务已注册 ✓"
else
  say "${C_Y}      ⚠️ 没有 crontab，靠下面的 systemd timer 兜底${C_0}"
fi

# 保险 2：systemd timer —— cron 挂了也能续
cat > /etc/systemd/system/acme-renew.service <<EOF
[Unit]
Description=Renew Let's Encrypt IP certificate (acme.sh)
After=network.target

[Service]
Type=oneshot
ExecStart=$HOME/.acme.sh/acme.sh --cron --home $HOME/.acme.sh
EOF

cat > /etc/systemd/system/acme-renew.timer <<EOF
[Unit]
Description=Daily certificate renewal check

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=3600

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable acme-renew.timer >/dev/null 2>&1 || true
systemctl start acme-renew.timer >/dev/null 2>&1 || true
say "      systemd timer 兜底已启用 ✓"

# Node 收回到本机监听 —— 8000 不再暴露公网
if systemctl cat chat-room 2>/dev/null | grep -q "Environment=HOST=0.0.0.0"; then
  sed -i 's/^Environment=HOST=0.0.0.0$/Environment=HOST=127.0.0.1/' /etc/systemd/system/chat-room.service
  systemctl daemon-reload
  systemctl restart chat-room
  sleep 2
  say "      Node 已改为仅本机监听（8000 不再对公网开放）✓"
fi

# 读口令
KEY=""
if [ -f "$APP_DIR/data/room.key" ]; then
  KEY=$(tr -d '\r\n' < "$APP_DIR/data/room.key")
fi

say ""
say "${C_G}  ============================================${C_0}"
say "${C_G}    HTTPS 装配完成${C_0}"
say "${C_G}  ============================================${C_0}"
say ""

# 访问地址：有域名优先用域名，没有就用 IP
if [ -n "$DOMAIN" ]; then
  ACCESS_HOST="$DOMAIN"
  CERT_LABEL="域名证书（90 天，自动续期）"
else
  ACCESS_HOST="$PUB_IP"
  CERT_LABEL="IP 证书（160 小时，自动续期）"
fi

CERT_DAYS="未知"
if [ -s "$SSL_DIR/fullchain.pem" ]; then
  CERT_DAYS=$("$HOME/.acme.sh/acme.sh" --info -d "$ACCESS_HOST" 2>/dev/null \
    | grep -oE 'Le_NextRenewTime=.*' | head -1 | cut -d'=' -f2 || echo "未知")
  [ -z "$CERT_DAYS" ] && CERT_DAYS="已安装"
fi

if [ -s "$SSL_DIR/fullchain.pem" ]; then
  say "  ${C_C}HTTPS 地址${C_0}  : ${C_G}https://${ACCESS_HOST}/chat${C_0}"
  if [ -n "$DOMAIN" ]; then
    say "  ${C_C}IP 直连${C_0}    : ${C_G}https://${PUB_IP}/chat${C_0}  （备用）"
  fi
  say "  ${C_C}证书类型${C_0}  : ${CERT_LABEL}"
  say "  ${C_C}续期时间${C_0}  : ${CERT_DAYS}"
else
  say "  ${C_C}HTTP 地址${C_0}   : ${C_G}http://${PUB_IP}/chat${C_0}"
  say "  ${C_Y}  证书未签发 —— 修好端口放行后重跑本脚本${C_0}"
fi
say ""
if [ -n "$KEY" ]; then
  say "  ${C_Y}房间口令${C_0}  : ${KEY}"
  say ""
  say "  ${C_G}发给朋友的链接${C_0} :"
  if [ -s "$SSL_DIR/fullchain.pem" ]; then
    say "  ${C_G}https://${ACCESS_HOST}/chat#key=${KEY}${C_0}"
  else
    say "  ${C_G}http://${PUB_IP}/chat#key=${KEY}${C_0}"
  fi
fi
say ""
say "${C_Y}接下来必做${C_0}："
say "  1. 云控制台放行 TCP 80 和 443（轻量=防火墙，ECS=安全组入方向）"
say "     80  是签证书要用；443 是 HTTPS 入口"
if [ -n "$DOMAIN" ]; then
  say "  2. 确认 DNS 的 A 记录 ${DOMAIN} → ${PUB_IP} 已生效"
  say "  3. 浏览器打开上面的地址，确认地址栏出现${C_C}小锁${C_0}"
  say "  4. 把带口令的链接发给朋友"
else
  say "  2. 浏览器打开上面的地址，确认地址栏出现${C_C}小锁${C_0}"
  say "  3. 把带口令的链接发给朋友"
fi
say ""
say "${C_G}常用命令${C_0}："
say "  nginx -t                        检查配置"
say "  systemctl reload nginx           重载配置"
say "  systemctl status acme-renew.timer 看续期定时器"
say "  acme.sh --renew -d ${ACCESS_HOST}  手动续期"
say ""
say "${C_C}体检命令${C_0}（检查 HTTPS 和 8000 状态）："
say "  bash deploy/verify.sh"
say ""
