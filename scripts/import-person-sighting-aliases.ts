// One-time move for the older Slack registry. Run with tsx from a Loom checkout.
// Arguments: DIRECTORY_DB REGISTRY_JSON WORKSPACE [--apply [APPROVED_ADDITIONS_JSON]]. Prints aggregate counts only.
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {legacySlackHolder} from '../src/backends/people-accounts.js';

const [directory,registryPath,workspace,mode,approvedPath,...extra]=process.argv.slice(2);
if(!directory||!registryPath||!/^T[A-Z0-9]+$/.test(workspace??'')||(mode!==undefined&&mode!=='--apply')||extra.length){
  throw Error('Expected DIRECTORY_DB REGISTRY_JSON WORKSPACE [--apply [APPROVED_ADDITIONS_JSON]]');
}
const registry=z.object({people:z.record(z.string(),z.object({slack:z.record(z.string(),z.array(z.string()))}))})
  .parse(JSON.parse(readFileSync(registryPath,'utf8')));
const owners=new Map<string,Set<string>>();
for(const [slug,person] of Object.entries(registry.people)){
  for(const account of person.slack[workspace]??[]){
    const existing=owners.get(account)??new Set<string>();
    existing.add(slug);
    owners.set(account,existing);
  }
}
const apply=mode==='--apply';
// Optional exact additive scope for a previously reviewed import. Each row is [workspace,account,slug].
const approved=approvedPath?z.array(z.tuple([z.string(),z.string(),z.string()]))
  .parse(JSON.parse(readFileSync(approvedPath,'utf8'))).filter(([space])=>space===workspace):undefined;
const db=new Database(directory,{fileMustExist:true,readonly:!apply});
try{
  const reconcile=db.transaction(()=>{
    const matches=new Map<string,string>();
    for(const [account,slugs] of owners){
      const slug=legacySlackHolder(db,workspace,account);
      if(slug&&slugs.size===1&&slugs.has(slug))matches.set(account,slug);
    }
    const present=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='person_sighting_aliases'").get();
    if(apply&&!present)throw Error('Upgrade the People database before applying aliases');
    const previous=present?db.prepare('SELECT account,slug FROM person_sighting_aliases WHERE workspace=?').all(workspace) as {account:string;slug:string}[]:[];
    const changed=previous.filter(row=>matches.get(row.account)!==row.slug);
    const additions=new Map(matches);
    for(const row of previous)if(matches.get(row.account)===row.slug)additions.delete(row.account);
    if(approved&&(changed.length||approved.length!==matches.size||
      new Set(approved.map(([,account])=>account)).size!==matches.size||
      approved.some(([,account,slug])=>matches.get(account)!==slug)))throw Error('The proposed matches differ from the reviewed additions');
    if(apply){
      const remove=db.prepare('DELETE FROM person_sighting_aliases WHERE workspace=? AND account=?');
      for(const row of changed)remove.run(workspace,row.account);
      const add=db.prepare('INSERT INTO person_sighting_aliases (workspace,account,slug) VALUES (?,?,?)');
      for(const [account,slug] of additions)add.run(workspace,account,slug);
    }
    return {matched:matches.size,remove:changed.length,add:additions.size,applied:apply};
  });
  console.log(JSON.stringify(apply?reconcile.immediate():reconcile()));
}finally{db.close();}
