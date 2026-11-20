/** Owning ACK paths supply metadata only, after checking released source words.
 * No caller-facing operation accepts an incoming sender or a conversation id.
 */
import { createHash } from 'node:crypto';
import { OperationError, type Context } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import type { RuntimeRecords } from './records.js';

export function recordPublicIncoming(app: Foundation, ctx: Context, job: RuntimeRecords['job'],
 input: { id: string; kind: 'wake' } | { id: string; kind: 'message'; from: { kind: 'person'; slug: string } }) {
 // Private/service sources remain with their own consumers. This helper never
 // broadens the owning ACK's current source, destination or body authority.
 if (job.member !== undefined || job.service !== undefined) return;
 if (ctx.db !== app.db || !app.db.inTransaction || !job.conversation) throw new OperationError('denied', 'Incoming metadata requires its owning transaction');
 const key = createHash('sha256').update(JSON.stringify([job.id, input.id])).digest('hex');
 const result = app.operations.call('direct', ctx.viewer, 'attention.recordTurn', {
  agent: job.agent, project: job.project,
  turn: { venue: 'runtime-clock', place: job.conversation, at: new Date(ctx.now).toISOString(),
   kind: input.kind, from: input.kind === 'wake' ? { kind: 'schedule' } : input.from },
 }, `runtime-incoming:${key}`);
 if (!result.ok) throw new OperationError(result.code, result.message);
}
