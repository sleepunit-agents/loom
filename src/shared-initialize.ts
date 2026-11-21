/** First install only. Build privately beside the requested empty home, then
 * publish the complete directory atomically. Never roll back user pathnames. */
import Database from 'better-sqlite3';
import {householdService,memberInput} from './apps/household.js';
import {loadKey} from './pieces/comms/crypto.js';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,lstatSync,readdirSync,mkdirSync,mkdtempSync,renameSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {userInfo} from 'node:os';
import type {Clock} from './core/clock.js';
import {assertHomeReady} from './core/home-state.js';
import {ownHome} from './core/daemon-home.js';
import {createDataSchema} from './core/data/database.js';
export interface InitialHousehold {
 defaultAgent:string;
 populate(service:ReturnType<typeof householdService>):void;
 commsIdentity?:string;
}
export async function initializeSharedHome(home:string,clock:Clock,fromArchive?:InitialHousehold){
 const config=join(home,'program.json');
 try{lstatSync(config);if(fromArchive)throw Error('Migration requires an empty destination');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 assertHomeReady(home);mkdirSync(home,{recursive:true,mode:0o700});
 const release=await ownHome(home);let client:Database.Database|undefined;
 try{
  if(readdirSync(home).length)throw Error('A nonempty home needs its separate data move or an explicit prepared program');
  const stage=mkdtempSync(join(dirname(home),'.'+basename(home)+'.initializing-'));
  const publish=(name:string,bytes:Uint8Array)=>{
   const fd=openSync(join(stage,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  };
  publish('loom.db',new Uint8Array());client=new Database(join(stage,'loom.db'));client.pragma('journal_mode = WAL');
  const at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>at),service=householdService(db,()=>at);
  // Through the household service, so the first member and agent meet the same rules as every later one.
  db.transaction(()=>{
   if(fromArchive){fromArchive.populate(service);return;}
   // A fresh installation names its first owner after the OS user when that name is valid.
   const username=userInfo().username,member=memberInput.shape.id.safeParse(username).success?username:'owner';
   service.setAgent({id:'assistant',about:'Help with the work you are given.',markBg:'#313244',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'});
   service.setMember({id:member,role:'owner',fullOwner:true,agents:[]});service.initialize('assistant');
  });
  client.close();client=undefined;
  if(fromArchive?.commsIdentity)publish('comms.key',Buffer.from(fromArchive.commsIdentity+'\n'));
  else await loadKey(stage);
  // Where things are, and nothing about who is in the household: the first owner and agent are rows above,
  // and sign-in and Memory read them from there (shared-startup.ts).
  const commons=join(home,'commons');
  const program={secretHolder:true,database:join(home,'loom.db'),commsKey:join(home,'comms.key'),memory:{checkingAgent:fromArchive?.defaultAgent??'assistant',sources:{
   commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},
  }}};
  publish('program.json',Buffer.from(JSON.stringify(program)+'\n'));
  // rename cannot replace a nonempty directory. A concurrent writer in home
  // makes publication fail without moving, unlinking or relinking its entries.
  // Failed private stages stay unpublished; retry still sees an empty home.
  renameSync(stage,home);
 }finally{try{if(client?.open)client.close();}finally{await release();}}
}
