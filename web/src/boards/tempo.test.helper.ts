/** Made-up Tempo rows for the `tempo` and `trigger` bricks' suites. */
import type { Trigger } from '../pieces/tempo/model';

export const trigger = (id: string, fields: Partial<Trigger> = {}): Trigger => ({
  id, ownerKind: 'agent', owner: 'art', sourceKind: 'time', watches: null, times: '07:17', days: 'weekdays',
  lifespan: 'until-stopped', targetKind: 'inbox', target: null, toKind: 'agent', to: 'art', project: null,
  instructions: 'Water the beds', file: null, note: 'Morning water', enabled: true, state: 'standing',
  nextDueAt: '2026-11-28T07:17:00.000Z', lastFiredAt: '2026-11-27T07:17:00.000Z', createdAt: '2026-11-14T00:00:00.000Z', changedAt: '2026-11-14T00:00:00.000Z', ...fields,
});
export const at = (iso: string, zone = 'UTC') => new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
