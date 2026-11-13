import { useRef, useState } from 'react';
import { useRecords, type Snapshot } from '../../data';
import { AppFrame, Button, Empty, Error, List, Loading, Row } from '../../kit';
import { AskReader, AnswerReceipt, stamp, type Guard } from './index';
import { useWaitChecks } from './wait-checks';
import type { Ask } from './model';
import { currentRuntimeJobs, type RuntimeJob, inboxPath, latestStatus, namedAgents, openAsks, orderedAgents, reportLink, type AgentPerson, type AgentStatus, type OwnedAgent, type ReportedItem } from './home-model';
import { deskJobs, agentNext } from '../../../../src/pieces/clock/desk';
import { active, time, state, type Wake, type Clock } from '../clock/model';
function Unavailable({ status, label }: { status: Snapshot['status']; label: string }) {
  return status === 'loading' ? <Loading label={`Opening ${label}…`} /> : <Error title={`Couldn’t load ${label}`} text={status === 'denied' ? 'Sign in with access to see this.' : 'Waiting for connection.'} />;
}
function ReportedItems({ title, empty, items, go }: { title: string; empty: string; items: ReportedItem[]; go(path: string): void }) {
  return <section aria-label={title} className="grid min-w-0 gap-2">
    <h3>{title} · {items.length}</h3>
    {!items.length ? <p>{empty}</p> : <List label={title}>{items.map((item, index) => {
      const link = reportLink(item.href);
      return link?.app ? <Row key={`${item.id}:${index}`} title={item.label || item.id} onClick={()=>go(link.href)} /> :
        <p key={`${item.id}:${index}`} className="min-w-0 py-2">{link ? <a className="underline" href={link.href} target="_blank" rel="noopener noreferrer">{item.label || item.id}</a> : item.label || item.id}</p>;
    })}</List>}
  </section>;
}
export default function Home({ go = path => location.assign(path) }: { go?: (path:string)=>void } = {}) {
  const roster = useRecords<OwnedAgent>('attention.ownedAgent');
  const people = useRecords<AgentPerson>('person');
  const agents = namedAgents(roster.records, people.status === 'live' ? people.records : []);
  const asks = useRecords<Ask>('attention.ask');
  useWaitChecks(asks);
  const wakes = useRecords<Wake>('wake');
  const clocks = useRecords<Clock>('clock');
  const statuses = useRecords<AgentStatus>('attention.agent');
  const runtime = useRecords<RuntimeJob>('runtime.job');
  const lock = useRef(false), [busy,setBusy] = useState(false);
  const guard: Guard = {lock,busy,setBusy};
  const columns = roster.records.length <= 1 ? '' : roster.records.length === 2 || roster.records.length === 4 ? 'lg:grid-cols-2' : 'lg:grid-cols-3';
  const open = asks.status === 'live' ? openAsks(asks.records) : [];
  return <div className="h-full w-full min-w-0 max-w-full overflow-auto [overflow-wrap:anywhere]" data-attention-home="">
    <div className="p-4"><AppFrame title="Home" where="Home" go={go} actions={<Button variant="outline" onClick={()=>go(inboxPath())}>Inbox</Button>}>
      <div className="grid min-w-0 gap-5">
        <section aria-label="Needs you" className="grid min-w-0 gap-2">
          {asks.status !== 'live' ? <Unavailable status={asks.status} label="asks" /> : <>
            <h2 className="text-lg font-semibold">Needs you · {open.length}</h2>
            {open.length ? <List label="First three asks">{open.slice(0,3).map(ask=><Row key={ask.id} layout="stack" title={ask.ask} meta={ask.why} status={ask.agent ?? 'Household'} onClick={()=>go(inboxPath(ask))} />)}</List> : <p>All clear.</p>}
            {open.length > 3 && <Button variant="outline" onClick={()=>go(inboxPath())}>Inbox · +{open.length-3} more</Button>}
          </>}
        </section>
        {busy && <p role="status">An answer is still being checked or recorded. Other answers wait.</p>}
        {roster.status !== 'live' ? <Unavailable status={roster.status} label="your agents" /> : !roster.records.length ? <Empty title="No agents of your own" text="Agents you own appear here, including when idle." /> : <div className={`grid min-w-0 grid-cols-1 items-start gap-4 ${columns}`} aria-label="Your agents">
          {orderedAgents(agents).map(agent=>{
            const ownAsks = open.filter(ask=>ask.agent===agent.id), first=ownAsks[0];
            const receipt = asks.status === 'live' ? asks.records.filter(ask=>ask.agent===agent.id && ask.answer).sort((a,b)=>b.answer!.at-a.answer!.at || a.id.localeCompare(b.id))[0] : undefined;
            const status = statuses.status === 'live' ? latestStatus(statuses.records,agent.id) : undefined;
            const clockStatus = wakes.status !== 'live' ? wakes.status : clocks.status;
            const paused = clocks.records.some(c => c.id === agent.id && c.paused);
            const work = clockStatus === 'live' ? wakes.records.filter(w => w.agent === agent.id && active(w)) : [];
            const next = agentNext(agent.id, work, paused);
            const jobs = deskJobs(work, paused);
            const runtimeJobs = runtime.status === 'live' ? currentRuntimeJobs(runtime.records, agent.id) : [];
            return <section key={agent.id} aria-label={`${agent.name} card`} className="grid min-w-0 gap-3 rounded-lg border p-3">
              <header><h2 className="text-xl font-semibold">{agent.name}</h2>{agent.personPath && <Button variant="outline" size="sm" aria-label={`${agent.name} in People`} onClick={()=>go(agent.personPath!)}>People</Button>}<p>{status?.state ?? 'No status reported'}{asks.status === 'live' && ownAsks.length ? ` · ${ownAsks.length} needs you` : ''}</p></header>
              {asks.status !== 'live' ? <Unavailable status={asks.status} label="agent asks" /> : first ? <AskReader key={first.id} ask={first} snapshot={asks} go={go} guard={guard} requireOwnership /> : <p>Nothing needs you from {agent.name}.</p>}
              {ownAsks.length > 1 && <Button variant="outline" onClick={()=>go(inboxPath(ownAsks[1]))}>Next ask · {ownAsks.length-1} more</Button>}
              {receipt && <section aria-label={`${agent.name} last answer`}><h3>Last answer</h3><p>{receipt.ask}</p><AnswerReceipt ask={receipt} /></section>}
              <section aria-label={`${agent.name} clock`} className="grid min-w-0 gap-2">
                <h3>Next</h3>
                {clockStatus !== 'live' ? <Unavailable status={clockStatus} label="clock" /> : <>
                  <p>{next.paused ? 'Clock paused' : next.next ? `${time(next.next.due)} · ${next.next.text}` : 'No wake scheduled'}</p>
                  <h3>Clock jobs · {jobs.length}</h3>
                  {!jobs.length ? <p>No clock jobs.</p> : <List label={`${agent.name} clock jobs`}>{jobs.map(job => {
                    const wake = work.find(w => w.id === job.wake)!;
                    return <Row key={job.id} title={job.text} status={state(wake, paused)} meta={job.status === 'scheduled' ? time(job.at) : undefined} onClick={()=>go(job.href)} />;
                  })}</List>}
                </>}
              </section>
              <section aria-label={`${agent.name} runtime jobs`} className="grid min-w-0 gap-2">
                {runtime.status !== 'live' ? <><h3>Runtime jobs</h3><Unavailable status={runtime.status} label="runtime jobs" /></> : <>
                  <h3>Runtime jobs · {runtimeJobs.length}</h3>
                  {!runtimeJobs.length ? <p>No current runtime jobs.</p> : <ul className="grid min-w-0 gap-3" aria-label={`${agent.name} current runtime jobs`}>{runtimeJobs.map(job => <li key={job.id} className="min-w-0 border-b pb-2">
                    <h4>{job.title || job.id}</h4><p>{job.state} · Box {job.box}</p>
                    <p>Queued <time dateTime={new Date(job.createdAt).toISOString()}>{stamp(job.createdAt)}</time></p>
                  </li>)}</ul>}
                </>}
              </section>
              <section aria-label={`${agent.name} reported work`} className="grid min-w-0 gap-3"><h3>Now</h3>{statuses.status !== 'live' ? <Unavailable status={statuses.status} label="agent status" /> : <><p className="whitespace-pre-wrap">{status?.work || 'Nothing right now'}</p>{status && <>
                <p>Reported <time dateTime={new Date(status.changedAt).toISOString()}>{stamp(status.changedAt)}</time></p>
                <ReportedItems title="Reported jobs" empty="No jobs reported." items={status.jobs} go={go} />
                <ReportedItems title="Watching" empty="No watched items reported." items={status.watched} go={go} />
              </>}</>}</section>
            </section>;
          })}
        </div>}
      </div>
    </AppFrame></div>
  </div>;
}
