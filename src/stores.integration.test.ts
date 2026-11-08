/**
 * Piece storage end to end (docs/specs/piece-storage.md): the grant loom hands a
 * piece's process, the store's HTTP API, and `loom store` with what loom gives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createToken, loadHousehold, type Household } from './household.js';
import { mintGrant, PieceStore, readGrant } from './stores.js';
import { runCliCaptured } from './cli/test-helpers.js';

describe('piece storage, end to end', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const tok: Record<string, string> = {};
  const saved = { LOOM_HOME: process.env.LOOM_HOME };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-store-e2e-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['mark'] }] }));
    // A managed piece whose package declares a store; its API answers with the grant loom gave it.
    const dir = join(home, 'pieces', 'notes');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'notes', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'notes', version: '1', installed: 'x',
      bins: ['loom-notes'], loom: { settings: [], services: [], store: { gates: { writers: 'owner' }, convos: { writers: 'piece' }, inbox: { writers: 'agent' } } } }));
    const bin = join(dir, 'current', 'cli');
    writeFileSync(bin, `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => console.log(JSON.stringify({ body: { grant: process.env.LOOM_STORE_GRANT ?? null, piece: process.env.LOOM_PIECE_NAME } })));
`);
    chmodSync(bin, 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    symlinkSync(bin, join(home, 'pieces', 'bin', 'loom-notes'));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.piece = createToken(h, { role: { kind: 'piece', piece: 'notes', subject: 'svc' }, label: 'notes svc' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
  });
  afterAll(async () => {
    if (saved.LOOM_HOME === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved.LOOM_HOME;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, token?: string) => fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  it("a piece's process gets a grant that says who it's serving", async () => {
    const asArt = await (await post('/api/notes/x', {}, tok.art)).json() as { grant: string; piece: string };
    expect(asArt.piece).toBe('notes');
    expect(readGrant(h.home, asArt.grant)).toMatchObject({ piece: 'notes', agent: 'art' });
    expect(readGrant(h.home, asArt.grant)!.owner).toBeUndefined();
    const asOwner = await (await post('/api/notes/x', {}, tok.owner)).json() as { grant: string };
    expect(readGrant(h.home, asOwner.grant)).toMatchObject({ piece: 'notes', owner: true, who: 'jonathan' });
  });

  it("the store's API: the piece's credential as the piece, a household owner as the owner, nobody else", async () => {
    expect((await post('/api/loom/store/notes/put', { collection: 'convos', key: 'art/slack/loren', doc: { n: 1 } }, tok.piece)).status).toBe(200);
    expect((await post('/api/loom/store/notes/put', { collection: 'gates', key: 'loren', doc: { tier: 3 } }, tok.piece)).status).toBe(403);
    expect((await post('/api/loom/store/notes/put', { collection: 'gates', key: 'loren', doc: { tier: 1 } }, tok.owner)).status).toBe(200);
    for (const t of [tok.art, tok.loren]) expect((await post('/api/loom/store/notes/get', { collection: 'gates', key: 'loren' }, t)).status).toBe(403);
    expect((await post('/api/loom/store/other/get', { collection: 'gates', key: 'loren' }, tok.piece)).status).toBe(403);
    const got = await (await post('/api/loom/store/notes/get', { collection: 'gates', key: 'loren' }, tok.owner)).json() as { doc: unknown; by: string };
    expect(got).toMatchObject({ doc: { tier: 1 }, by: 'jonathan' });
    expect((await post('/api/loom/store/notes/put', { collection: 'gates', key: 'loren', doc: { tier: 2 }, ifRev: 0 }, tok.owner)).status).toBe(409);
  });

  it('`loom store`: a grant writes what it allows, the piece itself its own collections, anyone else nothing', async () => {
    const run = async (args: string[], env: Record<string, string>, stdin?: string) =>
      runCliCaptured(['store', ...args], { stdin, env: { LOOM_HOME: h.home, ...env } });
    const owner = mintGrant(h.home, { piece: 'notes', owner: true, who: 'jonathan' });
    const agent = mintGrant(h.home, { piece: 'notes', agent: 'art' });
    expect((await run(['notes', 'put', 'gates', 'mark', '--if-rev', '0'], { LOOM_STORE_GRANT: owner }, '{"tier":2}')).code).toBe(0);
    expect((await run(['notes', 'put', 'gates', 'mark'], { LOOM_STORE_GRANT: agent }, '{"tier":3}')).code).toBe(5);
    expect((await run(['notes', 'put', 'inbox', 'art/1'], { LOOM_STORE_GRANT: agent }, '{"m":"hi"}')).code).toBe(0);
    expect((await run(['notes', 'put', 'inbox', 'mark/1'], { LOOM_STORE_GRANT: agent }, '{"m":"hi"}')).code).toBe(5);
    expect((await run(['notes', 'put', 'convos', 'k'], { LOOM_PIECE_NAME: 'notes', LOOM_STORE_GRANT: '' }, '{"a":1}')).code).toBe(0);
    expect((await run(['notes', 'put', 'gates', 'k'], { LOOM_PIECE_NAME: 'notes', LOOM_STORE_GRANT: '' }, '{"a":1}')).code).toBe(5);
    expect((await run(['notes', 'put', 'convos', 'k2'], { LOOM_PIECE_NAME: 'someone-else', LOOM_STORE_GRANT: '' }, '{"a":1}')).code).toBe(5);
    expect((await run(['notes', 'put', 'gates', 'mark', '--if-rev', '0'], { LOOM_STORE_GRANT: owner }, '{"tier":9}')).code).toBe(4);
    const st = new PieceStore(h.home, 'notes');
    try { expect(st.get('gates', 'mark')).toMatchObject({ doc: { tier: 2 }, by: 'jonathan' }); } finally { st.close(); }
    const got = await run(['notes', 'get', 'gates', 'mark'], { LOOM_STORE_GRANT: '' });
    expect(JSON.parse(got.stdout)).toMatchObject({ doc: { tier: 2 } });
  });
});
