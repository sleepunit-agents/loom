/**
 * Project section feeds through the hub (src/project-feeds.ts wired into
 * projectHubOf): acceptance criteria 10 and 11 of docs/specs/projects.md,
 * against stub managed pieces laid down as the installer leaves them (a
 * piece.json under $LOOM_HOME/pieces/<name>/, its bins in pieces/bin), as
 * src/offers-registry.test.ts does.
 *
 * Each output rule and each install-time declaration rule has its own case in
 * src/offers.test.ts (parseFeed, parseLoomBlock); here they are shown to reach
 * the hub: an answer a rule refuses is that piece's `{key, error}`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllBackends } from './backends/index.js';
import { openProjectsStore, type ProjectWriteInput } from './backends/projects.js';
import { remember } from './tools/remember.js';
import { projectHubOf, type HubSection } from './tools/project.js';
import { clearPieceCache } from './ui/pieces.js';
import { feedArgs, feedSince, managedPieceSections, unfiledSections } from './project-feeds.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T15:00:00.250Z');
const GOOD = '{"groups":[{"title":"Ready","items":[{"title":"one","ref":"t-1","status":"open"}]}]}';

describe('project section feeds (criteria 10-11)', () => {
  let tmp: string;
  let ctx: string;
  let env: Record<string, string>;

  async function piece(name: string, loom: Record<string, unknown>, bins: Record<string, string>) {
    const root = join(tmp, 'pieces');
    await mkdir(join(root, name), { recursive: true });
    await mkdir(join(root, 'bin'), { recursive: true });
    for (const [b, body] of Object.entries(bins)) {
      await writeFile(join(root, 'bin', b), `#!/bin/sh\n${body}\n`);
      await chmod(join(root, 'bin', b), 0o755);
    }
    await writeFile(join(root, name, 'piece.json'), JSON.stringify({
      v: 1, name, source: { repo: 'o/r', commit: '1'.repeat(40) }, package: name, version: '1.0.0', installed: '', bins: Object.keys(bins),
      loom: { settings: [{ name: 'FEED_GREETING', label: 'Greeting', kind: 'text', required: false, default: 'hello' }], services: [], ...loom },
    }));
  }
  const feedOf = (bin: string, extra: Record<string, unknown> = {}) => ({ sections: { project: { label: 'Tasks', argv: [bin, 'project-feed', '--json'], ...extra } } });
  /** A feed that writes its argv and environment to `seen`, then answers `answer`. */
  const recording = (seen: string, answer = GOOD) =>
    `printf '%s\\n' "$@" > ${seen}; echo "name=$LOOM_PIECE_NAME greeting=$FEED_GREETING" >> ${seen}; echo '${answer}'`;

  const write = (input: ProjectWriteInput) => {
    const s = openProjectsStore(ctx, { now: () => NOW })!;
    try { s.write(input); } finally { s.close(); }
  };
  const hub = (slug: string, extra: { since?: string; include_archived?: boolean } = {}) =>
    projectHubOf(ctx, { slug, ...extra }, { nowMs: NOW, pieceSections: managedPieceSections(env) });
  const sections = async (slug: string, extra: { since?: string; include_archived?: boolean } = {}) => {
    const r = await hub(slug, extra);
    if (!('sections' in r)) throw new Error(`no sections: ${JSON.stringify(r)}`);
    return r.sections;
  };
  const pieceSections = (ss: HubSection[]) => ss.filter((s) => s.key.startsWith('piece:'));

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-feeds-'));
    ctx = join(tmp, 'agent');
    await mkdir(ctx);
    env = { LOOM_HOME: tmp, PATH: '/usr/bin:/bin' };
    clearPieceCache();
  });
  afterEach(async () => {
    closeAllBackends();
    await rm(tmp, { recursive: true, force: true });
  });

  describe('10. a feed is run with exactly the documented arguments, in its environment, and checked', () => {
    it('--project --since (clamped to 8 days, UTC to the second), --epic, then --name and --venue in the card\'s order', async () => {
      const seen = join(tmp, 'seen');
      await piece('tasks', feedOf('loom-tasks'), { 'loom-tasks': recording(seen) });
      write({ slug: 'pond', name: 'Pond', links: { aliases: ['toad', 'on-pond'], epic: 't-210', venues: ['slack:C0POND', 'discord:123'], repos: ['acme/pond'], notes: ['pond'] } });

      const ss = await sections('pond', { since: new Date(NOW - 30 * DAY).toISOString() });
      expect(pieceSections(ss)).toEqual([{ key: 'piece:tasks', label: 'Tasks', groups: [{ title: 'Ready', items: [{ title: 'one', ref: 't-1', status: 'open' }] }] }]);
      expect((await readFile(seen, 'utf-8')).split('\n')).toEqual([
        'project-feed', '--json',
        '--project', 'pond', '--since', '2026-10-25T15:00:01Z',
        '--epic', 't-210',
        '--name', 'toad', '--name', 'on-pond',
        '--venue', 'slack:C0POND', '--venue', 'discord:123',
        'name=tasks greeting=hello', '',
      ]);
    });

    it('a since within 8 days passes as given (to the second); a card without links gets only --project and --since', async () => {
      const seen = join(tmp, 'seen');
      await piece('tasks', feedOf('loom-tasks'), { 'loom-tasks': recording(seen) });
      write({ slug: 'hockey', name: 'Hockey' });
      await sections('hockey', { since: '2026-10-30T09:15:42.000Z' });
      expect(await readFile(seen, 'utf-8')).toBe('project-feed\n--json\n--project\nhockey\n--since\n2026-10-30T09:15:42Z\nname=tasks greeting=hello\n');
      // The hub's own default (7 days) is inside the clamp.
      await sections('hockey');
      expect((await readFile(seen, 'utf-8')).split('\n').slice(2, 6)).toEqual(['--project', 'hockey', '--since', '2026-10-26T15:00:01Z']);
    });

    it('feedArgs and feedSince by themselves', () => {
      expect(feedSince('2026-01-01T00:00:00Z', NOW)).toBe('2026-10-25T15:00:01Z');
      expect(feedSince('2026-11-01T00:00:00Z', NOW)).toBe('2026-11-01T00:00:00Z');
      expect(feedArgs({ slug: 'pond', links: { epic: 't-1', venues: ['v'] } }, '2026-11-01T00:00:00Z', NOW))
        .toEqual(['--project', 'pond', '--since', '2026-11-01T00:00:00Z', '--epic', 't-1', '--venue', 'v']);
    });

    it('invalid output, a non-zero exit and a timeout over 3 s are each that piece\'s {key, error}; the other sections still return', async () => {
      await remember(ctx, { category: 'project', title: 'a pond memory', content: 'x', project: 'pond' });
      write({ slug: 'pond', name: 'Pond' });
      await piece('a-bad', feedOf('loom-a'), { 'loom-a': `echo '{"groups":[{"title":"g","items":[{"title":"t","url":"x"}]}]}'` });
      await piece('b-text', feedOf('loom-b'), { 'loom-b': 'echo not json' });
      await piece('c-exit', feedOf('loom-c'), { 'loom-c': `echo '${GOOD}'; exit 2` });
      await piece('d-slow', feedOf('loom-d'), { 'loom-d': 'sleep 10' });
      await piece('e-good', feedOf('loom-e'), { 'loom-e': `echo '${GOOD}'` });
      await piece('f-caps', feedOf('loom-f'), { 'loom-f': `echo '{"groups":[{"title":"g","items":[{"title":"t","status":"${'x'.repeat(25)}"}]}]}'` });

      const t0 = Date.now();
      const ss = await sections('pond');
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(ss.find((s) => s.key === 'memories')).toMatchObject({ items: [{ snippet: expect.stringContaining('a pond memory') }] });
      expect(pieceSections(ss)).toEqual([
        { key: 'piece:a-bad', error: 'invalid: groups[0].items[0]: unknown key "url"' },
        { key: 'piece:b-text', error: 'invalid: not JSON' },
        { key: 'piece:c-exit', error: 'exit 2' },
        { key: 'piece:d-slow', error: 'timed out' },
        { key: 'piece:e-good', label: 'Tasks', groups: [{ title: 'Ready', items: [{ title: 'one', ref: 't-1', status: 'open' }] }] },
        { key: 'piece:f-caps', error: 'invalid: groups[0].items[0].status is at most 24 characters' },
      ]);
    }, 15_000);

    it('piece sections come after the core ones, sorted by piece name', async () => {
      await remember(ctx, { category: 'project', title: 'm', content: 'x', project: 'pond' });
      write({ slug: 'pond', name: 'Pond' });
      for (const n of ['zeta', 'alpha', 'mid']) await piece(n, feedOf(`loom-${n}`), { [`loom-${n}`]: `echo '{"groups":[]}'` });
      const keys = (await sections('pond')).map((s) => s.key);
      expect(keys[0]).toBe('memories');
      expect(keys.slice(-3)).toEqual(['piece:alpha', 'piece:mid', 'piece:zeta']);
      expect(keys.slice(0, -3).some((k) => k.startsWith('piece:'))).toBe(false);
    });

    it('an archived project reached with include_archived takes its names from its card', async () => {
      const seen = join(tmp, 'seen');
      await piece('tasks', feedOf('loom-tasks'), { 'loom-tasks': recording(seen) });
      write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'], epic: 't-210' } });
      const s = openProjectsStore(ctx, { now: () => NOW })!;
      try { s.archive({ slug: 'pond', reason: 'shut', actor: 'art' }); } finally { s.close(); }

      expect(await hub('pond')).toEqual({ found: true, archived: true });
      expect(existsSync(seen)).toBe(false);
      const ss = await sections('pond', { include_archived: true });
      expect(pieceSections(ss).map((x) => x.key)).toEqual(['piece:tasks']);
      expect((await readFile(seen, 'utf-8')).split('\n').slice(2, 10)).toEqual(['--project', 'pond', '--since', '2026-10-26T15:00:01Z', '--epic', 't-210', '--name', 'on-pond']);
    });
  });

  describe('11. what is never run, and the empty and unfiled cases', () => {
    it('a piece without sections.project, or one found only on PATH, is never run', async () => {
      const ran = join(tmp, 'ran');
      await piece('plain', {}, { 'loom-plain': `touch ${ran}; echo '{"groups":[]}'` });
      await mkdir(join(tmp, 'path'));
      await writeFile(join(tmp, 'path', 'loom-onpath'), `#!/bin/sh\ntouch ${ran}\necho '{"groups":[]}'\n`);
      await chmod(join(tmp, 'path', 'loom-onpath'), 0o755);
      env = { ...env, PATH: `${join(tmp, 'path')}:/usr/bin:/bin` };
      write({ slug: 'pond', name: 'Pond' });

      expect(pieceSections(await sections('pond'))).toEqual([]);
      expect(await unfiledSections(env, NOW)).toEqual([]);
      expect(existsSync(ran)).toBe(false);
    });

    it('a feed answering {"groups": []} is a present, empty section', async () => {
      await piece('tasks', feedOf('loom-tasks'), { 'loom-tasks': `echo '{"groups":[]}'` });
      write({ slug: 'pond', name: 'Pond' });
      expect(pieceSections(await sections('pond'))).toEqual([{ key: 'piece:tasks', label: 'Tasks', groups: [] }]);
    });

    it('with unfiled: true, Home\'s call gets --unfiled --since 7 days ago; a feed without it is not asked', async () => {
      const seen = join(tmp, 'seen');
      const other = join(tmp, 'other');
      await piece('tasks', feedOf('loom-tasks', { unfiled: true }), { 'loom-tasks': recording(seen) });
      await piece('notes', feedOf('loom-notes'), { 'loom-notes': recording(other) });
      expect(await unfiledSections(env, NOW)).toEqual([{ key: 'piece:tasks', label: 'Tasks', groups: [{ title: 'Ready', items: [{ title: 'one', ref: 't-1', status: 'open' }] }] }]);
      expect(await readFile(seen, 'utf-8')).toBe('project-feed\n--json\n--unfiled\n--since\n2026-10-26T15:00:01Z\nname=tasks greeting=hello\n');
      expect(existsSync(other)).toBe(false);
    });
  });
});
