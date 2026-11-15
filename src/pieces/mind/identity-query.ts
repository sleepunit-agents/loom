/** A body's Identity is an authored, read-only view of declared private files. */
import Database from 'better-sqlite3';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {GraphQLError,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import {maySee,type Sharing} from '../../core/index.js';
import {digestOnConnection} from '../../backends/salience.js';
import {assembleTape,episodesOnConnection,DEFAULT_HOURS,HOUR_MS} from '../../backends/episodes.js';
import {keepReadUntil} from '../../core/data/read-lease.js';
import type {MemoryQueryContext} from './knowledge-query.js';
import type {MindSources} from './sources.js';
import type {QueryDeadlines} from './query-deadlines.js';
const text={type:GraphQLString},required={type:new GraphQLNonNull(GraphQLString)};
const identityType=new GraphQLObjectType({name:'MemoryIdentity',fields:{agent:required,readAt:required,creed:text,preferences:text,selfModel:text,topOfMind:text,recent:text}});
function identity(directory:string,name:string){
 const path=join(directory,name);if(!existsSync(path))return null;
 const base=realpathSync(directory),target=realpathSync(path),inside=relative(base,target);
 if(inside==='..'||inside.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(inside))throw Error('Identity escaped its declared source');
 return readFileSync(target,'utf8').trim()||null;
}
export function memoryIdentityFields(options:{sources?:MindSources;sharing():Sharing;now():number;timezone():string},deadlines:QueryDeadlines){
 const sources=new Map<string,{directory:string;db?:Database.Database}>();let closed=false;
 const close=()=>{if(closed)return;closed=true;for(const source of sources.values())source.db?.close();sources.clear();};
 try{for(const source of options.sources?.agents??[]){if(sources.has(source.agent))throw Error('Duplicate Memory source');sources.set(source.agent,{directory:source.directory,db:existsSync(source.memories)?new Database(source.memories,{readonly:true,fileMustExist:true,timeout:0}):undefined});}}
 catch(error){close();throw error;}
 const fields:GraphQLFieldConfigMap<unknown,MemoryQueryContext>={memoryIdentity:{type:identityType,args:{agent:required},resolve:(_source,args,context)=>{
  const source=sources.get(args.agent);if(closed||!source||!context?.viewer||!maySee(context.viewer,{type:'memory',agent:args.agent},options.sharing()))return null;
  try{
   const now=options.now(),db=source.db,opts={nowMs:now,timeZone:options.timezone(),hours:DEFAULT_HOURS,excludeFuture:true,excludeExpired:true};
   const episodes=db?episodesOnConnection(db,opts):[],times=episodes.map(row=>Date.parse(row.created)+opts.hours*HOUR_MS+1).filter(at=>Number.isFinite(at)&&at>now);
   if(db?.prepare("SELECT 1 FROM sqlite_schema WHERE name='memories'").get()){
    const row=db.prepare('SELECT min(julianday(expires_at)) AS at FROM memories WHERE archived=0 AND julianday(expires_at)>julianday(?)').get(new Date(now).toISOString()) as {at:number|null};
    if(row.at!==null)times.push(Math.round((row.at-2440587.5)*86400000));
   }
   const until=times.length?Math.min(...times):undefined;deadlines.set('context:'+args.agent,until);if(until!==undefined)keepReadUntil(context,until);
   return {agent:args.agent,readAt:new Date(now).toISOString(),creed:identity(source.directory,'IDENTITY.md'),preferences:identity(source.directory,'preferences.md'),selfModel:identity(source.directory,'self-model.md'),topOfMind:db?digestOnConnection(db,opts):null,recent:assembleTape(episodes,opts)};
  }catch{throw new GraphQLError('Identity is unavailable');}
 }}};
 return {fields,close};
}
