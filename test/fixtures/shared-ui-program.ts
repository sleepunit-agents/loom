/** Fictional prepared home using the same startup constructor as normal serve. */
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDataSchema,type DataDatabase} from '../../src/core/data/database.js';
import {members} from '../../src/core/data/schema.js';
import type {Clock} from '../../src/core/clock.js';
import {startSharedHome} from '../../src/shared-startup.js';
export async function sharedUiProgram(options:{clock:Clock;webRoot?:string;seed(db:DataDatabase,now:()=>string):void}){
 const home=mkdtempSync(join(tmpdir(),'loom-shared-ui-fiction-')),database=join(home,'app.db'),now=()=>new Date(options.clock.now()).toISOString();
 const previous=new Map(['LOOM_WORKER_SOCKET','LOOM_PUBLIC_URL'].map(name=>[name,process.env[name]]));
 for(const name of previous.keys())delete process.env[name];
 let seedConnection:Database.Database|undefined;
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined,closing:Promise<void>|undefined;
 const restore=()=>{for(const [name,value]of previous)if(value===undefined)delete process.env[name];else process.env[name]=value;};
 const close=()=>closing??=(async()=>{try{await app?.close();}finally{if(seedConnection?.open)seedConnection.close();rmSync(home,{recursive:true,force:true});restore();}})();
 try{
  seedConnection=new Database(database);
  const seeded=createDataSchema(seedConnection,now);options.seed(seeded,now);
  let owner=seeded.select().from(members).all().find(member=>member.role==='owner')?.id;
  if(!owner)throw Error('Fixture must explicitly seed its sign-in owner');
  seedConnection.close();
  const identity=await generateX25519Identity(),commsKey=join(home,'comms.key');writeFileSync(commsKey,identity,{mode:0o600});
  const webRoot=options.webRoot??join(home,'public');if(!options.webRoot){mkdirSync(webRoot);for(const file of ['index.html','next.html'])writeFileSync(join(webRoot,file),'<main>FICTIONAL SHARED PROGRAM</main>');}
  const commonsDirectory=join(home,'commons'),agentDirectory=join(home,'agents','art'),program={database,commsKey,signinMember:owner,webRoot,memory:{checkingAgent:'art',sources:{commons:{directory:commonsDirectory,knowledge:join(commonsDirectory,'knowledge.db'),people:join(commonsDirectory,'people.db')},agents:[{agent:'art',directory:agentDirectory,memories:join(agentDirectory,'memories.db')}]}}};
  writeFileSync(join(home,'program.json'),JSON.stringify(program),{mode:0o600});
  const printed:string[]=[],errors:unknown[]=[];
  app=await startSharedHome({home,clock:options.clock,host:'127.0.0.1',port:0,stdout:text=>printed.push(text),reportError:error=>errors.push(error)});
  const db=app.services.comms!.db;
  // Normal startup uses better-sqlite3; expose its same live connection for fixture writes.
  return {home,url:app.url,composition:app,db,client:db.$client as Database.Database,printed,errors,close};
 }catch(error){await close();throw error;}
}
