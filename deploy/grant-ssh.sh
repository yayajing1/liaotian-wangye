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
# ============================================================

PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQ0AYTQVP6pmYxKmQMp4QWucBvnkctdArZCcYFqzjPV yayajing1@github-powercontext'
TAG='github-powercontext'

echo "===== 1/4 writing SSH public key ====="
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
if grep -q "$TAG" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "  key already present, skip"
else
  echo "$PUBKEY" >> "$HOME/.ssh/authorized_keys"
  echo "  key written ok"
fi
chmod 600 "$HOME/.ssh/authorized_keys"

echo "===== 2/4 adjusting sshd config ====="
SSHD_CONF=/etc/ssh/sshd_config
SSHD_BAK=""

if [ -f "$SSHD_CONF" ]; then
  # SAFETY: back up the config first. If our edit produces an invalid
  # config we restore it immediately -- otherwise the user could lock
  # themselves out of their own server.
  SSHD_BAK="$SSHD_CONF.grantbak"
  cp "$SSHD_CONF" "$SSHD_BAK"

  # sshd uses the FIRST value it obtains for a keyword, so we must
  # replace existing lines (even commented-out ones) instead of appending.
  sed -i 's/^[#[:space:]]*PermitRootLogin.*/PermitRootLogin yes/' "$SSHD_CONF"
  sed -i 's/^[#[:space:]]*PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONF"
  grep -q '^PermitRootLogin yes' "$SSHD_CONF" || echo 'PermitRootLogin yes' >> "$SSHD_CONF"
  grep -q '^PubkeyAuthentication yes' "$SSHD_CONF" || echo 'PubkeyAuthentication yes' >> "$SSHD_CONF"

  # Validate before reloading. If sshd can't parse it, roll back.
  SSHD_TEST_BIN=""
  for c in sshd /usr/sbin/sshd; do
    command -v "$c" >/dev/null 2>&1 && { SSHD_TEST_BIN="$c"; break; }
  done
  if [ -n "$SSHD_TEST_BIN" ]; then
    if "$SSHD_TEST_BIN" -t >/dev/null 2>&1; then
      echo "  sshd_config updated & validated ok"
    else
      cp "$SSHD_BAK" "$SSHD_CONF"
      echo "  WARNING: modified config was invalid -> restored original"
      echo "  (pubkey login may not work; other methods still possible)"
    fi
  else
    echo "  sshd_config updated (could not validate: sshd binary not found)"
  fi
fi

echo "===== 3/4 reloading sshd ====="
# reload only re-reads config; the current Workbench session stays alive
if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
   || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null; then
  echo "  sshd reloaded ok"
else
  echo "  reload skipped (harmless; current session unaffected)"
fi

echo "===== 4/4 server info ====="
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
echo "===== grant complete ====="
echo "Send the PUBLIC_IP value above to the assistant."
echo
