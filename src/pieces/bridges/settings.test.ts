import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, bridgeChannels, bridgeConnections } from '../../core/data/schema.js';
import { BridgeSettings } from './settings.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const now = () => '2026-11-16T12:00:00.000Z', db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  for (const name of ['TOKEN', 'APP']) db.insert(secrets).values({ name, description: '', changedAt: now(), changedBy: 'owner' }).run();
  const settings = new BridgeSettings(db, now, write => write());
  const discord = { action: 'connection' as const, platform: 'discord' as const, agent: 'art', botUser: 'bot', tokenSecret: 'TOKEN', appSecret: null, enabled: true, only: [], ignore: [] };
  const enabled = () => db.select().from(bridgeConnections).all().filter(row => row.enabled).map(row => row.id);
  return { db, settings, discord, enabled };
}

it('lets one Discord bot be connected in one guild at a time, since its session hears every guild and direct message', () => {
  const f = fixture();
  f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1' });
  expect(() => f.settings.change({ ...f.discord, id: 'away', workspace: 'guild-2' })).toThrow('already has an enabled connection in another guild');
  expect(f.enabled()).toEqual(['home']);
  // Saved disabled, it waits; it cannot be enabled until the other is paused, and then the first cannot come back.
  f.settings.change({ ...f.discord, id: 'away', workspace: 'guild-2', enabled: false });
  expect(() => f.settings.change({ ...f.discord, id: 'away', workspace: 'guild-2' })).toThrow('already has an enabled connection in another guild');
  f.settings.change({ action: 'disconnect', id: 'home' });
  f.settings.change({ ...f.discord, id: 'away', workspace: 'guild-2' });
  expect(() => f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1' })).toThrow('already has an enabled connection in another guild');
  expect(f.enabled()).toEqual(['away']);
  // Editing the enabled connection itself, and another bot's connection in any guild, are untouched by the rule.
  f.settings.change({ ...f.discord, id: 'away', workspace: 'guild-2', ignore: ['noise'] });
  f.settings.change({ ...f.discord, id: 'second-bot', workspace: 'guild-1', botUser: 'other-bot' });
  expect(f.enabled()).toEqual(['away', 'second-bot']);
});
it('leaves Slack alone: a bot user id that recurs in another workspace is another bot', () => {
  const f = fixture(), slack = { ...f.discord, platform: 'slack' as const, appSecret: 'APP' };
  f.settings.change({ ...slack, id: 'one', workspace: 'T1' });
  f.settings.change({ ...slack, id: 'two', workspace: 'T2' });
  expect(f.enabled()).toEqual(['one', 'two']);
});
it('does not switch a removed connection on: it is restored first, and then enabled like any other', () => {
  const f = fixture();
  f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1' });
  // What removing a connection does (apps/household.ts): the row stays, switched off and marked removed.
  f.db.update(bridgeConnections).set({ enabled: false, state: 'disconnected', removedAt: '2026-11-16T12:00:00.000Z' }).run();
  expect(() => f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1' })).toThrow('Connection is removed');
  expect(f.enabled()).toEqual([]);
  // Its other settings can still be edited while it is off.
  f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1', enabled: false, ignore: ['noise'] });
  f.db.update(bridgeConnections).set({ removedAt: null }).run();
  f.settings.change({ ...f.discord, id: 'home', workspace: 'guild-1' });
  expect(f.enabled()).toEqual(['home']);
});
it('keeps the brief a channel\'s rule names, and none when the rule names none', () => {
  const f = fixture(), rule = { action: 'channel' as const, platform: 'discord' as const, workspace: 'guild', channel: 'pond', answers: 'art', botsMayTalk: false };
  const brief = () => f.db.select().from(bridgeChannels).get()?.brief;
  // A card filed before there were briefs has no such field: the rule has none.
  f.settings.change(rule); expect(brief()).toBeNull();
  f.settings.change({ ...rule, brief: 'onterris' }); expect(brief()).toBe('onterris');
  expect(f.settings.read(rule)).toMatchObject({ channel: 'pond', brief: 'onterris' });
  // The same rule saved again without one takes it away: a rule says the whole of what it is.
  f.settings.change({ ...rule, brief: null }); expect(brief()).toBeNull();
  // A brief is a page's name, and nothing that could be a path.
  for (const bad of ['', '../creed', 'roles/onterris', 'a b', '.hidden']) expect(() => f.settings.change({ ...rule, brief: bad }), bad).toThrow();
  expect(brief()).toBeNull();
});
