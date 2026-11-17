import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bodySessions, packSession, sessionPath, unpackSession } from './body-session.js';
import { harnessSessionFiles } from './body-harnesses.js';
import { SESSION_BYTES } from '../core/conversations/session-limit.js';

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const session = '0f0e0d0c-1111-4222-8333-444455556666';
/** A Claude Code directory with one session in it, as the harness leaves it. */
function home() {
  const root = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(root);
  const project = join(root, 'projects', '-house');
  mkdirSync(join(project, session, 'tool-results'), { recursive: true });
  writeFileSync(join(project, `${session}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n');
  writeFileSync(join(project, session, 'tool-results', 'one.txt'), 'A LONG TOOL RESULT');
  writeFileSync(join(project, 'another-session-9.jsonl'), 'SOMEBODY ELSE');
  writeFileSync(join(root, '.credentials.json'), 'THE ACCOUNT');
  return { root, env: { CLAUDE_CONFIG_DIR: root }, project };
}

it('says which paths are a session\'s own: its transcript and what is under its directory, in one project', () => {
  for (const rel of [`projects/-house/${session}.jsonl`, `projects/-house/${session}/tool-results/one.txt`]) expect(sessionPath(rel, session), rel).toBe(true);
  for (const rel of [`projects/-house/another.jsonl`, `projects/${session}.jsonl`, `${session}.jsonl`, `projects/-house/${session}.json`, `projects/-house/../${session}.jsonl`, `projects/-house/${session}/../../.credentials.json`,
    `/projects/-house/${session}.jsonl`, `projects//${session}.jsonl`, `.credentials.json`, `projects/-house/${session}.jsonl/x`]) expect(sessionPath(rel, session), rel).toBe(false);
  expect(sessionPath(`projects/-house/x.jsonl`, '../x')).toBe(false);
});

it('finds a Claude session\'s files, packs them and puts them back in another place exactly', () => {
  const from = home(), found = harnessSessionFiles('claude', from.env, session)!;
  expect(found).toEqual({ root: from.root, files: [`projects/-house/${session}.jsonl`, `projects/-house/${session}/tool-results/one.txt`] });
  const pack = packSession(found.root, found.files, session)!;
  expect(Buffer.byteLength(pack, 'base64')).toBeLessThan(SESSION_BYTES);
  // Nothing but the session's own files is in the pack.
  for (const other of ['SOMEBODY ELSE', 'THE ACCOUNT']) expect(JSON.stringify(unpackTo(pack).files)).not.toContain(Buffer.from(other).toString('base64'));
  const to = unpackTo(pack);
  expect(readFileSync(join(to.root, 'projects', '-house', `${session}.jsonl`), 'utf8')).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  expect(readFileSync(join(to.root, 'projects', '-house', session, 'tool-results', 'one.txt'), 'utf8')).toBe('A LONG TOOL RESULT');
  // A harness that keeps no sessions has no such place.
  expect(harnessSessionFiles('codex', from.env, session)).toBeUndefined();
  function unpackTo(value: string) { const root = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(root); return { root, files: unpackSession(root, value, session) }; }
});

it('does not follow a link out of the harness\'s directory when it looks for a session\'s files', () => {
  const from = home();
  symlinkSync(join(from.root, '.credentials.json'), join(from.project, session, 'link-out'));
  expect(harnessSessionFiles('claude', from.env, session)!.files.some(rel => rel.includes('link-out'))).toBe(false);
});

it('packs nothing too large to keep, and unpacks nothing that is not this session\'s', () => {
  const from = home();
  // Bytes that do not compress, so the pack is as large as the transcript.
  writeFileSync(join(from.project, `${session}.jsonl`), randomBytes(2 * SESSION_BYTES));
  const found = harnessSessionFiles('claude', from.env, session)!;
  expect(packSession(found.root, found.files, session)).toBeUndefined();
  expect(packSession(found.root, [], session)).toBeUndefined();
  const to = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(to);
  const pack = (entries: unknown) => gzipSync(Buffer.from(JSON.stringify(entries))).toString('base64');
  const data = Buffer.from('x').toString('base64');
  for (const entries of [[{ rel: '../escape', data }], [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: '.credentials.json', data }], [{ rel: `projects/-house/other.jsonl`, data }], [], 'nonsense',
    [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: `projects/-house/${session}.jsonl`, data }]]) expect(() => unpackSession(to, pack(entries), session), JSON.stringify(entries)).toThrow();
  expect(() => unpackSession(to, 'not gzip', session)).toThrow();
  expect(existsSync(join(to, 'projects'))).toBe(false); expect(existsSync(join(to, '.credentials.json'))).toBe(false);
});

it('takes the kept session from loom, hands back the one the run left, and leaves no file of either behind', async () => {
  const before = home(), found = harnessSessionFiles('claude', before.env, session)!, kept = packSession(found.root, found.files, session)!;
  const after = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(after);
  const calls: [string, unknown][] = [];
  const client = { command: async (operation: string, input: unknown) => { calls.push([operation, input]);
    return operation === 'conversation.session' ? { ok: true as const, value: { session: { session, files: kept } } } : { ok: true as const, value: { saved: true } }; } };
  const keeper = bodySessions(client as never, 'claude', { CLAUDE_CONFIG_DIR: after })!;
  expect(await keeper.take()).toBe(session);
  expect(existsSync(join(after, 'projects', '-house', `${session}.jsonl`))).toBe(true);
  // The run went on in the same session and added to it.
  writeFileSync(join(after, 'projects', '-house', `${session}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  await keeper.save(session);
  expect(calls.map(call => call[0])).toEqual(['conversation.session', 'conversation.sessionSave']);
  const saved = calls[1][1] as { session: string; files: string };
  expect(saved.session).toBe(session);
  const check = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(check); unpackSession(check, saved.files, session);
  expect(readFileSync(join(check, 'projects', '-house', `${session}.jsonl`), 'utf8')).toContain('{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  expect(existsSync(join(after, 'projects', '-house', `${session}.jsonl`))).toBe(false);
  expect(existsSync(join(after, 'projects', '-house', session, 'tool-results', 'one.txt'))).toBe(false);
});

it('starts fresh, and never fails, when loom has none, loom is away, or what it hands over is not a session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(root);
  const answers: unknown[] = [{ ok: true, value: { session: null } }, { ok: false, code: 'denied', message: 'no' }, { ok: true, value: { session: { session, files: 'bm90IGd6aXA=' } } }, { ok: true, value: { session: { session: '../x', files: 'eA==' } } }];
  for (const answer of answers) expect(await bodySessions({ command: async () => answer } as never, 'claude', { CLAUDE_CONFIG_DIR: root })!.take()).toBeUndefined();
  expect(await bodySessions({ command: async () => { throw Error('PRIVATE'); } } as never, 'claude', { CLAUDE_CONFIG_DIR: root })!.take()).toBeUndefined();
  // A run that left no session, or one too large to pack, says so; loom then removes what it kept.
  const said: unknown[] = [];
  const keeper = bodySessions({ command: async (_operation: string, input: unknown) => { said.push(input); return { ok: true, value: { saved: false } }; } } as never, 'claude', { CLAUDE_CONFIG_DIR: root })!;
  await keeper.save(undefined); await keeper.save('no-such-session-1');
  expect(said).toEqual([{ session: null }, { session: null }]);
  await bodySessions({ command: async () => { throw Error('PRIVATE'); } } as never, 'claude', { CLAUDE_CONFIG_DIR: root })!.save(session);
  // A harness with no sessions, and a directory that cannot be written, have no keeper: the body runs as before.
  expect(bodySessions({ command: async () => ({}) } as never, 'codex', { CLAUDE_CONFIG_DIR: root })).toBeUndefined();
  expect(bodySessions({ command: async () => ({}) } as never, 'claude', { CLAUDE_CONFIG_DIR: '/proc/loom-no-such-place' })).toBeUndefined();
});
