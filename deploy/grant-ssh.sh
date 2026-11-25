#!/bin/bash
# ============================================================
#  One-shot SSH grant for the deploy assistant.
#  Paste ONE line into Aliyun Workbench:
#
#    curl -fsSL https://raw.githubusercontent.com/yayajing1/liaotian-wangye/main/deploy/grant-ssh.sh | bash
#
#  What it does:
#    1. writes the assistant's public key into ~/.ssh/authorized_keys
#    2. makes sure sshd accepts root login via public key
#    3. prints the server's public IP + system info
#
#  Design notes:
#    - The public key is hardcoded below, so this works even when the
#      server cannot reach GitHub raw (self-contained fallback).
#    - sshd uses the FIRST value obtained for a keyword, so existing
#      lines are rewritten in place instead of appended.
#    - /etc/ssh/sshd_config.d/*.conf are checked too, because Ubuntu
#      24.04+ ships a cloud-init drop-in that can override things.
# ============================================================

PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQ0AYTQVP6pmYxKmQMp4QWucBvnkctdArZCcYFqzjPV yayajing1@github-powercontext'
TAG='github-powercontext'

echo "===== 1/5 writing SSH public key ====="
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
if grep -q "$TAG" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "  key already present, skip"
else
  printf '%s\n' "$PUBKEY" >> "$HOME/.ssh/authorized_keys"
  echo "  key written ok"
fi
chmod 600 "$HOME/.ssh/authorized_keys"
echo "  authorized_keys 行数：$(wc -l < "$HOME/.ssh/authorized_keys")"
echo "  当前用户：$(whoami)  HOME=$HOME"

echo "===== 2/5 adjusting sshd config ====="
SSHD_CONF=/etc/ssh/sshd_config
SSHD_BAK=""
BACKED_UP=""

if [ -f "$SSHD_CONF" ]; then
  # SAFETY: back up every file we touch. If our edit produces an invalid
  # config we restore them immediately -- otherwise the user could lock
  # themselves out of their own server.
  SSHD_BAK="$SSHD_CONF.grantbak"
  cp "$SSHD_CONF" "$SSHD_BAK"
  BACKED_UP="$SSHD_CONF"

  # sshd uses the FIRST value it obtains for a keyword, so we must
  # replace existing lines (even commented-out ones) instead of appending.
  # Also handle Ubuntu 24.04+ drop-ins in sshd_config.d/ which can
  # override the main file.
  for f in "$SSHD_CONF" /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] || continue
    if [ "$f" != "$SSHD_CONF" ]; then
      cp "$f" "$f.grantbak" 2>/dev/null || true
      BACKED_UP="$BACKED_UP $f"
    fi
    sed -i 's/^[#[:space:]]*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$f" 2>/dev/null || true
    sed -i 's/^[#[:space:]]*PubkeyAuthentication.*/PubkeyAuthentication yes/' "$f" 2>/dev/null || true
  done

  # PermitRootLogin prohibit-password still allows root login via key.
  # If sshd_config.d contains a "no" line that would win, we must neutralize it.
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] || continue
    if grep -qiE '^[#[:space:]]*PermitRootLogin[[:space:]]+no' "$f" 2>/dev/null; then
      sed -i 's/^[#[:space:]]*PermitRootLogin[[:space:]]*no.*/PermitRootLogin prohibit-password/I' "$f" 2>/dev/null || true
    fi
  done

  grep -q '^PermitRootLogin' "$SSHD_CONF" || echo 'PermitRootLogin prohibit-password' >> "$SSHD_CONF"
  grep -q '^PubkeyAuthentication' "$SSHD_CONF" || echo 'PubkeyAuthentication yes' >> "$SSHD_CONF"

  # Validate before reloading. If sshd can't parse it, roll back.
  SSHD_TEST_BIN=""
  for c in sshd /usr/sbin/sshd; do
    command -v "$c" >/dev/null 2>&1 && { SSHD_TEST_BIN="$c"; break; }
  done
  if [ -n "$SSHD_TEST_BIN" ]; then
    if "$SSHD_TEST_BIN" -t >/dev/null 2>&1; then
      echo "  sshd_config updated & validated ok"
    else
      for f in $BACKED_UP; do
        [ -f "$f.grantbak" ] && cp "$f.grantbak" "$f"
      done
      echo "  WARNING: modified config was invalid -> restored original"
      echo "  (pubkey login may not work; other methods still possible)"
    fi
  else
    echo "  sshd_config updated (could not validate: sshd binary not found)"
  fi
fi

echo "===== 3/5 reloading sshd ====="
# reload only re-reads config; the current Workbench session stays alive
if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
   || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null; then
  echo "  sshd reloaded ok"
else
  echo "  reload skipped (harmless; current session unaffected)"
fi

echo "===== 4/5 server info ====="
IP=""
IP=$(curl -s -m 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
[ -z "$IP" ] && IP=$(wget -qO- -T 5 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null)
[ -z "$IP" ] && IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null)
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "  PUBLIC_IP: ${IP:-NOT_FOUND_CHECK_CONSOLE}"
echo "  OS: $(grep -E '^PRETTY_NAME' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || echo unknown)"
echo "  ARCH: $(uname -m)"
echo "  USER: $(whoami)"
echo "  NODE: $(command -v node >/dev/null 2>&1 && node -v || echo 'not installed')"
echo "  GIT: $(command -v git >/dev/null 2>&1 && git --version || echo 'not installed')"
echo "  CPU: $(nproc 2>/dev/null || echo '?') cores"
echo "  MEM: $(free -m 2>/dev/null | awk '/^Mem:/{print $2"MB total"}' || echo '?')"
echo

# ---------- 4.5 本机防火墙检查 ----------
# 云控制台的规则我们改不了，但服务器内部的 ufw/iptables 如果拦了 80，
# ACME 验证就会失败。先看状态，给出提示。
echo "===== 5/5 本机防火墙 & 端口自检 ====="
if command -v ufw >/dev/null 2>&1; then
  UFW_STATE=$(ufw status 2>/dev/null | head -1 || echo "unknown")
  echo "  ufw 状态：${UFW_STATE}"
  if echo "$UFW_STATE" | grep -qi "active"; then
    echo "  ⚠️ ufw 已启用。若 80 端口不通，可执行："
    echo "     ufw allow 80/tcp && ufw allow 443/tcp"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  echo "  firewalld 状态：$(firewall-cmd --state 2>/dev/null || echo unknown)"
  echo "  ⚠️ 如需放行：firewall-cmd --permanent --add-service=http && firewall-cmd --permanent --add-service=https && firewall-cmd --reload"
fi

echo "  当前监听端口："
if command -v ss >/dev/null 2>&1; then
  ss -tln 2>/dev/null | awk 'NR>1{print "    "$4}' | head -15
elif command -v netstat >/dev/null 2>&1; then
  netstat -an 2>/dev/null | grep -i "LISTEN" | awk '{print "    "$4}' | head -15
fi
echo

echo "===== grant complete ====="
echo "Send the PUBLIC_IP value above to the assistant."
echo
