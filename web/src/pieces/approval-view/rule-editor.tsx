import {useRef,useState} from 'react';
import {Actions,Body,Button,Error,Field,Fields,Input} from '../../kit';
import {newId} from '../../data/id';
import {kindChoice,ruleKey as key,tierWord,type Rule} from './model';
export interface ApprovalRuleInput {kind:Rule['kind'];scope:string;person:string;tier:Rule['tier']|null}
export type SaveRule=(input:ApprovalRuleInput,id:string)=>Promise<void>;
/** One standing rule's fields, in the reader: the rule that was opened (`rule`), or a new one. Changing its kind,
 * scope or person addresses another rule (the three together are what a rule is), so Remove is offered only while
 * they name one that exists. Nothing is shown as saved until the program publishes it. */
export function RuleEditor({rules,save,rule}:{rules:readonly Rule[];save:SaveRule;rule?:Rule}){
 const [kind,setKind]=useState<Rule['kind']>(rule?.kind??'merge'),[scope,setScope]=useState(rule?.scope??''),[person,setPerson]=useState(rule?.person??''),[tier,setTier]=useState<Rule['tier']>(rule?.tier??'ask');
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
 return <form aria-label="Standing rule" className="grid min-w-0 gap-3" onSubmit={event=>{event.preventDefault();void send();}}>
  <Fields disabled={busy}>
   <Field label="When an agent asks about"><select aria-label="Kind" value={kind} onChange={event=>{change();setKind(event.target.value as Rule['kind']);}}>{(Object.keys(kindChoice) as Rule['kind'][]).map(value=><option key={value} value={value}>{kindChoice[value]}</option>)}</select></Field>
   <Field label="Scope" hint="A repository pattern such as github:acme/*, a project such as project:pond, or * for everything."><Input aria-label="Scope" required value={scope} onChange={event=>{change();setScope(event.target.value);}} /></Field>
   <Field label="Person (optional)" hint="Leave this blank for work done for a household owner. Naming a person grants only their work."><Input aria-label="Person (optional)" value={person} onChange={event=>{change();setPerson(event.target.value);}} /></Field>
   <Field label="Answer"><select aria-label="Answer" value={tier} onChange={event=>{change();setTier(event.target.value as Rule['tier']);}}>{(['ask','tell','do'] as const).map(value=><option key={value} value={value}>{tierWord[value]}</option>)}</select></Field>
  </Fields>
  <Actions><Button variant="primary" type="submit" disabled={busy||!scope.trim()||pendingRemoval}>Save rule</Button>{(existing||pendingRemoval)&&<Button type="button" variant="danger-quiet" disabled={busy} onClick={()=>void send(true)}>{pendingRemoval?'Retry removal':'Remove rule'}</Button>}</Actions>
  {busy&&<Body quiet role="status">Saving rule…</Body>}{saved&&<Body quiet role="status">{saved}</Body>}{error&&<Error text={error}/>}
 </form>;
}
