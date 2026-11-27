import {displayName} from '../kit/words';
import {sha256} from '@noble/hashes/sha2.js';
import type {Change} from '../pieces/change-view/model';
export interface WorkAlwaysInput {approval:string;change:string;head:string;project:string;person:string}
export interface MergeRequest {id:string;kind:string;target:string;state:string;agent:string;project:string|null;actingFor?:string;operation?:string|null}
export interface RulePerson {id:string;role:string}
export type CurrentChange=Pick<Change,'id'|'state'|'agent'|'project'|'headCommit'>;
/** Presentation only: the server rebinds every field to current shared records. */
export function alwaysInput(card:MergeRequest|undefined,changes:readonly CurrentChange[],people:readonly RulePerson[]):WorkAlwaysInput|undefined{
 if(!card||card.kind!=='merge'||card.state!=='pending'||card.operation!==null||!card.project||!card.actingFor||['unknown','?'].includes(card.actingFor))return;
 const row=changes.find(row=>card.target===`${row.id}@${row.headCommit}`);
 const principal=people.find(person=>person.id===card.actingFor);
 if(!row||row.state!=='open'||!row.agent||row.agent!==card.agent||row.project!==card.project||!/^[a-f0-9]{40}$/.test(row.headCommit)||!principal||!['owner','member'].includes(principal.role))return;
 return {approval:card.id,change:row.id,head:row.headCommit,project:card.project,person:principal.role==='owner'?'':principal.id};
}
/** One "for": the project. A grant that covers only one person's work says whose after it. */
export const alwaysLabel=(input:WorkAlwaysInput)=>`Always for ${input.project}${input.person?`, ${displayName(input.person)}’s work only`:''}`;
/** One immutable card/head/project/person intent across windows and reloads. */
export async function sendWorkAlways(command:WorkAlwaysInput,request:typeof fetch=fetch):Promise<void>{
 const input={approval:command.approval,change:command.change,head:command.head,project:command.project,person:command.person};
 const digest=sha256(new TextEncoder().encode(JSON.stringify(['approvals.always',input])));
 const id='work-always-'+Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
 try{
  const response=await request('/api/approvals/always',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({input,id})});
  const result:unknown=await response.json();
  if(response.ok&&result&&typeof result==='object'&&'ok'in result&&result.ok===true&&'value'in result&&result.value&&typeof result.value==='object'&&'id'in result.value&&result.value.id===input.approval)return;
 }catch{/* Unknown responses keep the same immutable ID; no automatic retry. */}
 throw new Error('Could not confirm the standing merge answer. Try again.');
}
