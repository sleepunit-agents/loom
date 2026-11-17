/** The Discord side of the bridge daemon, from a gateway frame to what is delivered, with Discord's API
 * played by a table of answers. What each rule decides is tested where the rule lives (incoming.test.ts,
 * normalize.test.ts); this checks that the daemon reads what those rules need and hands it over. */
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { DataWrites } from '../../core/data/writes.js';
import { FakeClock } from '../../core/clock.js';
import { eq } from 'drizzle-orm';
import { members, agents, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, inbox, jobs } from '../../core/data/schema.js';
import { Jobs } from '../../runtime/jobs.js';
import { STOP_WORD } from './incoming.js';
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
  // Mark's role is Mark's: in a room Art answers, a ping of it is not for Art.
  f.db.insert(bridgeChannels).values({ platform: 'discord', workspace: guild, channel: room, answers: 'art', botsMayTalk: false }).run();
  f.db.insert(agents).values({ id: 'mark', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.db.insert(bridgeConnections).values({ id: 'marks', platform: 'discord', workspace: guild, botUser: mark, agent: 'mark', tokenSecret: 'TOKEN', enabled: true, state: 'connected', stateAt: new Date(f.clock.now()).toISOString() }).run();
  expect(await f.say({ content: `<@&${markRole}> yours`, mention_roles: [markRole] })).toMatchObject({ state: 'dropped', reason: 'Another agent or no channel answer' });
  expect(f.calls.filter(call => call.path === `guilds/${guild}/roles`)).toHaveLength(1);
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
