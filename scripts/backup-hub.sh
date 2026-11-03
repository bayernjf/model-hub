#!/bin/sh
# model-hub SQLite backup loop (tech doc §11: cron 定期复制数据卷).
# Run as a compose sidecar: reads the live DB read-only, writes a consistent
# .backup snapshot to /backups, prunes beyond RETENTION_DAYS.
#
# Snapshots hold envelope ciphertext, project-token hashes and the full
# config — same sensitivity class as the live DB, so they are written 0600
# (2026-11-02 review P2-2). umask 077 covers anything else this script ever
# creates; the explicit chmod pins the snapshot itself.
set -eu
umask 077

DB_PATH="${HUB_DB_PATH:-/data/model-hub.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

backup_once() {
  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT="$BACKUP_DIR/hub-$STAMP.db"
  # VACUUM INTO produces a consistent snapshot (node:sqlite; no sqlite3 CLI needed).
  DB_PATH="$DB_PATH" OUT="$OUT" node --experimental-sqlite -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DB_PATH); db.exec("VACUUM INTO \x27"+process.env.OUT+"\x27"); db.close();'
  chmod 600 "$OUT"
  # Prune old snapshots (matches semantics of loom infra/backup/backup.sh).
  find "$BACKUP_DIR" -name 'hub-*.db' -type f -mtime "+$RETENTION_DAYS" -delete
  echo "[$(date -Iseconds)] wrote $OUT (kept last $RETENTION_DAYS days)"
}

# BACKUP_ONCE=1 runs a single backup and exits — used by the regression test
# and by ad-hoc manual snapshots; the sidecar path (no env) loops forever.
if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  backup_once
  exit 0
fi

while true; do
  backup_once
  sleep "$INTERVAL"
done
