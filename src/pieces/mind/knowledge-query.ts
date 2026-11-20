/** File-backed fields for composition into the one generated query schema.
 * These are not shared-database tables or a second endpoint. */
import { DAY_MS } from '../../core/day.js';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
 GraphQLBoolean, GraphQLEnumType, GraphQLError, GraphQLInt, GraphQLList,
 GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap,
} from 'graphql/index.js';
import { maySee, type Sharing, type Viewer } from '../../core/index.js';
import { knowledgeView, knowledgeAccess, AGING_DAYS, CHECK_DAYS, RECENT_DAYS } from './knowledge.js';
import {knowledgeSweep} from './knowledge-sweep.js';
import type {SweepPart} from '../../core/tempo/sweep.js';
import {MAX_REVISIONS} from '../../backends/cards.js';

/** The outside door supplies the authenticated viewer, never a query argument. */
export interface MemoryQueryContext { viewer: Viewer }
const text = { type: GraphQLString };
const requiredText = { type: new GraphQLNonNull(GraphQLString) };
const freshness = new GraphQLEnumType({ name:'MemoryKnowledgeFreshness', values:{ fresh:{value:'fresh'}, aging:{value:'aging'}, due:{value:'due'} } });
const summaryFields = {
 slug:requiredText, title:requiredText, domain:requiredText, updated:requiredText,
 verified_at:text, freshness_anchor:text, sla_class:text, fresh:{type:new GraphQLNonNull(freshness)}, by:text, recent:{type:GraphQLBoolean},
};
const summary = new GraphQLObjectType({ name:'MemoryKnowledgeSummary', fields:summaryFields });
const citation = new GraphQLObjectType({ name:'MemoryKnowledgeCitation', fields:{ claim:requiredText,kind:requiredText,locator:text,href:text,excerpt:requiredText,retrievedAt:requiredText,createdAt:requiredText } });
const reference = new GraphQLObjectType({ name:'MemoryKnowledgeReference', fields:{ slug:requiredText,title:requiredText } });
const check = new GraphQLObjectType({ name:'MemoryKnowledgeCheck', fields:{ at:requiredText,outcome:requiredText,by:text } });
const revision = new GraphQLObjectType({ name:'MemoryKnowledgeRevision', fields:{
 id:{type:new GraphQLNonNull(GraphQLInt)},slug:requiredText,body:requiredText,op:requiredText,replacedAt:requiredText,actor:text,
} });
const access=new GraphQLObjectType({name:'MemoryKnowledgeAccess',fields:Object.fromEntries(['allowed','canAdd','canVerify','canRecheck'].map(name=>[name,{type:new GraphQLNonNull(GraphQLBoolean)}]))});
const overview = new GraphQLObjectType({ name:'MemoryKnowledge',fields:{
 timezone:text,
 total:{type:new GraphQLNonNull(GraphQLInt)}, checkDays:{type:new GraphQLNonNull(GraphQLInt)},recentDays:{type:new GraphQLNonNull(GraphQLInt)},
 pages:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(summary)))},
} });

const match = new GraphQLObjectType({ name:'MemoryKnowledgeMatch', fields:{ slug:requiredText,title:requiredText,domain:requiredText,updated:requiredText,verified_at:text,freshness_anchor:text,sla_class:text,body:requiredText } });

export function knowledgeQueryFields(options: { path?:string; timezone?():string; sharing():Sharing; now():number }): {
 fields:GraphQLFieldConfigMap<unknown,MemoryQueryContext>;
 nextDeadline():number|undefined;
 sweep(checkingAgent:string):SweepPart;
 close():void;
} {
 let db:Database.Database|undefined,failed=false;
 try {
  if(options.path&&existsSync(options.path)) db=new Database(options.path,{readonly:true,fileMustExist:true,timeout:0});
 } catch { failed=true; }
 const allowed=(context:MemoryQueryContext)=>!!context?.viewer&&maySee(context.viewer,{type:'knowledge'},options.sharing());
 const read=(slug?:string)=>{
  if(failed)throw new GraphQLError('Knowledge is unavailable');
  try{return knowledgeView(db,options.now(),slug,slug!==undefined);}
  catch{throw new GraphQLError('Knowledge is unavailable');}
 };
 const page = new GraphQLObjectType< {slug:string},MemoryQueryContext>({ name:'MemoryKnowledgePage', fields:{
  ...summaryFields,body:requiredText,sourcing:text,
  sources:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(citation)))},
  citedBy:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(reference)))},checked:{type:check},
  history:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(revision))),resolve:(source,_args,context)=>{
   if(!allowed(context))return [];
   try{return db?.prepare(`SELECT r.id,r.slug,r.body,r.op,r.replaced_at AS replacedAt,r.actor
    FROM page_revisions r JOIN pages p ON p.id=r.page_id
    WHERE p.slug=? AND p.status='active' ORDER BY r.id DESC LIMIT ?`).all(source.slug,MAX_REVISIONS)??[];}
   catch{throw new GraphQLError('Knowledge history is unavailable');}
  }},
 } });
 return {
  sweep(checkingAgent){if(failed)throw new GraphQLError('Knowledge is unavailable');return knowledgeSweep(db,{now:options.now},checkingAgent);},
  fields:{
   memoryKnowledgeAccess:{type:access,resolve:(_source,_args,context)=>context?.viewer?knowledgeAccess(context.viewer,options.sharing()):null},
   memoryKnowledge:{type:overview,resolve:(_source,_args,context)=>allowed(context)?{...read(),timezone:options.timezone}:null},
   // One statement, no access stamp: every word must appear in the title, body or domain.
   memoryKnowledgeSearch:{type:new GraphQLList(new GraphQLNonNull(match)),args:{query:{type:new GraphQLNonNull(GraphQLString)},domain:{type:GraphQLString},first:{type:GraphQLInt}},
    resolve:(_source,args:{query:string;domain?:string|null;first?:number|null},context)=>{
     if(!allowed(context))return null;
     if(failed)throw new GraphQLError('Knowledge is unavailable');
     const first=args.first??10,words=args.query.trim().split(/\s+/).filter(Boolean);
     if(!Number.isInteger(first)||first<1||first>50||!words.length||words.length>20||args.query.length>400)throw new GraphQLError('Search needs 1 to 20 words and first from 1 to 50');
     if(!db)return [];
     const like=(word:string)=>'%'+word.replace(/[\\%_]/g,'\\$&')+'%',clauses=["status='active'"],values:unknown[]=[];
     for(const word of words){clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\')");values.push(like(word),like(word),like(word));}
     if(args.domain){clauses.push("(domain=? OR domain LIKE ? ESCAPE '\\')");values.push(args.domain,args.domain.replace(/[\\%_]/g,'\\$&')+'/%');}
     try{return db.prepare('SELECT slug,title,domain,updated,verified_at,freshness_anchor,sla_class,body FROM pages WHERE '+clauses.join(' AND ')+' ORDER BY hit_count DESC,updated DESC,slug LIMIT ?').all(...values,first);}
     catch{throw new GraphQLError('Knowledge is unavailable');}
    }},
   memoryKnowledgePage:{type:page,args:{slug:{type:new GraphQLNonNull(GraphQLString)}},
    resolve:(_source,args,context)=>allowed(context)?read(args.slug).open??null:null},
  },
  // Metadata only, across every active page, including pages outside a list's
  // display limit. Invalid legacy dates are already due, never timer inputs.
  nextDeadline(){
   if(!db||failed)return;
   try {
    const now=options.now();let next:number|undefined;
    const rows=db.prepare("SELECT updated,verified_at FROM pages WHERE status='active'").all() as Array<{updated:string;verified_at:string|null}>;
    for(const row of rows){
     const anchor=Date.parse(row.verified_at??row.updated);
     const boundaries=[anchor+AGING_DAYS*DAY_MS,anchor+CHECK_DAYS*DAY_MS,
      ...(row.verified_at?[Date.parse(row.verified_at)+RECENT_DAYS*DAY_MS]:[])];
     for(const at of boundaries)if(Number.isFinite(at)&&at>now&&(next===undefined||at<next))next=at;
    }
    return next;
   }catch{return undefined;}
  },
  close(){db?.close();db=undefined;},
 };
}
