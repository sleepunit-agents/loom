import {startSharedHolder} from './shared-holder-process.js';
import {githubBindingNames} from './pieces/changes/secrets.js';
import { notificationKey } from './core/signin/notification-key.js';
/** Default web startup from an explicit, already prepared shared household.
 * No importer, discovery, schema upgrade, or legacy database fallback. */
import Database from 'better-sqlite3';
import {initializeSharedHome} from './shared-initialize.js';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {constants,openSync,closeSync,fsyncSync,realpathSync} from 'node:fs';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {clock as systemClock,type Clock} from './core/clock.js';
import {createDataSchema,dataDatabase, upgradeDataSchema,type DataDatabase} from './core/data/database.js';
import {members,tokens} from './core/data/schema.js';
import {tokenLive} from './core/data/authentication.js';
import {sharedTokens} from './core/signin/shared-tokens.js';
import {ownHome} from './core/daemon-home.js';
import {prepareOperatorHome,listenOperatorLinks,type operatorRequest} from './core/signin/operator.js';
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
/** The shape that matters: every table with its columns, and every index, trigger and view as written.
 * A table's own SQL text is not compared, because a column added to an existing household by an upgrade
 * is written differently from the same column in a fresh database. */
function schema(client:Database.Database){
 const objects=client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string;tbl_name:string;sql:string|null}[];
 return objects.map(object=>object.type==='table'
  ?{type:object.type,name:object.name,columns:(client.prepare('SELECT name,type,"notnull" AS required,dflt_value AS fallback,pk FROM pragma_table_info(?) ORDER BY name').all(object.name))}
  :object);
}
/** Read-only, before anything is opened for writing: this must be a household database this program
 * knows. Anything else is refused with its bytes untouched. */
function recogniseDatabase(file:string){
 const current=new Database(file,{readonly:true,fileMustExist:true});
 try{
  const known=current.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migrations'").get()&&(current.prepare('SELECT max(number) AS number FROM migrations').get() as {number:number|null}).number;
  if(!known)throw Error('Shared startup requires the prepared shared schema; existing data needs its separate move');
 }finally{current.close();}
}
/** After any upgrade. A different or interim schema belongs to the separate real-data move. */
function checkDatabase(current:Database.Database){
 const expected=new Database(':memory:');
 try{createDataSchema(expected);if(JSON.stringify(schema(current))!==JSON.stringify(schema(expected)))throw Error('Shared startup requires the prepared shared schema; existing data needs its separate move');}
 finally{expected.close();}
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
  upgradeDataSchema(client,()=>new Date(clock.now()).toISOString());
  checkDatabase(client);
  const db=dataDatabase(client,()=>new Date(clock.now()).toISOString());
  // The member a local sign-in is for when the operator names nobody: a current owner of the household.
  const localOwner=()=>{const row=db.select().from(members).where(eq(members.id,program.signinMember)).get();return row?.role==='owner'&&!row.removedAt;};
  if(!localOwner())throw Error('Configure an existing household owner for local sign-in');
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
  const signin=sharedSigninLinks(db,clock),issuer=sharedTokens(db,clock);
  // Adapters ran since the first check and may have changed the household.
  if(!localOwner())throw Error('Local sign-in member is no longer allowed');
  // Every local sign-in of one member rides on one token row, made by the same service as any other token
  // so its rules hold here too. Nobody is ever given that row's bearer: it only anchors the browsers and
  // passkeys that came in through a local link, and revoking it in Setup ends them all.
  const localToken=(member:string)=>{
   const label='Local sign-in: '+(member.length<=100?member:`${member.slice(0,60)} ${createHash('sha256').update(member).digest('hex').slice(0,16)}`);
   const found=db.select().from(tokens).where(and(eq(tokens.label,label),eq(tokens.kind,'owner'),eq(tokens.member,member))).all().find(row=>tokenLive(row,clock.now()));
   return found?.fingerprint??issuer.issue({kind:'owner',member,label}).fingerprint;
  };
  /** A sign-in link for whoever can reach the operator socket: the OS user who owns this home. */
  const issue=({member,label,ttl}:z.infer<typeof operatorRequest>)=>app!.writes.run(()=>{
   if(member===undefined&&!localOwner())throw Error('Local sign-in member is no longer allowed');
   return signin.makeLink(localToken(member??program.signinMember),{label,ttlMs:ttl*1000}).path;
  }).value;
  operator=await listenOperatorLinks(home,publicOrigin??app.url,issue);
  // No link is made or printed at start: under a service manager this output is the log. The operator asks
  // for one when they want it.
  (options.stdout??(text=>{process.stdout.write(text);}))(`To sign in from this machine: loom signin --home ${home}\n`);
  /** For the code that started this program in its own process: the link the operator socket would give. */
  const signinLink=(member?:string)=>`${publicOrigin??app!.url}${issue({request:'link',label:'Local sign-in',ttl:300,...(member?{member}:{})})}`;
  return {...app,close,signinLink};
 }catch(error){await close();throw error;}
}
