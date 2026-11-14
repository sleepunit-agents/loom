/** Current installed-role behavior, not fake-runtime permission coverage. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, type Result } from '../../core/index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installSecrets } from '../secrets/index.js';
import { installSecretServices } from '../secrets/service.js';
import * as runtimeModule from '../runtime/bridges.js';
import { runtimeStore } from '../runtime/store.js';
import { installBridges } from './index.js';
import { venueSchema, routeSchema } from './model.js';
import { put } from './store.js';
import { discordInbox } from './discord-inbox.js';
import { slackInbox } from './slack-inbox.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
function ok(result: Result) { expect(result.ok, JSON.stringify(result)).toBe(true); }
async function until(condition: () => boolean) {
  for (let n = 0; n < 5000; n++) { if (condition()) return; await Promise.resolve(); }
  throw Error('Installed venue matrix did not settle');
}
const cases = ['peer-unlinked', 'peer-linked', 'pair', 'channel', 'thread', 'group', 'dm'] as const;
it.each(cases)('records the actual installed %s admission and durable disposition', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'bridges-matrix-')); fixture(home);
  const clock = new FakeClock(), group = kind === 'group', slack = group || kind === 'dm';
  const peer = kind.startsWith('peer'), epoch = '00000000-0000-4000-8000-000000000000';
  const admissions: Array<{ input: Parameters<runtimeModule.BridgeBodies['runtime']['admit']>[0]; result: string }> = [];
  // Observe, but never replace, the installed Runtime's owning admission verdict.
  const original = runtimeModule.bridgeRuntime;
  vi.spyOn(runtimeModule, 'bridgeRuntime').mockImplementation((...args) => {
    const role = original(...args), admit = role.runtime.admit;
    role.runtime.admit = async input => { const result = await admit(input); admissions.push({ input, result }); return result; };
    return role;
  });
  const requests: string[] = [], posts: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = String(url); requests.push(path);
    if (path.endsWith('users/@me')) return Response.json({ id: '100', bot: true });
    if (path.endsWith('guilds/300')) return Response.json({ id: '300' });
    if (path.endsWith('channels/400')) return Response.json({ id: '400', type: 0, guild_id: '300', name: 'shared' });
    if (path.endsWith('channels/401')) return Response.json({ id: '401', type: 11, guild_id: '300', parent_id: '400', name: 'PRIVATE THREAD TITLE' });
    const method = path.split('/').pop();
    if (method === 'auth.test') return Response.json({ ok: true, team_id: 'T123', user_id: 'U123', bot_id: 'B123' });
    if (method === 'bots.info') return Response.json({ ok: true, bot: { id: 'B123', user_id: 'U123', deleted: false, app_id: 'A123' } });
    if (method === 'apps.connections.open') return Response.json({ ok: true, url: 'wss://wss-primary.slack.com/link?ticket=FIXTURE' });
    if (method === 'conversations.info') return Response.json({ ok: true, channel: group
      ? { id: 'G123', is_im: false, is_mpim: true } : { id: 'D123', is_im: true, is_mpim: false, user: 'U200' } });
    if (method === 'conversations.members') return Response.json({ ok: true, members: ['U123', 'U200', 'U201'], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') {
      const user = new URLSearchParams(String(init?.body)).get('user');
      return Response.json({ ok: true, user: { id: user, team_id: 'T123', deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false } });
    }
    posts.push(path); throw Error('Unexpected platform request');
  };
  const socket = () => Object.assign(new EventEmitter(), { readyState: 1, terminate: vi.fn(), send: vi.fn(), ping: vi.fn() }) as unknown as WebSocket;
  const venue = venueSchema.parse(slack
    ? { id: 'slack', platform: 'slack', workspace: 'T123', bot: 'U123', agent: 'art', tokenSecret: 'bot', appSecret: 'app' }
    : { id: 'discord', platform: 'discord', workspace: '300', bot: '100', agent: 'art', tokenSecret: 'bot' });
  const app = await startLoom({ home, next: true, clock, stdout: () => {}, bridges: {
    source: { generation: async () => epoch, read: async () => Buffer.from('MATRIX FIXTURE TOKEN') }, request, socket, discordSocket: socket,
  }, install(a) {
    const sharing = () => new SharingDatabase(a.db, home).sharing();
    installSecrets(a.db, a.operations, a.live, sharing); installSecretServices(a.db, a.operations, sharing); installBridges(a, sharing);
    for (const name of ['bot', 'app']) {
      ok(a.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'secrets.describe', { name, description: name }, `describe-${name}`));
      ok(a.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'secrets.grantService', { service: 'bridges', name }, `grant-${name}`));
    }
    put(a.db, 'venues', venue);
    if (peer) put(a.db, 'venues', { ...venue, id: 'remote-peer', bot: '101', agent: 'mark', enabled: false });
    if (kind !== 'peer-unlinked') put(a.db, 'links', { id: 'sender', platform: venue.platform, workspace: venue.workspace, user: slack ? 'U200' : peer ? '101' : '200', person: peer ? 'mark' : 'jonathan' });
    if (group) put(a.db, 'links', { id: 'second', platform: 'slack', workspace: 'T123', user: 'U201', person: 'pollock' });
    if (!slack) put(a.db, 'routes', routeSchema.parse({ id: 'shared', platform: 'discord', workspace: '300', channel: '400', primary: 'art', peer, ...(kind === 'pair' ? { pair: 'mark' } : {}) }));
  } });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  // A DM control has a runnable house. Otherwise missing execution setup could
  // conceal a regression in admission by making startBody fail independently.
  app.db.transaction(() => {
    const store = runtimeStore(app.db);
    store.put('settings', { id: 'art', agent: 'art', boxes: ['a'], house: { repo: '/fixture/art', houseFile: 'house/house.json' } }, clock.now());
    store.put('box', { id: 'a', name: 'A', owner: 'jonathan', local: true, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: clock.now() }, clock.now());
  })();
  if (slack) await slackInbox(app.db, clock, { venue, app: 'A123' }).receive({ type: 'event_callback', team_id: 'T123', api_app_id: 'A123', event_id: 'EvMatrix',
    event: { type: 'message', channel: group ? 'G123' : 'D123', user: 'U200', ts: '1794503533.000000', text: 'MATRIX PRIVATE WORDS' } });
  else {
    const inbox = discordInbox(app.db, clock, { venue, credentialEpoch: epoch }, () => epoch);
    const checkpoint = (seq: number) => ({ seq, session: 'SESSION', url: 'wss://gateway.discord.gg/?v=10&encoding=json' });
    await inbox.commit({ type: 'READY', seq: 1, data: { user: { id: '100' }, session_id: 'SESSION' } }, checkpoint(1));
    await inbox.commit({ type: 'MESSAGE_CREATE', seq: 2, data: { id: '500', channel_id: kind === 'thread' ? '401' : '400', guild_id: '300', type: 0,
      content: peer ? '<@100> MATRIX PRIVATE WORDS' : 'MATRIX PRIVATE WORDS', timestamp: '2026-11-13T00:00:00.000Z', author: { id: peer ? '101' : '200', bot: peer }, mentions: peer ? [{ id: '100' }] : [], mention_roles: [] } }, checkpoint(2));
  }
  clock.advance(5000);
  await until(() => !!app.db.prepare("SELECT id FROM bridges_inbox WHERE state IN ('delivered','dropped') OR retry_since IS NOT NULL").get());
  const row = () => app.db.prepare('SELECT state,reason,message,retry_since FROM bridges_inbox').get() as { state: string; reason: string | null; message: string; retry_since: number | null };
  if (kind === 'dm') {
    expect(admissions).toEqual([expect.objectContaining({ result: 'allow', input: expect.objectContaining({ dm: true, person: 'jonathan' }) })]);
    expect(row().state).toBe('delivered'); expect(runtimeStore(app.db).ids('job')).toHaveLength(1);
  } else if (kind === 'peer-unlinked') {
    expect(admissions).toEqual([]); expect(row()).toMatchObject({ state: 'dropped', reason: 'unknown user', message: '{}' });
    expect(runtimeStore(app.db).ids('job')).toEqual([]);
  } else {
    expect(admissions).toEqual([expect.objectContaining({ result: 'wait', input: expect.objectContaining({ dm: false, ...(peer ? { peer: true, person: 'mark' } : {}), ...(group ? { group: true } : {}), ...(kind === 'pair' ? { pair: 'mark' } : {}) }) })]);
    expect(row()).toMatchObject({ state: 'pending', reason: null }); expect(row().retry_since).not.toBeNull();
    expect(row().message).toContain('MATRIX PRIVATE WORDS'); expect(row().message).not.toContain('PRIVATE THREAD TITLE');
    expect(runtimeStore(app.db).ids('job')).toEqual([]);
    // Retry repeats the real verdict, rather than manufacturing a DM or a body.
    const first = admissions.length; clock.advance(5000); await until(() => admissions.length > first);
    expect(admissions.every(a => a.result === 'wait')).toBe(true);
    expect(runtimeStore(app.db).ids('job')).toEqual([]);
  }
  if (group) {
    expect(requests.some(p => p.endsWith('conversations.members'))).toBe(true);
    expect(requests.filter(p => p.endsWith('users.info')).length).toBeGreaterThanOrEqual(2);
  }
  expect(posts).toEqual([]); expect(app.db.prepare('SELECT * FROM bridges_outbox').all()).toEqual([]);
  if (kind !== 'dm') expect(app.db.prepare('SELECT * FROM runtime_bridge_turns').all()).toEqual([]);
});
