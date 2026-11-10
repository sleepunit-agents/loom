/**
 * The collections contract's pure parts (docs/specs/collections.md, "What the tests must pin": identity, bounds,
 * hidden fields, viewer authority): the offer's install checks, a query's bounds, the audience and agent rule, and
 * sealed cursors.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCollectionsOffer, parseTypeDecl, providerConflict, type CollectionsOffer, type TypeDecl } from './contract.js';
import { checkQuery, queryShape, Sealer, type QueryIn } from './query.js';
import { admits, classesOf, parseAudience, type Viewer } from './viewer.js';
import { parseOffers, offerConflicts } from '../offers.js';

const argv = (v: unknown, where: string) => (Array.isArray(v) && v[0] === 'loom-tasks' ? undefined : `${where} must start with loom-tasks`);
const TASK = {
  version: '1.2',
  schema: { type: 'object' },
  agent: 'agent',
  fields: {
    agent: { class: 'member', filter: ['eq', 'in'] },
    title: { class: 'member', search: true },
    status: { class: 'member', filter: ['eq', 'in'], order: true },
    priority: { class: 'member', filter: ['eq', 'in', 'lte'], order: true },
    cost: { class: 'owner', filter: ['lt'], order: true },
    description: { class: 'member', heavy: true },
  },
  default_fields: ['title', 'status'],
  max_page: 200,
  aggregates: { count: { by: ['status'] }, spend: { by: ['cost'] } },
};
const offer = (types: Record<string, unknown> = { task: TASK }, extra: Record<string, unknown> = {}) => ({ query: ['loom-tasks', 'collections', 'query'], types, ...extra });
const decl = (): TypeDecl => parseTypeDecl('task', TASK) as TypeDecl;

describe('the collections offer: checked at install', () => {
  it('accepts the spec\'s shape, with core\'s defaults filled in', () => {
    const o = parseCollectionsOffer(offer(undefined, { owners: 2 }), argv) as CollectionsOffer;
    expect(o.owners).toBe(2);
    expect(o.types.task).toMatchObject({ version: '1.2', agent: 'agent', domain: 'type', audience: 'rows', houses: false, services: false, scoped_counts: false, max_page: 200 });
  });

  it.each([
    ['an unknown key', offer(undefined, { push: ['loom-tasks'] }), /no key "push"/],
    ['owners other than 2', offer(undefined, { owners: 1 }), /owners is 2/],
    ['no query argv', { types: { task: TASK } }, /query is required/],
    ['an argv that isn\'t its own bin', { query: ['sh', '-c'], types: { task: TASK } }, /must start with loom-tasks/],
    ['no types', offer({}), /at least one record type/],
    ['a type name out of grammar', offer({ Task: TASK }), /a type's name/],
    ['a field name out of grammar', offer({ task: { ...TASK, fields: { 'bad-name': { class: 'member' } } } }), /a field's name/],
    ['a reserved field', offer({ task: { ...TASK, fields: { ...TASK.fields, audience: { class: 'member' } } } }), /core's own field/],
    ['a secret class', offer({ task: { ...TASK, fields: { ...TASK.fields, token: { class: 'secret' } } } }), /no class for secret values/],
    ['a schema over 16 KB', offer({ task: { ...TASK, schema: { type: 'object', description: 'x'.repeat(17 * 1024) } } }), /at most 16 KB/],
    ['max_page over 500', offer({ task: { ...TASK, max_page: 501 } }), /max_page/],
    ['an aggregate naming an undeclared field', offer({ task: { ...TASK, aggregates: { count: { by: ['nope'] } } } }), /aggregates.count.by/],
    ['a filter operator that doesn\'t exist', offer({ task: { ...TASK, fields: { ...TASK.fields, status: { class: 'member', filter: ['like'] } } } }), /filter is a list of operators/],
    ['agent naming an undeclared field', offer({ task: { ...TASK, agent: 'owner' } }), /agent names one of its fields/],
    ['a default field that\'s heavy', offer({ task: { ...TASK, default_fields: ['description'] } }), /can't name a heavy field/],
    ['a heavy field to filter on', offer({ task: { ...TASK, fields: { ...TASK.fields, description: { class: 'member', heavy: true, filter: ['eq'] } } } }), /heavy field can't be filtered/],
    ['a kept: false field to order on', offer({ task: { ...TASK, fields: { ...TASK.fields, words: { class: 'member', kept: false, order: true } } } }), /kept: false field can't be/],
    ['services without houses', offer({ task: { ...TASK, services: true } }), /services needs houses/],
    ['scoped counts before the conformance run exists', offer({ task: { ...TASK, scoped_counts: true } }), /need a passing conformance run/],
    ['scoped search before the conformance run exists', offer({ task: { ...TASK, scoped_search: true } }, { search: ['loom-tasks', 's'] }), /need a passing conformance run/],
  ])('refuses %s', (_, raw, why) => {
    expect(parseCollectionsOffer(raw, argv)).toMatch(why);
  });

  it('a kept: false field is heavy', () => {
    const o = parseCollectionsOffer(offer({ task: { ...TASK, fields: { ...TASK.fields, words: { class: 'member', kept: false } } } }), argv) as CollectionsOffer;
    expect(o.types.task.fields.words).toEqual({ class: 'member', kept: false, heavy: true });
  });

  it('is the sixth offer key of a loom block, checked against the piece\'s bins', () => {
    expect(parseOffers({ collections: offer() }, { bins: ['loom-tasks'] })).toMatchObject({ collections: { query: ['loom-tasks', 'collections', 'query'] } });
    expect(parseOffers({ collections: offer() }, { bins: ['loom-other'] })).toMatch(/one of the piece's own bins/);
  });

  it('a provider name is one piece\'s: its role, else its name; loom is core\'s', () => {
    const c = parseCollectionsOffer(offer(), argv) as CollectionsOffer;
    const taskstore = { name: 'taskstore', loom: { role: 'tasks', collections: c } };
    // A second piece with the same role, or named what a role already publishes as, is refused; both ways round.
    expect(providerConflict('other-tasks', c, 'tasks', [taskstore])).toMatch(/provider name tasks is already the taskstore piece's/);
    expect(providerConflict('tasks', undefined, undefined, [taskstore])).toMatch(/tasks is already the taskstore piece's provider name/);
    expect(providerConflict('notes', c, undefined, [{ name: 'notes2', loom: { role: 'notes' } }])).toMatch(/already the notes2 piece's/);
    expect(providerConflict('loom', c, undefined, [])).toMatch(/core's own/);
    expect(providerConflict('mypiece', c, 'loom', [])).toMatch(/core's own/);
    // Its own earlier version isn't another piece, and an unrelated piece is fine.
    expect(providerConflict('taskstore', c, 'tasks', [taskstore, { name: 'clock', loom: { role: 'clock' } }])).toBeUndefined();
    // Through the installer's one check.
    expect(offerConflicts('other-tasks', { role: 'tasks', collections: c }, [taskstore])).toMatch(/already the taskstore piece's/);
  });
});

describe('a query: bounded, and never on a hidden field', () => {
  const member = classesOf({ kind: 'member', person: 'loren', household: false, agents: ['pond-bot'] });
  const owner = classesOf({ kind: 'member', person: 'jonathan', household: true, agents: ['art'] });
  const noCursor = () => undefined;
  const check = (q: Partial<QueryIn>, classes = member, householdOwner = false) => checkQuery({ id: 'q1', type: 'tasks/task@^1', ...q }, decl(), classes, householdOwner, noCursor);

  it('fills in the defaults: the type\'s default fields and a page of at most 50', () => {
    expect(check({})).toMatchObject({ provider: 'tasks', type: 'task', major: 1, fields: ['title', 'status'], limit: 50, where: [], order: [], withheld: [] });
  });

  it.each([
    ['nine clauses', { where: Array.from({ length: 9 }, () => ['status', 'eq', 'open']) }, /at most 8 clauses/],
    ['an undeclared field', { where: [['nope', 'eq', 1]] }, /no field "nope"/],
    ['an operator the field doesn\'t allow', { where: [['status', 'prefix', 'op']] }, /can't be filtered with "prefix"/],
    ['an in of 101', { where: [['status', 'in', Array.from({ length: 101 }, (_, i) => `s${i}`)]] }, /1-100 values/],
    ['a page over max_page', { limit: 201 }, /at most 200/],
    ['a heavy field in a big list', { fields: ['description'], limit: 21 }, /heavy field has at most 20/],
    ['an order on a field without order', { order: [['title', 'asc']] }, /no field "title" to order by/],
    ['an unknown aggregate', { aggregates: ['sum'] }, /no aggregate "sum"/],
    ['a subscription (the live stream is t-2022)', { subscribe: true }, /subscriptions come with the live stream/],
    ['a value that isn\'t a scalar', { where: [['status', 'eq', { $ne: 1 }]] }, /a value is/],
  ])('refuses %s as bad-query', (_, q, why) => {
    expect(check(q as Partial<QueryIn>)).toMatchObject({ error: 'bad-query', why: expect.stringMatching(why) });
  });

  it('refuses a where, an order or an aggregate\'s by on a field the viewer\'s class can\'t see, exactly as one that doesn\'t exist', () => {
    // cost is owner-class: a household owner may filter and order on it; an agent owner may not.
    expect(check({ where: [['cost', 'lt', 5]] })).toMatchObject({ error: 'bad-query', clause: 0, why: 'there\'s no field "cost" to filter on' });
    expect(check({ order: [['cost', 'asc']] })).toMatchObject({ error: 'bad-query', why: 'there\'s no field "cost" to order by' });
    expect(check({ aggregates: ['spend'] })).toMatchObject({ error: 'bad-query', why: 'there\'s no aggregate "spend"' });
    expect(check({ where: [['cost', 'lt', 5]], order: [['cost', 'asc']], aggregates: ['spend'] }, owner, true)).toMatchObject({ where: [['cost', 'lt', 5]] });
  });

  it('a named field the viewer can\'t see is withheld, not an error; audience is household owners\' only', () => {
    expect(check({ fields: ['title', 'cost', 'audience'] })).toMatchObject({ fields: ['title'], withheld: ['cost', 'audience'] });
    expect(check({ fields: ['title', 'cost', 'audience'] }, owner, true)).toMatchObject({ fields: ['title', 'cost', 'audience'], withheld: [] });
  });

  it('a major the provider doesn\'t serve is unsupported-version, never a reshaped record', () => {
    expect(check({ type: 'tasks/task@^2' })).toMatchObject({ error: 'unsupported-version' });
  });
});

describe('sealed cursors', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-cursor-'));
  const s = new Sealer(join(home, 'collections', 'cursor.key'));
  const shape = queryShape({ provider: 'tasks', type: 'task', major: 1 }, [['status', 'eq', 'open']], []);
  it('opens only for the same viewer and the same query, unedited and in time', () => {
    const c = s.seal('["t-9"]', 'member:loren:pond-bot', shape, 1000);
    expect(c).not.toContain('t-9');
    expect(s.unseal(c, 'member:loren:pond-bot', shape, 2000)).toBe('["t-9"]');
    expect(s.unseal(c, 'member:jonathan:*', shape, 2000)).toBeUndefined();
    expect(s.unseal(c, 'member:loren:pond-bot', queryShape({ provider: 'tasks', type: 'task', major: 1 }, [['status', 'eq', 'closed']], []), 2000)).toBeUndefined();
    const edited = Buffer.from(c, 'base64url'); edited[edited.length - 1] ^= 1;
    expect(s.unseal(edited.toString('base64url'), 'member:loren:pond-bot', shape, 2000)).toBeUndefined();
    expect(s.unseal(c, 'member:loren:pond-bot', shape, 1000 + 61 * 60 * 1000)).toBeUndefined();
    // Another listener reads the same key file, so its cursors open here.
    expect(new Sealer(join(home, 'collections', 'cursor.key')).unseal(c, 'member:loren:pond-bot', shape, 2000)).toBe('["t-9"]');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('who may see a record: the audience and the agent rule', () => {
  const jonathan: Viewer = { kind: 'member', person: 'jonathan', household: true, agents: ['art', 'mark', 'pond-bot'] };
  const loren: Viewer = { kind: 'member', person: 'loren', household: false, agents: ['pond-bot'] };
  const sam: Viewer = { kind: 'member', person: 'sam', household: false, agents: ['pond-bot', 'art'] };
  const art: Viewer = { kind: 'agent', agent: 'art' };
  const artHouse: Viewer = { kind: 'agent', agent: 'art', house: 'h1' };
  const artService: Viewer = { kind: 'agent', agent: 'art', service: 'discord' };
  const rows = { houses: false, services: false };
  const a = (v: unknown) => parseAudience(v)!;

  it('household owners: every term but members; members only those named', () => {
    for (const au of [{ household: true }, { owners: true }, { ownersOf: ['art'] }, { agents: ['art'] }]) expect(admits(jonathan, a(au), 'art', rows)).toBe(true);
    expect(admits(jonathan, a({ members: ['loren'] }), 'pond-bot', rows)).toBe(false);
    expect(admits(jonathan, a({ members: ['jonathan'] }), 'pond-bot', rows)).toBe(true);
  });

  it('an owner of some agents: only records naming one of their agents, and a record naming none only through members', () => {
    expect(admits(loren, a({ household: true }), 'pond-bot', rows)).toBe(true);
    expect(admits(loren, a({ household: true }), 'art', rows)).toBe(false);
    expect(admits(loren, a({ household: true }), undefined, rows)).toBe(false);
    expect(admits(loren, a({ members: ['loren'] }), undefined, rows)).toBe(true);
    expect(admits(loren, a({ owners: true }), 'pond-bot', rows)).toBe(false);
    expect(admits(loren, a({ ownersOf: ['pond-bot'] }), 'pond-bot', rows)).toBe(true);
    expect(admits(loren, a({ ownersOf: ['art'] }), 'pond-bot', rows)).toBe(false);
    expect(admits(loren, a({ agents: ['pond-bot'] }), 'pond-bot', rows)).toBe(false);
  });

  it('two members sharing an agent: a members-only record is its member\'s alone, and only while they own its agent', () => {
    const lorens = a({ members: ['loren'] });
    expect(admits(loren, lorens, 'pond-bot', rows)).toBe(true);
    expect(admits(sam, lorens, 'pond-bot', rows)).toBe(false);
    expect(admits({ ...loren, agents: [] }, lorens, 'pond-bot', rows)).toBe(false);
  });

  it('an agent\'s token: only an agents term naming it; a house\'s only where the type allows houses, a service house\'s services too', () => {
    expect(admits(art, a({ agents: ['art'] }), 'art', rows)).toBe(true);
    expect(admits(art, a({ household: true, ownersOf: ['art'] }), 'art', rows)).toBe(false);
    expect(admits(artHouse, a({ agents: ['art'] }), 'art', rows)).toBe(false);
    expect(admits(artHouse, a({ agents: ['art'] }), 'art', { houses: true, services: false })).toBe(true);
    expect(admits(artService, a({ agents: ['art'] }), 'art', { houses: true, services: false })).toBe(false);
    expect(admits(artService, a({ agents: ['art'] }), 'art', { houses: true, services: true })).toBe(true);
  });

  it('an audience that isn\'t one is no audience (the row is dropped)', () => {
    for (const bad of [undefined, null, {}, { everyone: true }, { members: [] }, { members: 'loren' }, { household: 'yes' }, { agents: ['Art!'] }]) expect(parseAudience(bad)).toBeUndefined();
  });

  it('owner-class fields are household owners\' only', () => {
    expect([...classesOf(jonathan)]).toContain('owner');
    expect([...classesOf(loren)]).not.toContain('owner');
    expect([...classesOf(art)]).not.toContain('owner');
  });
});
