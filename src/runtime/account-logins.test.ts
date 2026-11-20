import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { boxes, inbox, members, modelAccountBoxes, modelAccountLogins, modelAccounts } from '../core/data/schema.js';
import { AccountLogins, LOGIN_ENDING_MS } from './account-logins.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const DAY = 86_400_000;
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-19T14:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'member', joinedAt: now() }).run();
  for (const id of ['loom', 'one']) db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: false, hostsAny: false,
    reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
  db.insert(modelAccounts).values({ id: 'sub', owner: 'owner', provider: 'anthropic', label: 'Claude subscription', hasRoom: true }).run();
  for (const box of ['loom', 'one']) db.insert(modelAccountBoxes).values({ account: 'sub', box }).run();
  const service = new AccountLogins(db, now);
  const seen = (box: string) => db.update(boxes).set({ lastSeenAt: now() }).where(eq(boxes.id, box)).run();
  const at = (ms: number) => new Date(time + ms).toISOString();
  return { db, now, service, seen, at, advance: (ms: number) => { time += ms; }, rows: () => db.select().from(modelAccountLogins).all(),
    mail: () => db.select().from(inbox).all() };
}
const claude = { account: 'sub', harness: 'claude' } as const;

it('keeps two places on one machine as two sign-ins, each with its own end', () => {
  const f = fixture();
  expect(f.service.checked('loom', [
    { ...claude, place: 'containers', state: 'signed-in', expiresAt: f.at(25 * DAY) },
    { ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(21 * DAY) },
  ])).toEqual(['sub']);
  expect(f.rows().map(row => [row.box, row.harness, row.place, row.state, row.expiresAt, row.learnedFrom])).toEqual([
    ['loom', 'claude', 'containers', 'signed-in', f.at(25 * DAY), 'check'], ['loom', 'claude', 'host', 'signed-in', f.at(21 * DAY), 'check']]);
  expect(f.service.sweep()).toEqual([]);
  // The same answer again changes nothing a reader would see.
  f.advance(60_000);
  expect(f.service.checked('loom', [
    { ...claude, place: 'containers', state: 'signed-in', expiresAt: f.at(25 * DAY - 60_000) },
    { ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(21 * DAY - 60_000) },
  ])).toEqual([]);
  expect(f.rows().every(row => row.checkedAt === f.now() && row.since !== f.now())).toBe(true);
});

it('tells the owner once that a sign-in is gone, and closes it when the sign-in is back', () => {
  const f = fixture();
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out', why: 'no-file' }]);
  const [notice] = f.service.sweep();
  expect(notice).toMatchObject({ toKind: 'person', to: 'owner', source: 'notice', state: 'waiting',
    words: 'Claude subscription is signed out on one (claude in houses). There is no sign-in file.' });
  f.advance(60_000); f.seen('one');
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out', why: 'no-file' }]);
  expect(f.service.sweep().map(row => row.id)).toEqual([notice.id]);
  expect(f.mail()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ state: 'signed-out', why: 'There is no sign-in file.' });
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: f.at(20 * DAY) }]);
  expect(f.mail()[0].state).not.toBe('waiting');
  expect(f.service.sweep()).toEqual([]);
  // Gone a second time is a second occasion, and is said again.
  f.advance(DAY); f.seen('one');
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out' }]);
  expect(f.service.sweep()[0].id).not.toBe(notice.id);
  expect(f.mail()).toHaveLength(2);
});

it('tells the owner when a sign-in is about to end, and closes that when it is renewed', () => {
  const f = fixture();
  f.service.checked('loom', [{ ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(LOGIN_ENDING_MS + 60_000) }]);
  expect(f.service.sweep()).toEqual([]);
  f.advance(120_000); f.seen('loom');
  const [notice] = f.service.sweep();
  expect(notice.words).toMatch(/^The Claude subscription sign-in on loom \(claude on the machine itself\) ends in 2 days, on \d{4}-\d\d-\d\d\.$/);
  expect(f.service.sweep().map(row => row.id)).toEqual([notice.id]);
  f.service.checked('loom', [{ ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(25 * DAY) }]);
  expect(f.mail().map(row => row.state)).not.toContain('waiting');
  expect(f.service.sweep()).toEqual([]);
});

it('raises nothing for a machine that has stopped reporting, keeps what it last learned, and still speaks for the others', () => {
  const f = fixture();
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out' }]);
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-out' }]);
  f.advance(10 * 60_000); f.seen('loom');
  expect(f.service.sweep().map(row => row.words)).toEqual(['Claude subscription is signed out on loom (claude in houses).']);
  expect(f.rows()).toHaveLength(2);
  f.seen('one');
  expect(f.service.sweep()).toHaveLength(2);
});

it('leaves a sign-in the worker could not read as it was, and still records the ones it could', () => {
  const f = fixture();
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-out', why: 'no-file' }, { ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(9 * DAY) }]);
  const [notice] = f.service.sweep();
  f.advance(60_000); f.seen('loom');
  // The machine's own file cannot be read this round; the houses' sign-in is back.
  expect(f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: f.at(20 * DAY) }, { ...claude, place: 'host', state: 'unknown' }])).toEqual(['sub']);
  expect(f.rows().map(row => [row.place, row.state, row.expiresAt])).toEqual([['containers', 'signed-in', f.at(20 * DAY)], ['host', 'signed-in', f.at(9 * DAY - 60_000)]]);
  expect(f.mail().find(row => row.id === notice.id)!.state).not.toBe('waiting');
  // Unknown about a sign-in never recorded records nothing.
  expect(f.service.checked('one', [{ ...claude, place: 'host', state: 'unknown' }])).toEqual([]);
  expect(f.rows().filter(row => row.box === 'one')).toEqual([]);
});

it('closes what was said about a machine taken out of the household', () => {
  const f = fixture();
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out' }, { ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(DAY) }]);
  expect(f.service.sweep()).toHaveLength(2);
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'one')).run();
  expect(f.service.sweep()).toEqual([]);
  expect(f.rows()).toEqual([]);
  expect(f.mail().filter(row => row.state === 'waiting')).toEqual([]);
});

it('takes a model reply as proof that a watched house sign-in still works, without touching its end, adding one, or overruling a check that found it gone', () => {
  const f = fixture();
  const job = { account: 'sub', box: 'loom', harness: 'claude' };
  // Nothing the worker watches: a reply adds no record of its own, so the worker's list stays the whole record.
  expect(f.service.replied(job)).toBe(false);
  expect(f.rows()).toEqual([]);
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: f.at(9 * DAY) }, { ...claude, place: 'host', state: 'signed-in' }]);
  f.advance(1000);
  expect(f.service.replied(job)).toBe(true);
  expect(f.rows()).toMatchObject([{ place: 'containers', expiresAt: f.at(9 * DAY - 1000), learnedFrom: 'job', checkedAt: f.now() }, { place: 'host', learnedFrom: 'check' }]);
  expect(f.rows()[0].since).not.toBe(f.now());
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-out', why: 'ended' }]);
  expect(f.service.replied(job)).toBe(false);
  expect(f.rows()).toMatchObject([{ state: 'signed-out', why: 'The sign-in has ended.' }]);
  expect(f.service.replied({ account: 'sub', box: null, harness: 'claude' })).toBe(false);
  expect(f.service.replied({ account: 'sub', box: 'loom', harness: 'other' })).toBe(false);
});

it('stops watching a sign-in the worker no longer names or whose account is no longer enabled there, and closes its notices', () => {
  const f = fixture();
  f.service.checked('one', [{ ...claude, place: 'containers', state: 'signed-out' }, { ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(DAY) },
    { account: 'never-enabled', harness: 'claude', place: 'host', state: 'signed-out' }]);
  expect(f.rows()).toHaveLength(2);
  expect(f.service.sweep()).toHaveLength(2);
  expect(f.service.checked('one', [{ ...claude, place: 'host', state: 'signed-in', expiresAt: f.at(DAY) }])).toEqual(['sub']);
  expect(f.rows().map(row => row.place)).toEqual(['host']);
  expect(f.mail().filter(row => row.state === 'waiting')).toHaveLength(1);
  f.service.forget('sub', 'one');
  expect(f.rows()).toEqual([]);
  expect(f.mail().filter(row => row.state === 'waiting')).toEqual([]);
  // Another machine's record is not this worker's to replace.
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in' }]);
  f.service.checked('one', []);
  expect(f.rows().map(row => row.box)).toEqual(['loom']);
});

it('says again that a sign-in is ending after it was found gone and came back with the same end', () => {
  const f = fixture(), ends = f.at(2 * DAY);
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: ends }]);
  const [first] = f.service.sweep();
  expect(first.words).toMatch(/ends in /);
  f.advance(60_000); f.seen('loom');
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-out', why: 'no-file' }]);
  expect(f.service.sweep().map(row => row.words)).toEqual(['Claude subscription is signed out on loom (claude in houses). There is no sign-in file.']);
  expect(f.mail().find(row => row.id === first.id)!.state).not.toBe('waiting');
  f.advance(60_000); f.seen('loom');
  f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: ends }]);
  const open = f.service.sweep();
  expect(open).toHaveLength(1);
  expect(open[0].id).not.toBe(first.id);
  expect(open[0]).toMatchObject({ state: 'waiting' });
  expect(f.mail().filter(row => row.state === 'waiting').map(row => row.id)).toEqual([open[0].id]);
  expect(() => f.service.sweep(0)).toThrow('Invalid silence interval');
});

it('keeps no end for a time outside the years the database holds, and still records the sign-in', () => {
  const f = fixture();
  expect(f.service.checked('loom', [{ ...claude, place: 'containers', state: 'signed-in', expiresAt: '9999-12-31T23:59:59-01:00' }])).toEqual(['sub']);
  expect(f.rows()).toMatchObject([{ state: 'signed-in', expiresAt: null }]);
});
