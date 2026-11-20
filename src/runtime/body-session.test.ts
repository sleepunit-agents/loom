import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bodySessions, packSession, unpackSession } from './body-session.js';
import { harnessSessions } from './body-harnesses.js';
import { houseSessions } from './house-layout.js';
import { SESSION_BYTES } from '../core/conversations/session-limit.js';

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const session = '0f0e0d0c-1111-4222-8333-444455556666';
const claude = harnessSessions('claude')!;
/** A new directory, by its real path: the helpers compare where the kernel says a file is. */
const fresh = () => { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'loom-body-session-'))); made.push(directory); return directory; };
/** A house's home with Claude Code's directory in it and one session there, as the harness leaves it. */
function home() {
  const base = fresh(), root = join(base, '.claude'), project = join(root, 'projects', '-house');
  mkdirSync(join(project, session, 'tool-results'), { recursive: true });
  writeFileSync(join(project, `${session}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n');
  writeFileSync(join(project, session, 'tool-results', 'one.txt'), 'A LONG TOOL RESULT');
  writeFileSync(join(project, 'another-session-9.jsonl'), 'SOMEBODY ELSE');
  writeFileSync(join(root, '.credentials.json'), 'THE ACCOUNT');
  return { base, root, project, env: { CLAUDE_CONFIG_DIR: root, LOOM_BODY_OWN_HARNESS: '1' } };
}
/** A keeper for a house whose home is `base` and whose sessions place is `root`. */
const keep = (client: unknown, at: { base: string; root: string }, env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: at.root, LOOM_BODY_OWN_HARNESS: '1' }, harness = 'claude') =>
  bodySessions(client as never, harness, env, at.root, at.base);
const pack = (entries: unknown) => gzipSync(Buffer.from(JSON.stringify(entries))).toString('base64');
const nothing = { command: async () => ({ ok: true, value: { session: null } }) };

it('lets the Claude adapter alone say which paths are a session\'s: its transcript and what is under its directory, in one project', () => {
  for (const rel of [`projects/-house/${session}.jsonl`, `projects/-house/${session}/tool-results/one.txt`]) expect(claude.owns(rel, session), rel).toBe(true);
  for (const rel of [`projects/-house/another.jsonl`, `projects/${session}.jsonl`, `${session}.jsonl`, `projects/-house/${session}.json`, `projects/-house/../${session}.jsonl`, `projects/-house/${session}/../../.credentials.json`,
    `/projects/-house/${session}.jsonl`, `projects//${session}.jsonl`, `.credentials.json`, `projects/-house/${session}.jsonl/x`]) expect(claude.owns(rel, session), rel).toBe(false);
  expect(claude.owns(`projects/-house/x.jsonl`, '../x')).toBe(false);
  // A harness that keeps no sessions has no layout at all.
  expect(harnessSessions('codex')).toBeUndefined(); expect(harnessSessions('constructor')).toBeUndefined();
});

it('finds a Claude session\'s files, packs them and puts them back in another place exactly', () => {
  const from = home();
  expect(claude.files(from.root, session)).toEqual([`projects/-house/${session}.jsonl`, `projects/-house/${session}/tool-results/one.txt`]);
  const packedSession = packSession(claude, from.root, session)!;
  expect(Buffer.byteLength(packedSession, 'base64')).toBeLessThan(SESSION_BYTES);
  const to = fresh();
  expect(unpackSession(claude, to, packedSession, session)).toHaveLength(2);
  expect(readFileSync(join(to, 'projects', '-house', `${session}.jsonl`), 'utf8')).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  expect(readFileSync(join(to, 'projects', '-house', session, 'tool-results', 'one.txt'), 'utf8')).toBe('A LONG TOOL RESULT');
  // Nothing but the session's own files came across.
  expect(readdirSync(to, { recursive: true }).sort()).toEqual(['projects', 'projects/-house', `projects/-house/${session}`, `projects/-house/${session}.jsonl`, `projects/-house/${session}/tool-results`, `projects/-house/${session}/tool-results/one.txt`]);
});

it('follows no link on the way to a session\'s files: not at `projects`, not at a project, not inside the session', async () => {
  // Somewhere else on the machine, a directory laid out to look like a session's.
  const elsewhere = fresh(), lure = join(elsewhere, 'lure');
  mkdirSync(join(lure, session), { recursive: true });
  writeFileSync(join(lure, `${session}.jsonl`), 'NOT THIS BODY\'S'); writeFileSync(join(lure, session, 'secret.txt'), 'NOT THIS BODY\'S EITHER');
  mkdirSync(join(elsewhere, 'projects-out')); symlinkSync(lure, join(elsewhere, 'projects-out', 'x'));
  const cases: [string, (root: string) => void][] = [
    ['`projects` is a link to a directory of projects', root => { symlinkSync(elsewhere, join(root, 'projects')); }],
    ['`projects` is a link, and so is the project under it', root => { symlinkSync(join(elsewhere, 'projects-out'), join(root, 'projects')); }],
    // The case a body with a shell makes in one command.
    ['a project directory is a link', root => { mkdirSync(join(root, 'projects')); symlinkSync(lure, join(root, 'projects', 'x')); }],
    ['the transcript and the session directory are links', root => { mkdirSync(join(root, 'projects', 'x'), { recursive: true }); symlinkSync(join(lure, session), join(root, 'projects', 'x', session)); symlinkSync(join(lure, `${session}.jsonl`), join(root, 'projects', 'x', `${session}.jsonl`)); }],
    ['a file and a directory inside the session are links', root => { mkdirSync(join(root, 'projects', 'x', session), { recursive: true }); symlinkSync(join(lure, session, 'secret.txt'), join(root, 'projects', 'x', session, 'linked.txt')); symlinkSync(join(lure, session), join(root, 'projects', 'x', session, 'linked-directory')); }],
  ];
  for (const [name, plant] of cases) {
    const base = fresh(), root = join(base, '.claude'); mkdirSync(root); plant(root);
    const sent: unknown[] = [];
    const keeper = keep({ command: async (_operation: string, input: unknown) => { sent.push(input); return { ok: true, value: { saved: false } }; } }, { base, root })!;
    // Nothing outside is found, packed and handed to loom, or removed where it was.
    expect(claude.files(root, session), name).toEqual([]);
    await keeper.save(session);
    expect(sent, name).toEqual([{ session: null }]);
    expect(readFileSync(join(lure, `${session}.jsonl`), 'utf8'), name).toBe('NOT THIS BODY\'S');
    expect(readFileSync(join(lure, session, 'secret.txt'), 'utf8'), name).toBe('NOT THIS BODY\'S EITHER');
  }
});

it('packs nothing too large to keep, and unpacks nothing that is not this session\'s', () => {
  const from = home();
  // Bytes that do not compress, so the pack is as large as the transcript.
  writeFileSync(join(from.project, `${session}.jsonl`), randomBytes(2 * SESSION_BYTES));
  expect(packSession(claude, from.root, session)).toBeUndefined();
  expect(packSession(claude, fresh(), session)).toBeUndefined();
  const to = fresh(), data = Buffer.from('x').toString('base64');
  for (const entries of [[{ rel: '../escape', data }], [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: '.credentials.json', data }], [{ rel: `projects/-house/other.jsonl`, data }], [], 'nonsense',
    [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: `projects/-house/${session}.jsonl`, data }]]) expect(() => unpackSession(claude, to, pack(entries), session), JSON.stringify(entries)).toThrow();
  expect(() => unpackSession(claude, to, 'not gzip', session)).toThrow();
  expect(readdirSync(to)).toEqual([]);
});

it('unpacks through no link, and a refused pack leaves nothing behind: no file, no directory it made', () => {
  const data = Buffer.from('TRANSCRIPT').toString('base64');
  const files = [{ rel: `projects/-house/${session}.jsonl`, data }, { rel: `projects/-house/${session}/tool-results/one.txt`, data }];
  /** A harness directory and, beside it, a place a link could lead to. */
  const place = () => { const base = fresh(), root = join(base, 'claude'), outside = join(base, 'outside'); mkdirSync(root); mkdirSync(outside); return { root, outside }; };
  const empty = (directory: string) => readdirSync(directory, { recursive: true }).length === 0;
  // `projects` itself is a link.
  let at = place(); symlinkSync(at.outside, join(at.root, 'projects'));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The project directory is a link.
  at = place(); mkdirSync(join(at.root, 'projects')); symlinkSync(at.outside, join(at.root, 'projects', '-house'));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The session's own directory, and one inside it, is a link.
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); symlinkSync(at.outside, join(at.root, 'projects', '-house', session));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The first file had been written before the link was met: it is taken away again.
  expect(existsSync(join(at.root, 'projects', '-house', `${session}.jsonl`))).toBe(false);
  at = place(); mkdirSync(join(at.root, 'projects', '-house', session), { recursive: true }); symlinkSync(at.outside, join(at.root, 'projects', '-house', session, 'tool-results'));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  // The file itself is a link, to a file that is there and to one that is not; or a file is already there.
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); writeFileSync(join(at.outside, 'victim'), 'UNTOUCHED');
  symlinkSync(join(at.outside, 'victim'), join(at.root, 'projects', '-house', `${session}.jsonl`));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(readFileSync(join(at.outside, 'victim'), 'utf8')).toBe('UNTOUCHED');
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); symlinkSync(join(at.outside, 'made-by-link'), join(at.root, 'projects', '-house', `${session}.jsonl`));
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(empty(at.outside)).toBe(true);
  at = place(); mkdirSync(join(at.root, 'projects', '-house'), { recursive: true }); writeFileSync(join(at.root, 'projects', '-house', `${session}.jsonl`), 'ALREADY HERE');
  expect(() => unpackSession(claude, at.root, pack(files), session)).toThrow(); expect(readFileSync(join(at.root, 'projects', '-house', `${session}.jsonl`), 'utf8')).toBe('ALREADY HERE');
  // A pack refused part way, in a directory that had nothing: the directories it made go too.
  at = place();
  expect(() => unpackSession(claude, at.root, pack([files[0], { rel: `projects/-house/${session}/a/b.txt`, data }, { rel: `projects/-house/${session}/a/b.txt/c`, data }]), session)).toThrow();
  expect(empty(at.root)).toBe(true);
  // With no link in the way the same pack lands where it belongs.
  at = place();
  expect(unpackSession(claude, at.root, pack(files), session)).toHaveLength(2);
  expect(readFileSync(join(at.root, 'projects', '-house', session, 'tool-results', 'one.txt'), 'utf8')).toBe('TRANSCRIPT');
});

it('takes the kept session from loom, hands back the one the run left, and leaves no file of either behind', async () => {
  const before = home(), kept = packSession(claude, before.root, session)!;
  const base = fresh(), root = join(base, '.claude'); mkdirSync(root);
  const calls: [string, unknown][] = [];
  const client = { command: async (operation: string, input: unknown) => { calls.push([operation, input]);
    return operation === 'conversation.session' ? { ok: true as const, value: { session: { session, files: kept } } } : { ok: true as const, value: { saved: true } }; } };
  const keeper = keep(client, { base, root })!;
  expect(await keeper.take()).toBe(session);
  expect(existsSync(join(root, 'projects', '-house', `${session}.jsonl`))).toBe(true);
  // The run went on in the same session and added to it.
  writeFileSync(join(root, 'projects', '-house', `${session}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  await keeper.save(session);
  expect(calls.map(call => call[0])).toEqual(['conversation.session', 'conversation.sessionSave']);
  const saved = calls[1][1] as { session: string; files: string };
  expect(saved.session).toBe(session);
  const check = fresh(); unpackSession(claude, check, saved.files, session);
  expect(readFileSync(join(check, 'projects', '-house', `${session}.jsonl`), 'utf8')).toContain('{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  expect(existsSync(join(root, 'projects', '-house', `${session}.jsonl`))).toBe(false);
  expect(existsSync(join(root, 'projects', '-house', session, 'tool-results', 'one.txt'))).toBe(false);
});

it('starts fresh, and never fails, when loom has none, loom is away, or what it hands over is not a session', async () => {
  const base = fresh(), root = join(base, '.claude'); mkdirSync(root);
  const answers: unknown[] = [{ ok: true, value: { session: null } }, { ok: true, value: { session: { session, files: 'bm90IGd6aXA=' } } }, { ok: true, value: { session: { session: '../x', files: 'eA==' } } }];
  for (const answer of answers) {
    const calls: unknown[] = [];
    const client = { command: async (operation: string, input: unknown) => { calls.push([operation, input]); return operation === 'conversation.session' ? answer : { ok: true, value: { saved: false } }; } };
    expect(await keep(client, { base, root })!.take()).toBeUndefined();
    // Handed nothing it can continue, it says so at once: what loom keeps is of no use to this body and is removed.
    expect(calls).toEqual([['conversation.session', {}], ['conversation.sessionSave', { session: null }]]);
  }
  // Refused, or loom away: nothing more is asked, and nothing fails.
  const refused: string[] = [];
  expect(await keep({ command: async (operation: string) => { refused.push(operation); return { ok: false, code: 'denied', message: 'no' }; } }, { base, root })!.take()).toBeUndefined();
  expect(refused).toEqual(['conversation.session']);
  expect(await keep({ command: async () => { throw Error('PRIVATE'); } }, { base, root })!.take()).toBeUndefined();
  // A run that left no session, or one too large to pack, says so; loom then removes what it kept.
  const said: unknown[] = [];
  const keeper = keep({ command: async (_operation: string, input: unknown) => { said.push(input); return { ok: true, value: { saved: false } }; } }, { base, root })!;
  await keeper.save(undefined); await keeper.save('no-such-session-1');
  expect(said).toEqual([{ session: null }, { session: null }]);
  await keep({ command: async () => { throw Error('PRIVATE'); } }, { base, root })!.save(session);
});

it('keeps no session unless the worker said the place is the body\'s own, the harness keeps them there, and it is a real directory reached through no link', () => {
  const at = home();
  expect(keep(nothing, at)).toBeDefined();
  // Not said, said otherwise, or said in a way the worker never says it: a plain process, a container with a mount there.
  for (const value of [undefined, '0', 'true', 'yes', ' 1']) expect(keep(nothing, at, { CLAUDE_CONFIG_DIR: at.root, LOOM_BODY_OWN_HARNESS: value }), String(value)).toBeUndefined();
  // The harness keeps its sessions somewhere other than the place the worker vouched for (an image that
  // points Claude Code's whole directory at the mounted sign-in, say).
  const other = join(at.base, 'elsewhere'); mkdirSync(other);
  expect(keep(nothing, at, { CLAUDE_CONFIG_DIR: other, LOOM_BODY_OWN_HARNESS: '1' })).toBeUndefined();
  // The place is not there: it is not made. No directory, no session.
  const bare = fresh();
  expect(bodySessions(nothing as never, 'claude', { HOME: bare, LOOM_BODY_OWN_HARNESS: '1' }, join(bare, '.claude'), bare)).toBeUndefined();
  expect(existsSync(join(bare, '.claude'))).toBe(false);
  // The place is a link: into a mount, into the sign-in directory, anywhere. It is somebody else's place.
  const linked = fresh(), shared = fresh();
  symlinkSync(shared, join(linked, '.claude'));
  expect(bodySessions(nothing as never, 'claude', { HOME: linked, LOOM_BODY_OWN_HARNESS: '1' }, join(linked, '.claude'), linked)).toBeUndefined();
  // A step on the way from the home is a link.
  const deep = fresh(); mkdirSync(join(shared, 'config')); symlinkSync(shared, join(deep, 'via'));
  expect(bodySessions(nothing as never, 'claude', { CLAUDE_CONFIG_DIR: join(deep, 'via', 'config'), LOOM_BODY_OWN_HARNESS: '1' }, join(deep, 'via', 'config'), deep)).toBeUndefined();
  // A file where the directory should be; a place outside the home; a harness that keeps no sessions.
  writeFileSync(join(at.base, 'a-file'), 'x');
  expect(bodySessions(nothing as never, 'claude', { CLAUDE_CONFIG_DIR: join(at.base, 'a-file'), LOOM_BODY_OWN_HARNESS: '1' }, join(at.base, 'a-file'), at.base)).toBeUndefined();
  expect(bodySessions(nothing as never, 'claude', at.env, at.root, join(at.base, 'another-home'))).toBeUndefined();
  expect(keep(nothing, at, at.env, 'codex')).toBeUndefined();
  // With nothing said about the place, it is the layout's: a house's own home.
  expect(houseSessions('claude')).toBe('/home/agent/.claude'); expect(houseSessions('codex')).toBeUndefined(); expect(houseSessions('constructor')).toBeUndefined();
  expect(bodySessions(nothing as never, 'claude', at.env)).toBeUndefined();
});
