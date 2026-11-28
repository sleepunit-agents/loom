/** The `tempo` brick: one agent's triggers as the desktop's Tempo app lists them (pieces/tempo): the same read, the
 * same order, the same words for a kind, a source and a state. The big form adds the day's recorded firings, as
 * Tempo's "Recent history" shows a day, and the desktop's Create trigger form (pieces/tempo/create.tsx): its fields,
 * its input and its call (tempo.set through pieces/tempo/commands.ts), with this agent as who sets it and whom it
 * wakes until the member changes them. Tempo decides whether this member may set what was asked, and its refusal is
 * said here. The board is told `create` and nothing typed. What can be done to a trigger that exists is in its
 * `trigger` brick. */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { triggerRef } from '../../../src/core/boards/refs';
import { localDate } from '../../../src/core/tempo/calendar';
import { useDataQuery } from '../data/graphql';
import { eventsByDay, historyQuery, historyRange, outcomeWords, stoppedDue, type DayFeed, type Event } from '../pieces/tempo/day-model';
import { kindLabels, nextScheduledAt, recordedOutcomes, rows, source, terminal, title, triggerKind, type Trigger } from '../pieces/tempo/model';
import { tempoQuery, type TempoData } from '../pieces/tempo/query';
import { tempoFailureMessage } from '../pieces/tempo/actions';
import { tempoActions } from '../pieces/tempo/commands';
import type { NewTrigger } from '../../../src/core/tempo/triggers';
import { Action, Actions, Chip, Few, Field, Group, Lead, Loading, More, Note, Problem, Row, Rows, Section, Segmented, State, Time, Unavailable, count, useOwnFlag, words, type Act, type BodyProps, type Place } from './brick-kit';
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

export function Tempo({ params, form, act, raise }: BodyProps) {
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
  const own = useOwnFlag(failures, raise, (was, count) => (count > was ? 'A firing failed' : null));
  const [creating, setCreating] = useState(false), [created, setCreated] = useState(false);
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
  // The form, opened by a press, takes the place of the list and the day, as the desktop's takes its reader's.
  if (primary && creating) return (
    <CreateTrigger agent={agent} zone={zone} act={act} own={own} done={(made) => { setCreating(false); setCreated(made); }} />
  );
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
      {primary && <Actions label="Tempo actions">
        <Action onClick={() => { setCreated(false); setCreating(true); }}>New trigger…</Action>
        {created && <span role="status" className="board-note">Created. It is in the list once Tempo has it.</span>}
      </Actions>}
    </>
  );
}

type Source = NewTrigger['sourceKind'];
type Owner = NewTrigger['ownerKind'];
type Target = NewTrigger['targetKind'];
type Lifespan = NewTrigger['lifespan'];
type Recipient = 'agent' | 'person';
type Content = 'words' | 'file';
// The desktop form's choices, in its order and its words (pieces/tempo/create.tsx).
const sources: { value: Source; label: string }[] = [{ value: 'time', label: 'A time' }, { value: 'pull-request', label: 'A pull request changing' },
  { value: 'answer', label: 'An answer arriving' }, { value: 'job', label: 'A job stopping' }];
const lifespans: { value: Lifespan; label: string }[] = [{ value: 'once', label: 'The next time only' }, { value: 'today', label: 'For today' }, { value: 'until-stopped', label: 'Until stopped' }];
const owners: { value: Owner; label: string }[] = [{ value: 'member', label: 'A person' }, { value: 'agent', label: 'An agent' }, { value: 'household', label: 'The household' }];
const targets: { value: Target; label: string }[] = [{ value: 'inbox', label: 'An inbox item' }, { value: 'operation', label: 'An operation' }];
const recipients: { value: Recipient; label: string }[] = [{ value: 'agent', label: 'Agent' }, { value: 'person', label: 'Person' }];
const contents: { value: Content; label: string }[] = [{ value: 'words', label: 'Words' }, { value: 'file', label: 'Repository file' }];
const watchLabel: Record<Exclude<Source, 'time'>, [string, string]> = { 'pull-request': ['Pull request', 'change:…'], job: ['Job', 'job:…'], answer: ['Answer to', 'approval:… or question:…'] };

/** The desktop's Create trigger form, made of the kit's words, sending the input that form sends. */
function CreateTrigger({ agent, zone, act, own, done }: { agent: string; zone: string; act: Act; own(): void; done(made: boolean): void }) {
  const actions = useMemo(() => tempoActions(), []);
  const [note, setNote] = useState(''), [source, setSource] = useState<Source>('time'), [times, setTimes] = useState(''), [days, setDays] = useState('');
  const [watches, setWatches] = useState(''), [lifespan, setLifespan] = useState<Lifespan>('once');
  const [ownerKind, setOwnerKind] = useState<Owner>('agent'), [owner, setOwner] = useState(agent);
  const [target, setTarget] = useState<Target>('inbox'), [toKind, setToKind] = useState<Recipient>('agent'), [to, setTo] = useState(agent);
  const [operation, setOperation] = useState(''), [content, setContent] = useState<Content>('words'), [text, setText] = useState(''), [project, setProject] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const t = (value: string) => value.trim();
  const ready = !!t(note) && (source === 'time' ? !!t(times) : !!t(watches)) && (ownerKind === 'household' || !!t(owner))
    && (target === 'operation' ? !!t(operation) : !!t(to) && !!t(text));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending.current) return;
    const input: NewTrigger = { ownerKind, owner: ownerKind === 'household' ? null : t(owner), sourceKind: source, lifespan, targetKind: target,
      note: t(note), project: t(project) || null,
      ...(source === 'time' ? { times: t(times), days: t(days) || null } : { watches: t(watches) }),
      ...(t(to) ? { toKind, to: t(to) } : {}),
      ...(target === 'operation' ? { target: t(operation) } : content === 'file' ? { file: t(text) } : { instructions: t(text) }) };
    pending.current = true; setBusy(true); setError('');
    try { own(); await actions.create!(input); act('create', {}); done(true); }
    catch (failure) { setError(tempoFailureMessage(failure, 'Tempo could not create that trigger. Check the details and your access.')); }
    finally { pending.current = false; setBusy(false); }
  };
  const [watchWord, watchHint] = source === 'time' ? ['', ''] : watchLabel[source];
  return (
    <form className="board-form" aria-label="Create trigger" onSubmit={(e) => void save(e)}>
      <Lead>A new trigger</Lead>
      <Field label="Label" value={note} onChange={setNote} disabled={busy} />
      <Group title="When it fires">
      <Segmented<Source> label="Source" value={source} options={sources} onChange={setSource} disabled={busy} />
      {source === 'time' ? <>
        <Field label={`Time (${zone})`} value={times} onChange={setTimes} disabled={busy} placeholder="08:31" />
        <Field label="Days" value={days} onChange={setDays} disabled={busy} placeholder="weekdays, or leave empty for every day" />
        <Note>Use household times such as 08:31, 14:31, or a date with its offset such as 2026-11-20T08:31-06:00.</Note>
      </> : <Field label={watchWord} value={watches} onChange={setWatches} disabled={busy} placeholder={watchHint} />}
      <Segmented<Lifespan> label="Lifespan" value={lifespan} options={lifespans} onChange={setLifespan} disabled={busy} />
      </Group>
      <Group title="Whose it is">
      <Segmented<Owner> label="Set by" value={ownerKind} options={owners} onChange={setOwnerKind} disabled={busy} />
      {ownerKind !== 'household' && <Field label={ownerKind === 'member' ? 'Person' : 'Agent'} value={owner} onChange={setOwner} disabled={busy} />}
      <Field label="Project" value={project} onChange={setProject} disabled={busy} />
      </Group>
      <Group title="What it does">
      <Segmented<Target> label="Target" value={target} options={targets} onChange={setTarget} disabled={busy} />
      <Segmented<Recipient> label="Recipient kind" value={toKind} options={recipients} onChange={setToKind} disabled={busy} />
      <Field label="Recipient" value={to} onChange={setTo} disabled={busy} />
      {target === 'operation' ? <Field label="Operation" value={operation} onChange={setOperation} disabled={busy} placeholder="tempo.sweep" /> : <>
        <Segmented<Content> label="Content" value={content} options={contents} onChange={setContent} disabled={busy} />
        <Field label={content === 'file' ? 'Repository file' : 'Words'} value={text} onChange={setText} long={content === 'words'} disabled={busy} />
      </>}
      </Group>
      <Actions label="Create trigger">
        <Action submit kind="primary" disabled={busy || !ready}>{busy ? 'Creating…' : 'Create trigger'}</Action>
        <Action kind="quiet" disabled={busy} onClick={() => done(false)}>Back to the list</Action>
      </Actions>
      <Problem>{error}</Problem>
    </form>
  );
}
