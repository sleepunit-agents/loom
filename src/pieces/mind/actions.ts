/** Knowledge's two page actions; source effects and retry receipts commit together. */
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { operation, mayAct, OperationError, type Operations, type Sharing } from '../../core/index.js';
/** Composition supplies the synchronous shared store primitive, without a piece
 * importing the old backend or initializing any of its schema.
 */
export interface KnowledgeActionResult { verified: number; slugs: string[]; verified_at: string; stamped: boolean; noted: boolean }
export type KnowledgeVerifier = (db: BetterSqlite3.Database, input: { slug: string; outcome: 'confirmed' | 'stale'; note: string; verifier: string }, now: number) => KnowledgeActionResult;

/** Opt-in alongside the read installer. Never creates a missing content store.
 * The sole added table holds retry metadata/results, never page bodies or notes.
 * DDL, verification and receipt insertion share one immediate source transaction.
 */
export function installMindKnowledgeActions(operations: Operations, options: { path: string; sharing(): Sharing; verify: KnowledgeVerifier }) {
  const db = existsSync(options.path) ? new BetterSqlite3(options.path, { fileMustExist: true, timeout: 0 }) : undefined;
  for (const [verb, outcome, note] of [
    ['knowledgeVerify', 'confirmed', "confirmed from loom's page"],
    ['knowledgeRecheck', 'stale', "asked to be checked again from loom's page"],
  ] as const) {
    const name = `mind.${verb}`;
    operations.register(operation({ name, write: true, input: z.object({ slug: z.string().min(1).max(200) }), output: z.unknown(),
      may: viewer => mayAct(viewer, { type: 'knowledge' }, options.sharing(), 'act', name),
      run(ctx, input) {
        if (!db) throw new OperationError('not-found', 'Knowledge store is absent');
        const receipt = ctx.receipt;
        if (!receipt) throw new Error('Knowledge writes require a retry identity');
        const result = db.transaction(() => {
          db.exec(`CREATE TABLE IF NOT EXISTS mind_operation_receipts (
            viewer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input_hash TEXT NOT NULL,
            result TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(viewer,id))`);
          db.prepare('DELETE FROM mind_operation_receipts WHERE expires <= ?').run(ctx.now);
          const prior = db.prepare('SELECT name, input_hash, result FROM mind_operation_receipts WHERE viewer = ? AND id = ?')
            .get(receipt.viewer, receipt.id) as { name: string; input_hash: string; result: string } | undefined;
          if (prior) {
            if (prior.name !== receipt.name || prior.input_hash !== receipt.inputHash) throw new OperationError('conflict', 'Operation id already used for different input');
            return JSON.parse(prior.result) as KnowledgeActionResult;
          }
          const page = db.prepare('SELECT status FROM pages WHERE slug = ?').get(input.slug) as { status: string } | undefined;
          if (!page) throw new OperationError('not-found', 'Knowledge page not found');
          if (page.status === 'archived') throw new OperationError('conflict', 'Restore the page before checking it');
          const answer = options.verify(db, { slug: input.slug, outcome, note, verifier: ctx.viewer.id }, ctx.now);
          db.prepare('INSERT INTO mind_operation_receipts VALUES (?, ?, ?, ?, ?, ?)')
            .run(receipt.viewer, receipt.id, receipt.name, receipt.inputHash, JSON.stringify(answer), receipt.expires);
          return answer;
        }).immediate();
        // Replaying after a failed core receipt also repairs missed live publication.
        for (const slug of result.slugs) ctx.changed('knowledge', slug);
        return result;
      },
    }));
  }
  return { close() { db?.close(); } };
}
