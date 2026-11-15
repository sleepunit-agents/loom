import {useRef,useState} from 'react';
import {Button,Error,Input} from '../../kit';
import {newId} from '../../data/id';
import type {Rule} from './model';
export interface ApprovalRuleInput {kind:Rule['kind'];scope:string;person:string;tier:Rule['tier']|null}
export type SaveRule=(input:ApprovalRuleInput,id:string)=>Promise<void>;
const key=(rule:Pick<Rule,'kind'|'scope'|'person'>)=>JSON.stringify([rule.kind,rule.scope,rule.person]);
export function RuleEditor({rules,save}:{rules:readonly Rule[];save:SaveRule}){
 const [kind,setKind]=useState<Rule['kind']>('merge'),[scope,setScope]=useState(''),[person,setPerson]=useState(''),[tier,setTier]=useState<Rule['tier']>('ask');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const active=useRef(false),pending=useRef<{body:string;id:string;remove:boolean}|undefined>(undefined);
 const pendingRemoval=pending.current?.remove===true;
 const existing=rules.find(rule=>key(rule)===key({kind,scope:scope.trim(),person:person.trim()}));
 function change(){pending.current=undefined;setError('');setSaved('');}
 async function send(remove=false){
  if(active.current||!scope.trim()||(!remove&&pending.current?.remove))return;
  active.current=true;setBusy(true);setError('');setSaved('');
  const input={kind,scope:scope.trim(),person:person.trim(),tier:remove?null:tier},body=JSON.stringify(input);
  try{
   if(pending.current?.body!==body)pending.current={body,id:newId(),remove};
   await save(input,pending.current.id);pending.current=undefined;setSaved(remove?'Removal confirmed.':'Rule saved.');
  }catch{setError(remove?'Could not confirm removal. Retry removal.':'Could not save this rule. Check its scope and person, then try again.');}
  finally{active.current=false;setBusy(false);}
 }
 return <form aria-label="Standing rule" className="grid min-w-0 gap-3 p-3" onSubmit={event=>{event.preventDefault();void send();}}>
  <h3>Standing rule</h3>
  <fieldset disabled={busy} className="grid min-w-0 gap-3">
   <label>Rule<select aria-label="Rule" className="w-full" value={existing?key(existing):''} onChange={event=>{change();const rule=rules.find(rule=>key(rule)===event.target.value);setKind(rule?.kind??'merge');setScope(rule?.scope??'');setPerson(rule?.person??'');setTier(rule?.tier??'ask');}}>
    <option value="">New rule</option>{rules.map(rule=><option key={key(rule)} value={key(rule)}>{rule.kind} · {rule.scope}{rule.person?` · for ${rule.person}`:''}</option>)}
   </select></label>
   <label>Kind<select aria-label="Kind" className="w-full" value={kind} onChange={event=>{change();setKind(event.target.value as Rule['kind']);}}>{['merge','command','setting','dangerous'].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
   <label>Scope<Input aria-label="Scope" required value={scope} onChange={event=>{change();setScope(event.target.value);}} /></label>
   <p>A repository pattern such as github:acme/*, a project such as project:pond, or * for every target.</p>
   <label>Person (optional)<Input aria-label="Person (optional)" value={person} onChange={event=>{change();setPerson(event.target.value);}} /></label>
   <p>Leave the person blank for work for a household owner. Naming a person grants only their work.</p>
   <label>Answer<select aria-label="Answer" className="w-full" value={tier} onChange={event=>{change();setTier(event.target.value as Rule['tier']);}}><option value="ask">Ask me</option><option value="tell">Tell me after</option><option value="do">Just do it</option></select></label>
   <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy||!scope.trim()||pendingRemoval}>Save rule</Button>{(existing||pendingRemoval)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void send(true)}>{pendingRemoval?'Retry removal':'Remove rule'}</Button>}</div>
  </fieldset>
  {busy&&<p role="status">Saving rule…</p>}{saved&&<p role="status">{saved}</p>}{error&&<Error text={error}/>}
 </form>;
}
