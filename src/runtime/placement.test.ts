import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { agents, members, memberAgents, boxes, boxAgents, boxFacts, agentBoxes, agentModels, modelAccounts, modelAccountWindows, modelAccountBoxes, modelAccountLogins } from '../core/data/schema.js';
import { decidePlacement, QUOTA_WAIT_REASON, selectPlacement } from './placement.js';
const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(client => client.close()));
function fixture(verbose?: (sql: string) => void) {
  const client = new Database(':memory:', { verbose }); opened.push(client);
  const db = createDataSchema(client);
  const now = '2026-11-14T20:00:00.000Z';
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['remote', 'local']) {
    db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: id === 'local', hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now, lastSeenAt: now }).run();
    db.insert(agentBoxes).values({ agent: 'art', box: id, position: id === 'local' ? 0 : 1 }).run();
  }
  db.insert(agentModels).values([{ agent: 'art', model: 'preferred', position: 0 }, { agent: 'art', model: 'backup', position: 1 }]).run();
  db.insert(modelAccounts).values({ id: 'shared', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'shared', window: 'week', usage: 0.2, usageReadAt: now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values([{ account: 'shared', box: 'local' }, { account: 'shared', box: 'remote' }]).run();
  const input = { agent: 'art', now, roles: [{ model: 'unlisted', provider: 'provider', harness: 'runner', series: 'series' }, { model: 'preferred', provider: 'provider', harness: 'runner', series: 'series' }, { model: 'backup', provider: 'provider', harness: 'other', series: 'series' }] };
  return { db, input };
}
it('uses ordered workers and models, with the same heartbeat requirement on loom’s machine', () => {
  const { db, input } = fixture();
  expect(selectPlacement(db, input)).toEqual({ box: 'local', model: 'preferred', account: 'shared', harness: 'runner' });
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:55:00.000Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(boxes).set({ reportOnly: true }).where(eq(boxes.id, 'remote')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('matches capabilities and never silently substitutes a disallowed requested model', () => {
  const { db, input } = fixture();
  db.insert(boxFacts).values({ box: 'remote', fact: 'gpu:5090', fromOwner: false }).run();
  expect(selectPlacement(db, { ...input, needs: ['gpu:5090'] })?.box).toBe('remote');
  expect(selectPlacement(db, { ...input, wants: 'unlisted' })).toBeUndefined();
  expect(selectPlacement(db, { ...input, wants: 'backup' })?.harness).toBe('other');
});
it('shares exhausted account capacity across workers and respects actual sign-in locations', () => {
  const { db, input } = fixture();
  db.delete(modelAccountBoxes).where(eq(modelAccountBoxes.box, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(modelAccounts).set({ hasRoom: false }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('uses explicit lending when the worker does not host the agent owner’s agents', () => {
  const { db, input } = fixture();
  db.update(boxes).set({ hostsAny: false }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.insert(boxAgents).values({ box: 'remote', agent: 'art', lent: true }).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(boxes).set({ revokedAt: input.now }).where(eq(boxes.id, 'remote')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});

it('rejects foreign-owned hostsAny machines and unrelated provider accounts', () => {
  const { db, input } = fixture();
  db.insert(members).values({ id: 'other', role: 'member', joinedAt: input.now }).run();
  db.update(boxes).set({ owner: 'other' }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.insert(boxAgents).values({ box: 'remote', agent: 'art', lent: true }).run();
  db.update(modelAccounts).set({ provider: 'unrelated' }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.update(modelAccounts).set({ provider: 'provider' }).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
});
it('matches complete capability values and pins the heartbeat boundary', () => {
  const { db, input } = fixture();
  db.insert(boxFacts).values({ box: 'local', fact: 'gpu:15090', fromOwner: true }).run();
  expect(selectPlacement(db, { ...input, needs: ['gpu:5090'] })).toBeUndefined();
  db.update(boxes).set({ lastSeenAt: null }).where(eq(boxes.id, 'remote')).run();
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:58:00.000Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:57:59.999Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('honors configured preference positions even when they oppose identifier order', () => {
  const { db, input } = fixture();
  db.update(agentBoxes).set({ position: -1 }).where(eq(agentBoxes.box, 'remote')).run();
  db.update(agentModels).set({ position: -1 }).where(eq(agentModels.model, 'backup')).run();
  expect(selectPlacement(db, input)).toEqual({ box: 'remote', model: 'backup', account: 'shared', harness: 'other' });
});
it('uses the persisted provider quota summary for all agents sharing the subscription', async () => {
  const { recordAccountWindows } = await import('./account-windows.js');
  const { db, input } = fixture();
  db.insert(agents).values({ id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'mark' }).run();
  db.insert(agentBoxes).values({ agent: 'mark', box: 'local', position: 0 }).run();
  db.insert(agentModels).values({ agent: 'mark', model: 'preferred', position: 0 }).run();
  const other = { ...input, agent: 'mark' };
  expect(selectPlacement(db, input)?.account).toBe('shared');
  expect(selectPlacement(db, other)?.account).toBe('shared');
  recordAccountWindows(db, { account: 'shared', owner: 'owner', provider: 'provider' },
    [{ name: 'week', usage: 1, readAt: input.now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }], input.now);
  expect(selectPlacement(db, input)).toBeUndefined();
  expect(selectPlacement(db, other)).toBeUndefined();
});

it('closes placement when shared observations expire even while summary says room', () => {
  const { db, input } = fixture();
  db.update(modelAccountWindows).set({ resetsAt: input.now, usageReadAt: '2026-11-14T19:00:00.000Z' }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  expect(db.select().from(modelAccounts).get()!.hasRoom).toBe(true);
});
it('runs work that wants a tag on any allowed model carrying it, in the agent\'s order, across families', () => {
  const { db, input } = fixture(), now = input.now;
  db.insert(modelAccounts).values({ id: 'second', owner: 'owner', provider: 'other-provider', label: 'Other', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'second', window: 'week', usage: 0.2, usageReadAt: now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values({ account: 'second', box: 'local' }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'other-best', position: 2 }).run();
  const roles = [{ model: 'preferred', provider: 'provider', harness: 'runner', series: 'a', tag: 'normal' }, { model: 'backup', provider: 'provider', harness: 'runner', series: 'a', tag: 'best' },
    { model: 'other-best', provider: 'other-provider', harness: 'other', series: 'b', tag: 'best' }, { model: 'not-allowed', provider: 'provider', harness: 'runner', series: 'a', tag: 'low' }];
  const place = (wants?: string | null) => selectPlacement(db, { ...input, roles, wants })?.model;
  expect(place()).toBe('preferred'); expect(place(null)).toBe('preferred');
  expect(place('best')).toBe('backup'); expect(place('normal')).toBe('preferred');
  // One model by name works the same way; a tag no allowed model carries, or a model the agent may not use, places nothing.
  expect(place('other-best')).toBe('other-best'); expect(place('low')).toBeUndefined(); expect(place('not-allowed')).toBeUndefined();
  // The first family is out of room: the same tag goes to the next family that has some.
  db.update(modelAccountWindows).set({ usage: 1 }).where(eq(modelAccountWindows.account, 'shared')).run();
  expect(selectPlacement(db, { ...input, roles, wants: 'best' })).toMatchObject({ model: 'other-best', account: 'second', harness: 'other' });
  expect(place('normal')).toBeUndefined();
});

it('hands nothing to the machine of a removed member, whatever lists it was left on', () => {
  const { db, input } = fixture();
  // Lee has art, and a machine that lists art and takes any of lee's agents; it is art's first choice.
  db.insert(members).values({ id: 'lee', role: 'member', joinedAt: input.now }).run();
  db.insert(memberAgents).values({ member: 'lee', agent: 'art' }).run();
  db.insert(boxes).values({ id: 'lees', name: 'lees', owner: 'lee', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: input.now, lastSeenAt: input.now }).run();
  db.insert(boxAgents).values({ box: 'lees', agent: 'art', lent: false }).run();
  db.insert(agentBoxes).values({ agent: 'art', box: 'lees', position: -1 }).run();
  db.insert(modelAccountBoxes).values({ account: 'shared', box: 'lees' }).run();
  expect(selectPlacement(db, input)?.box).toBe('lees');
  // Removing a member keeps their list of agents and their machines. Neither places work any more.
  db.update(members).set({ removedAt: input.now }).where(eq(members.id, 'lee')).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
  // Not when the machine was lent to the agent either: a lent machine is still its owner's to lend.
  db.update(boxAgents).set({ lent: true }).where(eq(boxAgents.box, 'lees')).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
  db.update(members).set({ removedAt: null }).where(eq(members.id, 'lee')).run();
  expect(selectPlacement(db, input)?.box).toBe('lees');
  // An account is its member's too: with its owner removed, nothing is placed on it.
  db.insert(modelAccounts).values({ id: 'aaa-lees', owner: 'lee', provider: 'provider', label: 'Lee', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'aaa-lees', window: 'week', usage: 0.1, usageReadAt: input.now, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values({ account: 'aaa-lees', box: 'lees' }).run();
  expect(selectPlacement(db, input)?.account).toBe('aaa-lees');
  db.update(members).set({ removedAt: input.now }).where(eq(members.id, 'lee')).run();
  expect(selectPlacement(db, input)).toMatchObject({ box: 'local', account: 'shared' });
  db.update(members).set({ removedAt: null }).where(eq(members.id, 'lee')).run();
  // A removed agent is placed nowhere.
  db.update(agents).set({ removedAt: input.now }).where(eq(agents.id, 'art')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});

it('prefers a machine meeting every preferred fact, then uses the agent order among ties or fallbacks', () => {
  const { db, input } = fixture();
  const prefers = ['gpu:5090', 'large'];
  db.insert(boxFacts).values([
    { box: 'remote', fact: 'gpu:5090', fromOwner: true },
    { box: 'remote', fact: 'large', fromOwner: false },
  ]).run();
  expect(selectPlacement(db, { ...input, prefers })?.box).toBe('remote');
  expect(selectPlacement(db, { ...input, prefers: [...prefers, 'other'] })?.box).toBe('local');
  db.delete(modelAccountBoxes).where(eq(modelAccountBoxes.box, 'remote')).run();
  expect(selectPlacement(db, { ...input, prefers })?.box).toBe('local');
});


it('records why each configured machine was passed even when none can claim', () => {
  const { db, input } = fixture();
  const reason = (needs?: string[]) => decidePlacement(db, { ...input, needs }).decision[0];
  expect(reason(['gpu'])).toMatchObject({ box: 'local', outcome: 'passed', reason: expect.stringContaining('gpu') });
  db.update(modelAccounts).set({ hasRoom: false }).run();
  expect(reason()).toMatchObject({ outcome: 'passed', reason: expect.stringContaining('account with room') });
  db.update(boxes).set({ hostsAny: false }).where(eq(boxes.id, 'local')).run();
  expect(reason()).toMatchObject({ outcome: 'passed', reason: expect.stringContaining('does not host art') });
  db.update(boxes).set({ lastSeenAt: null }).where(eq(boxes.id, 'local')).run();
  expect(reason()).toMatchObject({ outcome: 'passed', reason: expect.stringContaining('not live') });
});

it('places a clock program by machine capabilities while every account is unavailable', () => {
  const { db, input } = fixture();
  db.delete(modelAccountBoxes).run();
  const criteria = { ...input, roles: [], programBoxes: new Set(['remote']) };
  expect(decidePlacement(db, criteria).placement?.box).toBe('remote');
  expect(decidePlacement(db, { ...criteria, needs: ['gpu'] }).placement).toBeUndefined();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('passes over a machine whose houses were last found signed out of the account, and says so', () => {
  const { db, input } = fixture();
  const login = { account: 'shared', box: 'local', harness: 'runner', state: 'signed-out', checkedAt: input.now, since: input.now, learnedFrom: 'check' } as const;
  // The machine's own sign-in being gone says nothing about its houses.
  db.insert(modelAccountLogins).values({ ...login, place: 'host' }).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
  db.insert(modelAccountLogins).values({ ...login, place: 'containers' }).run();
  // Another harness on the same machine keeps its own sign-in, so the machine still takes work it can run.
  expect(selectPlacement(db, input)).toMatchObject({ box: 'local', model: 'backup', harness: 'other' });
  db.insert(modelAccountLogins).values({ ...login, place: 'containers', harness: 'other' }).run();
  const decided = decidePlacement(db, input);
  expect(decided.placement).toMatchObject({ box: 'remote', account: 'shared' });
  expect(decided.decision.find(row => row.box === 'local')).toEqual({ box: 'local', outcome: 'passed', reason: 'An account for an allowed model is signed out on this machine.' });
  db.update(modelAccountLogins).set({ state: 'signed-in' }).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
});

it('explains quota only for an eligible container sign-in and a usable window reading',()=>{
  const {db,input}=fixture();
  const quotaLimited=()=>decidePlacement(db,input).quotaLimited;
  db.update(modelAccountWindows).set({usage:1}).run();
  const login={account:'shared',box:'local',harness:'runner',state:'signed-in',checkedAt:input.now,since:input.now,learnedFrom:'check'} as const;
  db.insert(modelAccountLogins).values({...login,place:'host'}).run();
  expect(quotaLimited()).toBe(false);
  db.insert(modelAccountLogins).values({...login,place:'containers'}).run();
  expect(quotaLimited()).toBe(false);
  db.delete(modelAccountLogins).run();
  db.update(modelAccounts).set({usageReadSucceeded:true}).run();
  db.insert(modelAccountLogins).values({...login,place:'host'}).run();
  expect(quotaLimited()).toBe(false);
  db.insert(modelAccounts).values({id:'unbound',owner:'owner',provider:'provider',label:'Other',hasRoom:false}).run();
  db.insert(modelAccountLogins).values({...login,place:'containers',account:'unbound'}).run();
  expect(quotaLimited()).toBe(false);
  db.insert(modelAccountLogins).values({...login,place:'containers',harness:'wrong'}).run();
  expect(quotaLimited()).toBe(false);
  db.insert(modelAccountLogins).values({...login,place:'containers'}).run();
  expect(quotaLimited()).toBe(true);
  expect(decidePlacement(db,input).decision[0]).toEqual({box:'local',outcome:'passed',reason:QUOTA_WAIT_REASON});
  expect(decidePlacement(db,input).decision[1].reason).not.toBe(QUOTA_WAIT_REASON);
  // A second subscription with room but signed out on this worker doesn't hide the signed-in route's quota diagnosis.
  db.insert(modelAccounts).values({id:'second',owner:'owner',provider:'provider',label:'Second',hasRoom:true}).run();
  db.insert(modelAccountBoxes).values({account:'second',box:'local'}).run();
  db.insert(modelAccountWindows).values({account:'second',window:'week',usage:0.1,usageReadAt:input.now,resetsAt:'2026-11-14T21:00:00.000Z',durationMs:7*86400_000}).run();
  for(const harness of ['runner','other'])db.insert(modelAccountLogins).values({...login,account:'second',harness,place:'containers',state:'signed-out'}).run();
  expect(decidePlacement(db,input)).toMatchObject({quotaLimited:true,decision:[{reason:QUOTA_WAIT_REASON},{box:'remote'}]});
  expect(decidePlacement(db,{...input,eligibleBoxes:new Set(['remote'])}).quotaLimited).toBe(false);
  db.update(modelAccountLogins).set({expiresAt:input.now}).run();
  expect(quotaLimited()).toBe(false);
  db.update(modelAccountLogins).set({expiresAt:null}).run();
  db.update(modelAccountWindows).set({resetsAt:input.now,usageReadAt:'2026-11-14T19:00:00.000Z'}).run();
  expect(quotaLimited()).toBe(false);
});

it('reads a fixed number of statements as eligible workers and occupied-slot checks grow', () => {
  let selects = 0;
  const { db, input } = fixture(sql => { if (/^select /i.test(sql)) selects++; });
  db.update(boxes).set({ slots: 1 }).run();
  const measure = (size: number) => {
    selects = 0;
    const result = decidePlacement(db, { ...input, prefers: ['gpu'] });
    expect(result.decision).toHaveLength(size);
    expect(result.placement?.box).toBe('local');
    return selects;
  };
  const baseline = measure(2);
  expect(baseline).toBeGreaterThan(0);
  for (let i = 2; i < 32; i++) {
    const id = 'worker-' + i;
    db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: false,
      hostsAny: true, reportOnly: false, alwaysOn: true, slots: 1, enrolledAt: input.now, lastSeenAt: input.now }).run();
    db.insert(agentBoxes).values({ agent: 'art', box: id, position: i }).run();
  }
  expect(measure(32)).toBe(baseline);
});

it('reads account windows in one batch and selects the first account with room', () => {
  let selects = 0;
  const { db, input } = fixture(sql => { if (/^select /i.test(sql)) selects++; });
  const measure = () => {
    selects = 0;
    expect(selectPlacement(db, input)?.account).toBe('shared');
    return selects;
  };
  const before = measure();
  expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 31; i++) {
    const id = 'busy-' + i;
    db.insert(modelAccounts).values({ id, owner: 'owner', provider: 'provider', label: id, hasRoom: true }).run();
    db.insert(modelAccountBoxes).values({ account: id, box: 'local' }).run();
    db.insert(modelAccountWindows).values({ account: id, window: 'hour', usage: 1, usageReadAt: input.now,
      resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 3600000 }).run();
  }
  expect(measure()).toBe(before);
});
