/** The `tempo` brick: one agent's triggers as the desktop's Tempo app lists them (pieces/tempo): the same read, the
 * same order, the same words for a kind, a source and a state. The big form adds the day's recorded firings, as
 * Tempo's "Recent history" shows a day. What can be done to a trigger is in its `trigger` brick. */
import { useMemo } from 'react';
import { triggerRef } from '../../../src/core/boards/refs';
import { localDate } from '../../../src/core/tempo/calendar';
import { useDataQuery } from '../data/graphql';
import { eventsByDay, historyQuery, historyRange, outcomeWords, stoppedDue, type DayFeed, type Event } from '../pieces/tempo/day-model';
import { kindLabels, nextScheduledAt, recordedOutcomes, rows, source, terminal, title, triggerKind, type Trigger } from '../pieces/tempo/model';
import { tempoQuery, type TempoData } from '../pieces/tempo/query';
import { Chip, Loading, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { clock, jobFailed, stateWord } from './tempo-data';

export const tempoClockQuery = 'query BrickTempoClock{deskTime{at}}';
const firings = ['fired', 'failed', 'failure'];
const eventFailed = (event: Event | undefined) => !!event && (event.event !== 'fired' || !!event.outcomes?.some((run) => jobFailed(run.state)));
/** A chip that places a trigger's brick, or its name alone when its id is not one a board can hold. */
export const triggerChip = (trigger: Trigger) => triggerRef.test(trigger.id)
  ? <Chip place={{ brick: 'trigger', params: { trigger: trigger.id } }}>{title(trigger)}</Chip> : <span>{title(trigger)}</span>;
/** Why an event went as it did, as the day's history says it. */
function eventDetails(event: Event, format: Intl.DateTimeFormat): string[] {
  const details = event.outcomes?.flatMap((run) => (run.reason ? [run.reason] : [])) ?? [];
  const due = event.event === 'stopped' || event.event === 'held' ? stoppedDue(event.note, format) : undefined;
  if (due) details.push(due);
  if (event.failure) details.push(event.failure);
  if (event.event === 'missed') details.push(...recordedOutcomes([{ state: 'missed', note: event.note, scheduled: false }]));
  return details;
}

export function Tempo({ params, form, raise }: BodyProps) {
  const agent = words(params.agent), primary = form === 'primary';
  const read = useDataQuery<TempoData>(tempoQuery, undefined, { keep: true });
  const desk = useDataQuery<{ deskTime: { at: number } | null }>(tempoClockQuery, undefined, { keep: true, pause: form === 'compact' });
  const zone = read.data?.tempoTimezone ?? 'UTC', now = desk.data?.deskTime?.at;
  const today = now == null ? undefined : localDate(now, zone);
  const feed = useDataQuery<DayFeed>(historyQuery, historyRange(today ?? '1970-01-02', 1, false), { keep: true, pause: !today || form === 'compact' });
  const live = read.status === 'live' && Array.isArray(read.data?.triggers);
  const mine = useMemo(() => (live ? rows(read.data!.triggers, 'all', '', agent) : []), [live, read.data, agent]);
  const log = feed.status === 'live' ? feed.data?.triggerLog : undefined;
  const days = useMemo(() => eventsByDay(log, feed.data?.tempoCalendarOutcomes, zone), [log, feed.data, zone]);
  // The newest firing of each trigger that the day's read holds, with what it came to.
  const last = useMemo(() => {
    const newest = new Map<string, Event>();
    for (const event of [...days.values()].flat()) if (firings.includes(event.event) && (newest.get(event.trigger)?.seq ?? -1) < event.seq) newest.set(event.trigger, event);
    return newest;
  }, [days]);
  const failed = (trigger: Trigger) => trigger.state === 'failed' || eventFailed(last.get(trigger.id));
  // Nothing is counted until the day's firings are read, or a failure already there would look new.
  const settled = form === 'compact' || !!log || (desk.status !== 'loading' && (!today || feed.status !== 'loading'));
  const failures = live && settled ? mine.filter(failed).length : undefined;
  useOwnFlag(failures, raise, (was, count) => (count > was ? 'A firing failed' : null));
  if (read.status === 'loading' || (read.status === 'live' && !read.data)) return <Loading />;
  if (!live) return <Unavailable what="agent's tempo" />;
  const pause = read.data!.agentPauses?.find((p) => p.agent === agent), pauses = read.data!.agentPauses ?? [];
  const format = clock(zone), time = (at: string | number) => format.format(new Date(at));
  const next = mine.map(nextScheduledAt).find((at): at is string => !!at);
  if (form === 'compact') return (
    <p className="board-brief">
      {mine.length === 1 ? '1 trigger' : `${mine.length} triggers`}{mine.some(failed) ? ` · ${mine.filter(failed).length} failed` : ''}{pause ? ' · agent paused' : ''}{next ? ` · next ${time(next)}` : ''}
    </p>
  );
  const shown = primary ? mine : mine.slice(0, 6);
  const todays = (today ? days.get(today) ?? [] : []).filter((event) => mine.some((t) => t.id === event.trigger))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq);
  return (
    <>
      <div className="board-line">
        <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip>
        <span className="text-muted-foreground">{mine.length === 1 ? '1 trigger' : `${mine.length} triggers`} · {zone}</span>
        {pause && <span className="board-state">Paused since {time(pause.since)}</span>}
      </div>
      {!mine.length && <p className="text-muted-foreground">No triggers here. Ask an agent in chat to set a trigger.</p>}
      {shown.map((trigger) => {
        const due = nextScheduledAt(trigger), event = last.get(trigger.id);
        return (
          <div key={trigger.id} style={{ marginTop: '.5rem' }}>
            <div className="board-line">
              {triggerChip(trigger)}
              <span className="board-state" data-running={trigger.state === 'firing'}>{stateWord(trigger, pauses)}</span>
              <span className="text-muted-foreground">{kindLabels[triggerKind(trigger)]}</span>
            </div>
            <p className="text-muted-foreground">
              {[source(trigger), due ? `Next ${time(due)}` : terminal(trigger) ? 'No next firing' : '',
                trigger.lastFiredAt ? `Last fired ${time(trigger.lastFiredAt)}` : 'Never fired',
                event ? [outcomeWords(event), ...eventDetails(event, format)].join(', ') : ''].filter(Boolean).join(' · ')}
            </p>
            {failed(trigger) && <p className="text-destructive">Its last firing failed.</p>}
          </div>
        );
      })}
      {!primary && mine.length > shown.length && <p className="text-muted-foreground">And {mine.length - shown.length} more.</p>}
      {primary && (
        <dl style={{ marginTop: '.8rem' }}>
          <div>
            <dt>Today</dt>
            <dd>
              {!today || !log ? (desk.status === 'loading' || feed.status === 'loading' ? <Loading /> : <p className="text-muted-foreground">Firing history unavailable.</p>)
                : todays.length ? todays.map((event) => (
                  <div key={event.seq} className="board-line">
                    <span className="text-muted-foreground">{time(event.at)}</span>
                    {triggerChip(mine.find((t) => t.id === event.trigger)!)}
                    <span>{[outcomeWords(event), ...eventDetails(event, format)].join(' · ')}</span>
                  </div>
                )) : <p className="text-muted-foreground">No recorded activity for this day.</p>}
            </dd>
          </div>
        </dl>
      )}
    </>
  );
}
