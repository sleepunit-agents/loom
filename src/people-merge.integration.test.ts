/**
 * POST /api/loom/people/merge, `loom person merge` and the person_merge tool
 * (docs/specs/person-cards.md, "Merge"): who may make two cards one, and who may not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { runtimePieces } from './cli/pieces-managed.js';
import { runCliCaptured } from './cli/test-helpers.js';
import { parseCliRequest } from './transport/cli-endpoint.js';
import { PeopleStore } from './backends/people.js';
import { commonsPeoplePath, openHouseholdPeople } from './backends/people-household.js';
import { personMerge } from './tools/person.js';

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

describe('people/merge: the owner and the runtime over HTTP, the owner at the shell, an agent with person_merge', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  /** Two cards for one person, the second on mark's side. */
  const pair = (from: string, into: string) => {
    const art = openHouseholdPeople(h, 'art', agentDir(h, 'art'))!;
    try { art.write({ slug: into, name: into.toUpperCase(), summary: 'Art knows them.', where: { slack: { value: `U${into.length}` } } }); } finally { art.close(); }
    const mark = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'))!;
    try { mark.write({ slug: from, name: from.toUpperCase(), summary: 'Mark knows them.', where: { discord: { value: `${from.length}` } } }); } finally { mark.close(); }
  };
  const dirRow = (slug: string) => {
    const st = new PeopleStore({ dbPath: commonsPeoplePath(h), readonly: true });
    try { return { row: st.getRow(slug), merged: st.mergeOf(slug) }; } finally { st.close(); }
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-merge-e2e-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['mark'] }] }));
    piece(home, 'shuttle', {});
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

  const post = (b: unknown, token?: string) => fetch(`http://127.0.0.1:${handle.port}/api/loom/people/merge`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

  it('a household owner merges, recorded by name; the answer counts each agent, and from is a redirect', async () => {
    pair('gracie', 'grace-aquino');
    const r = await post({ from: 'gracie', into: 'grace-aquino' }, tok.owner);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ from: 'gracie', into: 'grace-aquino', merged_by: 'jonathan', where_added: { discord: ['6'] },
      agents: { art: { card: 'noted' }, mark: { card: 'moved' } } });
    expect(dirRow('gracie')).toMatchObject({ row: { archive_reason: 'merged into grace-aquino' }, merged: { into: 'grace-aquino', by: 'jonathan' } });
    // A second merge of it elsewhere is a conflict; a missing card a 404; a bad body a 400.
    const again = await post({ from: 'gracie', into: 'nobody-else' }, tok.owner);
    expect(again.status).toBe(409);
    expect((await post({ from: 'nobody', into: 'grace-aquino' }, tok.owner)).status).toBe(404);
    expect((await post({ from: '../x', into: 'grace-aquino' }, tok.owner)).status).toBe(400);
    expect((await post({ from: 'grace-aquino', into: 'grace-aquino' }, tok.owner)).status).toBe(400);
  });

  it('the runtime merges (and dry-runs, writing nothing)', async () => {
    pair('pk', 'patrick-kells');
    const dry = await post({ from: 'pk', into: 'patrick-kells', dry_run: true }, tok.runtime);
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dry_run: true, merged_by: 'runtime:runtime' });
    expect(dirRow('pk').merged).toBeNull();
    expect((await post({ from: 'pk', into: 'patrick-kells' }, tok.runtime)).status).toBe(200);
    expect(dirRow('pk').merged).toMatchObject({ by: 'runtime:runtime' });
  });

  it('an agent token, an agent owner, a piece, a peer and no token are refused, and nothing is merged', async () => {
    pair('dp', 'daniel-pollock');
    const agent = await post({ from: 'dp', into: 'daniel-pollock' }, tok.art);
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as { error: string }).error).toMatch(/person_merge/);
    for (const t of [tok.loren, tok.shuttle, tok.peer]) expect((await post({ from: 'dp', into: 'daniel-pollock' }, t)).status).toBe(403);
    expect((await post({ from: 'dp', into: 'daniel-pollock' })).status).toBe(401);
    expect(dirRow('dp').merged).toBeNull();
  });

  it('`loom person merge`: the owner at the shell; a piece\'s process is exit 5, a missing card exit 3; --dry-run is anyone\'s', async () => {
    pair('al', 'allison-thomson');
    const env = { LOOM_HOME: h.home, LOOM_CONTEXT_DIR: agentDir(h, 'art') };
    const dry = await runCliCaptured(['person', 'merge', 'al', 'allison-thomson', '--dry-run'], { env: { ...env, LOOM_PIECE_NAME: 'shuttle' } });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^would merge al into allison-thomson\n {2}where: discord \+2\n/);
    expect(dry.stdout).toMatch(/mark: card moved · 0 memories/);
    expect(dry.stdout).toMatch(/not done: gates: rename al to allison-thomson in every agent's gates/);
    expect(dirRow('al').merged).toBeNull();
    const piece = await runCliCaptured(['person', 'merge', 'al', 'allison-thomson'], { env: { ...env, LOOM_PIECE_NAME: 'shuttle' } });
    expect(piece.code).toBe(5);
    expect(dirRow('al').merged).toBeNull();
    expect((await runCliCaptured(['person', 'merge', 'nobody', 'allison-thomson'], { env })).code).toBe(3);
    expect((await runCliCaptured(['person', 'merge', 'al'], { env })).code).toBe(2);
    const real = await runCliCaptured(['person', 'merge', 'al', 'allison-thomson', '--json'], { env });
    expect(real.code).toBe(0);
    expect(JSON.parse(real.stdout)).toMatchObject({ dry_run: false, merged_by: 'owner' });
    // Reading the old slug answers the merged card, with the note.
    const show = await runCliCaptured(['person', 'show', 'al'], { env });
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^## ALLISON-THOMSON \(allison-thomson\)/);
    expect(show.stdout).toMatch(/al was merged into allison-thomson/);
  });

  it('never over POST /cli', () => {
    expect(parseCliRequest({ argv: ['person', 'merge', 'a', 'b'] })).toMatch(/^refused: person merge is the owner's .*person_merge/);
  });

  it('an agent of the household merges with person_merge, recorded as itself', async () => {
    pair('lc', 'loren-clawitter');
    const out = JSON.parse(await personMerge(agentDir(h, 'mark'), { from: 'lc', into: 'loren-clawitter' }));
    expect(out).toMatchObject({ merged_by: 'mark', agents: { mark: { card: 'moved' } }, card: { slug: 'loren-clawitter', summary: 'Mark knows them.\nMerged lc (LC) ' + new Date().toISOString().slice(0, 10) } });
    expect(dirRow('lc').merged).toMatchObject({ by: 'mark' });
    // Mark's call reached only Mark's store: Art's isn't in the answer, and not_done says ask the owner.
    expect(Object.keys(out.agents)).toEqual(['mark']);
    expect(out.not_done[0]).toMatch(/^art: .*ask the owner/);
    expect(await personMerge(agentDir(h, 'mark'), { from: 'lc', into: 'jonathan' })).toMatch(/^Error: lc was already merged into loren-clawitter/);
  });
});
