#!/usr/bin/env bash
# ==================================================================
#  聊天室 —— 部署状态体检脚本
#
#  一键检查：
#    · HTTPS 是否正常工作（证书有效、443 通、wss 通）
#    · 8000 是否已收回本机（不再对公网暴露）
#    · 端口监听、防火墙续期、口令门禁
#
#  用法（在服务器上）：
#     bash deploy/verify.sh
#     bash deploy/verify.sh --ip 1.2.3.4     # 顺带从公网侧测
#
#  退出码：0 = 全绿；1 = 有问题
# ==================================================================
set -uo pipefail

APP_DIR="/opt/chat-room"
NODE_PORT="8000"
PUB_IP=""
APP_DIR_EXPLICIT=0
DOMAIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)   PUB_IP="$2"; shift 2 ;;
    --port) NODE_PORT="$2"; shift 2 ;;
    --dir)  APP_DIR="$2"; APP_DIR_EXPLICIT=1; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    -h|--help)
      echo "用法: bash verify.sh [--ip 公网IP] [--port Node端口] [--dir 安装目录] [--domain 自定义域名]"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

SSL_DIR="/etc/nginx/ssl/chatroom"

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_C="\033[36m"; C_D="\033[90m"; C_0="\033[0m"
say()  { printf "%b\n" "$1"; }
ok()   { say "  ${C_G}✓${C_0} $1"; }
warn() { say "  ${C_Y}!${C_0} $1"; }
bad()  { say "  ${C_R}✗${C_0} $1"; }
info() { say "  ${C_D}·${C_0} $1"; }

FAIL=0

# 自动识别代码目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$APP_DIR_EXPLICIT" -eq 0 ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
fi

say ""
say "${C_C}============================================${C_0}"
say "${C_C}  聊天室部署体检${C_0}"
say "${C_C}============================================${C_0}"
say ""

# ---------------------------------------------------------------
say "${C_C}[1] 服务进程${C_0}"
# ---------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet chat-room; then
  ok "chat-room 服务运行中"
else
  bad "chat-room 服务没在跑 —— systemctl status chat-room"
  FAIL=1
fi

# ---------------------------------------------------------------
say ""
say "${C_C}[2] Node 监听地址${C_0}  ${C_D}—— 8000 应该只在 127.0.0.1${C_0}"
# ---------------------------------------------------------------
# 端口监听：ss 优先，没有就退回 netstat（精简镜像可能只装了后者）
# 拿监听端口列表。ss 优先，没有则试 netstat。
# 注意：Windows 的 netstat 不认 -l/-n 组合，会直接打印用法并退出，
# 所以这里先用 -an 探测，失败再退回 -tln。
list_ports() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null && return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -i "LISTEN" && return 0
    netstat -tln 2>/dev/null
  fi
  return 0
}

LISTEN=$(list_ports | grep -E "[:.]${NODE_PORT}[[:space:]]" || true)

if [ -z "$LISTEN" ]; then
  if command -v ss >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; then
    # 有工具但没匹配到 —— 说明端口确实没在监听
    warn "没看到 ${NODE_PORT} 在监听"
    info "如果服务已配了 Nginx 反代，Node 只跑在本机 —— 属正常"
  else
    warn "没有 ss / netstat 命令，跳过（装 iproute2 或 net-tools 后再看）"
  fi
elif echo "$LISTEN" | grep -qE "127\.0\.0\.1[:.]${NODE_PORT}|\[::1\][:.]${NODE_PORT}"; then
  ok "${NODE_PORT} 只监听 127.0.0.1 —— 已收回本机，公网打不通 ✓"
elif echo "$LISTEN" | grep -qE "0\.0\.0\.0[:.]${NODE_PORT}|\*:${NODE_PORT}|\[::\][:.]${NODE_PORT}"; then
  bad "${NODE_PORT} 还在监听所有网卡（公网可直连）—— 防火墙的 8000 规则请删掉"
  FAIL=1
else
  info "${NODE_PORT} 监听：$(echo "$LISTEN" | head -1 | awk '{print $4}')"
fi

# systemd 里的 HOST 设置
if command -v systemctl >/dev/null 2>&1 && systemctl cat chat-room 2>/dev/null | grep -q "Environment=HOST=127.0.0.1"; then
  ok "systemd 配置 HOST=127.0.0.1 ✓"
elif command -v systemctl >/dev/null 2>&1 && systemctl cat chat-room 2>/dev/null | grep -q "Environment=HOST=0.0.0.0"; then
  warn "systemd 里 HOST=0.0.0.0 —— 跑 https-setup.sh 会自动改成 127.0.0.1"
fi

# ---------------------------------------------------------------
say ""
say "${C_C}[3] Nginx 与 HTTPS${C_0}"
# ---------------------------------------------------------------
if command -v nginx >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    ok "Nginx 运行中"
  else
    bad "Nginx 没在跑 —— systemctl status nginx"
    FAIL=1
  fi

  PORTS=$(list_ports || true)
  if [ -n "$PORTS" ]; then
    if echo "$PORTS" | grep -qE "[:.]443[[:space:]]"; then
      ok "443 在监听 ✓"
    else
      bad "443 没在监听 —— HTTPS 起不来"
      FAIL=1
    fi
    if echo "$PORTS" | grep -qE "[:.]80[[:space:]]"; then
      ok "80 在监听 ✓（ACME 验证 + 跳转 HTTPS）"
    else
      warn "80 没在监听 —— 证书续期会失败（acme.sh 依赖 80 做 http-01 验证）"
    fi
  fi
else
  warn "没装 Nginx —— 说明还没配 HTTPS"
fi

# 证书文件
if [ -s "$SSL_DIR/fullchain.pem" ] && [ -s "$SSL_DIR/privkey.pem" ]; then
  ok "证书文件就位（$SSL_DIR）"
  CERT_DAYS=$(openssl x509 -enddate -noout -in "$SSL_DIR/fullchain.pem" 2>/dev/null | sed 's/notAfter=//')
  if [ -n "$CERT_DAYS" ]; then
    info "有效期至：$CERT_DAYS"
  fi
  # SAN —— 域名模式下应该显示域名，IP 模式下应该显示 IP 地址
  SAN=$(openssl x509 -noout -text -in "$SSL_DIR/fullchain.pem" 2>/dev/null | grep -A1 "Subject Alternative Name" | tail -1 | tr -d ' ')
  if [ -n "$DOMAIN" ]; then
    if echo "$SAN" | grep -qF "$DOMAIN"; then
      ok "证书签发对象是域名 ${DOMAIN}：$SAN"
    else
      bad "证书里没有 ${DOMAIN}：$SAN —— 跑 https-setup.sh --domain ${DOMAIN} 重签"
      FAIL=1
    fi
  elif echo "$SAN" | grep -qiE "IP ?Address|IPAddress"; then
    ok "证书签发对象是 IP：$SAN"
  else
    warn "证书 SAN 不是 IP 地址：$SAN"
  fi
  # 剩余天数
  REMAIN=$(openssl x509 -noout -checkend 259200 -in "$SSL_DIR/fullchain.pem" 2>&1 >/dev/null && echo "充足" || echo "不足3天")
  if [ "$REMAIN" = "充足" ]; then
    ok "证书剩余有效期 > 3 天 ✓"
  else
    bad "证书快过期了（< 3 天）—— 检查续期：systemctl status acme-renew.timer"
    FAIL=1
  fi
else
  bad "证书文件缺失（$SSL_DIR）—— 跑 bash deploy/https-setup.sh"
  FAIL=1
fi

# ---------------------------------------------------------------
say ""
say "${C_C}[4] 本机功能自测${C_0}"
# ---------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://127.0.0.1/chat" 2>/dev/null); CODE="${CODE:-000}"
  if [ "$CODE" = "200" ]; then
    ok "HTTPS 首页返回 200 ✓"
  else
    bad "HTTPS 首页返回 ${CODE} —— nginx -t 看配置，journalctl -u nginx 看日志"
    FAIL=1
  fi

  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1/chat" 2>/dev/null); CODE="${CODE:-000}"
  if [ "$CODE" = "301" ] || [ "$CODE" = "302" ]; then
    ok "HTTP 正确跳转到 HTTPS（${CODE}）✓"
  elif [ "$CODE" = "200" ]; then
    warn "HTTP 还直接返回 200 —— 没配 301 跳转（不致命，但建议跳 HTTPS）"
  else
    info "HTTP 返回 ${CODE}"
  fi

  # WebSocket 升级 —— 不带口令，应被拒绝（说明门禁和 WS 通路都正常）
  #
  # ⚠️ 用真正的 WebSocket 客户端测，而不是 curl。
  # curl 拿到的是二进制帧，grep 不到 "bad_key" 字符串，会误报「握手没响应」。
  # 服务器上有 Node（项目依赖里有 ws），直接用 node 测最准。
  WS_CHECK_SCRIPT='
const url = process.argv[1];
const WebSocket = require("ws");
const w = new WebSocket(url, { rejectUnauthorized: false });
let done = false;
const finish = (code) => { if (done) return; done = true; try { w.terminate(); } catch (e) {} process.exit(code); };
w.on("open", () => { console.log("OPEN_UNEXPECTED"); finish(2); });
w.on("message", (d) => {
  const s = d.toString();
  if (s.indexOf("bad_key") >= 0) { console.log("BAD_KEY_OK"); finish(0); }
  else { console.log("OTHER:" + s.slice(0, 80)); finish(3); }
});
w.on("error", (e) => { console.log("ERR:" + (e && e.message)); finish(4); });
setTimeout(() => { console.log("TIMEOUT"); finish(5); }, 8000);
'

  NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
  if [ -x "$NODE_BIN" ] && [ -d "$APP_DIR/node_modules/ws" ]; then
    WS_PROBE=$(cd "$APP_DIR" && WS_TMP="$(mktemp /tmp/wsprobe-XXXXXX.js)" && printf '%s' "$WS_CHECK_SCRIPT" > "$WS_TMP" \
      && "$NODE_BIN" "$WS_TMP" "wss://127.0.0.1/ws?key=__probe__&cid=verify-probe" 2>&1 \
      | head -3; rm -f "$WS_TMP" 2>/dev/null || true)
    case "$WS_PROBE" in
      *BAD_KEY_OK*)
        ok "WebSocket 升级正常，且口令门禁生效（bad_key）✓" ;;
      *OPEN_UNEXPECTED*)
        warn "WebSocket 不带口令就连上了 —— 检查口令校验"
        FAIL=1 ;;
      *TIMEOUT*)
        warn "WebSocket 连接超时 —— 检查 Nginx 的 location /ws 配置" ;;
      *ERR:*)
        warn "WebSocket 连接失败 —— ${WS_PROBE}" ;;
      *)
        warn "WebSocket 探测无有效结果：${WS_PROBE}" ;;
    esac
  else
    # 退化路径：没有 node/ws 时退回 curl 握手检查
    WS_OUT=$(curl -s -i -N --max-time 8 \
      -H "Connection: Upgrade" -H "Upgrade: websocket" \
      -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
      "https://127.0.0.1/ws" 2>/dev/null | head -20 || true)
    if echo "$WS_OUT" | grep -q "101"; then
      warn "WebSocket 握手返回 101 —— 不带口令居然连上了？检查口令校验"
      FAIL=1
    elif echo "$WS_OUT" | grep -qi "upgrade\|bad_key"; then
      ok "WebSocket 握手有响应（升级头已透传）✓"
    else
      info "无法确定 WebSocket 状态（缺少 node/ws 客户端，仅提示）"
    fi
  fi
else
  warn "没有 curl，跳过功能自测"
fi

# ---------------------------------------------------------------
say ""
say "${C_C}[5] 证书自动续期${C_0}"
# ---------------------------------------------------------------
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q "acme.sh"; then
    ok "cron 续期任务已注册 ✓"
  else
    warn "cron 里没有 acme.sh 续期任务 —— 跑 https-setup.sh 补上"
  fi
else
  warn "没有 crontab 命令"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled acme-renew.timer >/dev/null 2>&1; then
  ok "systemd timer 兜底已启用 ✓"
else
  warn "acme-renew.timer 没启用 —— 跑 https-setup.sh 补上"
fi

# ---------------------------------------------------------------
say ""
say "${C_C}[6] 公网侧测试${C_0}  ${C_D}—— 从外部访问的视角${C_0}"
# ---------------------------------------------------------------
if [ -z "$PUB_IP" ]; then
  PUB_IP=$(curl -s -m 3 "http://100.100.100.200/latest/meta-data/public-ipv4" 2>/dev/null || true)
  [ -z "$PUB_IP" ] && PUB_IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)
fi

if [ -z "$PUB_IP" ]; then
  info "拿不到公网 IP，跳过（可加 --ip 1.2.3.4 指定）"
else
  info "公网 IP：${PUB_IP}"

  # 有域名时，域名才是真正的访问入口，优先测域名
  HTTPS_HOST="${DOMAIN:-$PUB_IP}"
  if [ -n "$DOMAIN" ]; then
    info "域名：${DOMAIN}"
  fi

  CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "https://${HTTPS_HOST}/chat" 2>/dev/null); CODE="${CODE:-000}"
  if [ "$CODE" = "200" ]; then
    ok "公网 HTTPS 通（${CODE}）✓"
  else
    bad "公网 HTTPS 不通（${CODE}）—— 检查云防火墙 443 规则"
    FAIL=1
  fi

  # 域名模式下，证书必须签给域名（IP 证书在域名访问时会报错）
  if [ -n "$DOMAIN" ] && [ -s "$SSL_DIR/fullchain.pem" ]; then
    SUBJ=$(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -text 2>/dev/null \
      | grep -A1 "Subject Alternative Name" | tail -1 | tr -d ' ' || true)
    if echo "$SUBJ" | grep -qF "$DOMAIN"; then
      ok "证书包含域名 ${DOMAIN} ✓"
    else
      bad "证书里没有 ${DOMAIN}（SAN: ${SUBJ:-未知}）—— 用了 IP 证书，域名访问会报证书错误"
      FAIL=1
    fi
  fi

  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://${PUB_IP}:${NODE_PORT}/chat" 2>/dev/null); CODE="${CODE:-000}"
  case "$CODE" in
    000|"")
      ok "${NODE_PORT} 公网已关闭（连不上）✓ —— 这正是想要的结果"
      ;;
    000*)
      # 可能是 000000 这类异常拼接，视为连不上
      ok "${NODE_PORT} 公网已关闭（连不上）✓ —— 这正是想要的结果"
      ;;
    *)
      bad "${NODE_PORT} 公网还能连上（${CODE}）—— 去控制台删掉 8000 防火墙规则"
      FAIL=1
      ;;
  esac
fi

# ---------------------------------------------------------------
say ""
say "${C_C}============================================${C_0}"
if [ "$FAIL" -eq 0 ]; then
  say "${C_G}  全部通过 ✓${C_0}"
  say ""
  if [ -n "$DOMAIN" ]; then
    say "  ${C_C}最终访问地址${C_0} : https://${DOMAIN}/chat#key=<口令>"
  else
    say "  ${C_C}最终访问地址${C_0} : https://${PUB_IP:-<你的IP>}/chat#key=<口令>"
  fi
else
  say "${C_Y}  有项目没通过（见上面标 ✗ 的）${C_0}"
  say "  ${C_D}常见解法：bash deploy/https-setup.sh（可重复执行）${C_0}"
fi
say "${C_C}============================================${C_0}"
say ""

exit "$FAIL"
