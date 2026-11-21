import Database from 'better-sqlite3';
import { constants, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ownHome } from '../core/daemon-home.js';
import { dataDatabase, dataSchemaNumber, recogniseDataSchema } from '../core/data/database.js';
import { privateBytes } from '../pieces/secrets/local-holder.js';
import { readKey, wordsKey } from '../pieces/comms/crypto.js';
import { importArchivedQuestions } from '../core/conversations/archived-question-store.js';
import { importThreads, UnresolvedArchiveThread } from '../core/conversations/import-threads.js';
export async function migrateComms(phase:'archived-questions'|'comms-threads', args:string[],io:{stdout(text:string):void;stderr(text:string):void}) {
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
    const tmp=mkdtempSync(join(tmpdir(),'loom-question-archive-'));clean.push(()=>rmSync(tmp,{recursive:true,force:true}));
    const copySnapshot=(name:string)=>{
      const file=join(source,name),copy=join(tmp,name);
      if(!lstatSync(file).isFile()||realpathSync(file)===target)throw Error('source must be a separate snapshot');
      // This phase consumes completed SQLite backups. A nonempty journal means the snapshot step is incomplete.
      for(const suffix of ['-wal','-journal'])if(existsSync(file+suffix)&&lstatSync(file+suffix).size)throw Error('snapshot needs its journal');
      copyFileSync(file,copy,constants.COPYFILE_EXCL);
      const db=new Database(copy,{readonly:true,fileMustExist:true});clean.push(()=>{db.close();});return db;
    };
    const household=copySnapshot('household.db');
    const client=new Database(target,{fileMustExist:true});clean.push(()=>{client.close();});
    if(recogniseDataSchema(client)!==dataSchemaNumber)throw Error('upgrade the staged database first');
    client.pragma('foreign_keys = ON');
    if(phase==='comms-threads'){
      const result=importThreads(household,dataDatabase(client));
      io.stdout(`Imported ${result.inserted} of ${result.total} Comms threads (new deletion records: ${result.tombstones}).\n`);return 0;
    }
    const sourceConfig=z.object({comms_days:z.number().int().min(1).max(14).default(14)}).parse(JSON.parse(
      // The archive is a stopped v1 household; its ordinary household.json need not be mode 0600.
      readFileSync(join(source,'household.json'),'utf8')));
    const identity=readKey(program.commsKey);
    if(identity!==readKey(join(source,'comms.key')))throw Error('the prepared home needs its original Comms key');
    const archive=copySnapshot('comms.db');
    const result=await importArchivedQuestions({archive,household,destination:dataDatabase(client),key:wordsKey(identity),
      sourceDays:sourceConfig.comms_days,now:()=>new Date().toISOString()});
    io.stdout(`Imported ${result.inserted} of ${result.total} archived questions.\n`);return 0;
  }catch(error){
    if(error instanceof UnresolvedArchiveThread){io.stderr(error.message+'\n');return 1;}
    io.stderr(`Could not import ${phase==='comms-threads'?'Comms threads':'archived questions'}. Check that the archive contains completed SQLite backups, the prepared home is stopped and current, and the key and thread identities match.\n`);return 1;
  }finally{for(const close of clean.reverse())await close();}
}
