import { useState } from 'react';
import { useRecords } from '../../data';
import { Button, Loading } from '../../kit';
interface WorkItem {ref:string;title:string;status:string;from:string;url:string;tone?:'bad'|'warn'|'ok'}
interface ThreadWork {id:string;items:WorkItem[];failed:string[];[key:string]:unknown}
export function Work({thread,agent,member}:{thread:string;agent:string;member:string}) {
 const {records,status}=useRecords<ThreadWork>('threadWork',thread),work=status==='live'?records.find(r=>r.id===thread):undefined;
 const [open,setOpen]=useState(false),bad=work?.items.filter(item=>item.tone==='bad').length??0;
 return <aside className="comms-work border-b p-3" data-open={open||undefined}>
  <div className="comms-work-strip"><Button variant="outline" aria-expanded={open} onClick={()=>setOpen(!open)}>Work{work?` (${work.items.length}${bad?` · ${bad} needs a look`:''})`:''}</Button></div>
  <div className="comms-work-body">
   <div className="comms-work-desktop"><h2>In this conversation</h2><p>{agent} and {member}</p><h2>Work in this thread</h2></div>
   <section aria-label="Work in this thread" className="grid gap-2 py-2">
    {status!=='live'?<Loading label="Waiting for work connection…"/>:!work?<p>Work unavailable</p>:<>
     {work.failed.map(piece=><p key={piece} role="status">{piece} didn't answer.</p>)}
     {work.items.length===0?<p>No work made here yet.</p>:<ul className="grid gap-2">{work.items.map(item=><li key={item.ref}><a href={item.url}>{item.title}</a><p><span data-tone={item.tone} className="rounded border px-1">{item.status}</span> · <span className="font-mono">{item.ref}</span> · Made here</p></li>)}</ul>}
    </>}
   </section>
  </div>
 </aside>;
}
