#!/bin/sh
# model-hub SQLite backup loop (tech doc §11: cron 定期复制数据卷).
# Run as a compose sidecar: reads the live DB read-only, writes a consistent
# .backup snapshot to /backups, prunes beyond RETENTION_DAYS.
set -eu

DB_PATH="${HUB_DB_PATH:-/data/model-hub.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

while true; do
  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT="$BACKUP_DIR/hub-$STAMP.db"
  # VACUUM INTO produces a consistent snapshot (node:sqlite; no sqlite3 CLI needed).
  DB_PATH="$DB_PATH" OUT="$OUT" node --experimental-sqlite -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DB_PATH); db.exec("VACUUM INTO \x27"+process.env.OUT+"\x27"); db.close();'
  # Prune old snapshots (matches semantics of loom infra/backup/backup.sh).
  find "$BACKUP_DIR" -name 'hub-*.db' -type f -mtime "+$RETENTION_DAYS" -delete
  echo "[$(date -Iseconds)] wrote $OUT (kept last $RETENTION_DAYS days)"
  sleep "$INTERVAL"
done
