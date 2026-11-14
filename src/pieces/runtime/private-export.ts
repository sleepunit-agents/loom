/** Runtime owns its downstream copies; no read of Clock's tables or saved Viewer. */
import { privateExportCopy, registerExportFilter, type Db } from '../../core/index.js';

export function privateRuntimeExport(db: Db) {
 const jobs=new Set<string>(),conversations=new Set<string>(),sources=new Set<string>();
 const records=(table:string)=>db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
 for(const row of records('runtime_clock_turns'))if(privateExportCopy(row,new Set())){
  jobs.add(String(row.job));conversations.add(String(row.conversation));sources.add(String(row.id));
 }
 for(const row of records('runtime_jobs')){
  const record=JSON.parse(String(row.record));if(record.member!==undefined)jobs.add(String(row.id));
 }
 for(const row of records('runtime_bindings')){
  const record=JSON.parse(String(row.record));if(record.member!==undefined){conversations.add(String(row.id));if(record.job)jobs.add(record.job);}
 }
 // A private turn taints its whole correlated conversation, even if a current
 // summary was cleared or a later job replaced it. Never export partial history.
 let changed=true;
 while(changed){
  const before=jobs.size+conversations.size+sources.size;
  for(const row of records('runtime_jobs')){
   const record=JSON.parse(String(row.record));
   if(jobs.has(String(row.id))||conversations.has(record.conversation)){
    jobs.add(String(row.id));if(record.conversation)conversations.add(record.conversation);
   }
  }
  for(const row of records('runtime_clock_turns'))if(jobs.has(String(row.job))||conversations.has(String(row.conversation))){
   jobs.add(String(row.job));conversations.add(String(row.conversation));sources.add(String(row.id));
  }
  changed=before!==jobs.size+conversations.size+sources.size;
 }
 const ids=new Set([...jobs,...conversations,...sources]);
 const reference=(value:unknown,field?:string):boolean=>{
  if(typeof value==='string'){
   if(['record','result','value'].includes(field??'')){try{return reference(JSON.parse(value));}catch{return false;}}
   if(['text','brief','title','note','details'].includes(field??''))return false;
   if(ids.has(value))return true;
   if(field==='key')return [...sources].some(id=>value.startsWith(`${id}:person:`));
  }
  return !!value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>reference(v,k));
 };
 const effect=(id:string)=>[...jobs].some(job=>id===`runtime:input:${job}`||id.startsWith(`runtime:clock-read:${job}:`))
  ||[...sources].some(source=>id===`runtime:clock-native:${source}`);
 return {jobs,excludes(table:string,row:Record<string,unknown>){
  if(table==='core_effects')return effect(String(row.id));
  if(!table.startsWith('runtime_')&&table!=='core_operations')return false;
  // Older ACK receipts have no private scope or source identity. Drop both
  // wordless completion caches, including public ACKs, rather than inventing
  // ownership for historical receipts or restoring them as execution evidence.
  if(table==='core_operations'&&['runtime.acknowledgeClockInput','runtime.completeClockExecution'].includes(String(row.name)))return true;
  if(table==='core_operations'&&row.name==='core.releaseEffect'){
   const result=JSON.parse(String(row.result));if(effect(String(result?.value?.id)))return true;
  }
  return reference(row)||privateExportCopy(row,new Set());
 }};
}
export function installPrivateRuntimeExport(db:Db){
 registerExportFilter(db,'runtime', (table,row)=>{
  if(!table.startsWith('runtime_')&&!['core_operations','core_effects'].includes(table))return true;
  return !privateRuntimeExport(db).excludes(table,row);
 });
}
