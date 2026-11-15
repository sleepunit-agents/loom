/** First install only. Build privately beside the requested empty home, then
 * publish the complete directory atomically. Never roll back user pathnames. */
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,lstatSync,readdirSync,mkdirSync,mkdtempSync,renameSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {userInfo} from 'node:os';
import type {Clock} from './core/clock.js';
import {assertHomeReady} from './core/home-state.js';
import {ownHome} from './core/daemon-home.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,memberAgents,household} from './core/data/schema.js';
export async function initializeSharedHome(home:string,clock:Clock){
 const config=join(home,'program.json');
 try{lstatSync(config);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
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
  const at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>at),username=userInfo().username;
  const member=/^[a-z0-9]+(-[a-z0-9]+)*$/.test(username)?username:'owner';
  db.transaction(()=>{
   db.insert(members).values({id:member,role:'owner',fullOwner:true,joinedAt:at}).run();
   db.insert(agents).values({id:'assistant',about:'Help with the work you are given.',markBg:'#313244',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
   db.insert(memberAgents).values({member,agent:'assistant'}).run();db.insert(household).values({defaultAgent:'assistant'}).run();
  });
  client.close();client=undefined;
  const key=Buffer.from(await generateX25519Identity()+'\n');try{publish('comms.key',key);}finally{key.fill(0);}
  const commons=join(home,'commons'),agent=join(home,'agents/assistant');
  const program={database:join(home,'loom.db'),commsKey:join(home,'comms.key'),signinMember:member,memory:{checkingAgent:'assistant',sources:{
   commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},
   agents:[{agent:'assistant',directory:agent,memories:join(agent,'memories.db')}],
  }}};
  publish('program.json',Buffer.from(JSON.stringify(program)+'\n'));
  // rename cannot replace a nonempty directory. A concurrent writer in home
  // makes publication fail without moving, unlinking or relinking its entries.
  // Failed private stages stay unpublished; retry still sees an empty home.
  renameSync(stage,home);
 }finally{try{if(client?.open)client.close();}finally{await release();}}
}
