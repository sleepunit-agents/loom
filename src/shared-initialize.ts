/** First install only. Prepared inventories belong to shared-startup; existing
 * homes belong to the separate data move and are never inferred or converted. */
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {constants,openSync,closeSync,fstatSync,writeFileSync,fsyncSync,lstatSync,unlinkSync,readdirSync,mkdirSync,mkdtempSync,renameSync,linkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
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
 const release=await ownHome(home),created=new Map<string,{dev:number;ino:number}>();
 let client:Database.Database|undefined;
 const publish=(name:string,bytes:Uint8Array)=>{
  const path=join(home,name),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{const stat=fstatSync(fd);created.set(path,{dev:stat.dev,ino:stat.ino});writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 };
 try{
  // Recheck after acquiring ownership; never overwrite another startup's work.
  if(readdirSync(home).length)throw Error('A nonempty home needs its separate data move or an explicit prepared program');
  publish('loom.db',new Uint8Array());
  client=new Database(join(home,'loom.db'));client.pragma('journal_mode = WAL');
  const at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>at),username=userInfo().username;
  const member=/^[a-z0-9]+(-[a-z0-9]+)*$/.test(username)?username:'owner';
  db.transaction(()=>{
   db.insert(members).values({id:member,role:'owner',fullOwner:true,joinedAt:at}).run();
   db.insert(agents).values({id:'assistant',about:'Help with the work you are given.',markBg:'#313244',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
   db.insert(memberAgents).values({member,agent:'assistant'}).run();
   db.insert(household).values({defaultAgent:'assistant'}).run();
  });
  client.close();client=undefined;
  const key=Buffer.from(await generateX25519Identity()+'\n');try{publish('comms.key',key);}finally{key.fill(0);}
  const commons=join(home,'commons'),agent=join(home,'agents/assistant');
  const program={database:join(home,'loom.db'),commsKey:join(home,'comms.key'),signinMember:member,memory:{checkingAgent:'assistant',sources:{
   commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},
   agents:[{agent:'assistant',directory:agent,memories:join(agent,'memories.db')}],
  }}};
  publish('program.json',Buffer.from(JSON.stringify(program)+'\n'));
 }catch(error){
  // No listener or caller has been admitted. Roll back only this attempt's
  // unpublished generated files, preserving replacements and all prior data.
  if(client?.open)client.close();client=undefined;
  let quarantine:string|undefined;
  if(created.size)try{
   quarantine=mkdtempSync(join(home,'.shared-init-rollback-'));
   let index=0;
   for(const [path,owned] of [...created].reverse())try{
    const claimed=join(quarantine,String(index++));
    // Claim the directory entry atomically before inspecting it. A writer at
    // the original path can no longer substitute the target of our deletion.
    renameSync(path,claimed);
    const stat=lstatSync(claimed);
    if(stat.isFile()&&stat.dev===owned.dev&&stat.ino===owned.ino)unlinkSync(claimed);
    else{
     // Restore a foreign entry only without clobbering a newer original path.
     // Keep the quarantined entry too: it is not ours to delete, even if the
     // restored name is subsequently replaced. Directories remain retained.
     try{linkSync(claimed,path);}catch{/* Both entries remain preserved. */}
    }
   }catch{/* Preserve ambiguous state. */}
  }catch{/* Cleanup failure never authorizes deleting an unknown entry. */}
  if(quarantine)try{rmdirSync(quarantine);}catch{/* Retained foreign entries. */}
  throw error;
 }finally{try{if(client?.open)client.close();}finally{await release();}}
}
