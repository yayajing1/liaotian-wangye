# ============================================================
#  失联救援 · 一键修复（贴在阿里云 Workbench / 云助手里执行）
#
#  背景：服务器 ping 得通，但 22 / 80 / 443 全部 connection timeout。
#  这说明流量被静默丢弃（DROP）—— 安全组加了 IP 白名单，
#  或者机器内部的 ufw / iptables 被改坏，把 SSH 自己也关在门外了。
#
#  Workbench 走阿里云内部通道，不吃公网防火墙，
#  所以就算安全组只剩你自己的 IP，这里也照样能进。
#
#  用法：把下面整段复制进 Workbench 的「命令助手」执行。
# ============================================================

echo "===== 1/5 现状 ====="
echo "--- 公网 IP ---"
curl -s --max-time 5 https://ipinfo.io/ip || echo "(取不到)"
echo
echo "--- ufw 状态 ---"
ufw status verbose 2>&1 | head -30
echo
echo "--- iptables INPUT 链 ---"
iptables -S INPUT 2>&1 | head -30
echo
echo "--- 监听中的端口 ---"
ss -lntp 2>&1 | head -20
echo
echo "--- 服务状态 ---"
systemctl is-active chat-room 2>&1
systemctl is-active nginx 2>&1

echo
echo "===== 2/5 放行 SSH / HTTP / HTTPS ====="
ufw allow 22/tcp 2>&1 | tail -2
ufw allow 80/tcp 2>&1 | tail -2
ufw allow 443/tcp 2>&1 | tail -2
ufw allow 8000/tcp 2>&1 | tail -2

echo
echo "===== 3/5 清理可能挡路的老规则 ====="
# 如果 ufw 里存在针对 SSH 的「只允许某个 IP」的老规则，删掉它
ufw status numbered 2>&1 | grep -E "22/tcp" || echo "  ufw 里没有 22 的限制规则"

# iptables 里手工加的 DROP 规则（删掉自建链 INPUT 里非默认的 DROP）
iptables -S INPUT 2>&1 | grep -- "-j DROP" || echo "  iptables INPUT 里没有 DROP 规则"

echo
echo "===== 4/5 重启网络与防火墙 ====="
ufw reload 2>&1 | tail -2
systemctl restart nginx 2>&1 | tail -2
systemctl restart chat-room 2>&1 | tail -2

echo
echo "===== 5/5 自检 ====="
sleep 2
echo -n "服务 chat-room : "; systemctl is-active chat-room
echo -n "服务 nginx      : "; systemctl is-active nginx
echo -n "端口 8000       : "; ss -lntp 2>/dev/null | grep -q ":8000" && echo "在监听" || echo "没监听"
echo -n "本机回环        : "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:8000/chat
echo -n "本机 HTTPS      : "; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 5 https://127.0.0.1/chat
echo
echo "===== 现在的防火墙全貌（发给我看） ====="
ufw status verbose 2>&1
iptables -S INPUT 2>&1 | head -20
