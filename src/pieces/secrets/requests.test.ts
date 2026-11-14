import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { Conversations } from '../../core/conversations/index.js';
import { members, agents, secrets, secretRequests, secretGrants, secretRules, secretRuleAgents, household, inbox, jobs } from '../../core/data/schema.js';
import { SecretRequests } from './requests.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-14T12:00:00Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'jonathan', role: 'owner', joinedAt: now() }, { id: 'owner2', role: 'owner', joinedAt: now() }]).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'github-token', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  const service = new SecretRequests(db, now);
  const input = { id: 'q-one', secret: 'github-token', agent: 'art', why: 'Merge the reviewed change', minutes: 30 };
  const job = (id: string, agent = 'art', conversation?: string) => db.insert(jobs).values({ id, agent, conversation, title: id, queuedAt: now(), state: 'running', brief: '', model: 'test', startedByKind: 'agent', startedBy: agent, houseRepository: '', houseFile: '', houseBranch: '' }).run();
  return { db, client, service, input, now, job, advance: (ms: number) => { time += ms; } };
}
describe('shared-schema secret requests and grants', () => {
  it('puts a pending question in every owner inbox, with no value', () => {
    const f = fixture();
    const row = f.service.request(f.input);
    expect(row).toMatchObject({ state: 'pending', askedAt: f.now(), always: false });
    const mail = f.db.select().from(inbox).all();
    expect(mail.map(i => i.to).sort()).toEqual(['jonathan', 'owner2']);
    expect(mail[0]).toMatchObject({ source: 'secret-request', sourceId: row.id, waitsOnKind: 'secret-request', waitsOnId: row.id, fromId: 'art', answers: 'yes-no' });
    expect(f.service.request(f.input)).toEqual(row);
    expect(f.db.select().from(inbox).all()).toHaveLength(2);
    expect(() => f.service.request({ ...f.input, minutes: 60 })).toThrow('reused');
    expect(f.db.select().from(secretGrants).all()).toHaveLength(0);
  });
  it('answers once and expires the grant at the exact requested deadline', () => {
    const f = fixture(); f.service.request(f.input);
    expect(f.service.answer(f.input.id, 'jonathan', true)).toMatchObject({ state: 'allowed', answeredBy: 'jonathan' });
    f.service.answer(f.input.id, 'owner2', false);
    expect(f.db.select().from(secretGrants).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all().every(i => i.state === 'resolved' && i.resolution === 'allowed')).toBe(true);
    expect(f.service.grantFor('github-token', 'art')).toBeDefined();
    expect(f.service.grantFor('github-token', 'mark')).toBeUndefined();
    expect(f.service.grantFor('another-token', 'art')).toBeUndefined();
    f.advance(30 * 60000 - 1); expect(f.service.grantFor('github-token', 'art')).toBeDefined();
    f.advance(1); expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
  });
  it('does not grant before its start when the clock moves backwards', () => {
    const f = fixture(); f.service.request(f.input); f.service.answer(f.input.id, 'jonathan', true);
    f.advance(-1); expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
  });
  it('compares grant times as dates across accepted UTC spellings', () => {
    const f = fixture(); f.service.request(f.input); f.service.answer(f.input.id, 'jonathan', true);
    f.db.update(secretGrants).set({ grantedAt: '2026-11-14T12:00:00Z' }).run();
    expect(f.service.grantFor('github-token', 'art')).toBeDefined();
    f.db.update(secretGrants).set({ expiresAt: '2026-11-14T12:30:00Z' }).run();
    f.advance(30 * 60000);
    expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
  });
  it('denies without a grant and makes an always-deny standing rule', () => {
    const f = fixture(); f.service.request(f.input);
    expect(f.service.answer(f.input.id, 'jonathan', false, true)).toMatchObject({ state: 'denied', always: true });
    expect(f.db.select().from(secretGrants).all()).toHaveLength(0);
    expect(f.service.request({ ...f.input, id: 'q-two' })).toMatchObject({ state: 'denied', answeredBy: 'rule' });
    expect(f.db.select().from(inbox).all()).toHaveLength(2);
  });
  it('keeps on-request and at-start rule agents separate', () => {
    const f = fixture();
    f.service.setRule({ secret: 'github-token', answer: 'auto', minutes: 5, agents: [{ agent: 'art', when: 'on_request' }, { agent: 'mark', when: 'at_start' }] });
    expect(f.service.request(f.input)).toMatchObject({ state: 'allowed', answeredBy: 'rule' });
    expect(f.service.request({ ...f.input, id: 'q-mark', agent: 'mark' }).state).toBe('pending');
    expect(f.db.select().from(secretGrants).get()).toMatchObject({ expiresAt: '2026-11-14T12:05:00.000Z' });
  });
  it.each(['auto', 'never', 'ask'] as const)('uses household %s when the secret has no rule', answer => {
    const f = fixture(); f.db.insert(household).values({ secretsDefault: answer }).run();
    expect(f.service.request(f.input).state).toBe(answer === 'auto' ? 'allowed' : answer === 'never' ? 'denied' : 'pending');
  });
  it('always-allow adds same-answer agents and replaces a conflicting answer list', () => {
    const f = fixture();
    f.service.setRule({ secret: 'github-token', answer: 'auto', minutes: 5, agents: [{ agent: 'mark', when: 'on_request' }] });
    f.service.request(f.input); f.service.answer(f.input.id, 'jonathan', true, true);
    expect(f.db.select().from(secretRuleAgents).all().map(a => a.agent).sort()).toEqual(['art', 'mark']);
    f.service.setRule({ secret: 'github-token', answer: 'ask', minutes: 5, agents: [{ agent: 'art', when: 'on_request' }] });
    f.service.request({ ...f.input, id: 'q-new' }); f.service.answer('q-new', 'jonathan', false, true);
    expect(f.db.select().from(secretRules).get()?.answer).toBe('never');
    expect(f.db.select().from(secretRuleAgents).all().map(a => a.agent)).toEqual(['art']);
  });
  it('checks job and conversation ownership, and limits job-scoped grants', () => {
    const f = fixture();
    const cv = new Conversations(f.db, f.now).open({ agent: 'art', venue: 'loom', place: 'thread', label: 'work' });
    f.job('j-one', 'art', cv.id); f.job('j-other', 'mark'); f.job('j-two');
    expect(() => f.service.request({ ...f.input, job: 'j-other' })).toThrow('Job does not belong');
    expect(() => f.service.request({ ...f.input, agent: 'mark', conversation: cv.id })).toThrow('Conversation does not belong');
    f.service.request({ ...f.input, job: 'j-one', conversation: cv.id });
    f.service.answer(f.input.id, 'jonathan', true);
    expect(f.service.grantFor('github-token', 'art', 'j-one')).toBeDefined();
    expect(f.service.grantFor('github-token', 'art', 'j-two')).toBeUndefined();
    expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
    expect(f.db.select().from(inbox).get()?.conversation).toBe(cv.id);
  });
  it('cancels a pending request and revokes an allowed grant without replay resurrection', () => {
    const f = fixture(); f.service.request(f.input);
    expect(f.service.cancel(f.input.id).state).toBe('cancelled');
    expect(f.service.answer(f.input.id, 'jonathan', true).state).toBe('cancelled');
    f.service.request({ ...f.input, id: 'q-allowed' }); f.service.answer('q-allowed', 'jonathan', true);
    expect(f.service.revoke('q-allowed').state).toBe('revoked');
    expect(f.service.request({ ...f.input, id: 'q-allowed' }).state).toBe('revoked');
    expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
  });
  it.each(['allow', 'deny', 'cancel'] as const)('rolls back %s if Inbox resolution fails', action => {
    const f = fixture(); f.service.request(f.input);
    f.client.exec("CREATE TRIGGER fail_resolution BEFORE UPDATE ON inbox BEGIN SELECT RAISE(ABORT, 'resolution failed'); END");
    expect(() => action === 'cancel' ? f.service.cancel(f.input.id) : f.service.answer(f.input.id, 'jonathan', action === 'allow', true)).toThrow('resolution failed');
    expect(f.db.select().from(secretRequests).get()).toMatchObject({ state: 'pending', answeredAt: null, answeredBy: null, always: false });
    expect(f.db.select().from(secretGrants).all()).toHaveLength(0);
    expect(f.db.select().from(secretRules).all()).toHaveLength(0);
    expect(f.db.select().from(secretRuleAgents).all()).toHaveLength(0);
    expect(f.db.select().from(inbox).all().every(i => i.state === 'waiting')).toBe(true);
  });
  it.each(['allowed', 'denied', 'cancelled', 'revoked'] as const)('preserves %s on request replay', state => {
    const f = fixture(); f.service.request(f.input);
    if (state === 'cancelled') f.service.cancel(f.input.id);
    else { f.service.answer(f.input.id, 'jonathan', state !== 'denied'); if (state === 'revoked') f.service.revoke(f.input.id); }
    const before = f.db.select().from(secretRequests).get();
    expect(before?.state).toBe(state);
    expect(f.service.request(f.input)).toEqual(before);
    expect(f.db.select().from(secretGrants).all()).toHaveLength(state === 'allowed' ? 1 : 0);
    expect(f.db.select().from(inbox).all()).toHaveLength(2);
  });
  it('rolls request creation back if owner inbox insertion fails', () => {
    const f = fixture();
    f.client.exec("CREATE TRIGGER fail_mail BEFORE INSERT ON inbox WHEN NEW.[to] = 'owner2' BEGIN SELECT RAISE(ABORT, 'mail failed'); END");
    expect(() => f.service.request(f.input)).toThrow('mail failed');
    expect(f.db.select().from(secretRequests).all()).toHaveLength(0);
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
    expect(f.db.select().from(secretGrants).all()).toHaveLength(0);
  });
});
