import { useMemo } from 'react';
import { localDate, timesOnDate } from '../../../../src/core/tempo/calendar';
import { DAY_MS } from '../../../../src/core/day';
import { useDataQuery } from '../../data/graphql';
import { Button, Row } from '../../kit';
import { eventLabels, kindLabels, triggerKind, recordedOutcomes, status, title, triggerAgent, type AgentPause, type Trigger } from './model';

const headerQuery = `query TempoDayHeader {
  deskTime { at }
  modelAccounts { ... on RuntimeAccount { label level } }
}`;
type Header = { deskTime: {at: number} | null; modelAccounts: {label: string; level: string}[] };
type Reading = {at:string;usage:number};
type DayUsage = {date:string;peak:Reading|null;weekly:Reading|null;highHours:string[]};
type SubscriptionUsage = {label:string;calendarUsage?:DayUsage[]};
const calendarUsageQuery = `query TempoSubscriptionHistory($start:String!,$days:Int!) {
  modelAccounts { ... on RuntimeAccount {label} ... on RuntimeAccountDetail {
    calendarUsage(start:$start,days:$days){date peak{at usage} weekly{at usage} highHours}
  }}
}`;
const historyQuery = `query TempoDayHistory($from: String!, $until: String!, $dueFrom:String!, $dueUntil:String!, $calendar:Boolean!) {
  stopped:triggerLog(where:{event:{eq:"stopped"},note:{gte:$dueFrom,lt:$dueUntil}}) @include(if:$calendar) {
    trigger seq at note triggerRow { state scheduleRemovedAt triggerLogByTrigger(where:{event:{eq:"stopped"}},orderBy:{seq:{direction:desc,priority:0}},limit:1){seq} }
  }
  tempoCalendarOutcomes(from:$from,until:$until)
  triggerLog(where: {at: {gte: $from, lt: $until}, event: {inArray: ["fired","failed","missed","cancelled","skipped","held","stopped","failure"]}},
    orderBy: {at: {direction: asc, priority: 0}, seq: {direction: asc, priority: 1}}) { trigger seq at event note }
}`;
type Outcome = { event:number; kind:"program"|"mail"|"notice"; state:string|null; reason:string|null };
type Event = { trigger: string; seq: number; at: string; event: string; note: string; outcomes?: Outcome[]; failure?:string };
const shift = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
function stoppedDue(note:string|undefined, format:Intl.DateTimeFormat) {
  const match=/^Next due (.+)$/.exec(note??'');
  const epoch=match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(epoch) ? 'Was due '+format.format(epoch) : undefined;
}

type Stop = Pick<Event,'trigger'|'seq'|'at'|'note'> & {triggerRow:{state:string;scheduleRemovedAt:string|null;triggerLogByTrigger:{seq:number}[]}|null};
type Entry = {trigger: Trigger; at: number; key: string; state: string; scheduled: boolean; stoppedAt?:string; note?: string};

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
  const full=new Intl.DateTimeFormat(undefined,{timeZone:zone,dateStyle:'medium',timeStyle:'short'});
  const time=new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit'});
  return <section aria-label="Day history" className="grid gap-1">
    {visible.length ? visible.map(event=>{
      const trigger=byId.get(event.trigger)!;
      const details=event.outcomes?.flatMap(run=>run.reason ? [run.reason] : []) ?? [];
      const due=(event.event==='stopped'||event.event==='held') ? stoppedDue(event.note,full) : undefined;
      if(due)details.push(due);
      if(event.failure) details.push(event.failure);
      if(event.event==='missed') details.push(...recordedOutcomes([{state:'missed',note:event.note,scheduled:false}]));
      return <Row key={event.seq} title={title(trigger)} status={outcomeWords(event)}
        data-trigger-kind={triggerKind(trigger)} trailing={kindLabels[triggerKind(trigger)]} meta={[time.format(Date.parse(event.at)),...details].join(' · ')} onClick={()=>open(trigger.id)}/>;
    }) : <p>No recorded activity for this day.</p>}
  </section>;
}

function DayHours({date, zone, now, triggers, pauses, open, log, stops, subscriptions}: ScheduleProps & {date: string; log: Event[] | undefined; stops:Stop[]|undefined; subscriptions:{label:string;day:DayUsage}[]}) {
  const {entries, frequent} = useMemo(() => {
    const items: Entry[] = [];
    const frequentIds = new Set<string>();
    const byId = new Map(triggers.map(t => [t.id,t]));
    const pauseTimes=new Map(pauses.map(pause=>[pause.agent,Date.parse(pause.since)]));
    const here=new Set<number>();
    for(const stop of stops??[]){
      const trigger=byId.get(stop.trigger), due=Date.parse(stop.note.slice('Next due '.length));
      if(!trigger || stop.triggerRow?.state!=='stopped' || stop.triggerRow.scheduleRemovedAt ||
        stop.triggerRow.triggerLogByTrigger[0]?.seq!==stop.seq || !Number.isFinite(due) || localDate(due,zone)!==date)continue;
      items.push({trigger,at:due,key:'due-'+stop.seq,state:'stopped',scheduled:false,stoppedAt:stop.at,note:stop.note});
      here.add(stop.seq);
    }
    for (const event of log ?? []) {
      const t = byId.get(event.trigger), at = Date.parse(event.at);
      if (!t || here.has(event.seq) || event.event==='failure') continue;
      // A current pause is already drawn at the time its wake was due.
      // Keep the change of state at its actual timestamp in Day history.
      const since=pauseTimes.get(triggerAgent(t) ?? '');
      if (event.event==='held' && since!==undefined && at>=since && t.state==='held'
        && t.enabled && t.sourceKind==='time' && t.nextDueAt && event.note==='Next due '+t.nextDueAt) continue;
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
      if (sourceKind !== 'time' || lifespan === 'once' || ['stopped','held'].includes(entry.state)) continue;
      const group = frequent.get(id);
      if (group) group.push(entry); else frequent.set(id,[entry]);
    }
    for (const [id,group] of frequent) {
      if (!frequentIds.has(id) && group.length < frequentRunsPerDay) frequent.delete(id);
    }
    return {entries:items.filter(entry=>!frequent.has(entry.trigger.id) || ['stopped','held'].includes(entry.state)),frequent};
  }, [triggers, pauses, date, zone, log, stops]);
  const format = new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit'});
  const full = new Intl.DateTimeFormat(undefined,{timeZone:zone,dateStyle:'medium',timeStyle:'short'});
  const hourFormat = new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'numeric',timeZoneName:'short'});
  const hours = new Map<string, (Entry | 'now')[]>();
  const add = (at:number, entry: Entry | 'now') => {
    const hour = hourFormat.format(at);
    firstAt.set(hour,at);
    const group = hours.get(hour);
    if (group) group.push(entry); else hours.set(hour,[entry]);
  };
  const firstAt = new Map<string,number>();
  const high = new Map<string,string[]>();
  for (const {label,day} of subscriptions) for (const sample of day.highHours) {
    const at=Date.parse(sample), hour=hourFormat.format(at);
    const labels=high.get(hour) ?? [];
    labels.push(label); high.set(hour,labels);
    if (!hours.has(hour)) hours.set(hour,[]);
    firstAt.set(hour,at);
  }
  const today = localDate(now,zone) === date;
  let marked = false;
  for (const entry of entries) {
    if (today && !marked && entry.at > now) { add(now,'now'); marked = true; }
    add(entry.at,entry);
  }
  if (today && !marked) add(now,'now');
  return <section aria-label="Day schedule" className="grid gap-1">
    {subscriptions.length > 0 && <section aria-label="Subscription readings" className="grid gap-1">
      {subscriptions.map(({label,day},i)=><p key={i}><strong>{label}</strong>{[
        day.peak && Math.round(day.peak.usage*100)+'% five-hour peak at '+format.format(Date.parse(day.peak.at)),
        day.weekly && Math.round(day.weekly.usage*100)+'% of the week at '+format.format(Date.parse(day.weekly.at)),
      ].filter(Boolean).map(words=>' · '+words).join('')}</p>)}
    </section>}
    {frequent.size > 0 && <section aria-label="Frequent triggers" className="grid gap-1">
      <h3 className="text-sm">Frequent triggers</h3>
      {[...frequent].map(([id,group])=><FrequentTriggerRow key={id} entries={group} format={format} open={open}/>)}
    </section>}
    {[...hours].sort(([a],[b])=>firstAt.get(a)!-firstAt.get(b)!).map(([hour,items])=><div key={hour} data-high-usage={high.has(hour)||undefined} className="tempo-hour grid grid-cols-[5em_minmax(0,1fr)] gap-2 border-t py-2">
      <h3 className="pt-1 text-sm">{hour}</h3>
      <div className="grid gap-1 border-l pl-2">{high.get(hour)?.map((label,i)=><small key={i}>{label} · five-hour window almost full</small>)}{items.map(entry=>entry === 'now'
        ? <div key="now" className="border-b text-sm" role="separator" aria-label="Now">Now · {format.format(now)}</div>
        : <Row key={entry.key} title={entry.state==='stopped'||entry.state.toLowerCase().startsWith('held')
            ? <s>{title(entry.trigger)}</s> : title(entry.trigger)} className={entry.trigger.sourceKind==='time'?undefined:'tempo-event-firing'}
          data-trigger-kind={triggerKind(entry.trigger)} trailing={kindLabels[triggerKind(entry.trigger)]} meta={[format.format(entry.at), entry.trigger.sourceKind !== 'time' && eventLabels[entry.trigger.sourceKind],
            entry.stoppedAt && 'Stopped '+full.format(Date.parse(entry.stoppedAt)),
            (entry.state==='stopped'||entry.state==='held') && stoppedDue(entry.note,full)].filter(Boolean).join(' · ')}
          status={entry.state} onClick={()=>open(entry.trigger.id)}/>)}</div>
    </div>)}
    {log && !entries.length && !frequent.size && <p>No timed activity for this day.</p>}
  </section>;
}

function FrequentTriggerRow({entries,format,open}: {entries: Entry[]; format: Intl.DateTimeFormat; open: (id:string)=>void}) {
  const trigger = entries[0].trigger;
  const upcoming = entries.filter(entry=>entry.scheduled);
  const summary = recordedOutcomes(entries);
  const next = upcoming[0];
  if (next) summary.push(upcoming.length+(next.state.startsWith('Held') ? ' held' : ' scheduled'), 'Next '+format.format(next.at));
  return <Row title={next?.state.startsWith('Held') ? <s>{title(trigger)}</s> : title(trigger)} status={next?.state} data-trigger-kind={triggerKind(trigger)} trailing={kindLabels[triggerKind(trigger)]} meta={summary.join(' · ')} onClick={()=>open(trigger.id)}/>;
}

function CalendarHours({start,week,history,selectDay,...schedule}: ScheduleProps & {start:string; week:boolean; history:boolean; selectDay:(date:string)=>void}) {
  const length = week ? 7 : 1;
  // Read the visible range once. The offsets on either side include local dates across DST changes.
  const from=shift(start,-1)+'T00:00:00.000Z',until=shift(start,length+1)+'T00:00:00.000Z';
  const feed = useDataQuery<{triggerLog: Event[];tempoCalendarOutcomes:Outcome[];stopped?:Stop[]}>(historyQuery,
    {from,until,dueFrom:'Next due '+from,dueUntil:'Next due '+until,calendar:!history});

  const usage = useDataQuery<{modelAccounts:SubscriptionUsage[]}>(calendarUsageQuery,{start,days:length},{pause:history});
  const accounts = usage.status==='live' && !usage.settling ? usage.data?.modelAccounts : undefined;
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
        {!history && <DayHours {...schedule} subscriptions={(accounts??[]).flatMap(account=>
          (account.calendarUsage??[]).filter(day=>day.date===date).map(day=>({label:account.label,day})))} stops={feed.status==='live'?feed.data?.stopped:undefined} date={date} log={log ? events.get(date) ?? noEvents : undefined}/>}
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
        {group.map(t=><Row key={t.id} title={title(t)} data-trigger-kind={triggerKind(t)} meta={kindLabels[triggerKind(t)]} onClick={()=>open(t.id)}/>)}
      </div>)}
    </section>}
    {start && now != null ? <CalendarHours start={start} week={week} history={history} selectDay={day=>{select(day);showDay();}} now={now} zone={zone} triggers={triggers} pauses={pauses} open={open}/>
      : <p>{feed.status === 'loading' ? 'Opening calendar…' : 'Household clock unavailable.'}</p>}
  </div>;
}
