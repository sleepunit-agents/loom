import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom } from '../foundation.js';
import { fixture, installFixture } from '../fixture.js';
import { FakeClock } from '../core/index.js';
import { PeopleStore } from '../backends/people.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { householdCommands } from '../core/household/commands.js';
import { runHouseholdClient } from './household-client.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'household-client-')); fixture(home);
  mkdirSync(join(home, 'commons'), { recursive: true });
  const people = new PeopleStore({ dbPath: join(home, 'commons', 'people.db') });
  people.write({ slug: 'guest', name: 'Guest' }); people.close();
  mkdirSync(join(home, 'agents', 'new-agent'), { recursive: true });
  const app = await startLoom({ home, next: true, clock: new FakeClock(), install: installFixture,
    authenticate: req => ({ viewer: { kind: 'member', id: req.headers.authorization === 'Bearer owner-token' ? 'jonathan' : 'pollock' }, valid: () => true }) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const tokenFile = join(home, 'token'); writeFileSync(tokenFile, 'owner-token');
  const run = async (args: string[], request: typeof fetch = fetch, env = { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile }) => {
    let stdout = '', stderr = ''; const bodies: string[] = [];
    const code = await runHouseholdClient(args, { stdout: s => stdout += s, stderr: s => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env }, {
      request: (url, init) => { bodies.push(String(init?.body)); return request(url, init); }, retry: async () => {},
    });
    return { code, stdout, stderr, bodies };
  };
  return { app, home, tokenFile, run };
}
const inputs: Record<string, unknown> = {
  setMember: { person: 'guest', agents: ['art'] }, removeMember: { person: 'guest' },
  addAgent: { agent: 'new-agent' }, setMemberProjects: { person: 'pollock', projects: ['other'] },
  setOwnedAgents: { person: 'pollock', agents: ['mark'] }, setAgentAccounts: { agent: 'art', accounts: { github: ['art-e-fish'] } },
  createProject: { slug: 'new-project', name: 'New project', members: [], agents: [], repositories: [] },
  setProjectMembers: { slug: 'new-project', members: ['pollock'] }, setProjectAgents: { slug: 'new-project', agents: ['art'] },
};
it('generates registry metadata/help and runs every household command through real HTTP', async () => {
  const { app, run, home } = await setup();
  const offered = app.operations.offered('http').filter(o => o.name.startsWith('household.'));
  expect(offered.map(o => o.cli)).toEqual(householdCommands);
  const help = await run(['--help']); expect(help.code).toBe(0);
  for (const command of householdCommands) {
    expect(help.stdout).toContain(command.name);
    const result = await run([command.name, JSON.stringify(inputs[command.name])]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const operation = offered.find(o => o.name === `household.${command.name}`)!;
    expect(operation.output.safeParse(JSON.parse(result.stdout)).success).toBe(true);
    expect(JSON.parse(result.bodies[0]).input).toEqual(inputs[command.name]);
  }
  const document = new HouseholdDatabase(app.db).document()!;
  expect(document.agents).toContain('new-agent');
  expect(document.members).not.toEqual(expect.arrayContaining([expect.objectContaining({ person: 'guest' })]));
  // No client opens a local app store, even if the invoking home is contradictory.
  const result = await run(['addAgent', '{"agent":"art"}'], fetch, { LOOM_URL: app.url, LOOM_TOKEN_FILE: join(home, 'token'), LOOM_HOME: '/missing-client-home' } as NodeJS.ProcessEnv & { LOOM_URL: string; LOOM_TOKEN_FILE: string });
  expect(result).toMatchObject({ code: 0, stderr: '' });
});
it('leaves all validation and owner authorization in the daemon', async () => {
  const { app, run, tokenFile } = await setup();
  const before = new HouseholdDatabase(app.db).document();
  expect(await run(['setMember', '{"person":"guest","agents":["art"],"actor":"jonathan"}'])).toMatchObject({ code: 1, stdout: '' });
  writeFileSync(tokenFile, 'reader-token');
  for (const command of householdCommands) expect(await run([command.name, JSON.stringify(inputs[command.name])])).toMatchObject({ code: 1, stdout: '' });
  expect(new HouseholdDatabase(app.db).document()).toEqual(before);
});
it('retries a committed write with the same operation id after its response is lost', async () => {
  const { app, run } = await setup(); let calls = 0;
  const result = await run(['addAgent', '{"agent":"new-agent"}'], async (url, init) => {
    const response = await fetch(url, init);
    if (++calls === 1) { await response.body?.cancel(); throw Error('owner-token'); }
    return response;
  });
  expect(result).toMatchObject({ code: 0, stderr: '' }); expect(result.bodies).toHaveLength(2);
  expect(new Set(result.bodies).size).toBe(1);
  expect(app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='household.addAgent'").get()).toEqual({ n: 1 });
});
it('refuses invalid usage before transport and preserves raw JSON for server validation', async () => {
  const { run } = await setup(); let calls = 0;
  const request: typeof fetch = async () => { calls++; throw Error('owner-token'); };
  for (const args of [['unknown'], ['addAgent'], ['addAgent', '[]'], ['addAgent', 'null'], ['addAgent', '{'], ['addAgent', '{}', 'extra']]) expect(await run(args, request)).toMatchObject({ code: 2, stdout: '' });
  expect(calls).toBe(0);
  const result = await run(['addAgent', '{"agent":1e400}']);
  expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.bodies[0]).toContain('1e400');
  expect(await run(['addAgent', '{}'], request)).toMatchObject({ code: 1, stdout: '', stderr: 'loom-household: loom daemon is unavailable\n' });
  expect(calls).toBe(4);
});
it('requires an explicit safe origin, refuses redirects and never echoes transport diagnostics', async () => {
  const { run, app, tokenFile } = await setup(); let calls = 0;
  const request: typeof fetch = async (_url, init) => { calls++; expect(init?.redirect).toBe('error'); return new Response(null, { status: 307 }); };
  for (const url of ['', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?query', 'https://example.com/#hash']) expect(await run(['addAgent', '{}'], request, { LOOM_URL: url, LOOM_TOKEN_FILE: tokenFile })).toMatchObject({ code: 1, stdout: '' });
  expect(calls).toBe(0);
  expect(await run(['addAgent', '{}'], request)).toMatchObject({ code: 1, stdout: '' }); expect(calls).toBe(1);
  for (const answer of [null, {}, { ok: false, message: 'owner-token' }, { ok: true }, { ok: true, value: { token: 'owner-token' } }]) {
    const result = await run(['addAgent', '{}'], async () => Response.json(answer)); expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.stderr).not.toContain('owner-token');
  }
  expect(await run(['addAgent', '{}'], request, { LOOM_URL: app.url, LOOM_TOKEN_FILE: '' })).toMatchObject({ code: 1, stdout: '' });
});
