import {useEffect,useState} from 'react';
import { newId } from '../../comms-id';

/** Device-local drafts only, partitioned by member and thread. Never sent until Send. */
export const draftKey=(member:string,thread:string)=>`loom:comms:draft:${encodeURIComponent(member)}:${encodeURIComponent(thread)}`;
export interface Draft { id:string; text:string }
const eventName='loom:comms-draft';
function notify(member:string,thread:string){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(eventName,{detail:storedKey(member,thread)}));}
const storedKey=(member:string,thread:string)=>`${draftKey(member,thread)}:v1`;
export function editDraft(previous:Draft,text:string):Draft {
 return text===previous.text?previous:{id:text?newId():'',text};
}
export function readDraft(member:string,thread:string):Draft {
 try {
  const raw=localStorage.getItem(storedKey(member,thread));
  if(raw!==null){const value:unknown=JSON.parse(raw);if(value&&typeof value==='object'&&'id' in value&&'text' in value&&typeof value.id==='string'&&/^[a-z2-7]{16}$/.test(value.id)&&typeof value.text==='string')return {id:value.id,text:value.text};}
  // Upgrade old text-only drafts once, retaining their words.
  // Reading where nothing was kept writes nothing.
  const old=localStorage.getItem(draftKey(member,thread));if(old===null)return {id:'',text:''};
  const draft=editDraft({id:'',text:''},old);writeDraft(member,thread,draft,false);return draft;
 }catch{return {id:'',text:''};}
}
export function writeDraft(member:string,thread:string,draft:Draft,broadcast=true){
 try {
  const key=storedKey(member,thread);
  if(draft.text)localStorage.setItem(key,JSON.stringify(draft));else localStorage.removeItem(key);
  localStorage.removeItem(draftKey(member,thread));
  if(broadcast)notify(member,thread);
 }catch{/* Storage denied: the current editor still keeps its draft and retry id. */}
}
/** An acknowledgement from one window must not erase a newer draft in another. */
export function clearDraft(member:string,thread:string,sent:Draft){
 try {
  const raw=localStorage.getItem(storedKey(member,thread));
  if(raw!==null){const current=JSON.parse(raw) as Draft;if(current.id===sent.id&&current.text===sent.text){localStorage.removeItem(storedKey(member,thread));notify(member,thread);}}
 }catch{/* The current editor can still clear its own acknowledged draft. */}
}

/** Same-document acknowledgements can arrive after a query remounts its editor.
 * Storage events carry other-window edits; this event covers the current page. */
export function useCommsDraft(member:string,thread:string,enabled=true){
 const [value,setValue]=useState<Draft>(()=>enabled?readDraft(member,thread):{id:'',text:''});
 useEffect(()=>{
  if(!enabled||typeof window==='undefined')return;
  const local=(event:Event)=>{if((event as CustomEvent).detail===storedKey(member,thread))setValue(readDraft(member,thread));};
  const external=(event:StorageEvent)=>{if(event.key===null||event.key===storedKey(member,thread)||event.key===draftKey(member,thread))setValue(readDraft(member,thread));};
  window.addEventListener(eventName,local);window.addEventListener('storage',external);
  return()=>{window.removeEventListener(eventName,local);window.removeEventListener('storage',external);};
 },[member,thread,enabled]);
 return {value,edit(text:string){const next=editDraft(value,text);setValue(next);writeDraft(member,thread,next);},acknowledged(sent:Draft){clearDraft(member,thread,sent);setValue(current=>current.id===sent.id&&current.text===sent.text?readDraft(member,thread):current);}};
}
