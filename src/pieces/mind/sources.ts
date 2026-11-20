/** Store locations from database metadata. No discovery through JSON or defaults. */
import { join } from 'node:path';
import type { Db } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';

export interface MindSources {
  commons: { directory: string; knowledge: string; people: string };
  agents: Array<{ agent: string; directory: string; memories: string }>;
}

/** A startup snapshot; changing the household's source inventory requires restart. */
export function mindSources(db: Db, home: string): MindSources | undefined {
  const household = new HouseholdDatabase(db).household(home);
  if (!household) return;
  const directory = join(household.home, 'commons');
  return {
    commons: { directory, knowledge: join(directory, 'knowledge.db'), people: join(directory, 'people.db') },
    agents: household.agents.map(agent => {
      const directory = join(household.home, 'agents', agent);
      return { agent, directory, memories: join(directory, 'memories.db') };
    }),
  };
}
