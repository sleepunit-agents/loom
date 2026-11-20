import { z } from 'zod';
import { KEEP_DAYS_MAX, type MeasuringSettings } from './index.js';

export const measuringValues = z.object({
  on: z.boolean(), send_outside: z.boolean(), outside_address: z.string(),
  keep_days: z.number().int().min(0).max(KEEP_DAYS_MAX),
}).strict().superRefine((value, ctx) => {
  if (value.on && value.keep_days === 0 && !value.send_outside) ctx.addIssue({code:'custom',path:['keep_days'],message:'Keep local history or send to an outside monitoring tool'});
  if (!value.outside_address && !value.send_outside) return;
  try {
    const url = new URL(value.outside_address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', path: ['outside_address'], message: 'Use an HTTP(S) OTLP endpoint without credentials, query or fragment' }); }
});
export const measuringChange = z.object({ before: measuringValues, after: measuringValues }).strict();
export const measuringChangeSummary = (before: MeasuringSettings, after: MeasuringSettings) =>
  `Measuring: ${JSON.stringify(before)} → ${JSON.stringify(after)}`;

/** Validate persisted presentation using the same values and summary as apply.
 * This does not authorize a request or execute its operation. */
export function readMeasuringChange(approval: {
  kind: string; target: string; details: string; changeSummary: string | null;
}) {
  if (approval.kind !== 'setting' || approval.target !== 'measuring') return;
  try {
    const parsed = measuringChange.safeParse(JSON.parse(approval.details));
    if (!parsed.success) return;
    const { before, after } = parsed.data;
    if (approval.changeSummary !== measuringChangeSummary(before, after)) return;
    return parsed.data;
  } catch { return; }
}
