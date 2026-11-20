import {startSharedHolder} from './shared-holder-process.js';
import {githubBindingNames} from './pieces/changes/secrets.js';
import { notificationKey } from './core/signin/notification-key.js';
/** Default web startup from an explicit, already prepared shared household.
 * No importer, discovery, or legacy database fallback. A household database this
 * program recognises is brought up to its schema number; any other is refused. */
import Database from 'better-sqlite3';
import {initializeSharedHome} from './shared-initialize.js';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {constants,openSync,closeSync,fsyncSync,realpathSync} from 'node:fs';
import {and,asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {clock as systemClock,type Clock} from './core/clock.js';
import {dataDatabase,recogniseDataSchema,upgradeDataSchema,type DataDatabase} from './core/data/database.js';
import {members,tokens} from './core/data/schema.js';
import {householdMemorySources} from './shared-memory.js';
import {householdOwner} from './shared-sharing.js';
import {tokenLive} from './core/data/authentication.js';
import {sharedTokens} from './core/signin/shared-tokens.js';
import {ownHome} from './core/daemon-home.js';
import {prepareOperatorHome,listenOperatorLinks,type operatorRequest} from './core/signin/operator.js';
import {sameIncomingOrigin} from './core/data/origin.js';
import {relyingParty} from './core/signin/webauthn.js';
import {sharedSigninLinks} from './core/signin/shared-links.js';
import {LINK_MS} from './core/signin/link-lifetime.js';
import {privateBytes} from './pieces/secrets/local-holder.js';
import {readKey,wordsKey,type WordsKey} from './pieces/comms/crypto.js';
import {serveShared} from './shared-serve.js';
import {StartupRefusal} from './core/startup-refusal.js';
import type {sharedRoot} from './shared-root.js';
const path=z.string().refine(isAbsolute,'Use an absolute path');
const githubBindings=z.record(z.string(),z.string()).refine(value=>{try{githubBindingNames(value);return true;}catch{return false;}},'Invalid GitHub credential bindings');
/** Where the household's files are, and what this installation is given. Who is in the household is not
 * here: members, owners and agents are rows in the household database and are read from it.
 *
 * A program.json written by an earlier build also names a member for local sign-in (`signinMember`) and
 * lists each agent's files (`memory.sources.agents`). Both are still accepted so that file keeps working,
 * and neither decides anything: local sign-in is for a current household owner, and an agent's files are
 * in `<home>/agents/<its id>` for every agent in the `agents` table. */
const programSchema=z.object({
 githubBindings:githubBindings.optional(),
 secretHolder:z.literal(true).optional(),database:path,commsKey:path,signinMember:z.string().optional(),webRoot:path.optional(),repository:path.optional(),adapters:path.optional(),
 memory:z.object({checkingAgent:z.string().min(1),alternateCheckingAgent:z.string().min(1).optional(),sources:z.object({
  commons:z.object({directory:path,knowledge:path,people:path}).strict(),
  agents:z.array(z.object({agent:z.string().min(1),directory:path,memories:path}).strict()).optional(),
 }).strict()}).strict(),
}).strict();
export {StartupRefusal};
/** Every agent's Memory directory is in here, named after the agent. */
export const agentsDirectory=(home:string)=>join(home,'agents');
type RootOptions=Parameters<typeof sharedRoot>[0];
/** A trusted local module supplies existing outside-service ports. No request
 * or database row chooses code, credentials, checking agent, or source paths. */
export type SharedStartupAdapters=Pick<RootOptions,'changes'|'tempo'|'secretWrites'|'secretInputs'|'bridges'|'modelRoles'|'runtimeJobEnded'|'approvedOperations'|'memoryEmbedding'>&{close?():void|Promise<void>};
export type SharedStartupFactory=(context:{db:DataDatabase;clock:Clock;home:string})=>SharedStartupAdapters|Promise<SharedStartupAdapters>;
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
 const commons=program.memory.sources.commons,agentFiles=agentsDirectory(home);
 // An earlier program.json could place an agent's files anywhere. They are now found by the one rule, so a
 // file that places them elsewhere is refused: starting would open an empty Memory beside the real one.
 // Compared as the files they are, so a home reached through a link is not taken for another place.
 for(const old of program.memory.sources.agents??[])if(canonical(old.directory)!==canonical(join(agentFiles,old.agent))||canonical(old.memories)!==canonical(join(agentFiles,old.agent,'memories.db')))
  throw new StartupRefusal(`program.json places agent ${old.agent}'s Memory outside ${agentFiles}. Move that directory to ${join(agentFiles,old.agent)}, or take the agent out of memory.sources.agents if its files are already there.`);
 const directories=[...(program.secretHolder?[join(home,'secret-holder')]:[]),commons.directory,agentFiles];
 const files=[config,program.database,program.commsKey,program.adapters,commons.knowledge,commons.people];
 if(directories.some(directory=>inside(webRoot,directory)||inside(directory,webRoot))||files.some(file=>file&&inside(webRoot,file)))throw Error('Public assets overlap private household files');
 recogniseDatabase(program.database);
 readKey(program.commsKey);
 const commsKey:WordsKey={seal:value=>wordsKey(readKey(program.commsKey)).seal(value),open:value=>wordsKey(readKey(program.commsKey)).open(value),hash:value=>wordsKey(readKey(program.commsKey)).hash(value)};
 prepareOperatorHome(home);
 const release=await ownHome(home);
 let client:Database.Database|undefined,app:Awaited<ReturnType<typeof serveShared>>|undefined,operator:Awaited<ReturnType<typeof listenOperatorLinks>>|undefined;
 let holder:Awaited<ReturnType<typeof startSharedHolder>>|undefined;
 let closing:Promise<void>|undefined,adapters:SharedStartupAdapters={};
 const close = () => closing ??= (async () => {
  const errors: unknown[] = [];
  const attempt = async (releaseResource: () => unknown) => {
   try { await releaseResource(); } catch (error) { errors.push(error); }
  };
  await attempt(() => operator?.close());
  await Promise.all([attempt(() => app?.close()), attempt(() => holder?.close())]);
  await attempt(() => adapters.close?.());
  await attempt(() => client?.close());
  await attempt(release);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Multiple errors while closing the shared home');
 })();
 try{
  // First-install publication must be durable before the holder writes values.
  const parent=openSync(dirname(realpathSync(home)),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(parent);}finally{closeSync(parent);}
  client=new Database(program.database,{fileMustExist:true});client.pragma('foreign_keys = ON');
  // Recognised again under the write lock, then upgraded; see upgradeDataSchema.
  upgradeDataSchema(client,()=>new Date(clock.now()).toISOString());
  const db=dataDatabase(client,()=>new Date(clock.now()).toISOString());
  // The member a local sign-in is for when the operator names nobody: a current owner of the household, the
  // first in the household's own order. Asked each time, so when that owner is removed or made a member
  // the next owner takes their place; the household never lets its last owner go.
  const localOwner=()=>db.select({id:members.id}).from(members).orderBy(asc(members.position),asc(members.id)).all().map(row=>row.id).find(id=>householdOwner(db,{kind:'member',id}));
  if(!localOwner())throw new StartupRefusal('A household needs an owner before anyone can sign in locally');
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
  app=await serveShared({db,clock,memory:{checkingAgent:program.memory.checkingAgent,alternateCheckingAgent:program.memory.alternateCheckingAgent,sources:householdMemorySources(db,commons,agentFiles)},commsKey,notifications:{vapid:notificationKey(home)},
   originAllowed:request=>sameIncomingOrigin(request,publicOrigin),publicOrigin,
   changes,
   tempo:{...adapters.tempo,...(program.repository?{repository:program.repository}:{})},
   secretWrites:adapters.secretWrites??(holder?{holder:holder.holder,fingerprintKey:holder.fingerprintKey}:undefined),secretInputs:adapters.secretInputs??(holder?{source:holder.source}:undefined),bridges,modelRoles:adapters.modelRoles,runtimeJobEnded:adapters.runtimeJobEnded,approvedOperations:adapters.approvedOperations,memoryEmbedding:adapters.memoryEmbedding,
   reportError:options.reportError??(()=>{}),startupNote:line=>(options.stdout??(text=>{process.stdout.write(text);}))(line+'\n'),host:options.host,port:options.port,webRoot,
  });
  const signin=sharedSigninLinks(db,clock),issuer=sharedTokens(db,clock);
  // Adapters ran since the first check and may have changed the household.
  if(!localOwner())throw new StartupRefusal('A household needs an owner before anyone can sign in locally');
  // Every local sign-in of one member rides on one token row, made by the same service as any other token
  // so its rules hold here too. Nobody is ever given that row's bearer: it only anchors the browsers and
  // passkeys that came in through a local link, and revoking it in Setup ends them all.
  const localToken=(member:string)=>{
   const label='Local sign-in: '+(member.length<=100?member:`${member.slice(0,60)} ${createHash('sha256').update(member).digest('hex').slice(0,16)}`);
   const found=db.select().from(tokens).where(and(eq(tokens.label,label),eq(tokens.kind,'owner'),eq(tokens.member,member))).all().find(row=>tokenLive(row,clock.now()));
   return found?.fingerprint??issuer.issue({kind:'owner',member,label}).fingerprint;
  };
  /** A sign-in link for whoever can reach the operator socket: the OS user who owns this home. */
  const issue=({member,label,ttl,agent}:z.infer<typeof operatorRequest>)=>app!.writes.run(()=>{
   const who=member??localOwner();
   if(who===undefined)throw Error('No household owner to sign in');
   return signin.makeLink(localToken(who),{label,ttlMs:ttl*1000,agent}).path;
  }).value;
  operator=await listenOperatorLinks(home,publicOrigin??app.url,issue);
  // No link is made or printed at start: under a service manager this output is the log. The operator asks
  // for one when they want it.
  (options.stdout??(text=>{process.stdout.write(text);}))(`To sign in from this machine: loom signin --home ${home}\n`);
  /** For the code that started this program in its own process: the link the operator socket would give. */
  const signinLink=(member?:string)=>`${publicOrigin??app!.url}${issue({request:'link',label:'Local sign-in',ttl:LINK_MS/1000,agent:false,...(member?{member}:{})})}`;
  return {...app,close,signinLink};
 } catch (error) {
  try { await close(); } catch (cleanupError) {
   throw new AggregateError([error, cleanupError], 'Shared home startup and cleanup failed', { cause: error });
  }
  throw error;
 }
}
