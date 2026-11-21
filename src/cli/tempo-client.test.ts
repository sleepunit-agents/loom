import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { agents, members, memberAgents, tokens, triggerLog, triggers } from '../core/data/schema.js';
import { sharedRoot } from '../shared-root.js';
import { runTempoClient } from './tempo-client.js';

it('finds earlier matching history of a stopped wake across pages, with the agent and time filters applied', async () => {
  const sql = new Database(':memory:');
  const clock = new FakeClock(Date.now());
  const at = new Date(clock.now()).toISOString();
  const db = createDataSchema(sql);
  const dir = mkdtempSync(join(tmpdir(), 'loom-wake-'));
  const file = join(dir, 'token');
  const token = randomUUID();
  writeFileSync(file, token, { mode: 0o600 });
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: createHash('sha256').update(token).digest('hex'), label: 'fixture', kind: 'owner', member: 'owner', createdAt: at }).run();
  for (const id of ['fern', 'birch']) {
    db.insert(agents).values({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(memberAgents).values({ member: 'owner', agent: id }).run();
    db.insert(triggers).values({ id, ownerKind: 'agent', owner: id, sourceKind: 'time', lifespan: 'once', targetKind: 'inbox',
      toKind: 'agent', to: id, enabled: false, state: 'stopped', createdAt: at, changedAt: at, note: 'Example' }).run();
  }
  for (let seq = 1; seq <= 105; seq++) {
    db.insert(triggerLog).values({ seq, trigger: seq === 2 ? 'birch' : 'fern', event: seq <= 3 ? 'fired' : 'held',
      at: seq === 3 ? new Date(clock.now() - 7200000).toISOString() : at, note: 'entry ' + seq }).run();
  }
  const app = sharedRoot({ db, clock, originAllowed: () => true });
  try {
    let out = '', err = '';
    const io = { env: { WAKE_AGENT: 'fern', LOOM_URL: 'http://localhost', LOOM_TOKEN_FILE: file }, stdin: Readable.from([]),
      stdinIsTTY: false, stdout: (s:string) => { out += s; }, stderr: (s:string) => { err += s; } };
    const request: typeof fetch = (url, init) => Promise.resolve(app.http.request(String(url), init));
    const code = await runTempoClient(['log', '--grep', 'fire', '--since', '1h30m'], io, request);
    expect(code, err).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toMatch(/ \| fired \| fern entry 1\n$/);
    out = '';
    expect(await runTempoClient(['list'], io, request)).toBe(0);
    expect(out).toBe('No pending wakes.\n');
    const result = await app.http.request('/api/tempo/set', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'request', input: { id: 'scheduled', ownerKind: 'household', sourceKind: 'time',
        times: at, lifespan: 'once', targetKind: 'inbox', toKind: 'agent', to: 'fern', instructions: 'Fixture', note: 'Fixture' } }),
    });
    expect(result.status, await result.text()).toBe(200);
    out = '';
    expect(await runTempoClient(['log', '--grep', 'delivered'], io, request)).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toMatch(/fired \| scheduled .* → delivered cv-[\w-]+/);
  } finally {
    await app.close();
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
