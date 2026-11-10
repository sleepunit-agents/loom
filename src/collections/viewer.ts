/**
 * Who may see what (docs/specs/collections.md, "Who may see what: three separate questions"): the viewer, a
 * record's audience, core's agent rule and the field classes. Core checks these on every row a provider answers,
 * whatever the provider said, so a provider that ignores who's asking leaks no rows.
 */
import type { FieldClass, TypeDecl } from './contract.js';
import { PROVIDER } from './contract.js';
import type { Household, Member } from '../household.js';

/**
 * Who is looking. A member's session or owner token (`household`: they own every agent; `agents`: the agents they
 * own, every one for a household owner), an agent's token (a task house's has `house`, a service house's
 * `service`), or core itself, which no route can be.
 */
export type Viewer =
  | { kind: 'member'; person: string; household: boolean; agents: readonly string[] }
  | { kind: 'agent'; agent: string; house?: string; service?: string }
  | { kind: 'core' };

/** A member as a viewer, their agents read from the household now (never from what a caller says). */
export function memberViewer(h: Household, m: Member): Viewer {
  return m.agents === '*'
    ? { kind: 'member', person: m.person, household: true, agents: [...h.agents] }
    : { kind: 'member', person: m.person, household: false, agents: m.agents.filter((a) => h.agents.includes(a)) };
}

export const isHouseholdOwner = (v: Viewer): boolean => v.kind === 'core' || (v.kind === 'member' && v.household);

/** A record's audience (collections.md, "Audience"): its terms are a union. */
export interface Audience {
  household?: true;
  owners?: true;
  ownersOf?: string[];
  members?: string[];
  agents?: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const names = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every((x) => typeof x === 'string' && NAME.test(x));

/** A provider's audience, checked; undefined when it isn't one (the row is then dropped: fail closed). */
export function parseAudience(v: unknown): Audience | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: Audience = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === 'household' || k === 'owners') { if (x !== true) return undefined; out[k] = true; continue; }
    if (k === 'ownersOf' || k === 'members' || k === 'agents') { if (!names(x)) return undefined; out[k] = [...x]; continue; }
    return undefined;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Whether `audience` and core's agent rule admit `viewer` to a record whose agent field says `agent` (undefined: the
 * type has none, or the record names none). `decl` says whether houses may read the type at all.
 *
 *  - Household owners: every term but `members`, which admits only the members it names.
 *  - An owner of some agents: the agent rule first (owners.md, today's `forOwner`): a record must name one of their
 *    agents, and one naming none is household owners' only, except through a `members` term naming them. Then the
 *    audience: `household`, an `ownersOf` naming one of their agents, or `members` naming them.
 *  - An agent's token: an `agents` term naming it; a house's only where the type allows houses (a service house's,
 *    services too).
 */
export function admits(viewer: Viewer, audience: Audience, agent: string | undefined, decl: Pick<TypeDecl, 'houses' | 'services'>): boolean {
  switch (viewer.kind) {
    case 'core': return true;
    case 'member': {
      const named = audience.members?.includes(viewer.person) === true;
      if (viewer.household) {
        // A household owner owns every agent: the agent rule passes. Every term but `members` admits them.
        return named || !!(audience.household || audience.owners || audience.ownersOf || audience.agents);
      }
      if (agent === undefined) return named;
      if (!viewer.agents.includes(agent)) return false;
      return named || audience.household === true || (audience.ownersOf?.some((a) => viewer.agents.includes(a)) ?? false);
    }
    case 'agent': {
      if (viewer.service !== undefined && !(decl.houses && decl.services)) return false;
      if (viewer.house !== undefined && !decl.houses) return false;
      return audience.agents?.includes(viewer.agent) === true;
    }
  }
}

/** The field classes a viewer may ever be sent: `owner` is household owners' only. */
export function classesOf(viewer: Viewer): ReadonlySet<FieldClass> {
  return new Set<FieldClass>(isHouseholdOwner(viewer) ? ['household', 'member', 'owner'] : ['household', 'member']);
}

/** The viewer as a provider is told it (collections.md: the member and what they own, or the agent and its house). */
export function presented(viewer: Viewer): Record<string, unknown> {
  switch (viewer.kind) {
    case 'core': return { kind: 'core' };
    case 'member': return { kind: 'member', who: viewer.person, household: viewer.household, agents: viewer.household ? '*' : [...viewer.agents] };
    case 'agent': return { kind: 'agent', agent: viewer.agent, ...(viewer.house ? { house: viewer.house } : {}), ...(viewer.service ? { service: viewer.service } : {}) };
  }
}

/** A stable name for a viewer and everything their authority rests on, for sealing cursors to them. */
export function viewerId(viewer: Viewer): string {
  switch (viewer.kind) {
    case 'core': return 'core';
    case 'member': return `member:${viewer.person}:${viewer.household ? '*' : [...viewer.agents].sort().join(',')}`;
    case 'agent': return `agent:${viewer.agent}:${viewer.house ?? ''}:${viewer.service ?? ''}`;
  }
}

/**
 * Whether a provider answers this viewer at all (collections.md, "4. The piece allows agent owners at all"): one
 * that doesn't declare `owners: 2` answers household owners only, and core refuses anyone else before it runs.
 */
export function providerAdmits(viewer: Viewer, owners2: boolean): boolean {
  return owners2 || isHouseholdOwner(viewer);
}

export const validProvider = (p: string): boolean => PROVIDER.test(p);
