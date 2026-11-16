/** Visible conversation metadata for a person card; card access stays separate. */
import {and,asc,desc,sql} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
import type {Viewer} from '../../policy.js';
import {conversationPeople} from './schema.js';
import {conversationVisibility} from './conversation-visibility.js';
export function readPeopleConversations(db:DataDatabase,viewer:Viewer,person:string){
 const allowed=conversationVisibility(viewer).conversations!;
 return db.query.conversations.findMany({columns:{id:true,label:true},where:f=>and(sql`${{getSQL:()=>allowed(f)}}`,sql`${{getSQL:()=>sql`exists(select 1 from ${conversationPeople} where ${conversationPeople.conversation}=${f.id} and ${conversationPeople.whoKind}='person' and ${conversationPeople.who}=${person})`}}`),orderBy:f=>[desc(f.lastAt),asc(f.id)]}).sync();
}
