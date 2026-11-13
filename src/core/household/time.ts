import type { Foundation } from '../app.js';
import { maySee } from '../../policy.js';
import { HouseholdDatabase } from './document.js';
import { SharingDatabase } from './sharing.js';

/** A server minute, not a device clock. Live owns each subscription's deadline. */
export function installHouseholdTime(app: Foundation, home: string) {
  const household = new HouseholdDatabase(app.db), sharing = new SharingDatabase(app.db, home);
  app.live.register({
    name: 'household.time', ids: () => Object.keys(sharing.sharing().members),
    read(id, viewer) {
      if (!maySee(viewer, { member: id }, sharing.sharing())) return;
      const h = household.household(home);
      if (!h) return;
      return { id, member: id, at: app.operations.clock.now(), timezone: h.tz ?? 'UTC' };
    },
    inScope: (_record, scope) => scope === undefined,
    expires: record => (Math.floor(Number(record.at) / 60_000) + 1) * 60_000,
  });
}
