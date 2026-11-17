import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeIncoming, bridgeSends } from '../../core/data/schema.js';
import { BridgeSends, reviewReply } from './sends.js';
import { BridgeReplyNotSent } from './outbound.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture(platform: 'discord' | 'slack' = 'discord') {
  const client = new Database(':memory:'); opened.push(client);
  let time = Date.parse('2026-11-14T12:00:00Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: 'Bot token', changedAt: now(), changedBy: 'jonathan' }).run();
  db.insert(bridgeConnections).values({ id: 'c', platform, agent: 'art', workspace: 'w', botUser: 'bot', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgeIncoming).values({ id: 'in', connection: 'c', channel: 'channel', thread: 'thread', isDm: false, user: 'person', text: 'Hello', postedAt: now(), receivedAt: now(), state: 'delivered' }).run();
  const post = vi.fn(async () => ({ id: 'posted' }));
  const changed = vi.fn();
  const sends = new BridgeSends(db, { post }, now, changed);
  const read = (id = 'reply') => db.select().from(bridgeSends).where(eq(bridgeSends.id, id)).get()!;
  return { db, client, sends, post, changed, read, now, advance: () => { time += 1000; } };
}

describe('approved bridge reply queue', () => {
  it.each(['discord', 'slack'] as const)('records a confirmed %s send, with address and receipt', async platform => {
    const f = fixture(platform);
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    expect(f.read()).toMatchObject({ state: 'pending', channel: 'channel', thread: 'thread', createdAt: f.now() });
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ platform }), { channel: 'channel', thread: 'thread' }, 'Hello back');
    expect(f.read()).toMatchObject({ state: 'sent', postedId: 'posted' });
    await f.sends.flush();
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(() => f.sends.queue({ id: 'reply', incoming: 'in', text: 'Different' })).toThrow('reused');
  });

  it('holds disabled connections, then lets a person release or dismiss', async () => {
    const f = fixture();
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    f.db.update(bridgeConnections).set({ enabled: false }).run();
    await f.sends.flush();
    expect(f.read().state).toBe('held');
    expect(f.post).not.toHaveBeenCalled();
    f.db.update(bridgeConnections).set({ enabled: true }).run();
    await f.sends.flush();
    expect(f.post).not.toHaveBeenCalled();
    reviewReply(f.db, 'reply', 'release');
    await f.sends.flush();
    expect(f.read().state).toBe('sent');
    f.sends.queue({ id: 'held', incoming: 'in', text: 'Hold', held: true });
    reviewReply(f.db, 'held', 'dismiss');
    expect(f.read('held').state).toBe('dismissed');
    // A decided reply is no longer awaiting one.
    expect(() => reviewReply(f.db, 'held', 'dismiss')).toThrow('not awaiting');
    expect(() => reviewReply(f.db, 'missing', 'dismiss')).toThrow('Unknown send');
  });

  it('waits for a reconnect without attempting a post', async () => {
    const f = fixture();
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    f.db.update(bridgeConnections).set({ state: 'backoff' }).run();
    await f.sends.flush();
    expect(f.read().state).toBe('pending');
    expect(f.post).not.toHaveBeenCalled();
    f.db.update(bridgeConnections).set({ state: 'connected' }).run();
    await f.sends.flush();
    expect(f.read().state).toBe('sent');
  });

  it('records uncertainty without recording an upstream exception or retrying', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new Error('a credential must not be persisted'));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    await f.sends.flush();
    expect(f.read()).toMatchObject({ state: 'uncertain', postedId: null });
    expect(JSON.stringify(f.read())).not.toContain('credential');
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(() => reviewReply(f.db, 'reply', 'release')).toThrow('not awaiting');
    reviewReply(f.db, 'reply', 'dismiss');
    expect(f.read().state).toBe('dismissed');
  });

  it('recovers an interrupted send as uncertain, and never posts it again', async () => {
    const f = fixture();
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    f.db.update(bridgeSends).set({ state: 'sending' }).run();
    const restarted = new BridgeSends(f.db, { post: f.post }, f.now);
    await restarted.flush();
    expect(f.read().state).toBe('uncertain');
    expect(f.post).not.toHaveBeenCalled();
  });

  it('serializes concurrent drains and waits for an in-flight send on close', async () => {
    const f = fixture();
    let finish!: (receipt: { id: string }) => void;
    f.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    const drain = f.sends.flush();
    expect(f.sends.flush()).toBe(drain);
    await Promise.resolve();
    expect(f.read().state).toBe('sending');
    let closed = false;
    const close = f.sends.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish({ id: 'arrived' });
    await close;
    expect(f.read()).toMatchObject({ state: 'sent', postedId: 'arrived' });
    expect(() => f.sends.queue({ id: 'later', incoming: 'in', text: 'Hello' })).toThrow('closed');
  });

  it('does not send network traffic from an uncommitted transaction', () => {
    const f = fixture();
    expect(() => f.db.transaction(() => {
      f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
      f.sends.flush();
    })).toThrow('after committing');
    expect(f.read()).toBeUndefined();
    expect(f.post).not.toHaveBeenCalled();
  });

  it('shares the active drain with a reentrant transport callback', async () => {
    const f = fixture();
    let nested: Promise<void> | undefined;
    f.post.mockImplementationOnce(async () => {
      nested = f.sends.flush();
      return { id: 'posted' };
    });
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello' });
    const drain = f.sends.flush();
    await drain;
    expect(nested).toBe(drain);
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it('keeps a reply that never left pending, and sends it once the transport can', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new BridgeReplyNotSent(true));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    await f.sends.flush();
    // Refused before any request: not uncertain, which could only be dismissed.
    expect(f.read()).toMatchObject({ state: 'pending', postedId: null });
    // Its own write must not make it spin: the next attempt waits a little.
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(1);
    for (let second = 0; second < 5; second++) f.advance();
    await f.sends.flush();
    expect(f.read()).toMatchObject({ state: 'sent', postedId: 'posted' });
    expect(f.post).toHaveBeenCalledTimes(2);
  });

  it('does not claim a reply while the transport is not ready', async () => {
    const f = fixture();
    let ready = false;
    const sends = new BridgeSends(f.db, { ready: () => ready, post: f.post }, f.now, f.changed);
    sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    f.changed.mockClear();
    await sends.flush();
    expect(f.read().state).toBe('pending'); expect(f.post).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
    ready = true; await sends.flush();
    expect(f.read().state).toBe('sent');
  });

  it('hands a reply no request can be built for to a person', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new BridgeReplyNotSent(false));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    await f.sends.flush();
    expect(f.read().state).toBe('held');
  });

  it('finishes a reply whose later part never left, from the part it stopped at', async () => {
    const f = fixture(), text = 'a'.repeat(2000) + 'b'.repeat(2000) + 'c'.repeat(500);
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(true));
    f.sends.queue({ id: 'reply', incoming: 'in', text });
    await f.sends.flush();
    // What the platform confirmed is sent and is not sent again. The remainder is a reply of its own, still to go.
    expect(f.read()).toMatchObject({ state: 'sent', text: 'a'.repeat(2000), postedId: 'first' });
    expect(f.read('reply/rest')).toMatchObject({ state: 'pending', text: 'b'.repeat(2000) + 'c'.repeat(500), postedId: null, incoming: 'in', channel: 'channel', thread: 'thread' });
    // A retry of the same reply is still the same reply; another text under its id is not.
    expect(f.sends.queue({ id: 'reply', incoming: 'in', text }).id).toBe('reply');
    expect(() => f.sends.queue({ id: 'reply', incoming: 'in', text: 'a'.repeat(2000) })).toThrow('reused');
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    for (let second = 0; second < 5; second++) f.advance();
    f.post.mockResolvedValueOnce({ id: 'second' }).mockResolvedValueOnce({ id: 'third' });
    await f.sends.flush();
    expect(f.read('reply/rest')).toMatchObject({ state: 'sent', postedId: 'third' });
    // The outside reader has every character once, in order.
    expect((f.post.mock.calls as unknown as [unknown, unknown, string][]).map(call => call[2]).filter((_, index) => index !== 1).join('')).toBe(text);
    expect(f.db.select().from(bridgeSends).all()).toHaveLength(2);
  });

  it('calls a partly posted reply uncertain as a whole when its remainder cannot have a row', async () => {
    const f = fixture();
    f.sends.queue({ id: 'reply/rest', incoming: 'in', text: 'Somebody chose this id', held: true });
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(true));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'x'.repeat(2001) });
    await f.sends.flush();
    expect(f.read()).toMatchObject({ state: 'uncertain', text: 'x'.repeat(2001), postedId: 'first' });
    expect(f.read('reply/rest')).toMatchObject({ state: 'held', text: 'Somebody chose this id' });
  });

  it('marks only the unconfirmed remainder of a partly posted reply uncertain', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new Error('timeout'));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'x'.repeat(2000) + 'y' });
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.read()).toMatchObject({ state: 'sent', text: 'x'.repeat(2000), postedId: 'first' });
    // The platform may have the second part: a person sees exactly which words are in doubt, and it is never sent again.
    expect(f.read('reply/rest')).toMatchObject({ state: 'uncertain', text: 'y', postedId: null });
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(() => reviewReply(f.db, 'reply/rest', 'release')).toThrow('not awaiting');
    reviewReply(f.db, 'reply/rest', 'dismiss');
    expect(f.read('reply/rest').state).toBe('dismissed');
  });
});
it('processes a second committed send queued while an earlier flush is awaiting HTTP',async()=>{
 const f=fixture();let release!:(receipt:{id:string})=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.post.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 f.sends.queue({id:'first',incoming:'in',text:'First'});const first=f.sends.flush();await started;f.sends.queue({id:'second',incoming:'in',text:'Second'});const second=f.sends.flush();expect(second).toBe(first);release({id:'posted-first'});await second;expect(f.read('first').state).toBe('sent');expect(f.read('second').state).toBe('sent');expect(f.post).toHaveBeenCalledTimes(2);
});
it('notifies standalone consumers only after queue and send states commit',async()=>{
 const f=fixture(),states:string[]=[];f.changed.mockImplementation(()=>{expect(f.client.inTransaction).toBe(false);states.push(f.read().state);});f.sends.queue({id:'reply',incoming:'in',text:'Hi'});await f.sends.flush();expect(states).toEqual(['pending','sending','sent']);
});
