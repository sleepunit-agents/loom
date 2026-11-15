import { notificationKey } from './core/signin/notification-key.js';
/** Default web startup from an explicit, already prepared shared household.
 * No importer, discovery, schema upgrade, or legacy database fallback. */
import Database from 'better-sqlite3';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {clock as systemClock,type Clock} from './core/clock.js';
import {createDataSchema,dataDatabase,type DataDatabase} from './core/data/database.js';
import {members,tokens,signinLinks} from './core/data/schema.js';
import {ownHome} from './core/daemon-home.js';
import {prepareOperatorHome,listenOperatorLinks} from './core/signin/operator.js';
import {sameOrigin,relyingParty} from './core/signin/index.js';
import {sharedSigninLinks} from './core/signin/shared-links.js';
import {privateBytes} from './pieces/secrets/local-holder.js';
import {readKey,wordsKey,type WordsKey} from './pieces/comms/crypto.js';
import {serveShared} from './shared-serve.js';
import type {sharedRoot} from './shared-root.js';
const path=z.string().refine(isAbsolute,'Use an absolute path');
const programSchema=z.object({
 database:path,commsKey:path,signinMember:z.string().min(1),webRoot:path.optional(),repository:path.optional(),adapters:path.optional(),
 memory:z.object({checkingAgent:z.string().min(1),sources:z.object({
  commons:z.object({directory:path,knowledge:path,people:path}).strict(),
  agents:z.array(z.object({agent:z.string().min(1),directory:path,memories:path}).strict()),
 }).strict()}).strict(),
}).strict();
type RootOptions=Parameters<typeof sharedRoot>[0];
/** A trusted local module supplies existing outside-service ports. No request
 * or database row chooses code, credentials, checking agent, or source paths. */
export type SharedStartupAdapters=Pick<RootOptions,'changes'|'workAnswerAuthority'|'tempo'|'secretWrites'|'secretInputs'|'bridges'|'modelRoles'|'runtimeJobEnded'>&{close?():void|Promise<void>};
export type SharedStartupFactory=(context:{db:DataDatabase;clock:Clock;home:string})=>SharedStartupAdapters|Promise<SharedStartupAdapters>;
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
function schema(client:Database.Database){return client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();}
/** Read-only validation happens before opening the writable connection. A
 * different or interim schema belongs to the separate real-data move. */
function checkDatabase(file:string){
 const current=new Database(file,{readonly:true,fileMustExist:true}),expected=new Database(':memory:');
 try{createDataSchema(expected);if(JSON.stringify(schema(current))!==JSON.stringify(schema(expected)))throw Error('Shared startup requires the prepared shared schema; existing data needs its separate move');}
 finally{current.close();expected.close();}
}
export async function startSharedHome(options:{home:string;program?:string;host?:string;port?:number;webRoot?:string;clock?:Clock;stdout?(text:string):void;reportError?(error:unknown):void}){
 const home=resolve(options.home),clock=options.clock??systemClock;
 const config=options.program??join(home,'program.json');
 let bytes:Buffer|undefined;
 const program=(()=>{try{bytes=privateBytes(config);return programSchema.parse(JSON.parse(bytes.toString('utf8')));}finally{bytes?.fill(0);}})();
 const webRoot=resolve(options.webRoot??program.webRoot??resolve(import.meta.dirname,'../dist/web'));
 const canonical=(path:string):string=>{try{return realpathSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=resolve(path,'..');if(parent===path)throw error;return resolve(canonical(parent),relative(parent,path));}};
 const inside=(parent:string,child:string)=>{const part=relative(canonical(resolve(parent)),canonical(resolve(child)));return !part||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
 const directories=[program.memory.sources.commons.directory,...program.memory.sources.agents.map(source=>source.directory)];
 const files=[config,program.database,program.commsKey,program.adapters,...[program.memory.sources.commons.knowledge,program.memory.sources.commons.people,...program.memory.sources.agents.map(source=>source.memories)]];
 if(directories.some(directory=>inside(webRoot,directory)||inside(directory,webRoot))||files.some(file=>file&&inside(webRoot,file)))throw Error('Public assets overlap private household files');
 checkDatabase(program.database);
 readKey(program.commsKey);
 const commsKey:WordsKey={seal:value=>wordsKey(readKey(program.commsKey)).seal(value),open:value=>wordsKey(readKey(program.commsKey)).open(value),hash:value=>wordsKey(readKey(program.commsKey)).hash(value)};
 prepareOperatorHome(home);
 const release=await ownHome(home);
 let client:Database.Database|undefined,app:Awaited<ReturnType<typeof serveShared>>|undefined,operator:Awaited<ReturnType<typeof listenOperatorLinks>>|undefined;
 let closing:Promise<void>|undefined,adapters:SharedStartupAdapters={};
 const close=()=>closing??=(async()=>{try{await operator?.close();}finally{try{await app?.close();}finally{try{await adapters.close?.();}finally{try{client?.close();}finally{await release();}}}}})();
 try{
  client=new Database(program.database,{fileMustExist:true});client.pragma('foreign_keys = ON');
  const db=dataDatabase(client,()=>new Date(clock.now()).toISOString());
  if(db.select().from(members).where(eq(members.id,program.signinMember)).get()?.role!=='owner')throw Error('Configure an existing household owner for local sign-in');
  if(program.adapters){privateBytes(program.adapters).fill(0);const module=await import(pathToFileURL(program.adapters).href);if(typeof module.default!=='function')throw Error('Shared adapters must export a factory');adapters=await (module.default as SharedStartupFactory)({db,clock,home});}
  const publicOrigin=relyingParty(process.env)?.origin;
  app=await serveShared({db,clock,memory:program.memory,commsKey,notifications:{vapid:notificationKey(home)},
   originAllowed:sameOrigin,publicOrigin,
   changes:adapters.changes,workAnswerAuthority:adapters.workAnswerAuthority,
   tempo:{...adapters.tempo,...(program.repository?{repository:program.repository}:{})},
   secretWrites:adapters.secretWrites,secretInputs:adapters.secretInputs,bridges:adapters.bridges,modelRoles:adapters.modelRoles,runtimeJobEnded:adapters.runtimeJobEnded,
   reportError:options.reportError??(()=>{}),host:options.host,port:options.port,webRoot,
  });
  const signin=sharedSigninLinks(db,clock);
  const issue=({member,label,ttl,ownerOnly=false}:{member:string;label:string;ttl:number;ownerOnly?:boolean})=>app!.writes.run(()=>{
   const current=db.select().from(members).where(eq(members.id,member)).get();
   if(!current||ownerOnly&&current.role!=='owner')throw Error('Local sign-in member is no longer allowed');
   const id=fingerprint(randomBytes(32).toString('hex'));
   // Token labels are globally unique while active. Separate local issuances
   // must not collide or reuse another person's similarly labelled token.
   db.insert(tokens).values({fingerprint:id,label:`${label.slice(0,150)} [local ${randomUUID()}]`,kind:'owner',member,createdAt:new Date(clock.now()).toISOString()}).run();
   const link=signin.makeLink(id);
   if(ttl<300)db.update(signinLinks).set({expiresAt:new Date(clock.now()+ttl*1000).toISOString()}).where(eq(signinLinks.id,fingerprint(link.path.slice('/login/'.length)))).run();
   return link.path;
  }).value;
  operator=await listenOperatorLinks(home,publicOrigin??app.url,issue);
  (options.stdout??(text=>{process.stdout.write(text);}))(`${publicOrigin??app.url}${issue({member:program.signinMember,label:'Local startup sign-in',ttl:300,ownerOnly:true})}\n`);
  return {...app,close};
 }catch(error){await close();throw error;}
}
