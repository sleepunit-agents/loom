/** Current work made in a conversation, read through the shared outside policy.
 * A comment on a visible source task may introduce a PR. Neither a hidden task
 * nor a hidden change may become an existence oracle in this list. */
import {readConversationWork} from './core/data/conversation-work-read.js';
import {GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString} from 'graphql/index.js';
import type {DataDatabase} from './core/data/database.js';
import type {Viewer} from './policy.js';
export function conversationWorkFields(db:DataDatabase){
 const row=new GraphQLObjectType({name:'ConversationMadeChange',fields:{id:{type:new GraphQLNonNull(GraphQLString)}}});
 return {conversationMadeChanges:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(row))),args:{conversation:{type:new GraphQLNonNull(GraphQLString)},change:{type:GraphQLString},limit:{type:GraphQLInt,defaultValue:51},offset:{type:GraphQLInt,defaultValue:0}},
  resolve(_source:unknown,input:{conversation:string;change?:string;limit:number;offset:number},context:{viewer:Viewer}){
   return readConversationWork(db,context.viewer,input);
  },
 }};
}
