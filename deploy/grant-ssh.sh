#!/bin/bash
# ============================================================
#  One-shot SSH grant for the deploy assistant.
#  Paste ONE line into Aliyun Workbench:
#
#    curl -fsSL https://raw.githubusercontent.com/yayajing1/liaotian-wangye/main/deploy/grant-ssh.sh | bash
#
#  What it does:
#    1. writes the assistant's public key into <target>/.ssh/authorized_keys
#    2. makes sure sshd accepts root login via public key
#    3. prints the server's public IP + system info
#
#  Design notes:
#    - The public key is hardcoded below, so this works even when the
#      server cannot reach GitHub raw.
#    - Aliyun Workbench logs you in as "admin", NOT root. Every privileged
#      step therefore goes through sudo individually. We never re-exec
#      the whole script with sudo, because in a `curl | bash` pipeline
#      $0 is not the script and stdin is already consumed.
#    - sshd uses the FIRST value obtained for a keyword, so existing
#      lines are rewritten in place instead of appended.
#    - /etc/ssh/sshd_config.d/*.conf are handled too, because Ubuntu
#      24.04+ ships a cloud-init drop-in that can override things.
# ============================================================

PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQ0AYTQVP6pmYxKmQMp4QWucBvnkctdArZCcYFqzjPV yayajing1@github-powercontext'
TAG='github-powercontext'

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_0="\033[0m"
say() { printf "%b\n" "$1"; }

# ---------- 提权封装 ----------
SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    say "  [提示] 当前用户是 $(whoami)（非 root），特权操作将自动加 sudo"
  else
    say "${C_R}[ERROR] 当前用户是 $(whoami) 且没有 sudo，无法完成授权${C_0}"
    exit 1
  fi
fi
run() { $SUDO "$@"; }

# 目标账号：优先 root（助手就是用 root 登录的）
TARGET_USER="root"
if ! id root >/dev/null 2>&1; then
  TARGET_USER="$(id -un)"
  say "  ${C_Y}⚠️ 系统没有 root 账号，改为授权给 ${TARGET_USER}${C_0}"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -z "$TARGET_HOME" ] && TARGET_HOME="/root"

say ""
say "===== 1/5 writing SSH public key ====="
say "  授权目标账号：${TARGET_USER}  HOME=${TARGET_HOME}"

run mkdir -p "$TARGET_HOME/.ssh"
run chmod 700 "$TARGET_HOME/.ssh"
run touch "$TARGET_HOME/.ssh/authorized_keys"

if run grep -q "$TAG" "$TARGET_HOME/.ssh/authorized_keys" 2>/dev/null; then
  say "  key already present, skip"
else
  # printf | sudo tee -a ：重定向在 root 侧生效，避免权限问题
  printf '%s\n' "$PUBKEY" | run tee -a "$TARGET_HOME/.ssh/authorized_keys" >/dev/null
  say "  key written ok"
fi

run chmod 600 "$TARGET_HOME/.ssh/authorized_keys"
run chown -R "$TARGET_USER":"$TARGET_USER" "$TARGET_HOME/.ssh" 2>/dev/null || true

KEY_LINES=$(run sh -c "wc -l < '$TARGET_HOME/.ssh/authorized_keys'" 2>/dev/null | tr -d ' ')
say "  authorized_keys 行数：${KEY_LINES:-?}"
say "  当前执行身份：$(whoami) (uid=$(id -u))"

say ""
say "===== 2/5 adjusting sshd config ====="
SSHD_CONF=/etc/ssh/sshd_config
BACKED_UP=""

if [ -f "$SSHD_CONF" ]; then
  # SAFETY: back up every file we touch. If the edit produces an invalid
  # config we restore them immediately -- otherwise the user could lock
  # themselves out of their own server.
  run cp "$SSHD_CONF" "$SSHD_CONF.grantbak"
  BACKED_UP="$SSHD_CONF"

  # sshd uses the FIRST value it obtains for a keyword, so we must
  # replace existing lines (even commented-out ones) instead of appending.
  for f in "$SSHD_CONF" /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] || continue
    if [ "$f" != "$SSHD_CONF" ]; then
      run cp "$f" "$f.grantbak" 2>/dev/null || true
      BACKED_UP="$BACKED_UP $f"
    fi
    # PermitRootLogin prohibit-password still allows root login via key,
    # but does not open password login for root.
    run sed -i 's/^[#[:space:]]*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$f" 2>/dev/null || true
    run sed -i 's/^[#[:space:]]*PubkeyAuthentication.*/PubkeyAuthentication yes/' "$f" 2>/dev/null || true
  done

  # Any drop-in that still says "no" would win over the main file — neutralize it.
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] || continue
    if grep -qiE '^[#[:space:]]*PermitRootLogin[[:space:]]+no' "$f" 2>/dev/null; then
      run sed -i 's/^[#[:space:]]*PermitRootLogin[[:space:]]*no.*/PermitRootLogin prohibit-password/I' "$f" 2>/dev/null || true
    fi
  done

  run grep -q '^PermitRootLogin' "$SSHD_CONF" || run sh -c "echo 'PermitRootLogin prohibit-password' >> '$SSHD_CONF'"
  run grep -q '^PubkeyAuthentication' "$SSHD_CONF" || run sh -c "echo 'PubkeyAuthentication yes' >> '$SSHD_CONF'"

  # Validate before reloading. If sshd can't parse it, roll back.
  SSHD_TEST_BIN=""
  for c in sshd /usr/sbin/sshd; do
    command -v "$c" >/dev/null 2>&1 && { SSHD_TEST_BIN="$c"; break; }
  done
  if [ -n "$SSHD_TEST_BIN" ]; then
    if "$SSHD_TEST_BIN" -t >/dev/null 2>&1; then
      say "  sshd_config updated & validated ok"
    else
      for f in $BACKED_UP; do
        [ -f "$f.grantbak" ] && run cp "$f.grantbak" "$f"
      done
      say "${C_R}  WARNING: modified config was invalid -> restored original${C_0}"
      say "  (pubkey login may not work; other methods still possible)"
    fi
  else
    say "  sshd_config updated (could not validate: sshd binary not found)"
  fi
fi

say ""
say "===== 3/5 reloading sshd ====="
# reload only re-reads config; the current Workbench session stays alive
if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
   || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null; then
  say "  sshd reloaded ok"
else
  say "  reload skipped (harmless; current session unaffected)"
fi

say ""
say "===== 4/5 server info ====="
IP=""
IP=$(curl -s -m 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
[ -z "$IP" ] && IP=$(wget -qO- -T 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
[ -z "$IP" ] && IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null)
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say "  PUBLIC_IP: ${IP:-NOT_FOUND_CHECK_CONSOLE}"
say "  OS: $(grep -E '^PRETTY_NAME' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || echo unknown)"
say "  ARCH: $(uname -m)"
say "  LOGIN USER: $(whoami)  (sudo 授权给 ${TARGET_USER})"
say "  NODE: $(command -v node >/dev/null 2>&1 && node -v || echo 'not installed')"
say "  GIT: $(command -v git >/dev/null 2>&1 && git --version || echo 'not installed')"
say "  CPU: $(nproc 2>/dev/null || echo '?') cores"
say "  MEM: $(free -m 2>/dev/null | awk '/^Mem:/{print $2"MB total"}' || echo '?')"

say ""
say "===== 5/5 本机防火墙 & 端口自检 ====="
if command -v ufw >/dev/null 2>&1; then
  UFW_STATE=$(ufw status 2>/dev/null | head -1 || echo "unknown")
  say "  ufw 状态：${UFW_STATE}"
  if echo "$UFW_STATE" | grep -qi "active"; then
    say "  ⚠️ ufw 已启用。若 80 端口不通，可执行："
    say "     sudo ufw allow 80/tcp && sudo ufw allow 443/tcp"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  say "  firewalld 状态：$(firewall-cmd --state 2>/dev/null || echo unknown)"
  say "  ⚠️ 如需放行：sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload"
fi

say "  当前监听端口："
if command -v ss >/dev/null 2>&1; then
  ss -tln 2>/dev/null | awk 'NR>1{print "    "$4}' | head -15
elif command -v netstat >/dev/null 2>&1; then
  netstat -an 2>/dev/null | grep -i "LISTEN" | awk '{print "    "$4}' | head -15
fi

say ""
say "${C_G}===== grant complete =====${C_0}"
say "Send the PUBLIC_IP value above to the assistant."
say ""
