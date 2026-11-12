import { it, expect } from 'vitest';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistHints, consumeHintOutbox } from './hint-outbox.js';
import { domainOf, refreshRequest, withLog } from './log.js';

it('bounds repeated publications and replays a dead owner without swallowing newer hints', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-hint-outbox-'));
  const dir = join(home, 'collections', 'hint-outbox');
  const hints = new Map([['loom/project', new Set(['private-key'])]]);
  try {
    withLog(home, db => domainOf(db, 'loom/project', 'loom'));
    for (let i = 0; i < 1000; i++) persistHints(home, hints);
    expect(readdirSync(dir)).toEqual(['loom.project.pending']);
    // A killed owner claimed the previous hint; new producer publications must survive independently.
    renameSync(join(dir, 'loom.project.pending'), join(dir, 'loom.project.processing'));
    for (let i = 0; i < 1000; i++) persistHints(home, hints);
    expect(readdirSync(dir).sort()).toEqual(['loom.project.pending', 'loom.project.processing']);
    withLog(home, db => {
      consumeHintOutbox(home, db);
      const first = refreshRequest(db, 'loom/project').through;
      expect(first).toBeGreaterThan(0); expect(readdirSync(dir)).toEqual(['loom.project.pending']);
      consumeHintOutbox(home, db);
      expect(refreshRequest(db, 'loom/project').through).toBeGreaterThan(first);
      expect(refreshRequest(db, 'loom/project').keys).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
