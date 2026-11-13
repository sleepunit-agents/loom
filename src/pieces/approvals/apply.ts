import { OperationError, type Result } from '../../core/index.js';
import { type Approval, type State, ownerApplied } from './model.js';
import { answer, use, type DomainContext } from './domain.js';

/** A synchronous in-process role on the same foundation database. Implementations
 * must do database work only: external work is an outbox record in that transaction.
 * A failure rolls back both the role's work and the approval's answer/spend.
 */
export interface ApprovalApplication {
  apply(approval: Readonly<Approval>, by: string): Result;
}
export interface ApprovalApplications {
  runtime?: ApprovalApplication;
  clock?: ApprovalApplication;
}

export function answerAndApply(
  state: State,
  id: string,
  action: string,
  by: string,
  context: DomainContext,
  applications: ApprovalApplications,
) {
  const approval = answer(state, id, action, by, context.now);
  if (action !== 'allow' || !ownerApplied.has(approval.kind)) return approval;
  const role = approval.kind === 'vouch-wake' ? applications.clock : applications.runtime;
  if (!role) throw new OperationError('unavailable', `The ${approval.kind} application role is unavailable`);
  const result = role.apply(Object.freeze(structuredClone(approval)), by);
  if (!result || result instanceof Promise || typeof result.ok !== 'boolean') {
    throw new OperationError('unavailable', 'The application role must return a synchronous result');
  }
  if (!result.ok) throw new OperationError(result.code, result.message);
  // Spend as the original authenticated caller. The owner deciding does not
  // manufacture a new principal or widen the receipt to another service house.
  return use(state, id, approval.kind, approval.target, {
    ...context,
    piece: true,
    caller: { who: approval.who, for: approval.for, people: approval.people },
  });
}
