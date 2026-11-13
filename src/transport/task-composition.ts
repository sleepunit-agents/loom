/** Temporary composition adapter while household metadata moves to the foundation. */
import type { Foundation } from '../core/app.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Household, Role } from '../household.js';
import { installHouseholdProjects } from '../core/household/operations.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { installTasks } from '../pieces/tasks/index.js';
import { registerOperationTools } from './operation-tools.js';
export function installHouseholdTasks(app: Foundation, household: () => Household | undefined) {
  // Only projects live in SQLite. Members, ownership, tokens and sessions still
  // use the production file adapter, including after it refreshes or disappears.
  migrateHouseholdTables(app.db);
  const sharing = new SharingDatabase(app.db, '', household);
  if (!app.operations.has('household.createProject')) installHouseholdProjects(app, '', household);
  if (!app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, () => sharing.sharing());
}
export function registerSessionOperations(server: McpServer, app: Foundation | undefined, caller: { role: Role } | undefined, household: () => Household | undefined): void {
  if (!app || !caller) return;
  if (caller.role.kind === 'agent') registerOperationTools(server, app.operations, { kind: 'agent', id: caller.role.agent });
  if (caller.role.kind === 'owner') {
    const h = household();
    const member = caller.role.member ?? h?.members.find(m => m.agents === '*')?.person;
    if (member) registerOperationTools(server, app.operations, { kind: 'member', id: member });
  }
}
