/** Changes cited by currently visible conversation-source task comments. */
import {and,asc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import type {Viewer} from '../../policy.js';
import type {DataDatabase} from './database.js';
import {tasks} from './schema.js';
import {conversationVisibility} from './conversation-visibility.js';
import {taskVisibility} from './visibility.js';
import {workVisibility} from './work-visibility.js';
import {citations} from '../../pieces/changes/model.js';
export function readConversationWork(db:DataDatabase,viewer:Viewer,input:{conversation:string;change?:string;limit:number;offset:number}){
 const allowed=conversationVisibility(viewer).conversations!;
 const parent=db.query.conversations.findFirst({columns:{id:true},where:f=>and(eq(f.id,input.conversation),sql`${{getSQL:()=>allowed(f)}}`)}).sync();
 if(!parent)return [];
 const taskPolicy=taskVisibility(viewer).tasks!(getTableColumns(tasks));
 const comments=db.query.taskComments.findMany({columns:{text:true},where:f=>sql`${{getSQL:()=>sql`exists(select 1 from ${tasks} where ${tasks.id}=${f.task} and ${tasks.sourceKind}='conversation' and ${tasks.sourceId}=${input.conversation} and ${taskPolicy})`}}`}).sync();
 const ids=[...new Set(comments.flatMap(comment=>citations(comment.text)).filter(id=>id.startsWith('github:')))];
 const limit=Math.max(1,Math.min(100,input.limit)),offset=Math.max(0,input.offset);
 return db.query.changes.findMany({columns:{id:true},where:f=>and(sql`${{getSQL:()=>workVisibility(viewer).changes!(f)}}`,inArray(f.id,ids),input.change?eq(f.id,input.change):undefined),orderBy:f=>asc(f.id),limit,offset}).sync();
}
