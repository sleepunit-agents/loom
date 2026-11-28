import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

/** Read filters for approvals and changes. Outside read policy only: no write authority.
 * The rules are stated in policy.ts; `approvals` is the labelled-record rule, which the
 * conversation, job and inbox reads also use. */
export function workVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, ['approvals', 'approvalRecord', 'approvalNotices', 'approvalRules', 'changeSync', 'changes', 'changeChecks', 'changePeople', 'changeFiles', 'changeTasks']);
}
