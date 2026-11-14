import { lt, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { timingDays } from '../data/schema.js';
import type { TimingStore } from './index.js';

/** The local OpenTelemetry destination uses the household's shared database.
 * Each completed span updates its daily bucket in one atomic statement. */
export function timingStore(db: DataDatabase): TimingStore {
  return {
    add(row) {
      db.insert(timingDays).values({
        day: row.day, kind: row.kind, name: row.name, count: row.count,
        totalMs: row.total_ms, slowestMs: row.slowest_ms,
        typicalMs: row.total_ms / row.count,
      }).onConflictDoUpdate({
        target: [timingDays.day, timingDays.kind, timingDays.name],
        set: {
          count: sql`${timingDays.count} + excluded.count`,
          totalMs: sql`${timingDays.totalMs} + excluded.total_ms`,
          slowestMs: sql`max(${timingDays.slowestMs}, excluded.slowest_ms)`,
          typicalMs: sql`(${timingDays.totalMs} + excluded.total_ms) / (${timingDays.count} + excluded.count)`,
        },
      }).run();
    },
    prune(beforeDay) {
      db.delete(timingDays).where(lt(timingDays.day, beforeDay)).run();
    },
  };
}
