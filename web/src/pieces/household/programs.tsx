import type {FormEvent} from 'react';
import {Button} from '../../kit';
import {programLine,programNote,type ProgramSetupData} from './model';
export {programQuery,type ProgramSetupData} from './model';
export function GrantChoices({catalogue,value}:{catalogue:ProgramSetupData['catalogue'];value?:{records:string[];operations:string[]}}){
 return <>{(['records','operations'] as const).map(field=><fieldset key={field} className="grid gap-1"><legend>{field==='records'?'Record types':'Operations'}</legend>{catalogue[field].map(name=><label key={name} className="flex gap-2"><input type="checkbox" name={field} value={name} defaultChecked={value?.[field].includes(name)}/>{name}</label>)}</fieldset>)}</>;
}
export function ProgramGrants({data,enabled,save}:{data:ProgramSetupData;enabled:boolean;save:(input:{fingerprint:string;records:FormDataEntryValue[];operations:FormDataEntryValue[]})=>Promise<void>}){
 const submit=(fingerprint:string,ended:boolean)=>(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!enabled||ended)return;const form=new FormData(event.currentTarget);void save({fingerprint,records:form.getAll('records'),operations:form.getAll('operations')});};
 return <section aria-label="Outside program grants" className="grid gap-4"><h2>Outside program grants</h2><p>{programNote}</p>{!data.tokens.length&&<p>No outside program tokens yet.</p>}{data.tokens.map(token=><form key={JSON.stringify(token)} aria-label={`Save grants for ${token.label}`} onSubmit={submit(token.fingerprint,token.ended)} className="grid gap-3 rounded-xl border p-4"><h3>{token.label}</h3><p>{programLine(token)}</p><fieldset disabled={!enabled||token.ended} className="grid gap-3"><GrantChoices catalogue={data.catalogue} value={token}/><Button disabled={!enabled||token.ended} type="submit">Save program grants</Button></fieldset></form>)}</section>;
}
