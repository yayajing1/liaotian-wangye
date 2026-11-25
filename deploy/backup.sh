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

APP_DIR="${APP_DIR:-/opt/chat-room}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
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
# 先用 .backup 命令做一致性快照，再连同 room.key 一起打包。
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/chat.db" ".backup '$BACKUP_DIR/chat.db.snap'"
  DB="$BACKUP_DIR/chat.db.snap"
else
  echo "[提示] 未找到 sqlite3 命令，直接打包（数据量极小，风险低）"
  DB="$DATA_DIR/chat.db"
fi

tar -czf "$OUT" -C "$(dirname "$DB")" "$(basename "$DB")" \
  -C "$DATA_DIR" room.key 2>/dev/null \
  || tar -czf "$OUT" -C "$DATA_DIR" chat.db room.key

[ -f "$BACKUP_DIR/chat.db.snap" ] && rm -f "$BACKUP_DIR/chat.db.snap"

echo ""
echo "  备份完成 ✓"
echo "  文件: $OUT"
echo "  大小: $(du -h "$OUT" | cut -f1)"
echo ""
echo "  迁移方法（在服务器上执行）："
echo "    tar -xzf $OUT -C $DATA_DIR"
echo "    systemctl restart chat-room"
echo ""
