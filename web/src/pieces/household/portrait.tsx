import { newId } from '../../data/id';
import {useState,useRef,type FormEvent} from 'react';
import {DOOR_REQUEST_BYTES} from '../../../../src/core/data/door-limit';
import {manifestFromPixelLab} from '../../../../src/pixellab-manifest';
import {SPRITE_MAX_BYTES} from '../../../../src/desk-sprite-layout';
import {Button,Field,Fields,Input} from '../../kit';
import {MemberOperationError,memberOperation} from '../../data/operation';

export const SHEET_LIMIT_WORDS='Choose a PNG sheet up to 4 MB.',METADATA_LIMIT_WORDS='Choose PixelLab animation JSON up to 1 MB.';
/** A portrait as household.setPortrait takes it, from the two chosen files, each checked against loom's limits
 * before anything is sent. Shared with the boards' household brick (web/src/boards/bricks-household-portrait.tsx). */
export async function readPortraitFiles(sheet:unknown,metadata:unknown){
  if(!(sheet instanceof File)||!sheet.size||sheet.size>SPRITE_MAX_BYTES)throw Error(SHEET_LIMIT_WORDS);
  if(!(metadata instanceof File)||!metadata.size||metadata.size>DOOR_REQUEST_BYTES)throw Error(METADATA_LIMIT_WORDS);
  const layout=manifestFromPixelLab(JSON.parse(await metadata.text()));
  const png=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(Error('Could not read the sheet.'));
    reader.readAsDataURL(sheet);
  });
  return {layout,png};
}
async function readPortrait(form:HTMLFormElement){
  const files=new FormData(form);
  return readPortraitFiles(files.get('png'),files.get('metadata'));
}
/** What loom's refusal (a 4xx) of a portrait change means, in the desktop's words. */
export const portraitRefusal=(status:number)=>status===409?'The portrait changed. Review the current face and choose the files again.':
  (status===401||status===403)?'Sign in as a household owner to change a portrait.':
  'Choose a valid PNG sheet up to 16 megapixels and its matching PixelLab animation JSON.';
export type PortraitInput={agent:string;version:string|null;portrait:Awaited<ReturnType<typeof readPortraitFiles>>|null};
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
