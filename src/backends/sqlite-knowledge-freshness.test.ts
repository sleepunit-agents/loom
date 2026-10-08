/**
 * Freshness + body-history backend tests:
 *   - verifyPages: stamp-only verification (the missing primitive whose
 *     absence caused the 2026-06-01 body-stomp incident)
 *   - writePage verified_at preservation on update
 *   - queryPages sortByVerified (stale-first ordering for the verify role)
 *   - page_revisions: body snapshots on replace-writes, history read/restore
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKnowledgeBackend, deriveSlaClass } from './sqlite-knowledge.js';

describe('SqliteKnowledgeBackend — verify / freshness / revisions', () => {
  let tmpDir: string;
  let backend: SqliteKnowledgeBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-know-fresh-'));
    backend = new SqliteKnowledgeBackend({
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

  describe('writePage verified_at preservation', () => {
    it('preserves existing verified_at on update when not explicitly provided', async () => {
      await seed('page', { verified_at: '2026-01-15T00:00:00.000Z' });

      await backend.writePage({
        slug: 'page',
        title: 'page',
        domain: 'test',
        body: 'Appended note',
        bodyMode: 'append',
      });

      const page = await backend.getPage('page');
      expect(page!.verified_at).toBe('2026-01-15T00:00:00.000Z');
    });

    it('moves verified_at on update when explicitly provided', async () => {
      await seed('page', { verified_at: '2026-01-15T00:00:00.000Z' });

      await backend.writePage({
        slug: 'page',
        title: 'page',
        domain: 'test',
        body: 'Rewritten body',
        verified_at: '2026-06-10T00:00:00.000Z',
      });

      const page = await backend.getPage('page');
      expect(page!.verified_at).toBe('2026-06-10T00:00:00.000Z');
    });

    it('still stamps verified_at at write time on create', async () => {
      await seed('page');
      const page = await backend.getPage('page');
      expect(page!.verified_at).not.toBeNull();
    });
  });

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

    it('rejects getVerifications for an unknown page', async () => {
      await expect(backend.getVerifications('ghost')).rejects.toThrow(/not found/);
    });

    it('returns an empty list for a page that has never been verified', async () => {
      await seed('page');
      expect(await backend.getVerifications('page')).toEqual([]);
    });
  });

  // ─── getPage access stamping ────────────────────────────────────────────────

  describe('getPage stampAccess', () => {
    it('does not stamp access by default', async () => {
      await seed('page');
      await backend.getPage('page');

      const page = await backend.getPage('page');
      expect(page!.hit_count).toBe(0);
      expect(page!.last_accessed).toBeNull();
    });

    it('stamps last_accessed and hit_count when stampAccess is true', async () => {
      await seed('page');
      await backend.getPage('page', { stampAccess: true });

      const page = await backend.getPage('page');
      expect(page!.hit_count).toBe(1);
      expect(page!.last_accessed).not.toBeNull();
    });
  });

  // ─── queryPages sortByVerified ──────────────────────────────────────────────

  describe('queryPages sortByVerified', () => {
    it('orders verified_at ASC with never-verified first', async () => {
      await seed('newest', { verified_at: '2026-06-01T00:00:00.000Z' });
      await seed('oldest', { verified_at: '2025-01-01T00:00:00.000Z' });
      await seed('middle', { verified_at: '2026-01-01T00:00:00.000Z' });
      await seed('never');
      // Null out verified_at to simulate a legacy/never-verified row.
      const raw = backend['ensureOpen']();
      raw.prepare('UPDATE pages SET verified_at = NULL WHERE slug = ?').run('never');

      const pages = await backend.queryPages({
        sortByVerified: true,
        stampAccess: false,
        excludeStatus: 'archived',
      });

      expect(pages.map((p) => p.slug)).toEqual(['never', 'oldest', 'middle', 'newest']);
    });

    it('applies stale-first ordering under a query filter too', async () => {
      await seed('alpha-fresh', { body: 'elektron page', verified_at: '2026-06-01T00:00:00.000Z' });
      await seed('alpha-stale', { body: 'elektron page', verified_at: '2025-06-01T00:00:00.000Z' });
      await seed('unrelated', { body: 'nothing here', verified_at: '2024-01-01T00:00:00.000Z' });

      const pages = await backend.queryPages({
        query: 'elektron',
        sortByVerified: true,
        stampAccess: false,
      });

      expect(pages.map((p) => p.slug)).toEqual(['alpha-stale', 'alpha-fresh']);
    });
  });

  // ─── page_revisions ─────────────────────────────────────────────────────────

  describe('page revisions', () => {
    it('snapshots the old body on a replace-write', async () => {
      await seed('page', { body: 'Version one.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Version two.' });

      const revisions = await backend.listRevisions('page');
      expect(revisions).toHaveLength(1);
      expect(revisions[0].op).toBe('write-replace');

      const rev = await backend.getRevision(revisions[0].id);
      expect(rev!.body).toBe('Version one.');
    });

    it('does not snapshot on append writes', async () => {
      await seed('page', { body: 'Version one.' });
      await backend.writePage({
        slug: 'page', title: 'page', domain: 'test', body: 'More.', bodyMode: 'append',
      });

      expect(await backend.listRevisions('page')).toHaveLength(0);
    });

    it('does not snapshot when the replacement body is identical', async () => {
      await seed('page', { body: 'Same.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Same.' });

      expect(await backend.listRevisions('page')).toHaveLength(0);
    });

    it('does not snapshot on create', async () => {
      await seed('page');
      expect(await backend.listRevisions('page')).toHaveLength(0);
    });

    it('lists revisions newest-first with body_length but without full bodies', async () => {
      await seed('page', { body: 'One.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Two.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Three.' });

      const revisions = await backend.listRevisions('page');
      expect(revisions).toHaveLength(2);
      // Newest snapshot first: the body that was replaced most recently.
      expect(revisions[0].body_length).toBe('Two.'.length);
      expect(revisions[1].body_length).toBe('One.'.length);
      expect((revisions[0] as Record<string, unknown>).body).toBeUndefined();
    });

    it('restores a revision and snapshots the pre-restore body', async () => {
      await seed('page', { body: 'Good body.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Stomped body.' });

      const revisions = await backend.listRevisions('page');
      const result = await backend.restoreRevision({ slug: 'page', revision_id: revisions[0].id });
      expect(result.restored).toBe(true);

      const page = await backend.getPage('page');
      expect(page!.body).toBe('Good body.');

      // The stomped body is itself preserved as a new revision.
      const after = await backend.listRevisions('page');
      expect(after[0].op).toBe('history-restore');
      expect((await backend.getRevision(after[0].id))!.body).toBe('Stomped body.');
    });

    it('rejects restoring a revision that belongs to another page', async () => {
      await seed('a', { body: 'A one.' });
      await backend.writePage({ slug: 'a', title: 'a', domain: 'test', body: 'A two.' });
      await seed('b', { body: 'B one.' });

      const revisions = await backend.listRevisions('a');
      await expect(
        backend.restoreRevision({ slug: 'b', revision_id: revisions[0].id }),
      ).rejects.toThrow();
    });

    it('caps revisions per page, pruning the oldest', async () => {
      await seed('page', { body: 'v0' });
      for (let i = 1; i <= 12; i++) {
        await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: `v${i}` });
      }

      const revisions = await backend.listRevisions('page');
      expect(revisions.length).toBe(10);
      // Oldest surviving snapshot is v2 (v0 and v1 pruned).
      const oldest = await backend.getRevision(revisions[revisions.length - 1].id);
      expect(oldest!.body).toBe('v2');
    });

    it('purging a page cascades its revisions', async () => {
      await seed('page', { body: 'One.' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'Two.' });
      await backend.archivePage({ slug: 'page' });
      await backend.purgePages({ slugs: ['page'], confirm: true });

      const raw = backend['ensureOpen']();
      const rows = raw.prepare('SELECT COUNT(*) AS n FROM page_revisions').get() as { n: number };
      expect(rows.n).toBe(0);
    });

    it('survives a slug rename — revisions follow the page, not the slug', async () => {
      await seed('old-slug', { body: 'One.' });
      await backend.writePage({ slug: 'old-slug', title: 'old-slug', domain: 'test', body: 'Two.' });
      await backend.movePage({ slug: 'old-slug', new_slug: 'new-slug', leave_pointer: false });

      const revisions = await backend.listRevisions('new-slug');
      expect(revisions).toHaveLength(1);
      expect((await backend.getRevision(revisions[0].id))!.body).toBe('One.');
    });
  });

  // ─── actor attribution (t-675) ──────────────────────────────────────────────

  describe('actor attribution', () => {
    it('stamps pages.author from the creating call, and never changes it on upsert', async () => {
      await seed('page', { actor: 'art' });
      expect((await backend.getPage('page'))!.author).toBe('art');

      // A later update by a different identity must not steal authorship.
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'v2', actor: 'mark' });
      expect((await backend.getPage('page'))!.author).toBe('art');
    });

    it('leaves author null when the creating call omits actor', async () => {
      await seed('page');
      expect((await backend.getPage('page'))!.author).toBeNull();
    });

    it('records the acting identity on a write-replace snapshot', async () => {
      await seed('page', { body: 'v1', actor: 'art' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'v2', actor: 'mark' });

      const [revision] = await backend.listRevisions('page');
      expect(revision.actor).toBe('mark');
    });

    it('records the acting identity on a history-restore snapshot', async () => {
      await seed('page', { body: 'v1', actor: 'art' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'v2', actor: 'art' });

      const [toRestore] = await backend.listRevisions('page');
      await backend.restoreRevision({ slug: 'page', revision_id: toRestore.id, actor: 'mark' });

      const [newestSnapshot] = await backend.listRevisions('page');
      expect(newestSnapshot.op).toBe('history-restore');
      expect(newestSnapshot.actor).toBe('mark');
    });

    it('leaves revision actor null when the call omits it', async () => {
      await seed('page', { body: 'v1' });
      await backend.writePage({ slug: 'page', title: 'page', domain: 'test', body: 'v2' });

      const [revision] = await backend.listRevisions('page');
      expect(revision.actor).toBeNull();
    });
  });

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

  describe('sla_class persistence', () => {
    it('stores the derived sla_class on create', async () => {
      await backend.writePage({
        slug: 'version-page',
        title: 'version-page',
        domain: 'music/gear/elektron',
        body: 'body',
        freshness_anchor: 'Syntakt OS 1.55B',
      });
      expect((await backend.getPage('version-page'))!.sla_class).toBe('software');
    });

    it('stores device class for device-domain page without version anchor', async () => {
      await backend.writePage({
        slug: 'gear-page',
        title: 'gear-page',
        domain: 'music/gear/elektron',
        body: 'body',
        freshness_anchor: 'as of 2026',
      });
      expect((await backend.getPage('gear-page'))!.sla_class).toBe('device');
    });

    it('defaults to default class', async () => {
      await seed('plain');
      expect((await backend.getPage('plain'))!.sla_class).toBe('default');
    });

    it('re-derives sla_class when freshness_anchor changes on writePage', async () => {
      await backend.writePage({
        slug: 'changing',
        title: 'changing',
        domain: 'ai/agent-orchestration',
        body: 'body',
        freshness_anchor: 'as of 2026',
      });
      expect((await backend.getPage('changing'))!.sla_class).toBe('default');

      await backend.writePage({
        slug: 'changing',
        title: 'changing',
        domain: 'ai/agent-orchestration',
        body: 'body',
        freshness_anchor: 'bd 1.2.2',
      });
      expect((await backend.getPage('changing'))!.sla_class).toBe('software');
    });

    it('accepts an explicit sla_class override', async () => {
      await backend.writePage({
        slug: 'override',
        title: 'override',
        domain: 'music/artists',
        body: 'body',
        freshness_anchor: 'as of 2026',
        sla_class: 'device',
      });
      expect((await backend.getPage('override'))!.sla_class).toBe('device');
    });

    it('re-derives sla_class when freshness_anchor changes on verifyPages', async () => {
      await backend.writePage({
        slug: 'verify-anchor',
        title: 'verify-anchor',
        domain: 'ai/agent-orchestration',
        body: 'body',
        freshness_anchor: 'as of 2026',
      });
      expect((await backend.getPage('verify-anchor'))!.sla_class).toBe('default');

      await backend.verifyPages({ slug: 'verify-anchor', freshness_anchor: 'v1.2.0' });
      expect((await backend.getPage('verify-anchor'))!.sla_class).toBe('software');
    });
  });
});
