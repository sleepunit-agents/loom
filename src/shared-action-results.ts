/** Personal action outcomes contain controlled display metadata, never request
 * input, operation output or raw failure messages. Notification cannot undo work.
 *
 * This insert is not a registered operation: it is a notice about a call, written after it, and must be
 * written when the call was refused or rolled back (docs/accepted-tradeoffs.md, "The notice of a person's
 * own action ..."). */
import { createHash } from 'node:crypto';
import type { Viewer } from './policy.js';
import type { Operations, Result } from './core/operations/index.js';
import type { DataDatabase } from './core/data/database.js';
import type { DataWrites } from './core/data/writes.js';
import { actionResults } from './core/data/schema.js';
const areas: Record<string,readonly [string,string]>={
 comms:['Conversations','/p/comms-preview'],inbox:['Inbox','/p/inbox-preview'],tasks:['Work','/p/work/backlog'],
 approvals:['Approvals','/p/approvals-preview'],changes:['Work','/p/work/changes'],
 tempo:['Tempo','/p/tempo'],
 secrets:['Secrets','/p/settings-preview/requests'],settings:['Settings','/p/settings-preview'],
 household:['Appearance','/p/settings-preview'],runtime:['Machines and jobs',''],
};
export function recordActionResult(options:{db:DataDatabase;writes:DataWrites;operations:Operations;viewer:Viewer;window:boolean;name:string;input:unknown;id?:string;result:Result;now:()=>number;reportError(error:unknown):void}):void {
 const report=(message:string)=>{try{options.reportError(new Error(message));}catch{/* Reporting cannot change committed work. */}};
 try {
 const {viewer,name,id,result}=options;
 if(viewer.kind!=='member'||!options.window||!id)return;
 if(name==='inbox.discuss'||name==='inbox.read'||name==='inbox.dismissResult'||name==='comms.change'&&options.input&&typeof options.input==='object'&&'change' in options.input&&options.input.change==='read')return;
 if(!options.operations.offered('http').some(op=>op.name===name&&op.write))return;
 const prefix=name.split('.')[0];
 const [area,page]=name==='household.setPortrait'?['Household setup','/p/setup-preview']:Object.hasOwn(areas,prefix)?areas[prefix]:['Loom',''];
  // A failed/conflicting call must not borrow a prior success receipt's retry
  // generation. Replays leave an already-dismissed notice dismissed.
  const generation=result.ok?options.operations.completedWriteDeadline(result)??0:result.code;
  const key=createHash('sha256').update(JSON.stringify([viewer.id,name,id,result.ok,generation])).digest('hex');
  const saved=options.writes.run(()=>options.db.insert(actionResults).values({id:`ar-${key}`,member:viewer.id,at:new Date(options.now()).toISOString(),ok:result.ok,text:result.ok?`Saved in ${area}`:`Could not save in ${area}`,page}).onConflictDoNothing().run());
  if(saved.notificationErrors.length)report('Action notice notification failed');
 } catch {report('Action notice could not be recorded');}
}
