import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Regression for 2026-11-02 review P2-2: backup snapshots used to land at
 * 0644 while the live DB and data dir are 0600/0700 — token hashes, audit
 * IPs and the full config readable by other users on the host.
 *
 * Drives the real scripts/backup-hub.sh in BACKUP_ONCE mode against a real
 * SQLite database created in a temp dir (no mocks): asserts the snapshot is
 * a faithful copy and that its mode is 0600. Also pins that a pre-existing
 * loose-permission directory does not leak onto the new file.
 */

const SCRIPT = join(__dirname, '../../../scripts/backup-hub.sh');

function createSourceDb(path: string): void {
  execFileSync(
    process.execPath,
    [
      '--experimental-sqlite',
      '-e',
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DB); db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'real-row\')"); db.close();',
    ],
    { env: { ...process.env, DB: path } },
  );
}

function readSnapshotValue(path: string): string {
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-sqlite',
      '-e',
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DB,{open:true,readOnly:true}); process.stdout.write(String(db.prepare("SELECT v FROM t").get().v)); db.close();',
    ],
    { env: { ...process.env, DB: path } },
  );
  return out.toString('utf8');
}

describe('backup-hub.sh (BACKUP_ONCE)', () => {
  it('writes a faithful snapshot with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-backup-test-'));
    const dbPath = join(dir, 'model-hub.db');
    const backupDir = join(dir, 'backups');
    createSourceDb(dbPath);

    execFileSync('sh', [SCRIPT], {
      env: {
        ...process.env,
        BACKUP_ONCE: '1',
        HUB_DB_PATH: dbPath,
        BACKUP_DIR: backupDir,
      },
    });

    const snapshots = readdirSync(backupDir).filter((f) => f.startsWith('hub-') && f.endsWith('.db'));
    expect(snapshots).toHaveLength(1);
    const [snapshotName] = snapshots;
    if (!snapshotName) throw new Error('snapshot missing');
    const snapshot = join(backupDir, snapshotName);

    // Content is a real copy, not an empty file.
    expect(readSnapshotValue(snapshot)).toBe('real-row');

    // 0600 exactly: owner rw, nothing for group/other (mode & 0o777).
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
  });

  it('does not inherit loose permissions from the environment umask', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-backup-test-'));
    const dbPath = join(dir, 'model-hub.db');
    const backupDir = join(dir, 'backups');
    createSourceDb(dbPath);

    // Simulate a permissive caller: even under umask 000 the snapshot must be 0600.
    execFileSync('sh', ['-c', 'umask 000 && exec sh "$1"', 'sh', SCRIPT], {
      env: {
        ...process.env,
        BACKUP_ONCE: '1',
        HUB_DB_PATH: dbPath,
        BACKUP_DIR: backupDir,
      },
    });

    const snapshots = readdirSync(backupDir).filter((f) => f.startsWith('hub-'));
    const [snapshotName] = snapshots;
    if (!snapshotName) throw new Error('snapshot missing');
    expect(statSync(join(backupDir, snapshotName)).mode & 0o777).toBe(0o600);
  });
});
