/** The check of a knowledge page (`verifyKnowledgePages`): a stamp and an attributed record, never a
 * change to the page's words unless a note is given; and the freshness class a page is given. */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveSlaClass } from './knowledge-verification.js';
import { KnowledgePages } from '../../test/fixtures/knowledge-pages.js';

describe('knowledge page checks', () => {
  let tmpDir: string;
  let backend: KnowledgePages;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-know-fresh-'));
    backend = new KnowledgePages({
      dbPath: join(tmpDir, 'knowledge.db'),
    });
  });

  afterEach(() => {
    backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed(slug: string, opts: { body?: string; verified_at?: string; freshness_anchor?: string; actor?: string } = {}) {
    await backend.writePage({
      slug,
      title: slug,
      domain: 'test',
      body: opts.body ?? `Body of ${slug}`,
      verified_at: opts.verified_at,
      freshness_anchor: opts.freshness_anchor,
      actor: opts.actor,
    });
  }

  // ─── writePage verified_at semantics ───────────────────────────────────────
  // ─── verifyPages ─────────────────────────────────────────────────────────────

  describe('verifyPages', () => {
    it('stamps verified_at without touching the body (single slug)', async () => {
      await seed('page', { verified_at: '2026-01-15T00:00:00.000Z' });
      const before = await backend.getPage('page');

      const result = await backend.verifyPages({ slug: 'page' });

      expect(result.verified).toBe(1);
      expect(result.slugs).toEqual(['page']);

      const after = await backend.getPage('page');
      expect(after!.body).toBe(before!.body);
      expect(after!.verified_at).not.toBe('2026-01-15T00:00:00.000Z');
      expect(new Date(after!.verified_at!).getTime()).toBeGreaterThan(
        new Date('2026-01-15T00:00:00.000Z').getTime(),
      );
    });

    it('accepts an explicit verified_at', async () => {
      await seed('page');

      await backend.verifyPages({ slug: 'page', verified_at: '2026-06-09T12:00:00.000Z' });

      const page = await backend.getPage('page');
      expect(page!.verified_at).toBe('2026-06-09T12:00:00.000Z');
    });

    it('updates freshness_anchor when given, preserves it otherwise', async () => {
      await seed('page', { freshness_anchor: 'OS 1.0' });

      await backend.verifyPages({ slug: 'page' });
      expect((await backend.getPage('page'))!.freshness_anchor).toBe('OS 1.0');

      await backend.verifyPages({ slug: 'page', freshness_anchor: 'OS 2.0' });
      expect((await backend.getPage('page'))!.freshness_anchor).toBe('OS 2.0');
    });

    it('does not bump updated on a pure stamp', async () => {
      await seed('page');
      const before = await backend.getPage('page');

      await backend.verifyPages({ slug: 'page' });

      const after = await backend.getPage('page');
      expect(after!.updated).toBe(before!.updated);
    });

    it('appends a dated verification note section and bumps updated', async () => {
      await seed('page', { body: 'Original body.' });

      const result = await backend.verifyPages({
        slug: 'page',
        verified_at: '2026-06-10T12:00:00.000Z',
        note: 'Firmware advanced to OS 2.1; claims hold.',
      });

      expect(result.noted).toBe(true);

      const page = await backend.getPage('page');
      expect(page!.body).toContain('Original body.');
      expect(page!.body).toContain('## Verification — 2026-06-10');
      expect(page!.body).toContain('Firmware advanced to OS 2.1; claims hold.');
      expect(page!.body.indexOf('Original body.')).toBeLessThan(
        page!.body.indexOf('## Verification'),
      );
    });

    it('saves the earlier body as a version before a verification note', async () => {
      await seed('page', { body: 'Original fact.' });
      await backend.verifyPages({ slug: 'page', note: 'Still true.', verifier: 'test-agent' });
      const revisions = await backend.listRevisions('page');
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ actor: 'test-agent', op: 'verify-note' });
      expect(revisions[0]).toMatchObject({ body: 'Original fact.' });
    });

    it('retains only the newest ten versions across notes and regular edits', async () => {
      await seed('page', { body: 'Original fact.' });
      for (let n = 0; n < 12; n++) await backend.verifyPages({ slug: 'page', note: `Check ${n}.` });
      const revisions = await backend.listRevisions('page');
      expect(revisions).toHaveLength(10);
      expect(revisions[0].body).toContain('Check 10.');
      expect(revisions.at(-1)!.body).toContain('Check 1.');
      const body = (await backend.getPage('page'))!.body;
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Edited fact.' });
      const edited = await backend.listRevisions('page');
      expect(edited).toHaveLength(10);
      expect(edited[0].body).toBe(body);
    });

    it('rolls back the snapshot and pruning if verification cannot commit', async () => {
      await seed('page', { body: 'Original fact.' });
      for (let n = 0; n < 10; n++) await backend.verifyPages({ slug: 'page', note: `Check ${n}.` });
      const before = await backend.getPage('page');
      const revisions = await backend.listRevisions('page');
      const db = new Database(join(tmpDir, 'knowledge.db'));
      try {
        db.exec("CREATE TRIGGER fail_verification BEFORE INSERT ON verifications BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
        await expect(backend.verifyPages({ slug: 'page', note: 'Must not survive.' })).rejects.toThrow('injected failure');
        expect(await backend.getPage('page')).toEqual(before);
        expect(await backend.listRevisions('page')).toEqual(revisions);
        expect(await backend.getVerifications('page')).toHaveLength(10);
      } finally { db.close(); }
    });

    it('stamps a batch of slugs with a shared verified_at', async () => {
      await seed('a');
      await seed('b');
      await seed('c');

      const result = await backend.verifyPages({
        slugs: ['a', 'b', 'c'],
        verified_at: '2026-06-10T12:00:00.000Z',
      });

      expect(result.verified).toBe(3);
      for (const slug of ['a', 'b', 'c']) {
        expect((await backend.getPage(slug))!.verified_at).toBe('2026-06-10T12:00:00.000Z');
      }
    });

    it('rejects the whole batch when any slug is missing (no partial stamp)', async () => {
      await seed('a', { verified_at: '2026-01-01T00:00:00.000Z' });

      await expect(
        backend.verifyPages({ slugs: ['a', 'ghost'], verified_at: '2026-06-10T12:00:00.000Z' }),
      ).rejects.toThrow(/ghost/);

      expect((await backend.getPage('a'))!.verified_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('rejects archived pages', async () => {
      await seed('page');
      await backend.archivePage({ slug: 'page' });

      await expect(backend.verifyPages({ slug: 'page' })).rejects.toThrow(/archived/);
    });

    it('rejects note and freshness_anchor in batch mode', async () => {
      await seed('a');
      await seed('b');

      await expect(
        backend.verifyPages({ slugs: ['a', 'b'], note: 'nope' }),
      ).rejects.toThrow(/batch/);
      await expect(
        backend.verifyPages({ slugs: ['a', 'b'], freshness_anchor: 'OS 9' }),
      ).rejects.toThrow(/batch/);
    });

    it('rejects when neither slug nor slugs is provided, or both', async () => {
      await seed('a');
      await expect(backend.verifyPages({})).rejects.toThrow();
      await expect(backend.verifyPages({ slug: 'a', slugs: ['a'] })).rejects.toThrow();
    });
  });

  // ─── verifications (t-675: attributed audit trail, not just a bare stamp) ──

  describe('verifications', () => {
    it('records a verification row alongside the verified_at stamp', async () => {
      await seed('page');

      await backend.verifyPages({ slug: 'page', verifier: 'mark' });

      const verifications = await backend.getVerifications('page');
      expect(verifications).toHaveLength(1);
      expect(verifications[0].verifier).toBe('mark');
      expect(verifications[0].outcome).toBe('confirmed');
      expect(verifications[0].citation_checked).toBe(false);
    });

    it('defaults outcome to confirmed and citation_checked to false when omitted', async () => {
      await seed('page');
      await backend.verifyPages({ slug: 'page' });

      const [v] = await backend.getVerifications('page');
      expect(v.verifier).toBeNull();
      expect(v.outcome).toBe('confirmed');
      expect(v.citation_checked).toBe(false);
    });

    it('records outcome and citation_checked when the verifier supplies them', async () => {
      await seed('page');
      await backend.verifyPages({
        slug: 'page',
        verifier: 'art',
        outcome: 'stale',
        citation_checked: true,
      });

      const [v] = await backend.getVerifications('page');
      expect(v.outcome).toBe('stale');
      expect(v.citation_checked).toBe(true);
    });

    // Mark's PR125 review: "stale" means "checked, and it's out of date" — a
    // failed verification. It must leave the audit row WITHOUT renewing the
    // successful-freshness stamp, or a known-wrong page sinks in the
    // stale-first queue exactly when it most needs follow-up.
    it('a stale outcome records the audit row but does not advance verified_at (single)', async () => {
      await seed('known-wrong', { body: 'Outdated claim', verified_at: '2026-01-01T00:00:00.000Z' });
      await seed('other', { verified_at: '2026-06-01T00:00:00.000Z' });

      const result = await backend.verifyPages({
        slug: 'known-wrong',
        outcome: 'stale',
        verifier: 'mark',
        verified_at: '2026-10-17T14:00:00.000Z',
      });

      expect(result.stamped).toBe(false);
      const page = await backend.getPage('known-wrong');
      expect(page!.verified_at).toBe('2026-01-01T00:00:00.000Z');
      expect(page!.body).toBe('Outdated claim');
      const [v] = await backend.getVerifications('known-wrong');
      expect(v.outcome).toBe('stale');
      expect(v.verifier).toBe('mark');
      expect(v.verified_at).toBe('2026-10-17T14:00:00.000Z');

    });

    it('a stale outcome does not advance verified_at for any page in a batch', async () => {
      await seed('a', { verified_at: '2026-01-01T00:00:00.000Z' });
      await seed('b', { verified_at: '2026-02-01T00:00:00.000Z' });

      const result = await backend.verifyPages({
        slugs: ['a', 'b'],
        outcome: 'stale',
        verifier: 'mark',
        verified_at: '2026-10-17T14:00:00.000Z',
      });

      expect(result.stamped).toBe(false);
      expect((await backend.getPage('a'))!.verified_at).toBe('2026-01-01T00:00:00.000Z');
      expect((await backend.getPage('b'))!.verified_at).toBe('2026-02-01T00:00:00.000Z');
      expect((await backend.getVerifications('a'))[0].outcome).toBe('stale');
      expect((await backend.getVerifications('b'))[0].outcome).toBe('stale');
    });

    it('a stale outcome still appends its note (the why is worth keeping)', async () => {
      await seed('page', { body: 'Outdated claim', verified_at: '2026-01-01T00:00:00.000Z' });

      const result = await backend.verifyPages({
        slug: 'page',
        outcome: 'stale',
        note: 'OS 2.0 changed this',
        verified_at: '2026-10-17T14:00:00.000Z',
      });

      expect(result.noted).toBe(true);
      const page = await backend.getPage('page');
      expect(page!.body).toContain('OS 2.0 changed this');
      expect(page!.verified_at).toBe('2026-01-01T00:00:00.000Z');
    });

    for (const outcome of ['confirmed', 'corrected'] as const) {
      it(`a ${outcome} outcome advances verified_at (single and batch)`, async () => {
        await seed('one', { verified_at: '2026-01-01T00:00:00.000Z' });
        await seed('x', { verified_at: '2026-01-01T00:00:00.000Z' });
        await seed('y', { verified_at: '2026-01-01T00:00:00.000Z' });

        const single = await backend.verifyPages({ slug: 'one', outcome, verified_at: '2026-10-17T14:00:00.000Z' });
        const batch = await backend.verifyPages({ slugs: ['x', 'y'], outcome, verified_at: '2026-10-17T14:00:00.000Z' });

        expect(single.stamped).toBe(true);
        expect(batch.stamped).toBe(true);
        for (const slug of ['one', 'x', 'y']) {
          expect((await backend.getPage(slug))!.verified_at).toBe('2026-10-17T14:00:00.000Z');
        }
      });
    }

    it('records one verification per page in batch mode', async () => {
      await seed('a');
      await seed('b');

      await backend.verifyPages({ slugs: ['a', 'b'], verifier: 'art' });

      expect(await backend.getVerifications('a')).toHaveLength(1);
      expect(await backend.getVerifications('b')).toHaveLength(1);
    });

    it('accumulates verifications across repeated calls, newest first', async () => {
      await seed('page');

      await backend.verifyPages({ slug: 'page', verifier: 'art', verified_at: '2026-01-01T00:00:00.000Z' });
      await backend.verifyPages({ slug: 'page', verifier: 'mark', verified_at: '2026-02-01T00:00:00.000Z' });

      const verifications = await backend.getVerifications('page');
      expect(verifications).toHaveLength(2);
      expect(verifications[0].verifier).toBe('mark');
      expect(verifications[1].verifier).toBe('art');
    });

    it('returns an empty list for a page that has never been verified', async () => {
      await seed('page');
      expect(await backend.getVerifications('page')).toEqual([]);
    });
  });

  // ─── getPage access stamping ────────────────────────────────────────────────

  // ─── sla_class derivation (t-434) ────────────────────────────────────────────

  describe('deriveSlaClass', () => {
    it('returns software for version-anchored pages', () => {
      expect(deriveSlaClass('Syntakt OS 1.55B', 'music/gear/elektron')).toBe('software');
      expect(deriveSlaClass('v2.1.263', 'ai/claude-code')).toBe('software');
      expect(deriveSlaClass('bd 1.2.2', 'ai/agent-orchestration')).toBe('software');
    });

    it('returns device for device-domain pages without a version anchor', () => {
      expect(deriveSlaClass('as of 2026', 'music/gear/elektron')).toBe('device');
      expect(deriveSlaClass(null, 'music/gear')).toBe('device');
      expect(deriveSlaClass(undefined, 'monitor/hardware')).toBe('device');
      expect(deriveSlaClass('2026-09-01', 'music/gear/push-3')).toBe('device');
    });

    it('returns software when version anchor is present even on a device domain (version wins)', () => {
      expect(deriveSlaClass('Push 3 OS 1.1.0', 'music/gear/ableton/push-3')).toBe('software');
    });

    it('returns default for date/year anchors outside device domains', () => {
      expect(deriveSlaClass('as of 2026', 'ai/agent-orchestration')).toBe('default');
      expect(deriveSlaClass('2026-06-11', 'music/artists')).toBe('default');
      expect(deriveSlaClass(null, 'ai/claude-code')).toBe('default');
    });
  });
});
