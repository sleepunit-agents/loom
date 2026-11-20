import { z } from 'zod';
import type { Db } from '../db/index.js';
import { OperationError } from '../operations/index.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';

/** Public attribution metadata, never a credential or an access grant. */
export const agentAccountsSchema = z.object({
  github: z.array(z.string().regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/)).max(100).default([]),
}).strict();
export type AgentAccounts = z.infer<typeof agentAccountsSchema>;

/** Optional metadata keyed by household agent; absent and removed agents have no accounts. */
export class HouseholdAccounts {
  constructor(private readonly db: Db, private readonly home: string) {}
  get(agent: string): AgentAccounts {
    if (!new HouseholdDatabase(this.db).household(this.home)?.agents.includes(agent)) return { github: [] };
    const raw = new HouseholdRows(this.db, 'settings').get(`agent-accounts:${agent}`);
    return raw === undefined ? { github: [] } : agentAccountsSchema.parse(raw);
  }
  set(agent: string, accounts: AgentAccounts): AgentAccounts {
    if (!this.db.inTransaction) throw new Error('account change requires a transaction');
    if (!new HouseholdDatabase(this.db).household(this.home)?.agents.includes(agent)) {
      throw new OperationError('invalid', 'Unknown household agent');
    }
    const parsed = agentAccountsSchema.parse(accounts);
    const next = { github: [...new Set(parsed.github.map(login => login.toLowerCase()))] };
    const rows = new HouseholdRows(this.db, 'settings');
    // A login must identify one agent, independently of case and update order.
    const agents = new HouseholdDatabase(this.db).household(this.home)!.agents;
    if (agents.some(id => id !== agent && this.get(id).github.some(login => next.github.includes(login.toLowerCase())))) {
      throw new OperationError('conflict', 'GitHub account already belongs to another agent');
    }
    if (next.github.length) rows.put(`agent-accounts:${agent}`, next);
    else rows.remove(`agent-accounts:${agent}`);
    return next;
  }
}
