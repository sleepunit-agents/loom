import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { closeSync, constants, fstatSync, openSync, readSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArchiveReader } from '../core/conversations/archive-reader.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { COMMS_DAYS_MAX } from '../core/data/comms-days.js';
import { ownHome } from '../core/daemon-home.js';
import { dataDatabase, dataSchemaNumber, recogniseDataSchema } from '../core/data/database.js';
import { privateBytes } from '../pieces/secrets/local-holder.js';
import { readKey, wordsKey } from '../pieces/comms/crypto.js';
import { importTextHistory } from '../core/conversations/import-text-history.js';
import { importArchivedQuestions } from '../core/conversations/archived-question-store.js';
import { householdId } from '../slug.js';
import { legacyThreadLookup } from '../core/conversations/legacy-thread-id.js';
import { pendingThreadDeletions } from '../core/conversations/archive-deletions.js';
import { importThreads, UnresolvedArchiveThread } from '../core/conversations/import-threads.js';
export async function migrateComms(phase:'comms'|'archived-questions'|'comms-threads'|'comms-text'|'comms-cards', args:string[],io:{stdout(text:string):void;stderr(text:string):void}) {
  const usage=`loom migrate ${phase} --source STOPPED_ARCHIVE --home PREPARED_HOME`;
  let source:string,home:string;
  try{
    const {values}=parseArgs({args,strict:true,allowPositionals:false,options:{source:{type:'string'},home:{type:'string'}}});
    if(!values.source||!values.home)throw Error();
    source=realpathSync(values.source);home=realpathSync(values.home);
  }catch{io.stderr(usage+'\n');return 2;}
  const clean:Array<()=>void|Promise<void>>=[];
  try {
    if(source===home)throw Error('overlapping source');
    clean.push(await ownHome(home));
    const program=z.object({database:z.string(),commsKey:z.string()}).parse(JSON.parse(privateBytes(join(home,'program.json')).toString()));
    const target=realpathSync(program.database);
    if(dirname(target)!==home)throw Error('use a staged database in its own home');
    const openSnapshot=(name:string): ArchiveReader=>{
      const file=join(source,name);
      if(realpathSync(file)!==file)throw Error('source snapshot path must be a regular archive path');
      if(!lstatSync(file).isFile()||realpathSync(file)===target)throw Error('source must be a separate snapshot');
      // This phase consumes completed SQLite backups. A nonempty journal means the snapshot step is incomplete.
      if(existsSync(file+'-wal')&&lstatSync(file+'-wal').size)throw Error('snapshot needs its WAL');
      const journal=file+'-journal';
      if(existsSync(journal)){
        const fd=openSync(journal,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const stat=fstatSync(fd),header=Buffer.alloc(Math.min(stat.size,28));
          // PERSIST clears its 28-byte header on commit; journal_size_limit may truncate it further.
          if(!stat.isFile()||(stat.size && (readSync(fd,header)!==header.length||header.some(byte=>byte!==0))))
            throw Error('snapshot needs rollback recovery');
        } finally {closeSync(fd);}
      }
      // This archive is a completed, stopped backup. Immutable mode reads WAL-format
      // database headers without creating sidecars or a second copy of private records.
      const uri=pathToFileURL(file);
      uri.searchParams.set('immutable','1');
      const db=new DatabaseSync(uri.href,{readOnly:true});
      clean.push(()=>db.close());
      return {readonly:true,prepare:sql=>db.prepare(sql)};
    };
    const household=openSnapshot('household.db');
    const client=new Database(target,{fileMustExist:true});clean.push(()=>{client.close();});
    if(recogniseDataSchema(client)!==dataSchemaNumber)throw Error('upgrade the staged database first');
    client.pragma('foreign_keys = ON');
    const reports:string[]=[];
    const restoreThreads=()=>{
      const agents=new Map<string,ArchiveReader>();
      const agentSnapshot=(agent:string)=>{
        const held=agents.get(agent);
        if(held)return held;
        const snapshot=openSnapshot(join('agents',householdId.parse(agent),'memories.db'));
        agents.set(agent,snapshot);
        return snapshot;
      };
      const recover=legacyThreadLookup(agentSnapshot,
        ()=>privateBytes(join(source,'comms.salt'),32));
      const result=importThreads(household,dataDatabase(client),recover,(agent,id)=>agentSnapshot(agent)
        .prepare('SELECT started,last FROM conversations WHERE agent=? AND id=?').get(agent,id) as {started:string;last:string}|undefined);
      reports.push(`Imported ${result.inserted} of ${result.total} Comms threads (new deletion records: ${result.tombstones}).\n`);
    }
    if(phase==='comms-threads'){restoreThreads();io.stdout(reports.join(''));return 0;}
    const sourceConfig=z.object({github:z.unknown().optional(),comms_days:z.number().int().min(1).max(COMMS_DAYS_MAX).default(14)}).parse(JSON.parse(
      // The archive is a stopped v1 household; its ordinary household.json need not be mode 0600.
      readFileSync(join(source,'household.json'),'utf8')));
    const identity=readKey(program.commsKey);
    if(identity!==readKey(join(source,'comms.key')))throw Error('the prepared home needs its original Comms key');
    const archive=openSnapshot('comms.db');
    const input={archive,household,destination:dataDatabase(client),key:wordsKey(identity),
      sourceDays:sourceConfig.comms_days,github:phase==='comms'||phase==='comms-text'?z.string().regex(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/i).nullish().parse(sourceConfig.github)??undefined:undefined,now:()=>new Date().toISOString()};
    if (phase === 'comms') {
      const removed = pendingThreadDeletions(household, input.destination);
      const unsupported = archive.prepare("SELECT DISTINCT thread FROM comms_messages WHERE kind IS NULL OR kind NOT IN ('message','reply','card','error')").all().map(row=>(row as {thread:unknown}).thread);
      if (unsupported.some(thread => typeof thread !== 'string' || !removed.has(thread))) {
        io.stderr('This archive contains Comms message kinds the combined importer cannot restore yet.\n');
        return 1;
      }
    }
    const phases = phase === 'comms' ? ['comms-text', 'comms-cards', 'comms-notices', 'archived-questions'] as const : [phase];
    const history = {
      'comms-text': {kind:'text', label:'Comms text messages'},
      'comms-cards': {kind:'cards', label:'Comms tool cards'},
      'comms-notices': {kind:'notices', label:'Comms notices'},
    } as const;
    // Each importer uses a nested SQLite savepoint. Keep the outer transaction
    // across asynchronous envelope reads and publish reports only after commit.
    client.exec('BEGIN IMMEDIATE');
    try {
      if (phase === 'comms') restoreThreads();
      for (const part of phases) {
        const result = part === 'archived-questions'
          ? await importArchivedQuestions(input)
          : await importTextHistory({ ...input, kind: history[part].kind });
        const label=part === 'archived-questions' ? 'archived questions' : history[part].label;
        reports.push(`Imported ${result.inserted} of ${result.total} ${label}.\n`);
      }
      client.exec('COMMIT');
    } catch (error) {
      if(client.inTransaction) client.exec('ROLLBACK');
      throw error;
    }
    io.stdout(reports.join(''));
    return 0;
  }catch(error){
    if(error instanceof UnresolvedArchiveThread){io.stderr(error.message+'\n');return 1;}
    io.stderr(`Could not import ${phase==='comms'?'Comms history':phase==='comms-threads'?'Comms threads':phase==='comms-cards'?'Comms tool cards':phase==='comms-text'?'Comms text history':'archived questions'}. Check that the archive contains completed SQLite backups, the prepared home is stopped and current, and the key and thread identities match.\n`);return 1;
  }finally{for(const close of clean.reverse())await close();}
}
