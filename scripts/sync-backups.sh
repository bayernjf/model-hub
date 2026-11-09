#!/bin/sh
# Mirror model-hub snapshots to a second location on the host.
#
# Deliberately runs outside Docker. On 2026-11-09 mounting ~/Downloads into the
# backup container hung Docker Desktop's file sharing (macOS protects that
# folder), which wedged the daemon and took every container on the machine down
# with it. A host-side copy cannot do that.
#
# Incremental by design: files are only added or updated, never deleted, so a
# snapshot that aged out of the container's retention window survives here.
set -u

SRC=${BACKUP_SRC:-$HOME/000mycodes/model-hub/backups}
DST=${BACKUP_DST:-$HOME/Downloads/model-hub-backups}

[ -d "$SRC" ] || exit 0
mkdir -p "$DST" || exit 0

/usr/bin/rsync -a "$SRC"/ "$DST"/ || exit 0
