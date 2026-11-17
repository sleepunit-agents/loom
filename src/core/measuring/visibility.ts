import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from '../data/queries.js';

/** Read filters for timings and measuring settings at the outside door. This does not
 * authenticate callers or authorize settings changes. The rules are stated in policy.ts. */
export function measuringVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, ['timingDays', 'measuringSettings']);
}
