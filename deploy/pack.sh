#!/usr/bin/env bash
# ==================================================================
#  打包脚本 —— 在你的 Windows 电脑上跑，把项目打成 deploy/chat-room.tar.gz
#
#  用法（在项目根目录）：
#     bash deploy/pack.sh
#
#  产物：deploy/chat-room.tar.gz
#  里面不含 node_modules 和 data/（服务器上现装、现建）
# ==================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/deploy/chat-room.tar.gz"

cd "$ROOT"

echo "打包中..."

# 需要带上的文件：
#   server.js           服务端
#   public/             前端静态文件
#   package.json        依赖清单
#   package-lock.json   锁定版本
#   deploy/deploy.sh    部署脚本
#   deploy/https-setup.sh  HTTPS 装配脚本（IP 证书 + Nginx）
#   deploy/verify.sh    部署状态体检脚本
#   deploy/backup.sh    数据备份/迁移脚本（1 个月到期迁移时用）
# 不带 node_modules（服务器上装）、不带 data/（服务器上建）
#
# 排除两个「隧道下载用」的副本，避免重复打包：
#   public/chat-room.tar.gz  → 包套包
#   public/deploy.sh         → 和 deploy/deploy.sh 重复
# 打包完会把最新副本同步回 public/，供隧道直接下载。
tar -czf "$OUT" \
  --exclude='public/chat-room.tar.gz' \
  --exclude='public/deploy.sh' \
  server.js \
  public/ \
  package.json \
  package-lock.json \
  deploy/deploy.sh \
  deploy/https-setup.sh \
  deploy/verify.sh \
  deploy/backup.sh \
  2>/dev/null

# 同步副本到 public/，隧道即可直接提供下载：
#   https://<隧道地址>/chat-room.tar.gz   ← 代码包
#   https://<隧道地址>/deploy.sh           ← 部署脚本
cp "$OUT" "$ROOT/public/chat-room.tar.gz"
cp "$ROOT/deploy/deploy.sh" "$ROOT/public/deploy.sh"

SIZE=$(du -h "$OUT" | cut -f1)
echo ""
echo "打包完成：$OUT  ($SIZE)"
echo ""
echo "接下来在项目根目录执行（把 IP 换成你的服务器公网 IP）："
echo "  scp -P 22 deploy/chat-room.tar.gz root@你的IP:/root/"
