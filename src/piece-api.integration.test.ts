/**
 * A piece's API (docs/extensions.md, "The API"): POST /api/<piece>/<path> runs
 * `loom-<piece> api --json`. Pins that
 *  - owner and agent tokens call as themselves; a piece credential calls only
 *    its own piece, as its subject; a peer, nobody and a revoked token can't;
 *  - a piece credential reaches nothing else: no MCP, no /cli, no page, no
 *    other agent;
 *  - the route is POST + JSON + no Origin, and the piece's answer is checked;
 *  - the role string round-trips, and "loom" is never a piece.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createToken, loadHousehold, parseRole, revokeToken, roleString, type Household } from './household.js';

describe('a piece\'s API', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let bin: string;
  const tok: Record<string, string> = {};
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-piece-api-'));
    for (const agent of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', agent), { recursive: true });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${agent}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art' }));
    h = loadHousehold(home)!;
    bin = join(home, 'bin');
    mkdirSync(bin);
    // Echoes what core sent it; a few paths misbehave on purpose.
    writeFileSync(join(bin, 'loom-thing'), `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const r = JSON.parse(s);
  if (process.argv[2] !== 'api' || process.argv[3] !== '--json') process.exit(2);
  if (r.path === 'conflict') return console.log(JSON.stringify({ status: 409, body: { error: 'taken' } }));
  if (r.path === 'garbage') return console.log('not json');
  if (r.path === 'five-hundred') return console.log(JSON.stringify({ status: 500, body: {} }));
  if (r.path === 'slow') return setTimeout(() => console.log(JSON.stringify({ body: 'slow' })), 1500);
  if (r.path === 'big') return process.stdout.write(JSON.stringify({ body: 'x'.repeat(r.body.n) }));
  console.log(JSON.stringify({ body: r }));
});
`);
    writeFileSync(join(bin, 'loom-other'), '#!/bin/sh\necho \'{"body":"other"}\'\n');
    // Installed, so only the guard can keep "loom" from being a piece.
    writeFileSync(join(bin, 'loom-loom'), '#!/bin/sh\necho \'{"body":"core impersonated"}\'\n');
    for (const f of ['loom-thing', 'loom-other', 'loom-loom']) chmodSync(join(bin, f), 0o755);
    process.env.PATH = [bin, savedPath].join(delimiter);
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.slack = createToken(h, { role: { kind: 'agent', agent: 'art', service: 'slack' }, label: 'art · house h-80 on loom' }).token;
    tok.house = createToken(h, { role: { kind: 'agent', agent: 'art', house: 'h-104' }, label: 'art · house h-104 on loom' }).token;
    tok.svcHouse = createToken(h, { role: { kind: 'agent', agent: 'art', service: 'slack', house: 'h-105' }, label: 'art · house h-105 on loom' }).token;
    tok.peer = createToken(h, { role: { kind: 'peer', name: 'phil' }, label: 'peer' }).token;
    tok.box = createToken(h, { role: { kind: 'piece', piece: 'thing', subject: 'thor' }, label: 'thing · thor' }).token;
    tok.ghost = createToken(h, { role: { kind: 'piece', piece: 'ghost', subject: 'x' }, label: 'ghost · x' }).token;
    tok.gone = createToken(h, { role: { kind: 'piece', piece: 'thing', subject: 'old' }, label: 'thing · old' }).token;
    revokeToken(h, 'thing · old');
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    process.env.PATH = savedPath;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const call = (path: string, token: string | undefined, body: unknown = { hi: 1 }, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  it('owner and agent tokens call as themselves; a piece credential as its subject', async () => {
    const asOwner = await call('/api/thing/boxes/list', tok.owner);
    expect(asOwner.status).toBe(200);
    expect(await asOwner.json()).toEqual({ caller: { kind: 'owner', who: 'owner', agents: '*' }, path: 'boxes/list', body: { hi: 1 } });
    expect((await (await call('/api/thing/', tok.art)).json() as { caller: unknown }).caller).toEqual({ kind: 'agent', agent: 'art' });
    const asBox = await call('/api/thing/poll', tok.box, { facts: { gpu: 'none' } });
    expect(await asBox.json()).toEqual({ caller: { kind: 'piece', subject: 'thor' }, path: 'poll', body: { facts: { gpu: 'none' } } });
  });

  // t-1591: a service house's token says which service it is, so a piece can
  // tell its bridge from the agent's other bodies (shuttle's relay-take).
  it('a service house\'s token calls as its agent, with its service', async () => {
    const r = await call('/api/thing/', tok.slack);
    expect((await r.json() as { caller: unknown }).caller).toEqual({ kind: 'agent', agent: 'art', service: 'slack' });
  });

  // A house's token says which house it is, so a piece can grant one house something
  // (the secrets piece's requests) and nothing else of the agent's.
  it('a house\'s token calls as its agent, with its house (and its service, for a service house)', async () => {
    expect((await (await call('/api/thing/', tok.house)).json() as { caller: unknown }).caller).toEqual({ kind: 'agent', agent: 'art', house: 'h-104' });
    expect((await (await call('/api/thing/', tok.svcHouse)).json() as { caller: unknown }).caller).toEqual({ kind: 'agent', agent: 'art', service: 'slack', house: 'h-105' });
  });

  it('nobody, a peer, a revoked credential and another piece\'s credential get nothing', async () => {
    expect((await call('/api/thing/poll', undefined)).status).toBe(401);
    expect((await call('/api/thing/poll', 'loom_nope')).status).toBe(401);
    expect((await call('/api/thing/poll', tok.gone)).status).toBe(401);
    expect((await call('/api/thing/poll', tok.peer)).status).toBe(403);
    expect((await call('/api/other/poll', tok.box)).status).toBe(403);
    // A credential for a piece that isn't installed is still only that piece's.
    expect((await call('/api/thing/poll', tok.ghost)).status).toBe(403);
    expect((await call('/api/ghost/poll', tok.ghost)).status).toBe(404);
  });

  it('a piece credential reaches nothing else: no MCP, no /cli, no other agent, no page', async () => {
    const mcp = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    for (const p of ['/', '/mcp', '/agents/art/mcp', '/agents/mark/']) {
      const r = await call(p, tok.box, mcp, { accept: 'application/json, text/event-stream' });
      expect(r.status, p).toBe(403);
    }
    expect((await call('/cli', tok.box, { argv: ['recall', 'x'] })).status).toBe(403);
    const login = (token: string) => fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ token }).toString(),
    });
    // The control: the same request with the owner's token does get a session.
    expect((await login(tok.owner)).headers.get('set-cookie') ?? '').toMatch(/loom_ui=[^;]+/);
    expect((await login(tok.box)).headers.get('set-cookie') ?? '').not.toMatch(/loom_ui=[^;]+/);
    // Nor the page by bearer header (the owner's control first).
    expect((await fetch(`${base}/mind`, { headers: { authorization: `Bearer ${tok.owner}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } })).status).toBe(200);
    const page = await fetch(`${base}/mind`, { redirect: 'manual', headers: { authorization: `Bearer ${tok.box}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } });
    expect(page.status).not.toBe(200);
  });

  it('only POST with JSON and no Origin; an unknown piece, "loom" and a bad path are 404s', async () => {
    expect((await fetch(`${base}/api/thing/poll`, { headers: { authorization: `Bearer ${tok.owner}` } })).status).toBe(405);
    expect((await call('/api/thing/poll', tok.owner, {}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call('/api/thing/poll', tok.owner, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/nothing/poll', tok.owner)).status).toBe(404);
    expect((await call('/api/loom/poll', tok.owner)).status).toBe(404);
    expect((await call('/api/Thing/poll', tok.owner)).status).toBe(404);
    expect((await call('/api', tok.owner)).status).toBe(404);
    const big = await call('/api/thing/poll', tok.owner, { pad: 'x'.repeat(5 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/api/thing/poll`, { method: 'POST', headers: { authorization: `Bearer ${tok.owner}`, 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('an API answer may be bigger than a page (8 MB), and no bigger', async () => {
    const two = await call('/api/thing/big', tok.owner, { n: 2 * 1024 * 1024 });
    expect(two.status).toBe(200);
    expect(((await two.json()) as string).length).toBe(2 * 1024 * 1024);
    expect((await call('/api/thing/big', tok.owner, { n: 9 * 1024 * 1024 })).status).toBe(502);
  });

  it('passes the piece\'s own status through, and a broken answer is a 502', async () => {
    const c = await call('/api/thing/conflict', tok.owner);
    expect([c.status, await c.json()]).toEqual([409, { error: 'taken' }]);
    expect((await call('/api/thing/garbage', tok.owner)).status).toBe(502);
    expect((await call('/api/thing/five-hundred', tok.owner)).status).toBe(502);
  });

  it('a flood of API calls is refused past its queue, and never starves the page', async () => {
    const flood = Array.from({ length: 16 }, () => call('/api/thing/slow', tok.box));
    await new Promise((r) => setTimeout(r, 200));
    // The page's pieces still answer while every API slot is busy.
    const t0 = Date.now();
    const pieces = await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${tok.owner}` } });
    expect(pieces.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    const statuses = (await Promise.all(flood)).map((r) => r.status);
    expect(statuses.filter((x) => x === 503).length).toBe(4);
    expect(statuses.filter((x) => x === 200).length).toBe(12);
  });

  it('the piece role round-trips, and "loom" can\'t be a piece', () => {
    const r = parseRole('piece:box/thor.local');
    expect(r).toEqual({ kind: 'piece', piece: 'box', subject: 'thor.local' });
    expect(roleString(r!)).toBe('piece:box/thor.local');
    const svc = parseRole('agent:art/slack');
    expect(svc).toEqual({ kind: 'agent', agent: 'art', service: 'slack' });
    expect(roleString(svc!)).toBe('agent:art/slack');
    for (const bad of ['agent:art/', 'agent:art/Slack', 'agent:art/a/b', 'peer:phil/x']) expect(parseRole(bad), bad).toBeNull();
    expect(parseRole('agent:art@h-104')).toEqual({ kind: 'agent', agent: 'art', house: 'h-104' });
    expect(parseRole('agent:art/slack@h-105')).toEqual({ kind: 'agent', agent: 'art', service: 'slack', house: 'h-105' });
    expect(roleString(parseRole('agent:art/slack@h-105')!)).toBe('agent:art/slack@h-105');
    for (const bad of ['agent:art@', 'agent:art@H-1', 'agent:art@h-1@h-2', 'agent:art@h-1/slack', 'peer:phil@h-1']) expect(parseRole(bad), bad).toBeNull();
    for (const bad of ['piece:loom/x', 'piece:box/', 'piece:box/../x', 'piece:Box/x', 'piece:box/x/y', 'piece:box']) expect(parseRole(bad), bad).toBeNull();
  });
});
