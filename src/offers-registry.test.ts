/**
 * The offers registry and runner (src/offers-registry.ts): which installed
 * managed pieces offer what, and running an offer's argv with args and stdin
 * in the piece's environment, under the manifest runner's limits, its answer
 * checked against a schema.
 *
 * Pieces here are laid down the way the installer leaves them: a piece.json
 * under $LOOM_HOME/pieces/<name>/ and its bins in pieces/bin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantsAuthority, OFFER_LIMITS, offersOf, piecesOffering, runOffer } from './offers-registry.js';
import { parseFeed } from './offers.js';
import { clearPieceCache } from './ui/pieces.js';

describe('offers registry and runner', () => {
  let tmp: string;
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

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-offers-'));
    env = { LOOM_HOME: tmp, PATH: '/usr/bin:/bin' };
    clearPieceCache();
  });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  const feed = { label: 'Tasks', argv: ['loom-tasks', 'project-feed', '--json'] };

  it('lists the pieces offering each kind, and a piece\'s declared offers', async () => {
    await piece('tasks', { sections: { project: { ...feed, unfiled: false } } }, { 'loom-tasks': 'true' });
    await piece('runtime', { role: 'runtime', grants: ['loom-runtime', 'grants'], mcp_tools: { house: { description: 'd', input_schema: { type: 'object' }, argv: ['loom-runtime'] } } }, { 'loom-runtime': 'true' });
    await piece('plain', {}, { 'loom-plain': 'true' });
    expect(piecesOffering(env, 'sections').map((p) => p.piece)).toEqual(['tasks']);
    expect(piecesOffering(env, 'mcp_tools').map((p) => p.piece)).toEqual(['runtime']);
    expect(piecesOffering(env, 'venues')).toEqual([]);
    expect(offersOf(env, 'tasks')).toEqual({ sections: { project: { ...feed, unfiled: false } } });
    expect(offersOf(env, 'runtime')).toEqual({ grants: ['loom-runtime', 'grants'], mcp_tools: { house: { description: 'd', input_schema: { type: 'object' }, argv: ['loom-runtime'] } } });
    expect(offersOf(env, 'plain')).toEqual({});
    expect(offersOf(env, 'missing')).toBeUndefined();
    expect(grantsAuthority(env)).toEqual({ piece: 'runtime', argv: ['loom-runtime', 'grants'] });
  });

  it('no grants authority with none installed, and none (said) were two ever present', async () => {
    expect(grantsAuthority(env)).toEqual({ piece: undefined });
    await piece('a', { grants: ['loom-a'] }, { 'loom-a': 'true' });
    await piece('b', { grants: ['loom-b'] }, { 'loom-b': 'true' });
    expect(grantsAuthority(env)).toEqual({ piece: undefined, conflict: ['a', 'b'] });
  });

  it('runs the declared argv plus the args, with stdin, in the piece\'s environment, and checks the answer', async () => {
    const out = join(tmp, 'seen');
    await piece('tasks', { sections: { project: feed } }, {
      'loom-tasks': `printf '%s\\n' "$@" > ${out}; cat >> ${out}; echo "name=$LOOM_PIECE_NAME greeting=$FEED_GREETING" >> ${out}; echo '{"groups":[{"title":"Open","items":[{"title":"one"}]}]}'`,
    });
    const r = await runOffer(env, 'tasks', feed.argv, { args: ['--project', 'loom', '--since', '2026-10-26T00:00:00Z'], stdin: 'the stdin', parse: parseFeed });
    expect(r).toEqual({ ok: true, value: { groups: [{ title: 'Open', items: [{ title: 'one' }] }] } });
    expect(await readFile(out, 'utf-8')).toBe('project-feed\n--json\n--project\nloom\n--since\n2026-10-26T00:00:00Z\nthe stdinname=tasks greeting=hello\n');
  });

  it('an answer the schema refuses, one that is not JSON, a non-zero exit, or one too large is an error, never a throw', async () => {
    await piece('tasks', {}, {
      'loom-tasks': 'case "$1" in bad) echo \'{"groups":[{"items":[]}]}\';; text) echo hi;; fail) echo \'{"groups":[]}\'; exit 3;; big) head -c 70000 /dev/zero | tr "\\0" x;; esac',
    });
    const run = (verb: string) => runOffer(env, 'tasks', ['loom-tasks', verb], { parse: parseFeed });
    expect(await run('bad')).toEqual({ ok: false, error: 'invalid: groups[0].title is required, at most 80 characters' });
    expect(await run('text')).toEqual({ ok: false, error: 'invalid: not JSON' });
    // A non-zero exit keeps its code and what it said, so an offer can say why it failed.
    expect(await run('fail')).toEqual({ ok: false, error: 'exit 3', exit: 3, answer: { groups: [] } });
    expect(await run('big')).toEqual({ ok: false, error: 'answer too large' });
  });

  it('each kind has its limits: delivery and mcp_tools 120 s, each in a pool of its own, a feed 3 s', async () => {
    expect(OFFER_LIMITS.delivery).toEqual({ timeoutMs: 120_000, maxBytes: 64 * 1024, pool: 'delivery' });
    expect(OFFER_LIMITS.mcp_tools).toEqual({ timeoutMs: 120_000, maxBytes: 64 * 1024, pool: 'tools' });
    expect(OFFER_LIMITS.sections).toMatchObject({ timeoutMs: 3_000, pool: 'page' });
    await piece('runtime', { role: 'runtime' }, { 'loom-runtime': 'sleep 3.5; echo \'{"groups":[]}\'' });
    // Past the feed's 3 s, inside delivery's 120.
    expect(await runOffer(env, 'runtime', ['loom-runtime'], { parse: parseFeed })).toEqual({ ok: false, error: 'timed out' });
    expect(await runOffer(env, 'runtime', ['loom-runtime'], { parse: parseFeed, kind: 'delivery' })).toEqual({ ok: true, value: { groups: [] } });
  }, 15_000);

  it('times out at 3 s, and kills the piece\'s process group', async () => {
    const child = join(tmp, 'child-lived');
    await piece('tasks', {}, { 'loom-tasks': `(sleep 4; touch ${child}) & sleep 10` });
    const t0 = Date.now();
    const r = await runOffer(env, 'tasks', ['loom-tasks'], { parse: parseFeed });
    const took = Date.now() - t0;
    expect(r).toEqual({ ok: false, error: 'timed out' });
    expect(took).toBeGreaterThanOrEqual(2_900);
    expect(took).toBeLessThan(4_000);
    await new Promise((res) => setTimeout(res, 1_500));
    expect(existsSync(child)).toBe(false);
  }, 10_000);

  it('runs at most 6 at once', async () => {
    const dir = join(tmp, 'running');
    await mkdir(dir);
    // Each run notes how many are running as it starts, then holds its place a moment.
    await piece('tasks', {}, { 'loom-tasks': `touch ${dir}/$$; ls ${dir} | wc -l > ${dir}.$$; sleep 0.4; rm ${dir}/$$; echo '{"groups":[]}'` });
    const rs = await Promise.all(Array.from({ length: 10 }, () => runOffer(env, 'tasks', ['loom-tasks'], { parse: parseFeed })));
    expect(rs.every((r) => r.ok)).toBe(true);
    const counts = await Promise.all((await readdir(tmp)).filter((f) => f.startsWith('running.')).map(async (f) => Number((await readFile(join(tmp, f), 'utf-8')).trim())));
    expect(counts).toHaveLength(10);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
  }, 10_000);

  it('never runs a piece that isn\'t managed, or an argv[0] that isn\'t the piece\'s bin', async () => {
    const ran = join(tmp, 'ran');
    await mkdir(join(tmp, 'path'));
    await writeFile(join(tmp, 'path', 'loom-onpath'), `#!/bin/sh\ntouch ${ran}\n`);
    await chmod(join(tmp, 'path', 'loom-onpath'), 0o755);
    await piece('tasks', {}, { 'loom-tasks': `touch ${ran}` });
    const e2 = { ...env, PATH: `${join(tmp, 'path')}:/usr/bin:/bin` };
    expect(await runOffer(e2, 'onpath', ['loom-onpath'], { parse: parseFeed })).toEqual({ ok: false, error: "onpath isn't a managed piece" });
    expect(await runOffer(e2, 'tasks', ['sh', '-c', `touch ${ran}`], { parse: parseFeed })).toEqual({ ok: false, error: '"sh" isn\'t one of tasks\'s bins' });
    expect(piecesOffering(e2, 'sections')).toEqual([]);
    expect(existsSync(ran)).toBe(false);
  });
});
