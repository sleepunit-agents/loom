import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { GraphQLString, GraphQLInt, GraphQLBoolean, GraphQLObjectType, GraphQLList, GraphQLNonNull, type GraphQLFieldConfig } from 'graphql/index.js';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { archivedQuestions as q, conversations, threads } from '../data/schema.js';
import { readAll } from '../data/execution.js';
import { selectedQueryFields } from '../data/queries.js';
import { keepReadUntil } from '../data/read-lease.js';
import { commsKeepDays } from '../data/comms-days.js';
import { wordsDeadline } from './retention.js';
import type { WordsKey } from './words.js';
import type { Viewer } from '../../policy.js';

export const archivedQuestionBody = z.object({
  text:z.string(), kind:z.string().optional(), why:z.string().optional(), if_yes:z.string().optional(), if_no:z.string().optional(),
  fine:z.string().optional(), refs:z.array(z.string()).optional(), relayedFrom:z.string().optional(), ownerOnly:z.boolean().optional(),
});
const bodyType = new GraphQLObjectType({name:'ArchivedQuestionBody',fields:{
  ...Object.fromEntries(['text','kind','why','if_yes','if_no','fine','relayedFrom'].map(name=>[name,{type:GraphQLString}])),
  refs:{type:new GraphQLList(new GraphQLNonNull(GraphQLString))},ownerOnly:{type:GraphQLBoolean},
}});
const questionType = new GraphQLObjectType({name:'ArchivedQuestion',fields:{
  ...Object.fromEntries(['thread','ref','approval','raisedAt','seenAt','wordsKeepUntil','verdict','answeredBy','answeredAt'].map(name=>[name,{type:GraphQLString}])),
  body:{type:bodyType},
}});

/** The same thread authority as its messages, including a second read after opening any envelopes. */
export function archivedQuestionsField(db:DataDatabase,key:WordsKey,allowed:(viewer:Viewer)=>SQL,now:()=>string): GraphQLFieldConfig<unknown,{viewer:Viewer}> {
  return {type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(questionType))),
    args:{thread:{type:new GraphQLNonNull(GraphQLString)}, offset:{type:GraphQLInt,defaultValue:0},limit:{type:GraphQLInt,defaultValue:50}},
    async resolve(_root,args,ctx,info) {
      const {thread,offset,limit}=args;
      if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid archived question page');
      const wantsBody=selectedQueryFields(info).has('body');
      const {words,...metadata}=getTableColumns(q);
      const read=()=>db.select({...metadata,words:wantsBody?words:sql<null>`null`}).from(q)
        .innerJoin(threads,eq(threads.id,q.thread)).innerJoin(conversations,eq(conversations.id,threads.conversation))
        .where(and(eq(q.thread,thread),eq(q.sourceConversation,conversations.id),eq(q.sourceMember,conversations.member),
          eq(q.sourceAgent,conversations.agent),eq(conversations.venue,'loom'),allowed(ctx.viewer))).orderBy(desc(q.raisedAt),desc(q.ref)).limit(limit).offset(offset).all();
      const rows=read();
      if (!rows.length) return [];
      const days=commsKeepDays(db), deadlines:number[]=[];
      const result=await readAll(rows.map(async row=>{
        const until=wordsDeadline({at:row.seenAt,keepUntil:row.keepUntil},days);
        const {words,...entry}=row;
        let contents=null;
        if(words && until>Date.parse(now())) {
          try { contents=archivedQuestionBody.parse(JSON.parse(await key.open(words))); }
          catch { throw Error('Archived question text unavailable'); }
          deadlines.push(until);
        }
        return {...entry,wordsKeepUntil:new Date(until).toISOString(),body:contents};
      }));
      if(days!==commsKeepDays(db)||JSON.stringify(read())!==JSON.stringify(rows)||deadlines.some(until=>until<=Date.parse(now())))
        throw Error('Comms changed; retry the query');
      for(const until of deadlines)keepReadUntil(ctx,until);
      return result;
    }};
}
