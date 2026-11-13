/** One declaration drives household operation responses and the opt-in API client. */
import { z } from 'zod';
import { operation as defineOperation, type Operation, type CliCommand } from '../operations/index.js';
import { memberSchema } from './members.js';
import { agentAccountsSchema } from './accounts.js';
import { projectSchema, projectSlug } from './sharing.js';

export const householdResponses = {
  setMember: z.array(memberSchema),
  removeMember: z.array(memberSchema),
  addAgent: z.array(z.string()),
  setMemberProjects: z.array(projectSlug),
  setOwnedAgents: z.array(z.string()),
  setAgentAccounts: agentAccountsSchema,
  createProject: projectSchema,
  setProjectMembers: projectSchema,
  setProjectAgents: projectSchema,
};
export const householdCommands: readonly CliCommand[] = Object.keys(householdResponses)
  .map(name => ({ name, write: true, positional: ['json'] }));
export function householdOperation<I>(op: Omit<Operation<I>, 'output' | 'cli'>): Operation<I> {
  const name = op.name.slice('household.'.length) as keyof typeof householdResponses;
  const cli = householdCommands.find(command => `household.${command.name}` === op.name);
  if (!cli || !op.write) throw new Error('Household CLI metadata does not match operation');
  return defineOperation({ ...op, cli, output: householdResponses[name] });
}
