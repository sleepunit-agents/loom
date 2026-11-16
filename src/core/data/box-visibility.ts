import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from './queries.js';
import { boxes, members } from './schema.js';

/** Machines registry: member ownership, with current household-owner precedence.
 * Hosting an agent is execution permission, not access to its owner's registry:
 * an agent reads no machine. The lists that hang off a machine (which agents may
 * run there, what it has) are seen with the machine, with one addition: an agent
 * sees its own rows of "may run there", so it can name a machine when it proposes
 * a change, and nothing else about that machine.
 * Installed runtime services continue to use the shared database directly. */
export function boxVisibility(viewer: Viewer): QueryVisibility {
  const current = alias(members, 'box_viewer'), parent = alias(boxes, 'box_viewer_box');
  const machine = (owner: AnyColumn | SQL): SQL => viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} as ${sql.identifier('box_viewer')} where ${current.id} = ${viewer.id} and (${current.role} = 'owner' or ${owner} = ${current.id}))`
    : sql`false`;
  const within = (box: AnyColumn): SQL => sql`exists (select 1 from ${boxes} as ${sql.identifier('box_viewer_box')} where ${parent.id} = ${box} and ${machine(sql`${parent.owner}`)})`;
  return { boxes: fields => machine(fields.owner),
    boxAgents: fields => viewer.kind === 'agent' ? sql`${fields.agent} = ${viewer.id}` : within(fields.box),
    boxFacts: fields => within(fields.box) };
}
