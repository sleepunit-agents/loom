/** Value-free hints that must survive their producer while live.db has another writer. */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { markNudged } from './log.js';

export function persistHints(home: string, hints: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (!hints.size) return;
  const dir = join(home, 'collections', 'hint-outbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, randomUUID());
  writeFileSync(`${path}.tmp`, JSON.stringify([...hints].map(([domain, keys]) => [domain, [...keys]])), { mode: 0o600 });
  renameSync(`${path}.tmp`, `${path}.json`);
}

/** Only the lifetime owner calls this. Commit before deleting: a crash may replay a hint, never lose it. */
export function consumeHintOutbox(home: string, db: Database): void {
  const dir = join(home, 'collections', 'hint-outbox');
  let files: string[];
  try { files = readdirSync(dir).filter(f => /^[a-f0-9-]+\.json$/.test(f)).slice(0, 32); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  for (const file of files) {
    const path = join(dir, file);
    const hints = JSON.parse(readFileSync(path, 'utf8')) as Array<[string, string[]]>;
    db.transaction(() => {
      for (const [domain, keys] of hints) for (const key of keys) markNudged(db, domain, Date.now(), key);
    }).immediate();
    unlinkSync(path);
  }
}
