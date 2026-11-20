import type { z } from 'zod';
import type { Db } from '../../core/index.js';
import { records, type RecordKind, type RuntimeRecords } from './records.js';
const schemas: { [K in RecordKind]: z.ZodType<RuntimeRecords[K]> } = records;
const tables = { box: 'runtime_boxes', job: 'runtime_jobs', settings: 'runtime_settings', binding: 'runtime_bindings' } as const;
/** Internal storage: callers own the registry/import transaction and change notification. */
export function runtimeStore(db: Db) {
  function read<K extends RecordKind>(kind: K, id: string): (RuntimeRecords[K] & { changedAt: number }) | undefined {
    const row = db.prepare(`SELECT record, changed_at FROM ${tables[kind]} WHERE id=?`).get(id) as { record: string; changed_at: number } | undefined;
    if (!row) return;
    return { ...schemas[kind].parse(JSON.parse(row.record)), changedAt: row.changed_at } as RuntimeRecords[K] & { changedAt: number };
  }
  return {
    read,
    ids(kind: RecordKind): string[] {
      return (db.prepare(`SELECT id FROM ${tables[kind]} ORDER BY id`).all() as { id: string }[]).map(row => row.id);
    },
    put<K extends RecordKind>(kind: K, value: RuntimeRecords[K], now: number): boolean {
      if (!db.inTransaction) throw new Error('Runtime writes require a transaction');
      const checked = schemas[kind].parse(value);
      if (kind === 'settings' && checked.id !== (checked as RuntimeRecords['settings']).agent) throw new Error('Settings id must be the agent');
      const record = JSON.stringify(checked);
      const before = db.prepare(`SELECT record FROM ${tables[kind]} WHERE id=?`).get(checked.id) as { record: string } | undefined;
      if (before?.record === record) return false;
      db.prepare(`INSERT INTO ${tables[kind]} (id,record,changed_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record, changed_at=excluded.changed_at`).run(checked.id, record, now);
      return true;
    },
  };
}
