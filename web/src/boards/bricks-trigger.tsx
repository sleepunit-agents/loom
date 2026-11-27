/** The `trigger` brick: one Tempo trigger as the desktop's reader shows it (pieces/tempo/index.tsx, TriggerDetails):
 * the same reads, the same words, and its five buttons through the same calls (pieces/tempo/commands.ts). Pause and
 * resume are of the trigger's agent, as there. Running it now and stopping it ask first. Tempo has no editor on the
 * desktop either: a trigger's times and words are changed by asking its agent. */
import { useMemo, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { displayName } from '../kit/words';
import { tempoFailureMessage } from '../pieces/tempo/actions';
import { tempoActions } from '../pieces/tempo/commands';
import { history, kindLabels, nextScheduledAt, source, status, target, terminal, title, triggerAgent, triggerKind, type TriggerEvent } from '../pieces/tempo/model';
import { journalDetailsQuery, programDetailsQuery, tempoCardQuery, triggerHistoryQuery, type JournalDetails, type ProgramDetails, type TempoData } from '../pieces/tempo/query';
import { runWords, type TriggerRun } from '../pieces/tempo/runs';
import { useAgentNames } from './agents-data';
import { Chip, Loading, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { clock, jobFailed, stateWord } from './tempo-data';

type Asking = '' | 'runNow' | 'stop';

export function Trigger({ params, form, act, raise }: BodyProps) {
  const id = words(params.trigger), primary = form === 'primary', small = form === 'compact';
  const read = useDataQuery<TempoData>(tempoCardQuery, { id }, { keep: true });
  const trigger = read.status === 'live' ? read.data?.triggers?.find((item) => item.id === id) : undefined;
  const log = useDataQuery<{ triggerLog: TriggerEvent[]; tempoRecentRuns: TriggerRun[] }>(triggerHistoryQuery, { id }, { keep: true, pause: small || !trigger });
  const detail = useDataQuery<ProgramDetails>(programDetailsQuery, { id }, { keep: true, pause: !primary || !trigger });
  const journalDetail = useDataQuery<JournalDetails>(journalDetailsQuery, { id }, { keep: true, pause: !primary || !trigger });
  const name = useAgentNames();
  const actions = useMemo(() => tempoActions(), []);
  const runs = log.status === 'live' && Array.isArray(log.data?.tempoRecentRuns) ? log.data.tempoRecentRuns : undefined;
  const failed = !!trigger && (trigger.state === 'failed' || jobFailed(runs?.[0]?.job?.state));
  // Nothing is compared until the runs are read, or a failure already there would look new.
  const known = !!trigger && (small || !!runs || log.status !== 'loading');
  const own = useOwnFlag(known ? (failed ? `failed:${runs?.[0]?.event ?? ''}` : 'ok') : undefined, raise, (_was, now) => (now === 'ok' ? null : 'Failed'));
  const [asking, setAsking] = useState<Asking>(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (read.status === 'loading' || (read.status === 'live' && !read.data)) return <Loading />;
  if (!trigger) return <Unavailable what="trigger" />;
  const pauses = read.data?.agentPauses ?? [], zone = read.data?.tempoTimezone ?? 'UTC';
  const format = clock(zone), time = (at: string) => format.format(new Date(at));
  const next = nextScheduledAt(trigger), agent = triggerAgent(trigger), paused = !!agent && pauses.some((item) => item.agent === agent);
  const standing = trigger.lifespan === 'until-stopped';
  if (small) return (
    <p className="board-brief">
      <span className="board-state" data-running={trigger.state === 'firing'}>{stateWord(trigger, pauses)}</span> {title(trigger)}{next ? ` · next ${time(next)}` : ''}
    </p>
  );
  const run = async (action: 'runNow' | 'stop' | 'start' | 'pause' | 'resume') => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      own();
      if (action === 'pause' || action === 'resume') await actions[action](agent!);
      else if (action === 'start') await actions.start!(trigger.id);
      else await actions[action](trigger.id);
      act(action, {}); setAsking('');
    } catch (failure) { setError(tempoFailureMessage(failure, 'Tempo could not complete that action. Try again.')); }
    finally { setBusy(false); }
  };
  const program = detail.status === 'live' ? detail.data?.tempoProgram : null;
  const journal = journalDetail.status === 'live' ? journalDetail.data?.tempoJournal : null;
  const entries = log.status === 'live' && Array.isArray(log.data?.triggerLog) ? history(log.data.triggerLog, trigger.id) : undefined;
  const lastDecision = program?.lastResult ?? entries?.find((event) => event.event === 'program')?.note;
  const stopWord = standing ? 'Stop' : 'Cancel';
  const shownRuns = primary ? runs ?? [] : (runs ?? []).slice(0, 3);
  return (
    <>
      <p className="board-lead">{title(trigger)}</p>
      <div className="board-line">
        <span className="board-state" data-running={trigger.state === 'firing'}>{stateWord(trigger, pauses)}</span>
        <span className="text-muted-foreground">{kindLabels[triggerKind(trigger)]} · {trigger.sourceKind} · {trigger.lifespan} · {status(trigger, pauses)}</span>
      </div>
      <p>{source(trigger)}</p>
      {next && <p>Due: {time(next)} · {zone}</p>}
      {failed && <p className="text-destructive">Its last firing failed.</p>}
      <dl style={{ marginTop: '.8rem' }}>
        <div><dt>Set by</dt><dd>{trigger.ownerKind === 'household' ? 'Household'
          : trigger.ownerKind === 'agent' && trigger.owner ? <>Agent · <Chip place={{ brick: 'agent', params: { agent: trigger.owner } }}>{name(trigger.owner)}</Chip></>
          : `Person · ${displayName(trigger.owner)}`}</dd></div>
        <div><dt>Target</dt><dd>{program ? program.program.name : target(trigger)}{agent && <> <Chip place={{ brick: 'tempo', params: { agent } }}>{name(agent)}’s tempo</Chip></>}</dd></div>
        {trigger.lastFiredAt && <div><dt>Last fired</dt><dd>{time(trigger.lastFiredAt)}</dd></div>}
        {primary && <>
          {trigger.project && <div><dt>Project</dt><dd><Chip place={{ brick: 'project', params: { project: trigger.project } }}>{trigger.project}</Chip></dd></div>}
          {!!trigger.needs?.length && <div><dt>Machine needs</dt><dd>{trigger.needs.join(', ')}</dd></div>}
          {trigger.prefers != null && <div><dt>Machine preferences</dt><dd>{trigger.prefers.join(', ') || 'None'}</dd></div>}
          {(trigger.wantsModel || (trigger.targetKind === 'inbox' && trigger.toKind === 'agent')) && <div><dt>Requested model</dt><dd>{trigger.wantsModel || 'Agent default'}</dd></div>}
          {program && <div><dt>House program definition</dt><dd><pre className="board-tail">{JSON.stringify(program.program, null, 2)}</pre></dd></div>}
          {lastDecision && <div><dt>Last program result</dt><dd>{lastDecision}</dd></div>}
          {program?.programState != null && <div><dt>Program state</dt><dd><pre className="board-tail">{JSON.stringify(program.programState, null, 2)}</pre></dd></div>}
          <div><dt>Enabled</dt><dd>{trigger.enabled ? 'Yes' : 'No'}</dd></div>
          {journal && <>
            <div><dt>Lessons</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{journal.lessons || 'No lessons yet.'}</dd></div>
            <div><dt>Saved state</dt><dd><pre className="board-tail">{journal.state || 'Empty'}</pre>{journal.stateChangedAt && <p className="text-muted-foreground">Last changed {time(journal.stateChangedAt)} · {zone}</p>}</dd></div>
          </>}
        </>}
        {trigger.instructions && <div><dt>Words</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{primary || trigger.instructions.length <= 240 ? trigger.instructions : trigger.instructions.slice(0, 240) + '…'}</dd></div>}
        {trigger.file && <div><dt>Repository file</dt><dd>{trigger.file}</dd></div>}
        {shownRuns.length > 0 && (
          <div>
            <dt>Recent runs</dt>
            <dd>
              {shownRuns.map((item) => (
                <div key={item.event + '-' + item.kind} className="board-line">
                  <span className="text-muted-foreground">{time(item.at)}</span>
                  <span className={jobFailed(item.job?.state) ? 'text-destructive' : undefined}>{runWords(item).join(' · ')}</span>
                  {item.conversation && <Chip place={{ brick: 'session', params: { session: item.conversation.id } }}>Session</Chip>}
                </div>
              ))}
            </dd>
          </div>
        )}
        {primary && (
          <div>
            <dt>Recent history</dt>
            <dd>
              {entries?.length ? entries.slice(0, 40).map((event) => <p key={event.seq}>{time(event.at)} · {event.event}{event.note && ` · ${event.note}`}</p>)
                : entries ? <p className="text-muted-foreground">No events yet.</p>
                : log.status === 'loading' ? <Loading /> : <p className="text-muted-foreground">Trigger history unavailable.</p>}
            </dd>
          </div>
        )}
      </dl>
      <div className="board-line" role="group" aria-label="Trigger actions">
        {asking === 'runNow' ? <><button type="button" className="board-action" disabled={busy} onClick={() => void run('runNow')}>Run it now</button><button type="button" className="board-action" onClick={() => setAsking('')}>Not now</button></>
          : asking === 'stop' ? <><button type="button" className="board-action" disabled={busy} onClick={() => void run('stop')}>{stopWord} this trigger</button><button type="button" className="board-action" onClick={() => setAsking('')}>Keep it</button></>
          : <>
            {!terminal(trigger) && <>
              <button type="button" className="board-action" disabled={busy || !trigger.enabled || paused || trigger.state === 'held' || trigger.state === 'firing'} onClick={() => setAsking('runNow')}>Run now…</button>
              <button type="button" className="board-action" disabled={busy} onClick={() => setAsking('stop')}>{stopWord}…</button>
            </>}
            {standing && !trigger.enabled && trigger.state === 'stopped' && !trigger.scheduleRemovedAt && <button type="button" className="board-action" disabled={busy} onClick={() => void run('start')}>Start</button>}
            {agent && <button type="button" className="board-action" disabled={busy} onClick={() => void run(paused ? 'resume' : 'pause')}>{paused ? 'Resume agent' : 'Pause agent'}</button>}
          </>}
      </div>
      {busy && <p role="status" className="text-muted-foreground">Waiting for Tempo…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <p className="text-muted-foreground">To change its times or words, ask its agent: Tempo has no editor here or on the desktop.</p>
    </>
  );
}
