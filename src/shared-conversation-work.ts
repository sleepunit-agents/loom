/** Current work made in a conversation, read through the shared outside policy.
 * A comment on a visible source task may introduce a PR. Neither a hidden task
 * nor a hidden change may become an existence oracle in this list. */
import {and,asc,eq,getTableColumns} from 'drizzle-orm';
import {GraphQLBoolean,GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString} from 'graphql/index.js';
import type {DataDatabase} from './core/data/database.js';
import {changes,tasks,taskComments} from './core/data/schema.js';
import {taskVisibility} from './core/data/visibility.js';
import {workVisibility} from './core/data/work-visibility.js';
import {citations} from './pieces/changes/model.js';
import {canReadSharedConversation} from './shared-sharing.js';
import type {Viewer} from './policy.js';
export function conversationWorkFields(db:DataDatabase){
 const row=new GraphQLObjectType({name:'ConversationMadeChange',fields:{id:{type:new GraphQLNonNull(GraphQLString)}}});
 return {conversationMadeChanges:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(row))),args:{conversation:{type:new GraphQLNonNull(GraphQLString)},limit:{type:GraphQLInt,defaultValue:51},offset:{type:GraphQLInt,defaultValue:0}},
  resolve(_source:unknown,input:{conversation:string;limit:number;offset:number},context:{viewer:Viewer}){
   if(!canReadSharedConversation(db,context.viewer,input.conversation))return [];
   const taskPolicy=taskVisibility(context.viewer).tasks!(getTableColumns(tasks));
   const comments=db.select({text:taskComments.text}).from(taskComments).innerJoin(tasks,eq(tasks.id,taskComments.task))
    .where(and(eq(tasks.sourceKind,'conversation'),eq(tasks.sourceId,input.conversation),taskPolicy)).all();
   const ids=new Set(comments.flatMap(comment=>citations(comment.text)).filter(id=>id.startsWith('github:')));
   const limit=Math.max(1,Math.min(100,input.limit)),offset=Math.max(0,input.offset);
   return db.select({id:changes.id}).from(changes).where(workVisibility(context.viewer).changes!(getTableColumns(changes)))
    .orderBy(asc(changes.id)).all().filter(row=>ids.has(row.id)).slice(offset,offset+limit);
  },
 }};
}
