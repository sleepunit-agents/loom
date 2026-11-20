import {useState} from 'react';
import {Actions,Button,Field,Fields,Input} from '../../kit';
import {useSettingRequest,type Navigation} from '../attention/setting-request';
import {kindChoice,ruleKey,tierWord,type Rule} from './model';

/** Opening the private composer leaves the rule untouched until its proposal is approved. */
export function RuleEditor({rules,rule,go}:Navigation & {rules:readonly Rule[];rule?:Rule}){
 const request=useSettingRequest({go},'standing approval rule change','Standing approval rule request');
 const [kind,setKind]=useState<Rule['kind']>(rule?.kind??'merge');
 const [scope,setScope]=useState(rule?.scope??'');
 const [person,setPerson]=useState(rule?.person??'');
 const [tier,setTier]=useState<Rule['tier']>(rule?.tier??'ask');
 const normalizedScope=kind==='merge'&&!scope.trim().startsWith('project:')?scope.trim().toLowerCase():scope.trim();
 const identity={kind,scope:normalizedScope,person:person.trim()};
 const existing=rules.some(row=>ruleKey(row)===ruleKey(identity));
 return <><form aria-label="Standing rule" className="grid min-w-0 gap-3" onChange={request.clear} onSubmit={event=>{event.preventDefault();if(normalizedScope&&!request.disabled)request.prepare({...identity,tier});}}>
  <Fields disabled={request.disabled}>
   <Field label="When an agent asks about"><select aria-label="Kind" value={kind} onChange={event=>{setKind(event.target.value as Rule['kind']);}}>{(Object.keys(kindChoice) as Rule['kind'][]).map(value=><option key={value} value={value}>{kindChoice[value]}</option>)}</select></Field>
   <Field label="Scope" hint="A repository pattern such as github:acme/*, a project such as project:pond, or * for everything."><Input aria-label="Scope" required value={scope} onChange={event=>{setScope(event.target.value);}} /></Field>
   <Field label="Person (optional)" hint="Leave this blank for work done for a household owner. Naming a person grants only their work."><Input aria-label="Person (optional)" value={person} onChange={event=>{setPerson(event.target.value);}} /></Field>
   <Field label="Answer"><select aria-label="Answer" value={tier} onChange={event=>{setTier(event.target.value as Rule['tier']);}}>{(['ask','tell','do'] as const).map(value=><option key={value} value={value}>{tierWord[value]}</option>)}</select></Field>
  </Fields>
  <Actions><Button variant="primary" type="submit" disabled={request.disabled||!normalizedScope}>Review rule change</Button>
   {existing&&<Button type="button" variant="danger-quiet" disabled={request.disabled} onClick={()=>request.prepare({...identity,tier:null})}>Review removal</Button>}</Actions>
 </form>{request.reader}</>;
}
