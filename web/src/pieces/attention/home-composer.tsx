import { useEffect, useRef, useState, type FormEvent } from 'react';
import { memberOperation } from '../../data/operation';
import { Button, Textarea } from '../../kit';
import { readDraft, writeDraft, editDraft, clearDraft, type Draft } from '../comms/drafts';
import { bindComposerViewport } from '../comms/viewport';

/** The root authorizes both phases; private words occur only in send input.
 * A stable draft ID makes a deliberate retry target the same thread/message. */
export function HomeMessageComposer({member,agent,onOpened}:{member:string;agent:string;onOpened(id:string):void}) {
  const key=`new:${agent}`;
  const form=useRef<HTMLFormElement>(null),input=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>form.current?bindComposerViewport(form.current):undefined,[]);
  const [draft,setDraft]=useState(()=>readDraft(member,key));
  const current=useRef<Draft>(draft),mounted=useRef(true),locked=useRef(false);
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function edit(text:string) {
    const next=editDraft(current.current,text);current.current=next;setDraft(next);writeDraft(member,key,next);
  }
  async function send(event:FormEvent) {
    event.preventDefault();
    if(locked.current||!current.current.text.trim())return;
    const sent=current.current,thread=`th:${sent.id}`;
    locked.current=true;setPending(true);setMessage('');
    try {
      const opened=await memberOperation<{thread:string}>('comms.open',{thread,agent});
      if(!mounted.current)return;
      if(opened?.thread!==thread)throw Error('Could not confirm the conversation. Draft kept.');
      const posted=await memberOperation<{thread:string;seq:number}>('comms.send',{thread,clientId:sent.id,words:sent.text});
      if(posted?.thread!==thread)throw Error('Could not confirm the message. Draft kept.');
      clearDraft(member,key,sent);
      if(mounted.current){
        if(current.current===sent){const empty={id:'',text:''};current.current=empty;setDraft(empty);}
        onOpened(thread);
      }
    } catch(error) {
      if(mounted.current)setMessage(error instanceof Error?error.message:'Could not confirm the message. Draft kept.');
    } finally {locked.current=false;if(mounted.current)setPending(false);}
  }
  return <form ref={form} onSubmit={send} className="grid gap-2 border-t p-4">
    <label>Message<Textarea ref={input} value={draft.text} maxLength={100000} rows={3} disabled={pending} onChange={event=>edit(event.target.value)}/></label>
    <Button type="submit" onPointerDown={event=>{if(event.button===0&&document.activeElement===input.current)event.preventDefault();}} disabled={pending||!draft.text.trim()}>Send</Button>
    <p role="status">{pending?'Sending…':message}</p>
  </form>;
}
