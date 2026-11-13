/** Real in-process composition; no member authority is invented for a request. */
import { OperationError, type Operations } from '../../core/index.js';
import type { AttentionSources } from '../attention/role.js';
import type { GrantAttention } from './index.js';
export function secretGrantAttention(sources: AttentionSources, operations: Pick<Operations, 'call'>): GrantAttention {
  const source = sources.register('secrets', (ctx, ask) => {
    const kind = ask.answer?.kind;
    if (!kind || kind === 'words' || kind === 'replied') throw new OperationError('invalid', 'Grant asks need a yes or no');
    const result = operations.call('direct', ctx.viewer, 'secrets.answer', { id: ask.id, allow: kind === 'yes' }, `attention:${ask.id}`);
    if (!result.ok) throw new OperationError(result.code, result.message);
  });
  return {
    raise(request, ctx) {
      source.raise(ctx, { id: request.id, ask: `Allow ${request.agent} to use ${request.target}?`,
        why: request.why, if_yes: 'I grant this request.', if_no: 'I deny this request.',
        answers: 'yes-no', refs: [request.id], href: '/p/settings-preview' });
      return { raised: true, managed: true };
    },
    resolve(request, ctx) { source.resolve(ctx, request.id, `Grant request ${request.state}`); return { resolved: true }; },
  };
}
