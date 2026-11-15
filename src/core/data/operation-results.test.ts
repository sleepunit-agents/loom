import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { OperationResults, type OperationReceipt } from './operation-results.js';
import { projects, operationResults } from './schema.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const client of opened.splice(0)) client.close(); });
function setup() {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client);
  return { client, db, receipts: new OperationResults(db) };
}
const now = Date.parse('2026-11-14T00:00:00.000Z');
function receipt(overrides: Partial<OperationReceipt> = {}): OperationReceipt {
  return { caller: 'member:jonathan', id: 'retry-1', operation: 'tasks.close', inputHash: 'hashed-input',
    result: { ok: true, value: { id: 't-1', title: '水', extra: null } }, expires: now + 30 * 86400_000, ...overrides };
}

it('replays the serialized answer and fingerprint through a new adapter without legacy tables', () => {
  const { db, client, receipts } = setup();
  const original = receipt(); receipts.insert(original);
  expect(new OperationResults(db).get(original.caller, original.id)).toEqual(original);
  expect(Buffer.isBuffer(db.select().from(operationResults).get()?.result)).toBe(true);
  expect(client.prepare("SELECT name FROM sqlite_schema WHERE name IN ('core_operations','core_migrations')").all()).toEqual([]);
});

it('isolates callers and rejects duplicate insertion without replacing the first answer', () => {
  const { receipts } = setup();
  receipts.insert(receipt());
  receipts.insert(receipt({ caller: 'member:another', result: { ok: true, value: null } }));
  expect(() => receipts.insert(receipt({ inputHash: 'changed' }))).toThrow();
  expect(receipts.get('member:jonathan', 'retry-1')).toEqual(receipt());
  expect(receipts.get('member:another', 'retry-1')?.result).toEqual({ ok: true, value: null });
  expect(receipts.get('unknown', 'retry-1')).toBeUndefined();
});

it('commits and rolls back receipt plus real shared writes in the same transaction', () => {
  const { db, receipts } = setup();
  expect(() => db.transaction(() => {
    db.insert(projects).values({ id: 'rolled-back', name: 'Pond' }).run();
    receipts.insert(receipt());
    throw new Error('effect failed');
  })).toThrow('effect failed');
  expect(receipts.get('member:jonathan', 'retry-1')).toBeUndefined();
  expect(db.select().from(projects).all()).toEqual([]);
  db.transaction(() => {
    db.insert(projects).values({ id: 'committed', name: 'Pond' }).run();
    receipts.insert(receipt());
  });
  expect(receipts.get('member:jonathan', 'retry-1')).toEqual(receipt());
  expect(db.select().from(projects).all()).toHaveLength(1);
});

it('recovers missing or matching receipts but preserves identity on conflicting recovery', () => {
  const { db, receipts } = setup();
  receipts.recover(receipt());
  const recovered = receipt({ result: { ok: true, value: 'recovered' }, expires: now + 1234 });
  receipts.recover(recovered);
  expect(receipts.get(recovered.caller, recovered.id)).toEqual(recovered);
  for (const conflict of [{ operation: 'tasks.delete' }, { inputHash: 'other' }]) {
    expect(() => receipts.recover(receipt(conflict))).toThrow('Operation id already used');
    expect(receipts.get(recovered.caller, recovered.id)).toEqual(recovered);
  }
  expect(() => db.transaction(() => {
    receipts.recover(receipt({ result: { ok: true, value: 'provisional' } }));
    throw new Error('outer rollback');
  })).toThrow('outer rollback');
  expect(receipts.get(recovered.caller, recovered.id)).toEqual(recovered);
});

it('expires inclusively at the deadline and exposes the next clock deadline', () => {
  const { receipts } = setup();
  expect(receipts.nextExpiry()).toBeUndefined();
  receipts.insert(receipt({ expires: now + 1 }));
  receipts.insert(receipt({ id: 'later', expires: now + 2 }));
  expect(receipts.nextExpiry()).toBe(now + 1);
  receipts.expire(now);
  expect(receipts.get('member:jonathan', 'retry-1')).toBeDefined();
  receipts.expire(now + 1);
  expect(receipts.get('member:jonathan', 'retry-1')).toBeUndefined();
  expect(receipts.nextExpiry()).toBe(now + 2);
  receipts.expire(now + 2);
  expect(receipts.nextExpiry()).toBeUndefined();
});

it('does not write a receipt when serialization or deadline conversion fails', () => {
  const { db, receipts } = setup();
  expect(() => receipts.insert(receipt({ expires: NaN }))).toThrow();
  expect(() => receipts.insert(receipt({ result: { ok: true, value: 1n } }))).toThrow();
  expect(db.select().from(operationResults).where(eq(operationResults.id, 'retry-1')).all()).toEqual([]);
});
