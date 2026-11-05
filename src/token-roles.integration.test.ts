/**
 * The runtime and review roles, and token expiry (docs/specs/conversations.md, "Who writes
 * what", "Review tokens" and acceptance criterion 7). Pins that
 *  - `runtime:<piece>` and `review:<piece>` parse and round-trip; neither can be loom's;
 *  - a runtime token is minted only for the one managed piece whose loom block says
 *    `"role": "runtime"` (CLI and createToken), and a review token never by createToken;
 *  - POST /api/loom/review/token mints a review token only for a runtime token, expiring
 *    two hours out;
 *  - every existing route refuses both roles (ROLE_ROUTES is the only way in);
 *  - an expired token is refused everywhere, the next token write drops it, and a record
 *    without `expires` is as valid as ever.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import {
  createToken, loadHousehold, loadTokens, mintReviewToken, parseRole, REVIEW_TOKEN_TTL_MS, REVIEW_TOKENS_LIVE_MAX, roleString,
  TokenResolver, type Household,
} from './household.js';
import { runToken } from './cli/household.js';
import { runtimePieces } from './cli/pieces-managed.js';
import { ROLE_ROUTES } from './transport/role-routes.js';

/** A managed piece record (and its bin), with `role` in its loom block. */
function piece(home: string, name: string, role?: string): void {
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...(role ? { role } : {}) } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => console.log(JSON.stringify({ body: JSON.parse(s) })));
`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

function household(prefix: string): Household {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, 'agents', 'art'), { recursive: true });
  writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art' }));
  return loadHousehold(home)!;
}

function io(env: NodeJS.ProcessEnv) {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { env, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } as never };
}

describe('role grammar: runtime and review', () => {
  it('parses runtime:<piece> and review:<piece>, round-trips, and never names loom', () => {
    expect(parseRole('runtime:shuttle')).toEqual({ kind: 'runtime', piece: 'shuttle' });
    expect(parseRole('review:shuttle')).toEqual({ kind: 'review', piece: 'shuttle' });
    for (const s of ['runtime:shuttle', 'review:shuttle']) expect(roleString(parseRole(s)!)).toBe(s);
    for (const s of ['runtime', 'review', 'runtime:', 'runtime:loom', 'review:loom', 'runtime:Shuttle', 'runtime:shuttle/x', 'review:a@h-1', 'runtimes:x']) {
      expect(parseRole(s), s).toBeNull();
    }
  });
});

describe('minting a runtime token', () => {
  let h: Household;
  const saved = process.env.LOOM_HOME;
  beforeAll(() => {
    h = household('loom-roles-mint-');
    piece(h.home, 'shuttle', 'runtime');
    piece(h.home, 'box', 'boxes');
    piece(h.home, 'plain');
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  it('runtimePieces finds the managed pieces whose loom block says role runtime', () => {
    expect(runtimePieces({ LOOM_HOME: h.home })).toEqual(['shuttle']);
  });

  it('createToken mints one for the runtime piece, and refuses any other piece, or with no list given', () => {
    const pieces = runtimePieces({ LOOM_HOME: h.home });
    expect(createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'shuttle', runtimePieces: pieces }).record.role).toBe('runtime:shuttle');
    expect(() => createToken(h, { role: { kind: 'runtime', piece: 'box' }, label: 'box', runtimePieces: pieces })).toThrow(/role.*runtime/);
    expect(() => createToken(h, { role: { kind: 'runtime', piece: 'ghost' }, label: 'ghost', runtimePieces: pieces })).toThrow(/role.*runtime/);
    // Fail closed: a caller that didn't look mints nothing.
    expect(() => createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'shuttle 2' })).toThrow(/runtime/);
    // Two pieces both claiming to be the runtime: neither is.
    expect(() => createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'shuttle 3', runtimePieces: ['shuttle', 'other'] })).toThrow(/more than one/);
  });

  it('createToken never mints a review token', () => {
    expect(() => createToken(h, { role: { kind: 'review', piece: 'shuttle' }, label: 'r', runtimePieces: ['shuttle'] })).toThrow(/review\/token/);
  });

  it('loom token create --runtime mints for the eligible piece and refuses the rest', async () => {
    const ok = io({ LOOM_HOME: h.home });
    expect(await runToken(['create', '--runtime', 'shuttle', '--label', 'shuttle · cli'], ok.io)).toBe(0);
    expect(ok.out.join('')).toMatch(/^loom_/);
    expect(ok.err.join('')).toMatch(/runtime:shuttle/);
    for (const p of ['box', 'plain', 'ghost']) {
      const bad = io({ LOOM_HOME: h.home });
      expect(await runToken(['create', '--runtime', p, '--label', `${p} · cli`], bad.io), p).toBe(1);
      expect(bad.err.join(''), p).toMatch(/can't mint a runtime token/);
    }
    // Not a role the CLI can name, and not two at once.
    expect(await runToken(['create', '--runtime', 'loom', '--label', 'x'], io({ LOOM_HOME: h.home }).io)).toBe(2);
    expect(await runToken(['create', '--runtime', 'shuttle', '--owner', '--label', 'x'], io({ LOOM_HOME: h.home }).io)).toBe(2);
    expect(loadTokens(h.home).filter((t) => t.role.startsWith('runtime:')).map((t) => t.label)).toEqual(['shuttle', 'shuttle · cli']);
  });
});

describe('token expiry', () => {
  let h: Household;
  beforeAll(() => { h = household('loom-roles-expiry-'); });
  afterAll(() => rmSync(h.home, { recursive: true, force: true }));
  const file = () => join(h.home, 'tokens.json');
  const records = () => (JSON.parse(readFileSync(file(), 'utf-8')) as { tokens: Record<string, unknown>[] }).tokens;
  const write = (tokens: unknown[]) => writeFileSync(file(), JSON.stringify({ v: 1, tokens }), { mode: 0o600 });

  it('an old record without expires stays valid; one with expires is accepted, and refused once past it', () => {
    const plain = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'plain' });
    const soon = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'soon' });
    const later = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'later' });
    const recs = records();
    expect(recs.every((r) => r.expires === undefined)).toBe(true);
    // Ahead of the clock, so the sweep test below still finds 'later' unexpired.
    const at = Date.now() + 10 * 86_400_000;
    write(recs.map((r) => r.label === 'soon' ? { ...r, expires: new Date(at).toISOString() } : r.label === 'later' ? { ...r, expires: new Date(at + 3600_000).toISOString() } : r));
    const resolver = new TokenResolver(h);
    expect(resolver.resolve(plain.token, at)).toEqual({ kind: 'agent', agent: 'art' });
    expect(resolver.resolve(soon.token, at - 1)).toEqual({ kind: 'agent', agent: 'art' });
    expect(resolver.resolve(soon.token, at)).toBeNull();
    expect(resolver.resolve(later.token, at)).toEqual({ kind: 'agent', agent: 'art' });
  });

  it('a malformed expires is a malformed record', () => {
    const recs = records();
    write(recs.map((r, i) => i === 0 ? { ...r, expires: 'tomorrow-ish' } : r));
    expect(() => loadTokens(h.home)).toThrow(/malformed/);
    write(recs.map((r, i) => i === 0 ? { ...r, expires: 7 } : r));
    expect(() => loadTokens(h.home)).toThrow(/malformed/);
    write(recs);
  });

  it('the next token write sweeps expired records, and only those', () => {
    write(records().map((r) => r.label === 'soon' ? { ...r, expires: '2020-01-01T00:00:00.000Z' } : r));
    expect(records().map((r) => r.label)).toContain('soon');
    createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'next' });
    expect(records().map((r) => r.label).sort()).toEqual(['later', 'next', 'plain']);
  });

  it('a review token expires two hours after it was minted', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    const { token, record } = mintReviewToken(h, 'shuttle', now);
    expect(record.role).toBe('review:shuttle');
    expect(record.expires).toBe(new Date(now.getTime() + REVIEW_TOKEN_TTL_MS).toISOString());
    const resolver = new TokenResolver(h, { runtimePieces: () => ['shuttle'] });
    expect(resolver.resolve(token, now.getTime() + REVIEW_TOKEN_TTL_MS - 1)).toEqual({ kind: 'review', piece: 'shuttle' });
    expect(resolver.resolve(token, now.getTime() + REVIEW_TOKEN_TTL_MS)).toBeNull();
    // Without a word on which piece is the runtime, or once it isn't, it reaches nothing.
    expect(new TokenResolver(h).resolve(token, now.getTime())).toBeNull();
    expect(new TokenResolver(h, { runtimePieces: () => [] }).resolve(token, now.getTime())).toBeNull();
    expect(new TokenResolver(h, { runtimePieces: () => ['shuttle', 'other'] }).resolve(token, now.getTime())).toBeNull();
  });

  it('a review record without expires (not core\'s) is refused', () => {
    const { token } = mintReviewToken(h, 'shuttle');
    write(records().map((r) => r.role === 'review:shuttle' ? (({ expires: _e, ...rest }) => rest)(r) : r));
    expect(new TokenResolver(h, { runtimePieces: () => ['shuttle'] }).resolve(token)).toBeNull();
  });
});

describe('the runtime and review roles over HTTP', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    h = household('loom-roles-http-');
    piece(h.home, 'shuttle', 'runtime');
    piece(h.home, 'notes');
    process.env.LOOM_HOME = h.home;
    const pieces = runtimePieces(process.env);
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.box = createToken(h, { role: { kind: 'piece', piece: 'shuttle', subject: 'thor' }, label: 'shuttle · thor' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'shuttle · runtime', runtimePieces: pieces }).token;
    handle = await startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const call = (path: string, token: string | undefined, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  it('a runtime token mints a review token that expires two hours out', async () => {
    const before = Date.now();
    const r = await call('/api/loom/review/token', tok.runtime);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const got = await r.json() as { token: string; expires: string };
    expect(got.token).toMatch(/^loom_/);
    const exp = Date.parse(got.expires);
    expect(exp).toBeGreaterThanOrEqual(before + REVIEW_TOKEN_TTL_MS);
    expect(exp).toBeLessThanOrEqual(Date.now() + REVIEW_TOKEN_TTL_MS);
    tok.review = got.token;
    const rec = loadTokens(h.home).find((t) => t.role === 'review:shuttle');
    expect(rec?.expires).toBe(got.expires);
  });

  it('nothing but a runtime token mints one: not a review token, owner, agent, piece credential or nobody', async () => {
    for (const k of ['review', 'owner', 'art', 'box'] as const) {
      expect((await call('/api/loom/review/token', tok[k])).status, k).toBe(403);
    }
    expect((await call('/api/loom/review/token', undefined)).status).toBe(401);
    expect((await call('/api/loom/review/token', 'loom_nope')).status).toBe(401);
  });

  it('the review-token route is POST, JSON, no Origin', async () => {
    expect((await fetch(`${base}/api/loom/review/token`, { headers: { authorization: `Bearer ${tok.runtime}` } })).status).toBe(405);
    expect((await call('/api/loom/review/token', tok.runtime, {}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call('/api/loom/review/token', tok.runtime, {}, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('a runtime holds a bounded number of live review tokens', async () => {
    const live = () => loadTokens(h.home).filter((t) => t.role === 'review:shuttle' && !t.revoked).length;
    while (live() < REVIEW_TOKENS_LIVE_MAX) expect((await call('/api/loom/review/token', tok.runtime)).status).toBe(200);
    expect((await call('/api/loom/review/token', tok.runtime)).status).toBe(429);
  });

  it('every existing route refuses both roles', async () => {
    // The allowlist: runtime mints review tokens, writes conversation turns (t-1741), delivers (t-1744),
    // writes audit entries and reads the scorecards and review settings; review takes, finishes, scores and finds (t-1742).
    expect(ROLE_ROUTES).toEqual({ runtime: ['review/token', 'conversations/turn', 'deliver', 'audit', 'scorecards', 'review/config', 'people/ensure', 'people/merge', 'comms/adapter', 'comms/activity'], review: ['audit/take', 'audit/done', 'scores', 'findings'] });
    const mcp = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    for (const k of ['runtime', 'review'] as const) {
      for (const p of ['/', '/mcp', '/agents/art/mcp', '/agents/art/']) {
        expect((await call(p, tok[k], mcp, { accept: 'application/json, text/event-stream' })).status, `${k} ${p}`).toBe(403);
      }
      expect((await call('/cli', tok[k], { argv: ['recall', 'x'] })).status, `${k} /cli`).toBe(403);
      // A piece's API, its own included, and any piece's store.
      for (const p of ['/api/shuttle/run', '/api/notes/x', '/api/loom/store/shuttle/get', '/api/loom/store/notes/list', '/api/loom/poll']) {
        expect((await call(p, tok[k], { collection: 'c', key: 'k' })).status, `${k} ${p}`).toBe(403);
      }
      // review/config is a GET, and the runtime's: POST is 405 for anyone, GET 403 for review.
      expect((await call('/api/loom/review/config', tok[k], {})).status, `${k} POST review/config`).toBe(405);
      if (k === 'review') expect((await fetch(`${base}/api/loom/review/config`, { headers: { authorization: `Bearer ${tok[k]}` } })).status).toBe(403);
      // The page: no session from the login form, no page by bearer.
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin' },
        body: new URLSearchParams({ token: tok[k] }).toString(),
      });
      expect(login.headers.get('set-cookie') ?? '', `${k} login`).not.toMatch(/loom_ui=[^;]+/);
      const page = await fetch(`${base}/mind`, { redirect: 'manual', headers: { authorization: `Bearer ${tok[k]}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } });
      expect(page.status, `${k} page`).not.toBe(200);
    }
    // The control: the owner does reach the page.
    expect((await fetch(`${base}/mind`, { headers: { authorization: `Bearer ${tok.owner}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } })).status).toBe(200);
  });

  it('an expired token is refused everywhere (401), whatever its role', async () => {
    const recs = (JSON.parse(readFileSync(join(h.home, 'tokens.json'), 'utf-8')) as { tokens: Record<string, unknown>[] }).tokens;
    const past = '2020-01-01T00:00:00.000Z';
    writeFileSync(join(h.home, 'tokens.json'), JSON.stringify({ v: 1, tokens: recs.map((r) => r.label === 'owner' ? r : { ...r, expires: past }) }), { mode: 0o600 });
    expect((await call('/api/loom/review/token', tok.runtime)).status).toBe(401);
    expect((await call('/api/loom/review/token', tok.review)).status).toBe(401);
    expect((await call('/api/shuttle/run', tok.box)).status).toBe(401);
    expect((await call('/cli', tok.art, { argv: ['recall', 'x'] })).status).toBe(401);
    expect((await call('/mcp', tok.art, {})).status).toBe(401);
    // The owner's record had none, and still works.
    expect((await fetch(`${base}/mind`, { headers: { authorization: `Bearer ${tok.owner}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } })).status).toBe(200);
  });

  it('a runtime token stops working once its piece isn\'t the runtime', async () => {
    const fresh = createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'shuttle · runtime 2', runtimePieces: ['shuttle'] }).token;
    // The sweep dropped every expired review token, so there's room again.
    expect((await call('/api/loom/review/token', fresh)).status).toBe(200);
    // A second piece claims the runtime role: the household has no one runtime now.
    piece(h.home, 'impostor', 'runtime');
    expect((await call('/api/loom/review/token', fresh)).status).toBe(401);
    rmSync(join(h.home, 'pieces', 'impostor'), { recursive: true, force: true });
    expect((await call('/api/loom/review/token', fresh)).status).toBe(200);
  });
});
