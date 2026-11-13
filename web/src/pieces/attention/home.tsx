import { useRef, useState } from 'react';
import { useRecords, type Snapshot } from '../../data';
import { AppFrame, Button, Empty, Error, List, Loading, Row } from '../../kit';
import { AskReader, AnswerReceipt, stamp, type Guard } from './index';
import type { Ask } from './model';
import { inboxPath, latestStatus, openAsks, orderedAgents, type AgentStatus, type OwnedAgent } from './home-model';
function Unavailable({ status, label }: { status: Snapshot['status']; label: string }) {
  return status === 'loading' ? <Loading label={`Opening ${label}…`} /> : <Error title={`Couldn’t load ${label}`} text={status === 'denied' ? 'Sign in with access to see this.' : 'Waiting for connection.'} />;
}
export default function Home({ go = path => location.assign(path) }: { go?: (path:string)=>void } = {}) {
  const roster = useRecords<OwnedAgent>('attention.ownedAgent');
  const asks = useRecords<Ask>('attention.ask');
  const statuses = useRecords<AgentStatus>('attention.agent');
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
          {orderedAgents(roster.records).map(agent=>{
            const ownAsks = open.filter(ask=>ask.agent===agent.id), first=ownAsks[0];
            const receipt = asks.status === 'live' ? asks.records.filter(ask=>ask.agent===agent.id && ask.answer).sort((a,b)=>b.answer!.at-a.answer!.at || a.id.localeCompare(b.id))[0] : undefined;
            const status = statuses.status === 'live' ? latestStatus(statuses.records,agent.id) : undefined;
            return <section key={agent.id} aria-label={`${agent.name} card`} className="grid min-w-0 gap-3 rounded-lg border p-3">
              <header><h2 className="text-xl font-semibold">{agent.name}</h2><p>{status?.state ?? 'No status reported'}{asks.status === 'live' && ownAsks.length ? ` · ${ownAsks.length} needs you` : ''}</p></header>
              {asks.status !== 'live' ? <Unavailable status={asks.status} label="agent asks" /> : first ? <AskReader key={first.id} ask={first} snapshot={asks} go={go} guard={guard} requireOwnership /> : <p>Nothing needs you from {agent.name}.</p>}
              {ownAsks.length > 1 && <Button variant="outline" onClick={()=>go(inboxPath(ownAsks[1]))}>Next ask · {ownAsks.length-1} more</Button>}
              {receipt && <section aria-label={`${agent.name} last answer`}><h3>Last answer</h3><p>{receipt.ask}</p><AnswerReceipt ask={receipt} /></section>}
              <section><h3>Now</h3>{statuses.status !== 'live' ? <Unavailable status={statuses.status} label="agent status" /> : <><p className="whitespace-pre-wrap">{status?.work || 'Nothing right now'}</p>{status && <p>Reported <time dateTime={new Date(status.changedAt).toISOString()}>{stamp(status.changedAt)}</time></p>}</>}</section>
            </section>;
          })}
        </div>}
      </div>
    </AppFrame></div>
  </div>;
}
