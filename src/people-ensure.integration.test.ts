/**
 * POST /api/loom/people/ensure and `loom person ensure` (docs/specs/person-cards.md, "Ensure"):
 * who may make a card on the owner's authority, and who may not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { runtimePieces } from './cli/pieces-managed.js';
import { mintGrant } from './stores.js';
import { runCliCaptured } from './cli/test-helpers.js';
import { parseCliRequest } from './transport/cli-endpoint.js';
import { PeopleStore } from './backends/people.js';
import { commonsPeoplePath } from './backends/people-household.js';
import { resolveSqliteDbPath } from './config.js';

function piece(home: string, name: string, loom: Record<string, unknown>): void {
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

const SOURCE = "shuttle gates (art's people), allowed by the owner 2026-11-02";
const body = (slug: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), role: 'Toxicologist', source: SOURCE,
    where: { slack: { value: `U${slug.length}${slug.replace(/[^a-z]/g, '').toUpperCase().slice(0, 8)} (Onterris)` } }, ...extra });

describe('people/ensure: the owner, a piece in an owner\'s action, the runtime; nobody else', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-ensure-e2e-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['mark'] }] }));
    piece(home, 'shuttle', { store: { people: { writers: 'owner' } } });
    piece(home, 'runtime', { role: 'runtime' });
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.shuttle = createToken(h, { role: { kind: 'piece', piece: 'shuttle', subject: 'svc' }, label: 'shuttle svc' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    tok.peer = createToken(h, { role: { kind: 'peer', name: 'pal' }, label: 'pal' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const post = (b: unknown, token?: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${handle.port}/api/loom/people/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(b) });
  const directoryCard = (slug: string) => {
    const st = new PeopleStore({ dbPath: commonsPeoplePath(h), readonly: true });
    try { return st.getRow(slug)?.card ?? null; } finally { st.close(); }
  };

  it('a household owner makes a card, and a second call only merges', async () => {
    const r = await post(body('grace-aquino'), tok.owner);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ slug: 'grace-aquino', created: true });
    expect(directoryCard('grace-aquino')).toMatchObject({ name: 'Grace Aquino', where: { slack: { value: 'U12GRACEAQU (Onterris)', source: SOURCE } } });
    const again = await (await post(body('grace-aquino', { name: 'Not Her', where: { discord: { value: '42' } } }), tok.owner)).json();
    expect(again).toMatchObject({ created: false, added: { discord: ['42'] } });
    expect(directoryCard('grace-aquino')!.name).toBe('Grace Aquino');
  });

  it("the runtime makes a card, its summary on the agent's relationship it names", async () => {
    const r = await post(body('pat-runtime', { agent: 'mark' }), tok.runtime);
    expect(r.status).toBe(200);
    const rel = new PeopleStore({ dbPath: resolveSqliteDbPath(agentDir(h, 'mark')), readonly: true });
    try { expect(rel.getRow('pat-runtime')!.card.summary).toBe(`Toxicologist. From ${SOURCE}.`); } finally { rel.close(); }
  });

  it("a piece's credential makes one only with the owner's grant loom gave its process", async () => {
    expect((await post(body('no-grant'), tok.shuttle)).status).toBe(403);
    expect((await post(body('agent-grant'), tok.shuttle, { 'x-loom-store-grant': mintGrant(h.home, { piece: 'shuttle', agent: 'art' }) })).status).toBe(403);
    expect((await post(body('other-piece'), tok.shuttle, { 'x-loom-store-grant': mintGrant(h.home, { piece: 'runtime', owner: true }) })).status).toBe(403);
    expect((await post(body('forged'), tok.shuttle, { 'x-loom-store-grant': 'e30.AAAA' })).status).toBe(403);
    for (const s of ['no-grant', 'agent-grant', 'other-piece', 'forged']) expect(directoryCard(s)).toBeNull();
    const ok = await post(body('with-grant'), tok.shuttle, { 'x-loom-store-grant': mintGrant(h.home, { piece: 'shuttle', owner: true, who: 'jonathan' }) });
    expect(ok.status).toBe(200);
    expect(directoryCard('with-grant')).not.toBeNull();
  });

  it('an agent, an agent owner, a peer and no token are refused, and nothing is written', async () => {
    const r = await post(body('by-agent'), tok.art);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/person_write/);
    expect((await post(body('by-loren'), tok.loren)).status).toBe(403);
    expect((await post(body('by-peer'), tok.peer)).status).toBe(403);
    expect((await post(body('by-nobody'))).status).toBe(401);
    for (const s of ['by-agent', 'by-loren', 'by-peer', 'by-nobody']) expect(directoryCard(s)).toBeNull();
  });

  it('a bad slug is a 400, a value on another card a 409', async () => {
    for (const slug of ['../x', 'Grace Aquino']) {
      const r = await post(body('x', { slug }), tok.owner);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/slug/);
    }
    const dup = await post(body('grace-again', { where: { slack: { value: 'U12GRACEAQU (Onterris)' } } }), tok.owner);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already on grace-aquino's card/);
    expect(directoryCard('grace-again')).toBeNull();
  });

  it('`loom person ensure`: the owner at the shell and an owner grant make cards; an agent grant or a piece\'s own process is exit 5', async () => {
    const run = (env: Record<string, string>, b: unknown) =>
      runCliCaptured(['person', 'ensure', '--json'], { stdin: JSON.stringify(b), env: { LOOM_HOME: h.home, LOOM_CONTEXT_DIR: agentDir(h, 'art'), ...env } });
    const owner = await run({}, body('cli-owner'));
    expect(owner.code).toBe(0);
    expect(JSON.parse(owner.stdout)).toMatchObject({ created: true });
    expect((await run({ LOOM_STORE_GRANT: mintGrant(h.home, { piece: 'shuttle', owner: true, who: 'jonathan' }) }, body('cli-grant'))).code).toBe(0);
    const agent = await run({ LOOM_STORE_GRANT: mintGrant(h.home, { piece: 'shuttle', agent: 'art' }) }, body('cli-agent'));
    expect(agent.code).toBe(5);
    expect(agent.stderr).toMatch(/person_write/);
    expect((await run({ LOOM_PIECE_NAME: 'shuttle' }, body('cli-piece'))).code).toBe(5);
    expect((await run({ LOOM_STORE_GRANT: 'nope.nope' }, body('cli-forged'))).code).toBe(5);
    for (const s of ['cli-agent', 'cli-piece', 'cli-forged']) expect(directoryCard(s)).toBeNull();
    expect(directoryCard('cli-owner')).not.toBeNull();
    expect(directoryCard('cli-grant')).not.toBeNull();
    // The flags form, and a dry run that writes nothing.
    const dry = await runCliCaptured(['person', 'ensure', 'cli-flags', '--name', 'Cli Flags', '--role', 'Tester', '--where', 'slack=U0FLAGS (Onterris)', '--dry-run'],
      { env: { LOOM_HOME: h.home, LOOM_CONTEXT_DIR: agentDir(h, 'art') } });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('would make a card');
    expect(directoryCard('cli-flags')).toBeNull();
    expect((await runCliCaptured(['person', 'ensure', '../x', '--name', 'X'], { env: { LOOM_HOME: h.home, LOOM_CONTEXT_DIR: agentDir(h, 'art') } })).code).toBe(1);
  });

  it('never over POST /cli: an agent token runs `loom person` there, but not ensure', () => {
    expect(parseCliRequest({ argv: ['person', 'ensure', 'x', '--name', 'X'] })).toMatch(/^refused: person ensure is the owner's/);
    expect(parseCliRequest({ argv: ['--json', 'person', 'ensure'] })).toMatch(/^refused/);
    expect(typeof parseCliRequest({ argv: ['person', 'show', 'x'] })).toBe('object');
  });
});
