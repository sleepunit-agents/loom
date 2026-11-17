import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeConnections, bridgeIncoming, bridgeSendFiles, bridgeSendParts, bridgeSends } from '../../core/data/schema.js';
import { BridgeSends, SEND_FILES, SEND_FILES_BYTES, STOPPED_LINE, reviewReply } from './sends.js';
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
  const parts = (id = 'reply') => db.select({ part: bridgeSendParts.part, postedId: bridgeSendParts.postedId }).from(bridgeSendParts).where(eq(bridgeSendParts.send, id)).orderBy(asc(bridgeSendParts.part)).all();
  return { db, client, sends, post, changed, read, parts, now, advance: () => { time += 1000; } };
}

describe('approved bridge reply queue', () => {
  it.each(['discord', 'slack'] as const)('records a confirmed %s send, with address and receipt', async platform => {
    const f = fixture(platform);
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'Hello back' });
    expect(f.read()).toMatchObject({ state: 'pending', channel: 'channel', thread: 'thread', createdAt: f.now() });
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ platform }), { channel: 'channel', thread: 'thread' }, 'Hello back');
    expect(f.read().state).toBe('sent'); expect(f.parts()).toEqual([{ part: 0, postedId: 'posted' }]);
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
    expect(f.read().state).toBe('uncertain'); expect(f.parts()).toEqual([]);
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
    expect(f.read().state).toBe('sent'); expect(f.parts()).toEqual([{ part: 0, postedId: 'arrived' }]);
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
    expect(f.read().state).toBe('pending'); expect(f.parts()).toEqual([]);
    // Its own write must not make it spin: the next attempt waits a little.
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(1);
    for (let second = 0; second < 5; second++) f.advance();
    await f.sends.flush();
    expect(f.read().state).toBe('sent'); expect(f.parts()).toEqual([{ part: 0, postedId: 'posted' }]);
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

  it('finishes a reply whose later part never left, from the part it stopped at, as the one row it always was', async () => {
    const f = fixture(), text = 'a'.repeat(2000) + 'b'.repeat(2000) + 'c'.repeat(500);
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(true));
    f.sends.queue({ id: 'reply', incoming: 'in', text });
    await f.sends.flush();
    // The reply is still one row with all its words, waiting; what the platform confirmed is recorded part by part.
    expect(f.read()).toMatchObject({ state: 'pending', text });
    expect(f.parts()).toEqual([{ part: 0, postedId: 'first' }]);
    // A retry of the same reply is still the same reply; another text under its id is not.
    expect(f.sends.queue({ id: 'reply', incoming: 'in', text }).id).toBe('reply');
    expect(() => f.sends.queue({ id: 'reply', incoming: 'in', text: 'a'.repeat(2000) })).toThrow('reused');
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    for (let second = 0; second < 5; second++) f.advance();
    f.post.mockResolvedValueOnce({ id: 'second' }).mockResolvedValueOnce({ id: 'third' });
    await f.sends.flush();
    expect(f.read()).toMatchObject({ state: 'sent', text });
    expect(f.parts()).toEqual([{ part: 0, postedId: 'first' }, { part: 1, postedId: 'second' }, { part: 2, postedId: 'third' }]);
    // The outside reader has every character once, in order.
    expect((f.post.mock.calls as unknown as [unknown, unknown, string][]).map(call => call[2]).filter((_, index) => index !== 1).join('')).toBe(text);
    expect(f.db.select().from(bridgeSends).all()).toHaveLength(1);
  });

  it('finishes a partly posted reply after a restart, from the parts the earlier run recorded', async () => {
    const f = fixture(), text = 'a'.repeat(2000) + 'b'.repeat(10);
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(true));
    f.sends.queue({ id: 'reply', incoming: 'in', text });
    await f.sends.flush(); await f.sends.close();
    const post = vi.fn(async () => ({ id: 'second' })), again = new BridgeSends(f.db, { post }, f.now);
    await again.flush();
    expect(post.mock.calls.map(call => (call as unknown as [unknown, unknown, string])[2])).toEqual(['b'.repeat(10)]);
    expect(f.read().state).toBe('sent'); expect(f.parts()).toEqual([{ part: 0, postedId: 'first' }, { part: 1, postedId: 'second' }]);
  });

  it('calls a partly posted reply uncertain when a later part may have arrived, keeps what was confirmed, and never sends it again', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new Error('timeout'));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'x'.repeat(2000) + 'y' });
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.read()).toMatchObject({ state: 'uncertain', text: 'x'.repeat(2000) + 'y' });
    // The first part is known to be out; the second is the one in doubt.
    expect(f.parts()).toEqual([{ part: 0, postedId: 'first' }]);
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(() => reviewReply(f.db, 'reply', 'release')).toThrow('not awaiting');
    reviewReply(f.db, 'reply', 'dismiss');
    expect(f.read().state).toBe('dismissed');
  });

  it('hands a partly posted reply to a person when its next part can never be built, and goes on from there when released', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(false));
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'x'.repeat(2000) + 'y' });
    await f.sends.flush();
    expect(f.read().state).toBe('held');
    reviewReply(f.db, 'reply', 'release'); f.post.mockResolvedValueOnce({ id: 'second' });
    await f.sends.flush();
    expect(f.read().state).toBe('sent');
    expect((f.post.mock.calls as unknown as [unknown, unknown, string][]).map(call => call[2])).toEqual(['x'.repeat(2000), 'y', 'y']);
  });
});
it('processes a second committed send queued while an earlier flush is awaiting HTTP',async()=>{
 const f=fixture();let release!:(receipt:{id:string})=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.post.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 f.sends.queue({id:'first',incoming:'in',text:'First'});const first=f.sends.flush();await started;f.sends.queue({id:'second',incoming:'in',text:'Second'});const second=f.sends.flush();expect(second).toBe(first);release({id:'posted-first'});await second;expect(f.read('first').state).toBe('sent');expect(f.read('second').state).toBe('sent');expect(f.post).toHaveBeenCalledTimes(2);
});
it('notifies standalone consumers only after queue and send states commit',async()=>{
 const f=fixture(),states:string[]=[];f.changed.mockImplementation(()=>{expect(f.client.inTransaction).toBe(false);states.push(f.read().state);});f.sends.queue({id:'reply',incoming:'in',text:'Hi'});await f.sends.flush();expect(states).toEqual(['pending','sending','sent']);
});
it('queues a post to a message that was not delivered only as loom\'s own line after a stop word', () => {
  const f = fixture();
  f.db.insert(bridgeIncoming).values([
    { id: 'stop', connection: 'c', channel: 'channel', thread: null, isDm: false, user: 'person', text: '', postedAt: f.now(), receivedAt: f.now(), state: 'dropped', reason: 'Stop word' },
    { id: 'stranger', connection: 'c', channel: 'channel', thread: null, isDm: false, user: 'x', text: '', postedAt: f.now(), receivedAt: f.now(), state: 'dropped', reason: 'Unknown sender' },
  ]).run();
  // Nothing else may be posted to a dropped message: not other words to a stop, and not this line to a stranger.
  expect(() => f.sends.queue({ id: 'a', incoming: 'stop', text: STOPPED_LINE })).toThrow('No delivered message');
  expect(() => f.sends.queue({ id: 'b', incoming: 'stop', text: 'Anything else', stopped: true })).toThrow('No delivered message');
  expect(() => f.sends.queue({ id: 'c', incoming: 'stranger', text: STOPPED_LINE, stopped: true })).toThrow('No delivered message');
  expect(() => f.sends.queue({ id: 'd', incoming: 'in', text: STOPPED_LINE, stopped: true })).toThrow('No delivered message');
  expect(f.sends.queue({ id: 'e', incoming: 'stop', text: STOPPED_LINE, stopped: true })).toMatchObject({ state: 'pending', channel: 'channel', thread: null, text: 'Stopped here.' });
  expect(f.sends.queue({ id: 'f', incoming: 'stop', text: STOPPED_LINE, stopped: true, held: true })).toMatchObject({ state: 'held' });
});
describe('a post\'s files', () => {
  const png = () => ({ name: '../out/plot one.png', contents: Buffer.from('PNG') });
  const kept = (f: ReturnType<typeof fixture>) => f.db.select().from(bridgeSendFiles).all().map(row => [row.send, row.position, row.name, row.contents.toString()]);
  it('are kept with the post, go out with its last part, and are gone once it is sent', async () => {
    const f = fixture();
    const long = 'a'.repeat(1500) + '\n' + 'b'.repeat(1500);
    f.sends.queue({ id: 'reply', incoming: 'in', text: long, files: [png(), { name: 'data.csv', contents: Buffer.from('1,2') }] });
    // A name is the last part of what was given, in plain characters; the order is the order given.
    expect(kept(f)).toEqual([['reply', 0, 'plot_one.png', 'PNG'], ['reply', 1, 'data.csv', '1,2']]);
    await f.sends.flush();
    expect(f.post).toHaveBeenCalledTimes(2);
    const calls = f.post.mock.calls as unknown as [unknown, unknown, string, { name: string; contents: Buffer }[] | undefined][];
    expect(calls[0]).toHaveLength(3);
    expect(calls[1][3]?.map(file => [file.name, file.contents.toString()])).toEqual([['plot_one.png', 'PNG'], ['data.csv', '1,2']]);
    expect(f.read().state).toBe('sent');
    expect(kept(f)).toEqual([]);
  });
  it('wait with a post that was only partly made, and go with the part still to come', async () => {
    const f = fixture();
    f.sends.queue({ id: 'reply', incoming: 'in', text: 'a'.repeat(1500) + '\n' + 'b'.repeat(1500), files: [png()] });
    f.post.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new BridgeReplyNotSent(true));
    await f.sends.flush();
    expect(f.read().state).toBe('pending'); expect(kept(f)).toHaveLength(1);
    f.advance(); f.advance(); f.advance(); f.advance(); f.advance(); f.advance();
    f.post.mockClear();
    await f.sends.flush();
    const calls = f.post.mock.calls as unknown as [unknown, unknown, string, unknown[] | undefined][];
    expect(calls).toHaveLength(1); expect(calls[0][3]).toHaveLength(1);
    expect(f.read().state).toBe('sent'); expect(kept(f)).toEqual([]);
  });
  it('go when the post is in doubt or dismissed, and stay while it is held for a person', async () => {
    const f = fixture();
    f.sends.queue({ id: 'doubt', incoming: 'in', text: 'One', files: [png()] });
    f.post.mockRejectedValueOnce(new Error('socket hang up'));
    await f.sends.flush();
    expect(f.read('doubt').state).toBe('uncertain'); expect(kept(f)).toEqual([]);
    f.sends.queue({ id: 'held', incoming: 'in', text: 'Two', held: true, files: [png()] });
    await f.sends.flush();
    expect(kept(f)).toHaveLength(1);
    reviewReply(f.db, 'held', 'dismiss');
    expect(kept(f)).toEqual([]);
    f.sends.queue({ id: 'released', incoming: 'in', text: 'Three', held: true, files: [png()] });
    reviewReply(f.db, 'released', 'release');
    expect(kept(f)).toHaveLength(1);
    await f.sends.flush();
    expect(f.read('released').state).toBe('sent'); expect(kept(f)).toEqual([]);
  });
  it('are refused past their count or their bytes, when empty, and on Slack, and then nothing is queued', () => {
    const f = fixture();
    const file = (bytes: number) => ({ name: 'f', contents: Buffer.alloc(bytes, 1) });
    expect(() => f.sends.queue({ id: 'a', incoming: 'in', text: 'x', files: Array.from({ length: SEND_FILES + 1 }, () => file(1)) })).toThrow('Files cannot be posted');
    expect(() => f.sends.queue({ id: 'b', incoming: 'in', text: 'x', files: [file(SEND_FILES_BYTES), file(1)] })).toThrow('Files cannot be posted');
    expect(() => f.sends.queue({ id: 'c', incoming: 'in', text: 'x', files: [file(0)] })).toThrow('Files cannot be posted');
    expect(f.db.select().from(bridgeSends).all()).toEqual([]); expect(kept(f)).toEqual([]);
    expect(f.sends.queue({ id: 'd', incoming: 'in', text: 'x', files: [file(SEND_FILES_BYTES)] }).state).toBe('pending');
    const slack = fixture('slack');
    expect(() => slack.sends.queue({ id: 'e', incoming: 'in', text: 'x', files: [file(1)] })).toThrow('Files cannot be posted');
  });
});
