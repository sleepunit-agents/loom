/** Tests that used to set machines and agents up through owner commands at the door.
 * Those commands are gone: from outside, such a change is a proposal an owner allows.
 * Installed code sets things up through `services.setup`, and so do these tests. The
 * reply has the door's shape so the tests' downstream assertions read the same. */
import { z } from 'zod';
import { OperationError } from '../../src/core/operations/index.js';
import { boxSettingsInput } from '../../src/shared-box-settings.js';
import { agentRunSettingsInput } from '../../src/shared-agent-run-settings.js';
import { agentModelsInput } from '../../src/shared-agent-models.js';
import { agentBodyPolicyInput } from '../../src/shared-agent-body-policy.js';
import type { sharedRoot } from '../../src/shared-root.js';
type Root = ReturnType<typeof sharedRoot>;
const status = { denied: 403, invalid: 400, conflict: 409, 'not-found': 404, unavailable: 503 } as const;
const steps: Record<string, { input: z.ZodType; run(root: Root, input: never, member: string): void }> = {
  boxSettingsSet: { input: boxSettingsInput, run: (root, input) => root.services.setup.machine(input) },
  agentRunSettingsSet: { input: agentRunSettingsInput, run: (root, input, member) => root.services.setup.run(member, input) },
  agentModelsSet: { input: agentModelsInput, run: (root, input) => root.services.setup.models(input) },
  agentBodyPolicySet: { input: agentBodyPolicyInput, run: (root, input) => root.services.setup.bodyPolicy(input) },
  boxRevoke: { input: z.object({ box: z.string().min(1).max(200) }).strict(), run: (root, input: { box: string }) => root.services.setup.revokeMachine(input.box) },
};
/** Undefined when `name` is not one of the removed setup commands: the caller then uses the door. */
export function setupCall(root: Root, name: string, input: unknown, member = 'owner'): Response | undefined {
  const step = steps[name.replace(/^runtime\./, '')];
  if (!step) return undefined;
  const parsed = step.input.safeParse(input);
  if (!parsed.success) return Response.json({ ok: false, code: 'invalid', message: 'Invalid input' }, { status: 400 });
  try { root.writes.run(() => step.run(root, parsed.data as never, member)); }
  catch (error) {
    if (error instanceof OperationError) return Response.json({ ok: false, code: error.code, message: error.message }, { status: status[error.code] });
    return Response.json({ ok: false, code: 'unavailable', message: 'Operation could not complete' }, { status: 503 });
  }
  return Response.json({ ok: true, value: { saved: true } });
}
