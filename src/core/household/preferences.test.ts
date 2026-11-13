import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { PeopleStore } from '../../backends/people.js';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdRows } from './rows.js';
import { HouseholdDatabase } from './document.js';
import type { Viewer } from '../../policy.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'household-preferences-')); fixture(home);
  cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'commons'), { recursive: true });
  const people = new PeopleStore({ dbPath: join(home, 'commons', 'people.db') });
  for (const slug of ['jonathan', 'pollock']) people.write({ slug, name: slug });
  people.close();
  const clock = new FakeClock(), app = await startLoom({ home, next: true, clock, install: installFixture });
  cleanup.push(async () => app.close());
  return { home, clock, app, settings: new HouseholdRows<Record<string, unknown>>(app.db, 'settings'), readers: new HouseholdRows<Record<string, unknown>>(app.db, 'readers') };
}
const owner: Viewer = { kind: 'member', id: 'jonathan' }, member: Viewer = { kind: 'member', id: 'pollock' };
it('reads imported owner/member preferences through every door without returning reader state or accepting another member', async () => {
  const { app, settings, readers } = await setup();
  settings.put('session-envelope', { v: 1, sessions: {}, seen: { at: 1 }, prefs: { look: '000h', mode: 'light', tiling: false, private: 'hidden' } });
  readers.put('pollock', { opened: { secret: 1 }, prefs: { look: 'lowlight', sound: false } });
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    expect(app.operations.call(door, owner, 'household.preferences', {})).toEqual({ ok: true, value: { look: 'daylight', mode: 'light', tiling: false, oneWindow: true } });
    expect(app.operations.call(door, member, 'household.preferences', {})).toEqual({ ok: true, value: { look: 'lowlight', sound: false } });
    expect(app.operations.call(door, owner, 'household.preferences', { member: 'pollock' })).toMatchObject({ code: 'invalid' });
    for (const v of [{ kind: 'member', id: 'absent' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }] as Viewer[]) {
      expect(app.operations.call(door, v, 'household.preferences', {})).toMatchObject({ code: 'denied' });
      expect(app.operations.call(door, v, 'household.setPreferences', { sound: true }, `${door}:${v.id}`)).toMatchObject({ code: 'denied' });
    }
  }
});
it('patches only the caller, normalizes legacy choices without rewriting them, and uses strictly increasing server versions', async () => {
  const { app, clock, settings, readers } = await setup();
  const envelope = { v: 1, prefs: { look: '000h', mode: 'dark', sound: false, extra: 'kept' }, done: ['kept'] };
  settings.put('session-envelope', envelope);
  const reader = { opened: { x: 1 }, prefs: { zoom: true }, extra: 'reader retained' }; readers.put('pollock', reader);
  expect(app.operations.call('direct', owner, 'household.setPreferences', { tiling: false }, 'first')).toEqual({ ok: true, value: { look: 'lowlight', mode: 'dark', sound: false, tiling: false, oneWindow: true, at: clock.now() } });
  expect(settings.get('session-envelope')).toEqual({ ...envelope, prefs: { ...envelope.prefs, tiling: false, at: clock.now() } });
  expect(readers.get('pollock')).toEqual(reader);
  expect(app.operations.call('http', owner, 'household.setPreferences', { oneWindow: false, sound: true }, 'second')).toMatchObject({ ok: true, value: { oneWindow: false, sound: true, at: clock.now() + 1 } });
  expect(app.operations.call('socket', member, 'household.setPreferences', { motion: 'on', contrast: 'off' }, 'member')).toEqual({ ok: true, value: { zoom: true, motion: 'on', contrast: 'off', at: clock.now() } });
  expect(readers.get('pollock')).toEqual({ ...reader, prefs: { zoom: true, motion: 'on', contrast: 'off', at: clock.now() } });
  for (const input of [{}, { at: 42 }, { member: 'jonathan', sound: false }, { zoom: 'true' }, { look: 'other' }, { _csrf: 'ignored' }, { unknown: true }]) {
    expect(app.operations.call('direct', member, 'household.setPreferences', input, 'invalid')).toMatchObject({ code: 'invalid' });
  }
});
it('commits preferences, receipt and live event together; restart retry cannot revert a newer choice or bypass removal', async () => {
  const { app, home, clock, readers } = await setup();
  const events: unknown[] = []; app.live.observe(changes => events.push({ changes, transaction: app.db.inTransaction }));
  app.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON core_operations WHEN NEW.id='prefs' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
  const before = readers.entries();
  expect(app.operations.call('direct', member, 'household.setPreferences', { sound: true }, 'prefs')).toMatchObject({ code: 'unavailable' });
  expect(readers.entries()).toEqual(before); expect(events).toEqual([]);
  app.db.exec('DROP TRIGGER fail_receipt');
  const result = app.operations.call('direct', member, 'household.setPreferences', { sound: true }, 'prefs');
  expect(result).toMatchObject({ ok: true });
  expect(events).toEqual([{ changes: [{ type: 'household.preferences', id: 'pollock' }], transaction: false }]);
  await app.close();
  const reopened = await startLoom({ home, next: true, clock, install: installFixture }); cleanup.push(async () => reopened.close());
  expect(reopened.operations.call('direct', member, 'household.setPreferences', { sound: false }, 'newer')).toMatchObject({ ok: true });
  expect(reopened.operations.call('http', member, 'household.setPreferences', { sound: true }, 'prefs')).toEqual(result);
  expect(reopened.operations.call('direct', member, 'household.preferences', {})).toMatchObject({ value: { sound: false } });
  new HouseholdDatabase(reopened.db).change(home, raw => { raw.members = (raw.members as Array<{ person: string }>).filter(m => m.person !== 'pollock'); });
  // Core receipts acknowledge a previously completed operation before current policy; no new effect.
  expect(reopened.operations.call('http', member, 'household.setPreferences', { sound: true }, 'prefs')).toEqual(result);
  expect(reopened.operations.call('http', member, 'household.setPreferences', { sound: true }, 'removed')).toMatchObject({ code: 'denied' });
  expect(reopened.operations.call('http', member, 'household.preferences', {})).toMatchObject({ code: 'denied' });
});
it('keeps preferences attached to people when the first owner changes, including absent preferences', async () => {
  const { app, settings, readers } = await setup();
  const envelope = { v: 1, prefs: { look: 'neon', sound: true }, seen: { at: 4 } };
  settings.put('session-envelope', envelope);
  readers.put('pollock', { prefs: { look: 'daylight', zoom: true }, opened: { keep: 1 } });
  expect(app.operations.call('direct', owner, 'household.setMember', { person: 'pollock', agents: '*' }, 'promote')).toMatchObject({ ok: true });
  expect(app.operations.call('direct', owner, 'household.setMember', { person: 'jonathan', agents: ['art'] }, 'demote')).toMatchObject({ ok: true });
  expect(settings.get('session-envelope')).toEqual({ ...envelope, prefs: { look: 'daylight', zoom: true } });
  expect(readers.get('jonathan')).toMatchObject({ prefs: envelope.prefs });
  expect(readers.get('pollock')).toMatchObject({ opened: { keep: 1 } });
  expect(app.operations.call('direct', owner, 'household.preferences', {})).toEqual({ ok: true, value: envelope.prefs });
  expect(app.operations.call('direct', member, 'household.preferences', {})).toEqual({ ok: true, value: { look: 'daylight', zoom: true } });
  readers.put('jonathan', { opened: { still: 1 } });
  expect(app.operations.call('direct', member, 'household.setMember', { person: 'jonathan', agents: '*' }, 'restore')).toMatchObject({ ok: true });
  expect(settings.get('session-envelope')).toEqual({ v: 1, seen: { at: 4 } });
  expect(readers.get('pollock')).toMatchObject({ prefs: { look: 'daylight', zoom: true }, opened: { keep: 1 } });
});
it('sends only the subscribing member record, then publishes updates and removes it after membership revocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'preference-live-')); fixture(home);
  cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
  const app = await startLoom({ home, next: true, clock: new FakeClock(), install: installFixture, authenticate: () => ({ viewer: member, valid: () => true }) });
  cleanup.push(async () => app.close());
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live'); cleanup.push(async () => ws.terminate());
  const messages: unknown[] = [], pending: ((v: unknown) => void)[] = [];
  ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const receive = pending.shift(); if (receive) receive(v); else messages.push(v); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => pending.push(resolve));
  await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'household.preferences' }));
  expect(await next()).toEqual({ kind: 'set', type: 'household.preferences', records: [{ id: 'pollock', member: 'pollock', prefs: {} }] });
  expect(app.operations.call('direct', owner, 'household.setPreferences', { look: 'neon' }, 'owner')).toMatchObject({ ok: true });
  expect(app.operations.call('direct', member, 'household.setPreferences', { look: 'daylight' }, 'mine')).toMatchObject({ ok: true });
  expect(await next()).toMatchObject({ kind: 'put', record: { id: 'pollock', member: 'pollock', prefs: { look: 'daylight' } } });
  expect(app.operations.call('direct', owner, 'household.removeMember', { person: 'pollock' }, 'remove')).toMatchObject({ ok: true });
  expect(await next()).toEqual({ kind: 'set', type: 'household.preferences', records: [] });
});
