import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { approvals, measuringSettings } from '../data/schema.js';
import { DEFAULT_MEASURING, type MeasuringSettings } from './index.js';

export const MEASURING_SETTINGS_OPERATION = 'measuring.settings';
const settings = z.object({
  on: z.boolean(), send_outside: z.boolean(), outside_address: z.string(),
  keep_days: z.number().int().min(1).max(3650),
}).strict().superRefine((value, ctx) => {
  if (!value.outside_address && !value.send_outside) return;
  try {
    const url = new URL(value.outside_address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', path: ['outside_address'], message: 'Use an HTTP(S) OTLP endpoint without credentials, query or fragment' }); }
});
const change = z.object({ before: settings, after: settings }).strict();
const summary = (before: MeasuringSettings, after: MeasuringSettings) =>
  `Measuring: ${JSON.stringify(before)} → ${JSON.stringify(after)}`;
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
