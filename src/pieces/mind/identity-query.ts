/** A body's Identity is an authored, read-only view of declared private files. */
import { DAY_MS } from '../../core/day.js';
import {PAGE_NAME} from '../../slug.js';
import Database from 'better-sqlite3';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {GraphQLError,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import {maySee,type Sharing} from '../../core/index.js';
import type {Viewer} from '../../policy.js';
import type {TapeDigest} from '../../backends/episodes.js';
import {digestOnConnection} from '../../backends/salience.js';
import {assembleTape,episodesOnConnection,DEFAULT_HOURS,HOUR_MS} from '../../backends/episodes.js';
import {keepReadUntil} from '../../core/data/read-lease.js';
import type {MemoryQueryContext} from './knowledge-query.js';
import {AgentFiles,type AgentSource,type MindSources} from './sources.js';
import type {QueryDeadlines} from './query-deadlines.js';
const text={type:GraphQLString},required={type:new GraphQLNonNull(GraphQLString)};
/** Authored pages beside the creed: one folder per kind, one Markdown file per name. */
const pageFolders:Readonly<Record<string,string>>={harness:'harnesses',model:'models',role:'roles',project:'projects',client:'clients'};
const pageName=PAGE_NAME;
function identity(directory:string,name:string){
 const path=join(directory,name);if(!existsSync(path))return null;
 const base=realpathSync(directory),target=realpathSync(path),inside=relative(base,target);
 if(inside==='..'||inside.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(inside))throw Error('Identity escaped its declared source');
 return readFileSync(target,'utf8').trim()||null;
}
/** Conversation digests live in the shared database, not in an agent's memory file, so the tape is
 * handed the ones this viewer may see for this agent, written within the window. */
export type TapeDigestReader=(viewer:Viewer,agent:string,window:{from:number;until:number})=>TapeDigest[];
export function memoryIdentityFields(options:{sources?:MindSources;sharing():Sharing;now():number;timezone():string;digests?:TapeDigestReader},deadlines:QueryDeadlines){
 // An agent's pages are files in its directory; its memory file is opened once it is there.
 const stores=new AgentFiles<AgentSource,Database.Database>(()=>options.sources?.agents??[],source=>existsSync(source.memories)?new Database(source.memories,{readonly:true,fileMustExist:true,timeout:0}):undefined);
 let closed=false;
 const sources={get:(agent:string)=>{const source=closed?undefined:options.sources?.agents.find(source=>source.agent===agent);return source?{directory:source.directory,db:stores.get(agent)}:undefined;}};
 const close=()=>{if(closed)return;closed=true;for(const db of stores.end())db.close();};
 try{stores.follow();}catch(error){close();throw error;}
 const identityType=new GraphQLObjectType<{agent:string},MemoryQueryContext>({name:'MemoryIdentity',fields:{agent:required,readAt:required,creed:text,preferences:text,selfModel:text,topOfMind:text,recent:text,
  page:{type:GraphQLString,args:{kind:required,name:required},resolve:(parent,args:{kind:string;name:string},context)=>{
   const source=sources.get(parent.agent),folder=Object.hasOwn(pageFolders,args.kind)?pageFolders[args.kind]:undefined;
   if(closed||!source||!folder||!pageName.test(args.name)||!context?.viewer||!maySee(context.viewer,{type:'memory',agent:parent.agent},options.sharing()))return null;
   try{return identity(source.directory,join(folder,args.name+'.md'));}catch{throw new GraphQLError('Identity is unavailable');}
  }},
 }});
 const fields:GraphQLFieldConfigMap<unknown,MemoryQueryContext>={memoryIdentity:{type:identityType,args:{agent:required},resolve:(_source,args,context)=>{
  const source=sources.get(args.agent);if(closed||!source||!context?.viewer||!maySee(context.viewer,{type:'memory',agent:args.agent},options.sharing()))return null;
  try{
   const now=options.now(),db=source.db,opts={nowMs:now,timeZone:options.timezone(),hours:DEFAULT_HOURS,excludeFuture:true,excludeExpired:true};
   const episodes=db?episodesOnConnection(db,opts):[],digests=options.digests?.(context.viewer,args.agent,{from:now-opts.hours*HOUR_MS,until:now})??[];
   const times=[...episodes.map(row=>row.created),...digests.map(row=>row.at)].map(at=>Date.parse(at)+opts.hours*HOUR_MS+1).filter(at=>Number.isFinite(at)&&at>now);
   if(db?.prepare("SELECT 1 FROM sqlite_schema WHERE name='memories'").get()){
    const row=db.prepare('SELECT min(julianday(expires_at)) AS at FROM memories WHERE archived=0 AND julianday(expires_at)>julianday(?)').get(new Date(now).toISOString()) as {at:number|null};
    if(row.at!==null)times.push(Math.round((row.at-2440587.5)*DAY_MS));
   }
   const until=times.length?Math.min(...times):undefined;deadlines.set('context:'+args.agent,until);if(until!==undefined)keepReadUntil(context,until);
   return {agent:args.agent,readAt:new Date(now).toISOString(),creed:identity(source.directory,'IDENTITY.md'),preferences:identity(source.directory,'preferences.md'),selfModel:identity(source.directory,'self-model.md'),topOfMind:db?digestOnConnection(db,opts):null,recent:assembleTape(episodes,opts,digests)};
  }catch{throw new GraphQLError('Identity is unavailable');}
 }}};
 return {fields,close};
}
