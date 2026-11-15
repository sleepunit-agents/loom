import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgePeople, bridgeChannels, bridgeChannelFilters, bridgeIncoming, conversations, turns, inbox } from '../../core/data/schema.js';
import { BridgeIncoming, type IncomingMessage } from './incoming.js';
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
