import type {ApprovalRuleInput} from '../pieces/approval-view/rule-editor';
/** The authenticated root supplies setBy; caller metadata never enters the envelope. */
export async function sendApprovalRule(rule:ApprovalRuleInput,id:string,request:typeof fetch=fetch):Promise<void>{
 const input={kind:rule.kind,scope:rule.kind==='merge'&&!rule.scope.trim().startsWith('project:')?rule.scope.trim().toLowerCase():rule.scope.trim(),person:rule.person.trim(),tier:rule.tier};
 try{
  const response=await request('/api/approvals/setRule',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({input,id})});
  const result:unknown=await response.json();
  if(response.ok&&result&&typeof result==='object'&&'ok'in result&&result.ok===true&&'value'in result&&result.value&&typeof result.value==='object'){
   const value=result.value;
   if('kind'in value&&value.kind===input.kind&&'scope'in value&&value.scope===input.scope&&'person'in value&&value.person===input.person)return;
  }
 }catch{/* Keep this explicit intent for a deliberate retry; never retry automatically. */}
 throw new Error('Could not confirm the rule. Try again.');
}
