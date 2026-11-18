/** Knowledge's page actions; source effects and retry receipts commit together. */
import type { Viewer } from '../../policy.js';
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { mindReceipts, mindReceiptsReady } from './receipt-schema.js';
import { snapshotKnowledgeRevision } from '../../backends/knowledge-revisions.js';
import { MAX_PAGE_BODY_LENGTH } from '../../backends/knowledge-verification.js';
import { insertKnowledgeCitation, insertKnowledgePage, markKnowledgePageSourced, setKnowledgePageBody } from '../../backends/knowledge-writes.js';
import { operation, mayAct, OperationError, RecoveredWrite, type Context, type Operations, type Sharing } from '../../core/index.js';
/** Composition supplies the synchronous verification primitive. Page rows, their words and their
 * citations are written through the knowledge store's own primitives (backends/knowledge-writes.ts),
 * never by SQL here, so the store's rules hold for a page made or changed at the door.
 */
export interface KnowledgeActionResult { verified: number; slugs: string[]; verified_at: string; stamped: boolean; noted: boolean }
export type KnowledgeVerifier = (db: BetterSqlite3.Database, input: { slug: string; outcome: 'confirmed' | 'stale'; note?: string; freshness_anchor?: string; verifier: string }, now: number) => KnowledgeActionResult;

/** Opt-in alongside the read installer. Never creates a missing content store.
 * The added tables hold migration/retry metadata, never page bodies or notes.
 * Source preparation owns metadata; verification and its receipt
 * insertion share one immediate source transaction.
 */
/** A knowledge page's slug as a command may send it. The page's own rules are the store's. */
export const pageSlug = z.string().min(1).max(200);
/** `refused` answers why this caller writes nothing here, in words for the caller (the body of a job on anybody else's
 * word, shared-place-mail.ts), or nothing. Asked first by every write. */
export function installMindKnowledgeActions(operations: Operations, options: { path?: string; sharing(): Sharing; verify: KnowledgeVerifier; refused?(viewer: Viewer): string | undefined }) {
  const refuse = (viewer: Viewer) => { const why = options.refused?.(viewer); if (why) throw new OperationError('denied', why); };
  const db = options.path && existsSync(options.path) ? new BetterSqlite3(options.path, { fileMustExist: true, timeout: 0 }) : undefined;
  const recover = (ctx: Context) => {
    if (!db || !ctx.receipt || !mindReceiptsReady(db)) return;
    const prior = mindReceipts.find(db, ctx.receipt, ctx.now);
    if (!prior) return;
    const result = JSON.parse(prior.result) as { slugs: string[] };
    for (const slug of result.slugs) ctx.changed('knowledge', slug);
    return new RecoveredWrite(result, prior.expires);
  };
  // A check with no note is a pure stamp: the body, `updated` and the kept
  // versions stay as they are, and the check is recorded in `verifications`.
  for (const [verb, outcome] of [
    ['knowledgeVerify', 'confirmed'],
    ['knowledgeRecheck', 'stale'],
  ] as const) {
    const name = `mind.${verb}`;
    operations.register(operation({ name, write: true, input: z.object({ slug: pageSlug, note: z.string().trim().min(1).max(4000).optional(), freshnessAnchor: z.string().trim().min(1).max(200).optional() }), output: z.unknown(),
      recover,
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act'),
      run(ctx, input) {
        refuse(ctx.viewer);
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
        if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
        const receipt = ctx.receipt;
        if (!receipt) throw new Error('Knowledge writes require a retry identity');
        const result = db.transaction(() => {
          mindReceipts.expire(db, ctx.now);
          // Another daemon sharing this source may have committed since lookup.
          const replay = recover(ctx);
          if (replay) return replay;
          const page = db.prepare('SELECT status FROM pages WHERE slug = ?').get(input.slug) as { status: string } | undefined;
          if (!page) throw new OperationError('not-found', 'Knowledge page not found');
          if (page.status === 'archived') throw new OperationError('conflict', 'Restore the page before checking it');
          const answer = options.verify(db, { slug: input.slug, outcome, ...(input.note ? { note: input.note } : {}), ...(input.freshnessAnchor ? { freshness_anchor: input.freshnessAnchor } : {}), verifier: ctx.viewer.id }, ctx.now);
          mindReceipts.save(db, receipt, answer, receipt.expires);
          return answer;
        }).immediate();
        // Replaying after a failed core receipt also repairs missed live publication.
        if (!(result instanceof RecoveredWrite)) for (const slug of result.slugs) ctx.changed('knowledge', slug);
        return result;
      },
    }));
  }
  operations.register(operation({ name: 'mind.knowledgeAdd', write: true,
    input: z.object({ title: z.string().trim().min(1).max(200), domain: z.string().trim().toLowerCase().min(1).max(200),
      body: z.string().trim().min(1).max(MAX_PAGE_BODY_LENGTH), source: z.string().trim().max(4000).default(''), freshnessAnchor: z.string().trim().min(1).max(200).optional() }), output: z.unknown(), recover,
    may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act'),
    run(ctx, input) {
      refuse(ctx.viewer);
      if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
      if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
      if (input.source && !/^https?:\/\//.test(input.source)) throw new OperationError('invalid', 'The source must be an http or https link, or empty');
      const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
      if (!slug) throw new OperationError('invalid', 'That title has nothing to make an address from');
      const receipt = ctx.receipt!;
      const answer = db.transaction(() => {
        mindReceipts.expire(db, ctx.now);
        const replay = recover(ctx); if (replay) return replay;
        if (db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug)) throw new OperationError('conflict', 'Knowledge already has a page by that title');
        const at = new Date(ctx.now).toISOString(), sourcing = input.source ? 'sourced' : 'provisional';
        const page = insertKnowledgePage(db, { slug, title: input.title, domain: input.domain, body: input.body, sourcing,
          ...(input.freshnessAnchor ? { freshness_anchor: input.freshnessAnchor } : {}), ...(input.domain.startsWith('ours/') ? { created_by: ctx.viewer.id } : {}), actor: ctx.viewer.id }, at);
        insertKnowledgeCitation(db, page.id, { claim: input.title, source_kind: input.source ? 'web' : 'conversation', source_locator: input.source || `${ctx.viewer.id} on loom's page`, excerpt: input.title }, at);
        const result = { slug, slugs: [slug], sourcing };
        mindReceipts.save(db, receipt, result, receipt.expires);
        return result;
      }).immediate();
      if (!(answer instanceof RecoveredWrite)) ctx.changed('knowledge', slug);
      return answer;
    },
  }));
  // Edit and restore both replace a page's body. Either saves the displaced
  // body as a version first, in the same transaction, and keeps the newest ten.
  const replace = (name: string, op: string, input: z.ZodType<{ slug: string }>, next: (page: { id: number; body: string }, value: never) => string, source: (value: never) => string = () => '') =>
    operations.register(operation({ name, write: true, input, output: z.unknown(), recover,
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act'),
      run(ctx, value) {
        refuse(ctx.viewer);
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
        if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
        const receipt = ctx.receipt;
        if (!receipt) throw new Error('Knowledge writes require a retry identity');
        const answer = db.transaction(() => {
          mindReceipts.expire(db, ctx.now);
          const replay = recover(ctx); if (replay) return replay;
          const page = db.prepare('SELECT id, body, status FROM pages WHERE slug = ?').get(value.slug) as { id: number; body: string; status: string } | undefined;
          if (!page) throw new OperationError('not-found', 'Knowledge page not found');
          if (page.status === 'archived') throw new OperationError('conflict', 'Restore the page before changing it');
          const body = next(page, value as never), from = source(value as never);
          if (from && !/^https?:\/\//.test(from)) throw new OperationError('invalid', 'The source must be an http or https link, or empty');
          if (from && db.prepare('SELECT 1 FROM citations WHERE page_id = ? AND source_locator = ?').get(page.id, from)) throw new OperationError('conflict', 'The page already names that source');
          // A source alone is a change too: the words stay and no version is kept.
          if (body === page.body && !from) throw new OperationError('conflict', 'The page already says that');
          const at = new Date(ctx.now).toISOString();
          const revision = body === page.body ? null : snapshotKnowledgeRevision(db, page.id, value.slug, page.body, op, at, ctx.viewer.id);
          setKnowledgePageBody(db, page.id, body, at);
          if (from) {
            const title = (db.prepare('SELECT title FROM pages WHERE id = ?').get(page.id) as { title: string }).title;
            insertKnowledgeCitation(db, page.id, { claim: title, source_kind: 'web', source_locator: from, excerpt: title }, at);
            markKnowledgePageSourced(db, page.id);
          }
          const result = { slug: value.slug, slugs: [value.slug], revision };
          mindReceipts.save(db, receipt, result, receipt.expires);
          return result;
        }).immediate();
        if (!(answer instanceof RecoveredWrite)) ctx.changed('knowledge', value.slug);
        return answer;
      },
    }));
  const slug = pageSlug;
  // Edit: new words, a source to add, or both.
  replace('mind.knowledgeEdit', 'edit', z.object({ slug, body: z.string().trim().min(1).max(MAX_PAGE_BODY_LENGTH).optional(), source: z.string().trim().max(4000).default('') }).strict()
    .refine(value => value.body !== undefined || value.source !== '', 'Give new words, a source, or both'),
    (page, value: { body?: string }) => value.body ?? page.body, (value: { source: string }) => value.source);
  replace('mind.knowledgeRestore', 'restore', z.object({ slug, revision: z.number().int().positive() }).strict(),
    (page, value: { revision: number }) => {
      const kept = db!.prepare('SELECT body FROM page_revisions WHERE id = ? AND page_id = ?').get(value.revision, page.id) as { body: string } | undefined;
      if (!kept) throw new OperationError('not-found', 'That version of the page is not kept');
      return kept.body;
    });
  return { close() { db?.close(); } };
}
