#!/usr/bin/env bash
# Verifies the SQLite migration set: files are numbered with no gaps, each
# creates a table, and the created table set matches the expected schema.
# Read-only. model-hub uses SQLite only (node:sqlite).
set -euo pipefail

cd "$(dirname "$0")/.."
MIGRATION_DIR="db/migrations"

expected_tables=(
  providers
  model_overlays
  projects
  tokens
  assignments
  usage_events
  health_checks
  admin_audit
)

fail=0

files=$(find "$MIGRATION_DIR" -maxdepth 1 -name '*.sql' -exec basename {} \; | sort)
file_count=$(printf '%s\n' "$files" | grep -c '\.sql' || true)

# 1. Sequential numbering NNN starting at 001 with no gaps.
expected_number=1
while IFS= read -r file; do
  number=$(printf '%s' "$file" | grep -oE '^[0-9]{3}' || true)
  wanted=$(printf '%03d' "$expected_number")
  if [ "$number" != "$wanted" ]; then
    echo "FAIL: expected migration number $wanted, got '$file'"
    fail=1
  fi
  expected_number=$((expected_number + 1))
done <<< "$files"

# 2. Each file creates a table with IF NOT EXISTS.
while IFS= read -r file; do
  if ! grep -q 'CREATE TABLE IF NOT EXISTS' "$MIGRATION_DIR/$file"; then
    echo "FAIL: $file has no 'CREATE TABLE IF NOT EXISTS'"
    fail=1
  fi
done <<< "$files"

# 3. Created table set matches the expected tables.
created_tables=$(
  grep -hoE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$MIGRATION_DIR"/*.sql \
    | awk '{print $NF}' | sort
)
expected_sorted=$(printf '%s\n' "${expected_tables[@]}" | sort)
if [ "$created_tables" != "$expected_sorted" ]; then
  echo "FAIL: created table set does not match expected"
  diff <(printf '%s' "$expected_sorted") <(printf '%s' "$created_tables") || true
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: sqlite migrations ($file_count files, table set verified)"
