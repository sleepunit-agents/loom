/** The pure part of Tempo's day: the read of a range's recorded firings, how they are grouped by household day and
 * the words for what each came to. No component and no sheet: the desktop's calendar (./day.tsx) and the board's
 * `tempo` brick both draw from this. */
import { localDate } from '../../../../src/core/tempo/calendar';
import { DAY_MS } from '../../../../src/core/day';

export const historyQuery = `query TempoDayHistory($from: String!, $until: String!, $dueFrom:String!, $dueUntil:String!, $calendar:Boolean!) {
  stopped:triggerLog(where:{event:{eq:"stopped"},note:{gte:$dueFrom,lt:$dueUntil}}) @include(if:$calendar) {
    trigger seq at note triggerRow { state scheduleRemovedAt triggerLogByTrigger(where:{event:{eq:"stopped"}},orderBy:{seq:{direction:desc,priority:0}},limit:1){seq} }
  }
  tempoCalendarOutcomes(from:$from,until:$until)
  triggerLog(where: {at: {gte: $from, lt: $until}, event: {inArray: ["fired","failed","missed","cancelled","skipped","held","stopped","failure"]}},
    orderBy: {at: {direction: asc, priority: 0}, seq: {direction: asc, priority: 1}}) { trigger seq at event note }
}`;
export type Outcome = { event:number; kind:"program"|"mail"|"notice"; state:string|null; reason:string|null };
export type Event = { trigger: string; seq: number; at: string; event: string; note: string; outcomes?: Outcome[]; failure?:string };
export type Stop = Pick<Event,'trigger'|'seq'|'at'|'note'> & {triggerRow:{state:string;scheduleRemovedAt:string|null;triggerLogByTrigger:{seq:number}[]}|null};
export type DayFeed = {triggerLog: Event[];tempoCalendarOutcomes:Outcome[];stopped?:Stop[]};

export const shift = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
/** The variables that read `length` household days from `start`. The offsets on either side include local dates
 * across DST changes. */
export function historyRange(start: string, length: number, calendar: boolean) {
  const from=shift(start,-1)+'T00:00:00.000Z',until=shift(start,length+1)+'T00:00:00.000Z';
  return {from,until,dueFrom:'Next due '+from,dueUntil:'Next due '+until,calendar};
}
export function stoppedDue(note:string|undefined, format:Intl.DateTimeFormat) {
  const match=/^Next due (.+)$/.exec(note??'');
  const epoch=match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(epoch) ? 'Was due '+format.format(epoch) : undefined;
}
export function outcomeWords(event:Event) {
  return event.outcomes?.map(run=>(run.kind==='notice'?'Inbox notice':run.kind==='program'?'Program':'Agent wake')+' '+(run.state??'delivered')).join(' → ') || event.event;
}
/** The recorded events of a read, by household day, each with what its deliveries came to and, for a failure, why. */
export function eventsByDay(log: readonly Event[] | undefined, outcomes: readonly Outcome[] | undefined, zone: string) {
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
    const date = localDate(Date.parse(event.at),zone);
    const group = days.get(date);
    const row={...event,failure,outcomes:byEvent.get(event.seq)};
    if (group) group.push(row); else days.set(date,[row]);
  }
  return days;
}
