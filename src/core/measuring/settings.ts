import type { DataDatabase } from '../data/database.js';
import { approvals, measuringSettings } from '../data/schema.js';
import { DEFAULT_MEASURING, type MeasuringSettings } from './index.js';

import { measuringValues as settings, measuringChange as change, measuringChangeSummary as summary } from './change.js';

export const MEASURING_SETTINGS_OPERATION = 'measuring.settings';
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
  return {
    read,
    prepare(input: MeasuringSettings) {
      const before = settings.parse(read()), after = settings.parse(input);
      if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('Measuring settings are unchanged');
      return {
        kind: 'setting' as const, target: 'measuring', operation: MEASURING_SETTINGS_OPERATION,
        details: JSON.stringify({ before, after }), changeSummary: summary(before, after),
      };
    },
    apply(approval: Pick<Approval, 'kind' | 'target' | 'operation' | 'details' | 'changeSummary'>) {
      if (approval.kind !== 'setting' || approval.target !== 'measuring' || approval.operation !== MEASURING_SETTINGS_OPERATION)
        throw new Error('Wrong Measuring settings operation');
      const { before, after } = change.parse(JSON.parse(approval.details));
      if (approval.changeSummary !== summary(before, after)) throw new Error('Measuring before/after does not match its card');
      if (JSON.stringify(read()) !== JSON.stringify(before)) throw new Error('Measuring settings changed; request a fresh card');
      db.insert(measuringSettings).values({
        singleton: 1, on: after.on, sendOutside: after.send_outside,
        outsideAddress: after.outside_address || null, keepDays: after.keep_days,
      }).onConflictDoUpdate({ target: measuringSettings.singleton, set: {
        on: after.on, sendOutside: after.send_outside, outsideAddress: after.outside_address || null, keepDays: after.keep_days,
      } }).run();
    },
  };
}
