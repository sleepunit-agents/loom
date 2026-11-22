import {useRef,useState} from 'react';
import {Actions,Button} from '../../kit';
import {MemberOperationError,memberOperation} from '../../data/operation';
import type {InboxItem} from '../inbox-view/model';

export function WorkerJoinCard({item}:{item:InboxItem}) {
  const locked=useRef(false);
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const match=/^worker-join:([a-f0-9-]{36}):([A-Z2-9]{4}-[A-Z2-9]{4})$/.exec(item.sourceId??'');
  if (!match || item.state!=='waiting') return null;
  const [,request,code]=match;
  async function decide(decision:'allow'|'block') {
    if (locked.current) return;
    locked.current=true;setBusy(true);setMessage('');
    try {
      await memberOperation('runtime.workerJoinDecide',{request,code,decision});
      setMessage(decision==='allow'?'Machine admitted.':'Join request blocked.');
    } catch(error) {
      locked.current=false;setBusy(false);
      setMessage(error instanceof MemberOperationError && error.status===403
        ? 'Sign in again as a household owner to answer.' : 'Could not save this decision. Check the request and try again.');
    }
  }
  return <>
    <Actions label="Worker admission">
      <Button variant="primary" disabled={busy} onClick={()=>void decide('allow')}>Let it in</Button>
      <Button disabled={busy} onClick={()=>void decide('block')}>Block</Button>
    </Actions>
    {message && <p role="status">{message}</p>}
  </>;
}
