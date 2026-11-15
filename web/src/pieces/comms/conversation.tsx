import {useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {Button,Empty,Error,Loading} from '../../kit';
import {conversationActivityQuery,type ConversationActivityData} from './conversation-query';

/** The canonical client owns results; pagination retains only a sequence cursor. */
export function ConversationActivity({conversation}:{conversation:string}){
 const [before,setBefore]=useState(2147483647);
 const result=useDataQuery<ConversationActivityData>(conversationActivityQuery,{id:conversation,before});
 const activity=result.status==='live'?result.data?.activity:undefined;
 const steps=activity?.turnsByConversation??[];
 return <article className="flex h-full min-h-0 flex-col">
  <header className="grid gap-2 border-b p-4"><h1>Conversation activity</h1>{activity&&<p>{activity.label}</p>}</header>
  <div className="min-h-0 flex-1 overflow-auto p-4" aria-label="Conversation activity">
   {result.status==='loading'?<Loading label="Opening conversation activity…"/>:result.status!=='live'?<Error text="Waiting for your signed-in connection."/>:!activity?<Empty title="Conversation unavailable"/>:<>
    <div className="flex gap-2"><Button variant="outline" onClick={()=>setBefore(steps.at(-1)!.seq)} disabled={steps.length<50}>Load earlier activity</Button>{before!==2147483647&&<Button variant="outline" onClick={()=>setBefore(2147483647)}>Latest activity</Button>}</div>
    {!steps.length?<Empty title="No retained activity"/>:<ol className="grid gap-3">{[...steps].reverse().map(step=><li key={step.seq} className="rounded border p-3">
     <p><time dateTime={step.at}>{new Date(step.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT</time></p>
     <p>{step.kind} · {step.fromId??step.fromKind}{step.outcome&&` · ${step.outcome}`}</p>
    </li>)}</ol>}
   </>}
  </div>
 </article>;
}
