/** Personal action outcomes contain controlled display metadata, never request
 * input, operation output or raw failure messages. Notification cannot undo work. */
import { createHash } from 'node:crypto';
import type { Viewer } from './policy.js';
import type { Operations, Result } from './core/operations/index.js';
import type { DataDatabase } from './core/data/database.js';
import type { DataWrites } from './core/data/writes.js';
import { actionResults } from './core/data/schema.js';
const areas: Record<string,readonly [string,string]>={
 comms:['Conversations','/p/comms-preview'],inbox:['Inbox','/p/inbox-preview'],tasks:['Tasks','/p/tasks-preview'],
 approvals:['Approvals','/p/approvals-preview'],changes:['Changes','/p/changes-preview'],
 clock:['Tempo','/p/clock-preview'],tempo:['Tempo','/p/clock-preview'],
 secrets:['Secrets','/p/settings-preview/requests'],settings:['Settings','/p/settings-preview'],
 household:['Appearance','/p/settings-preview'],runtime:['Machines and jobs','/p/jobs-preview'],
};
export function recordActionResult(options:{db:DataDatabase;writes:DataWrites;operations:Operations;viewer:Viewer;window:boolean;name:string;input:unknown;id?:string;result:Result;now:()=>number;reportError(error:unknown):void}):void {
 const {viewer,name,id,result}=options;
 if(viewer.kind!=='member'||!options.window||!id)return;
 if(name==='inbox.read'||name==='inbox.dismissResult'||name==='comms.change'&&options.input&&typeof options.input==='object'&&'change' in options.input&&options.input.change==='read')return;
 if(!options.operations.offered('http').some(op=>op.name===name&&op.write))return;
 const [area,page]=areas[name.split('.')[0]]??['Loom','/p/inbox-preview'];
 try {
  // A failed/conflicting call must not borrow a prior success receipt's retry
  // generation. Replays leave an already-dismissed notice dismissed.
  const generation=result.ok?options.operations.retryDeadline(viewer,id,name)??0:result.code;
  const key=createHash('sha256').update(JSON.stringify([viewer.id,name,id,result.ok,generation])).digest('hex');
  const saved=options.writes.run(()=>options.db.insert(actionResults).values({id:`ar-${key}`,member:viewer.id,at:new Date(options.now()).toISOString(),ok:result.ok,text:result.ok?`Saved in ${area}`:`Could not save in ${area}`,page}).onConflictDoNothing().run());
  if(saved.notificationErrors.length)options.reportError(new Error('Action notice notification failed'));
 } catch {try{options.reportError(new Error('Action notice could not be recorded'));}catch{/* Reporting cannot change the action result. */}}
}
