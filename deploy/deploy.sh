#!/usr/bin/env bash
# ==================================================================
#  聊天室 —— 云服务器一键部署脚本（Ubuntu / Debian / Alibaba Cloud Linux）
#
#  用法：
#     bash deploy.sh                # 交互式安装
#     bash deploy.sh --port 8000    # 指定端口
#
#  做的事：
#     1. 检查 Node.js 版本（必须 >= 22，用到内置的 node:sqlite）
#     2. 安装依赖（只用 ws，不需要编译原生模块）
#     3. 注册 systemd 服务，开机自启、崩溃自动重启
#     4. 打印访问地址和房间口令
#
#  不做的事：Nginx / HTTPS / 域名 —— 那些需要域名和备案，
#            等有域名了再按 deploy/生产部署.md 补。
# ==================================================================
set -euo pipefail

APP_DIR="/opt/chat-room"
PORT="8000"
DATA_DIR="/opt/chat-room/data"
PKG_URL=""
SELF_URL=""
GIT_REPO=""
WITH_HTTPS=0
APP_DIR_EXPLICIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir)  APP_DIR="$2"; APP_DIR_EXPLICIT=1; shift 2 ;;
    --url)  PKG_URL="$2"; shift 2 ;;
    --self) SELF_URL="$2"; shift 2 ;;
    --git)  GIT_REPO="$2"; shift 2 ;;
    --https) WITH_HTTPS=1; shift ;;
    -h|--help)
      echo "用法: bash deploy.sh [--port 端口] [--dir 安装目录] [--url 代码包下载地址] [--self 本脚本下载地址] [--git GitHub仓库地址] [--https 顺便配HTTPS]"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# --dir 改了安装目录，数据目录跟着走
DATA_DIR="${APP_DIR}/data"

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_C="\033[36m"; C_0="\033[0m"
say() { printf "%b\n" "$1"; }

# 自动识别安装目录：
# 如果脚本自己所在目录就有 server.js，说明用户已经手动 clone 好了
# （比如 git clone 到 /opt/chat-room/app 然后 cd app 跑本脚本），
# 那就装在原地，不要再往 /opt/chat-room 复制一份 —— 否则会出现
# 「代码在 app/ 里、data/ 在 /opt/chat-room/data」这种错位，
# systemd 的 WorkingDirectory 和实际代码位置对不上。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$APP_DIR_EXPLICIT" -eq 0 ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
  DATA_DIR="${APP_DIR}/data"
  say "      检测到代码已在 ${SCRIPT_DIR}，就地安装"
fi

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_C="\033[36m"; C_0="\033[0m"
say() { printf "%b\n" "$1"; }

# ---------- 下载辅助 ----------
# 云服务器上通常不需要代理，但有些环境预设了 HTTP_PROXY 会导致
# 直连的地址被代理转发、返回 502。这里做两级尝试：
# 先按环境默认试，失败再强制绕过代理试一次。
fetch_ok() {
  # $1=url  $2=输出文件  $3=超时秒数  $4=重试次数（默认 1）
  # 注意：curl 遇到 502 这类错误也会返回退出码 0（把错误页当 body 下载下来），
  # 所以必须自己检查 HTTP 状态码。
  local URL="$1" OUT="$2" TMO="${3:-60}" RETRY="${4:-1}" CODE
  local i=0
  while [ "$i" -lt "$RETRY" ]; do
    i=$((i+1))
    if command -v curl >/dev/null 2>&1; then
      CODE=$(curl -sf -o "$OUT" -m "$TMO" -w '%{http_code}' "$URL" 2>/dev/null || echo "")
      case "$CODE" in 2*|3*) return 0 ;; esac
      CODE=$(curl -sf -o "$OUT" -m "$TMO" --noproxy '*' -w '%{http_code}' "$URL" 2>/dev/null || echo "")
      case "$CODE" in 2*|3*) return 0 ;; esac
    fi
    if command -v wget >/dev/null 2>&1; then
      wget -q -T "$TMO" -O "$OUT" "$URL" 2>/dev/null && return 0
      wget -q -T "$TMO" --no-proxy -O "$OUT" "$URL" 2>/dev/null && return 0
    fi
    [ "$i" -lt "$RETRY" ] && sleep 2
  done
  return 1
}

# 测一个 URL 的响应时间（秒）。只认 HTTP 2xx/3xx，
# 不通的地址必须返回非 0 —— 否则 curl 对失败请求也会输出 time=0.05，
# 会被误判成"最快的源"。
probe_time() {
  local URL="$1" TMO="${2:-8}" OUT
  if command -v curl >/dev/null 2>&1; then
    OUT=$(curl -s -o /dev/null -m "$TMO" -w '%{http_code} %{time_total}' "$URL" 2>/dev/null || echo "")
    case "$OUT" in
      2*|3*) echo "$OUT" | awk '{print $2}'; return 0 ;;
    esac
    OUT=$(curl -s -o /dev/null -m "$TMO" --noproxy '*' -w '%{http_code} %{time_total}' "$URL" 2>/dev/null || echo "")
    case "$OUT" in
      2*|3*) echo "$OUT" | awk '{print $2}'; return 0 ;;
    esac
  fi
  return 1
}

say ""
say "${C_C}  ============================================${C_0}"
say "${C_C}    Chat Room  -  云服务器部署${C_0}"
say "${C_C}  ============================================${C_0}"
say ""

# ---------- 1. 运行环境检查 ----------

if [ "$(id -u)" != "0" ]; then
  say "${C_Y}[提示] 当前不是 root，会用 sudo 提权${C_0}"
  SUDO="sudo"
else
  SUDO=""
fi

say "[1/5] 检查 Node.js ..."

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 22 ] 2>/dev/null; then
    NODE_OK=1
    say "      已安装 $(node -v) ✓"
  else
    say "      当前 $(node -v)，太低了（需要 >= 22）"
  fi
fi

if [ "$NODE_OK" -eq 0 ]; then
  say "      正在下载 Node.js 22 ..."
  NODE_VER="v22.22.2"
  ARCH="x64"
  [ "$(uname -m)" = "aarch64" ] && ARCH="arm64"

  cd /tmp

  # 两个源都留着：国内节点用 npmmirror，海外节点用官方 nodejs.org
  URL_NP="https://cdn.npmmirror.com/binaries/node/${NODE_VER}/node-${NODE_VER}-linux-${ARCH}.tar.xz"
  URL_OF="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${ARCH}.tar.xz"

  # curl / wget 挨个试 —— 精简版系统镜像不一定预装 curl
  DL_OK=0
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    say "      没找到 curl/wget，正在安装 ..."
    (apt-get update -qq && apt-get install -y -qq curl xz-utils) >/dev/null 2>&1 \
      || (yum install -y -q curl xz) >/dev/null 2>&1 \
      || true
  fi

  fetch_to() {
    # $1=url  $2=outfile
    fetch_ok "$1" "$2" 180
  }

  # 先试 npmmirror，失败换官方源
  for TRY_URL in "$URL_NP" "$URL_OF"; do
    [ "$DL_OK" -eq 1 ] && break
    if fetch_to "$TRY_URL" node.tar.xz; then
      DL_OK=1
      say "      下载完成 ✓"
    else
      say "      ${C_Y}该源不可用，换一个 ...${C_0}"
      rm -f node.tar.xz
    fi
  done

  if [ "$DL_OK" -eq 1 ]; then
    mkdir -p /usr/local/lib/nodejs
    tar -xJf node.tar.xz -C /usr/local/lib/nodejs --strip-components=1
    rm -f node.tar.xz
    ln -sf "/usr/local/lib/nodejs/bin/node" /usr/local/bin/node
    ln -sf "/usr/local/lib/nodejs/bin/npm"  /usr/local/bin/npm
    ln -sf "/usr/local/lib/nodejs/bin/npx"  /usr/local/bin/npx
    hash -r
    say "      安装完成 $(node -v) ✓"
  else
    say "${C_R}[ERROR] Node.js 下载失败，请检查服务器网络${C_0}"
    say "      手动装依赖后重跑本脚本："
    say "        apt-get update && apt-get install -y curl xz-utils"
    exit 1
  fi
fi

# ---------- 2. 依赖 ----------

say ""
say "[2/5] 安装依赖 ..."

# 代码必须先到位。常见两种情况：
#   a) 已经把项目放在 /opt/chat-room 里了
#   b) 只上传了一个 chat-room.tar.gz —— 那就自动解开
#   c) 服务器上一条命令从网上拉 —— 用 --url 或 --self 指定来源
#
# --self 自举：如果知道本脚本是从哪个 URL 下载的，
# 就自动推断出同目录下同名的代码包（deploy.sh ↔ chat-room.tar.gz）。
# 代码获取策略：
#   a) 显式给了 --git → 一定从 GitHub 拉（哪怕目录里已经有旧代码，也要更新）
#   b) APP_DIR 里已经有 server.js → 直接用
#   c) 只上传了 chat-room.tar.gz → 自动解开
#   d) 服务器上一条命令从网上拉 —— 用 --url 或 --self 指定来源
#
# --self 自举：如果知道本脚本是从哪个 URL 下载的，
# 就自动推断出同目录下同名的代码包（deploy.sh ↔ chat-room.tar.gz）。
if [ -z "$PKG_URL" ] && [ -n "$SELF_URL" ]; then
  case "$SELF_URL" in
    */deploy.sh)
      PKG_URL="${SELF_URL%/deploy.sh}/chat-room.tar.gz"
      say "      自动推断代码包地址：$PKG_URL"
      ;;
  esac
fi

if [ -n "$GIT_REPO" ] || [ ! -f "$APP_DIR/server.js" ]; then
  TARBALL=""
  for cand in /root/chat-room.tar.gz /root/chat-room.tar.gz "$HOME/chat-room.tar.gz"; do
    [ -f "$cand" ] && TARBALL="$cand" && break
  done

  if [ -n "$GIT_REPO" ]; then
    # 从 GitHub 直接 clone —— 免去传文件，服务器一条命令搞定
    say "      从 GitHub 拉取代码 ..."
    say "      $GIT_REPO"

    CLONE_TMP=$(mktemp -d)
    CLONE_OK=0

    # 优先 git clone。精简镜像常常没装 git，没装就装。
    if command -v git >/dev/null 2>&1; then
      if git clone --depth 1 "$GIT_REPO" "$CLONE_TMP/app" >/dev/null 2>&1; then
        CLONE_OK=1
      fi
    else
      say "      未检测到 git，尝试安装 ..."
      (apt-get update -qq && apt-get install -y -qq git) >/dev/null 2>&1 \
        || (yum install -y -q git) >/dev/null 2>&1 \
        || true
      if command -v git >/dev/null 2>&1; then
        git clone --depth 1 "$GIT_REPO" "$CLONE_TMP/app" >/dev/null 2>&1 && CLONE_OK=1
      fi
    fi

    # 兜底：git 装不上 / 克隆失败 → 直接下载 codeload 的 tarball
    if [ "$CLONE_OK" -eq 0 ]; then
      say "      git 方式不可用，改用压缩包下载 ..."
      # https://github.com/<user>/<repo>.git → https://codeload.github.com/<user>/<repo>/tar.gz/<branch>
      REPO_PATH="${GIT_REPO%.git}"
      REPO_PATH="${REPO_PATH#https://github.com/}"
      REPO_PATH="${REPO_PATH#http://github.com/}"
      REPO_PATH="${REPO_PATH#git@github.com:}"
      OWNER="${REPO_PATH%%/*}"
      REPO_NAME="${REPO_PATH##*/}"
      TARBALL_URL="https://codeload.github.com/${OWNER}/${REPO_NAME}/tar.gz/refs/heads/main"

      if fetch_ok "$TARBALL_URL" "$CLONE_TMP/app.tar.gz" 120 2; then
        if tar -tzf "$CLONE_TMP/app.tar.gz" >/dev/null 2>&1; then
          mkdir -p "$CLONE_TMP/app"
          tar -xzf "$CLONE_TMP/app.tar.gz" -C "$CLONE_TMP/app" --strip-components=1
          CLONE_OK=1
        fi
      fi
    fi

    if [ "$CLONE_OK" -eq 1 ]; then
      mkdir -p "$APP_DIR"
      # 只拷代码，不碰已有 data/
      cp -a "$CLONE_TMP/app/." "$APP_DIR/"
      rm -rf "$CLONE_TMP"
      say "      拉取完成 ✓"
    else
      rm -rf "$CLONE_TMP"
      say "${C_R}[ERROR] 从 GitHub 拉取失败${C_0}"
      say "      请检查："
      say "        1. 仓库地址是否正确（现在是 $GIT_REPO）"
      say "        2. 仓库是否为 Public（私有仓库需要配 SSH key 或 token）"
      say "        3. 服务器能否访问 github.com：curl -I https://github.com"
      exit 1
    fi
  elif [ -n "$TARBALL" ]; then
    say "      发现 $TARBALL，正在解开到 $APP_DIR ..."
    mkdir -p "$APP_DIR"
    tar -xzf "$TARBALL" -C "$APP_DIR"
    say "      解包完成 ✓"
  elif [ -n "$PKG_URL" ]; then
    # 从 URL 下载代码包（手机上没电脑时最省事：一条命令搞定）
    say "      从网络下载代码包 ..."
    say "      $PKG_URL"
    mkdir -p "$APP_DIR"
    DL_OK=0
    if fetch_ok "$PKG_URL" /tmp/chat-room.tar.gz 120 3; then
      DL_OK=1
    fi

    if [ "$DL_OK" -eq 1 ]; then
      # 校验是不是有效的 gzip 包（防止下到的是 HTML 错误页）
      if ! tar -tzf /tmp/chat-room.tar.gz >/dev/null 2>&1; then
        say "${C_R}[ERROR] 下载到的不是有效的代码包（可能是错误页）${C_0}"
        exit 1
      fi
      tar -xzf /tmp/chat-room.tar.gz -C "$APP_DIR"
      rm -f /tmp/chat-room.tar.gz
      say "      下载并解包完成 ✓"
    else
      say "${C_R}[ERROR] 下载失败${C_0}"
      say "      试试手动下载后上传，或检查服务器网络"
      exit 1
    fi
  else
    say "${C_R}[ERROR] $APP_DIR 下没有 server.js${C_0}"
    say "      请先把代码放过去，四选一："
    say ""
    say "        ${C_C}方式1${C_0}（从 GitHub 拉，最省事，推荐）："
    say "          bash deploy/deploy.sh --git https://github.com/<用户名>/<仓库名>.git"
    say ""
    say "        ${C_C}方式2${C_0}（有电脑）："
    say "          scp -P 22 deploy/chat-room.tar.gz root@你的IP:/root/   # 然后重跑本脚本"
    say ""
    say "        ${C_C}方式3${C_0}（只有手机，一条命令）："
    say "          bash deploy/deploy.sh --url <代码包的下载链接>"
    say ""
    say "        ${C_C}方式4${C_0}（手动上传解包）："
    say "          tar -xzf chat-room.tar.gz -C $APP_DIR"
    exit 1
  fi
fi

cd "$APP_DIR"

# ---------- 选 npm 源 ----------
# 服务器可能在新加坡/海外，国内源反而更慢；
# 也可能在内地，官方源又太慢。所以实测两个源，谁快用谁。
# 全部失败就用官方源（最稳，只是慢一点）。
pick_npm_registry() {
  local NP="https://registry.npmmirror.com"
  local OF="https://registry.npmjs.org"
  local t_np t_of

  say "      测速 npm 源 ..."
  t_np=$(probe_time "$NP/ws" 8 || echo "")
  t_of=$(probe_time "$OF/ws" 8 || echo "")

  # 只有一个源可用 → 用它
  if [ -z "$t_np" ] && [ -z "$t_of" ]; then
    say "      ${C_Y}两个源都测不通，用官方源（可能较慢）${C_0}"
    npm config set registry "$OF" >/dev/null 2>&1 || true
    return
  fi
  if [ -z "$t_of" ]; then
    say "      用 npmmirror（官方源不可达）"
    npm config set registry "$NP" >/dev/null 2>&1 || true
    return
  fi
  if [ -z "$t_np" ]; then
    say "      用官方源（npmmirror 不可达）"
    npm config set registry "$OF" >/dev/null 2>&1 || true
    return
  fi

  # 都可用 → 比时间
  if [ "$(echo "$t_np < $t_of" | bc 2>/dev/null || echo 0)" = "1" ]; then
    say "      用 npmmirror（${t_np}s）"
    npm config set registry "$NP" >/dev/null 2>&1 || true
  else
    say "      用官方源（${t_of}s，更快）"
    npm config set registry "$OF" >/dev/null 2>&1 || true
  fi
}

pick_npm_registry

# 装依赖，失败自动换源重试一次
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
  else
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
  fi
}

if ! install_deps; then
  say "      ${C_Y}依赖安装失败，换官方源重试 ...${C_0}"
  npm config set registry https://registry.npmjs.org >/dev/null 2>&1 || true
  if ! install_deps; then
    say "${C_R}[ERROR] 依赖安装失败，请检查服务器网络能否访问 npm${C_0}"
    exit 1
  fi
fi

# 依赖真的装上了吗？（npm 失败时退出码可能仍为 0，要验实际结果）
if [ ! -d "$APP_DIR/node_modules/ws" ]; then
  say "${C_R}[ERROR] node_modules/ws 不存在，依赖没装成功${C_0}"
  say "      请手动执行： cd $APP_DIR && npm install --omit=dev${C_0}"
  exit 1
fi
say "      依赖就绪 ✓"

# ---------- 3. 目录与权限 ----------

say ""
say "[3/5] 准备数据目录 ..."

# 内存兜底：1GB 内存的机器（轻量 2核1G）跑 Node 会略显紧张，
# 加 1GB swap 可以避免偶发 OOM 把服务打死。已经有 swap 就跳过。
if [ "$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')" -lt 100 ] 2>/dev/null; then
  say "      检测到无 swap，添加 1GB 交换分区 ..."
  if command -v fallocate >/dev/null 2>&1; then
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  else
    dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null 2>&1
  swapon /swapfile 2>/dev/null && say "      swap 已启用 ✓" || say "      ${C_Y}[提示] swap 创建失败，不影响运行${C_0}"
  # 重启后仍生效
  grep -q "/swapfile" /etc/fstab 2>/dev/null || echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
fi

# 用一个专门的非 root 用户跑服务 —— 不需要 root，也不该用 root。
RUN_USER="chatroom"

if ! id "$RUN_USER" >/dev/null 2>&1; then
  if useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --no-create-home "$RUN_USER" 2>/dev/null; then
    say "      已创建运行用户：$RUN_USER"
  else
    # 建不出专用用户就退而用 root —— 能跑，但权限过大，明确告知
    RUN_USER="root"
    say "${C_Y}      ${C_Y}提示：无法创建专用用户，将以 root 运行（功能正常，权限偏大）${C_0}"
  fi
else
  say "      运行用户已存在：$RUN_USER"
fi

mkdir -p "$DATA_DIR"

# systemd 的 ReadWritePaths 指向的路径必须**已经存在**，
# 否则服务会直接启动失败（ProtectSystem 系列加固与它有先后依赖）。
# 上面 mkdir 过了，这里再确认一次并给足权限。
chmod 700 "$DATA_DIR"

# 代码目录只读即可，服务运行期不写代码目录
chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true

# ---------- 4. systemd 服务 ----------

say ""
say "[4/5] 注册 systemd 服务 ..."

# 房间口令：优先用环境变量 ROOM_KEY，没设就沿用/生成 data/room.key
cat > /etc/systemd/system/chat-room.service <<EOF
[Unit]
Description=Chat Room WebSocket Server
After=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=ALT_PORT=0
Environment=DATA_DIR=${DATA_DIR}
Environment=NODE_ENV=production
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chat-room >/dev/null 2>&1
systemctl restart chat-room
sleep 3

#  ---------- 5. 自检 + 打印地址 ----------

say ""
say "[5/5] 自检 ..."

if systemctl is-active --quiet chat-room; then
  say "      服务状态：运行中 ✓"
else
  say "${C_R}[ERROR] 服务没起来，日志如下：${C_0}"
  journalctl -u chat-room -n 30 --no-pager
  exit 1
fi

# 本机监听检查 —— 端口通不通，先在服务器内部确认，
# 这样如果外部访问不了，就能确定是「云防火墙没放行」而不是「服务没起来」。
if command -v ss >/dev/null 2>&1; then
  if ss -tln 2>/dev/null | grep -q ":${PORT}"; then
    say "      端口监听：${PORT} 已在 LISTEN ✓"
  else
    say "${C_Y}[警告] 没看到 ${PORT} 在监听，请检查 journalctl -u chat-room${C_0}"
  fi
fi

# 从本机探一下，确认真的能响应
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/chat" || echo "000")
  if [ "$CODE" = "200" ]; then
    say "      HTTP 自检：200 ✓"
  else
    say "${C_Y}[警告] HTTP 自检返回 ${CODE}，服务可能还没完全就绪${C_0}"
  fi
fi

# 房间口令
KEY=""
if [ -f "$DATA_DIR/room.key" ]; then
  KEY=$(tr -d '\r\n' < "$DATA_DIR/room.key")
fi

# 公网 IP —— 依次尝试 4 种方式，保证一定能拿到
# 1) 阿里云元数据服务（内网 100.100.100.200，最可靠、最快，不走公网）
# 2) ipify.org
# 3) ifconfig.me
# 4) 本机网卡地址兜底（拿不到公网 IP 时至少能看个大概）
PUB_IP=""
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
  [ -n "$PUB_IP" ] && say "${C_Y}      提示：以上是网卡地址，公网 IP 请从控制台实例卡片复制${C_0}"
fi

say ""
say "${C_G}  ============================================${C_0}"
say "${C_G}    部署完成${C_0}"
say "${C_G}  ============================================${C_0}"
say ""
say "  ${C_C}本机访问${C_0}  : http://127.0.0.1:${PORT}/chat"
if [ -n "$PUB_IP" ]; then
  say "  ${C_C}公网访问${C_0}  : http://${PUB_IP}:${PORT}/chat"
fi
say ""
if [ -n "$KEY" ]; then
  say "  ${C_Y}房间口令${C_0}  : ${KEY}"
  if [ -n "$PUB_IP" ]; then
    say ""
    say "  ${C_G}发给朋友的链接${C_0} :"
    say "  ${C_G}http://${PUB_IP}:${PORT}/chat#key=${KEY}${C_0}"
  fi
fi
say ""
say "${C_Y}接下来必做${C_0}："
if [ -n "$PUB_IP" ]; then
  say "  1. 放行 TCP 端口 ${PORT}（二选一，看你买的是哪种产品）："
  say ""
  say "     ${C_C}轻量应用服务器${C_0} → 控制台 → 轻量应用服务器 → 实例 → 防火墙 → 添加规则"
  say "     ${C_C}ECS 云服务器${C_0}   → 控制台 → ECS → 实例 → 安全组 → 配置规则 → 入方向手动添加"
  say ""
  say "     规则内容：协议 TCP  ｜ 端口 ${PORT}  ｜ 授权对象 0.0.0.0/0"
  say "     （只放行你朋友家的 IP 更安全，但他家 IP 可能会变）"
else
  say "  1. 在云控制台放行 TCP 端口 ${PORT}（轻量=防火墙，ECS=安全组入方向）"
fi
say "  2. 浏览器打开上面的「公网访问」地址，页面能打开就算成功"
say "  3. 把「发给朋友的链接」发给他"
say ""
say "${C_G}常用命令${C_0}："
say "  systemctl status chat-room    查看状态"
say "  systemctl restart chat-room   重启"
say "  journalctl -u chat-room -f    看实时日志"
say ""

# ---------- 6. 可选：装 HTTPS ----------
# 为什么单独一步：HTTPS 需要 80/443 端口放行，
# 而放行是在云控制台做的（服务器自己改不了），
# 所以这里把该做的都做了，最后告诉你控制台要放行什么。
if [ "$WITH_HTTPS" -eq 1 ]; then
  say ""
  say "${C_C}============================================${C_0}"
  say "${C_C}  第 6 步：配置 HTTPS（地址栏小锁 + wss）${C_0}"
  say "${C_C}============================================${C_0}"

  HTTPS_SH="$APP_DIR/deploy/https-setup.sh"
  if [ -f "$HTTPS_SH" ]; then
    # 装依赖那步可能因为 --omit=dev 跳过了 devDeps，但这个脚本是纯 bash，无依赖
    bash "$HTTPS_SH" --ip "$PUB_IP" --port "$PORT" --dir "$APP_DIR" || \
      say "${C_Y}[提示] HTTPS 环节未完全成功，可稍后单独跑：bash deploy/https-setup.sh${C_0}"
  else
    say "${C_Y}[提示] 没找到 $HTTPS_SH${C_0}"
  fi
fi

