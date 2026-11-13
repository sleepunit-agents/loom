import { OperationError, type Context } from '../../core/index.js';
import type { GrantAttention } from './index.js';
import type { GrantRequest } from './role.js';
/** Persisted requests keep the atomic resolution obligation across a restart. */
export function resolveGrantAttention(attention: GrantAttention | undefined, request: GrantRequest, ctx: Context): void {
  if (!attention?.resolve) {
    if (request.attentionManaged) throw new OperationError('unavailable', 'Grant request needs its attention source');
    return;
  }
  const result: unknown = attention.resolve(request, ctx);
  if (result instanceof Promise) { void result.catch(() => {}); throw new OperationError('unavailable', 'Attention resolution must be synchronous'); }
  if (!result || typeof result !== 'object' || !('resolved' in result) || result.resolved !== true) throw new OperationError('unavailable', 'Attention did not acknowledge resolution');
}
