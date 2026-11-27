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
import { Chip, Few, Loading, More, Note, Row, Rows, Section, State, Time, Unavailable, count, useOwnFlag, words, type BodyProps, type Place } from './brick-kit';
import { clock, jobFailed, stateTone, stateWord } from './tempo-data';

export const tempoClockQuery = 'query BrickTempoClock{deskTime{at}}';
const firings = ['fired', 'failed', 'failure'];
const eventFailed = (event: Event | undefined) => !!event && (event.event !== 'fired' || !!event.outcomes?.some((run) => jobFailed(run.state)));
/** Where a trigger's row leads: its own brick, or nowhere when its id is not one a board can hold. */
const triggerPlace = (trigger: Trigger): Place | undefined => (triggerRef.test(trigger.id) ? { brick: 'trigger', params: { trigger: trigger.id } } : undefined);
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
  const format = clock(zone);
  const next = mine.map(nextScheduledAt).find((at): at is string => !!at);
  if (form === 'compact') return (
    <p className="board-brief">
      {count(mine.length, 'trigger')}{mine.some(failed) ? ` · ${mine.filter(failed).length} failed` : ''}{pause ? ' · agent paused' : ''}{next ? <> · next <Time at={next} /></> : null}
    </p>
  );
  const todays = (today ? days.get(today) ?? [] : []).filter((event) => mine.some((t) => t.id === event.trigger))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq);
  return (
    <>
      <div className="board-meta">
        <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip>
        <span>{count(mine.length, 'trigger')}</span>
        {pause && <State tone="waiting">Paused <Time at={pause.since} /></State>}
        <small className="board-zone">{zone}</small>
      </div>
      {!mine.length ? <Note>No triggers here. Ask an agent in chat to set a trigger.</Note> : (
        <Few of={mine} first={primary ? mine.length : 5} fit={!primary}>{(shown, hidden) => <>
        <div className="board-tempo">
          <Rows beside>
            {shown.map((trigger) => {
              const due = nextScheduledAt(trigger), event = last.get(trigger.id);
              return (
                <Row key={trigger.id} place={triggerPlace(trigger)} title={title(trigger)} end={<State tone={stateTone(trigger, pauses)}>{stateWord(trigger, pauses)}</State>}
                  meta={<>
                    <span>{kindLabels[triggerKind(trigger)]} · {source(trigger)}</span>
                    {primary && <span className="board-tempo-times">
                      {due ? <>Next <Time at={due} /></> : terminal(trigger) ? 'No next firing' : null}{(due || terminal(trigger)) && ' · '}
                      {trigger.lastFiredAt ? <>Last fired <Time at={trigger.lastFiredAt} /></> : 'Never fired'}
                      {event ? ' · ' + [outcomeWords(event), ...eventDetails(event, format)].join(', ') : ''}</span>}
                    {failed(trigger) && <span className="board-tempo-failed">Its last firing failed.</span>}
                  </>} />
              );
            })}
          </Rows>
        </div>
        <More n={hidden} />
        </>}</Few>
      )}
      {primary && (
        <Section title="Today">
          {!today || !log ? (desk.status === 'loading' || feed.status === 'loading' ? <Loading /> : <Note>Firing history unavailable.</Note>)
            : todays.length ? (
              <div className="board-tempo">
                <Rows beside>{todays.map((event) => { const trigger = mine.find((t) => t.id === event.trigger)!; return (
                  <Row key={event.seq} place={triggerPlace(trigger)} title={title(trigger)} meta={[outcomeWords(event), ...eventDetails(event, format)].join(' · ')}
                    end={<Time at={event.at} />} />
                ); })}</Rows>
              </div>
            ) : <Note>No recorded activity for this day.</Note>}
        </Section>
      )}
    </>
  );
}
