import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agents, members, secrets, secretGrants, secretRules, secretRequests, secretUses, household, inbox, jobs } from '../../core/data/schema.js';
import { SecretRequests } from './requests.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-14T12:00:00Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  for (const name of ['github-token', 'slack-token']) db.insert(secrets).values({ name, description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  const service = new SecretRequests(db, now);
  const job = (id: string, agent = 'art') => db.insert(jobs).values({ id, agent, title: id, queuedAt: now(), state: 'queued', brief: '', model: 'test', startedByKind: 'agent', startedBy: agent, houseRepository: '', houseFile: '', houseBranch: '' }).run();
  job('job-art'); job('job-mark', 'mark');
  const rule = (answer: 'ask' | 'auto' | 'never' = 'auto', when: 'at_start' | 'on_request' = 'at_start', secret = 'github-token') => service.setRule({ secret, answer, minutes: 5, agents: [{ agent: 'art', when }] });
  return { db, client, service, job, rule, now, advance: (ms: number) => { time += ms; } };
}
describe('shared startup secret grants', () => {
  it.each(['ask', 'auto'] as const)('grants explicit startup permission under %s without a request or a value handoff', answer => {
    const f = fixture(); f.rule(answer);
    const [grant] = f.service.grantAtStart('job-art');
    expect(grant).toMatchObject({ secret: 'github-token', agent: 'art', job: 'job-art', request: null, grantedBy: 'rule', grantedAt: f.now(), expiresAt: '2026-11-14T12:05:00.000Z' });
    expect(f.service.grantFor('github-token', 'art', 'job-art')).toEqual(grant);
    expect(f.service.grantFor('github-token', 'art')).toBeUndefined();
    expect(f.service.grantFor('github-token', 'art', 'job-mark')).toBeUndefined();
    expect(f.service.grantAtStart('job-mark')).toEqual([]);
    expect(f.db.select().from(secretRequests).all()).toEqual([]);
    expect(f.db.select().from(inbox).all()).toEqual([]);
    expect(f.db.select().from(secretUses).all()).toEqual([]);
  });
  it('never grants from a household default or an on-request entry', () => {
    const f = fixture(); f.db.insert(household).values({ secretsDefault: 'auto' }).run();
    expect(f.service.grantAtStart('job-art')).toEqual([]);
    f.rule('auto', 'on_request');
    expect(f.service.grantAtStart('job-art')).toEqual([]);
    expect(f.db.select().from(secretGrants).all()).toEqual([]);
  });
  it('a never rule blocks an explicitly listed startup agent', () => {
    const f = fixture(); f.rule('never');
    expect(f.service.grantAtStart('job-art')).toEqual([]);
    expect(f.db.select().from(secretGrants).all()).toEqual([]);
  });
  it('retries across service recreation preserve the deadline even after expiry or rule extension', () => {
    const f = fixture(); f.rule();
    const first = f.service.grantAtStart('job-art');
    f.advance(60000);
    const restarted = new SecretRequests(f.db, f.now);
    expect(restarted.grantAtStart('job-art')).toEqual(first);
    f.db.update(secretRules).set({ minutes: 60 }).run();
    f.advance(4 * 60000);
    expect(restarted.grantAtStart('job-art')).toEqual([]);
    expect(f.service.grantFor('github-token', 'art', 'job-art')).toBeUndefined();
    expect(f.db.select().from(secretGrants).all()).toEqual(first);
    f.job('job-next');
    expect(restarted.grantAtStart('job-next')[0].expiresAt).toBe('2026-11-14T13:05:00.000Z');
  });
  it('uses current rules for new issuance without silently revoking existing grants', () => {
    const f = fixture(); f.rule();
    const [first] = f.service.grantAtStart('job-art');
    f.rule('never'); f.job('job-next');
    expect(f.service.grantAtStart('job-next')).toEqual([]);
    expect(f.service.grantAtStart('job-art')).toEqual([]);
    expect(f.service.grantFor('github-token', 'art', 'job-art')).toEqual(first);
  });
  it('returns no grant before its original start after a clock reversal', () => {
    const f = fixture(); f.rule();
    const first = f.service.grantAtStart('job-art');
    f.advance(-1); expect(f.service.grantAtStart('job-art')).toEqual([]);
    expect(f.db.select().from(secretGrants).all()).toEqual(first);
  });
  it('issues every applicable secret atomically and participates in a caller rollback', () => {
    const f = fixture(); f.rule(); f.rule('auto', 'at_start', 'slack-token');
    expect(() => f.db.transaction(() => { expect(f.service.grantAtStart('job-art')).toHaveLength(2); throw new Error('abort'); })).toThrow('abort');
    expect(f.db.select().from(secretGrants).all()).toEqual([]);
    expect(f.service.grantAtStart('job-art').map(g => g.secret).sort()).toEqual(['github-token', 'slack-token']);
  });
  it('rolls back all startup grants on an invalid stored rule duration', () => {
    const f = fixture(); f.rule(); f.rule('auto', 'at_start', 'slack-token');
    f.db.update(secretRules).set({ minutes: 0 }).where(eq(secretRules.secret, 'slack-token')).run();
    expect(() => f.service.grantAtStart('job-art')).toThrow(/Too small/);
    expect(f.db.select().from(secretGrants).all()).toEqual([]);
  });
  it('rejects unknown or malformed jobs without writes', () => {
    const f = fixture(); f.rule();
    expect(() => f.service.grantAtStart('unknown')).toThrow('Unknown startup job');
    expect(() => f.service.grantAtStart('')).toThrow();
    expect(f.db.select().from(secretGrants).all()).toEqual([]);
  });
});
