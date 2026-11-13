/** Device-local drafts only, partitioned by member and thread. Never sent until Send. */
export const draftKey=(member:string,thread:string)=>`loom:comms:draft:${encodeURIComponent(member)}:${encodeURIComponent(thread)}`;
export function readDraft(member:string,thread:string):string {try{return localStorage.getItem(draftKey(member,thread))??'';}catch{return '';}}
export function writeDraft(member:string,thread:string,text:string){try{const key=draftKey(member,thread);if(text)localStorage.setItem(key,text);else localStorage.removeItem(key);}catch{/* Storage denied: the current editor still keeps its draft. */}}
