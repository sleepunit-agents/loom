import type { Db } from '../../core/index.js';
import { empty, type State, type Approval, type Rule, type Standing } from './model.js';
export const ruleId = (r: Rule | Standing) => 'id' in r ? r.id : `${r.person ? `grant:${r.person}:` : 'rule:'}${r.kind}:${r.scope}`;
export function load(db: Db): State {
  const rows = <T>(table: string) => (db.prepare(`SELECT record FROM approvals_${table} ORDER BY rowid`).all() as {record:string}[]).map(r => JSON.parse(r.record) as T);
  const s = empty(); s.approvals = rows('approvals'); s.notices = rows('notices'); s.audit = rows('audit');
  for (const r of rows<Rule | Standing>('rules')) if ('id' in r) s.standing.push(r); else if (r.person !== undefined) s.grants.push(r); else s.rules.push(r);
  return s;
}
/** Registry and offline importer own the transaction. Receipt history is never trimmed. */
export function persist(db: Db, s: State, now: number): {type:string;id:string}[] {
  const changes: {type:string;id:string}[] = [];
  const sync = (table: string, records: {id:string;record: unknown}[], type: string) => {
    const old = new Map((db.prepare(`SELECT id,record FROM approvals_${table}`).all() as {id:string;record:string}[]).map(r => [r.id,r.record]));
    for (const r of records) {
      const json = JSON.stringify(r.record);
      if (old.get(r.id) !== json) {
        if (table === 'approvals') db.prepare('INSERT INTO approvals_approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,changed_at=excluded.changed_at').run(r.id,json,now);
        else db.prepare('INSERT INTO approvals_rules VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(r.id,json);
        changes.push({type,id:r.id});
      }
      old.delete(r.id);
    }
    for (const id of old.keys()) { db.prepare(`DELETE FROM approvals_${table} WHERE id=?`).run(id); changes.push({type,id}); }
  };
  sync('approvals',s.approvals.map(a => ({id:a.id,record:a})),'approval');
  sync('rules',[...s.rules,...s.grants,...s.standing].map(r => ({id:ruleId(r),record:r})),'approval-rule');
  for (const table of ['notices','audit'] as const) {
    const held = db.prepare(`SELECT count(*) AS n FROM approvals_${table}`).get() as {n:number};
    const rows = s[table];
    if (JSON.stringify((db.prepare(`SELECT record FROM approvals_${table} ORDER BY id`).all() as {record:string}[]).map(r => JSON.parse(r.record))) !== JSON.stringify(rows)) {
      // Notices are bounded and prepend; the append-only audit never rewrites prior entries.
      if (table === 'notices') { db.exec('DELETE FROM approvals_notices'); rows.forEach((r,i) => db.prepare('INSERT INTO approvals_notices VALUES (?,?)').run(i,JSON.stringify(r))); }
      else { if (held.n > rows.length) throw Error('Audit cannot shrink');
        const prefix = (db.prepare('SELECT record FROM approvals_audit ORDER BY id').all() as {record:string}[]).map(r => JSON.parse(r.record));
        if (JSON.stringify(prefix) !== JSON.stringify(rows.slice(0, held.n))) throw Error('Audit history cannot change');
        rows.slice(held.n).forEach(r => db.prepare('INSERT INTO approvals_audit(record) VALUES (?)').run(JSON.stringify(r))); }
    }
  }
  return changes;
}
export function readApproval(db: Db, id: string): Approval | undefined { const row = db.prepare('SELECT record FROM approvals_approvals WHERE id=?').get(id) as {record:string}|undefined; return row ? JSON.parse(row.record) : undefined; }
