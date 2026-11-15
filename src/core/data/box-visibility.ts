import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from './queries.js';
import { members } from './schema.js';

/** Machines registry: member ownership, with current household-owner precedence.
 * Hosting an agent is execution permission, not access to its owner's registry.
 * Installed runtime services continue to use the shared database directly. */
export function boxVisibility(viewer: Viewer): QueryVisibility {
  const current = alias(members, 'box_viewer');
  return { boxes: fields => viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} as ${sql.identifier('box_viewer')} where ${current.id} = ${viewer.id} and (${current.role} = 'owner' or ${fields.owner} = ${current.id}))`
    : sql`false` };
}
