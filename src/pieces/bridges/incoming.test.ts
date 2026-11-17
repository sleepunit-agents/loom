import { graphql } from 'graphql/index.js';
import { dataQueries } from '../../core/data/queries.js';
import { workVisibility } from '../../core/data/work-visibility.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgePeople, bridgeChannels, bridgeChannelFilters, bridgeIncoming, conversations, turns, inbox } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import { BridgeIncoming, type IncomingMessage } from './incoming.js';
import { expirePrivateBridgeWords, oldestPrivateBridgeWords } from '../../core/conversations/private-bridge-words.js';
import { bridgeSends } from '../../core/data/schema.js';
import {normalizeSlack} from './normalize.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture(platform: 'discord' | 'slack' = 'discord') {
  const client = new Database(':memory:'); clients.push(client);
  const now = () => '2026-11-14T12:00:00.000Z';
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  db.insert(bridgeConnections).values({ id: 'c', platform, agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgeConnections).values({ id: 'peer', platform, agent: 'mark', workspace: 'w', botUser: 'bot-mark', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgePeople).values({ platform, workspace: 'w', user: 'outside', member: 'jonathan' }).run();
  db.insert(bridgeChannels).values({ platform, workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  const ingress = new BridgeIncoming(db, now);
  const message: IncomingMessage = { id: 'm', connection: 'c', channel: 'room', isDm: false, user: 'outside', text: 'Friday?', postedAt: now(), mentions: [] };
  return { client, db, ingress, message, now };
}
describe('shared-schema bridge ingress', () => {
  it.each(['channel','group'] as const)('keeps independent Slack %s roots separate and children with their root',kind=>{
    const f=fixture('slack');
    const receive=(ts:string,thread_ts?:string)=>f.ingress.receive(normalizeSlack({id:'c',workspace:'w'},{type:'event_callback',team_id:'w',event:{type:'message',channel:'room',channel_type:kind,user:'outside',ts,thread_ts,text:'Channel words'}})!);
    const first=receive('1794672000.000001'),second=receive('1794672001.000001'),child=receive('1794672002.000001','1794672000.000001');
    expect([first.state,second.state,child.state]).toEqual(['delivered','delivered','delivered']);
    expect(second.conversation).not.toBe(first.conversation);expect(child.conversation).toBe(first.conversation);
    expect(f.db.select().from(conversations).all()).toHaveLength(2);expect(f.db.select().from(inbox).all()).toHaveLength(3);
  });
  it.each(['im','mpim'] as const)('keeps successive unthreaded Slack %s messages in one conversation',kind=>{
    const f=fixture('slack');
    const receive=(ts:string)=>f.ingress.receive(normalizeSlack({id:'c',workspace:'w'},{type:'event_callback',team_id:'w',event:{type:'message',channel:'direct',channel_type:kind,user:'outside',ts,text:'Direct words'}})!);
    const first=receive('1794672000.000001'),second=receive('1794672001.000001');
    expect(first.state).toBe('delivered');expect(second.state).toBe('delivered');
    expect(second.conversation).toBe(first.conversation);expect(first.thread).toBeNull();
    expect(f.db.select().from(conversations).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all()).toHaveLength(2);
  });
  it.each(['discord', 'slack'] as const)('delivers %s once into conversation, turn and inbox', platform => {
    const f = fixture(platform);
    const row = f.ingress.receive(f.message);
    expect(row).toMatchObject({ state: 'delivered', member: 'jonathan', deliveredAt: f.now() });
    expect(f.db.select().from(inbox).all()).toEqual([expect.objectContaining({ source: platform, sourceId: JSON.stringify(['w', 'room', 'm']), conversation: row.conversation, fromKind: 'person', fromId: 'jonathan', words: 'Friday?' })]);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(f.ingress.receive(f.message)).toEqual(row);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(() => f.ingress.receive({ ...f.message, text: 'changed' })).toThrow('reused');
    f.ingress.receive({ ...f.message, id: 'm2' });
    expect(f.db.select().from(conversations).all()).toHaveLength(1);
    expect(f.db.select().from(turns).all().map(t => t.seq)).toEqual([1, 2]);
  });
  it('addresses explicit mentions, ignores another agent, and allows direct messages', () => {
    const f = fixture();
    expect(f.ingress.receive({ ...f.message, id: 'other', mentions: ['bot-mark'] }).state).toBe('dropped');
    f.db.update(bridgeChannels).set({ answers: 'mark' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'none' }).state).toBe('dropped');
    expect(f.ingress.receive({ ...f.message, id: 'mention', mentions: ['bot-art'] }).state).toBe('delivered');
    const dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true });
    expect(dm.state).toBe('delivered');
    expect(f.db.select().from(conversations).where(eq(conversations.id, dm.conversation!)).get()?.member).toBe('jonathan');
  });
  it('does not infer a household identity for an unknown outside person', () => {
    const f = fixture();
    expect(f.ingress.receive({ ...f.message, user: 'stranger' })).toMatchObject({ state: 'delivered', member: null });
    expect(f.db.select().from(inbox).get()).toMatchObject({ fromKind: 'unknown', fromId: null });
  });
  it('requires a known bot and an enabled bot channel rule', () => {
    const f = fixture();
    expect(f.ingress.receive({ ...f.message, id: 'self', user: 'bot-art' }).reason).toBe('Own message');
    expect(f.ingress.receive({ ...f.message, id: 'disabled', user: 'bot-mark', bot: true, mentions: ['bot-art'] }).state).toBe('dropped');
    f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
    expect(f.ingress.receive({ ...f.message, id: 'unknown', user: 'alien-bot', bot: true, mentions: ['bot-art'] }).state).toBe('dropped');
    expect(f.ingress.receive({ ...f.message, id: 'unaddressed', user: 'bot-mark', bot: true }).state).toBe('delivered');
    f.db.update(bridgeChannels).set({ answers: 'mark' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'other-default', user: 'bot-mark', bot: true }).state).toBe('dropped');
    expect(f.ingress.receive({ ...f.message, id: 'known', user: 'bot-mark', mentions: ['bot-art'] }).state).toBe('delivered');
    expect(f.db.select().from(inbox).get()).toMatchObject({ fromKind: 'agent', fromId: 'mark' });
  });
  it('holds conflicting recipient assignments for the same bot', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ botUser: 'bot-art' }).where(eq(bridgeConnections.id, 'peer')).run();
    const message = { ...f.message, mentions: ['bot-art'] };
    expect(f.ingress.receive(message)).toMatchObject({ state: 'held', reason: 'Ambiguous connection agent', conversation: null });
    expect(f.ingress.receive({ ...message, connection: 'peer' })).toMatchObject({ state: 'held', reason: 'Ambiguous connection agent', conversation: null });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
    expect(f.db.select().from(turns).all()).toHaveLength(0);
  });
  it('holds conflicting bot-to-agent assignments instead of guessing', () => {
    const f = fixture();
    f.db.insert(bridgeConnections).values({ id: 'conflict', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-mark', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
    f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
    expect(f.ingress.receive({ ...f.message, user: 'bot-mark', mentions: ['bot-art'] })).toMatchObject({ state: 'held', reason: 'Ambiguous bot identity', conversation: null });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
  });
  it('scopes person links to both platform and workspace', () => {
    const f = fixture();
    f.db.insert(members).values({ id: 'other', role: 'member', joinedAt: f.now() }).run();
    f.db.delete(bridgePeople).run();
    f.db.insert(bridgePeople).values([
      { platform: 'slack', workspace: 'w', user: 'outside', member: 'other' },
      { platform: 'discord', workspace: 'another', user: 'outside', member: 'other' },
      { platform: 'discord', workspace: 'w', user: 'outside', member: 'jonathan' },
    ]).run();
    expect(f.ingress.receive(f.message).member).toBe('jonathan');
  });
  it('applies only and ignore filters to a thread parent', () => {
    const f = fixture();
    f.db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'allowed', rule: 'only' }).run();
    expect(f.ingress.receive(f.message).reason).toBe('Channel filtered');
    expect(f.ingress.receive({ ...f.message, id: 'yes', parent: 'allowed', mentions: ['bot-art'] }).state).toBe('delivered');
    f.db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'allowed', rule: 'ignore' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'no', parent: 'allowed', mentions: ['bot-art'] }).state).toBe('dropped');
  });
  it('holds disabled connections until explicit retry, without duplicating a turn', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'c')).run();
    expect(f.ingress.receive(f.message)).toMatchObject({ state: 'held', reason: 'Connection disabled' });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
    f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'c')).run();
    expect(f.ingress.receive(f.message)).toMatchObject({ state: 'held', reason: 'Connection disabled' });
    expect(f.ingress.receive(f.message, true).state).toBe('delivered');
    f.ingress.receive(f.message, true);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
  });
  it('keeps workspace, channel, and thread conversations distinct', () => {
    const f = fixture();
    f.ingress.receive(f.message);
    f.ingress.receive({ ...f.message, id: 'thread', thread: 't' });
    f.ingress.receive({ ...f.message, id: 'other-channel', channel: 'elsewhere', mentions: ['bot-art'] });
    f.db.update(bridgeConnections).set({ workspace: 'w2' }).where(eq(bridgeConnections.id, 'c')).run();
    f.ingress.receive({ ...f.message, id: 'workspace', mentions: ['bot-art'] });
    expect(f.db.select().from(conversations).all()).toHaveLength(4);
  });
  it('delivers a message seen by two connections for one agent only once', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ agent: 'art' }).where(eq(bridgeConnections.id, 'peer')).run();
    const message = { ...f.message, mentions: ['bot-art', 'bot-mark'] };
    const first = f.ingress.receive(message);
    const second = f.ingress.receive({ ...message, connection: 'peer' });
    expect(second).toMatchObject({ state: 'delivered', conversation: first.conversation });
    expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all()).toHaveLength(1);
  });
  it('delivers the same place to separate agents when both are addressed', () => {
    const f = fixture();
    const message = { ...f.message, mentions: ['bot-art', 'bot-mark'] };
    const art = f.ingress.receive(message);
    const mark = f.ingress.receive({ ...message, connection: 'peer' });
    expect(mark.conversation).not.toBe(art.conversation);
    expect(f.db.select().from(conversations).all().map(c => c.agent).sort()).toEqual(['art', 'mark']);
    expect(f.db.select().from(inbox).all().map(i => i.to).sort()).toEqual(['art', 'mark']);
    expect(f.db.select().from(turns).all()).toHaveLength(2);
  });
  it('rolls back incoming and turn creation when inbox insertion fails', () => {
    const f = fixture();
    f.client.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END");
    expect(() => f.ingress.receive(f.message)).toThrow('inbox unavailable');
    expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(0);
    expect(f.db.select().from(conversations).all()).toHaveLength(0);
    expect(f.db.select().from(turns).all()).toHaveLength(0);
    f.client.exec('DROP TRIGGER fail_inbox');
    expect(f.ingress.receive(f.message).state).toBe('delivered');
  });
});

it('a changed DM person link opens a separate private conversation and never relabels prior history', () => {
 const f=fixture();
 f.db.insert(members).values({id:'other',role:'member',joinedAt:f.now()}).run();
 const first=f.ingress.receive({...f.message,id:'private-first',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'other'}).run();
 const second=f.ingress.receive({...f.message,id:'private-second',isDm:true,channel:'direct'});
 expect(second.conversation).not.toBe(first.conversation);
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBe('jonathan');
 expect(f.db.select().from(conversations).where(eq(conversations.id,second.conversation!)).get()?.member).toBe('other');
 expect(f.db.select().from(inbox).where(eq(inbox.conversation,first.conversation!)).get()?.member).toBe('jonathan');
 expect(f.db.select().from(inbox).where(eq(inbox.conversation,second.conversation!)).get()?.member).toBe('other');
});
it('group DMs never use one participant private-member context or a prior single-DM history', () => {
 const f=fixture();
 const first=f.ingress.receive({...f.message,id:'private-first',isDm:true,channel:'direct'});
 const group=f.ingress.receive({...f.message,id:'group-message',isDm:true,groupDm:true,channel:'direct'});
 expect(group.conversation).not.toBe(first.conversation);
 expect(group.member).toBe('jonathan');
 expect(f.db.select().from(conversations).where(eq(conversations.id,group.conversation!)).get()?.member).toBeNull();
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBe('jonathan');
});

it('ordinary members read only their own DM generation after a person-link reassignment', async () => {
 const f=fixture();
 f.db.insert(members).values(['alice','bob'].map(id=>({id,role:'member' as const,joinedAt:f.now()}))).run();
 f.db.update(bridgePeople).set({member:'alice'}).run();
 const first=f.ingress.receive({...f.message,id:'alice-private',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'bob'}).run();
 const second=f.ingress.receive({...f.message,id:'bob-private',isDm:true,channel:'direct'});
 for(const [member,id] of [['alice',first.conversation],['bob',second.conversation]]){
  const schema=dataQueries(f.client,{tables:['conversations'],visibility:{conversations:workVisibility({kind:'member',id:member!}).approvals}});
  const result=await graphql({schema,source:'{ conversations { id member } }'});expect(result.errors).toBeUndefined();
  expect(result.data?.conversations).toEqual([{id,member}]);
 }
});

it('a delayed duplicate on a second connection preserves the original DM actor and conversation after relinking', () => {
 const f=fixture();f.db.insert(members).values(['alice','bob'].map(id=>({id,role:'member' as const,joinedAt:f.now()}))).run();f.db.update(bridgePeople).set({member:'alice'}).run();
 const connection=f.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,'c')).get()!;
 f.db.insert(bridgeConnections).values({...connection,id:'second'}).run();
 const first=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'bob'}).run();
 const again=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second'});
 expect(again).toMatchObject({conversation:first.conversation,member:'alice',state:'delivered'});
 expect(f.db.select().from(conversations).all()).toHaveLength(1);expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('a newly linked single-DM member gets a private conversation without adopting unknown-actor history', () => {
 const f=fixture();f.db.delete(bridgePeople).run();
 const first=f.ingress.receive({...f.message,id:'unknown-private',isDm:true,channel:'direct'});
 f.db.insert(members).values({id:'alice',role:'member',joinedAt:f.now()}).run();
 f.db.insert(bridgePeople).values({platform:'discord',workspace:'w',user:'outside',member:'alice'}).run();
 const next=f.ingress.receive({...f.message,id:'known-private',isDm:true,channel:'direct'});
 expect(next.conversation).not.toBe(first.conversation);expect(next.member).toBe('alice');
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBeNull();
 expect(f.db.select().from(conversations).where(eq(conversations.id,next.conversation!)).get()?.member).toBe('alice');
});

it('rejects a conflicting cross-connection copy without creating a second receipt or changing history', () => {
 const f=fixture(),connection=f.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,'c')).get()!;f.db.insert(bridgeConnections).values({...connection,id:'second'}).run();
 const first=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct'});
 expect(()=>f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second',text:'Changed words'})).toThrow('identity changed');
 expect(()=>f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second',user:'different-sender'})).toThrow('identity changed');
 expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(1);expect(f.db.select().from(conversations).all()).toHaveLength(1);expect(f.db.select().from(inbox).get()?.conversation).toBe(first.conversation);
});

it('reuses the original public channel place key',()=>{
 const f=fixture(),prior=new Conversations(f.db,f.now).open({agent:'art',venue:'discord',place:JSON.stringify(['w','room',null]),label:'Existing public room'});
 const row=f.ingress.receive(f.message);
 expect(row.conversation).toBe(prior.id);expect(f.db.select().from(conversations).all()).toHaveLength(1);
});
it('erases a private DM\'s words at the keep time, in every column that holds them, and nothing else', () => {
  const f = fixture(), dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' });
  const room = f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' });
  expect(f.db.select().from(conversations).where(eq(conversations.id, dm.conversation!)).get()?.member).toBe('jonathan');
  for (const [id, incoming, state] of [['sent', dm.id, 'sent'], ['waiting', dm.id, 'held'], ['room', room.id, 'sent']] as const)
    f.db.insert(bridgeSends).values({ id, incoming, connection: 'c', channel: 'x', text: 'Reply words', state, createdAt: f.now() }).run();
  const words = () => ({ mail: f.db.select({ words: inbox.words }).from(inbox).all().map(row => row.words), received: f.db.select({ text: bridgeIncoming.text }).from(bridgeIncoming).all().map(row => row.text),
    replies: Object.fromEntries(f.db.select().from(bridgeSends).all().map(row => [row.id, row.text])) });
  expect(oldestPrivateBridgeWords(f.db)).toBe(Date.parse(f.now()));
  // Younger than the keep time: untouched.
  expect(expirePrivateBridgeWords(f.db, '2026-11-14T11:59:59.999Z')).toBe(0);
  expect(expirePrivateBridgeWords(f.db, '2026-11-14T12:00:00.000Z')).toBe(3);
  // The room is not private, and a reply a person has yet to decide on is still needed.
  expect(words()).toEqual({ mail: [null, 'Room words'], received: ['', 'Room words'], replies: { sent: '', waiting: 'Reply words', room: 'Reply words' } });
  expect(oldestPrivateBridgeWords(f.db)).toBeUndefined();
  // A late replay of the erased message is still the same message, not a reused id.
  expect(f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' })).toMatchObject({ id: dm.id, state: 'delivered', text: '' });
  expect(() => f.ingress.receive({ ...f.message, id: 'room', text: 'Other words' })).toThrow('reused');
});
