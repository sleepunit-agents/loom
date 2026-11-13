import { z } from 'zod';
import type { Db } from '../db/index.js';
import { OperationError } from '../operations/index.js';
import { firstOwner, type Member } from '../../household.js';
import { HouseholdDatabase } from './document.js';
import { TokenDatabase } from './tokens.js';

export const memberPerson = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
export const memberAgents = z.union([z.literal('*'), z.array(z.string())]);
export const memberSchema = z.object({ person: memberPerson, role: z.enum(['owner', 'member']), agents: memberAgents });

/** The enclosing operation owns the transaction, retry receipt and access events. */
export function changeHouseholdMember(db: Db, home: string, person: string, agents?: '*' | string[]): Member[] {
  if (!db.inTransaction) throw new Error('member change requires a transaction');
  const household = new HouseholdDatabase(db), h = household.household(home);
  if (!h) throw new OperationError('unavailable', 'Household has not been imported');
  const previous = h.members.find(m => m.person === person);
  if (agents === undefined && !previous) throw new OperationError('not-found', 'Member does not exist');
  if (agents !== undefined && agents !== '*' && agents.some(a => !h.agents.includes(a))) throw new OperationError('invalid', 'Unknown household agent');
  // Match the old member-set action: new members are owners. Existing ordinary
  // members keep their role unless explicitly promoted to household ownership.
  const next: Member | undefined = agents === undefined ? undefined : {
    person, role: agents === '*' ? 'owner' : previous?.role ?? 'owner',
    agents: agents === '*' ? '*' : [...new Set(agents)],
  };
  if (next?.role === 'owner' && Array.isArray(next.agents) && !next.agents.length) throw new OperationError('invalid', 'A scoped owner must own an agent');
  const members = h.members.flatMap(m => m.person === person ? next ? [next] : [] : [m]);
  if (next && !previous) members.push(next);
  const first = members.find(m => m.agents === '*');
  if (!first) throw new OperationError('invalid', 'A household owner must remain');
  const was = firstOwner(h).person;
  if (first.person !== was) {
    // Pin *all* unbound owner credentials, including revoked ones: no credential
    // may ever acquire a different person through a later first-owner fallback.
    new TokenDatabase(db).change(tokens => {
      for (const token of tokens) if (token.role === 'owner' && token.member === undefined) token.member = was;
    });
  }
  household.change(home, raw => {
    const old = Array.isArray(raw.members) ? raw.members as Array<Record<string, unknown>> : h.members;
    raw.members = members.map(m => {
      const row = old.find(old => old.person === m.person);
      return m.person === person ? { ...row, ...m } : row ?? m;
    });
  });
  return members;
}
