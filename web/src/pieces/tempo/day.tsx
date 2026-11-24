import { useMemo, useState } from 'react';
import { localDate, timesOnDate } from '../../../../src/core/tempo/calendar';
import { DAY_MS } from '../../../../src/core/day';
import { useDataQuery } from '../../data/graphql';
import { Button, Row } from '../../kit';
import { status, title, type AgentPause, type Trigger } from './model';

const headerQuery = `query TempoDayHeader {
  deskTime { at }
  modelAccounts { ... on RuntimeAccount { label level } }
}`;
type Header = { deskTime: {at: number} | null; modelAccounts: {label: string; level: string}[] };
const historyQuery = `query TempoDayHistory($from: String!, $until: String!) {
  triggerLog(where: {at: {gte: $from, lt: $until}, event: {inArray: ["fired","failed","missed","cancelled","skipped"]}},
    orderBy: {at: {direction: asc, priority: 0}, seq: {direction: asc, priority: 1}}) { trigger seq at event }
}`;
type Event = { trigger: string; seq: number; at: string; event: string };
const shift = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
type Entry = {trigger: Trigger; at: number; key: string; state: string};

function DayHours({date, zone, now, triggers, pauses, open}: {date: string; zone: string; now: number;
  triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open: (id: string) => void}) {
  // Cover all local offsets; the final date comparison also handles non-24-hour days.
  const feed = useDataQuery<{triggerLog: Event[]}>(historyQuery, {from: shift(date,-1)+'T00:00:00.000Z', until: shift(date,2)+'T00:00:00.000Z'});
  const log = feed.status === 'live' ? feed.data?.triggerLog : undefined;
  const entries = useMemo(() => {
    const items: Entry[] = [];
    const byId = new Map(triggers.map(t => [t.id,t]));
    for (const event of log ?? []) {
      const t = byId.get(event.trigger), at = Date.parse(event.at);
      if (t && localDate(at,zone) === date) items.push({trigger:t, at, key:'event-'+event.seq, state:event.event});
    }
    for (const t of triggers) {
      if (t.sourceKind !== 'time' || !t.times || !t.enabled || !t.nextDueAt) continue;
      const next = Date.parse(t.nextDueAt);
      if (t.lifespan === 'today' && localDate(next,zone) !== date) continue;
      const times = t.lifespan === 'once' ? (localDate(next,zone) === date ? [next] : []) : timesOnDate(t.times,t.days,date,zone);
      for (const at of times) if (at >= next) items.push({trigger:t, at, key:t.id+'/'+at, state:status(t,pauses)});
    }
    return items.sort((a,b)=>a.at-b.at || a.key.localeCompare(b.key));
  }, [triggers, pauses, date, zone, log]);
  const format = new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit'});
  const hourFormat = new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'numeric',timeZoneName:'short'});
  const hours = new Map<string, (Entry | 'now')[]>();
  const add = (at:number, entry: Entry | 'now') => {
    const hour = hourFormat.format(at);
    const group = hours.get(hour);
    if (group) group.push(entry); else hours.set(hour,[entry]);
  };
  const today = localDate(now,zone) === date;
  let marked = false;
  for (const entry of entries) {
    if (today && !marked && entry.at > now) { add(now,'now'); marked = true; }
    add(entry.at,entry);
  }
  if (today && !marked) add(now,'now');
  return <section aria-label="Day schedule" className="grid gap-1">
    {!log && <p>{feed.status === 'loading' ? 'Loading firing history…' : 'Firing history unavailable.'}</p>}
    {[...hours].map(([hour,items])=><div key={hour} className="grid grid-cols-[5em_minmax(0,1fr)] gap-2 border-t py-2">
      <h3 className="pt-1 text-sm">{hour}</h3>
      <div className="grid gap-1 border-l pl-2">{items.map(entry=>entry === 'now'
        ? <div key="now" className="border-b text-sm" role="separator" aria-label="Now">Now · {format.format(now)}</div>
        : <Row key={entry.key} title={title(entry.trigger)} meta={format.format(entry.at)} status={entry.state} onClick={()=>open(entry.trigger.id)}/>)}</div>
    </div>)}
    {log && !entries.length && <p>No timed activity for this day.</p>}
  </section>;
}

export function TempoDay({zone,triggers,pauses,open}: {zone:string; triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open:(id:string)=>void}) {
  const feed = useDataQuery<Header>(headerQuery);
  const data = feed.status === 'live' ? feed.data : undefined;
  const now = data?.deskTime?.at;
  const [chosen,select] = useState<string>();
  const today = now == null ? undefined : localDate(now,zone);
  const date = chosen ?? today;
  const waiting = triggers.filter(t=>t.enabled && t.sourceKind!=='time');
  return <div className="grid gap-3 p-3">
    {date && <nav aria-label="Calendar date" className="flex flex-wrap items-center gap-2">
      <Button aria-label="Previous day" onClick={()=>select(shift(date,-1))}>‹</Button>
      <time dateTime={date}>{new Intl.DateTimeFormat(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(Date.parse(date+'T12:00:00Z'))}</time>
      <Button aria-label="Next day" onClick={()=>select(shift(date,1))}>›</Button>
      <Button disabled={date===today} onClick={()=>select(undefined)}>Today</Button>
    </nav>}
    {date === today && !!data?.modelAccounts?.length && <section aria-label="Current subscriptions" className="flex flex-wrap gap-3">
      {data.modelAccounts.map((account,i)=><span key={i} className="loom-job-capacity" data-capacity={account.level}>{account.label} · {account.level}</span>)}
    </section>}
    {!!waiting.length && <section aria-label="Event triggers"><h3>Waiting for an event now</h3>{waiting.map(t=><Row key={t.id} title={title(t)} meta={t.sourceKind} onClick={()=>open(t.id)}/>)}</section>}
    {date && now != null ? <DayHours date={date} now={now} zone={zone} triggers={triggers} pauses={pauses} open={open}/>
      : <p>{feed.status === 'loading' ? 'Opening calendar…' : 'Household clock unavailable.'}</p>}
  </div>;
}
