/**
 * The household (docs/specs/household.md), phase 1: tokens, roles, and one
 * daemon serving several agents. The spec's pins:
 *  - an agent:<a> token reads and writes only agents/<a>/ (MCP and /cli);
 *  - the owner reaches the default agent, or another under /agents/<name>/;
 *  - a peer token sees only knowledge tools; unknown or revoked gets nothing;
 *  - only owner tokens log in to the page, and revoking one ends its sessions;
 *  - tokens.json never holds a token, and a plain context dir is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import {
  addAgent, contextFromHome, createToken, householdOf, initHousehold, loadHousehold, loadTokens, parseRole,
  revokeToken, TokenResolver, type Household,
} from './household.js';
import { closeAllBackends } from './backends/index.js';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

async function connect(port: number, token: string, path = '/'): Promise<Client> {
  const client = new Client({ name: 'household-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

function makeHousehold(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-household-'));
  for (const [agent, creed] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
    mkdirSync(join(home, 'agents', agent), { recursive: true });
    writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${creed}\n\nI am ${creed}.\n`);
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
  return loadHousehold(home)!;
}

describe('household files', () => {
  let h: Household;
  beforeEach(() => { h = makeHousehold(); });
  afterEach(() => rmSync(h.home, { recursive: true, force: true }));

  it('mints tokens that are shown once and stored only as sha256, in a 0600 file', () => {
    const { token, record } = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'Art · house on wunder' });
    expect(token).toMatch(/^loom_[A-Za-z0-9_-]{40,}$/);
    const file = readFileSync(join(h.home, 'tokens.json'), 'utf-8');
    expect(file).not.toContain(token);
    expect(file).toContain(record.sha256);
    expect(statSync(join(h.home, 'tokens.json')).mode & 0o777).toBe(0o600);
    expect(new TokenResolver(h).resolve(token)).toEqual({ kind: 'agent', agent: 'art' });
  });

  it('refuses a role for an agent the household lacks, a duplicate live label, and bad roles', () => {
    expect(() => createToken(h, { role: { kind: 'agent', agent: 'ghost' }, label: 'x' })).toThrow(/no agent named ghost/);
    createToken(h, { role: { kind: 'owner' }, label: 'page' });
    expect(() => createToken(h, { role: { kind: 'owner' }, label: 'page' })).toThrow(/already labeled/);
    for (const bad of ['admin', 'agent:', 'agent:Art', 'peer:../x']) expect(parseRole(bad)).toBeNull();
  });

  it('a revoke takes effect on the next resolve, even from another resolver already warm', () => {
    const { token } = createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const r = new TokenResolver(h);
    expect(r.resolve(token)).toEqual({ kind: 'owner' });
    revokeToken(h, 'page');
    expect(r.resolve(token)).toBeNull();
    expect(loadTokens(h.home)[0].revoked).toBeTruthy();
  });

  it('init moves a plain context dir into a household and leaves a symlink that still finds it', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-init-'));
    try {
      mkdirSync(join(home, 'solo'));
      writeFileSync(join(home, 'solo', 'IDENTITY.md'), '# Solo\n');
      const made = initHousehold(home, 'solo', { owner: 'pat' });
      expect(made.agents).toEqual(['solo']);
      expect(lstatSync(join(home, 'solo')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, 'agents', 'solo', 'IDENTITY.md'), 'utf-8')).toBe('# Solo\n');
      expect(householdOf(join(home, 'solo'))).toMatchObject({ agent: 'solo', household: { default: 'solo' } });
      expect(() => initHousehold(home, 'solo')).toThrow(/already has a household/);
      mkdirSync(join(home, 'agents', 'second'));
      expect(addAgent(loadHousehold(home)!, 'second').agents).toEqual(['solo', 'second']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a plain context dir belongs to no household, and LOOM_HOME is the only way a default comes from one', () => {
    const plain = mkdtempSync(join(tmpdir(), 'loom-plain-'));
    try {
      expect(householdOf(plain)).toBeNull();
      expect(contextFromHome({})).toBeUndefined();
      expect(contextFromHome({ LOOM_HOME: h.home })).toBe(join(h.home, 'agents', 'art'));
      expect(contextFromHome({ LOOM_HOME: h.home, LOOM_AGENT: 'mark' })).toBe(join(h.home, 'agents', 'mark'));
      expect(() => contextFromHome({ LOOM_HOME: h.home, LOOM_AGENT: 'ghost' })).toThrow(/isn't in the household/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('one daemon, several agents', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};

  beforeEach(async () => {
    h = makeHousehold();
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art body' }).token;
    tok.mark = createToken(h, { role: { kind: 'agent', agent: 'mark' }, label: 'mark body' }).token;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tok.peer = createToken(h, { role: { kind: 'peer', name: 'gabe' }, label: 'gabe' }).token;
    handle = await startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    await closeAllBackends();
    rmSync(h.home, { recursive: true, force: true });
  });

  it('each agent token is that agent: its own identity, its own memories, never the other\'s', async () => {
    const art = await connect(handle.port, tok.art);
    const mark = await connect(handle.port, tok.mark);
    expect(textOf(await art.callTool({ name: 'identity', arguments: {} }))).toContain('Art E Fish');
    expect(textOf(await mark.callTool({ name: 'identity', arguments: {} }))).toContain('Visual Mark');
    await art.callTool({ name: 'remember', arguments: { category: 'project', title: 'zebra kiln secret', content: 'only art knows the zebra kiln' } });
    expect(textOf(await art.callTool({ name: 'recall', arguments: { query: 'zebra kiln' } }))).toContain('zebra kiln secret');
    expect(textOf(await mark.callTool({ name: 'recall', arguments: { query: 'zebra kiln' } }))).not.toContain('zebra kiln secret');
    expect(existsSync(join(h.home, 'agents', 'art', 'memories.db'))).toBe(true);
    await art.close();
    await mark.close();
  });

  it('the owner gets the default agent, or another under /agents/<name>/; an agent can\'t reach another that way', async () => {
    const owner = await connect(handle.port, tok.owner);
    expect(textOf(await owner.callTool({ name: 'identity', arguments: {} }))).toContain('Art E Fish');
    await owner.close();
    const ownerOnMark = await connect(handle.port, tok.owner, '/agents/mark/');
    expect(textOf(await ownerOnMark.callTool({ name: 'identity', arguments: {} }))).toContain('Visual Mark');
    await ownerOnMark.close();
    await expect(connect(handle.port, tok.art, '/agents/mark/')).rejects.toThrow();
    const artOwnPath = await connect(handle.port, tok.art, '/agents/art/');
    expect(textOf(await artOwnPath.callTool({ name: 'identity', arguments: {} }))).toContain('Art E Fish');
    await artOwnPath.close();
    await expect(connect(handle.port, tok.owner, '/agents/ghost/')).rejects.toThrow();
  });

  it('a peer sees only knowledge tools; unknown and revoked tokens get nothing', async () => {
    const peer = await connect(handle.port, tok.peer);
    const names = (await peer.listTools()).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('knowledge_'))).toBe(true);
    await peer.close();
    await expect(connect(handle.port, 'loom_not-a-real-token')).rejects.toThrow();
    revokeToken(h, 'mark body');
    await expect(connect(handle.port, tok.mark)).rejects.toThrow();
  });

  it('a session can\'t be carried to another role by swapping tokens mid-session', async () => {
    const init = await fetch(`${base}/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.art}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    const sid = init.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    const hijack = await fetch(`${base}/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.mark}`, 'mcp-session-id': sid, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(401);
  });

  it('/cli runs as the token\'s agent, and a peer has no /cli', async () => {
    const cli = (t: string, argv: string[]) => fetch(`${base}/cli`, {
      method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv }),
    });
    const r = await cli(tok.mark, ['wake']);
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain('Visual Mark');
    expect((await cli(tok.peer, ['wake'])).status).toBe(404);
  });

  it('only owner tokens log in to the page, and revoking one ends its session', async () => {
    const login = (t: string) => fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(t)}`, redirect: 'manual',
    });
    expect((await login(tok.art)).status).toBe(401);
    expect((await login(tok.peer)).status).toBe(401);
    const ok = await login(tok.owner);
    expect(ok.status).toBe(303);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })).status).toBe(200);
    revokeToken(h, 'jonathan');
    expect((await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })).headers.get('location')).toBe('/login');
  });

  it('LOOM_BEARER_TOKEN, when set, is an owner token too', async () => {
    await handle.close();
    handle = await startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h, token: 'legacy-owner' });
    const c = await connect(handle.port, 'legacy-owner', '/agents/mark/');
    expect(textOf(await c.callTool({ name: 'identity', arguments: {} }))).toContain('Visual Mark');
    await c.close();
  });
});
