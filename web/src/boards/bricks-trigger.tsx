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
import { Action, Actions, Asking, Chip, Fact, Facts, Lead, Loading, Note, Problem, Row, Rows, Section, State, Time, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { jobFailed, stateTone, stateWord } from './tempo-data';

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
  const next = nextScheduledAt(trigger), agent = triggerAgent(trigger), paused = !!agent && pauses.some((item) => item.agent === agent);
  const standing = trigger.lifespan === 'until-stopped';
  if (small) return (
    <p className="board-brief">
      <State tone={stateTone(trigger, pauses)}>{stateWord(trigger, pauses)}</State> {title(trigger)}{next ? <> · next <Time at={next} /></> : null}
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
  const shownRuns = runs ?? [];
  // One question at a time: while the brick asks, the question stands in place of its controls.
  const controls = asking ? (
        asking === 'runNow'
          ? <Asking label="Trigger actions" kind="primary" yes="Run it now" no="Not now" busy={busy} onYes={() => void run('runNow')} onNo={() => setAsking('')} />
          : <Asking label="Trigger actions" yes={`${stopWord} this trigger`} no="Keep it" busy={busy} onYes={() => void run('stop')} onNo={() => setAsking('')} />
      ) : (
        <Actions label="Trigger actions">
          {!terminal(trigger) && <>
            <Action disabled={busy || !trigger.enabled || paused || trigger.state === 'held' || trigger.state === 'firing'} onClick={() => setAsking('runNow')}>Run now…</Action>
            <Action disabled={busy} onClick={() => setAsking('stop')}>{stopWord}…</Action>
          </>}
          {standing && !trigger.enabled && trigger.state === 'stopped' && !trigger.scheduleRemovedAt && <Action kind="primary" disabled={busy} onClick={() => void run('start')}>Start</Action>}
          {primary && agent && <Action kind="quiet" disabled={busy} onClick={() => void run(paused ? 'resume' : 'pause')}>{paused ? 'Resume agent' : 'Pause agent'}</Action>}
        </Actions>
      );
  const prose = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
  return (
    <>
      <Lead>{title(trigger)}</Lead>
      <div className="board-meta">
        <State tone={stateTone(trigger, pauses)}>{stateWord(trigger, pauses)}</State>
        <span>{primary ? `${kindLabels[triggerKind(trigger)]} · ${trigger.sourceKind} · ${trigger.lifespan} · ${status(trigger, pauses)}` : kindLabels[triggerKind(trigger)]}</span>
      </div>
      {failed && <p className="board-problem">Its last firing failed.</p>}
      <Facts>
        <Fact label="When">{source(trigger)} <small className="board-zone">{zone}</small></Fact>
        {next && <Fact label="Due"><Time at={next} /></Fact>}
        {trigger.lastFiredAt && <Fact label="Last fired"><Time at={trigger.lastFiredAt} /></Fact>}
      </Facts>
      {!primary && controls}
      {primary && <Facts>
        <Fact label="Set by">{trigger.ownerKind === 'household' ? 'Household'
          : trigger.ownerKind === 'agent' && trigger.owner ? <>Agent · <Chip place={{ brick: 'agent', params: { agent: trigger.owner } }}>{name(trigger.owner)}</Chip></>
          : `Person · ${displayName(trigger.owner)}`}</Fact>
        <Fact label="Target">{program ? program.program.name : target(trigger)}{agent && <> <Chip place={{ brick: 'tempo', params: { agent } }}>{name(agent)}’s tempo</Chip></>}</Fact>
        {primary && <>
          {trigger.project && <Fact label="Project"><Chip place={{ brick: 'project', params: { project: trigger.project } }}>{trigger.project}</Chip></Fact>}
          {!!trigger.needs?.length && <Fact label="Machine needs">{trigger.needs.join(', ')}</Fact>}
          {trigger.prefers != null && <Fact label="Machine preferences">{trigger.prefers.join(', ') || 'None'}</Fact>}
          {(trigger.wantsModel || (trigger.targetKind === 'inbox' && trigger.toKind === 'agent')) && <Fact label="Requested model">{trigger.wantsModel || 'Agent default'}</Fact>}
          <Fact label="Enabled">{trigger.enabled ? 'Yes' : 'No'}</Fact>
        </>}
        {trigger.file && <Fact label="Repository file"><span className="font-mono">{trigger.file}</span></Fact>}
        {trigger.instructions && <Fact wide label="Words"><span style={prose}>{primary || trigger.instructions.length <= 240 ? trigger.instructions : trigger.instructions.slice(0, 240) + '…'}</span></Fact>}
        {primary && <>
          {program && <Fact wide label="House program definition"><pre className="board-tail">{JSON.stringify(program.program, null, 2)}</pre></Fact>}
          {lastDecision && <Fact wide label="Last program result">{lastDecision}</Fact>}
          {program?.programState != null && <Fact wide label="Program state"><pre className="board-tail">{JSON.stringify(program.programState, null, 2)}</pre></Fact>}
          {journal && <>
            <Fact wide label="Lessons"><span style={prose}>{journal.lessons || 'No lessons yet.'}</span></Fact>
            <Fact wide label="Saved state"><pre className="board-tail">{journal.state || 'Empty'}</pre>{journal.stateChangedAt && <p className="board-note">Last changed <Time at={journal.stateChangedAt} /></p>}</Fact>
          </>}
        </>}
      </Facts>}
      {primary && shownRuns.length > 0 && (
        <Section title="Recent runs">
          <div className="board-tempo">
            <Rows beside>{shownRuns.map((item) => (
              <Row key={item.event + '-' + item.kind} place={item.conversation ? { brick: 'session', params: { session: item.conversation.id } } : undefined}
                title={<span className={jobFailed(item.job?.state) ? 'board-tempo-failed' : undefined}>{runWords(item).join(' · ')}</span>}
                end={<Time at={item.at} />} />
            ))}</Rows>
          </div>
        </Section>
      )}
      {primary && (
        <Section title="Recent history">
          {entries?.length ? (
            <div className="board-tempo">
              <Rows beside>{entries.slice(0, 40).map((event) => <Row key={event.seq} title={event.event} meta={event.note || undefined} end={<Time at={event.at} />} />)}</Rows>
            </div>
          ) : entries ? <Note>No events yet.</Note>
            : log.status === 'loading' ? <Loading /> : <Note>Trigger history unavailable.</Note>}
        </Section>
      )}
      {primary && controls}
      {busy && <p role="status" className="board-note">Waiting for Tempo…</p>}
      <Problem>{error}</Problem>
      {primary && <Note>To change its times or words, ask its agent: Tempo has no editor here or on the desktop.</Note>}
    </>
  );
}
