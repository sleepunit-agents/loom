/** Tests that used to change settings through owner commands at the door.
 * Those commands are gone: from outside, a settings change is a proposal a household
 * owner allows (household.propose). Installed code sets things up through
 * `services.setup`, and so do these tests. The reply has the door's shape so the
 * tests' downstream assertions read the same. */
import { z } from 'zod';
import { OperationError } from '../../src/core/operations/index.js';
import { boxSettingsInput } from '../../src/shared-box-settings.js';
import { agentRunSettingsInput } from '../../src/shared-agent-run-settings.js';
import { agentModelsInput } from '../../src/shared-agent-models.js';
import { agentBodyPolicyInput } from '../../src/shared-agent-body-policy.js';
import { memberInput, agentInput, settingsInput, HouseholdError } from '../../src/apps/household.js';
import { projectInput } from '../../src/shared-projects.js';
import { approvalRuleInput } from '../../src/apps/approval-rules.js';
import { secretRuleInput } from '../../src/pieces/secrets/requests.js';
import { houseSecretsInput } from '../../src/shared-secret-commands.js';
import { bridgeConfiguration } from '../../src/pieces/bridges/settings.js';
import type { sharedRoot } from '../../src/shared-root.js';
type Root = ReturnType<typeof sharedRoot>;
const status = { denied: 403, invalid: 400, conflict: 409, 'not-found': 404, unavailable: 503 } as const;
const saved = { saved: true };
interface Step { input: z.ZodType; run(root: Root, input: never, member: string): unknown }
const secretAction = z.discriminatedUnion('action', [
  secretRuleInput.extend({ action: z.literal('rule') }).strict(),
  z.object({ action: z.literal('default'), answer: z.enum(['ask', 'auto', 'never']) }).strict(),
  houseSecretsInput.extend({ action: z.literal('house') }).strict(),
]);
const steps: Record<string, Step> = {
  'runtime.boxSettingsSet': { input: boxSettingsInput, run: (root, input) => { root.services.setup.machine(input); return saved; } },
  'runtime.agentRunSettingsSet': { input: agentRunSettingsInput, run: (root, input, member) => { root.services.setup.run(member, input); return saved; } },
  'runtime.agentModelsSet': { input: agentModelsInput, run: (root, input) => { root.services.setup.models(input); return saved; } },
  'runtime.agentBodyPolicySet': { input: agentBodyPolicyInput, run: (root, input) => { root.services.setup.bodyPolicy(input); return saved; } },
  'runtime.boxRevoke': { input: z.object({ box: z.string().min(1).max(200) }).strict(), run: (root, input: { box: string }) => { root.services.setup.revokeMachine(input.box); return saved; } },
  'household.setMember': { input: memberInput, run: (root, input) => root.services.setup.member(input) },
  'household.setAgent': { input: agentInput, run: (root, input) => root.services.setup.agent(input) },
  'household.setSettings': { input: settingsInput, run: (root, input) => root.services.setup.settings(input) },
  'household.setProject': { input: projectInput, run: (root, input) => root.services.setup.project(input) },
  'household.setAgentAccounts': { input: z.object({ agent: z.string().min(1), github: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)).max(100) }).strict(),
    run: (root, input: { agent: string; github: string[] }) => ({ saved: (root.services.setup.accounts(input) as { saved: true }).saved }) },
  'approvals.setRule': { input: approvalRuleInput, run: (root, input, member) => root.services.setup.rule(input, member) },
  'secrets.command': { input: secretAction, run: (root, input: z.infer<typeof secretAction>) => {
    if (input.action === 'rule') { const { action: _action, ...rule } = input; root.services.setup.secretRule(rule); }
    else if (input.action === 'default') root.services.setup.secretDefault(input.answer);
    else { const { action: _action, ...house } = input; root.services.setup.houseSecrets(house); }
    return saved; } },
  'bridges.command': { input: bridgeConfiguration, run: (root, input) => { root.services.setup.bridge(input); return saved; } },
};
/** Undefined when this is not one of the removed settings commands (or is an answer the
 * door still takes, such as a secret request's answer or a bridge send's review): the
 * caller then uses the door. `name` may be `piece.verb`, `piece/verb`, or a bare runtime verb. */
export function setupCall(root: Root, name: string, input: unknown, member = 'owner'): Response | undefined {
  const key = name.replace('/', '.'), step = steps[key] ?? steps['runtime.' + key];
  if (!step) return undefined;
  const action = (input as { action?: unknown } | null)?.action;
  if (key === 'secrets.command' && !['rule', 'default', 'house'].includes(String(action))) return undefined;
  if (key === 'bridges.command' && action === 'review') return undefined;
  const parsed = step.input.safeParse(input);
  if (!parsed.success) return Response.json({ ok: false, code: 'invalid', message: 'Invalid input' }, { status: 400 });
  let value: unknown;
  try { value = root.writes.run(() => step.run(root, parsed.data as never, member)).value; }
  catch (error) {
    // A storage refusal (a missing reference, a broken rule of the schema) is a bad request here, as it is for a proposal.
    const known = error instanceof OperationError || error instanceof HouseholdError, plain = error instanceof Error && !('code' in error);
    const code = known ? (error as OperationError).code : 'invalid' as const;
    return Response.json({ ok: false, code, message: known || plain ? (error as Error).message : 'That change could not be made' }, { status: status[code] });
  }
  return Response.json({ ok: true, value });
}
