import { useState, useSyncExternalStore } from 'react';
import { useRecords, call, type Call, type LiveRecord } from '../../data';
import { List, Row, Empty, Loading, Error, Button } from '../../kit';
interface Effect extends LiveRecord { title: string; kind: string; state: string }
function Receipt({ request }: { request: Call }) {
  const state=useSyncExternalStore(request.subscribe,request.getSnapshot);
  return state.pending ? <Loading label="Releasing…" /> : state.result?.ok===false ? <Error text={state.result.message} /> : null;
}
export default function Staging() {
  const {records,status}=useRecords<Effect>('core.effect');
  const [request,setRequest]=useState<Call>();
  return <section className="p-5 grid gap-4"><h1>Held outside work</h1><p>Staging holds wakes, bridge sends, body starts and push. Release one item when you intend it to reach outside.</p>
    {status==='loading'?<Loading />:status!=='live'?<Error text="Waiting for an authenticated connection." />:records.length?<List label="Held work">{records.map(effect=><Row key={effect.id} title={effect.title} status={`${effect.kind} · ${effect.state}`} actions={effect.state==='due'?<Button variant="outline" size="sm" onClick={()=>setRequest(call('core.releaseEffect',{id:effect.id}))}>Release this item</Button>:undefined} />)}</List>:<Empty title="No held work" />}
    {request&&<Receipt request={request} />}
  </section>;
}
