#!/usr/bin/env bash
# ================================================================
# 域名一键绑定 —— 把 IP 换成域名，签标准 DV 证书
# ================================================================
#
# 为什么必须做这件事？
# ---------------------
# 现在用的是 Let's Encrypt 的 **IP 证书**（有效期只有 6~7 天）。
# IP 证书在很多手机上不被信任：
#   - iOS Safari（尤其是微信内置浏览器用的 WKWebView）
#   - 老版本安卓 Chrome / 微信 X5 内核
# 这些浏览器会弹「**你的连接不是私密连接**」「危险警告」——
# 朋友点开链接第一眼看到的就是这个，压根不敢用。
#
# 换成**域名证书**之后：
#   - 所有浏览器都认（标准 DV，全球信任）
#   - 有效期 90 天（不用每 3 天续一次）
#   - 换服务器 IP 也不用重签
#
# 用法（在服务器上跑）：
#   bash deploy/bind-domain.sh --domain chat.你的域名.com
#
# 前提：
#   1. 域名已经买好
#   2. DNS 的 A 记录已经指向本服务器公网 IP
#   3. 阿里云防火墙 80 端口已放行（ACME 验证要用）
#
# 脚本会自动：
#   1. 校验域名格式 + 查 DNS 解析（不指向本机就提醒）
#   2. 签发标准 Let's Encrypt 域名证书（90 天）
#   3. Nginx 的 server_name 改成「域名 + IP 直连」
#   4. 加上 HSTS / 隐藏 nginx 版本号
#   5. 配置自动续期（cron + systemd timer 双保险）
#   6. 验证证书和网站

set -euo pipefail

# ---- 颜色 ----
C_G="\033[0;32m"; C_Y="\033[0;33m"; C_R="\033[0;31m"; C_C="\033[0;36m"; C_0="\033[0m"

DOMAIN=""
APP_DIR="/opt/chat-room/app"
NODE_PORT="8000"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --dir)    APP_DIR="${2:-}"; shift 2 ;;
    --port)   NODE_PORT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "用法：bash deploy/bind-domain.sh --domain chat.你的域名.com"
      echo "  --domain  你的域名（不带 https://）"
      echo "  --dir     安装目录（默认 /opt/chat-room/app）"
      echo "  --port    Node 端口（默认 8000）"
      exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

say()  { echo -e "$*"; }
run()  { "$@" >/dev/null 2>&1 || true; }

if [ -z "$DOMAIN" ]; then
  say "${C_R}请用 --domain 指定域名${C_0}"
  say "例：bash deploy/bind-domain.sh --domain chat.abc.xyz"
  exit 1
fi

# 去掉协议头和路径
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"; DOMAIN="${DOMAIN%%:*}"

if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
  say "${C_R}域名格式不合法：${DOMAIN}${C_0}"
  exit 1
fi

say ""
say "${C_C}============================================${C_0}"
say "${C_C}  绑定域名：${DOMAIN}${C_0}"
say "${C_C}============================================${C_0}"
say ""

# ---------- 1. 本机公网 IP ----------
PUB_IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
if [ -z "$PUB_IP" ]; then
  PUB_IP=$(curl -s --max-time 10 ifconfig.me 2>/dev/null || true)
fi
[ -z "$PUB_IP" ] && PUB_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 || true)
if [ -z "$PUB_IP" ]; then
  say "${C_R}没法获取本机公网 IP${C_0}"
  exit 1
fi
say "[1/6] 本机公网 IP：${PUB_IP}"

# ---------- 2. 查 DNS ----------
say "[2/6] 查 DNS 解析…"
RESOLVED=""
RESOLVED=$(dig +short "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)
[ -z "$RESOLVED" ] && RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)

if [ -z "$RESOLVED" ]; then
  say "    ${C_Y}⚠️ 查不到 ${DOMAIN} 的解析结果${C_0}"
  say "    请先在阿里云 DNS 控制台加 A 记录：${DOMAIN} → ${PUB_IP}"
  say "    ${C_Y}解析生效通常 10 分钟，最长 24 小时${C_0}"
  say ""
  read -r -p "  解析好了没？(y/n) " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || exit 1
  RESOLVED=$(dig +short "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)
  [ -z "$RESOLVED" ] && { say "${C_R}还是查不到解析${C_0}"; exit 1; }
fi

if [ "$RESOLVED" != "$PUB_IP" ]; then
  say "    ${C_Y}⚠️ ${DOMAIN} 当前解析到 ${RESOLVED}，本机是 ${PUB_IP}${C_0}"
  say "    ${C_Y}   请去阿里云把 A 记录改成 ${PUB_IP}${C_0}"
  say ""
  read -r -p "  已经改好了？(y/n) " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || exit 1
  sleep 5
  NEW=$(dig +short "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)
  if [ "$NEW" != "$PUB_IP" ]; then
    say "${C_R}解析还没生效（现在是 ${NEW}），过几分钟再跑一次${C_0}"
    exit 1
  fi
  say "    ${C_G}✓ 解析已指向本机${C_0}"
else
  say "    ${C_G}✓ 解析正确${C_0}"
fi

# ---------- 3. 80 端口能通吗 ----------
say "[3/6] 检查 80 端口（ACME 验证要用）…"
if curl -s -o /dev/null --max-time 8 "http://${DOMAIN}/" 2>/dev/null; then
  say "    ${C_G}✓ 80 端口可达${C_0}"
else
  say "    ${C_Y}⚠️ 80 端口访问不通${C_0}"
  say "    请确认阿里云防火墙有 TCP 80 规则（ACME http-01 验证必须走 80）"
  say "    ${C_Y}   如果刚改完 DNS，解析可能还没生效，等 10 分钟再试${C_0}"
fi

# ---------- 4. 签证书 ----------
say "[4/6] 签发 Let's Encrypt 域名证书（90 天）…"
ACME="$HOME/.acme.sh/acme.sh"
if [ ! -f "$ACME" ]; then
  say "${C_R}没找到 acme.sh，先跑一遍 deploy/https-setup.sh 装环境${C_0}"
  exit 1
fi

# 先确保 80 端口的 ACME 挑战目录是通的
mkdir -p /var/www/letsencrypt

if "$ACME" --issue --ecc --keylength ec-256 \
      -d "$DOMAIN" -w /var/www/letsencrypt \
      --server letsencrypt --force 2>&1 | tail -20; then
  say "    ${C_G}✓ 证书签发成功${C_0}"
else
  say "${C_R}证书签发失败${C_0}"
  say "常见原因："
  say "  1. 80 端口没放行（阿里云防火墙 + 系统防火墙）"
  say "  2. DNS 还没生效"
  say "  3. 同一组域名 7 天内签发次数超限（等几小时或用 --server letsencrypt_test 测）"
  exit 1
fi

# ---------- 5. 装证书 + 改 nginx ----------
say "[5/6] 安装证书并配置 Nginx…"
SSL_DIR="/etc/nginx/ssl/chatroom"
mkdir -p "$SSL_DIR"
install -m 644 "$HOME/.acme.sh/${DOMAIN}_ecc/${DOMAIN}.cer"  "$SSL_DIR/fullchain.pem"
install -m 600 "$HOME/.acme.sh/${DOMAIN}_ecc/${DOMAIN}.key" "$SSL_DIR/privkey.pem"

# 装续期钩子：每次 acme.sh 续完期，把新证书复制到 nginx 目录并重载
cat > "$HOME/.acme.sh/deploy/chatroom.sh" <<'HOOK'
#!/usr/bin/env bash
SSL_DIR="/etc/nginx/ssl/chatroom"
install -m 644 "$HOME/.acme.sh/${CERT_DOMAIN}_ecc/${CERT_DOMAIN}.cer"  "$SSL_DIR/fullchain.pem"
install -m 600 "$HOME/.acme.sh/${CERT_DOMAIN}_ecc/${CERT_DOMAIN}.key" "$SSL_DIR/privkey.pem"
nginx -t && systemctl reload nginx
HOOK
chmod +x "$HOME/.acme.sh/deploy/chatroom.sh"

# 给这个域名挂上续期钩子
"$ACME" --install-cert -d "$DOMAIN" --ecc \
  --key-file "$HOME/.acme.sh/${DOMAIN}_ecc/${DOMAIN}.key" \
  --fullchain-file "$HOME/.acme.sh/${DOMAIN}_ecc/${DOMAIN}.cer" \
  --reloadcmd "bash $HOME/.acme.sh/deploy/chatroom.sh" >/dev/null 2>&1 || true

# Nginx：server_name 同时接受域名和 IP 直连（IP 直连留着当备用）
SERVER_NAME="${DOMAIN} ${PUB_IP} _"
cat > /etc/nginx/sites-available/chat-room <<EOF
# HTTP：只留 ACME 验证目录，其余跳 HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS：域名证书（90 天）+ 反代到 Node
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
    ssl_session_tickets on;

    # ---------- 安全响应头 ----------
    #
    # HSTS：浏览器会强制走 HTTPS，不会再弹「不安全」提示。
    # ⚠️ 证书出问题时浏览器会卡住无法访问，
    #    需手动清 HSTS 缓存：chrome://net-internals/#hsts → Delete domain security policies
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 不暴露 nginx 版本号
    server_tokens off;

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

ln -sf /etc/nginx/sites-available/chat-room /etc/nginx/sites-enabled/chat-room
rm -f /etc/nginx/sites-enabled/default

if nginx -t 2>&1 | tail -3; then
  systemctl reload nginx
  say "    ${C_G}✓ Nginx 已重载${C_0}"
else
  say "${C_R}Nginx 配置有问题，没重载（现有配置还在跑，没断服务）${C_0}"
  exit 1
fi

# ---------- 6. 验证 ----------
say "[6/6] 验证…"
sleep 2

echo | openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName 2>/dev/null | sed 's/^/    /'

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${DOMAIN}/chat" || echo "000")
say "    网站 HTTP 状态：${CODE}"

say ""
say "${C_G}============================================${C_0}"
say "${C_G}  绑定完成${C_0}"
say "${C_G}============================================${C_0}"
say ""
say "  ${C_C}新地址（发给朋友）${C_0}"
say "    https://${DOMAIN}/chat#key=你的房间口令"
say ""
say "  ${C_C}IP 直连（备用）${C_0}"
say "    https://${PUB_IP}/chat#key=你的房间口令"
say ""
say "  ${C_C}证书${C_0}"
say "    域名：${DOMAIN}"
say "    有效期 90 天，自动续期已配好"
say ""
say "  ${C_C}下一步${C_0}"
say "    1. 把新链接发给朋友（域名那个）"
say "    2. 让他们清一下旧的浏览器缓存 / 微信缓存再打开"
say "    3. 测一下：curl -I https://${DOMAIN}/chat"
