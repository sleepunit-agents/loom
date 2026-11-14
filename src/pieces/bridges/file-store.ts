/** Private storage seam only. Runtime must issue both trusted permits before
 * composition may wire this to intake or a body. No caller-selected paths. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../core/index.js';
import { SLACK_FILE_BYTES, SLACK_FILES_PER_MESSAGE, type SlackFilesPermit, type FetchedSlackFile } from './slack-files.js';
export const BRIDGE_FILE_RETENTION = 14 * 86400_000;
const word=z.string().min(1).max(1000);
const scopeSchema=z.object({agent:word,venue:word,workspace:word,channel:word});
const fileId=z.string().regex(/^F[A-Z0-9]{2,30}$/);
const descriptor=z.object({id:fileId,name:z.string().max(4096),size:z.number().int().min(0).max(SLACK_FILE_BYTES),url:z.string().max(8192)}).strict();
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const safeName=(name:string)=>name.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,80).replace(/^[._]+/,'')||'file';
const held=()=>Error('Bridge file unavailable');
interface Scope {readonly agent:string;readonly venue:string;readonly workspace:string;readonly channel:string}
/** Trusted Runtime proof for an exact file delivered to an authenticated active
 * body. current() owns authentication, job/conversation, delivery and policy
 * revocation. This interface creates no authority and has no production issuer. */
export interface BridgeFileReadPermit extends Scope {
  readonly delivery:string; readonly job:string; readonly file:string;
  current():boolean;
}
const scopeKey=(p:Scope)=>JSON.stringify(scopeSchema.parse(p));
const tick=(now:()=>number)=>{const n=now();if(!Number.isSafeInteger(n)||n<0)throw held();return n;};
interface Row {name:string;bytes:Buffer;digest:string;created:number}
export function bridgeFileStore(db:Db, now:()=>number) {
  const pruneAt=(at:number)=>{
    db.prepare('DELETE FROM bridges_files WHERE created<=?').run(at-BRIDGE_FILE_RETENTION);
    db.prepare('DELETE FROM bridges_file_deliveries WHERE created<=?').run(at-BRIDGE_FILE_RETENTION);
  };
  return {
    /** Atomic batch save. Dedup never overwrites bytes or refreshes their age.
     * Caller owns fetched buffers; this method neither consumes nor erases them.
     * Platform fetch orchestration (including fetch-once) is not installed. */
    save(permit:SlackFilesPermit, fetched:readonly FetchedSlackFile[]):void {
      try {
        const scope=scopeKey(permit),delivery=word.parse(permit.delivery);
        const files=z.array(descriptor).max(SLACK_FILES_PER_MESSAGE).parse(permit.files.slice(0,SLACK_FILES_PER_MESSAGE));
        if(new Set(files.map(f=>f.id)).size!==files.length||fetched.length!==files.length)throw held();
        const manifest=hash(JSON.stringify(files));
        const current=()=>permit.current()&&scopeKey(permit)===scope&&permit.delivery===delivery
          &&hash(JSON.stringify(permit.files.slice(0,SLACK_FILES_PER_MESSAGE)))===manifest;
        if(!current())throw held();
        db.transaction(()=>{
          const at=tick(now);pruneAt(at);
          const before=db.prepare('SELECT manifest FROM bridges_file_deliveries WHERE scope=? AND delivery=?').get(scope,delivery) as {manifest:string}|undefined;
          if(before&&before.manifest!==manifest)throw held();
          db.prepare('INSERT OR IGNORE INTO bridges_file_deliveries VALUES (?,?,?,?)').run(scope,delivery,manifest,at);
          for(let i=0;i<files.length;i++){
            const f=files[i],got=fetched[i];
            if(got.id!==f.id||got.name!==safeName(f.name)||!Buffer.isBuffer(got.bytes)||got.bytes.length>SLACK_FILE_BYTES)throw held();
            const digest=hash(got.bytes);
            const old=db.prepare('SELECT name,digest FROM bridges_files WHERE scope=? AND file=?').get(scope,f.id) as {name:string;digest:string}|undefined;
            if(old&&(old.digest!==digest||old.name!==got.name))throw held();
            db.prepare('INSERT OR IGNORE INTO bridges_files VALUES (?,?,?,?,?,?)').run(scope,f.id,got.name,got.bytes,digest,at);
            db.prepare('INSERT OR IGNORE INTO bridges_file_sources VALUES (?,?,?)').run(scope,delivery,f.id);
          }
          if(!current())throw held();
        })();
      }catch{throw held();}
    },
    /** Returns a new owned buffer only after current exact Runtime proof. Never
     * returns source deliveries, URLs, paths or bytes through registry receipts. */
    read(permit:BridgeFileReadPermit):{name:string;bytes:Buffer;sha256:string} {
      let owned:Buffer|undefined;
      try {
        const scope=scopeKey(permit),delivery=word.parse(permit.delivery),job=word.parse(permit.job),file=fileId.parse(permit.file);
        const current=()=>permit.current()&&scopeKey(permit)===scope&&permit.delivery===delivery&&permit.job===job&&permit.file===file;
        if(!current())throw held();
        const at=tick(now);
        const row=db.prepare(`SELECT f.name,f.bytes,f.digest,f.created FROM bridges_files f
          JOIN bridges_file_sources s ON s.scope=f.scope AND s.file=f.file
          JOIN bridges_file_deliveries d ON d.scope=s.scope AND d.delivery=s.delivery
          WHERE f.scope=? AND f.file=? AND s.delivery=? AND f.created>? AND d.created>?`).get(scope,file,delivery,at-BRIDGE_FILE_RETENTION,at-BRIDGE_FILE_RETENTION) as Row|undefined;
        if(!row)throw held();
        owned=row.bytes;
        if(!Buffer.isBuffer(owned)||owned.length>SLACK_FILE_BYTES||hash(owned)!==row.digest||!current()
          ||tick(now)>=row.created+BRIDGE_FILE_RETENTION)throw held();
        return {name:row.name,bytes:owned,sha256:row.digest};
      }catch{owned?.fill(0);throw held();}
    },
    /** Logical SQLite expiry only, not forensic erasure of backups/WAL. The
     * daemon job remains pending; reads enforce expiry even without pruning. */
    prune():void {try{db.transaction(()=>pruneAt(tick(now)))();}catch{throw held();}},
  };
}
