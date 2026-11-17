import {startSharedHolder} from './shared-holder-process.js';
import {githubBindingNames} from './pieces/changes/secrets.js';
import { notificationKey } from './core/signin/notification-key.js';
/** Default web startup from an explicit, already prepared shared household.
 * No importer, discovery, or legacy database fallback. A household database this
 * program recognises is brought up to its schema number; any other is refused. */
import Database from 'better-sqlite3';
import {initializeSharedHome} from './shared-initialize.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {constants,openSync,closeSync,fsyncSync,realpathSync} from 'node:fs';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {clock as systemClock,type Clock} from './core/clock.js';
import {dataDatabase,recogniseDataSchema,upgradeDataSchema,type DataDatabase} from './core/data/database.js';
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
const githubBindings=z.record(z.string(),z.string()).refine(value=>{try{githubBindingNames(value);return true;}catch{return false;}},'Invalid GitHub credential bindings');
const programSchema=z.object({
 githubBindings:githubBindings.optional(),
 secretHolder:z.literal(true).optional(),database:path,commsKey:path,signinMember:z.string().min(1),webRoot:path.optional(),repository:path.optional(),adapters:path.optional(),
 memory:z.object({checkingAgent:z.string().min(1),sources:z.object({
  commons:z.object({directory:path,knowledge:path,people:path}).strict(),
  agents:z.array(z.object({agent:z.string().min(1),directory:path,memories:path}).strict()),
 }).strict()}).strict(),
}).strict();
type RootOptions=Parameters<typeof sharedRoot>[0];
/** A trusted local module supplies existing outside-service ports. No request
 * or database row chooses code, credentials, checking agent, or source paths. */
export type SharedStartupAdapters=Pick<RootOptions,'changes'|'tempo'|'secretWrites'|'secretInputs'|'bridges'|'modelRoles'|'runtimeJobEnded'|'approvedOperations'|'memoryEmbedding'>&{close?():void|Promise<void>};
export type SharedStartupFactory=(context:{db:DataDatabase;clock:Clock;home:string})=>SharedStartupAdapters|Promise<SharedStartupAdapters>;
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Read-only, before anything is opened for writing: this must be a household database this program
 * knows, at this schema number or an earlier one it can upgrade. Anything else, including an interim or
 * hand-altered schema, is refused with its bytes untouched and belongs to the separate real-data move. */
function recogniseDatabase(file:string){
 const current=new Database(file,{readonly:true,fileMustExist:true});
 try{recogniseDataSchema(current);}finally{current.close();}
}
export async function startSharedHome(options:{home:string;program?:string;host?:string;port?:number;webRoot?:string;clock?:Clock;stdout?(text:string):void;reportError?(error:unknown):void}){
 const home=resolve(options.home),clock=options.clock??systemClock;
 if(!options.program)await initializeSharedHome(home,clock);
 const config=options.program??join(home,'program.json');
 let bytes:Buffer|undefined;
 const program=(()=>{try{bytes=privateBytes(config);return programSchema.parse(JSON.parse(bytes.toString('utf8')));}finally{bytes?.fill(0);}})();
 const webRoot=resolve(options.webRoot??program.webRoot??resolve(import.meta.dirname,'../dist/web'));
 const canonical=(path:string):string=>{try{return realpathSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=resolve(path,'..');if(parent===path)throw error;return resolve(canonical(parent),relative(parent,path));}};
 const inside=(parent:string,child:string)=>{const part=relative(canonical(resolve(parent)),canonical(resolve(child)));return !part||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
 const directories=[...(program.secretHolder?[join(home,'secret-holder')]:[]),program.memory.sources.commons.directory,...program.memory.sources.agents.map(source=>source.directory)];
 const files=[config,program.database,program.commsKey,program.adapters,...[program.memory.sources.commons.knowledge,program.memory.sources.commons.people,...program.memory.sources.agents.map(source=>source.memories)]];
 if(directories.some(directory=>inside(webRoot,directory)||inside(directory,webRoot))||files.some(file=>file&&inside(webRoot,file)))throw Error('Public assets overlap private household files');
 recogniseDatabase(program.database);
 readKey(program.commsKey);
 const commsKey:WordsKey={seal:value=>wordsKey(readKey(program.commsKey)).seal(value),open:value=>wordsKey(readKey(program.commsKey)).open(value),hash:value=>wordsKey(readKey(program.commsKey)).hash(value)};
 prepareOperatorHome(home);
 const release=await ownHome(home);
 let client:Database.Database|undefined,app:Awaited<ReturnType<typeof serveShared>>|undefined,operator:Awaited<ReturnType<typeof listenOperatorLinks>>|undefined;
 let holder:Awaited<ReturnType<typeof startSharedHolder>>|undefined;
 let closing:Promise<void>|undefined,adapters:SharedStartupAdapters={};
 const close=()=>closing??=(async()=>{try{await operator?.close();}finally{try{const pending=app?.close();try{await holder?.close();}finally{await pending;}}finally{try{await adapters.close?.();}finally{try{client?.close();}finally{await release();}}}}})();
 try{
  // First-install publication must be durable before the holder writes values.
  const parent=openSync(dirname(realpathSync(home)),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(parent);}finally{closeSync(parent);}
  client=new Database(program.database,{fileMustExist:true});client.pragma('foreign_keys = ON');
  // Recognised again under the write lock, then upgraded; see upgradeDataSchema.
  upgradeDataSchema(client,()=>new Date(clock.now()).toISOString());
  const db=dataDatabase(client,()=>new Date(clock.now()).toISOString());
  if(db.select().from(members).where(eq(members.id,program.signinMember)).get()?.role!=='owner')throw Error('Configure an existing household owner for local sign-in');
  if(program.adapters){privateBytes(program.adapters).fill(0);const module=await import(pathToFileURL(program.adapters).href);if(typeof module.default!=='function')throw Error('Shared adapters must export a factory');adapters=await (module.default as SharedStartupFactory)({db,clock,home});}
  if(program.secretHolder){
   if(adapters.secretWrites||adapters.secretInputs)throw Error('Shared Secret holder ports already configured');
   holder=await startSharedHolder(join(realpathSync(home),'secret-holder'),clock);
  }
  const configuredBridges=adapters.bridges;
  const bridges:RootOptions['bridges']=configuredBridges?{
   source:configuredBridges.source,effectsAllowed:()=>!closing&&configuredBridges.effectsAllowed(),
   request:configuredBridges.request,discord:configuredBridges.discord,slack:configuredBridges.slack,
   inboxCommitted:ids=>configuredBridges.inboxCommitted?.(ids),
  }:holder?{source:holder.source,effectsAllowed:()=>!closing}:undefined;
  const source=adapters.secretInputs?.source??holder?.source;
  let changes=adapters.changes;
  if(!changes&&program.githubBindings){
   if(!source)throw Error('GitHub credential source unavailable');
   changes={github:{source,bindings:program.githubBindings,
    request:async(...args)=>{if(closing)throw Error('GitHub read unavailable');return fetch(...args);},
   }};
  }
  const publicOrigin=relyingParty(process.env)?.origin;
  app=await serveShared({db,clock,memory:program.memory,commsKey,notifications:{vapid:notificationKey(home)},
   originAllowed:sameOrigin,publicOrigin,
   changes,
   tempo:{...adapters.tempo,...(program.repository?{repository:program.repository}:{})},
   secretWrites:adapters.secretWrites??(holder?{holder:holder.holder,fingerprintKey:holder.fingerprintKey}:undefined),secretInputs:adapters.secretInputs??(holder?{source:holder.source}:undefined),bridges,modelRoles:adapters.modelRoles,runtimeJobEnded:adapters.runtimeJobEnded,approvedOperations:adapters.approvedOperations,memoryEmbedding:adapters.memoryEmbedding,
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
