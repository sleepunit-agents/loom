import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

/** Read filters for the machines registry. The rules are stated in policy.ts.
 * Installed runtime services continue to use the shared database directly. */
export function boxVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, ['boxes', 'boxAgents', 'boxFacts']);
}
