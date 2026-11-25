#!/usr/bin/env bash
# 备份聊天数据（数据库 + 房间口令）
#
# 用法：
#   bash deploy/backup.sh                    # 备份到 backups/
#   bash deploy/backup.sh /path/to/dir       # 备份到指定目录
#
# 1 个月轻量到期、或要迁移到 ECS 时，用它导出一份带走。
# 迁移只需这个文件 —— 里面包含所有消息、历史昵称和房间口令。

set -euo pipefail

# 先记住用户是否显式指定了 DATA_DIR —— 必须在赋默认值之前判断，
# 否则默认值会让「显式指定」永远为真，自动识别逻辑形同虚设。
DATA_DIR_EXPLICIT=0
[ -n "${DATA_DIR:-}" ] && DATA_DIR_EXPLICIT=1

APP_DIR="${APP_DIR:-/opt/chat-room}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"

# 自动识别安装目录 —— 跟 deploy.sh / https-setup.sh 保持一致：
# 脚本所在目录就有 server.js 时就地操作，避免代码和 data/ 错位。
# （不修的话，服务器实际装在 /opt/chat-room/app，
#   而脚本默认找 /opt/chat-room/data → 报「数据目录不存在」）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$DATA_DIR_EXPLICIT" -eq 0 ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
  DATA_DIR="${APP_DIR}/data"
fi

# BACKUP_DIR 必须在 APP_DIR 确定之后才算，否则会落到旧目录
BACKUP_DIR="${1:-$APP_DIR/backups}"

if [ ! -d "$DATA_DIR" ]; then
  echo "[ERROR] 数据目录不存在: $DATA_DIR" >&2
  echo "如果 DATA_DIR 不是默认路径，请用环境变量指定：" >&2
  echo "  DATA_DIR=/your/data/dir bash deploy/backup.sh" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/chat-data-$TS.tar.gz"

# SQLite 正在写入时直接打包可能拿到损坏的库，
# 所以先做一致性快照，再连同 room.key 一起打包。
#
# 优先用 sqlite3 命令行；没有的话用 Node 内置的 node:sqlite（Node 22+ 自带），
# 两者都能做真正的在线快照，比直接 tar 安全。
SNAP="$BACKUP_DIR/chat.db.snap"
DB=""

if command -v sqlite3 >/dev/null 2>&1; then
  echo "[快照] 用 sqlite3 命令行做一致性快照 ..."
  if sqlite3 "$DATA_DIR/chat.db" ".backup '$SNAP'" 2>/dev/null && [ -s "$SNAP" ]; then
    DB="$SNAP"
  fi
elif command -v node >/dev/null 2>&1; then
  echo "[快照] 用 Node 内置 node:sqlite 做一致性快照 ..."
  SNAP_TMP="$BACKUP_DIR/.snap-$$.js"
  cat > "$SNAP_TMP" <<'SNAPJS'
const { DatabaseSync } = require("node:sqlite");
const src = process.argv[2];
const dst = process.argv[3].replace(/'/g, "''");
const db = new DatabaseSync(src);
db.exec("VACUUM INTO '" + dst + "'");
db.close();
SNAPJS
  if node "$SNAP_TMP" "$DATA_DIR/chat.db" "$SNAP" 2>/dev/null && [ -s "$SNAP" ]; then
    DB="$SNAP"
  fi
  rm -f "$SNAP_TMP" 2>/dev/null || true
else
  echo "[提示] 没有 sqlite3 也没有 node，直接打包（数据量极小，风险低）"
fi

if [ -z "$DB" ]; then
  echo "[提示] 快照失败，改为直接打包"
  DB="$DATA_DIR/chat.db"
fi

tar -czf "$OUT" -C "$(dirname "$DB")" "$(basename "$DB")" \
  -C "$DATA_DIR" room.key 2>/dev/null \
  || tar -czf "$OUT" -C "$DATA_DIR" chat.db room.key

[ -f "$SNAP" ] && rm -f "$SNAP"

echo ""
echo "  备份完成 ✓"
echo "  文件: $OUT"
echo "  大小: $(du -h "$OUT" | cut -f1)"
echo ""
echo "  迁移方法（在服务器上执行）："
echo "    tar -xzf $OUT -C $DATA_DIR"
echo "    systemctl restart chat-room"
echo ""
