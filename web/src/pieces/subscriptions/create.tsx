import { newId } from '../../data/id';
import { NativeSelect } from '../../kit/native-select';
import {useRef,useState,type FormEvent} from 'react';
import {Button,Field,Fields,Input} from '../../kit';
import {memberOperation} from '../../data/operation';
import {useDataQuery} from '../../data/graphql';

type Setup={member:string;providers:string[];machines:{id:string;name:string}[]};
const query='{ subscriptionSetup { member providers machines { id name } } }';

function CreateForm({setup}:{setup:Setup}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const attempt=useRef<{key:string;id:string} | null>(null);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy)return;
  const form=event.currentTarget,values=new FormData(form);
  const input={provider:String(values.get('provider')),label:String(values.get('label')??'').trim(),machines:values.getAll('machines').map(String).sort()};
  if(!input.label){setMessage('Give the subscription a label.');return;}
  const key=JSON.stringify(input);
  if(attempt.current?.key!==key)attempt.current={key,id:newId()};
  setBusy(true);setMessage('');
  try{
   await memberOperation('runtime.accountCreate',input,attempt.current.id);
   attempt.current=null;form.reset();
   setMessage(input.machines.length?'Subscription added. Each selected machine has a sign-in request. Watch Inbox for the provider’s instructions.':'Subscription added.');
  }catch{setMessage('Could not confirm creation. Check the list or retry with the same settings.');}
  finally{setBusy(false);}
 }
 return <details className="rounded-xl border p-4"><summary>Add a subscription</summary>
  <form onSubmit={event=>void submit(event)} aria-label="Add a subscription">
   <Fields disabled={busy}>
    <p>Owner: {setup.member}</p>
    <Field label="Service"><NativeSelect name="provider" required>{setup.providers.map(p=><option key={p}>{p}</option>)}</NativeSelect></Field>
    <Field label="Label"><Input required name="label" maxLength={200}/></Field>
    {!!setup.machines.length&&<fieldset><legend>Machines to sign in on</legend>{setup.machines.map(m=><label className="flex gap-2" key={m.id}>
     <input type="checkbox" name="machines" value={m.id}/>{m.name}
    </label>)}</fieldset>}
    <Button type="submit">Add subscription</Button>
   </Fields>
   {message&&<p role="status">{message}</p>}
  </form>
 </details>;
}
export function AddSubscription(){
 const feed=useDataQuery<{subscriptionSetup:Setup|null}>(query);
 const setup=feed.status==='live'?feed.data?.subscriptionSetup:null;
 return setup&&setup.providers.length?<CreateForm key={setup.member} setup={setup}/>:null;
}
