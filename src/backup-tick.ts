/**
 * The daemon's side of the nightly backup (src/backup.ts): start `loom backup tick` as a detached child, so a
 * backup's minutes (and any crash in one) never touch a listener. Only when the household has a backup set; the
 * child takes the run lock, so three listeners starting three ticks run one backup.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { backupDir, readSettings } from './backup.js';
import type { Household } from './household.js';

/** dist/index.js (this file is dist/backup-tick.js once built). */
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

export function spawnBackupTick(h: Household, env: NodeJS.ProcessEnv, o: { spawnImpl?: typeof spawn; entry?: string } = {}): boolean {
  try {
    const { settings, problem } = readSettings(h);
    if (!settings && !problem) return false;
    // Its last words, for when a tick fails before it records anything: backup/tick.log, appended (three listeners
    // share it), started over past a megabyte.
    mkdirSync(backupDir(h.home), { recursive: true, mode: 0o700 });
    const path = join(backupDir(h.home), 'tick.log');
    let big = false;
    try { big = statSync(path).size > 1024 * 1024; } catch { /* none yet */ }
    const log = openSync(path, big ? 'w' : 'a', 0o600);
    try {
      const child = (o.spawnImpl ?? spawn)(process.execPath, [o.entry ?? ENTRY, 'backup', 'tick'], {
        detached: true, stdio: ['ignore', log, log], env: { ...env, LOOM_HOME: h.home },
      });
      child.on('error', () => {});
      child.unref();
    } finally { closeSync(log); }
    return true;
  } catch { return false; }
}
