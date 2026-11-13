import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, mayAct, maySee, type RecordType } from '../../core/index.js';
import { signin, hash } from '../../core/signin/index.js';
import { venueSchema } from '../bridges/model.js';
import { runtimeStore } from '../runtime/store.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Full noncredential household grants inventory supplied on t-2209, revision 7.
// These are the two real agents, not a wildcard interpreted as a new principal.
const pieces = ['approvals', 'box', 'clock', 'machine', 'packages', 'runtime', 'secrets', 'shuttle', 'tasks', 'discord', 'slack'];
it.each(['art', 'mark'])('%s remains subject to record scope for every retired piece gate', agent => {
  const sharing = fixtureSharing(), viewer = { kind: 'agent', id: agent } as const;
  for (const type of pieces) {
    const other = agent === 'art' ? 'mark' : 'art';
    expect(maySee(viewer, { type, agent }, sharing), type).toBe(true);
    for (const scope of [{ agent: other }, { project: 'absent', agent }, { member: 'jonathan', agent }, {}]) {
      expect(maySee(viewer, { type, ...scope }, sharing), type).toBe(false);
      expect(mayAct(viewer, { type, ...scope }, sharing), type).toBe(false);
    }
    expect(mayAct(viewer, { type, agent }, sharing, 'household'), type).toBe(false);
    expect(mayAct(viewer, { type, agent }, sharing, 'agent-setup'), type).toBe(false);
    expect(mayAct(viewer, { type, agent }, sharing, 'answer-person'), type).toBe(false);
  }
});

it('keeps Mark out of Art Slack setup, traffic records and send paths on the real next API', async () => {
  const home = mkdtempSync(join(tmpdir(), 'retired-grants-scope-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const types = new Map<string, RecordType>();
  const app = await startLoom({ home, next: true, staging: true, clock: new FakeClock(), stdout: () => {}, install(app) {
    const register = app.live.register.bind(app.live);
    app.live.register = type => { types.set(type.name, type); register(type); };
  } });
  cleanup.push(() => app.close());
  const owner = { kind: 'member', id: 'jonathan' } as const;
  const mark = { kind: 'agent', id: 'mark' } as const;
  const venue = venueSchema.parse({ id: 'art-slack', platform: 'slack', agent: 'art', workspace: 'T1', bot: 'U1', tokenSecret: 'slack-ref' });
  const route = { id: 'art-route', platform: 'slack', workspace: 'T1', channel: 'C1', primary: 'art' };
  const link = { id: 'art-link', platform: 'slack', workspace: 'T1', user: 'U2', person: 'jonathan' };
  for (const [name, input] of [['putVenues', venue], ['putRoutes', route], ['putLinks', link]] as const) {
    expect(app.operations.call('direct', owner, `bridges.${name}`, input, `seed:${name}`).ok).toBe(true);
  }
  app.db.transaction(() => {
    app.db.prepare("INSERT INTO bridges_outbox VALUES ('art-send','art-incoming','art-slack','identity','{}','PRIVATE slack words','held',NULL,1)").run();
    runtimeStore(app.db).put('binding', { id: 'art-slack-binding', agent: 'art', venue: 'slack:T1', place: 'C1' }, app.operations.clock.now());
  })();
  for (const [type, id] of [['bridges.venue', venue.id], ['bridges.route', route.id], ['bridges.link', link.id], ['bridges.send', 'art-send'], ['runtime.binding', 'art-slack-binding']]) {
    const records = types.get(type)!;
    expect(records.ids(undefined)).toContain(id);
    expect(records.read(id, owner), type).toBeDefined();
    expect(records.read(id, mark), type).toBeUndefined();
  }
  const secret = randomBytes(32).toString('hex');
  signin(app).tokens.change(tokens => tokens.push({ role: 'agent:mark', sha256: hash(secret), label: 'scope audit', created: new Date(app.operations.clock.now()).toISOString() }));
  let serial = 0;
  const post = async (name: string, input: unknown) => {
    const [piece, op] = name.split('.');
    const response = await fetch(`${app.url}/api/${piece}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ input, id: `audit:${++serial}` }) });
    return response.json();
  };
  for (const [name, input] of [
    ['bridges.putVenues', { ...venue, agent: 'mark' }], ['bridges.putRoutes', { ...route, primary: 'mark' }], ['bridges.putLinks', { ...link, person: 'pollock' }],
    ['bridges.removeVenues', { id: venue.id }], ['bridges.removeRoutes', { id: route.id }], ['bridges.removeLinks', { id: link.id }],
    ['bridges.dismissSend', { id: 'art-send', state: 'held' }],
    ['runtime.readConversation', {}],
    ['runtime.reply', { id: 'mark-send', conversation: 'art-slack-binding', text: 'forged reply' }],
  ] as const) expect(await post(name, input), name).toMatchObject({ ok: false, code: 'denied' });
  expect(await post('runtime.listBindings', {})).toMatchObject({ ok: true, value: { records: [] } });
  // Bridge reply is a trusted in-process role, not a public operation. External
  // delivery is still unimplemented; retirement must not manufacture that door.
  expect(app.operations.has('bridges.reply')).toBe(false);
  expect(app.operations.has('runtime.deliver')).toBe(false);
  expect(app.db.prepare('SELECT state,text FROM bridges_outbox').all()).toEqual([{ state: 'held', text: 'PRIVATE slack words' }]);
  expect(types.get('bridges.venue')!.read(venue.id, owner)).toMatchObject({ agent: 'art' });
});
