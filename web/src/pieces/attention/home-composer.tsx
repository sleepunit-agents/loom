import { useEffect, useRef, useState } from 'react';
import { memberOperation } from '../../data/operation';
import { MessageBar } from '../comms/composer';
import { readDraft, writeDraft, editDraft, clearDraft, type Draft } from '../comms/drafts';

/** The root authorizes both phases; private words occur only in send input.
 * A stable draft ID makes a deliberate retry target the same thread/message.
 * Drawn as the same bar Comms has under a thread (comms/composer.tsx). */
export function HomeMessageComposer({member,agent,name=agent,suggestedText,onOpened}:{member:string;agent:string;name?:string;suggestedText?:string;onOpened(id:string):void}) {
  const key=suggestedText ? `suggestion:${agent}:${suggestedText}` : `new:${agent}`;
  const [draft,setDraft]=useState(()=>{const saved=readDraft(member,key);return saved.text||!suggestedText?saved:editDraft(saved,suggestedText);});
  const current=useRef<Draft>(draft),mounted=useRef(true),locked=useRef(false);
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function edit(text:string) {
    const next=editDraft(current.current,text);current.current=next;setDraft(next);writeDraft(member,key,next);
  }
  async function send() {
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
  return <MessageBar name={name} value={draft.text} busy={pending} onChange={edit} onSend={send} status={pending?'Sending…':message}/>;
}
