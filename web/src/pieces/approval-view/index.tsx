import { useRef, useState, type ReactNode } from 'react';
import { Split, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
import { folders, matches, rows, type Approval, type ApprovalSnapshot } from './model';
export type { ApprovalSnapshot } from './model';

export type RenderApprovalChange = (approval: Approval) => ReactNode;
interface ChangePresentation { renderChange?: RenderApprovalChange }

/** The composition binds these commands to the authenticated operation door.
 * A visible button is not authority: the operation rechecks the exact request.
 * Always is offered only when that door supplies its concrete scope and action.
 */
export interface ApprovalActions {
  supports?(approval: Approval): boolean;
  allow(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  always?: { label: string; approval: string; run(id: string): Promise<void> };
}
function Unavailable({ status }: { status: ApprovalSnapshot['status'] }) {
  return status === 'loading' ? <Loading label="Opening Approvals…" />
    : <Error text={status === 'denied' ? 'Sign in with access to see Approvals.' : 'Waiting for connection.'} />;
}
function Answer({ approval, actions }: { approval: Approval; actions?: ApprovalActions }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false);
  async function send(action: () => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try { await action(); } catch { setError('Could not save your answer. Reconnect and try again.'); }
    finally { active.current = false; setBusy(false); }
  }
  return <>
    {approval.state === 'pending' && actions && (!actions.supports || actions.supports(approval)) && <div role="group" aria-label="Answer approval" className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void send(() => actions.allow(approval.id))}>Allow</Button>
      {actions.always?.approval === approval.id && <Button variant="outline" disabled={busy} onClick={() => void send(() => actions.always!.run(approval.id))}>{actions.always.label}</Button>}
      <Button variant="outline" disabled={busy} onClick={() => void send(() => actions.deny(approval.id))}>Deny</Button>
    </div>}
    {busy && <p role="status">Saving answer…</p>}
    {error && <Error text={error} />}
  </>;
}
function Details({ approval: a, snapshot, actions, renderChange, inline = false }: { approval: Approval; snapshot: ApprovalSnapshot; actions?: ApprovalActions; inline?: boolean } & ChangePresentation) {
  const time = (at: string) => new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return <article className="grid min-w-0 gap-4 p-5 [overflow-wrap:anywhere]">
    <header><p>{a.kind} · {a.state}</p><h2 className="text-xl font-semibold">{a.ask}</h2><p>{a.agent}{a.project && ` · ${a.project}`}{a.member && ` · private to ${a.member}`}</p></header>
    <section><h3>Why</h3><p>{a.why}</p></section>
    <section><h3>If you allow</h3><p>{a.ifYes}</p></section>
    <section><h3>If you deny</h3><p>{a.ifNo}</p></section>
    {a.changeSummary && <section><h3>Exactly what will change</h3><p className="whitespace-pre-wrap">{a.changeSummary}</p></section>}
    {renderChange?.(a)}
    <section><h3>Exactly what this allows</h3><p>{a.kind}: {a.target}</p></section>
    <Answer key={a.id} approval={a} actions={actions} />
    {a.decidedBy && <p>Answered by {a.decidedBy}</p>}
    {a.expiresAt && <p>Allowance ends {time(a.expiresAt)} · {snapshot.timezone}</p>}
    {!inline && <>
      {a.details && <section><h3>Details</h3><p className="whitespace-pre-wrap">{a.details}</p></section>}
      <section><h3>Permanent record</h3><ol>{snapshot.record.filter(r => r.approval === a.id).sort((x, y) => x.seq - y.seq).map(r => <li key={r.seq}>{time(r.at)} · {r.event}{r.note && ` · ${r.note}`}</li>)}</ol></section>
    </>}
  </article>;
}

/** Same current request and answer controls as the tile, with before and after. */
export function ApprovalCard({ id, snapshot, actions, renderChange }: { id: string; snapshot: ApprovalSnapshot; actions?: ApprovalActions } & ChangePresentation) {
  if (snapshot.status !== 'live') return <Unavailable status={snapshot.status} />;
  const approval = snapshot.approvals.find(a => a.id === id);
  return approval ? <Details key={id} approval={approval} snapshot={snapshot} actions={actions} renderChange={renderChange} inline /> : <Empty title="Approval unavailable" />;
}

/** No transport or cached private records: the generated query client supplies
 * the current visible snapshot, and drops it on disconnect or access loss. */
export default function Approvals({ snapshot, actions, renderChange }: { snapshot: ApprovalSnapshot; actions?: ApprovalActions } & ChangePresentation) {
  const [folder, setFolder] = useState('pending'), [query, setQuery] = useState(''), [selected, setSelected] = useState<string>();
  const live = snapshot.status === 'live';
  const shown = rows(snapshot, folder, query);
  const approval = live ? snapshot.approvals.find(a => a.id === selected) : undefined;
  const rules = live ? snapshot.rules.filter(r => matches([r.kind, r.scope, r.person, r.tier], query)) : [];
  const notices = live ? snapshot.notices.filter(n => matches([n.what, n.agent, n.target, n.kind], query)).sort((a,b) => b.at.localeCompare(a.at)) : [];
  const rulesView = folder === 'rules', noticesView = folder === 'notices';
  return <Split label="Approvals" className="h-full" folders={folders.map(f => ({ ...f, count: live ? f.id === 'rules' ? snapshot.rules.length : f.id === 'notices' ? snapshot.notices.length : rows(snapshot, f.id, '').length : undefined }))}
    folder={folder} onFolder={id => { setFolder(id); setSelected(undefined); }}
    search={<label>Search approvals<Input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    listTitle={folders.find(f => f.id === folder)?.label}
    listMeta={live ? rulesView ? rules.length : noticesView ? notices.length : shown.length : undefined}
    list={!live ? <Unavailable status={snapshot.status} />
      : rulesView ? <>{rules.length ? <List label="Standing rules">{rules.map(r => <Row key={`${r.kind}:${r.scope}:${r.person}`} title={r.scope} meta={`${r.kind}${r.person ? ` · for ${r.person}` : ''}`} status={r.tier === 'do' ? 'Just do it' : r.tier === 'tell' ? 'Tell me after' : 'Ask me'} />)}</List> : <Empty title="No matching rules" />}<p className="p-3">Ask an agent in chat to change a standing rule. Only a household owner can change rules.</p></>
      : noticesView ? notices.length ? <List label="Reported steps">{notices.map(n => <Row key={n.id} title={n.what} meta={`${n.agent} · ${n.kind} · ${n.target}`} status={new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(n.at))} />)}</List> : <Empty title="No reported steps" />
      : shown.length ? <List label="Approvals">{shown.map(a => <Row key={a.id} title={a.what} meta={a.why} status={`${a.agent} · ${a.state}`} selected={a.id === selected} onClick={() => setSelected(a.id)} />)}</List> : <Empty title={query ? 'No matching approvals' : 'No approvals here'} />}
    reader={approval ? <Details key={approval.id} approval={approval} snapshot={snapshot} actions={actions} renderChange={renderChange} /> : null}
    open={!!approval} onBack={() => setSelected(undefined)} backLabel="Approvals"
    blank={<Empty title="Open an approval" text="Choose a request to read exactly what it allows." />} />;
}
