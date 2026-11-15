/** Fictional shared program for hosted Memory browser evidence. */
import Database,{type Database as NativeDatabase} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {Clock} from '../core/clock.js';
import type {DataDatabase} from '../core/data/database.js';
import type {MindSources} from '../pieces/mind/sources.js';
import {createDataSchema} from '../core/data/database.js';
import {agents,members,tokens,household} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
export interface MemoryFixture {app:Awaited<ReturnType<typeof serveShared>>;db:DataDatabase;client:NativeDatabase;sources:MindSources;signInPath():Promise<string>;close():Promise<void>}
export async function memorySharedFixture(options:{home:string;clock:Clock;webRoot:string;agents:string[];otherMembers?:string[]}):Promise<MemoryFixture>{
 const client=new Database(':memory:'),db=createDataSchema(client),at=new Date(options.clock.now()).toISOString(),bearer='f'.repeat(64);
 db.insert(members).values([{id:'owner',role:'owner' as const,joinedAt:at},...(options.otherMembers??[]).map(id=>({id,role:'member' as const,joinedAt:at}))]).run();
 db.insert(agents).values(options.agents.map(id=>({id,about:'',markBg:'',markFg:'',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(household).values({singleton:1,defaultAgent:options.agents[0],timezone:'America/Chicago'}).run();
 db.insert(tokens).values({fingerprint:createHash('sha256').update(bearer).digest('hex'),label:'Fictional browser',kind:'owner',member:'owner',createdAt:at}).run();
 const commons=join(options.home,'commons'),sources={commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:options.agents.map(agent=>{const directory=join(options.home,'agents',agent);return {agent,directory,memories:join(directory,'memories.db')};})};
 try{
  const app=await serveShared({db,clock:options.clock,webRoot:options.webRoot,memory:{sources,checkingAgent:options.agents[0]},originAllowed:req=>{try{return new URL(String(req.headers.origin)).host===req.headers.host;}catch{return false;}},reportError:()=>{}});
  let closing:Promise<void>|undefined;
  return {app,db,client,sources,async signInPath(){const response=await app.http.request(app.url+'/api/signin/link',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({input:{}})});if(response.status!==200)throw Error('Fictional sign-in link failed');return (await response.json()).value.path as string;},close(){return closing??=(async()=>{try{await app.close();}finally{client.close();}})();}};
 }catch(error){client.close();throw error;}
}
