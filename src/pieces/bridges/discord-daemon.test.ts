/** The Discord side of the bridge daemon, from a gateway frame to what is delivered, with Discord's API
 * played by a table of answers. What each rule decides is tested where the rule lives (incoming.test.ts,
 * normalize.test.ts); this checks that the daemon reads what those rules need and hands it over. */
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { DataWrites } from '../../core/data/writes.js';
import { FakeClock } from '../../core/clock.js';
import { eq } from 'drizzle-orm';
import { conversations, members, agents, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeFileMessages, bridgeFiles, bridgeIncoming, bridgeSends, inbox, jobs } from '../../core/data/schema.js';
import { Jobs } from '../../runtime/jobs.js';
import { STOP_WORD } from './incoming.js';
import { TAKEN_REACTION, TYPING_EVERY_MS, workingOn } from './presence.js';
import { SharedBridges, type SharedBridgeOptions } from './shared-daemon.js';
import type { DiscordGatewayOptions } from './discord-gateway.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const guild = '100000000000000001', bot = '200000000000000002', mark = '200000000000000003', room = '300000000000000004', person = '400000000000000005';
const artRole = '500000000000000006', markRole = '500000000000000007';

function discordFixture(overrides: Partial<SharedBridgeOptions> = {}) {
  const client = new Database(':memory:'); clean.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'TOKEN', description: '', changedAt: at, changedBy: 'owner' }).run();
  db.insert(bridgeConnections).values({ id: 'connection', platform: 'discord', workspace: guild, botUser: bot, agent: 'art', tokenSecret: 'TOKEN', enabled: true, state: 'disconnected', stateAt: at }).run();
  db.insert(bridgePeople).values({ platform: 'discord', workspace: guild, user: person, member: 'owner' }).run();
  /** What Discord answers, by method and path. A path with no answer is a 404. */
  const answers = new Map<string, unknown>([
    ['GET users/@me', { id: bot, bot: true }],
    [`GET guilds/${guild}`, { id: guild }],
    [`GET guilds/${guild}/roles`, [{ id: guild, managed: false }, { id: artRole, managed: true, tags: { bot_id: bot } }, { id: markRole, managed: true, tags: { bot_id: mark } }]],
    [`GET channels/${room}`, { id: room, guild_id: guild, type: 0 }],
  ]);
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url).replace('https://discord.com/api/v10/', ''), method = options?.method ?? 'GET';
    calls.push({ method, path, ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) });
    const answer = answers.get(`${method} ${path}`);
    if (answer === undefined) return Response.json({ message: 'Not found' }, { status: 404 });
    if (Buffer.isBuffer(answer)) return new Response(answer, { headers: { 'content-type': 'image/png' } });
    return answer === null ? new Response(null, { status: 204 }) : Response.json(answer);
  });
  const gateways: DiscordGatewayOptions[] = [];
  const discord: SharedBridgeOptions['discord'] = options => { gateways.push(options); options.state?.('connected'); return { close: async () => {} }; };
  const errors: Error[] = [];
  const writes = new DataWrites(db, { refreshAccess() {}, changed() {} });
  const source = { generation: async () => '12345678-1234-4234-8234-123456789abc', read: async (name: string) => Buffer.from('synthetic:' + name) };
  const daemon = new SharedBridges({ db, clock, writes, source, effectsAllowed: () => true, changed() {}, reportError: error => errors.push(error), request, discord, ...overrides });
  clean.push(() => daemon.close());
  let seq = 0;
  /** One MESSAGE_CREATE through the gateway and the drain that follows it. */
  const say = async (data: Record<string, unknown>) => {
    const id = String(600000000000000000n + BigInt(++seq));
    const d = { type: 0, id, guild_id: guild, channel_id: room, author: { id: person, bot: false }, content: 'Hello', mentions: [], timestamp: '2026-11-14T12:00:00.000Z', ...data };
    await gateways.at(-1)!.commit({ type: 'MESSAGE_CREATE', data: d, seq }, { session: 'fixture', url: 'wss://gateway.discord.gg', seq }, Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: seq, d })));
    clock.advance(0); await daemon.idle();
    return db.select().from(bridgeIncoming).all().find(row => row.id === `bi:${JSON.stringify(['connection', d.id])}`)!;
  };
  const start = async () => { await daemon.ready(); await daemon.idle(); };
  return { client, db, clock, writes, daemon, request, answers, calls, gateways, errors, say, start };
}

it('reads the guild\'s roles once when it connects, so a ping of the bot\'s own role is a mention of the bot', async () => {
  const f = discordFixture(); await f.start();
  expect(f.calls.filter(call => call.path === `guilds/${guild}/roles`)).toHaveLength(1);
  // No channel rule: only a message addressed to Art is delivered.
  expect(await f.say({ content: 'anyone?' })).toMatchObject({ state: 'dropped' });
  expect(await f.say({ content: `<@&${artRole}> are you there`, mention_roles: [artRole] })).toMatchObject({ state: 'delivered', mentions: JSON.stringify([bot]) });
  // Mark's role is Mark's: in a shared place Art answers, a ping of it is not for Art.
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.db.insert(bridgeConnections).values({ id: 'marks', platform: 'discord', workspace: guild, botUser: mark, agent: 'mark', tokenSecret: 'TOKEN', enabled: true, state: 'connected', stateAt: new Date(f.clock.now()).toISOString() }).run();
  expect(await f.say({ content: `<@&${markRole}> yours`, mention_roles: [markRole] })).toMatchObject({ state: 'dropped', reason: 'Another agent or no channel answer' });
  expect(f.calls.filter(call => call.path === `guilds/${guild}/roles`)).toHaveLength(1);
});

it('describes a direct message, named channel and thread where the conversation is opened', async () => {
  const f = discordFixture(); await f.start();
  const dm = '700000000000000010', thread = '700000000000000011';
  f.answers.set(`GET channels/${dm}`, { id: dm, type: 1 });
  f.answers.set(`GET channels/${room}`, { id: room, guild_id: guild, type: 0, name: 'pond' });
  f.answers.set(`GET channels/${thread}`, { id: thread, guild_id: guild, type: 11, parent_id: room, name: 'otters' });
  const addressed = { content: `<@${bot}> hello`, mentions: [{ id: bot }] };
  const label = async (data: Record<string, unknown>) => {
    const row = await f.say({ ...addressed, ...data });
    return f.db.select().from(conversations).where(eq(conversations.id, row.conversation!)).get()?.label;
  };
  expect(await label({ guild_id: undefined, channel_id: dm })).toBe('Discord direct message with owner');
  expect(await label({ channel_id: thread })).toBe('Discord thread #otters under #pond');
  expect(await label({ channel_id: room })).toBe('Discord channel #pond');
});

it('leaves a ping of another bot alone even when that bot has no loom connection', async () => {
  const f = discordFixture(); await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  expect(await f.say({ content: `<@&${markRole}> yours`, mention_roles: [markRole] })).toMatchObject({ state: 'dropped' });
  expect(await f.say({ content: `<@${mark}> yours`, mentions: [{ id: mark, bot: true }] })).toMatchObject({ state: 'dropped' });
  expect(await f.say({ content: `<@${person}> hello`, mentions: [{ id: person }] })).toMatchObject({ state: 'delivered' });
});

it('connects and takes mentions when the roles cannot be read; a role ping is then nobody\'s', async () => {
  const f = discordFixture(); f.answers.delete(`GET guilds/${guild}/roles`); await f.start();
  expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');
  expect(await f.say({ content: `<@&${artRole}> hello`, mention_roles: [artRole] })).toMatchObject({ state: 'dropped' });
  expect(await f.say({ content: `<@${bot}> hello`, mentions: [{ id: bot }] })).toMatchObject({ state: 'delivered' });
});

it('takes a thread started from the bot\'s own message as addressed to it, whoever posted that message', async () => {
  const f = discordFixture(); await f.start();
  const thread = '700000000000000008', other = '700000000000000009';
  // The starter was posted outside loom (the old bridge, a script): nothing of it is in loom's send records.
  f.answers.set(`GET channels/${thread}`, { id: thread, guild_id: guild, type: 11, parent_id: room });
  f.answers.set(`GET channels/${room}/messages/${thread}`, { id: thread, channel_id: room, author: { id: bot, bot: true } });
  expect(await f.say({ channel_id: thread, content: 'still you' })).toMatchObject({ state: 'delivered', repliesTo: bot, thread, parent: room });
  // The starter is read once for the thread, not for each message in it.
  await f.say({ channel_id: thread, content: 'and again' });
  expect(f.calls.filter(call => call.path === `channels/${room}/messages/${thread}`)).toHaveLength(1);
  // A thread under somebody else's message, and one with no starter message, address nobody.
  f.answers.set(`GET channels/${other}`, { id: other, guild_id: guild, type: 11, parent_id: room });
  f.answers.set(`GET channels/${room}/messages/${other}`, { id: other, channel_id: room, author: { id: person } });
  expect(await f.say({ channel_id: other, content: 'not you' })).toMatchObject({ state: 'dropped', repliesTo: person });
  const bare = '700000000000000010';
  f.answers.set(`GET channels/${bare}`, { id: bare, guild_id: guild, type: 11, parent_id: room });
  expect(await f.say({ channel_id: bare, content: 'nobody' })).toMatchObject({ state: 'dropped', repliesTo: null });
  expect(f.db.select().from(inbox).all()).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

it('ends the working job on the stop word through the runtime\'s Stop, and says so once the pass has committed', async () => {
  const announced: string[][] = [];
  let f!: ReturnType<typeof discordFixture>;
  f = discordFixture({
    stopJob: (job, member) => { new Jobs(f.db, () => new Date(f.clock.now()).toISOString()).stop(job, member, 'stop'); },
    jobsEnded: ids => { expect(f.client.inTransaction).toBe(false); expect(f.db.select().from(jobs).where(eq(jobs.id, ids[0])).get()?.state).toBe('stopped'); announced.push([...ids]); },
  });
  await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  const first = await f.say({ content: 'Do the long thing' });
  f.db.insert(jobs).values({ id: 'job', agent: 'art', conversation: first.conversation, title: 'Work', state: 'running', queuedAt: new Date(f.clock.now()).toISOString(), brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next' }).run();
  expect(await f.say({ content: `<@${bot}> stop`, mentions: [{ id: bot }] })).toMatchObject({ state: 'dropped', reason: STOP_WORD, text: '' });
  expect(f.db.select().from(jobs).get()).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'stop' });
  expect(announced).toEqual([['job']]);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});

it('says "Stopped here." where a stop word stopped a job, through the send queue, and nowhere else', async () => {
  let f!: ReturnType<typeof discordFixture>;
  f = discordFixture({ stopJob: (job, member) => { new Jobs(f.db, () => new Date(f.clock.now()).toISOString()).stop(job, member, 'stop'); } });
  f.answers.set(`POST channels/${room}/messages`, { id: '800000000000000001', channel_id: room });
  await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  const first = await f.say({ content: 'Do the long thing' });
  // No job is working: "stop" is a message, and nothing is said back by loom.
  expect(await f.say({ content: 'stop' })).toMatchObject({ state: 'delivered' });
  expect(f.db.select().from(bridgeSends).all()).toEqual([]);
  f.db.insert(jobs).values({ id: 'job', agent: 'art', conversation: first.conversation, title: 'Work', state: 'running', queuedAt: new Date(f.clock.now()).toISOString(), brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next' }).run();
  const stop = await f.say({ content: 'Stop!' });
  expect(stop).toMatchObject({ state: 'dropped', reason: STOP_WORD });
  await f.daemon.idle();
  expect(f.db.select().from(bridgeSends).all()).toMatchObject([{ id: 'stopped:' + stop.id, incoming: stop.id, channel: room, thread: null, text: 'Stopped here.', state: 'sent' }]);
  expect(f.calls.filter(call => call.method === 'POST' && call.path === `channels/${room}/messages`).map(call => call.body)).toEqual([{ content: 'Stopped here.', allowed_mentions: { parse: ['users'], replied_user: false } }]);
  // The same event again says nothing more.
  f.daemon.changed(); await f.daemon.idle();
  expect(f.db.select().from(bridgeSends).all()).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

it('reacts to a message a running job has taken, shows typing while it works, and takes the reaction off when the mail is settled', async () => {
  const f = discordFixture(); await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  const row = await f.say({ content: 'Look into this' }), message = JSON.parse(row.id.slice(3))[1] as string;
  const reaction = `channels/${room}/messages/${message}/reactions/${encodeURIComponent(TAKEN_REACTION)}/@me`, typing = `channels/${room}/typing`;
  const made = (method: string, path: string) => f.calls.filter(call => call.method === method && call.path === path).length;
  const shown = async () => { f.daemon.changed(); await f.daemon.idle(); };
  const second = await f.say({ content: 'One more detail' });
  // Delivered and waiting: nobody has taken it, so nothing is shown.
  await shown();
  expect(workingOn(f.db)).toEqual([]); expect(made('PUT', reaction)).toBe(0); expect(made('POST', typing)).toBe(0);
  // A job takes it.
  f.db.insert(jobs).values({ id: 'job', agent: 'art', conversation: row.conversation, title: 'Work', state: 'running', queuedAt: new Date(f.clock.now()).toISOString(), brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next' }).run();
  f.db.update(inbox).set({ state: 'taken', job: 'job' }).run();
  expect(workingOn(f.db)).toHaveLength(2);
  const secondId = JSON.parse(second.id.slice(3))[1] as string;
  const secondReaction = reaction.replace(message, secondId);
  f.answers.set(`PUT ${secondReaction}`, null);
  f.request.mockImplementationOnce(async () => Response.json({ retry_after: 15 }, {status:429,headers:{'Retry-After':'15'}}));
  const before = f.request.mock.calls.length;
  await shown(); await shown();
  expect(f.request.mock.calls.length - before).toBe(1);
  expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');
  f.answers.set(`PUT ${reaction}`, null); f.answers.set(`DELETE ${reaction}`, null); f.answers.set(`POST ${typing}`, null);
  for (let i = 0; i < 2; i++) { f.clock.advance(5_000); await f.daemon.idle(); }
  expect(f.request.mock.calls.length - before).toBe(1);
  f.clock.advance(5_000); await f.daemon.idle();
  expect(made('PUT', reaction)).toBe(1);
  expect(made('PUT', secondReaction)).toBe(1);
  expect(made('POST', typing)).toBe(1);
  await shown(); await shown();
  expect(made('PUT', reaction)).toBe(1); expect(made('POST', typing)).toBe(1);
  f.clock.advance(TYPING_EVERY_MS); await f.daemon.idle();
  expect(made('POST', typing)).toBe(2);
  // The reply settles the mail: the reaction comes off and typing stops.
  f.db.update(inbox).set({ state: 'done' }).run();
  await shown();
  expect(made('DELETE', reaction)).toBe(1);
  f.clock.advance(TYPING_EVERY_MS); await f.daemon.idle();
  expect(made('POST', typing)).toBe(2); expect(made('DELETE', reaction)).toBe(1);
  expect(f.calls.find(call => call.path === reaction)?.body).toBeUndefined();
});

it('shows nothing for mail whose job is not running, or on a connection that is switched off', async () => {
  const f = discordFixture(); await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  const row = await f.say({ content: 'Look into this' });
  f.db.insert(jobs).values({ id: 'job', agent: 'art', conversation: row.conversation, title: 'Work', state: 'queued', queuedAt: new Date(f.clock.now()).toISOString(), brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next' }).run();
  f.db.update(inbox).set({ state: 'taken', job: 'job' }).run();
  expect(workingOn(f.db)).toEqual([]);
  f.db.update(jobs).set({ state: 'running' }).run();
  expect(workingOn(f.db)).toHaveLength(1);
  const typingOnly = [{connection:'connection',channel:room}];
  f.db.update(bridgeIncoming).set({bot:true}).run();
  expect(workingOn(f.db)).toEqual(typingOnly);
  f.db.update(bridgeIncoming).set({bot:false,webhook:true}).run();
  expect(workingOn(f.db)).toEqual(typingOnly);
  for (const source of ['trigger','handoff'] as const) {
    f.db.update(inbox).set({source}).run();
    expect(workingOn(f.db)).toEqual(typingOnly);
  }
  f.db.update(inbox).set({state:'done'}).run();
  expect(workingOn(f.db)).toEqual([]);
  f.db.update(inbox).set({source:'discord',state:'taken'}).run();
  f.db.update(bridgeIncoming).set({webhook:false}).run();
  for (const state of ['starting','failed','lost','done'] as const) {
    f.db.update(jobs).set({state}).run();
    expect(workingOn(f.db)).toEqual([]);
  }
  f.db.update(jobs).set({ state: 'stopped' }).run();
  expect(workingOn(f.db)).toEqual([]);
  f.db.update(jobs).set({ state: 'running' }).run();
  f.db.update(bridgeConnections).set({ enabled: false }).run();
  expect(workingOn(f.db)).toEqual([]);
});

it('keeps a delivered Discord message\'s attachments, once, and leaves one it cannot fetch as a link', async () => {
  const f = discordFixture(); await f.start();
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  const cat = 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1', gone = 'https://cdn.discordapp.com/attachments/1/2/gone.png?ex=1';
  f.answers.set(`GET ${cat}`, Buffer.from('PNGDATA'));
  const attachments = [{ id: '900000000000000001', filename: 'cat.png', size: 7, content_type: 'image/png', url: cat }, { id: '900000000000000002', filename: 'gone.png', size: 9, content_type: 'image/png', url: gone }];
  const row = await f.say({ content: '', attachments });
  f.clock.advance(1); await f.daemon.idle(); f.clock.advance(1); await f.daemon.idle();
  // A picture alone is delivered, with both links in its words.
  expect(row).toMatchObject({ state: 'delivered' });
  expect(row.text).toBe(`[attachment: cat.png (image/png, 7 bytes) ${cat}]\n[attachment: gone.png (image/png, 9 bytes) ${gone}]`);
  expect(f.db.select().from(bridgeFiles).all()).toMatchObject([{ connection: 'connection', file: '900000000000000001', name: 'cat.png', contents: Buffer.from('PNGDATA') }]);
  expect(f.db.select().from(bridgeFileMessages).all()).toEqual([{ connection: 'connection', file: '900000000000000001', incoming: row.id }]);
  // Each is asked for once: the one that is gone is not asked for again on every pass.
  for (let n = 0; n < 3; n++) { f.clock.advance(5000); await f.daemon.idle(); }
  expect(f.calls.filter(call => call.path === cat)).toHaveLength(1);
  expect(f.calls.filter(call => call.path === gone)).toHaveLength(1);
  // The fetch carries no credential: the link is Discord's own.
  expect(f.request.mock.calls.find(([url]) => String(url) === cat)?.[1]?.headers).toBeUndefined();
  // A stranger's attachment is not fetched: the message was dropped.
  await f.say({ author: { id: '400000000000000099' }, content: 'x', attachments: [{ ...attachments[0], id: '900000000000000003', url: cat + '&other' }] });
  expect(f.calls.filter(call => call.path === cat + '&other')).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

it('shares presence capacity across nine busy Discord channels before their heartbeats expire', async () => {
  const f = discordFixture();
  await f.start();
  for (let i = 0; i < 9; i++) {
    const channel = String(300000000000000100n + BigInt(i));
    f.answers.set(`GET channels/${channel}`, {id:channel, type:0, guild_id:guild});
    const row = await f.say({channel_id:channel, content:`<@${bot}> hello`, mentions:[{id:bot}]});
    const message = JSON.parse(row.id.slice(3))[1];
    f.answers.set(`POST channels/${channel}/typing`, null);
    f.answers.set(`PUT channels/${channel}/messages/${message}/reactions/${encodeURIComponent(TAKEN_REACTION)}/@me`, null);
    f.db.insert(jobs).values({id:'work-'+i, agent:'art', conversation:row.conversation, title:'Work', state:'running',
      queuedAt:new Date(f.clock.now()).toISOString(),brief:'',model:'model',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next'}).run();
    f.db.update(inbox).set({state:'taken',job:'work-'+i}).where(eq(inbox.conversation,row.conversation!)).run();
  }
  f.daemon.changed();
  await f.daemon.idle();
  for (let i = 0; i < 2; i++) { f.clock.advance(1000); await f.daemon.idle(); }
  expect(f.calls.filter(call => call.path.endsWith('/typing'))).toHaveLength(9);
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(9);
});
