import { useMemo } from 'react';
import { localDate, timesOnDate } from '../../../../src/core/tempo/calendar';
import { DAY_MS } from '../../../../src/core/day';
import { useDataQuery } from '../../data/graphql';
import { Button, Row } from '../../kit';
import { eventLabels, recordedOutcomes, status, title, type AgentPause, type Trigger } from './model';

const headerQuery = `query TempoDayHeader {
  deskTime { at }
  modelAccounts { ... on RuntimeAccount { label level } }
}`;
type Header = { deskTime: {at: number} | null; modelAccounts: {label: string; level: string}[] };
const historyQuery = `query TempoDayHistory($from: String!, $until: String!) {
  tempoCalendarOutcomes(from:$from,until:$until)
  triggerLog(where: {at: {gte: $from, lt: $until}, event: {inArray: ["fired","failed","missed","cancelled","skipped","held","stopped","failure"]}},
    orderBy: {at: {direction: asc, priority: 0}, seq: {direction: asc, priority: 1}}) { trigger seq at event note }
}`;
type Outcome = { event:number; kind:"program"|"mail"|"notice"; state:string|null; reason:string|null };
type Event = { trigger: string; seq: number; at: string; event: string; note: string; outcomes?: Outcome[]; failure?:string };
const shift = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
type Entry = {trigger: Trigger; at: number; key: string; state: string; scheduled: boolean; note?: string};

type ScheduleProps = {zone: string; now: number; triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open: (id: string) => void};
const dateLabel = new Intl.DateTimeFormat(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
const formatDate = (date: string) => dateLabel.format(Date.parse(date+'T12:00:00Z'));
const noEvents: Event[] = [];
const frequentRunsPerDay = 4;

function outcomeWords(event:Event) {
  return event.outcomes?.map(run=>(run.kind==='notice'?'Inbox notice':run.kind==='program'?'Program':'Agent wake')+' '+(run.state??'delivered')).join(' → ') || event.event;
}

function DayHistory({events,triggers,zone,open}:{events:Event[];triggers:readonly Trigger[];zone:string;open:(id:string)=>void}) {
  const byId=new Map(triggers.map(trigger=>[trigger.id,trigger]));
  const visible=events.filter(event=>byId.has(event.trigger))
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||b.seq-a.seq);
  const time=new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit'});
  return <section aria-label="Day history" className="grid gap-1">
    {visible.length ? visible.map(event=>{
      const trigger=byId.get(event.trigger)!;
      const details=event.outcomes?.flatMap(run=>run.reason ? [run.reason] : []) ?? [];
      if(event.failure) details.push(event.failure);
      if(event.event==='missed') details.push(...recordedOutcomes([{state:'missed',note:event.note,scheduled:false}]));
      return <Row key={event.seq} title={title(trigger)} status={outcomeWords(event)}
        meta={[time.format(Date.parse(event.at)),...details].join(' · ')} onClick={()=>open(trigger.id)}/>;
    }) : <p>No recorded activity for this day.</p>}
  </section>;
}

function DayHours({date, zone, now, triggers, pauses, open, log}: ScheduleProps & {date: string; log: Event[] | undefined}) {
  const {entries, frequent} = useMemo(() => {
    const items: Entry[] = [];
    const frequentIds = new Set<string>();
    const byId = new Map(triggers.map(t => [t.id,t]));
    for (const event of log ?? []) {
      const t = byId.get(event.trigger), at = Date.parse(event.at);
      if (!t || ['failure','stopped','held'].includes(event.event)) continue;
      items.push({trigger:t, at, key:'event-'+event.seq, state:event.outcomes?.every(run=>run.kind==='notice') ? event.event : outcomeWords(event), note:event.note, scheduled:false});
    }
    for (const t of triggers) {
      if (t.sourceKind !== 'time' || !t.times || !t.enabled || !t.nextDueAt) continue;
      const next = Date.parse(t.nextDueAt);
      if (t.lifespan === 'today' && localDate(next,zone) !== date) continue;
      const times = t.lifespan === 'once' ? (localDate(next,zone) === date ? [next] : []) : timesOnDate(t.times,t.days,date,zone);
      if (times.length >= frequentRunsPerDay && times.some(at=>at >= next)) frequentIds.add(t.id);
      for (const at of times) if (at >= next) items.push({trigger:t, at, key:t.id+'/'+at, state:status(t,pauses), scheduled:true});
    }
    items.sort((a,b)=>a.at-b.at || a.key.localeCompare(b.key));
    const frequent = new Map<string, Entry[]>();
    for (const entry of items) {
      const {id,sourceKind,lifespan} = entry.trigger;
      if (sourceKind !== 'time' || lifespan === 'once') continue;
      const group = frequent.get(id);
      if (group) group.push(entry); else frequent.set(id,[entry]);
    }
    for (const [id,group] of frequent) {
      if (!frequentIds.has(id) && group.length < frequentRunsPerDay) frequent.delete(id);
    }
    return {entries:items.filter(entry=>!frequent.has(entry.trigger.id)),frequent};
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
    {frequent.size > 0 && <section aria-label="Frequent triggers" className="grid gap-1">
      <h3 className="text-sm">Frequent triggers</h3>
      {[...frequent].map(([id,group])=><FrequentTriggerRow key={id} entries={group} format={format} open={open}/>)}
    </section>}
    {[...hours].map(([hour,items])=><div key={hour} className="tempo-hour grid grid-cols-[5em_minmax(0,1fr)] gap-2 border-t py-2">
      <h3 className="pt-1 text-sm">{hour}</h3>
      <div className="grid gap-1 border-l pl-2">{items.map(entry=>entry === 'now'
        ? <div key="now" className="border-b text-sm" role="separator" aria-label="Now">Now · {format.format(now)}</div>
        : <Row key={entry.key} title={title(entry.trigger)} className={entry.trigger.sourceKind === 'time' ? undefined : 'tempo-event-firing'}
          meta={entry.trigger.sourceKind === 'time' ? format.format(entry.at) : format.format(entry.at)+' · '+eventLabels[entry.trigger.sourceKind]} status={entry.state} onClick={()=>open(entry.trigger.id)}/>)}</div>
    </div>)}
    {log && !entries.length && !frequent.size && <p>No timed activity for this day.</p>}
  </section>;
}

function FrequentTriggerRow({entries,format,open}: {entries: Entry[]; format: Intl.DateTimeFormat; open: (id:string)=>void}) {
  const trigger = entries[0].trigger;
  const upcoming = entries.filter(entry=>entry.scheduled);
  const summary = recordedOutcomes(entries);
  const next = upcoming[0];
  if (next) summary.push(upcoming.length+' scheduled', 'Next '+format.format(next.at));
  return <Row title={title(trigger)} status={next?.state} meta={summary.join(' · ')} onClick={()=>open(trigger.id)}/>;
}

function CalendarHours({start,week,history,selectDay,...schedule}: ScheduleProps & {start:string; week:boolean; history:boolean; selectDay:(date:string)=>void}) {
  const length = week ? 7 : 1;
  // Read the visible range once. The offsets on either side include local dates across DST changes.
  const feed = useDataQuery<{triggerLog: Event[];tempoCalendarOutcomes:Outcome[]}>(historyQuery,{from:shift(start,-1)+'T00:00:00.000Z',until:shift(start,length+1)+'T00:00:00.000Z'});
  const log = feed.status === 'live' ? feed.data?.triggerLog : undefined;
  const outcomes=feed.status==='live' ? feed.data?.tempoCalendarOutcomes : undefined;
  const events = useMemo(()=>{
    const byEvent=new Map<number,Outcome[]>();
    for(const outcome of outcomes ?? []){
      const group=byEvent.get(outcome.event);
      if(group)group.push(outcome);else byEvent.set(outcome.event,[outcome]);
    }
    const days = new Map<string, Event[]>();
    const bySeq=new Map(log?.map(event=>[event.seq,event]));
    for (const event of log ?? []) {
      const adjacent=bySeq.get(event.seq+(event.event==='failure' ? -1 : 1));
      if(event.event==='failure' && adjacent?.trigger===event.trigger && adjacent.event==='failed')continue;
      const failure=event.event==='failed' && adjacent?.trigger===event.trigger && adjacent.event==='failure'
        ? adjacent.note : event.event==='failure' ? event.note : undefined;
      const date = localDate(Date.parse(event.at),schedule.zone);
      const group = days.get(date);
      const row={...event,failure,outcomes:byEvent.get(event.seq)};
      if (group) group.push(row); else days.set(date,[row]);
    }
    return days;
  },[log,outcomes,schedule.zone]);
  if(history && log) return <DayHistory events={events.get(start)??noEvents} triggers={schedule.triggers} zone={schedule.zone} open={schedule.open}/>;
  return <div aria-label={week ? 'Week schedule' : undefined} role={week ? 'region' : undefined} className={week ? 'tempo-week-days' : 'grid gap-3'}>
    {!log && <p>{feed.status === 'loading' ? 'Loading firing history…' : 'Firing history unavailable.'}</p>}
    {Array.from({length},(_,offset)=>{
      const date = shift(start,offset);
      return <div key={date} role={week ? 'group' : undefined} aria-label={week ? formatDate(date) : undefined}>
        {week && <h3><Button onClick={()=>selectDay(date)} aria-label={'Open '+formatDate(date)}><time dateTime={date}>{formatDate(date)}</time></Button></h3>}
        {!history && <DayHours {...schedule} date={date} log={log ? events.get(date) ?? noEvents : undefined}/>}
      </div>;
    })}
  </div>;
}

export function TempoCalendar({week,history,chosen,setChosen,showDay,clearReader,zone,triggers,pauses,open}: {week:boolean; history:boolean; chosen?:string; setChosen:(value:string|undefined)=>void; showDay:()=>void; clearReader:()=>void; zone:string; triggers: readonly Trigger[]; pauses: readonly AgentPause[]; open:(id:string)=>void}) {
  const feed = useDataQuery<Header>(headerQuery);
  const data = feed.status === 'live' ? feed.data : undefined;
  const now = data?.deskTime?.at;
  function select(date: string | undefined) { setChosen(date); clearReader(); }
  const today = now == null ? undefined : localDate(now,zone);
  const date = chosen ?? today;
  // Weeks start on Monday. Work in civil dates so DST never shifts a column.
  const start = week && date ? shift(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7)) : date;
  const waiting = new Map<string, Trigger[]>();
  for (const trigger of triggers) {
    if (!trigger.enabled || trigger.sourceKind === 'time') continue;
    const label = eventLabels[trigger.sourceKind];
    const group = waiting.get(label);
    if (group) group.push(trigger);
    else waiting.set(label, [trigger]);
  }
  return <div className="tempo-calendar grid gap-3 p-3">
    {date && start && <nav aria-label="Calendar date" className="flex flex-wrap items-center gap-2">
      <Button aria-label={week?'Previous week':'Previous day'} onClick={()=>select(shift(date,week?-7:-1))}>‹</Button>
      <span><time dateTime={start}>{formatDate(start)}</time>{week && <> – <time dateTime={shift(start,6)}>{formatDate(shift(start,6))}</time></>}</span>
      <Button aria-label={week?'Next week':'Next day'} onClick={()=>select(shift(date,week?7:1))}>›</Button>
      <Button disabled={date===today} onClick={()=>select(undefined)}>Today</Button>
    </nav>}
    {!history && !week && date === today && !!data?.modelAccounts?.length && <section aria-label="Current subscriptions" className="flex flex-wrap gap-3">
      {data.modelAccounts.map((account,i)=><span key={i} className="loom-job-capacity" data-capacity={account.level}>{account.label} · {account.level}</span>)}
    </section>}
    {!history && waiting.size > 0 && <section aria-label="Event triggers"><h3>Waiting for an event now</h3>
      {[...waiting].map(([label, group])=><div key={label} role="group" aria-label={label}>
        <h4 className="text-sm">{label}</h4>
        {group.map(t=><Row key={t.id} title={title(t)} onClick={()=>open(t.id)}/>)}
      </div>)}
    </section>}
    {start && now != null ? <CalendarHours start={start} week={week} history={history} selectDay={day=>{select(day);showDay();}} now={now} zone={zone} triggers={triggers} pauses={pauses} open={open}/>
      : <p>{feed.status === 'loading' ? 'Opening calendar…' : 'Household clock unavailable.'}</p>}
  </div>;
}
