/** Model-account page projection. Public coarse capacity and private detail
 * are separate generated batches; location joins never run once per account. */
import { and, asc, inArray, sql, type AnyColumn } from 'drizzle-orm';
import { rules, type Viewer } from '../../policy.js';
import { sqlHolds, sqlRule } from '../../policy-sql.js';
import type { DataDatabase } from './database.js';

/** An account's private detail is its member's and household owners'. Rendered after Drizzle's
 * alias pass over this relation, like every other policy filter. */
function privateAccount(viewer: Viewer, fields: Record<string, AnyColumn>) {
  const allowed = sqlRule(rules.ownedByMember('owner'), viewer, fields);
  return sql`${{ getSQL: () => allowed }}`;
}
export function readModelAccounts(db: DataDatabase, viewer: Viewer) {
  // Two rules, both policy.ts's: the summary (name and coarse level) and the private detail.
  const rows = !sqlHolds(db, rules.accountSummary, viewer) ? [] : db.query.modelAccounts.findMany({ columns: { id: true, label: true, hasRoom: true }, orderBy: f => asc(f.label),
    with: { modelAccountWindowsByAccount: { columns: { window: true, usage: true, usageReadAt: true, resetsAt: true, durationMs: true, reserve: true } } },
  }).sync();
  const privateRows = db.query.modelAccounts.findMany({ where: f => privateAccount(viewer, f),
    columns: { id: true, owner: true, provider: true, usage: true, usageReadAt: true, resetsAt: true },
    with: { modelAccountBoxesByAccount: { columns: {}, with: { boxRow: { columns: { id: true, name: true } } } },
      accountSigninsByAccount: {columns:{state:true},where:f=>inArray(f.state,['asked','started','waiting']),with:{boxRow:{columns:{id:true,name:true}}}},
      modelAccountLoginsByAccount: { columns: { harness: true, place: true, state: true, expiresAt: true, checkedAt: true, since: true, learnedFrom: true, why: true }, with: { boxRow: { columns: { id: true, name: true, owner: true, lastSeenAt: true, revokedAt: true } } } } },
  }).sync();
  const text = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return { rows, privateRows: new Map(privateRows.map(({ modelAccountBoxesByAccount, modelAccountLoginsByAccount, accountSigninsByAccount, ...row }) => [row.id,
    { ...row, pendingSignIns:accountSigninsByAccount.flatMap(request=>request.boxRow?[request.boxRow]:[]),
      // Each sign-in of the account loom has learned about: machine, harness and place, never a credential.
      logins: modelAccountLoginsByAccount.filter(login => login.boxRow).map(({ boxRow, ...login }) => ({ ...login, box: boxRow! }))
        .sort((a, b) => text(a.box.name, b.box.name) || text(a.box.id, b.box.id) || text(a.harness, b.harness) || text(a.place, b.place)),
      signedInOn: modelAccountBoxesByAccount.map(link => link.boxRow!).filter(Boolean).sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))) }])) };
}
/** One current-authority statement for every private account witnessed by a read. */
export function allowedModelAccounts(db: DataDatabase, viewer: Viewer, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  return new Set(db.query.modelAccounts.findMany({ columns: { id: true }, where: f => and(inArray(f.id, ids), privateAccount(viewer, f)) }).sync().map(row => row.id));
}

/** Coalesce the selected private columns in one execution turn. No authority
 * result is cached: a later direct column access gets a fresh batch. */
export function modelAccountAuthority(db: DataDatabase, viewer: Viewer) {
  let pending: { id: string; resolve(): void; reject(error: unknown): void }[] | undefined;
  return (id: string) => new Promise<void>((resolve, reject) => {
    if (!pending) {
      pending = [];
      queueMicrotask(() => {
        const reads = pending!; pending = undefined;
        try {
          const allowed = allowedModelAccounts(db, viewer, [...new Set(reads.map(read => read.id))]);
          for (const read of reads) { if (allowed.has(read.id)) read.resolve(); else read.reject(Error('Account access ended')); }
        } catch (error) { for (const read of reads) read.reject(error); }
      });
    }
    pending.push({ id, resolve, reject });
  });
}
