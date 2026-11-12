import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { movesAfter } from './comms.js';

it('orders committed thread moves across scans even when their timestamps are equal or go backwards', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-sequence-'));
  const db = new Database(join(home, 'household.db'));
  try {
    movesAfter(home, 0);
    const insert = db.prepare(`INSERT INTO comms_threads (id,agent,member,conversation,opened,last,channel,first_id,first_hash,updated)
      VALUES (?, 'art', ?, ?, 'now', 'now', 1, ?, 'hash', 123)`);
    insert.run('a', 'alice', 'a', 'a');
    const first = movesAfter(home, 0); expect(first.map(m => m.member)).toEqual(['alice']);
    insert.run('b', 'bob', 'b', 'b');
    const second = movesAfter(home, first[0].seq); expect(second.map(m => m.member)).toEqual(['bob']);
    db.prepare('UPDATE comms_threads SET updated = 122 WHERE id = ?').run('a');
    const third = movesAfter(home, second[0].seq); expect(third.map(m => m.member)).toEqual(['alice']);
    db.prepare('UPDATE comms_threads SET updated = 122 WHERE id = ?').run('a');
    expect(movesAfter(home, third[0].seq).map(m => m.member)).toEqual(['alice']);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
