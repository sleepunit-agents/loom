/** Read operations for portable agent content; content never enters loom.db. */
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { operation, maySee, type Operations, type Live, type Sharing, type Viewer } from '../../core/index.js';
import { knowledgeView, type KnowledgeOpen } from './knowledge.js';

/** Composition supplies paths from household database metadata, never household.json. */
export function installMindKnowledge(operations: Operations, live: Live, options: {
  path: string; sharing(): Sharing;
}) {
  // One retained read-only connection, including across live notifications.
  const db = existsSync(options.path) ? new BetterSqlite3(options.path, { readonly: true, fileMustExist: true, timeout: 0 }) : undefined;
  const visible = (viewer: Viewer) => maySee(viewer, { type: 'knowledge' }, options.sharing());
  const view = (slug?: string) => {
    const load = () => knowledgeView(db, operations.clock.now(), slug, slug !== undefined);
    return db ? db.transaction(load)() : load();
  };
  const read = (slug: string, viewer: Viewer) => {
    if (!visible(viewer)) return;
    const page = view(slug).open;
    return page ? { ...page, id: page.slug } : undefined;
  };
  operations.register(operation({ name: 'mind.knowledgeList', input: z.object({}), output: z.unknown(),
    may: visible, run: () => view(),
  }));
  operations.register(operation({ name: 'mind.knowledgeRead', input: z.object({ slug: z.string().min(1).max(200) }), output: z.unknown(),
    may: visible, run: (ctx, input) => read(input.slug, ctx.viewer) ?? { ok: false, code: 'not-found', message: 'Knowledge page not found' },
  }));
  live.register({ name: 'knowledge', ids: scope => scope === undefined ? view().pages.map(p => p.slug) : [scope], read,
    inScope: (r, scope) => scope === undefined || r.id === scope,
    // Freshness and Recently verified change at their exact boundary without polling.
    expires(record) {
      const page = record as unknown as KnowledgeOpen;
      const anchor = Date.parse(page.verified_at ?? page.updated);
      const now = operations.clock.now();
      const deadlines = [anchor + 20 * 86400_000, anchor + 30 * 86400_000,
        ...(page.verified_at ? [Date.parse(page.verified_at) + 7 * 86400_000] : [])];
      return deadlines.filter(t => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0];
    },
  });
  return { close() { db?.close(); } };
}
