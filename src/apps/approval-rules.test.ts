import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { members } from '../core/data/schema.js';
import { householdOwners } from '../shared-sharing.js';
import { approvalRulesService } from './approval-rules.js';

let client: Database.Database, db: DataDatabase;
const at = '2026-11-14T20:00:00.000Z', target = `github:acme/app#1@${'a'.repeat(40)}`;
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(members).values([{ id: 'pat', role: 'owner', joinedAt: at }, { id: 'kim', role: 'owner', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }]).run();
});
afterEach(() => client.close());
const remove = (id: string) => db.update(members).set({ removedAt: at }).where(eq(members.id, id)).run();

it('answers for a principal only while that person is in the household', () => {
  const rules = approvalRulesService(db, () => at), resolve = (actingFor: string) => rules.resolve({ kind: 'merge', target, actingFor });
  rules.set({ kind: 'merge', scope: '*', tier: 'do' }, 'pat');
  rules.set({ kind: 'merge', scope: '*', person: 'sam', tier: 'tell' }, 'pat');
  expect(resolve('kim')).toMatchObject({ tier: 'do', person: '' });
  expect(resolve('sam')).toMatchObject({ tier: 'tell', person: 'sam' });
  expect(rules.personFor('kim')).toBe(''); expect(rules.personFor('sam')).toBe('sam');
  // A removed owner's agent no longer gets the household's own standing rules, nor a removed member theirs.
  remove('kim'); remove('sam');
  expect(resolve('kim')).toBeUndefined(); expect(resolve('sam')).toBeUndefined();
  expect(rules.personFor('kim')).toBeUndefined(); expect(rules.personFor('sam')).toBeUndefined();
});
it('lists only current owners, and a removed setter grants nothing', () => {
  const rules = approvalRulesService(db, () => at);
  rules.set({ kind: 'merge', scope: '*', tier: 'do' }, 'kim');
  expect(householdOwners(db)).toEqual(['kim', 'pat']);
  remove('kim');
  expect(householdOwners(db)).toEqual(['pat']);
  expect(rules.resolve({ kind: 'merge', target, actingFor: 'pat' })).toBeUndefined();
  expect(() => rules.set({ kind: 'merge', scope: '*', tier: 'do' }, 'kim')).toThrow('A household owner is required');
});
