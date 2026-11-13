import type { Db } from '../../core/index.js';
import type { Change } from './model.js';
export const loadChanges = (db: Db): Change[] => (db.prepare('SELECT record FROM changes_changes ORDER BY id').all() as {record:string}[]).map(r=>JSON.parse(r.record));
export function replaceChanges(db: Db, changes: Change[]): string[] {
 const before = new Map(loadChanges(db).map(c=>[c.id,JSON.stringify(c)])), after = new Map(changes.map(c=>[c.id,JSON.stringify(c)]));
 if(after.size!==changes.length) throw new Error('Duplicate change ids');
 const changed:string[]=[];
 for(const [id,record] of before) if(after.get(id)!==record) changed.push(id);
 for(const c of changes) if(before.get(c.id)!==JSON.stringify(c)) { if(!before.has(c.id)) changed.push(c.id); db.prepare('INSERT INTO changes_changes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,record=excluded.record').run(c.id,c.repo,JSON.stringify(c)); }
 for(const id of before.keys()) if(!after.has(id)) db.prepare('DELETE FROM changes_changes WHERE id=?').run(id);
 return changed;
}
export const canonical = (value: unknown): string => {
 if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if(value && typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
 return JSON.stringify(value);
};
