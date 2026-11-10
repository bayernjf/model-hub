#!/bin/sh
# Keep the local model-hub console up across reboots.
#
# This machine has no "start Docker at login" toggle set, so a LaunchAgent runs
# this instead: bring Docker up, wait for the daemon socket, then start the
# compose stack. Idempotent — running it while everything is already up is a
# no-op, which also makes it safe to run by hand after a Dock restart.
set -u

DOCKER=/usr/local/bin/docker
REPO_DIR=${MODEL_HUB_DIR:-/Users/jiangfeng/000mycodes/model-hub}

[ -x "$DOCKER" ] || exit 0
[ -d "$REPO_DIR" ] || exit 0

# macOS local dev runs OrbStack only; Docker Desktop is retired (2026-11-10).
if ! pgrep -f '/Applications/OrbStack.app' >/dev/null 2>&1; then
  open -a OrbStack
fi

# OrbStack hands over the socket late on a cold login, same as Docker Desktop
# did. Wait up to two minutes, then exit quietly: a machine that is still
# booting should not fail the agent, and `restart: unless-stopped` covers the
# container from there.
i=0
while [ "$i" -lt 60 ]; do
  "$DOCKER" info >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 2
done
[ "$i" -lt 60 ] || exit 0

cd "$REPO_DIR" || exit 0
"$DOCKER" compose up -d
