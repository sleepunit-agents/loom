import {conversationTitle} from '../../data/conversation-title';
import {useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {Button,Empty,Error,Loading} from '../../kit';
import {conversationActivityQuery,type ConversationActivityData,type ConversationTurn} from './conversation-query';
import {briefTime,fullTime} from '../../kit/time';

/** A step's stored kind, who it was from and how it ended, in plain words (the schema's own values: turns.kind,
 * turns.from_kind, turns.outcome). One that is not listed is said as stored, with spaces for its underscores. */
const plain=(value:string)=>value.replace(/[_-]+/g,' ');
const kindWords:Record<string,string>={message:'Message',reply:'Reply',action:'Step',wake:'Wake',note:'Note',refused:'Refused'};
const fromWords:Record<string,string>={person:'a person',agent:'an agent',schedule:'a schedule',unknown:'someone unknown'};
const outcomeWords:Record<string,string>={answered:'answered',progressed:'made progress',deferred:'put off',failed:'failed',none:''};
function said(step:ConversationTurn){
 const outcome=step.outcome?outcomeWords[step.outcome]??plain(step.outcome):'';
 return `${kindWords[step.kind]??plain(step.kind)} from ${step.fromId??fromWords[step.fromKind]??plain(step.fromKind)}${outcome?` · ${outcome}`:''}`;
}

/** The canonical client owns results; pagination retains only a sequence cursor. */
export function ConversationActivity({conversation}:{conversation:string}){
 const [before,setBefore]=useState(2147483647);
 // An earlier page keeps the steps on screen until it answers. This is mounted per conversation (keyed by it),
 // so kept steps are never another conversation's.
 const result=useDataQuery<ConversationActivityData>(conversationActivityQuery,{id:conversation,before},{keep:true});
 const activity=result.status==='live'?result.data?.activity:undefined;
 const receipt=activity&&result.data?.latestBridgeReceipt;
 const steps=activity?.turnsByConversation??[];
 const timezone=result.status==='live'?result.data?.deskTime?.timezone:undefined;
 return <article className="flex h-full min-h-0 flex-col">
  <header className="grid gap-2 border-b p-4"><h1>Conversation activity</h1>{activity&&<p>{conversationTitle(activity)}</p>}
   {receipt&&<p>Your message at {fullTime(receipt.receivedAt,timezone)} · {receipt.acceptedAt
    ? receipt.agent+' received it at '+fullTime(receipt.acceptedAt,timezone) : 'No body acknowledgment recorded'}
    {' · '}{receipt.replied?'Reply sent':'No sent reply recorded'}</p>}</header>
  <div className="min-h-0 flex-1 overflow-auto p-4" aria-label="Conversation activity" aria-busy={result.settling||undefined}>
   {result.status==='loading'?<Loading label="Opening conversation activity…"/>:result.status!=='live'?<Error text="Waiting for your signed-in connection."/>:!activity?<Empty title="Conversation unavailable"/>:<>
    <div className="flex gap-2"><Button variant="outline" onClick={()=>setBefore(steps.at(-1)!.seq)} disabled={steps.length<50||result.settling}>Load earlier activity</Button>{before!==2147483647&&<Button variant="outline" onClick={()=>setBefore(2147483647)}>Latest activity</Button>}</div>
    {!steps.length?<Empty title="No retained activity"/>:<ol className="grid gap-3">{[...steps].reverse().map(step=><li key={step.seq} className="rounded border p-3">
     <p><time dateTime={step.at} title={fullTime(step.at,timezone)}>{briefTime(step.at,timezone)}</time></p>
     <p>{said(step)}</p>
    </li>)}</ol>}
   </>}
  </div>
 </article>;
}
