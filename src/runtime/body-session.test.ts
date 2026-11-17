import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  return { root, env: { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '1' }, project };
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
  const keeper = bodySessions(client as never, 'claude', { CLAUDE_CONFIG_DIR: after, LOOM_BODY_OWN_HARNESS: '1' })!;
  expect(await keeper.take()).toBe(session);
  expect(existsSync(join(after, 'projects', '-house', `${session}.jsonl`))).toBe(true);
  // The run went on in the same session and added to it.
  writeFileSync(join(after, 'projects', '-house', `${session}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  await keeper.save(session);
  expect(calls.map(call => call[0])).toEqual(['conversation.session', 'conversation.sessionSave']);
  expect(calls[1][1]).toHaveProperty('files');
  const saved = calls[1][1] as { session: string; files: string };
  expect(saved.session).toBe(session);
  const check = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(check); unpackSession(check, saved.files, session);
  expect(readFileSync(join(check, 'projects', '-house', `${session}.jsonl`), 'utf8')).toContain('{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  expect(existsSync(join(after, 'projects', '-house', `${session}.jsonl`))).toBe(false);
  expect(existsSync(join(after, 'projects', '-house', session, 'tool-results', 'one.txt'))).toBe(false);
});

it('starts fresh, and never fails, when loom has none, loom is away, or what it hands over is not a session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(root);
  const env = { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '1' };
  const answers: unknown[] = [{ ok: true, value: { session: null } }, { ok: true, value: { session: { session, files: 'bm90IGd6aXA=' } } }, { ok: true, value: { session: { session: '../x', files: 'eA==' } } }];
  for (const answer of answers) {
    const calls: unknown[] = [];
    const client = { command: async (operation: string, input: unknown) => { calls.push([operation, input]); return operation === 'conversation.session' ? answer : { ok: true, value: { saved: false } }; } };
    expect(await bodySessions(client as never, 'claude', env)!.take()).toBeUndefined();
    // Handed nothing it can continue, it says so at once: what loom keeps is of no use to this body and is removed.
    expect(calls).toEqual([['conversation.session', {}], ['conversation.sessionSave', { session: null }]]);
  }
  // Refused, or loom away: nothing more is asked, and nothing fails.
  const refused: string[] = [];
  expect(await bodySessions({ command: async (operation: string) => { refused.push(operation); return { ok: false, code: 'denied', message: 'no' }; } } as never, 'claude', env)!.take()).toBeUndefined();
  expect(refused).toEqual(['conversation.session']);
  expect(await bodySessions({ command: async () => { throw Error('PRIVATE'); } } as never, 'claude', env)!.take()).toBeUndefined();
  // A run that left no session, or one too large to pack, says so; loom then removes what it kept.
  const said: unknown[] = [];
  const keeper = bodySessions({ command: async (_operation: string, input: unknown) => { said.push(input); return { ok: true, value: { saved: false } }; } } as never, 'claude', env)!;
  await keeper.save(undefined); await keeper.save('no-such-session-1');
  expect(said).toEqual([{ session: null }, { session: null }]);
  await bodySessions({ command: async () => { throw Error('PRIVATE'); } } as never, 'claude', env)!.save(session);
});

it('keeps no session unless the harness directory is this body\'s alone, is there already, and can be written', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(root);
  const client = { command: async () => ({ ok: true, value: { session: null } }) } as never;
  expect(bodySessions(client, 'claude', { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '1' })).toBeDefined();
  // Not said to be the body's own: a plain process, or a container with the sign-in directory mounted in.
  for (const env of [{ CLAUDE_CONFIG_DIR: root }, { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '0' }, { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: 'true' }]) expect(bodySessions(client, 'claude', env)).toBeUndefined();
  // A harness directory that is not there is not made: no directory, no session.
  const missing = join(root, 'no-claude-here');
  expect(bodySessions(client, 'claude', { CLAUDE_CONFIG_DIR: missing, LOOM_BODY_OWN_HARNESS: '1' })).toBeUndefined();
  expect(existsSync(missing)).toBe(false);
  const home = join(root, 'home');mkdirSync(home);
  expect(bodySessions(client, 'claude', { HOME: home, LOOM_BODY_OWN_HARNESS: '1' })).toBeUndefined();
  expect(existsSync(join(home, '.claude'))).toBe(false);
  // A file where the directory should be, and a harness that keeps no sessions.
  writeFileSync(join(root, 'a-file'), 'x');
  expect(bodySessions(client, 'claude', { CLAUDE_CONFIG_DIR: join(root, 'a-file'), LOOM_BODY_OWN_HARNESS: '1' })).toBeUndefined();
  expect(bodySessions(client, 'codex', { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '1' })).toBeUndefined();
});

it('unpacks through no link: one planted at any step of a session\'s path refuses the whole pack and nothing lands outside', () => {
  const pack = (entries: unknown) => gzipSync(Buffer.from(JSON.stringify(entries))).toString('base64');
  const data = Buffer.from('TRANSCRIPT').toString('base64');
  const files = [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: `projects/-house/${session}/tool-results/one.txt`, data }];
  /** A harness directory and, beside it, a place a link could lead to. */
  const place = () => { const base = mkdtempSync(join(tmpdir(), 'loom-body-session-')); made.push(base); const root = join(base, 'claude'), outside = join(base, 'outside'); mkdirSync(root); mkdirSync(outside); return { root, outside }; };
  const empty = (directory: string) => readdirSync(directory, { recursive: true }).length === 0;
  // `projects` itself is a link.
  let at = place(); symlinkSync(at.outside, join(at.root, 'projects'));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The project directory is a link.
  at = place(); mkdirSync(join(at.root, 'projects')); symlinkSync(at.outside, join(at.root, 'projects', '-house'));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The session's own directory, and one inside it, is a link.
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); symlinkSync(at.outside, join(at.root, 'projects', '-house', session));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  expect(existsSync(join(at.root, 'projects', '-house', `${session}.jsonl`))).toBe(false);
  at = place(); mkdirSync(join(at.root, 'projects', '-house', session), { recursive: true }); symlinkSync(at.outside, join(at.root, 'projects', '-house', session, 'tool-results'));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The file itself is a link, to a file that is there and to one that is not; or a file is already there.
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); writeFileSync(join(at.outside, 'victim'), 'UNTOUCHED');
  symlinkSync(join(at.outside, 'victim'), join(at.root, 'projects', '-house', `${session}.jsonl`));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(readFileSync(join(at.outside, 'victim'), 'utf8')).toBe('UNTOUCHED');
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); symlinkSync(join(at.outside, 'made-by-link'), join(at.root, 'projects', '-house', `${session}.jsonl`));
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); writeFileSync(join(at.root, 'projects', '-house', `${session}.jsonl`), 'ALREADY HERE');
  expect(() => unpackSession(at.root, pack(files), session)).toThrow(); expect(readFileSync(join(at.root, 'projects', '-house', `${session}.jsonl`), 'utf8')).toBe('ALREADY HERE');
  // With no link in the way the same pack lands where it belongs.
  at = place();
  expect(unpackSession(at.root, pack(files), session)).toHaveLength(2);
  expect(readFileSync(join(at.root, 'projects', '-house', session, 'tool-results', 'one.txt'), 'utf8')).toBe('TRANSCRIPT');
});
