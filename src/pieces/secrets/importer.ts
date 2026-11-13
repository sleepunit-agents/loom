/** Explicit offline import. Caller owns the stopped-home gate. */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, type Db } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { schema } from './schema/001.js';
import { schema as attentionSchema } from '../attention/schema/001.js';
import { assertSeparateSecretPaths, canonicalSecretImport, readSecretImport, type SecretImportOptions } from './import-source.js';
export { readSecretImport } from './import-source.js';

export function importSecrets(db: Db, home: string, from: string, now: number, options: SecretImportOptions,
  hooks: {interrupt?:()=>void}={}) {
  try {
    if(db.name && db.name!==':memory:') {
      const source=realpathSync(from),target=realpathSync(dirname(db.name));
      assertSeparateSecretPaths(source,target);
    }
    return db.transaction(()=>{
    const h=new HouseholdDatabase(db).household(home);
    if(!h)throw Error();
    const expected=readSecretImport(from,now,options,{agents:h.agents,members:h.members.map(m=>m.person)});
    migrate(db,'secrets',schema); migrate(db,'attention',attentionSchema);
    const get=(key:string)=>(db.prepare('SELECT value FROM secrets_meta WHERE key=?').get(key) as {value:string}|undefined)?.value;
    if(get('source-checksum')) {
      if(get('source-checksum')!==expected.checksum || get('source-options')!==expected.options)throw Error();
      return {imported:false,checksum:expected.checksum,names:expected.records.length,requests:expected.requests.length,grants:expected.grants.length};
    }
    for(const table of ['secrets_names','secrets_requests','secrets_grants','secrets_changes','secrets_uses','secrets_meta'])
      if(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw Error();
    for(const ask of expected.asks)if(db.prepare('SELECT 1 FROM attention_asks WHERE id=?').get(ask.id))throw Error();
    const insert=(table:string,records:{id:string}[])=>{for(const r of records)db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run(r.id,JSON.stringify(r));};
    insert('secrets_names',expected.records);insert('secrets_requests',expected.requests);insert('secrets_changes',expected.changes);insert('attention_asks',expected.asks);
    for(const g of expected.grants)db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run(g.id,g.agent,g.kind,g.target,JSON.stringify(g));
    for(const u of expected.uses)db.prepare('INSERT INTO secrets_uses VALUES (?,?,?)').run(u.id,u.name,JSON.stringify(u));
    db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('policy',JSON.stringify(expected.policy));
    db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('legacy-snapshot',JSON.stringify(expected.legacy));
    hooks.interrupt?.();
    const check=(table:string,records:unknown[])=>{
      const actual=(db.prepare(`SELECT record FROM ${table} ORDER BY id`).all() as {record:string}[]).map(r=>JSON.parse(r.record));
      const sorted=(r:unknown[])=>r.map(canonicalSecretImport).sort();
      if(canonicalSecretImport(sorted(actual))!==canonicalSecretImport(sorted(records)))throw Error();
    };
    check('secrets_names',expected.records);check('secrets_requests',expected.requests);check('secrets_grants',expected.grants);check('secrets_changes',expected.changes);check('secrets_uses',expected.uses);
    for(const a of expected.asks) {
      const row=db.prepare('SELECT record FROM attention_asks WHERE id=?').get(a.id) as {record:string}|undefined;
      if(!row || canonicalSecretImport(JSON.parse(row.record))!==canonicalSecretImport(a))throw Error();
    }
    if(canonicalSecretImport(JSON.parse(get('policy')!))!==canonicalSecretImport(expected.policy)||canonicalSecretImport(JSON.parse(get('legacy-snapshot')!))!==canonicalSecretImport(expected.legacy))throw Error();
    db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('source-checksum',expected.checksum);
    db.prepare('INSERT INTO secrets_meta VALUES (?,?)').run('source-options',expected.options);
    return {imported:true,checksum:expected.checksum,names:expected.records.length,requests:expected.requests.length,grants:expected.grants.length};
  })(); } catch { throw Error('Secrets import refused'); }
}
