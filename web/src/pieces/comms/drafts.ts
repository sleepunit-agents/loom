import { newId } from '../../comms-id';

/** Device-local drafts only, partitioned by member and thread. Never sent until Send. */
export const draftKey=(member:string,thread:string)=>`loom:comms:draft:${encodeURIComponent(member)}:${encodeURIComponent(thread)}`;
export interface Draft { id:string; text:string }
const storedKey=(member:string,thread:string)=>`${draftKey(member,thread)}:v1`;
export function editDraft(previous:Draft,text:string):Draft {
 return text===previous.text?previous:{id:text?newId():'',text};
}
export function readDraft(member:string,thread:string):Draft {
 try {
  const raw=localStorage.getItem(storedKey(member,thread));
  if(raw!==null){const value:unknown=JSON.parse(raw);if(value&&typeof value==='object'&&'id' in value&&'text' in value&&typeof value.id==='string'&&/^[a-z2-7]{16}$/.test(value.id)&&typeof value.text==='string')return {id:value.id,text:value.text};}
  // Upgrade old text-only drafts once, retaining their words.
  const text=localStorage.getItem(draftKey(member,thread))??'';
  const draft=editDraft({id:'',text:''},text);writeDraft(member,thread,draft);return draft;
 }catch{return {id:'',text:''};}
}
export function writeDraft(member:string,thread:string,draft:Draft){
 try {
  const key=storedKey(member,thread);
  if(draft.text)localStorage.setItem(key,JSON.stringify(draft));else localStorage.removeItem(key);
  localStorage.removeItem(draftKey(member,thread));
 }catch{/* Storage denied: the current editor still keeps its draft and retry id. */}
}
/** An acknowledgement from one window must not erase a newer draft in another. */
export function clearDraft(member:string,thread:string,sent:Draft){
 try {
  const raw=localStorage.getItem(storedKey(member,thread));
  if(raw!==null){const current=JSON.parse(raw) as Draft;if(current.id===sent.id&&current.text===sent.text)localStorage.removeItem(storedKey(member,thread));}
 }catch{/* The current editor can still clear its own acknowledged draft. */}
}
