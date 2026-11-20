import { it, expect, vi } from 'vitest';
import { CollectionRuntime, type Transport } from '../../web/src/collections/runtime';
const shared = vi.hoisted(() => ({ runtime: null as unknown as CollectionRuntime }));
vi.mock('../../web/src/page', () => ({ collectionsRuntime: async () => ({ runtime: shared.runtime }) }));
import { watchProjects } from '../../web/src/tasks-live';
it('repages the real runtime after reconnect during a pending continuation with an equal length first page', async () => {
  const handlers = new Map<string, (d: Record<string, unknown>) => void>();
  let resume: (() => void) | undefined;
  const asks: Array<{ stream: string; after?: string }> = [];
  const transport: Transport = {
    on: (event, f) => { handlers.set(event, f); return () => handlers.delete(event); },
    post: async (body) => {
      const queries = body.queries as Array<{ id: string; stream: string; after?: string }>;
      const answers = await Promise.all(queries.map(async (q) => {
        asks.push(q);
        if (q.stream === 'first' && q.after) await new Promise<void>((resolve) => { resume = resolve; });
        const start = q.after ? 500 : 0, n = q.after ? 100 : 500;
        return { id: q.id, rows: Array.from({ length: n }, (_, i) => ({ key: `loom/project/art:p${start + i}` })),
          next: q.after ? null : 'tail', at: 0, scope: 1, withheld: [], coverage: { complete: !!q.after } };
      }));
      return { status: 200, json: { answers } };
    },
  };
  shared.runtime = new CollectionRuntime(transport);
  handlers.get('hello')!({ stream: 'first', scope: 1, seq: 0 });
  const got = vi.fn(); const stop = watchProjects('csrf', got);
  try {
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    expect(got).not.toHaveBeenCalled();
    handlers.get('error')!({});
    handlers.get('hello')!({ stream: 'second', scope: 1, seq: 0 });
    await vi.waitFor(() => expect(got.mock.calls.at(-1)?.[1].size).toBe(600));
    expect(asks.filter((q) => q.stream === 'second').map((q) => q.after ?? 'first')).toEqual(['first', 'tail']);
  } finally { resume?.(); stop(); shared.runtime.clear(); }
});
