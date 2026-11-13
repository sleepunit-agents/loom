import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fixture, fixtureSharing } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { installAttention } from './index.js';
import { z } from 'zod';
import { attentionCommands, operation } from './commands.js';
import { runAttentionClient } from '../../cli/attention-client.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-client-'));
  fixture(home);
  const sharing = fixtureSharing;
  const app = await startLoom({ home, next: true, host: '127.0.0.1', port: 0, clock: new FakeClock(), sharing,
    authenticate: req => req.headers.authorization === 'Bearer fixture-token' ? { viewer: { kind: 'member', id: 'jonathan' }, valid: () => true } : req.headers.authorization === 'Bearer pollock-token' ? { viewer: { kind: 'member', id: 'pollock' }, valid: () => true } : undefined,
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
const ask = { id: 'a1', agent: 'art', member: 'jonathan', ask: 'Continue?', source: { kind: 'piece', id: 'fixture' } };
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
  expect(JSON.parse(answered.stdout)).toMatchObject({ state: 'answered', answer: { kind: 'yes', by: { id: 'jonathan' } } });
  expect(await app.run(['answer', '{"id":"a1","answer":{"kind":"no"}}'])).toMatchObject({ code: 1, stdout: '' });
  writeFileSync(app.tokenFile, 'pollock-token');
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

it('refuses unlisted operations and mismatched write markers before registration', () => {
  const base = { input: z.object({}), output: z.unknown(), may: () => true, run: () => null };
  expect(() => operation({ ...base, name: 'attention.unlisted' })).toThrow('metadata does not match');
  expect(() => operation({ ...base, name: 'attention.raise' })).toThrow('metadata does not match');
  expect(() => operation({ ...base, name: 'attention.get', write: true })).toThrow('metadata does not match');
});
it('prints help with no credentials or daemon and never invokes transport', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    let stdout = '', stderr = '';
    expect(await runAttentionClient(args, { stdout: s => stdout += s, stderr: s => stderr += s, stdin: Readable.from([]), stdinIsTTY: false, env: {} }, { request: async () => { throw Error('must not request'); }, retry: async () => { throw Error('must not retry'); } })).toBe(0);
    expect(stdout).toContain('usage: loom-attention'); expect(stderr).toBe('');
  }
});
it('preserves overflowing JSON numbers for daemon rejection instead of converting them to null', async () => {
  const app = await setup();
  const turn = await app.run(['recordTurn', JSON.stringify({ agent: 'art', turn: { venue: 'terminal', place: 'fixture', at: '2026-11-12T00:00:00Z', from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r1', outcome: 'progressed' } })]);
  expect(turn.code).toBe(0); const { conversation, seq } = JSON.parse(turn.stdout);
  const raw = `{"conversation":"${conversation}","seq":${seq},"measure":"progress","score":1e400,"text":"Checked"}`;
  const refused = await app.run(['writeFinding', raw]);
  expect(refused).toMatchObject({ code: 1, stdout: '' });
  expect(refused.bodies[0]).toContain('"score":1e400');
  expect(app.db.prepare('SELECT count(*) AS n FROM attention_findings').get()).toEqual({ n: 0 });
  const accepted = await app.run(['writeFinding', raw.replace('1e400', 'null')]);
  expect(accepted.code).toBe(0); expect(JSON.parse(accepted.stdout)).toMatchObject({ score: null });
});

it('cancels stalled requests on the timeout signal and stops after four attempts', async () => {
  const app = await setup();
  const signals: AbortSignal[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
  try {
    const result = await app.run(['conversations'], async (_url, init) => {
      if (!init?.signal) throw Error('missing cancellation');
      signals.push(init.signal);
      init.signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: 'loom-attention: loom daemon is unavailable\n' });
    expect(timeout).toHaveBeenCalledTimes(4);
    expect(timeout.mock.calls).toEqual([[1500], [1500], [1500], [1500]]);
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  } finally { timeout.mockRestore(); }
});
