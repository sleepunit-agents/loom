/** Explicit retained reads include expired/archived words under current
 * Memory visibility. They have no current-body freshness/expiry lease. */
import {GraphQLString,GraphQLInt,GraphQLNonNull,GraphQLList,GraphQLObjectType,GraphQLError,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {Viewer} from '../../core/index.js';
import type {ProjectsReader} from './projects.js';
const text={type:GraphQLString};
const common={id:text,title:text,content:text,category:text,project:text,ttl:text,created:text};
const archived=new GraphQLObjectType({name:'MemoryArchivedMemory',fields:{...common,ref:text,expiresAt:text,note:text,archivedAt:text}});
const draft=new GraphQLObjectType({name:'MemoryDraft',fields:{...common,source:text}});
const page=(name:string,entry:GraphQLObjectType)=>new GraphQLObjectType({name,fields:{entries:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entry)))},nextBefore:text}});
const archivePage=page('MemoryArchivePage',archived),draftPage=page('MemoryDraftPage',draft);
const cursor=(value:unknown)=>{if(value===undefined||value===null)return true;if(typeof value!=='string'||!/^(-?[1-9]\d{0,18}|0)$/.test(value))return false;const at=BigInt(value);return at>=-9223372036854775808n&&at<=9223372036854775807n;};
export function retainedQueryFields(source:Pick<ProjectsReader,'retained'>):GraphQLFieldConfigMap<unknown,{viewer:Viewer}>{
 const read=(kind:'archive'|'draft',args:Record<string,unknown>,context:{viewer:Viewer})=>{
  if(!context?.viewer)return null;
  const first=args.first??50,before=args.before;
  if(typeof first!=='number'||!Number.isInteger(first)||first<1||first>200||!cursor(before))throw new GraphQLError('Retained Memory selection is invalid');
  try{return source.retained(args.agent as string,context.viewer,kind,first,before as string|null|undefined);}catch{throw new GraphQLError('Retained Memory is unavailable');}
 };
 const args={agent:{type:new GraphQLNonNull(GraphQLString)},first:{type:GraphQLInt,defaultValue:50},before:{type:GraphQLString}};
 return {memoryArchive:{type:archivePage,args,resolve:(_source,args,context)=>read('archive',args,context)},memoryDrafts:{type:draftPage,args,resolve:(_source,args,context)=>read('draft',args,context)}};
}
