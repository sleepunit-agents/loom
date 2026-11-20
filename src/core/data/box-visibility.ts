import { and, sql } from 'drizzle-orm';
import { agents } from './schema.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

/** Read filters for the machines registry. The rules are stated in policy.ts.
 * Installed runtime services continue to use the shared database directly. */
export function boxVisibility(viewer: Viewer): QueryVisibility {
  const visibility = sqlVisibility(viewer, ['boxes', 'boxAgents', 'boxFacts']);
  return {
    ...visibility,
    // The machine roster shows current placements. The saved grant can take effect again after a restore.
    boxAgents: fields => and(visibility.boxAgents!(fields),
      sql`exists (select 1 from ${agents} where ${agents.id} = ${fields.agent} and ${agents.removedAt} is null)`)!,
  };
}
