import type { Foundation } from '../../core/app.js';
import { installHouseholdProjects } from '../../core/household/operations.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { mayAct } from '../../policy.js';

/** Next-side composition only: all metadata comes from loom.db, including an empty home. */
export function installSharing(app: Foundation, home: string) {
  migrateHouseholdTables(app.db);
  const store = new SharingDatabase(app.db, home);
  installHouseholdProjects(app, home);
  app.live.register({
    name: 'household.sharing', ids: () => ['household'],
    read(id, viewer) {
      if (!mayAct(viewer, {}, store.sharing(), 'household')) return;
      const household = new HouseholdDatabase(app.db).household(home);
      return household ? { id, members: household.members.map(m => m.person), agents: household.agents } : undefined;
    },
    inScope: () => true,
  });
  return () => store.sharing();
}
