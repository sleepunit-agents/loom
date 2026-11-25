import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { useAgentNames } from '../../data/names';
import { memberOperation } from '../../data/operation';
import { Error, LinkButton } from '../../kit';
import { displayName } from '../../kit/words';
import { threadPath } from '../attention/home-comms-data';

const query='query WorkDiscussionAgent($kind:String!,$id:String!){workDiscussionAgent(kind:$kind,id:$id)}';

export function WorkDiscussion({kind,id,go}:{kind:'ticket'|'project';id:string;go:(href:string)=>void}) {
  const audience = useDataQuery<{workDiscussionAgent:string|null}>(query,{kind,id});
  const agent = audience.status==='live' && !audience.settling ? audience.data?.workDiscussionAgent : null;
  const names = useAgentNames(), mounted = useRef(true), pending = useRef(false);
  const [state,setState] = useState<'idle'|'opening'|'failed'>('idle');
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  async function open() {
    if (!agent || pending.current) return;
    pending.current=true;
    setState('opening');
    try {
      const result=await memberOperation<{thread:string}>('work.discuss',{kind,id,agent});
      if (mounted.current) { setState('idle'); go(threadPath(result.thread)); }
    } catch { if (mounted.current) setState('failed'); }
    finally { pending.current=false; }
  }
  if (!agent) return null;
  return <>
    <LinkButton disabled={state==='opening'} onClick={()=>void open()}>
      {state==='opening' ? 'Opening conversation…' : 'Discuss privately with '+displayName(agent,names)}
    </LinkButton>
    {state==='failed' && <Error text="Could not open the discussion. Try again."/>}
  </>;
}
