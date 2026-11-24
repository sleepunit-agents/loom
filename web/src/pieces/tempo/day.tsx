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

type ScheduleProps = {zone: string; now: number; triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open: (id: string) => void};
const dateLabel = new Intl.DateTimeFormat(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
const formatDate = (date: string) => dateLabel.format(Date.parse(date+'T12:00:00Z'));
const noEvents: Event[] = [];

function DayHours({date, zone, now, triggers, pauses, open, log}: ScheduleProps & {date: string; log: Event[] | undefined}) {
  const entries = useMemo(() => {
    const items: Entry[] = [];
    const byId = new Map(triggers.map(t => [t.id,t]));
    for (const event of log ?? []) {
      const t = byId.get(event.trigger), at = Date.parse(event.at);
      if (t) items.push({trigger:t, at, key:'event-'+event.seq, state:event.event});
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
    {[...hours].map(([hour,items])=><div key={hour} className="grid grid-cols-[5em_minmax(0,1fr)] gap-2 border-t py-2">
      <h3 className="pt-1 text-sm">{hour}</h3>
      <div className="grid gap-1 border-l pl-2">{items.map(entry=>entry === 'now'
        ? <div key="now" className="border-b text-sm" role="separator" aria-label="Now">Now · {format.format(now)}</div>
        : <Row key={entry.key} title={title(entry.trigger)} meta={format.format(entry.at)} status={entry.state} onClick={()=>open(entry.trigger.id)}/>)}</div>
    </div>)}
    {log && !entries.length && <p>No timed activity for this day.</p>}
  </section>;
}

function CalendarHours({start,week,selectDay,...schedule}: ScheduleProps & {start:string; week:boolean; selectDay:(date:string)=>void}) {
  const length = week ? 7 : 1;
  // Read the visible range once. The offsets on either side include local dates across DST changes.
  const feed = useDataQuery<{triggerLog: Event[]}>(historyQuery,{from:shift(start,-1)+'T00:00:00.000Z',until:shift(start,length+1)+'T00:00:00.000Z'});
  const log = feed.status === 'live' ? feed.data?.triggerLog : undefined;
  const events = useMemo(()=>{
    const days = new Map<string, Event[]>();
    for (const event of log ?? []) {
      const date = localDate(Date.parse(event.at),schedule.zone);
      const group = days.get(date);
      if (group) group.push(event); else days.set(date,[event]);
    }
    return days;
  },[log,schedule.zone]);
  return <div aria-label={week ? 'Week schedule' : undefined} role={week ? 'region' : undefined} className="grid gap-3">
    {!log && <p>{feed.status === 'loading' ? 'Loading firing history…' : 'Firing history unavailable.'}</p>}
    {Array.from({length},(_,offset)=>{
      const date = shift(start,offset);
      return <div key={date} role={week ? 'group' : undefined} aria-label={week ? formatDate(date) : undefined}>
        {week && <h3><Button onClick={()=>selectDay(date)} aria-label={'Open '+formatDate(date)}><time dateTime={date}>{formatDate(date)}</time></Button></h3>}
        <DayHours {...schedule} date={date} log={log ? events.get(date) ?? noEvents : undefined}/>
      </div>;
    })}
  </div>;
}

export function TempoCalendar({week,showDay,clearReader,zone,triggers,pauses,open}: {week:boolean; showDay:()=>void; clearReader:()=>void; zone:string; triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open:(id:string)=>void}) {
  const feed = useDataQuery<Header>(headerQuery);
  const data = feed.status === 'live' ? feed.data : undefined;
  const now = data?.deskTime?.at;
  const [chosen,setChosen] = useState<string>();
  function select(date: string | undefined) { setChosen(date); clearReader(); }
  const today = now == null ? undefined : localDate(now,zone);
  const date = chosen ?? today;
  // Weeks start on Monday. Work in civil dates so DST never shifts a column.
  const start = week && date ? shift(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7)) : date;
  const waiting = triggers.filter(t=>t.enabled && t.sourceKind!=='time');
  return <div className="grid gap-3 p-3">
    {date && start && <nav aria-label="Calendar date" className="flex flex-wrap items-center gap-2">
      <Button aria-label={week?'Previous week':'Previous day'} onClick={()=>select(shift(date,week?-7:-1))}>‹</Button>
      <span><time dateTime={start}>{formatDate(start)}</time>{week && <> – <time dateTime={shift(start,6)}>{formatDate(shift(start,6))}</time></>}</span>
      <Button aria-label={week?'Next week':'Next day'} onClick={()=>select(shift(date,week?7:1))}>›</Button>
      <Button disabled={date===today} onClick={()=>select(undefined)}>Today</Button>
    </nav>}
    {!week && date === today && !!data?.modelAccounts?.length && <section aria-label="Current subscriptions" className="flex flex-wrap gap-3">
      {data.modelAccounts.map((account,i)=><span key={i} className="loom-job-capacity" data-capacity={account.level}>{account.label} · {account.level}</span>)}
    </section>}
    {!!waiting.length && <section aria-label="Event triggers"><h3>Waiting for an event now</h3>{waiting.map(t=><Row key={t.id} title={title(t)} meta={t.sourceKind} onClick={()=>open(t.id)}/>)}</section>}
    {start && now != null ? <CalendarHours start={start} week={week} selectDay={day=>{select(day);showDay();}} now={now} zone={zone} triggers={triggers} pauses={pauses} open={open}/>
      : <p>{feed.status === 'loading' ? 'Opening calendar…' : 'Household clock unavailable.'}</p>}
  </div>;
}
