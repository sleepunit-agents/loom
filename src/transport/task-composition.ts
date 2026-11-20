/** Temporary composition adapter while household metadata moves to the foundation. */
import type { Foundation } from '../core/app.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Household, Role } from '../household.js';
import { installTasks } from '../pieces/tasks/index.js';
import { registerOperationTools } from './operation-tools.js';
export function installHouseholdTasks(app: Foundation, household: () => Household | undefined) {
  if (app.operations.has('tasks.list')) return;
  installTasks(app.db, app.operations, app.live, () => {
    const h = household();
    return { members: Object.fromEntries((h?.members ?? []).map(m => [m.person, { owner: m.agents === '*', agents: m.agents === '*' ? h!.agents : m.agents }])), projects: {}, services: {} };
  });
}
export function registerSessionOperations(server: McpServer, app: Foundation | undefined, caller: { role: Role } | undefined, household: () => Household | undefined): void {
  if (!app || !caller) return;
  // The new side's operations are offered to agents only when loom runs the new side
  // (`loom serve --next`, which sets LOOM_NEXT). On today's loom they would be tools
  // writing to a store nobody reads.
  if (process.env.LOOM_NEXT !== '1') return;
  if (caller.role.kind === 'agent') registerOperationTools(server, app.operations, { kind: 'agent', id: caller.role.agent });
  if (caller.role.kind === 'owner') {
    const h = household();
    const member = caller.role.member ?? h?.members.find(m => m.agents === '*')?.person;
    if (member) registerOperationTools(server, app.operations, { kind: 'member', id: member });
  }
}
