import { useRecords } from '../../data';
import { Loading } from '../../kit';
interface WorkItem {ref:string;title:string;status:string;from:string;url:string;tone?:'bad'|'warn'|'ok'}
interface ThreadWork {id:string;items:WorkItem[];failed:string[];[key:string]:unknown}
export function Work({thread}:{thread:string}) {
 const {records,status}=useRecords<ThreadWork>('threadWork',thread),work=records.find(r=>r.id===thread);
 return <details><summary>Work in this thread</summary><section aria-label="Work in this thread" className="max-h-60 overflow-auto py-2">
  {status!=='live'?<Loading label="Waiting for work connection…"/>:!work?<p>Work unavailable</p>:<>
   {work.failed.length>0&&<p role="status">Couldn't read: {work.failed.join(', ')}.</p>}
   {work.items.length===0?<p>No work made here yet.</p>:<ul className="grid gap-2">{work.items.map(item=><li key={item.ref} data-tone={item.tone}><a href={item.url}>{item.title}</a><p>{item.ref} · {item.status} · Made here</p></li>)}</ul>}
  </>}
 </section></details>;
}
