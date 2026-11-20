import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

/** Read filters for tasks, projects and the agent roster. The rules are stated in policy.ts. */
export function taskVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, ['tasks', 'taskComments', 'taskLinks', 'projectMembers', 'projects', 'agents']);
}
