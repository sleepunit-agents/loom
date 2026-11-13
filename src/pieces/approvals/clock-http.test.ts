import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { importClock } from '../clock/importer.js';
import { wakes } from '../clock/store.js';
import { load } from './store.js';

it('applies the real Clock role over HTTP atomically and spends once across restart and lost-answer retry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'approvals-clock-http-'));
  const source = join(home, 'source');
  mkdirSync(join(source, 'art'), { recursive: true });
  const ids = ['w-aaaaaa', 'w-bbbbbb'];
  writeFileSync(join(source, 'art', 'spool.jsonl'), ids.map(id => JSON.stringify({
    id, kind: 'wake', for: '-', at: '2026-11-13 07:00:00', created: '2026-11-13 05:00:00',
    prompt: 'Review my queue', origin: 'agent:art', fails: 3,
  })).join('\n'));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const access = fixtureSharing();
  // The injected fixture Sharing owns its service grants; production uses built-ins.
  access.services.approvals = {types: ['approval'], operations: ['approvals.piece-request']};
  let first = true;
  const options = {
    home, clock, next: true, sharing: () => access, stdout: () => {},
    authenticate: (req: import('node:http').IncomingMessage) => ({
      viewer: (req.headers['x-test-agent'] ? {kind: 'agent', id: 'art'} : {kind: 'member', id: 'jonathan'}) as Viewer,
      valid: () => true,
    }),
    install(app: Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
      if (first) { importClock(app.db, source, clock.now()); first = false; }
    },
  };
  let app = await startLoom(options);
  const post = async (piece: string, verb: string, input: object, id = randomUUID(), agent = false) => {
    const response = await fetch(`${app.url}/api/${piece}/${verb}`, {
      method: 'POST', headers: {'content-type': 'application/json', ...(agent ? {'x-test-agent': 'art'} : {})},
      body: JSON.stringify({input, id}),
    });
    return response.json();
  };
  try {
    const target = `art:${ids.join(',')}`;
    const filed = await post('clock', 'askVouch', {target}, randomUUID(), true);
    expect(filed).toMatchObject({ok: true, value: {state: 'pending', target}});
    const card = filed.value.id;
    const before = wakes(app.db), approvals = load(app.db);
    const input = {id: card, action: 'allow'};
    const receipt = randomUUID();
    // Authenticated agent input cannot impersonate the deciding owner.
    expect(await post('approvals', 'answer', {...input, by: 'jonathan'}, randomUUID(), true)).toMatchObject({ok: false, code: 'denied'});
    app.db.exec(`CREATE TRIGGER fail_clock_http BEFORE UPDATE ON clock_wakes WHEN NEW.id='w-bbbbbb' BEGIN SELECT RAISE(ABORT,'fixture'); END`);
    expect(await post('approvals', 'answer', input, receipt)).toMatchObject({ok: false});
    expect(wakes(app.db)).toEqual(before);
    expect(load(app.db)).toEqual(approvals);
    expect(app.db.prepare('SELECT * FROM clock_events').all()).toEqual([]);
    app.db.exec('DROP TRIGGER fail_clock_http');
    // Failed writes leave no retry receipt; the exact same HTTP operation can succeed.
    const answer = await post('approvals', 'answer', input, receipt);
    expect(answer).toMatchObject({ok: true, value: {state: 'used', id: card}});
    expect(wakes(app.db).every(w => w.state === 'pending' && w.by?.kind === 'member' && w.by.id === 'jonathan')).toBe(true);
    const events = app.db.prepare('SELECT * FROM clock_events').all();
    expect(events).toHaveLength(2);
    const committed = load(app.db);
    expect(committed.approvals[0]).toMatchObject({id: card, state: 'used', by: 'jonathan'});
    await app.close(); app = await startLoom(options);
    expect(await post('approvals', 'answer', input, receipt)).toEqual(answer);
    expect(await post('approvals', 'answer', input)).toMatchObject({ok: false});
    expect(await post('approvals', 'use', {id: card, kind: 'vouch-wake', target}, randomUUID(), true)).toMatchObject({ok: false});
    expect(app.db.prepare('SELECT * FROM clock_events').all()).toEqual(events);
    expect(load(app.db).approvals).toEqual(committed.approvals);
    expect(load(app.db).audit.filter(a => a.event === 'use')).toHaveLength(1);
  } finally { await app.close(); rmSync(home, {recursive: true, force: true}); }
});
