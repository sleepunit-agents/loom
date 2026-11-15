/** Activity projections composed into the shared query schema. No endpoint or store of their own. */
import {GraphQLBoolean,GraphQLError,GraphQLFloat,GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {QueryDeadlines} from './query-deadlines.js';
import type {Viewer} from '../../core/index.js';
import type {installMindActivity} from './activity.js';

const text={type:GraphQLString}, requiredText={type:new GraphQLNonNull(GraphQLString)};
const strings={type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)))};
const list=(type:GraphQLObjectType)=>({type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)))});
const entryFields={id:requiredText,agent:requiredText,at:requiredText,day:requiredText,hour:{type:new GraphQLNonNull(GraphQLInt)},title:requiredText,line:text,venue:requiredText,where:requiredText,what:requiredText,owner:{type:GraphQLBoolean},expires:{type:GraphQLFloat}};
const entry=new GraphQLObjectType({name:'MemoryActivityEntry',fields:entryFields});
const link=new GraphQLObjectType({name:'MemoryActivityLink',fields:{label:requiredText,href:text}});
const step=new GraphQLObjectType({name:'MemoryActivityStep',fields:{label:requiredText,state:requiredText,tool:requiredText}});
const more=new GraphQLObjectType({name:'MemoryActivityMore',fields:{id:requiredText,at:requiredText,title:requiredText}});
const open=new GraphQLObjectType({name:'MemoryActivityOpen',fields:{...entryFields,asked:strings,decided:strings,story:text,tasks:list(link),prs:list(link),links:list(link),needs:text,steps:{type:new GraphQLList(new GraphQLNonNull(step))},more:list(more)}});
const window=new GraphQLObjectType({name:'MemoryActivityWindow',fields:{id:requiredText,to:requiredText,days:strings,earlier:text,entries:list(entry),conversations:requiredText,episodes:requiredText,truncated:{type:new GraphQLNonNull(GraphQLBoolean)},expires:{type:new GraphQLNonNull(GraphQLFloat)}}});

const access=new GraphQLObjectType({name:'MemoryActivityAccess',fields:{allowed:{type:new GraphQLNonNull(GraphQLBoolean)},agents:strings,owner:requiredText,timezone:requiredText,today:requiredText,windows:strings,expires:{type:new GraphQLNonNull(GraphQLFloat)}}});

/** The authenticated outside door supplies the viewer; the existing reader
 * rechecks current sharing, conversation scope and expiry on every read. */
export function activityQueryFields(reader:Pick<ReturnType<typeof installMindActivity>,'window'|'read'> & Partial<Pick<ReturnType<typeof installMindActivity>,'access'>>,deadlines?:QueryDeadlines):GraphQLFieldConfigMap<unknown,{viewer:Viewer}> {
 const safe=<T>(read:()=>T):T=>{try{return read();}catch{throw new GraphQLError('Activity is unavailable');}};
 const track=<T extends {expires?:number}>(value:T|undefined,context:{viewer:Viewer},kind:string,id:string)=>{
  deadlines?.set(JSON.stringify([context.viewer.kind,context.viewer.id,kind,id]),value?.expires);return value??null;
 };
 return {
  memoryActivityAccess:{type:access,resolve:(_source,_args,context)=>context?.viewer?track(safe(()=>reader.access?.(context.viewer)),context,'activity.access','activity'):null},
  memoryActivity:{type:window,args:{to:{type:GraphQLString,defaultValue:'recent'}},resolve:(_source,args,context)=>context?.viewer?track(safe(()=>reader.window(args.to??'recent',context.viewer)),context,'activity.window',args.to??'recent'):null},
  memoryActivityEntry:{type:open,args:{id:{type:new GraphQLNonNull(GraphQLString)}},resolve:(_source,args,context)=>{
   if(!context?.viewer)return null;
   const result=safe(()=>reader.read(args.id,context.viewer));
   if(result&&'state' in result)throw new GraphQLError('Activity entry is unavailable');
   return track(result,context,'activity.entry',args.id);
  }},
 };
}
