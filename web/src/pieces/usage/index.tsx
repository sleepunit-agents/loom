import {ToolbarFrame} from '../../kit/toolbar';
import {Fragment, useState} from 'react';
import {Empty, Error, Fact, Facts, Input, LinkButton, Loading, Reader, Row} from '../../kit';
import './usage.css';
import {useDataQuery} from '../../data/graphql';

import {byTokens,conversationsQuery,dayRange,format,groupTitle,jobsQuery,localDay,metrics,runKindWord,toolsLine,type UsageGroup as Group,type UsageJob as Job,type UsageRange as Range} from './model';
export {conversationsQuery,jobsQuery} from './model';

function Jobs({range,conversation}:{range:Range;conversation:string|null}) {
  const [selected,setSelected]=useState<string>();
  // Another date range keeps this conversation's last table until its own answers. A row is mounted per conversation,
  // so a kept table is never another conversation's.
  const {status,data,settling}=useDataQuery<{conversationJobUsage:Job[]}>(jobsQuery,{...range,conversation},{keep:true});
  if(status!=='live'||!data)return status==='loading'?<Loading label="Loading jobs…" />:<Error text="Job usage unavailable." />;
  if(!data.conversationJobUsage.length)return <Empty title="No jobs in this conversation for this period." />;
  return <section aria-label="Jobs in this conversation" aria-busy={settling||undefined}>
    {data.conversationJobUsage.map(({id,title,runKind,linkedWakeJob,state,usage,observations})=><Fragment key={id}>
      <Row title={title||id} selected={selected===id} aria-expanded={selected===id}
        meta={[runKindWord(runKind),state].filter(Boolean).join(' · ')}
        onClick={()=>setSelected(selected===id?undefined:id)}/>
      {selected===id&&<Reader data-inline aria-label={title||id}>
      <Facts>
        <Fact label="Job ID">{title && title!==id ? id : undefined}</Fact>
        <Fact label="Woke job">{linkedWakeJob}</Fact>
        <Fact label="Harness">{usage?.harness??'Unknown'}</Fact><Fact label="Model">{usage?.model??'Unknown'}</Fact>
        {Object.entries(metrics).map(([key,label])=><Fact key={key} label={label}>{format(usage?.[key as keyof typeof metrics])}</Fact>)}
        <Fact label="Calls by tool">{toolsLine(usage)}</Fact>
        <Fact label="Source">{usage?.source??'Pending'}</Fact>
      </Facts>
      {observations.map((words,index)=><p key={index}>{words}</p>)}
    </Reader>}</Fragment>)}
  </section>;
}
function Conversations({range}:{range:Range}) {
  const [open,setOpen]=useState<string|null>();
  // Another date range keeps the last table, and the conversation opened in it, until the new one answers.
  const {status,data,settling}=useDataQuery<{jobUsageRollup:Group[]}>(conversationsQuery,{...range},{keep:true});
  if(status!=='live'||!data)return status==='loading'?<Loading label="Loading conversations…" />:<Error text="Conversation usage unavailable." />;
  if(!data.jobUsageRollup.length)return <Empty title="No jobs in this period." />;
  const groups=byTokens(data.jobUsageRollup);
  return <table className="usage-groups" aria-label="Conversation usage" aria-busy={settling||undefined}><thead><tr><th scope="col">Conversation</th><th scope="col">Reported tokens</th><th scope="col">Peak context (tokens)</th><th scope="col">Jobs</th><th scope="col">Retries</th></tr></thead>
    <tbody>{groups.map(g=><Fragment key={JSON.stringify(g.key)}><tr><th scope="row"><LinkButton aria-expanded={open===g.key}
      onClick={()=>setOpen(open===g.key?undefined:g.key)}>{groupTitle(g)}</LinkButton></th>
      <td>{format(g.totalTokens)}</td><td>{format(g.largestContext)}<br/><small>{format(g.jobsWithLargestContext)} of {format(g.jobCount)} measured</small></td><td>{format(g.jobCount)}</td><td>{format(g.retryCount)}</td></tr>
      {open===g.key&&<tr><td colSpan={5}><Jobs conversation={g.key} range={range}/></td></tr>}
    </Fragment>)}</tbody></table>;
}
export default function Usage() {
  const [last,setLast]=useState(()=>localDay(0));
  const [first,setFirst]=useState(()=>localDay(-6));
  const valid=first&&last&&first<=last&&Number.isFinite(Date.parse(first))&&Number.isFinite(Date.parse(last));
  return <ToolbarFrame title="Job usage" controls={<fieldset className="usage-range"><legend>Date range ({Intl.DateTimeFormat().resolvedOptions().timeZone})</legend>
      <label>From <Input type="date" value={first} max={last} onChange={e=>setFirst(e.target.value)}/></label>
      <label> Through <Input type="date" value={last} min={first} onChange={e=>setLast(e.target.value)}/></label>
    </fieldset>}>
  <main className="usage-page" aria-label="Job usage">

    {valid?<Conversations range={dayRange(first,last)}/>:<p>Choose a valid date range.</p>}
  </main></ToolbarFrame>;
}
