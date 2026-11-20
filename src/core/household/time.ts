import type { Foundation } from '../app.js';
import { maySee } from '../../policy.js';
import { HouseholdDatabase } from './document.js';
import { SharingDatabase } from './sharing.js';

/** A server minute, not a device clock. Missed minutes publish only the current one. */
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
    refreshOn: change => change.type === 'household.time',
  });
  let stopped = false, cancel: () => void;
  const schedule = () => {
    const now = app.operations.clock.now();
    cancel = app.operations.clock.at((Math.floor(now / 60_000) + 1) * 60_000, () => {
      // Schedule again after this clock turn, not inside it: a jump/sleep must
      // not replay thousands of elapsed minutes or enqueue stale socket frames.
      queueMicrotask(() => {
        if (stopped) return;
        try { app.live.changed([{ type: 'household.time', id: 'minute' }]); }
        finally { schedule(); }
      });
    });
  };
  schedule();
  app.onClose(() => { stopped = true; cancel(); });
}
