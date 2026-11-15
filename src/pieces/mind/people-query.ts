/** Person cards stay in their existing files; these fields join the one query schema. */
import { GraphQLBoolean, GraphQLFloat, GraphQLError, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import { peopleReader, mayReadPerson, type PeopleReaderOptions } from './people.js';
import type { CardValue, PersonCard, PersonRecord } from './people-model.js';
import type { MemoryQueryContext } from './knowledge-query.js';
import type { PeopleConversations } from './people-conversations.js';
const text={type:GraphQLString}, requiredText={type:new GraphQLNonNull(GraphQLString)};
const list=(type:GraphQLObjectType)=>new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)));
const value=new GraphQLObjectType<CardValue>({name:'MemoryCardValue',fields:{
 text:{type:GraphQLString,resolve:v=>typeof v==='string'?v:null},
 number:{type:GraphQLFloat,resolve:v=>typeof v==='number'?v:null},
 boolean:{type:GraphQLBoolean,resolve:v=>typeof v==='boolean'?v:null},
 strings:{type:new GraphQLList(new GraphQLNonNull(GraphQLString)),resolve:v=>Array.isArray(v)?v:null},
}});
const where=new GraphQLObjectType({name:'MemoryPersonCardField',fields:{key:requiredText,value:{type:value},label:text,source:text,verified_at:text,stale_after_days:{type:GraphQLInt}}});
const how=new GraphQLObjectType({name:'MemoryPersonCardHow',fields:{key:requiredText,value:{type:value}}});
const may=new GraphQLObjectType({name:'MemoryPersonCardStatement',fields:{text:requiredText,source:requiredText}});
const card=new GraphQLObjectType<PersonCard>({name:'MemoryPersonCard',fields:{slug:requiredText,name:requiredText,summary:text,
 where:{type:list(where),resolve:c=>Object.entries(c.where).map(([key,f])=>({key,...f}))},
 how:{type:list(how),resolve:c=>Object.entries(c.how).map(([key,value])=>({key,value}))},may:{type:list(may)},
}});
const field=new GraphQLObjectType({name:'MemoryPersonField',fields:{key:requiredText,value:requiredText,label:text,source:text,verifiedAt:text,state:requiredText}});
const project=new GraphQLObjectType({name:'MemoryPersonProject',fields:{agent:requiredText,slug:requiredText,name:requiredText,status:requiredText,href:text}});
const evidence=new GraphQLObjectType({name:'MemoryPersonEvidence',fields:{created:requiredText,category:requiredText,title:requiredText,content:requiredText}});
const ownership=new GraphQLObjectType({name:'MemoryPersonOwnership',fields:{owner:{type:GraphQLBoolean},agents:{type:new GraphQLList(new GraphQLNonNull(GraphQLString))}}});
const revision=new GraphQLObjectType({name:'MemoryPersonRevision',fields:{id:{type:GraphQLInt},op:requiredText,replacedAt:requiredText,actor:text,card:{type:card}}});
const conversation=new GraphQLObjectType({name:'MemoryPersonConversation',fields:{id:requiredText,title:requiredText,href:requiredText}});
const conversations=new GraphQLObjectType({name:'MemoryPersonConversations',fields:{available:{type:new GraphQLNonNull(GraphQLBoolean)},rows:{type:list(conversation)}}});
export function peopleQueryFields(options:PeopleReaderOptions & {conversations?:PeopleConversations}): {fields:GraphQLFieldConfigMap<unknown,MemoryQueryContext>;nextDeadline():number|undefined;close():void} {
 let reader:ReturnType<typeof peopleReader>|undefined=peopleReader(options);
 const visible=(context:MemoryQueryContext,agent?:string)=>!!context?.viewer&&mayReadPerson(context.viewer,agent,options.sharing());
 const anyVisible=(context:MemoryQueryContext)=>visible(context)||options.agents.some(a=>visible(context,a.agent));
 const safe=<T>(read:()=>T):T=>{try{return read();}catch{throw new GraphQLError('People are unavailable');}};
 const person=new GraphQLObjectType<PersonRecord,MemoryQueryContext>({name:'MemoryPerson',fields:{
  id:requiredText,slug:requiredText,agent:text,name:requiredText,card:{type:new GraphQLNonNull(card)},updated:requiredText,synthesizedAt:text,kind:requiredText,
  evidence:{type:list(evidence)},newer:{type:GraphQLInt},fields:{type:list(field)},projects:{type:list(project)},ownership:{type:ownership},mergedFrom:text,
  history:{type:list(revision),resolve:(source,_args,context)=>visible(context,source.agent)?safe(()=>reader?.history(source.id,context.viewer)??[]):[]},
  conversations:{type:conversations,resolve:(source,_args,context)=>{
   if(!visible(context,source.agent))return {available:false,rows:[]};
   try{return options.conversations?.list(context.viewer,source.slug)??{available:false,rows:[]};}
   catch{throw new GraphQLError('People conversations are unavailable');}
  }},
 }});
 return {nextDeadline:()=>reader?.nextDeadline(),fields:{
  memoryPeople:{type:new GraphQLList(new GraphQLNonNull(person)),resolve:(_source,_args,context)=>anyVisible(context)?safe(()=>reader?.list(context.viewer)??[]):[]},
  memoryPerson:{type:person,args:{id:{type:new GraphQLNonNull(GraphQLString)}},resolve:(_source,args,context)=>{
   const colon=(args.id as string).indexOf(':');if(colon<1)return null;
   const agent=(args.id as string).slice(0,colon);if(!visible(context,agent==='commons'?undefined:agent))return null;
   return safe(()=>reader?.read(args.id,context.viewer)??null);
  }},
 },close(){reader?.close();reader=undefined;}};
}
