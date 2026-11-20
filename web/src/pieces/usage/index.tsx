import {Fragment, useState} from 'react';
import {Empty, Error, Fact, Facts, Input, LinkButton, Loading, Meta, Reader, Title} from '../../kit';
import './usage.css';
import {useDataQuery} from '../../data/graphql';

export const conversationsQuery = `query UsageConversations($from:String!, $to:String!) {
  jobUsageRollup(from:$from,to:$to,groupBy:"conversation"){key title totalTokens jobCount retryCount}
}`;
export const jobsQuery = `query UsageJobs($from:String!, $to:String!, $conversation:String) {
  conversationJobUsage(from:$from,to:$to,conversation:$conversation){id title runKind linkedWakeJob state observations usage{
    harness model source tokensIn tokensOut cacheRead cacheWritten modelCalls toolCalls tools{name count} largestContext wallMs
  }}
}`;
interface Group {key:string|null; title:string|null; totalTokens:number|null; jobCount:number; retryCount:number}
const metrics = {
  tokensIn:'Input tokens',tokensOut:'Output tokens',cacheRead:'Cache read',cacheWritten:'Cache written',
  modelCalls:'Model calls',toolCalls:'Tool calls',largestContext:'Largest context',wallMs:'Wall time (ms)',
} as const;
type Measurement = Record<keyof typeof metrics,number|null> & {
  harness:string|null; model:string|null; source:string; tools:{name:string;count:number}[]|null;
};
interface Job {id:string;title:string;runKind:string|null;linkedWakeJob:string|null;state:string;observations:string[];usage:Measurement|null}
interface Range {from:string;to:string}
const format=(value:number|null|undefined)=>value==null?'Unknown':value.toLocaleString();

function Jobs({range,conversation}:{range:Range;conversation:string|null}) {
  // Another date range keeps this conversation's last table until its own answers. A row is mounted per conversation,
  // so a kept table is never another conversation's.
  const {status,data,settling}=useDataQuery<{conversationJobUsage:Job[]}>(jobsQuery,{...range,conversation},{keep:true});
  if(status!=='live'||!data)return status==='loading'?<Loading label="Loading jobs…" />:<Error text="Job usage unavailable." />;
  if(!data.conversationJobUsage.length)return <Empty title="No jobs in this conversation for this period." />;
  return <section aria-label="Jobs in this conversation" aria-busy={settling||undefined}>
    {data.conversationJobUsage.map(({id,title,runKind,linkedWakeJob,state,usage,observations})=><Reader key={id} data-inline>
      <header><Meta>{[runKind && (runKind==='program'?'Program':runKind==='main'?'Main session':'Subagent'),state].filter(Boolean).join(' · ')}</Meta>
        <Title>{title||id}</Title></header>
      <Facts>
        <Fact label="Job ID">{title && title!==id ? id : undefined}</Fact>
        <Fact label="Woke job">{linkedWakeJob}</Fact>
        <Fact label="Harness">{usage?.harness??'Unknown'}</Fact><Fact label="Model">{usage?.model??'Unknown'}</Fact>
        {Object.entries(metrics).map(([key,label])=><Fact key={key} label={label}>{format(usage?.[key as keyof typeof metrics])}</Fact>)}
        <Fact label="Calls by tool">{usage?.tools ? usage.tools.map(tool=>tool.name+' × '+format(tool.count)).join(', ')||'None' : 'Unknown'}</Fact>
        <Fact label="Source">{usage?.source??'Pending'}</Fact>
      </Facts>
      {observations.map((words,index)=><p key={index}>{words}</p>)}
    </Reader>)}
  </section>;
}
function Conversations({range}:{range:Range}) {
  const [open,setOpen]=useState<string|null>();
  // Another date range keeps the last table, and the conversation opened in it, until the new one answers.
  const {status,data,settling}=useDataQuery<{jobUsageRollup:Group[]}>(conversationsQuery,{...range},{keep:true});
  if(status!=='live'||!data)return status==='loading'?<Loading label="Loading conversations…" />:<Error text="Conversation usage unavailable." />;
  if(!data.jobUsageRollup.length)return <Empty title="No jobs in this period." />;
  const groups=[...data.jobUsageRollup].sort((a,b)=>(b.totalTokens??-1)-(a.totalTokens??-1)||(a.key??'').localeCompare(b.key??''));
  return <table className="usage-groups" aria-label="Conversation usage" aria-busy={settling||undefined}><thead><tr><th scope="col">Conversation</th><th scope="col">Reported tokens</th><th scope="col">Jobs</th><th scope="col">Retries</th></tr></thead>
    <tbody>{groups.map(g=><Fragment key={JSON.stringify(g.key)}><tr><th scope="row"><LinkButton aria-expanded={open===g.key}
      onClick={()=>setOpen(open===g.key?undefined:g.key)}>{g.title||g.key||'Jobs without a conversation'}</LinkButton></th>
      <td>{format(g.totalTokens)}</td><td>{format(g.jobCount)}</td><td>{format(g.retryCount)}</td></tr>
      {open===g.key&&<tr><td colSpan={4}><Jobs conversation={g.key} range={range}/></td></tr>}
    </Fragment>)}</tbody></table>;
}
function localDay(offset:number) {
  const date=new Date();
  date.setDate(date.getDate()+offset);
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
function midnight(day:string,offset=0) {
  const date=new Date(day+'T00:00:00');
  date.setDate(date.getDate()+offset);
  return date;
}
export default function Usage() {
  const [last,setLast]=useState(()=>localDay(0));
  const [first,setFirst]=useState(()=>localDay(-6));
  const valid=first&&last&&first<=last&&Number.isFinite(Date.parse(first))&&Number.isFinite(Date.parse(last));
  return <main className="usage-page" aria-label="Job usage">
    <fieldset><legend>Date range ({Intl.DateTimeFormat().resolvedOptions().timeZone})</legend>
      <label>From <Input type="date" value={first} max={last} onChange={e=>setFirst(e.target.value)}/></label>
      <label> Through <Input type="date" value={last} min={first} onChange={e=>setLast(e.target.value)}/></label>
    </fieldset>
    {valid?<Conversations range={{from:midnight(first).toISOString(),to:midnight(last,1).toISOString()}}/>:<p>Choose a valid date range.</p>}
  </main>;
}
