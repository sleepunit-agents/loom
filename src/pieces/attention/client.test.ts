import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { installAttention } from './index.js';
import { attentionCommands } from './commands.js';
import { runAttentionClient } from './client.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-client-'));
  const sharing = () => ({ members: { alice: { owner: true, agents: ['art'] }, bob: { owner: true, agents: ['art'] } }, projects: {}, services: {} });
  const app = await startLoom({ home, clock: new FakeClock(), sharing,
    authenticate: req => req.headers.authorization === 'Bearer fixture-token' ? { viewer: { kind: 'member', id: 'alice' }, valid: () => true } : req.headers.authorization === 'Bearer bob-token' ? { viewer: { kind: 'member', id: 'bob' }, valid: () => true } : undefined,
    install: app => installAttention(app.db, app.operations, app.live, sharing) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const tokenFile = join(home, 'token'); writeFileSync(tokenFile, 'fixture-token');
  const run = async (args: string[], request: typeof fetch = fetch, env = { LOOM_URL: app.url, LOOM_TOKEN_FILE: tokenFile }) => {
    let stdout = '', stderr = ''; const bodies: string[] = [];
    const code = await runAttentionClient(args, { stdout: s => stdout += s, stderr: s => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env }, {
      request: (url, init) => { bodies.push(String(init?.body)); return request(url, init); }, retry: async () => {},
    });
    return { code, stdout, stderr, bodies };
  };
  return { ...app, run, tokenFile };
}
const ask = { id: 'a1', agent: 'art', member: 'alice', ask: 'Continue?', source: { kind: 'piece', id: 'fixture' } };
it('offers exactly the registry commands with matching write metadata and generated help', async () => {
  const app = await setup();
  const offered = app.operations.offered('http').filter(o => o.name.startsWith('attention.'));
  expect(offered.map(o => o.cli).sort((a,b) => a!.name.localeCompare(b!.name))).toEqual([...attentionCommands].sort((a,b) => a.name.localeCompare(b.name)));
  for (const op of offered) expect(!!op.cli?.write).toBe(op.write);
  const help = await app.run(['--help']); expect(help.code).toBe(0);
  for (const op of offered) expect(help.stdout).toContain(op.cli!.name);
});
it('prints the daemon value unchanged, preserves first answer, and enforces authenticated private scope', async () => {
  const app = await setup();
  const raised = await app.run(['raise', JSON.stringify(ask)]); expect(raised.code).toBe(0);
  const record = JSON.parse(raised.stdout); expect(record).toMatchObject({ ...ask, state: 'open' });
  expect(await app.run(['get', '{"id":"a1"}'])).toMatchObject({ code: 0, stdout: JSON.stringify(record, null, 2) + '\n' });
  const answered = await app.run(['answer', '{"id":"a1","answer":{"kind":"yes"}}']);
  expect(JSON.parse(answered.stdout)).toMatchObject({ state: 'answered', answer: { kind: 'yes', by: { id: 'alice' } } });
  expect(await app.run(['answer', '{"id":"a1","answer":{"kind":"no"}}'])).toMatchObject({ code: 1, stdout: '' });
  writeFileSync(app.tokenFile, 'bob-token');
  expect(await app.run(['get', '{"id":"a1"}'])).toMatchObject({ code: 1, stdout: '' });
  expect(await app.run(['answer', '{"id":"a1","answer":{"kind":"done"}}'])).toMatchObject({ code: 1, stdout: '' });
});
it('retries a committed write with identical body/id after a lost response', async () => {
  const app = await setup(); let calls = 0;
  const result = await app.run(['raise', JSON.stringify(ask)], async (url, init) => {
    const response = await fetch(url, init);
    if (++calls === 1) { await response.body?.cancel(); throw Error('sensitive diagnostic'); }
    return response;
  });
  expect(result).toMatchObject({ code: 0, stderr: '' }); expect(result.bodies).toHaveLength(2); expect(result.bodies[0]).toBe(result.bodies[1]);
  expect(app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='attention.raise'").get()).toEqual({ n: 1 });
});
it('sends read filters as JSON numbers without attribution or write ids and leaves schema validation to the daemon', async () => {
  const app = await setup();
  const result = await app.run(['conversations', '{"limit":1}']); expect(result).toMatchObject({ code: 0, stdout: '[]\n' });
  expect(JSON.parse(result.bodies[0])).toEqual({ input: { limit: 1 } });
  expect(await app.run(['conversations', '{"limit":"1"}'])).toMatchObject({ code: 1, stdout: '' });
  expect(await app.run(['recordTurn', '{"words":"private"}'])).toMatchObject({ code: 1, stdout: '' });
});
it('rejects malformed usage before networking and bounds unavailable retries without diagnostics', async () => {
  const app = await setup(); let requests = 0;
  const unavailable: typeof fetch = async () => { requests++; throw Error('fixture-token secret'); };
  for (const args of [['bogus'], ['get','[]'], ['get','null'], ['get','{'], ['get','{}','extra']]) {
    expect(await app.run(args, unavailable)).toMatchObject({ code: 2, stdout: '' });
  }
  expect(requests).toBe(0);
  expect(await app.run(['get','{}'], unavailable)).toMatchObject({ code: 1, stdout: '', stderr: 'loom-attention: loom daemon is unavailable\n' });
  expect(requests).toBe(4);
});
it('refuses implicit or malformed origins, absent token configuration and redirects', async () => {
  const app = await setup(); let calls = 0;
  const request: typeof fetch = async (_url, init) => { calls++; expect(init?.redirect).toBe('error'); return new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/' } }); };
  for (const url of ['', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?query', 'https://example.com/#hash']) {
    expect(await app.run(['conversations'], request, { LOOM_URL: url, LOOM_TOKEN_FILE: app.tokenFile })).toMatchObject({ code: 1, stdout: '' });
  }
  expect(await app.run(['conversations'], request, { LOOM_URL: app.url, LOOM_TOKEN_FILE: '' })).toMatchObject({ code: 1, stdout: '' });
  expect(calls).toBe(0);
  expect(await app.run(['conversations'], request)).toMatchObject({ code: 1, stdout: '' });
});
it('handles 503 retries, refusal envelopes, malformed responses and escaped tokens without leaking diagnostics', async () => {
  const app = await setup(); let calls = 0;
  const result = await app.run(['conversations'], async () => ++calls < 4 ? Response.json({}, { status: 503 }) : Response.json({ ok: true, value: [] }));
  expect(result).toMatchObject({ code: 0, stdout: '[]\n' }); expect(calls).toBe(4);
  for (const value of [null, {}, { ok: false, message: 'secret' }, { ok: true }]) {
    const result = await app.run(['conversations'], async () => Response.json(value)); expect(result).toMatchObject({ code: 1, stdout: '' }); expect(result.stderr).not.toContain('secret');
  }
  const token = 'abc"def\\ghi'; writeFileSync(app.tokenFile, token);
  expect(await app.run(['conversations'], async () => Response.json({ ok: true, value: [{ label: token }] }))).toMatchObject({ code: 0, stdout: '[\n  {\n    "label": "[redacted]"\n  }\n]\n' });
});
