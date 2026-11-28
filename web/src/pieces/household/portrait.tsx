import { newId } from '../../data/id';
import {useState,useRef,type FormEvent} from 'react';
import {portraitRefusal,readPortraitFiles,type PortraitInput} from './portrait-request';
import {Button,Field,Fields,Input} from '../../kit';
import {MemberOperationError,memberOperation} from '../../data/operation';

async function readPortrait(form:HTMLFormElement){
  const files=new FormData(form);
  return readPortraitFiles(files.get('png'),files.get('metadata'));
}
type Request={id:string;input:PortraitInput};

export function Portrait({agent,version,enabled}:{agent:string;version:string|null;enabled:boolean}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [retry,setRetry]=useState<Request>();
  const selection=useRef<{version:string|null}|undefined>(undefined);
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget;
    const action=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    let request:Request|undefined;
    setBusy(true);setMessage('');
    const reset=()=>{selection.current=undefined;setRetry(undefined);form.reset();};
    try{
      if(action==='retry'){
        if(!retry)return;
        request=retry;
      }else{
        if(action!=='remove'&&selection.current?.version!==version){
          reset();throw Error('The portrait changed while you were choosing files. Review it and choose the files again.');
        }
        const portrait=action==='remove'?null:await readPortrait(form);
        request={id:newId(),input:{agent,version,portrait}};
      }
      await memberOperation('household.setPortrait',request.input,request.id);
      reset();setMessage(request.input.portrait?'Animated portrait saved.':'Generated face restored.');
    }catch(error){
      if(error instanceof MemberOperationError&&error.status>=400&&error.status<500){
        reset();
        setMessage(portraitRefusal(error.status));
      }else if(request){
        setRetry(request);setMessage('Could not confirm the change. Retry to check or finish it.');
      }else setMessage(error instanceof Error?error.message:'Could not read this portrait.');
    }finally{setBusy(false);}
  }
  return <form aria-label={`Animated portrait for ${agent}`} onChange={()=>{selection.current??={version};setRetry(undefined);}} onSubmit={event=>void save(event)}>
    <Fields className="grid gap-2" disabled={!enabled||busy}>
      <Field label="PixelLab sprite sheet"><Input name="png" type="file" accept="image/png" required/></Field>
      <Field label="PixelLab animation JSON"><Input name="metadata" type="file" accept=".json,application/json" required/></Field>
      {retry?<Button type="submit" value="retry" formNoValidate>Retry portrait change</Button>:
        <Button type="submit">{version?'Replace portrait':'Add portrait'}</Button>}
      {version&&!retry&&<Button type="submit" value="remove" formNoValidate variant="outline">Use generated face</Button>}
    </Fields>
    {message&&<p role="status">{message}</p>}
  </form>;
}
