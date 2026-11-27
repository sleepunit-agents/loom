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
import { briefTime, fullTime } from '../kit/time';
import { alertControls, alertLinesSelection, alertPatch, type AlertLines } from '../pieces/household/alert-lines-model';
import { hostingWord, listedAgents } from '../pieces/runtime/machine-hosting-model';
import { conditionLine, readingAge, readingLine, readingsOf, type Reading } from '../pieces/runtime/machine-readings';
import { machinesInventoryQuery, ownerMachinesQuery, signInWarnings, type Machine, type MachineReadEntry, type MachinesInventory, type OwnerMachinesData, type ReaderCard } from '../pieces/runtime/machines-query';
import { isMember, isRef, useHouseholdOwner } from './admin-data';
import { Chip, Loading, Unavailable, type Act, type BodyProps } from './brick-kit';

export const machineFactsQuery = `query BrickMachineFacts { boxes { id sameMachineAsLoom lastSeenAt slots } ${alertLinesSelection} }`;
type Facts = { boxes: { id: string; sameMachineAsLoom: boolean; lastSeenAt: string | null; slots: number | null }[]; boxAlertSettings: AlertLines[] };
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
  if (!ids.length) return <p className="text-muted-foreground">None right now.</p>;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <p className="text-muted-foreground">Can’t read jobs right now.</p>;
  const jobs = Object.values(read.data).flatMap((rows) => (Array.isArray(rows) ? rows : [])).filter((job) => job.box === box && current.includes(job.state))
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || b.id.localeCompare(a.id));
  if (!jobs.length) return <p className="text-muted-foreground">None right now.</p>;
  return (
    <>
      {jobs.map((job) => {
        const title = 'title' in job ? job.title || 'Untitled job' : 'Private conversation';
        return (
          <div className="board-line" key={job.id}>
            {isRef(job.conversation) ? <Chip place={{ brick: 'session', params: { session: job.conversation } }}>{title}</Chip> : <span>{title}</span>}
            <span className="board-state" data-running={job.state !== 'queued'}>{job.state}</span>
            {isRef(job.agent) ? <Chip place={{ brick: 'agent', params: { agent: job.agent } }}>{job.agent}</Chip> : <span>{job.agent}</span>}
            <span className="text-muted-foreground">queued {briefTime(job.queuedAt)}</span>
          </div>
        );
      })}
    </>
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
        <div>
          <dt>Explicit read grants</dt>
          <dd>
            <p className="text-muted-foreground">Agents allowed to run on this machine may also read it.</p>
            {readers.map((id) => (
              <div className="board-line" key={id}>
                {isRef(id) ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span>{id}</span>}
                <button type="button" className="board-action" disabled={busy} onClick={() => void propose(id, false)}>Request revocation for {id}</button>
              </div>
            ))}
            {!readers.length && <p>No explicit grants.</p>}
            {!!choices.length && (
              <div className="board-line" role="group" aria-label="Agent">
                {choices.map((id) => <button key={id} type="button" className="board-action" aria-pressed={agent === id} disabled={busy} onClick={() => select(agent === id ? '' : id)}>{id}</button>)}
                <button type="button" className="board-action" disabled={busy || !agent || readers.includes(agent)} onClick={() => void propose(agent, true)}>Request read grant</button>
              </div>
            )}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            {cards === undefined && <Loading />}
            {cards === null && <p className="text-muted-foreground">Pending read grants are unavailable.</p>}
            {cards?.map((card) => (
              <div key={card.id}>
                <p>{card.ask}</p>
                {card.review && <p className="text-muted-foreground">Updated to show the current readers.</p>}
                <div className="board-line">
                  <button type="button" className="board-action" disabled={busy} onClick={() => void change('machine.answerReader', { id: card.id, answer: 'allow', ...(card.review ? { review: card.review } : {}) }, () => act('answerReader', { answer: 'allow' }))}>Allow</button>
                  <button type="button" className="board-action" disabled={busy} onClick={() => void change('machine.answerReader', { id: card.id, answer: 'deny' }, () => act('answerReader', { answer: 'deny' }))}>Deny</button>
                </div>
              </div>
            ))}
          </dd>
        </div>
      )}
      <div>
        <dt>Read history</dt>
        <dd>
          <div className="board-line"><button type="button" className="board-action" disabled={busy} onClick={() => refresh((n) => n + 1)}>Refresh</button></div>
          {history === null && <p className="text-muted-foreground">Machine read history is unavailable.</p>}
          {history === undefined && <Loading />}
          {history?.length === 0 && <p>No machine reads recorded.</p>}
          {history?.map((row) => (
            <div key={row.id} style={{ marginTop: '.4rem' }}>
              <p><strong>{row.read}</strong> · {fullTime(row.askedAt)}</p>
              <p className="text-muted-foreground">{row.agent} · {row.word}{row.person ? ' · ' + row.person : ''} · {row.outcome} · {row.bytes} bytes</p>
              <p className="text-muted-foreground">Job <span className="font-mono">{row.job}</span> {isRef(row.conversation) && <Chip place={{ brick: 'session', params: { session: row.conversation } }}>Session</Chip>}</p>
              <p className="text-muted-foreground">Arguments <code>{row.args}</code></p>
            </div>
          ))}
        </dd>
      </div>
    </>
  );
}

/** The household's alert lines. Any member reads them; a household owner changes them, as Household setup does. */
function AlertLinesForm({ lines, owner, act }: { lines: AlertLines; owner: boolean; act: Act }) {
  const stored = JSON.stringify(lines);
  const [draft, setDraft] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [said, say] = useState('');
  useEffect(() => { setDraft({}); }, [stored]);
  if (!owner) return <>{alertControls.map(({ key, label }) => <p key={key}>{label}: {lines[key]}</p>)}<p className="text-muted-foreground">A household owner changes these.</p></>;
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
    <form aria-label="Machine alert thresholds" onSubmit={(event) => void save(event)}>
      <p className="text-muted-foreground">These thresholds apply to all machines on their next reading.</p>
      {alertControls.map(({ key, label, min, max }) => (
        <label className="board-line" key={key}>{label}
          <input className="board-input" type="number" min={min} max={max} step={1} required disabled={busy} value={draft[key] ?? String(lines[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        </label>
      ))}
      <div className="board-line"><button type="submit" className="board-action" disabled={busy}>Save thresholds</button></div>
      {said && <p role="status">{said}</p>}
    </form>
  );
}

export function Machines({ form, act }: BodyProps) {
  const primary = form === 'primary';
  const inventory = useDataQuery<MachinesInventory>(machinesInventoryQuery, undefined, { keep: true });
  const mine = useDataQuery<OwnerMachinesData>(ownerMachinesQuery, undefined, { keep: true });
  const facts = useDataQuery<Facts>(machineFactsQuery, undefined, { keep: true });
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
  const count = `${live.length} machine${live.length === 1 ? '' : 's'} · ${alerts ? `${alerts} open alert${alerts === 1 ? '' : 's'}` : 'no open alerts'}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const agents = liveAgents(data.agents).map((a) => a.id);
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      {!boxes.length && <p className="text-muted-foreground">No machines are visible to this account.</p>}
      {boxes.map((box) => {
        const more = fact.get(box.id), list = read(box.id), disks = list.filter((r) => r.kind === 'disk').length, setting = settings.get(box.id);
        const shown = primary && open === box.id;
        return (
          <section key={box.id} aria-label={box.name} style={{ marginTop: '.7rem' }}>
            <div className="board-line">
              {primary ? <button type="button" className="board-action" aria-expanded={shown} onClick={() => setOpen(shown ? '' : box.id)}>{box.name}</button> : <strong>{box.name}</strong>}
              {box.revokedAt && <span className="board-state">Revoked</span>}
              {more?.sameMachineAsLoom && <span className="board-state">The loom machine</span>}
              <span className="text-muted-foreground">{more?.lastSeenAt ? 'last seen ' + briefTime(more.lastSeenAt, undefined, now) : more ? 'never seen' : ''}</span>
              {!box.revokedAt && warnings.has(box.id) && <span className="board-state">A sign-in needs attention</span>}
            </div>
            {!box.revokedAt && conditions(box.id).map(({ key, line }) => <p key={key} role="status"><strong>{line}</strong></p>)}
            {!box.revokedAt && !!list.length && <p className="text-muted-foreground">{list.map((reading) => readingLine(reading, disks, now)).join(' · ')}</p>}
            {!box.revokedAt && !!setting && setting.readingsLeftOut > 0 && <p role="status">More than 24 things reported; {setting.readingsLeftOut} were left out.</p>}
            {shown && (
              <dl style={{ marginTop: '.5rem' }}>
                <div><dt>Owner</dt><dd>{isMember(box.owner) ? <Chip place={{ brick: 'person', params: { person: 'member:' + box.owner } }}>{box.owner}</Chip> : box.owner}</dd></div>
                <div><dt>Hosting</dt><dd>{hostingWord(box)}</dd></div>
                <div><dt>Listed agents</dt><dd>{listedAgents(box).join(', ') || 'None listed'}</dd></div>
                <div><dt>Slots</dt><dd>{more?.slots ?? 'Not reported'}</dd></div>
                {!box.revokedAt && <div><dt>Jobs on it now</dt><dd><Jobs box={box.id} agents={agents} /></dd></div>}
                {box.owner === member && setting && <Settings box={setting} agents={(mine.data?.agents ?? []).map((a) => a.id)} act={act} />}
              </dl>
            )}
            {!primary && <p className="text-muted-foreground">{hostingWord(box)}{more?.slots != null ? ` · ${more.slots} slot${more.slots === 1 ? '' : 's'}` : ''}</p>}
          </section>
        );
      })}
      {primary && lines && (
        <dl style={{ marginTop: '.9rem' }}><div><dt>Machine alerts</dt><dd><AlertLinesForm lines={lines} owner={owner} act={act} /></dd></div></dl>
      )}
      {primary && <p className="text-muted-foreground" style={{ marginTop: '.6rem' }}>Enrolling or revoking a machine is not done from a board.</p>}
    </>
  );
}
