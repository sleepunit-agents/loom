import type { DataDatabase } from '../data/database.js';
import { approvals, measuringSettings } from '../data/schema.js';
import { DEFAULT_MEASURING, type MeasuringSettings } from './index.js';

import { measuringValues as settings, measuringChange as change, measuringChangeSummary as summary } from './change.js';

type Approval = typeof approvals.$inferSelect;

/** Trusted shared-model service. The outside door authenticates the household
 * owner. Register apply in the shared Approvals operation map; it performs only
 * synchronous writes inside Approvals' transaction, never SDK/network work.
 * The persisted approval carries the values, so pending cards survive restart.
 */
export function measuringSettingsService(db: DataDatabase) {
  const read = (): MeasuringSettings => {
    const row = db.select().from(measuringSettings).get();
    return row ? { on: row.on, send_outside: row.sendOutside, outside_address: row.outsideAddress ?? '', keep_days: row.keepDays } : { ...DEFAULT_MEASURING };
  };
  const write = (after: MeasuringSettings) => {
    const value = settings.parse(after), row = { on: value.on, sendOutside: value.send_outside, outsideAddress: value.outside_address || null, keepDays: value.keep_days };
    db.insert(measuringSettings).values({ singleton: 1, ...row }).onConflictDoUpdate({ target: measuringSettings.singleton, set: row }).run();
  };
  return {
    read, write,
  };
}
