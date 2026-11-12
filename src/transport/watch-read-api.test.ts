import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToken, loadHousehold } from '../household.js';
import { startHttpServer, type HttpServeHandle } from './http-server.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
const read = vi.hoisted(() => vi.fn(async () => ({ observations: [{ value: 'test' }] })));
vi.mock('../watch-read.js', async orig => ({ ...await orig<typeof import('../watch-read.js')>(), readWatches: read }));
let home: string, server: HttpServeHandle, base: string;
const tokens: Record<string, string> = {};
const body = { agent: 'art', principal: 'owner', targets: [{ kind: 'tasks.task', id: 't-1' }] };
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'watch-api-'));
  mkdirSync(join(home, 'agents', 'art'), { recursive: true });
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  const loom = parseLoomBlock({ role: 'clock' }, 'clock', ['loom-clock']);
  mkdirSync(join(home, 'pieces', 'clock'), { recursive: true });
  writeFileSync(join(home, 'pieces', 'clock', 'piece.json'), JSON.stringify({ v: 1, name: 'clock', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'clock', version: '1', bins: ['loom-clock'], loom }));
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  writeFileSync(join(home, 'pieces', 'clock', 'cli'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(home, 'pieces', 'clock', 'cli'), 0o755);
  symlinkSync(join(home, 'pieces', 'clock', 'cli'), join(home, 'pieces', 'bin', 'loom-clock'));
  process.env.LOOM_HOME = home;
  const h = loadHousehold(home)!;
  for (const [name, role] of Object.entries({ clock: { kind: 'piece', piece: 'clock', subject: 'test' },
    other: { kind: 'piece', piece: 'other', subject: 'test' }, owner: { kind: 'owner' }, agent: { kind: 'agent', agent: 'art' } } as const)) {
    tokens[name] = createToken(h, { role, label: name }).token;
  }
  server = await startHttpServer({ contextDir: join(home, 'agents', 'art'), household: h, host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  read.mockClear();
});
afterEach(async () => { await server?.close(); rmSync(home, { recursive: true, force: true }); });
const call = (who: string, data: unknown = body, headers = {}) => fetch(`${base}/api/loom/watches/observe`, {
  method: 'POST', headers: { authorization: `Bearer ${tokens[who] ?? 'invalid'}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
});
it('admits only the installed clock credential and rejects browser use before reading', async () => {
  for (const who of ['owner', 'agent', 'other', 'unknown']) expect((await call(who)).status).toBe(who === 'unknown' ? 401 : 403);
  expect((await call('clock', body, { origin: base })).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const r = await call('clock');
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ observations: [{ value: 'test' }] });
  expect(read).toHaveBeenCalledTimes(1);
  rmSync(join(home, 'pieces', 'clock'), { recursive: true, force: true });
  expect((await call('clock')).status).toBe(403);
  expect(read).toHaveBeenCalledTimes(1);
});
it('rejects malformed or oversized targets and content types before reading', async () => {
  expect((await call('clock', {})).status).toBe(400);
  expect((await call('clock', { ...body, targets: Array(21).fill(body.targets[0]) })).status).toBe(400);
  expect((await call('clock', body, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await call('clock', { padding: 'x'.repeat(17000) })).status).toBe(413);
  expect(read).not.toHaveBeenCalled();
});
