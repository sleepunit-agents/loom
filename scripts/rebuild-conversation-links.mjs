/** Observe source links through the normally authenticated browser, not raw rows. */
import {browserRead} from './rebuild-conversation-visibility.mjs';
export async function conversationLinks({page,example}){
 const unknown=reason=>Object.fromEntries(['conversationTaskSource','conversationApprovalSource'].map(name=>[name,{inconclusive:true,reason}]));
 try{
  const selection='{ tasks(where:{id:{in:'+JSON.stringify(example.tasks)+'}},limit:100){id sourceKind sourceId} approvals(where:{id:{eq:'+JSON.stringify(example.approval)+'}},limit:2){id conversation} }';
  const result=await browserRead(page,selection);
  const taskIDs=result.tasks.map(row=>row.id).sort();
  const tasksMatch=JSON.stringify(taskIDs)===JSON.stringify([...example.tasks].sort())&&result.tasks.every(row=>row.sourceKind==='conversation'&&row.sourceId===example.conversation);
  const approvalMatches=result.approvals.length===1&&result.approvals[0].id===example.approval&&result.approvals[0].conversation===example.conversation;
  return{
   conversationTaskSource:tasksMatch?{ok:true,reason:'Each of the four actual example tasks names its originating private conversation through source_kind/source_id.',tasks:taskIDs,conversation:example.conversation}:{ok:false,error:'The authenticated Tasks selection returned missing tasks or a different originating conversation.',observed:result.tasks},
   conversationApprovalSource:approvalMatches?{ok:true,reason:'The actual example approval retains the conversation in which it was requested.',approval:example.approval,conversation:example.conversation}:{ok:false,error:'The authenticated approval selection omitted or changed its originating conversation.',observed:result.approvals},
  };
 }catch{return unknown('The browser source-link selection could not complete.');}
}
