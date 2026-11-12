/** Value-free broad hints that survive their producer while live.db has another writer. */
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { markNudged } from './log.js';

const NAME = /^([a-z][a-z0-9-]{0,39})\.([a-z][a-z0-9-]{0,31}|\*)\.(pending|processing)$/;
export function persistHints(home: string, hints: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (!hints.size) return;
  const dir = join(home, 'collections', 'hint-outbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const domain of hints.keys()) {
    const name = `${domain.replace('/', '.')}.pending`;
    if (!NAME.test(name)) continue;
    // Existence is the entire value. Exclusive creation coalesces without a read/overwrite race with the owner.
    try { closeSync(openSync(join(dir, name), 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

/** Only the lifetime owner calls this. Claim before computing, commit before removing; producer writes stay pending. */
export function consumeHintOutbox(home: string, db: Database, initialize?: (domain: string) => void): void {
  const dir = join(home, 'collections', 'hint-outbox');
  let files: string[];
  try { files = readdirSync(dir).filter(f => NAME.test(f)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  // At most one pending and one claimed marker per installed domain, even with a dead producer/owner.
  for (const base of [...new Set(files.map(f => f.replace(/\.(pending|processing)$/, '')))]) {
    const claimed = `${base}.processing`;
    if (!files.includes(claimed)) {
      try { renameSync(join(dir, `${base}.pending`), join(dir, claimed)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    }
    const domain = base.replace('.', '/');
    db.transaction(() => { initialize?.(domain); markNudged(db, domain); }).immediate();
    unlinkSync(join(dir, claimed));
  }
}
