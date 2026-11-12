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

it('retains provider-wide domains as well as individual type domains', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-provider-hint-outbox-'));
  try {
    withLog(home, db => domainOf(db, 'tasks/*', 'tasks'));
    persistHints(home, new Map([['tasks/*', new Set(['*'])]]));
    withLog(home, db => { consumeHintOutbox(home, db); expect(refreshRequest(db, 'tasks/*').through).toBeGreaterThan(0); });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('imports all bounded domains rather than starving the tail behind hot domains', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-domain-hint-outbox-'));
  try {
    const hints = new Map(Array.from({ length: 40 }, (_, i) => [`loom/type-${i}`, new Set(['*'])]));
    withLog(home, db => { for (const domain of hints.keys()) domainOf(db, domain, 'loom'); });
    persistHints(home, hints);
    withLog(home, db => {
      consumeHintOutbox(home, db);
      for (const domain of hints.keys()) expect(refreshRequest(db, domain).through).toBeGreaterThan(0);
    });
    expect(readdirSync(join(home, 'collections', 'hint-outbox'))).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
