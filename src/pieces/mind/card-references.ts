/** Private card names never become shared receipt IDs. The map stays in the
 * declared agent source; reads resolve it only after current visibility checks. */
import type {Database} from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
type Kind='person'|'project';
export function opaqueCardReference(db:Database,kind:Kind,slug:string){
 if(!db.inTransaction)throw Error('Card reference requires its source transaction');
 const prior=db.prepare('SELECT uuid FROM memory_card_references WHERE kind=? AND slug=?').get(kind,slug) as {uuid:string}|undefined;
 const uuid=prior?.uuid??randomUUID();
 if(!prior)db.prepare('INSERT INTO memory_card_references(uuid,kind,slug) VALUES(?,?,?)').run(uuid,kind,slug);
 return `${kind}:${uuid}`;
}
export function resolveCardReference(db:Database,kind:Kind,reference:string){
 if(!reference.startsWith(kind+':')||!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_card_references'").get())return reference;
 const row=db.prepare('SELECT slug FROM memory_card_references WHERE kind=? AND uuid=?').get(kind,reference.slice(kind.length+1)) as {slug:string}|undefined;
 return row?.slug??reference;
}
