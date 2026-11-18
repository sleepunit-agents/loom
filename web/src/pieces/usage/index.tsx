import {Fragment, useState} from 'react';
import {useDataQuery} from '../../data/graphql';

export const conversationsQuery = `query UsageConversations($from:String!, $to:String!) {
  jobUsageRollup(from:$from,to:$to,groupBy:"conversation"){key title totalTokens jobCount retryCount}
}`;
export const jobsQuery = `query UsageJobs($from:String!, $to:String!, $conversation:String) {
  conversationJobUsage(from:$from,to:$to,conversation:$conversation){id title runKind state observations usage{
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
interface Job {id:string;title:string;runKind:string|null;state:string;observations:string[];usage:Measurement|null}
interface Range {from:string;to:string}
const format=(value:number|null|undefined)=>value==null?'Unknown':value.toLocaleString();

function Jobs({range,conversation}:{range:Range;conversation:string|null}) {
  const {status,data}=useDataQuery<{conversationJobUsage:Job[]}>(jobsQuery,{...range,conversation});
  if(status!=='live'||!data)return <p>{status==='loading'?'Loading jobs…':'Job usage unavailable.'}</p>;
  return <table><caption>Jobs in this conversation</caption><thead><tr>
    <th>Job</th><th>State</th><th>Harness</th><th>Model</th>{Object.values(metrics).map(label=><th key={label}>{label}</th>)}
    <th>Calls by tool</th><th>Source</th><th>Observations</th>
  </tr></thead><tbody>{data.conversationJobUsage.map(({id,title,runKind,state,usage,observations})=><tr key={id}>
    <th scope="row">{runKind && <span>{runKind==='main'?'Main session':'Subagent'} · </span>}{title||id}{title&&title!==id&&<small> ({id})</small>}</th><td>{state}</td><td>{usage?.harness??'Unknown'}</td><td>{usage?.model??'Unknown'}</td>
    {(Object.keys(metrics) as (keyof typeof metrics)[]).map(key=><td key={key}>{format(usage?.[key])}</td>)}
    <td>{usage?.tools ? usage.tools.map(tool=>tool.name+' × '+format(tool.count)).join(', ')||'None' : 'Unknown'}</td>
    <td>{usage?.source??'Pending'}</td><td>{observations.join(' ')}</td>
  </tr>)}</tbody></table>;
}
function Conversations({range}:{range:Range}) {
  const [open,setOpen]=useState<string|null>();
  const {status,data}=useDataQuery<{jobUsageRollup:Group[]}>(conversationsQuery,{...range});
  if(status!=='live'||!data)return <p>{status==='loading'?'Loading conversations…':'Conversation usage unavailable.'}</p>;
  if(!data.jobUsageRollup.length)return <p>No jobs in this period.</p>;
  const groups=[...data.jobUsageRollup].sort((a,b)=>(b.totalTokens??-1)-(a.totalTokens??-1)||(a.key??'').localeCompare(b.key??''));
  return <table><thead><tr><th>Conversation</th><th>Reported tokens</th><th>Jobs</th><th>Retries</th></tr></thead>
    <tbody>{groups.map(g=><Fragment key={JSON.stringify(g.key)}><tr><th scope="row"><button aria-expanded={open===g.key}
      onClick={()=>setOpen(open===g.key?undefined:g.key)}>{g.title||g.key||'Jobs without a conversation'}</button></th>
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
  return <main style={{padding:'1rem',overflow:'auto'}}><h1>Job usage</h1>
    <fieldset><legend>Date range ({Intl.DateTimeFormat().resolvedOptions().timeZone})</legend>
      <label>From <input type="date" value={first} max={last} onChange={e=>setFirst(e.target.value)}/></label>
      <label> Through <input type="date" value={last} min={first} onChange={e=>setLast(e.target.value)}/></label>
    </fieldset>
    {valid?<Conversations range={{from:midnight(first).toISOString(),to:midnight(last,1).toISOString()}}/>:<p>Choose a valid date range.</p>}
  </main>;
}
