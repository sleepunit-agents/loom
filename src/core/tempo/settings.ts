import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { approvals } from '../data/schema.js';
import type { Clock } from '../clock.js';
import { InboxVolume } from './volume.js';

export const TEMPO_SETTINGS_OPERATION = 'tempo.settings';
const recipient = z.object({ kind: z.enum(['person', 'agent']), id: z.string().min(1) }).strict();
const timings = z.object({
  settleSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dimDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  muteDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const change = z.object({ who: recipient, before: timings, after: timings }).strict();
type Change = z.infer<typeof change>;
type Approval = Pick<typeof approvals.$inferSelect, 'kind' | 'target' | 'operation' | 'details' | 'changeSummary'>;
const target = (who: Change['who']) => `tempo:${who.kind}:${who.id}`;
const summary = ({ who, before, after }: Change) =>
  `Tempo for ${who.kind} ${who.id}: settle ${before.settleSeconds} → ${after.settleSeconds} seconds; dim ${before.dimDays} → ${after.dimDays} days; mute ${before.muteDays} → ${after.muteDays} days`;
const same = (a: Change['before'], b: Change['before']) =>
  a.settleSeconds === b.settleSeconds && a.dimDays === b.dimDays && a.muteDays === b.muteDays;

/** Trusted shared-model API. The outside door authorizes the requester and
 * approval answer. Register apply as a static Approvals operation on the same
 * connection. Pending cards contain the complete change and survive restart.
 * Notify Tempo/subscriptions only after the enclosing approval commits.
 */
export function tempoSettingsService(db: DataDatabase, clock: Clock) {
  const volume = new InboxVolume(db, clock);
  const validate = (value: Change['after']) => {
    if (clock.now() + Math.max(value.dimDays, value.muteDays) * 86_400_000 > 8.64e15)
      throw new Error('Invalid Tempo timings');
  };
  return {
    read(who: Change['who']) { return volume.timings(recipient.parse(who)); },
    prepare(who: Change['who'], patch: Partial<Change['after']>) {
      who = recipient.parse(who);
      const before = timings.parse(volume.timings(who));
      const after = timings.parse({ ...before, ...timings.partial().parse(patch) });
      validate(after);
      if (same(before, after)) throw new Error('Tempo settings are unchanged');
      const details = { who, before, after };
      return { kind: 'setting' as const, target: target(who), operation: TEMPO_SETTINGS_OPERATION,
        details: JSON.stringify(details), changeSummary: summary(details) };
    },
    apply(approval: Approval) {
      if (approval.kind !== 'setting' || approval.operation !== TEMPO_SETTINGS_OPERATION)
        throw new Error('Wrong Tempo settings operation');
      const details = change.parse(JSON.parse(approval.details));
      if (approval.target !== target(details.who) || approval.changeSummary !== summary(details))
        throw new Error('Tempo before/after does not match its card');
      validate(details.after);
      if (same(details.before, details.after)) throw new Error('Tempo settings are unchanged');
      if (!same(volume.timings(details.who), details.before))
        throw new Error('Tempo settings changed; request a fresh card');
      volume.setTimings(details.who, details.after);
    },
  };
}
