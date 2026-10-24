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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
import { harnessInit } from './tools/harness.js';

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

  it('using a token never rewrites tokens.json, so it can\'t undo a revoke that lands meanwhile', () => {
    const { token } = createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const before = readFileSync(join(h.home, 'tokens.json'), 'utf-8');
    const r = new TokenResolver(h);
    expect(r.resolve(token)).toEqual({ kind: 'owner' });
    expect(readFileSync(join(h.home, 'tokens.json'), 'utf-8')).toBe(before);
    expect(loadTokens(h.home)[0].last_used).toBeTruthy();
    revokeToken(h, 'page');
    expect(r.resolve(token)).toBeNull();
    expect(loadTokens(h.home)[0]).toMatchObject({ revoked: expect.any(String), last_used: expect.any(String) });
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

  it('over MCP, an agent token can\'t make harness_init write a file outside its stack', async () => {
    const art = await connect(handle.port, tok.art);
    const victim = join(h.home, 'agents', 'mark', 'IDENTITY.md');
    const before = readFileSync(victim, 'utf-8');
    const r = await art.callTool({ name: 'harness_init', arguments: { name: 'x', target: victim } });
    expect(textOf(r)).toMatch(/over the network/);
    expect(readFileSync(victim, 'utf-8')).toBe(before);
    await art.close();
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

// Fixes from the security review of PR #164, each pinned so the old code fails.
describe('household hardening', () => {
  let h: Household;
  beforeEach(() => { h = makeHousehold(); });
  afterEach(async () => {
    await closeAllBackends();
    rmSync(h.home, { recursive: true, force: true });
  });

  it('harness_init never writes a target over the network, and only instruction files locally', async () => {
    const victim = join(h.home, 'agents', 'mark', 'IDENTITY.md');
    const before = readFileSync(victim, 'utf-8');
    expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'x', target: victim }, { remote: true })).toMatch(/over the network/);
    expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'x', target: victim })).toMatch(/must be a harness instruction file/);
    expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'x', target: join(h.home, '.bashrc') })).toMatch(/must be a harness instruction file/);
    expect(readFileSync(victim, 'utf-8')).toBe(before);
    await expect(harnessInit(join(h.home, 'agents', 'art'), { name: 'z\ntouch /tmp/pwn\n#' })).rejects.toThrow(/control characters/);
  });

  it('the household daemon refuses env that would merge every agent into one store or name', async () => {
    for (const v of ['LOOM_SQLITE_DB_PATH', 'LOOM_KNOWLEDGE_DB_PATH', 'LOOM_IDENTITY']) {
      process.env[v] = join(h.home, 'shared');
      try {
        await expect(startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h })).rejects.toThrow(new RegExp(v));
      } finally {
        delete process.env[v];
      }
    }
  });

  it('a broken tokens.json fails closed (503, no path) without locking out the env owner token', async () => {
    const agentTok = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'a' }).token;
    const handle = await startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h, token: 'env-owner' });
    try {
      writeFileSync(join(h.home, 'tokens.json'), JSON.stringify({ v: 1, tokens: [{ label: 'x', role: 'owner', sha256: 'z'.repeat(64), created: 'now' }] }), { mode: 0o600 });
      const res = await fetch(`http://127.0.0.1:${handle.port}/cli`, {
        method: 'POST', headers: { authorization: `Bearer ${agentTok}`, 'content-type': 'application/json' }, body: JSON.stringify({ argv: ['wake'] }),
      });
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(h.home);
      const owner = await connect(handle.port, 'env-owner');
      expect(textOf(await owner.callTool({ name: 'identity', arguments: {} }))).toContain('Art E Fish');
      await owner.close();
    } finally {
      await handle.close();
    }
  });

  it('a group- or world-writable tokens.json is not trusted', () => {
    createToken(h, { role: { kind: 'owner' }, label: 'page' });
    chmodSync(join(h.home, 'tokens.json'), 0o664);
    expect(() => loadTokens(h.home)).toThrow(/writable by group or others/);
  });

  it('a revoke is seen even when the mtime doesn\'t change (the file is replaced, so its inode does)', () => {
    const { token } = createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const r = new TokenResolver(h);
    expect(r.resolve(token)).not.toBeNull();
    const st = statSync(join(h.home, 'tokens.json'));
    revokeToken(h, 'page');
    utimesSync(join(h.home, 'tokens.json'), st.atime, st.mtime);
    expect(r.resolve(token)).toBeNull();
  });

  it('a live holder\'s lock makes a second writer wait and refuse; a dead holder\'s is taken over', () => {
    createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const lock = join(h.home, '.household.lock');
    // A live holder: this test process's parent (always running).
    writeFileSync(lock, String(process.ppid));
    const t0 = Date.now();
    expect(() => revokeToken(h, 'page')).toThrow(/held by another loom process/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
    expect(loadTokens(h.home)[0].revoked).toBeUndefined();
    expect(readFileSync(lock, 'utf-8')).toBe(String(process.ppid));
    // A dead holder: a pid that isn't running.
    writeFileSync(lock, '2147483646');
    expect(revokeToken(h, 'page').revoked).toBeTruthy();
    expect(existsSync(lock)).toBe(false);
  }, 15_000);

  it('a lock left by a live process is never broken just for being old', () => {
    createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const lock = join(h.home, '.household.lock');
    writeFileSync(lock, String(process.ppid));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    expect(() => revokeToken(h, 'page')).toThrow(/held by another/);
    rmSync(lock);
  }, 15_000);

  it('a chmod alone is noticed: the token cache rechecks permissions', () => {
    const { token } = createToken(h, { role: { kind: 'owner' }, label: 'page' });
    const r = new TokenResolver(h);
    expect(r.resolve(token)).not.toBeNull();
    chmodSync(join(h.home, 'tokens.json'), 0o620);
    expect(() => r.resolve(token)).toThrow(/writable by group or others/);
  });

  it('a local managed-block write can\'t be redirected by a planted temp-file symlink or a symlinked target', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'loom-repo-'));
    try {
      const rc = join(repo, 'fake_bashrc');
      writeFileSync(rc, 'original rc\n');
      writeFileSync(join(repo, 'CLAUDE.md'), 'touch PWNED\n');
      symlinkSync(rc, join(repo, 'CLAUDE.md.loom.tmp'));
      expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'claude-code', target: join(repo, 'CLAUDE.md') })).toMatch(/Managed block/);
      expect(readFileSync(rc, 'utf-8')).toBe('original rc\n');
      // A CLAUDE.md that's a symlink to an rc file is judged by the real file.
      const link = join(repo, 'sub', 'CLAUDE.md');
      mkdirSync(join(repo, 'sub'));
      symlinkSync(rc, link);
      expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'claude-code', target: link })).toMatch(/must be a harness instruction file/);
      expect(readFileSync(rc, 'utf-8')).toBe('original rc\n');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // The dotfiles case still works: a CLAUDE.md linked to a real CLAUDE.md is
      // written through, and stays a link.
      mkdirSync(join(repo, 'dotfiles'));
      writeFileSync(join(repo, 'dotfiles', 'CLAUDE.md'), '# mine\n');
      const dot = join(repo, 'home', 'CLAUDE.md');
      mkdirSync(join(repo, 'home'));
      symlinkSync(join(repo, 'dotfiles', 'CLAUDE.md'), dot);
      expect(await harnessInit(join(h.home, 'agents', 'art'), { name: 'claude-code', target: dot })).toMatch(/Managed block/);
      expect(lstatSync(dot).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(repo, 'dotfiles', 'CLAUDE.md'), 'utf-8')).toMatch(/# mine[\s\S]*loom:start/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('agent directories must be real directories: no symlinks into another agent\'s stack', async () => {
    symlinkSync('art', join(h.home, 'agents', 'evil'));
    expect(() => addAgent(h, 'evil')).toThrow(/real directory/);
    rmSync(join(h.home, 'agents', 'mark'), { recursive: true });
    symlinkSync('art', join(h.home, 'agents', 'mark'));
    await expect(startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h })).rejects.toThrow(/real directory/);
    const home2 = mkdtempSync(join(tmpdir(), 'loom-init-link-'));
    try {
      mkdirSync(join(home2, 'data', 'solo'), { recursive: true });
      writeFileSync(join(home2, 'data', 'solo', 'IDENTITY.md'), '# Solo\n');
      symlinkSync(join(home2, 'data', 'solo'), join(home2, 'solo'));
      expect(() => initHousehold(home2, 'solo')).toThrow(/is a symlink/);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  it('a mistyped /agents/ path is a 404, never the default agent', async () => {
    const ownerTok = createToken(h, { role: { kind: 'owner' }, label: 'o' }).token;
    const handle = await startHttpServer({ contextDir: join(h.home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    try {
      for (const p of ['/agents/Mark/', '/agents/mark%2Fmcp', '/agents/', '/agents', '/AGENTS/mark/mcp', '/%61gents/mark/mcp', '/x/agents/mark/mcp', '/agents/mark/elsewhere']) {
        const res = await fetch(`http://127.0.0.1:${handle.port}${p}`, {
          method: 'POST', headers: { authorization: `Bearer ${ownerTok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
        });
        expect(res.status).toBe(404);
      }
    } finally {
      await handle.close();
    }
  });
});
