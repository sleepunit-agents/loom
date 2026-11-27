/** The `machines` brick: the desktop's "Machines and jobs" app (pieces/machines, pieces/runtime/machines.tsx) on a
 * board. Its reads are that app's own (pieces/runtime/machines-query.ts) and one small selection of the machine
 * facts that app does not show (the loom machine, last seen, slots) beside the household's alert lines. A
 * machine's readings and open conditions are said in the desktop's words (pieces/runtime/machine-readings.ts).
 * Read grants are requested and answered by the desktop's own operations; the alert lines are saved by
 * `machine.setAlertLines`, which only a household owner may call. Enrolling a machine ends in a credential for its
 * worker, and the desktop's Machines app offers neither that nor revoking one: neither is offered here. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { liveAgents } from '../data/live-agents';
import { memberOperation } from '../data/operation';
import { alertControls, alertLinesSelection, alertPatch, type AlertLines } from '../pieces/household/alert-lines-model';
import { hostingWord, listedAgents } from '../pieces/runtime/machine-hosting-model';
import { conditionLine, readingAge, readingLine, readingsOf, type Reading } from '../pieces/runtime/machine-readings';
import { machinesInventoryQuery, ownerMachinesQuery, signInWarnings, type Machine, type MachineReadEntry, type MachinesInventory, type OwnerMachinesData, type ReaderCard } from '../pieces/runtime/machines-query';
import { isMember, isRef, useHouseholdOwner } from './admin-data';
import { Action, Actions, Chip, Fact, Facts, Few, Lead, Loading, More, Note, Opened, Opens, Problem, Row, Rows, Section, State, Time, Unavailable, count, type Act, type BodyProps } from './brick-kit';

export const machineFactsQuery = `query BrickMachineFacts { boxes { id sameMachineAsLoom lastSeenAt slots } ${alertLinesSelection} }`;
type MachineFacts = { boxes: { id: string; sameMachineAsLoom: boolean; lastSeenAt: string | null; slots: number | null }[]; boxAlertSettings: AlertLines[] };
/** The jobs of each of `count` agents the member may read, and the private ones on a machine the member owns,
 * as the desktop's jobs list reads them for one agent (pieces/attention/agent-jobs.tsx). */
export const machineJobsQuery = (count: number) => `query BrickMachineJobs(${Array.from({ length: count }, (_, i) => `$a${i}:String!`).join(',')}){${Array.from({ length: count }, (_, i) =>
  `j${i}:jobHistory(agent:$a${i},first:30){id agent title state box conversation queuedAt} p${i}:privateMachineJobs(agent:$a${i}){id agent box state queuedAt}`).join(' ')}}`;
type Job = { id: string; agent: string; title?: string; state: string; box: string | null; conversation?: string | null; queuedAt: string };
const current = ['queued', 'starting', 'running'];
const agentCap = 24;

function Jobs({ box, agents }: { box: string; agents: string[] }) {
  const ids = agents.slice(0, agentCap);
  const query = useMemo(() => machineJobsQuery(Math.max(ids.length, 1)), [ids.length]);
  const read = useDataQuery<Record<string, Job[]>>(query, Object.fromEntries((ids.length ? ids : ['']).map((id, i) => ['a' + i, id])), { keep: true, pause: !ids.length });
  if (!ids.length) return <Note>None right now.</Note>;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Note>Can’t read jobs right now.</Note>;
  const jobs = Object.values(read.data).flatMap((rows) => (Array.isArray(rows) ? rows : [])).filter((job) => job.box === box && current.includes(job.state))
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || b.id.localeCompare(a.id));
  if (!jobs.length) return <Note>None right now.</Note>;
  return (
    <Rows>
      {jobs.map((job) => {
        const title = 'title' in job ? job.title || 'Untitled job' : 'Private conversation';
        return (
          <Row key={job.id} title={title} place={isRef(job.conversation) ? { brick: 'session', params: { session: job.conversation } } : undefined}
            end={<><State tone={job.state === 'queued' ? 'neutral' : 'working'}>{job.state}</State>{isRef(job.agent) ? <Chip place={{ brick: 'agent', params: { agent: job.agent } }}>{job.agent}</Chip> : <span>{job.agent}</span>}<span>queued <Time at={job.queuedAt} /></span></>} />
        );
      })}
    </Rows>
  );
}

/** Who may read one of the member's own machines, the requests to change that, and what has been read: the
 * desktop's machine settings (pieces/runtime/machines.tsx, MachineSettings) with the same operations. */
function Settings({ box, agents, act }: { box: Machine; agents: string[]; act: Act }) {
  const [revision, refresh] = useState(0);
  const [history, setHistory] = useState<MachineReadEntry[] | null>();
  const [cards, setCards] = useState<ReaderCard[] | null>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [agent, select] = useState('');
  const readers = box.readers ?? [], readerList = JSON.stringify(readers);
  useEffect(() => {
    let here = true;
    setHistory(undefined); setCards(undefined); setError('');
    void memberOperation<MachineReadEntry[]>('machine.history', { machine: box.id }).then((rows) => { if (here) setHistory(rows); }, () => { if (here) setHistory(null); });
    if (!box.revokedAt) void memberOperation<ReaderCard[]>('machine.readerCards', { machine: box.id }).then((rows) => { if (here) setCards(rows); }, () => { if (here) setCards(null); });
    return () => { here = false; };
  }, [box.id, box.revokedAt, readerList, revision]);
  async function change(operation: string, input: object, report: () => void) {
    if (busy) return;
    setBusy(true); setError('');
    try { await memberOperation(operation, input); report(); select(''); refresh((n) => n + 1); }
    catch { setError('Could not change the read grant. Refresh to check the current settings.'); }
    finally { setBusy(false); }
  }
  const propose = (id: string, allow: boolean) => change('machine.proposeReader', { box: box.id, agent: id, allow }, () => act('proposeReader', { allow: allow ? 'yes' : 'no' }));
  const choices = agents.filter((id) => !readers.includes(id));
  return (
    <>
      {!box.revokedAt && (
        <Section title="Explicit read grants">
          <Note>Agents allowed to run on this machine may also read it.</Note>
          {!readers.length ? <Note>No explicit grants.</Note> : (
            <Rows>
              {readers.map((id) => (
                <Row key={id} title={isRef(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : id}
                  end={<Action kind="quiet" disabled={busy} onClick={() => void propose(id, false)}>Request revocation for {id}</Action>} />
              ))}
            </Rows>
          )}
          {!!choices.length && (
            <div className="board-choice" role="group" aria-label="Agent">
              <span className="board-seg">{choices.map((id) => <button key={id} type="button" aria-pressed={agent === id} disabled={busy} onClick={() => select(agent === id ? '' : id)}>{id}</button>)}</span>
              <Action disabled={busy || !agent || readers.includes(agent)} onClick={() => void propose(agent, true)}>Request read grant</Action>
            </div>
          )}
          <Problem>{error}</Problem>
          {cards === undefined && <Loading />}
          {cards === null && <Note>Pending read grants are unavailable.</Note>}
          {!!cards?.length && (
            <Rows>
              {cards.map((card) => (
                <Row key={card.id} title={card.ask} meta={card.review ? 'Updated to show the current readers.' : undefined}>
                  <Actions>
                    <Action disabled={busy} onClick={() => void change('machine.answerReader', { id: card.id, answer: 'allow', ...(card.review ? { review: card.review } : {}) }, () => act('answerReader', { answer: 'allow' }))}>Allow</Action>
                    <Action disabled={busy} onClick={() => void change('machine.answerReader', { id: card.id, answer: 'deny' }, () => act('answerReader', { answer: 'deny' }))}>Deny</Action>
                  </Actions>
                </Row>
              ))}
            </Rows>
          )}
        </Section>
      )}
      <Section title="Read history">
        {history === null && <Note>Machine read history is unavailable.</Note>}
        {history === undefined && <Loading />}
        {history?.length === 0 && <Note>No machine reads recorded.</Note>}
        {!!history?.length && (
          <Rows>
            {history.map((row) => (
              <Row key={row.id} title={row.read} end={<Time at={row.askedAt} />}
                meta={<>{row.agent} · {row.word}{row.person ? ' · ' + row.person : ''} · {row.outcome} · {row.bytes} bytes<br />Job <span className="font-mono">{row.job}</span> {isRef(row.conversation) && <Chip place={{ brick: 'session', params: { session: row.conversation } }}>Session</Chip>}<br />Arguments <code className="font-mono">{row.args}</code></>} />
            ))}
          </Rows>
        )}
        <Actions><Action kind="quiet" disabled={busy} onClick={() => refresh((n) => n + 1)}>Refresh</Action></Actions>
      </Section>
    </>
  );
}

/** The household's alert lines. Any member reads them; a household owner changes them, as Household setup does. */
function AlertLinesForm({ lines, owner, act }: { lines: AlertLines; owner: boolean; act: Act }) {
  const stored = JSON.stringify(lines);
  const [draft, setDraft] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [said, say] = useState('');
  useEffect(() => { setDraft({}); }, [stored]);
  if (!owner) return <><Facts>{alertControls.map(({ key, label }) => <Fact key={key} label={label}>{lines[key]}</Fact>)}</Facts><Note>A household owner changes these.</Note></>;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = alertPatch(lines, (key) => draft[key] ?? String(lines[key]));
    if ('error' in checked) { say(checked.error); return; }
    if (!Object.keys(checked.patch).length) { say(''); return; }
    setBusy(true); say('');
    try { await memberOperation('machine.setAlertLines', checked.patch); act('setAlertLines', {}); say('Saved'); }
    catch { say('Could not save. Check the values and connection.'); }
    finally { setBusy(false); }
  };
  return (
    <form className="board-form" aria-label="Machine alert thresholds" onSubmit={(event) => void save(event)}>
      <div className="board-machines-lines">
        {alertControls.map(({ key, label, min, max }) => (
          <label className="board-field" key={key}><span>{label}</span>
            <input className="board-input" type="number" min={min} max={max} step={1} required disabled={busy} value={draft[key] ?? String(lines[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
      </div>
      <Note>These thresholds apply to all machines on their next reading.</Note>
      <Actions><Action submit disabled={busy}>Save thresholds</Action>{said && <span role="status" className="board-note">{said}</span>}</Actions>
    </form>
  );
}

export function Machines({ form, act }: BodyProps) {
  const primary = form === 'primary';
  const inventory = useDataQuery<MachinesInventory>(machinesInventoryQuery, undefined, { keep: true });
  const mine = useDataQuery<OwnerMachinesData>(ownerMachinesQuery, undefined, { keep: true });
  const facts = useDataQuery<MachineFacts>(machineFactsQuery, undefined, { keep: true });
  const owner = useHouseholdOwner(!primary);
  const [open, setOpen] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(timer); }, []);
  if (inventory.status === 'loading') return <Loading />;
  const data = inventory.status === 'live' ? inventory.data : undefined, member = data?.account?.member;
  if (!data || !member || !Array.isArray(data.boxes)) return <Unavailable what="list of machines" />;
  const warnings = signInWarnings(data), now = Date.now();
  const readings = mine.status === 'live' ? mine.data?.boxReadings : undefined;
  const settings = new Map((mine.status === 'live' ? mine.data?.boxes ?? [] : []).map((box) => [box.id, box]));
  const fact = new Map((facts.status === 'live' ? facts.data?.boxes ?? [] : []).map((box) => [box.id, box]));
  const lines = facts.status === 'live' ? facts.data?.boxAlertSettings?.[0] : undefined;
  const boxes = [...data.boxes].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || Number(a.owner !== member) - Number(b.owner !== member) || a.name.localeCompare(b.name));
  const read = (box: string) => readingsOf(readings, box);
  const conditions = (box: string): { key: string; line: string }[] => read(box).flatMap((reading: Reading) => {
    const line = conditionLine(reading);
    return line ? [{ key: JSON.stringify([reading.kind, reading.thing]), line: line + readingAge(reading, now) }] : [];
  });
  const live = boxes.filter((box) => !box.revokedAt), alerts = live.reduce((n, box) => n + conditions(box.id).length, 0);
  const summary = `${count(live.length, 'machine')} · ${alerts ? count(alerts, 'open alert') : 'no open alerts'}`;
  if (form === 'compact') return <p className="board-brief">{summary}</p>;
  const agents = liveAgents(data.agents).map((a) => a.id);
  return (
    <>
      <Lead>{summary}</Lead>
      {!boxes.length && <Note>No machines are visible to this account.</Note>}
      <Few of={boxes} first={boxes.length} fit={!primary}>{(some, hidden) => <>
      <Rows>
        {some.map((box) => {
          const more = fact.get(box.id), list = read(box.id), disks = list.filter((r) => r.kind === 'disk').length, setting = settings.get(box.id);
          const shown = primary && open === box.id, open_ = !box.revokedAt ? conditions(box.id) : [];
          return (
            <Row key={box.id} flagged={open_.length > 0} title={primary ? <Opens open={shown} onToggle={() => setOpen(shown ? '' : box.id)}>{box.name}</Opens> : box.name}
              meta={<>
                {more?.sameMachineAsLoom && <>The loom machine · </>}
                {more?.lastSeenAt ? <>last seen <Time at={more.lastSeenAt} /></> : more ? 'never seen' : ''}
                {!primary && open_.length > 0 && <> · {count(open_.length, 'open alert')}</>}
              </>}
              end={<>
                {box.revokedAt && <State tone="muted">Revoked</State>}
                {!box.revokedAt && warnings.has(box.id) && <State tone="waiting">A sign-in needs attention</State>}
              </>}>
              {primary && open_.map(({ key, line }) => <p key={key} role="status" className="board-machines-alert">{line}</p>)}
              {primary && !box.revokedAt && !!list.length && <Note>{list.map((reading) => readingLine(reading, disks, now)).join(' · ')}</Note>}
              {primary && !box.revokedAt && !!setting && setting.readingsLeftOut > 0 && <p role="status" className="board-note">More than 24 things reported; {setting.readingsLeftOut} were left out.</p>}
              {shown && (
                <Opened>
                  <Facts>
                    <Fact label="Owner">{isMember(box.owner) ? <Chip place={{ brick: 'person', params: { person: 'member:' + box.owner } }}>{box.owner}</Chip> : box.owner}</Fact>
                    <Fact label="Hosting">{hostingWord(box)}</Fact>
                    <Fact label="Listed agents">{listedAgents(box).join(', ') || 'None listed'}</Fact>
                    <Fact label="Slots">{more?.slots ?? 'Not reported'}</Fact>
                  </Facts>
                  {!box.revokedAt && <Section title="Jobs on it now"><Jobs box={box.id} agents={agents} /></Section>}
                  {box.owner === member && setting && <Settings box={setting} agents={(mine.data?.agents ?? []).map((a) => a.id)} act={act} />}
                </Opened>
              )}
            </Row>
          );
        })}
      </Rows>
      <More n={hidden} />
      </>}</Few>
      {primary && lines && <Section title="Machine alerts"><AlertLinesForm lines={lines} owner={owner} act={act} /></Section>}
      {primary && <Note>Enrolling or revoking a machine is not done from a board.</Note>}
    </>
  );
}
