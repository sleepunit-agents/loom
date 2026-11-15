/** Default web startup from an explicit, already prepared shared household.
 * No importer, discovery, schema upgrade, or legacy database fallback. */
import Database from 'better-sqlite3';
import {createHash,randomBytes} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
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
import {readKey,wordsKey} from './pieces/comms/crypto.js';
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
 let bytes:Buffer|undefined;
 const program=(()=>{try{bytes=privateBytes(options.program??join(home,'program.json'));return programSchema.parse(JSON.parse(bytes.toString('utf8')));}finally{bytes?.fill(0);}})();
 checkDatabase(program.database);
 const commsKey=wordsKey(readKey(program.commsKey));
 prepareOperatorHome(home);
 const release=await ownHome(home);
 let client:Database.Database|undefined,app:Awaited<ReturnType<typeof serveShared>>|undefined,operator:Awaited<ReturnType<typeof listenOperatorLinks>>|undefined;
 let closing:Promise<void>|undefined,adapters:SharedStartupAdapters={};
 const close=()=>closing??=(async()=>{try{await operator?.close();}finally{try{await app?.close();}finally{try{await adapters.close?.();}finally{try{client?.close();}finally{await release();}}}}})();
 try{
  client=new Database(program.database,{fileMustExist:true});client.pragma('foreign_keys = ON');
  const db=dataDatabase(client,()=>new Date(clock.now()).toISOString());
  if(db.select().from(members).where(eq(members.id,program.signinMember)).get()?.role!=='owner')throw Error('Configure an existing household owner for local sign-in');
  if(program.adapters){const module=await import(pathToFileURL(program.adapters).href);if(typeof module.default!=='function')throw Error('Shared adapters must export a factory');adapters=await (module.default as SharedStartupFactory)({db,clock,home});}
  app=await serveShared({db,clock,memory:program.memory,commsKey,
   originAllowed:sameOrigin,publicOrigin:relyingParty(process.env)?.origin,
   changes:adapters.changes,workAnswerAuthority:adapters.workAnswerAuthority,
   tempo:{...adapters.tempo,...(program.repository?{repository:program.repository}:{})},
   secretWrites:adapters.secretWrites,secretInputs:adapters.secretInputs,bridges:adapters.bridges,modelRoles:adapters.modelRoles,runtimeJobEnded:adapters.runtimeJobEnded,
   reportError:options.reportError??(()=>{}),host:options.host,port:options.port,webRoot:options.webRoot??program.webRoot??resolve(import.meta.dirname,'../dist/web'),
  });
  const signin=sharedSigninLinks(db,clock);
  const issue=({member,label,ttl}:{member:string;label:string;ttl:number})=>app!.writes.run(()=>{
   if(!db.select().from(members).where(eq(members.id,member)).get())throw Error('Unknown member');
   const id=fingerprint(randomBytes(32).toString('hex'));
   // Token labels are globally unique while active. Separate local issuances
   // must not collide or reuse another person's similarly labelled token.
   db.insert(tokens).values({fingerprint:id,label:`${label.slice(0,120)} [local ${id}]`,kind:'owner',member,createdAt:new Date(clock.now()).toISOString()}).run();
   const link=signin.makeLink(id);
   if(ttl<300)db.update(signinLinks).set({expiresAt:new Date(clock.now()+ttl*1000).toISOString()}).where(eq(signinLinks.id,fingerprint(link.path.slice('/login/'.length)))).run();
   return link.path;
  }).value;
  operator=await listenOperatorLinks(home,app.url,issue);
  (options.stdout??(text=>{process.stdout.write(text);}))(`${app.url}${issue({member:program.signinMember,label:'Local startup sign-in',ttl:300})}\n`);
  return {...app,close};
 }catch(error){await close();throw error;}
}
