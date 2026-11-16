/** Knowledge's page actions; source effects and retry receipts commit together. */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { mindReceiptsReady } from './receipt-schema.js';
import { snapshotKnowledgeRevision } from '../../backends/knowledge-revisions.js';
import { operation, mayAct, OperationError, RecoveredWrite, type Context, type Operations, type Sharing } from '../../core/index.js';
/** Composition supplies the synchronous shared store primitive, without a piece
 * importing the old backend or initializing any of its schema.
 */
export interface KnowledgeActionResult { verified: number; slugs: string[]; verified_at: string; stamped: boolean; noted: boolean }
export type KnowledgeVerifier = (db: BetterSqlite3.Database, input: { slug: string; outcome: 'confirmed' | 'stale'; note?: string; freshness_anchor?: string; verifier: string }, now: number) => KnowledgeActionResult;

/** Opt-in alongside the read installer. Never creates a missing content store.
 * The added tables hold migration/retry metadata, never page bodies or notes.
 * Source preparation owns metadata; verification and its receipt
 * insertion share one immediate source transaction.
 */
export function installMindKnowledgeActions(operations: Operations, options: { path?: string; sharing(): Sharing; verify: KnowledgeVerifier; classify(domain: string, anchor?: string): string }) {
  const db = options.path && existsSync(options.path) ? new BetterSqlite3(options.path, { fileMustExist: true, timeout: 0 }) : undefined;
  const recover = (ctx: Context) => {
    if (!db || !ctx.receipt || !mindReceiptsReady(db)) return;
    const receipt = ctx.receipt;
    const prior = db.prepare('SELECT name, input_hash, result, expires FROM mind_operation_receipts WHERE viewer = ? AND id = ? AND expires > ?')
      .get(receipt.viewer, receipt.id, ctx.now) as { name: string; input_hash: string; result: string; expires: number } | undefined;
    if (!prior) return;
    if (prior.name !== receipt.name || prior.input_hash !== receipt.inputHash) throw new OperationError('conflict', 'Operation id already used for different input');
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
    operations.register(operation({ name, write: true, input: z.object({ slug: z.string().min(1).max(200), note: z.string().trim().min(1).max(4000).optional(), freshnessAnchor: z.string().trim().min(1).max(200).optional() }), output: z.unknown(),
      recover,
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', name),
      run(ctx, input) {
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
        if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
        const receipt = ctx.receipt;
        if (!receipt) throw new Error('Knowledge writes require a retry identity');
        const result = db.transaction(() => {
          db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(ctx.now);
          // Another daemon sharing this source may have committed since lookup.
          const replay = recover(ctx);
          if (replay) return replay;
          const page = db.prepare('SELECT status FROM pages WHERE slug = ?').get(input.slug) as { status: string } | undefined;
          if (!page) throw new OperationError('not-found', 'Knowledge page not found');
          if (page.status === 'archived') throw new OperationError('conflict', 'Restore the page before checking it');
          const answer = options.verify(db, { slug: input.slug, outcome, ...(input.note ? { note: input.note } : {}), ...(input.freshnessAnchor ? { freshness_anchor: input.freshnessAnchor } : {}), verifier: ctx.viewer.id }, ctx.now);
          db.prepare('INSERT INTO mind_operation_receipts VALUES (?, ?, ?, ?, ?, ?)')
            .run(receipt.viewer, receipt.id, receipt.name, receipt.inputHash, JSON.stringify(answer), receipt.expires);
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
      body: z.string().trim().min(1).max(64 * 1024), source: z.string().trim().max(4000).default(''), freshnessAnchor: z.string().trim().min(1).max(200).optional() }), output: z.unknown(), recover,
    may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', 'mind.knowledgeAdd'),
    run(ctx, input) {
      if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
      if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
      if (input.source && !/^https?:\/\//.test(input.source)) throw new OperationError('invalid', 'The source must be an http or https link, or empty');
      const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
      if (!slug) throw new OperationError('invalid', 'That title has nothing to make an address from');
      const receipt = ctx.receipt!;
      const answer = db.transaction(() => {
        db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(ctx.now);
        const replay = recover(ctx); if (replay) return replay;
        if (db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug)) throw new OperationError('conflict', 'Knowledge already has a page by that title');
        const at = new Date(ctx.now).toISOString(), sourcing = input.source ? 'sourced' : 'provisional';
        const inserted = db.prepare(`INSERT INTO pages(uuid,slug,title,domain,body,sourcing,verified_at,freshness_anchor,sla_class,created_by,author,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),slug,input.title,input.domain,input.body,sourcing,at,input.freshnessAnchor ?? null,options.classify(input.domain, input.freshnessAnchor),input.domain.startsWith('ours/') ? ctx.viewer.id : null,ctx.viewer.id,at,at);
        db.prepare('INSERT INTO citations(page_id,claim,source_kind,source_locator,excerpt,retrieved_at,created) VALUES(?,?,?,?,?,?,?)')
          .run(inserted.lastInsertRowid,input.title,input.source ? 'web' : 'conversation',input.source || `${ctx.viewer.id} on loom's page`,input.title,at,at);
        const result = { slug, slugs: [slug], sourcing };
        db.prepare('INSERT INTO mind_operation_receipts VALUES(?,?,?,?,?,?)').run(receipt.viewer,receipt.id,receipt.name,receipt.inputHash,JSON.stringify(result),receipt.expires);
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
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', name),
      run(ctx, value) {
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
        if (!mindReceiptsReady(db)) throw new OperationError('unavailable', 'Knowledge is not prepared for changes');
        const receipt = ctx.receipt;
        if (!receipt) throw new Error('Knowledge writes require a retry identity');
        const answer = db.transaction(() => {
          db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(ctx.now);
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
          db.prepare('UPDATE pages SET body = ?, updated = ? WHERE id = ?').run(body, at, page.id);
          if (from) {
            const title = (db.prepare('SELECT title FROM pages WHERE id = ?').get(page.id) as { title: string }).title;
            db.prepare('INSERT INTO citations(page_id,claim,source_kind,source_locator,excerpt,retrieved_at,created) VALUES(?,?,?,?,?,?,?)').run(page.id, title, 'web', from, title, at, at);
            db.prepare("UPDATE pages SET sourcing = 'sourced' WHERE id = ?").run(page.id);
          }
          const result = { slug: value.slug, slugs: [value.slug], revision };
          db.prepare('INSERT INTO mind_operation_receipts VALUES(?,?,?,?,?,?)').run(receipt.viewer, receipt.id, receipt.name, receipt.inputHash, JSON.stringify(result), receipt.expires);
          return result;
        }).immediate();
        if (!(answer instanceof RecoveredWrite)) ctx.changed('knowledge', value.slug);
        return answer;
      },
    }));
  const slug = z.string().min(1).max(200);
  // Edit: new words, a source to add, or both.
  replace('mind.knowledgeEdit', 'edit', z.object({ slug, body: z.string().trim().min(1).max(64 * 1024).optional(), source: z.string().trim().max(4000).default('') }).strict()
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
