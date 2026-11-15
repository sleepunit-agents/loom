/** Metadata-only seam for the new conversation owner. Never reads legacy Comms. */
import type { Viewer } from '../../core/index.js';
export interface PeopleConversations {
  list(viewer:Viewer,person:string): {available:boolean;rows:Array<{id:string;title:string;href:string}>};
}

import { and, desc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { conversations, conversationPeople } from '../../core/data/schema.js';
import { maySee, type Sharing } from '../../core/index.js';

/** Only metadata from the shared model. The card resolver checks card access
 * separately; appearing on a card never grants access to its conversations.
 * No limit is applied before visibility, so private rows cannot crowd out
 * visible conversations. Sharing is refreshed on every read.
 */
export function sharedPeopleConversations(db:DataDatabase, sharing:()=>Sharing,
 href:(id:string)=>string):PeopleConversations {
 return {list(viewer,person) {
  const current=sharing();
  const rows=db.select({id:conversations.id,title:conversations.label,
   agent:conversations.agent,project:conversations.project,member:conversations.member})
   .from(conversations).innerJoin(conversationPeople,
    and(eq(conversationPeople.conversation,conversations.id),
     eq(conversationPeople.whoKind,'person'),eq(conversationPeople.who,person)))
   .orderBy(desc(conversations.lastAt),conversations.id).all();
  return {available:true,rows:rows.filter(row=>maySee(viewer,{type:'conversation',agent:row.agent,
   ...(row.project!==null?{project:row.project}:{}),...(row.member!==null?{member:row.member}:{})},current))
   .map(row=>({id:row.id,title:row.title,href:href(row.id)}))};
 }};
}
