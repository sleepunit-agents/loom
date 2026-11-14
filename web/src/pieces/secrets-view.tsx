import type { ReactNode } from 'react';
import { Empty, Error, List, Loading, Row, Split } from '../kit';

export interface SecretRow { name: string; description: string; changedAt: string; changedBy: string }
export interface SecretGrantRow {
  id: string; secret: string; agent: string; job: string | null; request: string | null;
  grantedBy: string; grantedAt: string; expiresAt: string;
}
export interface SecretRequestRow {
  id: string; secret: string; agent: string; job: string | null; conversation: string | null;
  why: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled' | 'revoked';
  minutes: number; answeredBy: string | null; always: boolean; askedAt: string; answeredAt: string | null;
}
export interface SecretsSnapshot {
  status: 'loading' | 'live' | 'offline' | 'error';
  /** Authenticated query principal. Root must replace the whole snapshot on
   * authentication changes and enforce owner access at the query/command door. */
  member: string;
  secrets: readonly SecretRow[];
  grants: readonly SecretGrantRow[];
  requests: readonly SecretRequestRow[];
  rules: readonly { secret: string; answer: 'ask' | 'auto' | 'never'; minutes: number }[];
  ruleAgents: readonly { secret: string; agent: string; when: 'on_request' | 'at_start' }[];
  uses: readonly { id: string; secret: string; agent: string; job: string; at: string; state: 'started' | 'released' | 'failed' }[];
  changes: readonly { id: string; secret: string; action: 'add' | 'replace' | 'removed'; by: string; at: string }[];
  /** Omit when the household default has not been fetched. */
  defaultAnswer?: 'ask' | 'auto' | 'never';
}
export type SecretsFolder = 'secrets' | 'requests' | 'grants' | 'pieces' | 'add';
export interface SecretsSelection { folder: SecretsFolder; id: string }
const labels = { secrets: 'Secrets', requests: 'Requests', grants: 'Grants', pieces: 'Piece settings' };
const useLabels = { started: 'Delivery unconfirmed', released: 'Delivered', failed: 'Failed' };
const grantDetails = (grant: SecretGrantRow) => <>
  <p>{grant.agent} · {grant.job ? `Job: ${grant.job}` : 'Agent-wide'}</p>
  <p>Granted: {grant.grantedAt} · Expires: {grant.expiresAt} · By: {grant.grantedBy}</p>
  {grant.request && <p>Request: {grant.request}</p>}
</>;

/** Metadata presentation only: no value input, mutation, authorization decision,
 * subscription or legacy command. Root owns write-only forms and approval cards.
 * Non-live/principal-mismatched snapshots never mount retained rows or controls. */
export function SecretsView({ snapshot, member, folder, selected, select, changeFolder, cards, pieces = [] }: {
  snapshot: SecretsSnapshot; member: string; folder: SecretsFolder; selected?: SecretsSelection;
  select: (selection: SecretsSelection | undefined) => void;
  changeFolder: (folder: SecretsFolder) => void;
  cards?: { add?: () => ReactNode; secret?: (name: string) => ReactNode; request?: (id: string) => ReactNode; grant?: (id: string) => ReactNode };
  pieces?: readonly { id: string; label: string; description: string; open: () => void }[];
}) {
  if (snapshot.member !== member || snapshot.status === 'loading') return <Loading label="Opening Settings…" />;
  if (snapshot.status !== 'live') return <Error text="Settings is unavailable. Reconnect to continue." />;
  const active = selected?.folder === folder ? selected.id : undefined;
  const secret = folder === 'secrets' ? snapshot.secrets.find(row => row.name === active) : undefined;
  const request = folder === 'requests' ? snapshot.requests.find(row => row.id === active) : undefined;
  const grant = folder === 'grants' ? snapshot.grants.find(row => row.id === active) : undefined;
  const open = (id: string) => select({ folder, id });
  const row = (id: string, title: string, meta: ReactNode, status?: string) =>
    <Row key={id} title={title} meta={meta} status={status} selected={id === active} onClick={() => open(id)} />;
  let reader: ReactNode = null;
  if (secret) {
    const rule = snapshot.rules.find(row => row.secret === secret.name);
    reader = <article className="grid gap-4 p-5"><h1>{secret.name}</h1><p>{secret.description}</p>
      <p>Changed: {secret.changedAt} · By: {secret.changedBy}</p>
      <section><h2>Who may use it</h2>{snapshot.grants.filter(row => row.secret === secret.name).map(value => <div key={value.id}>{grantDetails(value)}</div>)}</section>
      <section><h2>Rules</h2>{rule ? <p>Standing answer: {rule.answer} · Automatic grant: {rule.minutes} minutes</p>
        : <p>{snapshot.defaultAnswer ? `Household default: ${snapshot.defaultAnswer}` : 'No secret rule. Household default not loaded.'}</p>}
        {snapshot.ruleAgents.filter(row => row.secret === secret.name).map(value => <p key={JSON.stringify([value.agent, value.when])}>{value.agent} · {value.when === 'at_start' ? 'At startup' : 'When asked'}</p>)}
      </section>
      <section><h2>Recorded use</h2>{snapshot.uses.filter(row => row.secret === secret.name).map(value => <p key={value.id}>{value.at} · {value.agent} · Job: {value.job} · {useLabels[value.state]}</p>)}</section>
      <section><h2>Changes</h2>{snapshot.changes.filter(row => row.secret === secret.name).map(value => <p key={value.id}>{value.at} · {value.action} · {value.by}</p>)}</section>
      <p>The value is write-only. It cannot be read back here.</p>{cards?.secret?.(secret.name)}
    </article>;
  } else if (request) reader = <article className="grid gap-4 p-5"><h1>{request.agent} asks for {request.secret}</h1><p>{request.why}</p>
    <p>{request.state} · {request.minutes} minutes · Asked: {request.askedAt}</p>
    {request.job && <p>Job: {request.job}</p>}{request.conversation && <p>Conversation: {request.conversation}</p>}
    {request.answeredBy && <p>Answered by: {request.answeredBy} · {request.answeredAt}</p>}{request.always && <p>Answered always; a standing rule was made.</p>}
    {request.state === 'pending' && cards?.request?.(request.id)}
  </article>;
  else if (grant) reader = <article className="grid gap-4 p-5"><h1>{grant.secret}</h1>{grantDetails(grant)}{cards?.grant?.(grant.id)}</article>;
  else if (folder === 'add') reader = <article className="grid gap-4 p-5"><h1>Add a secret</h1><p>The value is write-only. It cannot be read back here.</p>{cards?.add?.()}</article>;
  const rows = folder === 'requests' ? snapshot.requests.map(value => row(value.id, `${value.agent}: ${value.secret}`, value.why, value.state))
    : folder === 'grants' ? snapshot.grants.map(value => row(value.id, `${value.agent}: ${value.secret}`, value.job ? `Job: ${value.job}` : 'Agent-wide', `Expires: ${value.expiresAt}`))
    : folder === 'pieces' ? pieces.map(value => <Row key={value.id} title={value.label} meta={value.description} onClick={value.open} />)
    : snapshot.secrets.map(value => row(value.name, value.name, value.description));
  const view = folder === 'add' ? 'secrets' : folder;
  return <Split label="Settings" folders={[
    { id: 'secrets', label: labels.secrets, count: snapshot.secrets.length },
    { id: 'requests', label: labels.requests, count: snapshot.requests.filter(value => value.state === 'pending').length },
    { id: 'grants', label: labels.grants, count: snapshot.grants.length }, { id: 'pieces', label: labels.pieces },
  ]} folder={view} onFolder={id => { select(undefined); changeFolder(id as SecretsFolder); }} listTitle={labels[view]}
    listTop={view === 'secrets' && cards?.add ? <Row title="Add a secret" onClick={() => { select(undefined); changeFolder('add'); }} /> : undefined}
    list={rows.length ? <List label={labels[view]}>{rows}</List> : <Empty title={`No ${labels[view].toLowerCase()}`} />}
    reader={reader} open={reader !== null} onBack={() => { select(undefined); if (folder === 'add') changeFolder('secrets'); }} backLabel="Back to Settings"
    blank={<Empty title={active ? 'This item is no longer available' : 'Choose an item'} />} />;
}
