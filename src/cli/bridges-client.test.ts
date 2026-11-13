import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom } from '../foundation.js';
import { FakeClock, type Sharing } from '../core/index.js';
import { installBridges } from '../pieces/bridges/index.js';
import { bridgeCommands, type BridgesInputs } from '../pieces/bridges/commands.js';
import { runBridgesClient } from './bridges-client.js';
const sharing: Sharing = { members: { jonathan: { owner: true, agents: ['art'] }, reader: { owner: false, agents: [] } }, projects: {}, services: {} };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'bridges-client-'));
  const app = await startLoom({ home, next: true, host: '127.0.0.1', port: 0, clock: new FakeClock(), sharing: () => sharing,
    authenticate: req => ['Bearer fixture-token', 'Bearer v1'].includes(req.headers.authorization ?? '') ? { viewer: { kind: 'member', id: 'jonathan' }, valid: () => true } : req.headers.authorization === 'Bearer reader-token' ? { viewer: { kind: 'member', id: 'reader' }, valid: () => true } : undefined,
    install: app => installBridges(app, () => sharing) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const tokenFile = join(home, 'token'); writeFileSync(tokenFile, 'fixture-token');
  const run = async (args: string[], request: typeof fetch = fetch, env = { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile }) => {
    let stdout = '', stderr = ''; const bodies: string[] = [];
    const code = await runBridgesClient(args, { stdout: s => stdout += s, stderr: s => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env }, {
      request: (url, init) => { bodies.push(String(init?.body)); return request(url, init); }, retry: async () => {},
    });
    return { code, stdout, stderr, bodies };
  };
  return { ...app, run, tokenFile };
}
const venue: BridgesInputs['putVenues'] = { id: 'v1', platform: 'slack', agent: 'art', workspace: 'T1', bot: 'U1', tokenSecret: 'TOKEN_REFERENCE', appSecret: 'APP_REFERENCE' };
const route: BridgesInputs['putRoutes'] = { id: 'r1', platform: 'slack', workspace: 'T1', channel: 'G1', primary: 'art', readers: ['jonathan'] };
const link: BridgesInputs['putLinks'] = { id: 'l1', platform: 'slack', workspace: 'T1', user: 'U2', person: 'jonathan' };
it('generates help and registry metadata for setup writes and terminal send disposition', async () => {
  const app = await setup();
  const offered = app.operations.offered('http').filter(o => o.name.startsWith('bridges.'));
  expect(offered.map(o => o.cli)).toEqual(bridgeCommands);
  expect(offered.every(o => o.write && o.cli?.write)).toBe(true);
  const help = await app.run(['--help']); expect(help.code).toBe(0);
  for (const command of bridgeCommands) expect(help.stdout).toContain(command.name);
});
it('puts and removes venue, route and person-link records through the real HTTP operations', async () => {
  const app = await setup();
  for (const [table, record] of [['Venues', venue], ['Routes', route], ['Links', link]] as const) {
    const result = await app.run([`put${table}`, JSON.stringify(record)]);
    expect(result).toMatchObject({ code: 0, stdout: JSON.stringify({ id: record.id }, null, 2) + '\n', stderr: '' });
    expect(JSON.parse(result.bodies[0]).input).toEqual(record);
    const row = app.db.prepare(`SELECT record FROM bridges_${table.toLowerCase()} WHERE id=?`).get(record.id) as { record: string };
    expect(JSON.parse(row.record)).toMatchObject(record);
    expect(await app.run([`remove${table}`, JSON.stringify({ id: record.id })])).toMatchObject({ code: 0 });
    expect(app.db.prepare(`SELECT count(*) AS n FROM bridges_${table.toLowerCase()}`).get()).toEqual({ n: 0 });
  }
});
it('keeps schema validation and owner authorization in the daemon, never trusting client identity', async () => {
  const app = await setup();
  expect(await app.run(['putVenues', JSON.stringify({ ...venue, enabled: 'yes' })])).toMatchObject({ code: 1, stdout: '' });
  expect(await app.run(['putLinks', JSON.stringify({ ...link, actor: 'jonathan' })])).toMatchObject({ code: 1, stdout: '' });
  writeFileSync(app.tokenFile, 'reader-token');
  for (const command of bridgeCommands) {
    expect(await app.run([command.name, JSON.stringify(command.name === 'dismissSend' ? { id: 'missing', state: 'uncertain' } : command.name.startsWith('remove') ? { id: 'missing' } : command.name === 'putVenues' ? venue : command.name === 'putRoutes' ? route : link)])).toMatchObject({ code: 1, stdout: '' });
  }
  expect(app.db.prepare('SELECT count(*) AS n FROM bridges_venues').get()).toEqual({ n: 0 });
  expect(app.db.prepare('SELECT count(*) AS n FROM bridges_links').get()).toEqual({ n: 0 });
});
it('retries the identical write after a committed response is lost', async () => {
  const app = await setup(); let calls = 0;
  const result = await app.run(['putVenues', JSON.stringify(venue)], async (url, init) => {
    const response = await fetch(url, init);
    if (++calls === 1) { await response.body?.cancel(); throw Error('fixture-token diagnostics'); }
    return response;
  });
  expect(result).toMatchObject({ code: 0, stderr: '' }); expect(result.bodies).toHaveLength(2); expect(result.bodies[0]).toBe(result.bodies[1]);
  expect(app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='bridges.putVenues'").get()).toEqual({ n: 1 });
  expect(app.db.prepare("SELECT value FROM bridges_meta WHERE key='setup-revision'").get()).toEqual({ value: '1' });
});
it('acknowledges a caller-supplied id even when it coincides with the bearer token', async () => {
  const app = await setup(); writeFileSync(app.tokenFile, 'v1');
  expect(await app.run(['putVenues', JSON.stringify(venue)])).toMatchObject({ code: 0, stdout: '{\n  "id": "v1"\n}\n', stderr: '' });
  const row = app.db.prepare('SELECT id FROM bridges_venues WHERE id=?').get('v1');
  expect(row).toEqual({ id: 'v1' });
  expect(await app.run(['removeVenues', '{"id":"v1"}'], async () => Response.json({ ok: true, value: { id: 'other' } }))).toMatchObject({ code: 1, stdout: '' });
});
it('rejects malformed usage before networking and leaves overflowing numbers for daemon rejection', async () => {
  const app = await setup(); let requests = 0;
  const unavailable: typeof fetch = async () => { requests++; throw Error('fixture-token'); };
  for (const args of [['send'], ['putVenues'], ['putVenues','[]'], ['putVenues','null'], ['putVenues','{'], ['putVenues','{}','extra']]) expect(await app.run(args, unavailable)).toMatchObject({ code: 2, stdout: '' });
  expect(requests).toBe(0);
  const raw = JSON.stringify(venue).replace('"v1"', '1e400');
  const result = await app.run(['putVenues', raw]); expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.bodies[0]).toContain('1e400');
  expect(await app.run(['removeVenues','{"id":"v1"}'], unavailable)).toMatchObject({ code: 1, stdout: '', stderr: 'loom-bridges: loom daemon is unavailable\n' });
  expect(requests).toBe(4);
});
it('requires an explicit origin and token, refuses redirects, and never prints server diagnostics or token echoes', async () => {
  const app = await setup(); let calls = 0;
  const redirect: typeof fetch = async (_url, init) => { calls++; expect(init?.redirect).toBe('error'); return new Response(null, { status: 307 }); };
  for (const url of ['', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?query', 'https://example.com/#hash']) expect(await app.run(['removeVenues','{}'], redirect, { LOOM_URL: url, LOOM_TOKEN_FILE: app.tokenFile })).toMatchObject({ code: 1, stdout: '' });
  expect(await app.run(['removeVenues','{}'], redirect, { LOOM_URL: app.url, LOOM_TOKEN_FILE: '' })).toMatchObject({ code: 1, stdout: '' }); expect(calls).toBe(0);
  expect(await app.run(['removeVenues','{}'], redirect)).toMatchObject({ code: 1, stdout: '' }); expect(calls).toBe(1);
  for (const value of [null, {}, { ok: false, message: 'fixture-token' }, { ok: true }, { ok: true, value: { id: 'ok', token: 'fixture-token' } }, { ok: true, value: { id: 'fixture-token' } }]) {
    const result = await app.run(['removeVenues','{}'], async () => Response.json(value)); expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.stderr).not.toContain('fixture-token');
  }
});
it('refuses extra acknowledgement and envelope fields independently of the requested id', async () => {
  const app = await setup();
  for (const answer of [
    { ok: true, value: { id: 'v1', unexpected: 'fixture-token' } },
    { ok: true, value: { id: 'v1' }, unexpected: 'fixture-token' },
  ]) {
    expect(await app.run(['removeVenues', '{"id":"v1"}'], async () => Response.json(answer))).toMatchObject({ code: 1, stdout: '', stderr: 'loom-bridges: Invalid daemon response\n' });
  }
  expect(await app.run(['removeVenues', '{"id":"v1"}'], async () => Response.json({ ok: true, value: { id: 'v1' } }))).toMatchObject({ code: 0, stdout: '{\n  "id": "v1"\n}\n' });
});
it('retries server errors with the same id and offers offline help without any transport', async () => {
  const app = await setup(); let calls = 0;
  for (const status of [500, 502, 503, 504]) {
    calls = 0;
    const result = await app.run(['removeVenues','{"id":"v1"}'], async () => ++calls < 4 ? Response.json({}, { status }) : Response.json({ ok: true, value: { id: 'v1' } }));
    expect(result).toMatchObject({ code: 0 }); expect(calls).toBe(4); expect(new Set(result.bodies).size).toBe(1);
  }
  calls = 0;
  const refused = await app.run(['removeVenues','{"id":"v1"}'], async () => { calls++; return Response.json({}, { status: 503 }); });
  expect(refused).toMatchObject({ code: 1, stdout: '', stderr: 'loom-bridges: Request refused\n' });
  expect(calls).toBe(4); expect(new Set(refused.bodies).size).toBe(1);
  for (const args of [[], ['--help'], ['-h']]) {
    let stdout = '';
    expect(await runBridgesClient(args, { stdout: s => stdout += s, stderr: () => {}, stdin: Readable.from([]), stdinIsTTY: false, env: {} }, { request: async () => { throw Error('must not request'); }, retry: async () => { throw Error('must not retry'); } })).toBe(0);
    expect(stdout).toContain('usage: loom-bridges');
  }
});

it('dismisses a held send through HTTP with a stable retry after its acknowledgement is lost', async () => {
  const app = await setup();
  app.db.prepare("INSERT INTO bridges_outbox VALUES ('reply','incoming','v1','identity','{}','private words','held',NULL,0)").run();
  let calls=0;
  const result=await app.run(['dismissSend',JSON.stringify({id:'reply',state:'held'} satisfies BridgesInputs['dismissSend'])],async(url,init)=>{
    const response=await fetch(url,init);
    if(++calls===1){await response.body?.cancel();throw Error('lost response');}
    return response;
  });
  expect(result).toMatchObject({code:0,stdout:'{\n  "id": "reply"\n}\n',stderr:''});
  expect(result.bodies).toHaveLength(2);expect(new Set(result.bodies).size).toBe(1);
  expect(app.db.prepare('SELECT state,text FROM bridges_outbox').get()).toEqual({state:'dismissed',text:'private words'});
  expect(app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='bridges.dismissSend'").get()).toEqual({n:1});
});
