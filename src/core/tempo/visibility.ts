import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from '../data/queries.js';

/** Read filters for triggers and agent pauses at the outside door, not authentication or
 * write authority. The rules are stated in policy.ts. Installed code reads directly. */
export function tempoVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, ['triggers', 'triggerEdits', 'triggerLog', 'agentPauses']);
}
