import { sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from '../data/queries.js';
import { agents, members } from '../data/schema.js';

/** Outside-door read policy for the generated shared query schema. This does
 * not authenticate callers or authorize settings changes. Keep membership in
 * SQL so a retained schema cannot retain ownership or a removed agent. */
export function measuringVisibility(viewer: Viewer): QueryVisibility {
  // Copy scalars: mutating the caller's viewer later cannot change this schema.
  const { kind, id } = viewer;
  const owner = kind === 'member'
    ? sql`exists (select 1 from ${members} where ${members.id} = ${id} and ${members.role} = 'owner')`
    : sql`false`;
  const agent = kind === 'agent'
    ? sql`exists (select 1 from ${agents} where ${agents.id} = ${id})`
    : sql`false`;
  return {
    timingDays: () => sql`${owner} or ${agent}`,
    measuringSettings: () => owner,
  };
}
