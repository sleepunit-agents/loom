/** Knowledge's two page actions; source effects and retry receipts commit together. */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { migrateMindReceipts } from './receipt-schema.js';
import { operation, mayAct, OperationError, RecoveredWrite, type Context, type Operations, type Sharing } from '../../core/index.js';
/** Composition supplies the synchronous shared store primitive, without a piece
 * importing the old backend or initializing any of its schema.
 */
export interface KnowledgeActionResult { verified: number; slugs: string[]; verified_at: string; stamped: boolean; noted: boolean }
export type KnowledgeVerifier = (db: BetterSqlite3.Database, input: { slug: string; outcome: 'confirmed' | 'stale'; note: string; verifier: string }, now: number) => KnowledgeActionResult;

/** Opt-in alongside the read installer. Never creates a missing content store.
 * The added tables hold migration/retry metadata, never page bodies or notes.
 * Numbered metadata migrations run at install; verification and its receipt
 * insertion share one immediate source transaction.
 */
export function installMindKnowledgeActions(operations: Operations, options: { path?: string; sharing(): Sharing; verify: KnowledgeVerifier; classify(domain: string): string }) {
  const db = options.path && existsSync(options.path) ? new BetterSqlite3(options.path, { fileMustExist: true, timeout: 0 }) : undefined;
  try { if (db) migrateMindReceipts(db); } catch (error) { db?.close(); throw error; }
  const recover = (ctx: Context) => {
    if (!db || !ctx.receipt) return;
    const receipt = ctx.receipt;
    const prior = db.prepare('SELECT name, input_hash, result, expires FROM mind_operation_receipts WHERE viewer = ? AND id = ? AND expires > ?')
      .get(receipt.viewer, receipt.id, ctx.now) as { name: string; input_hash: string; result: string; expires: number } | undefined;
    if (!prior) return;
    if (prior.name !== receipt.name || prior.input_hash !== receipt.inputHash) throw new OperationError('conflict', 'Operation id already used for different input');
    const result = JSON.parse(prior.result) as { slugs: string[] };
    for (const slug of result.slugs) ctx.changed('knowledge', slug);
    return new RecoveredWrite(result, prior.expires);
  };
  for (const [verb, outcome, note] of [
    ['knowledgeVerify', 'confirmed', "confirmed from loom's page"],
    ['knowledgeRecheck', 'stale', "asked to be checked again from loom's page"],
  ] as const) {
    const name = `mind.${verb}`;
    operations.register(operation({ name, write: true, input: z.object({ slug: z.string().min(1).max(200) }), output: z.unknown(),
      recover,
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', name),
      run(ctx, input) {
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
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
          const answer = options.verify(db, { slug: input.slug, outcome, note, verifier: ctx.viewer.id }, ctx.now);
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
      body: z.string().trim().min(1).max(64 * 1024), source: z.string().trim().max(4000).default('') }), output: z.unknown(), recover,
    may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', 'mind.knowledgeAdd'),
    run(ctx, input) {
      if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
      if (input.source && !/^https?:\/\//.test(input.source)) throw new OperationError('invalid', 'The source must be an http or https link, or empty');
      const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
      if (!slug) throw new OperationError('invalid', 'That title has nothing to make an address from');
      const receipt = ctx.receipt!;
      const answer = db.transaction(() => {
        db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(ctx.now);
        const replay = recover(ctx); if (replay) return replay;
        if (db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug)) throw new OperationError('conflict', 'Knowledge already has a page by that title');
        const at = new Date(ctx.now).toISOString(), sourcing = input.source ? 'sourced' : 'provisional';
        const inserted = db.prepare(`INSERT INTO pages(uuid,slug,title,domain,body,sourcing,verified_at,sla_class,created_by,author,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),slug,input.title,input.domain,input.body,sourcing,at,options.classify(input.domain),input.domain.startsWith('ours/') ? ctx.viewer.id : null,ctx.viewer.id,at,at);
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
  return { close() { db?.close(); } };
}
