/**
 * Capture-propose queue tests.
 *
 * The load-bearing assertion is the INTEGRITY INVARIANT: a proposal is NOT
 * authored canon. It must be invisible to recall / memory_list / find_similar /
 * the salience digest until an explicit ratify commits it through remember().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  propose,
  listProposals,
  getProposal,
  rejectProposal,
  ratifyProposal,
  UnknownProposalError,
} from './proposals.js';
import { remember } from '../tools/remember.js';
import { recall } from '../tools/recall.js';
import { memoryList } from '../tools/memory-list.js';
import { closeAllBackends } from './index.js';

describe('proposals — capture-propose queue', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-proposals-'));
  });
  afterEach(async () => {
    closeAllBackends();
    await rm(dir, { recursive: true, force: true });
  });

  describe('propose + list', () => {
    it('stages a pending proposal that listProposals returns', () => {
      const ref = propose(dir, {
        category: 'project',
        title: 'Draft idea',
        content: 'A rough thought worth keeping.',
        source: 'capture-lane',
      });
      expect(ref.id).toBeGreaterThan(0);
      expect(ref.uuid).toMatch(/^[0-9a-f-]{36}$/);

      const rows = listProposals(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(ref.id);
      expect(rows[0].title).toBe('Draft idea');
      expect(rows[0].category).toBe('project');
      expect(rows[0].source).toBe('capture-lane');
      expect(rows[0].status).toBe('pending');
    });

    it('lists newest first', () => {
      propose(dir, { category: 'self', title: 'first', content: 'one' });
      propose(dir, { category: 'self', title: 'second', content: 'two' });
      const rows = listProposals(dir);
      expect(rows.map((r) => r.title)).toEqual(['second', 'first']);
    });

    it('requires non-empty title, content, and category', () => {
      expect(() => propose(dir, { category: 'self', title: '', content: 'x' })).toThrow(/title/);
      expect(() => propose(dir, { category: 'self', title: 'x', content: '  ' })).toThrow(/content/);
      expect(() => propose(dir, { category: '', title: 'x', content: 'y' })).toThrow(/category/);
    });

    it('getProposal fetches by id and returns null for unknown', () => {
      const ref = propose(dir, { category: 'reference', title: 't', content: 'c' });
      expect(getProposal(dir, ref.id)?.title).toBe('t');
      expect(getProposal(dir, 99999)).toBeNull();
    });
  });

  describe('INTEGRITY INVARIANT — proposals are invisible to memory', () => {
    it('a proposed draft does NOT appear in recall or memory_list; a real memory does', async () => {
      // One REAL authored memory, one PROPOSED draft — same distinctive token so
      // a semantic recall would surface either if both were stored as memories.
      await remember(dir, {
        category: 'project',
        title: 'Canon fact',
        content: 'The widget uses zorblax compression.',
      });
      propose(dir, {
        category: 'project',
        title: 'Proposed fact',
        content: 'The widget also supports zorblax streaming.',
        source: 'lane',
      });

      // recall surfaces only the real memory
      const recalled = await recall(dir, { query: 'zorblax', limit: 10 });
      expect(recalled).toContain('Canon fact');
      expect(recalled).not.toContain('Proposed fact');

      // memory_list surfaces only the real memory
      const listed = await memoryList(dir, { limit: 50 });
      expect(listed).toContain('Canon fact');
      expect(listed).not.toContain('Proposed fact');

      // but the proposal is alive in its own queue
      expect(listProposals(dir).map((r) => r.title)).toEqual(['Proposed fact']);
    });

    it('proposals live in a separate table, not in memories', async () => {
      // One real memory (creates the memories table), one staged proposal.
      await remember(dir, { category: 'self', title: 'real', content: 'authored' });
      propose(dir, { category: 'self', title: 'staged', content: 'body' });
      const db = new BetterSqlite3(join(dir, 'memories.db'), { readonly: true });
      const memCount = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
      const propCount = (db.prepare('SELECT COUNT(*) AS c FROM proposals').get() as { c: number }).c;
      db.close();
      expect(memCount).toBe(1);
      expect(propCount).toBe(1);
    });
  });

  describe('ratify', () => {
    it('commits via remember (becomes recallable) and removes the proposal', async () => {
      const ref = propose(dir, {
        category: 'project',
        title: 'Promote me',
        content: 'The flux capacitor needs 1.21 gigawatts.',
      });

      const memRef = await ratifyProposal(dir, ref.id);
      expect(memRef.ref).toMatch(/^project\//);

      // proposal is gone from the queue
      expect(listProposals(dir)).toHaveLength(0);
      expect(getProposal(dir, ref.id)).toBeNull();

      // memory is now recallable
      const recalled = await recall(dir, { query: 'gigawatts', limit: 10 });
      expect(recalled).toContain('Promote me');
    });

    it('applies overrides on accept', async () => {
      const ref = propose(dir, {
        category: 'self',
        title: 'rough title',
        content: 'rough content',
        project: 'old',
      });

      const memRef = await ratifyProposal(dir, ref.id, {
        title: 'polished title',
        content: 'polished content about quokkas',
        category: 'reference',
        project: 'new',
      });
      expect(memRef.category).toBe('reference');
      expect(memRef.title).toBe('polished title');

      const listed = await memoryList(dir, { limit: 50 });
      expect(listed).toContain('polished title');
      expect(listed).not.toContain('rough title');

      const recalled = await recall(dir, { query: 'quokkas', limit: 10 });
      expect(recalled).toContain('polished content about quokkas');
    });

    it('throws UnknownProposalError for an unknown id', async () => {
      await expect(ratifyProposal(dir, 4242)).rejects.toBeInstanceOf(UnknownProposalError);
    });

    it('refuses an INVALID proposal (empty content) and leaves it pending', async () => {
      // Force a bad row past the soft propose() guard by writing directly, so the
      // hard validation only fires at ratify time (through validateMemoryInput).
      propose(dir, { category: 'self', title: 'placeholder', content: 'placeholder' });
      const db = new BetterSqlite3(join(dir, 'memories.db'));
      db.pragma('busy_timeout = 0');
      const row = db
        .prepare("SELECT id FROM proposals WHERE status = 'pending'")
        .get() as { id: number };
      db.prepare("UPDATE proposals SET content = '' WHERE id = ?").run(row.id);
      db.close();

      await expect(ratifyProposal(dir, row.id)).rejects.toThrow(/content/);

      // still pending — nothing committed
      const stillThere = getProposal(dir, row.id);
      expect(stillThere?.status).toBe('pending');
      expect(listProposals(dir).map((r) => r.id)).toContain(row.id);

      // and no memory was authored
      const listed = await memoryList(dir, { limit: 50 });
      expect(listed).toContain('No memories found');
    });
  });

  describe('reject', () => {
    it('removes a pending proposal and returns true', () => {
      const ref = propose(dir, { category: 'self', title: 'discard me', content: 'x' });
      expect(rejectProposal(dir, ref.id)).toBe(true);
      expect(listProposals(dir)).toHaveLength(0);
    });

    it('returns false for an unknown id', () => {
      expect(rejectProposal(dir, 12345)).toBe(false);
    });
  });

  describe('self-heal', () => {
    it('listProposals returns [] when no store exists yet', () => {
      expect(listProposals(dir)).toEqual([]);
    });
  });
});
