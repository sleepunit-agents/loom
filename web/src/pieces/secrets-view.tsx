import type { ReactNode } from 'react';
import {fullTime} from '../kit/time';
import { Button, Fact, Facts, Meta, Reader, Section, Title, Empty, Error, List, Loading, Row, Split } from '../kit';

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
  status: 'loading' | 'live' | 'offline' | 'denied' | 'error';
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
const time = (at:string,zone?:string) => <time dateTime={at}>{fullTime(at,zone)}</time>;
const grantDetails = (grant: SecretGrantRow,zone?:string) => <Facts>
  <Fact label="Agent">{grant.agent}</Fact><Fact label="Scope">{grant.job || 'Agent-wide'}</Fact>
  <Fact label="Granted">{time(grant.grantedAt,zone)}</Fact><Fact label="Expires">{time(grant.expiresAt,zone)}</Fact>
  <Fact label="Granted by">{grant.grantedBy}</Fact><Fact label="Request">{grant.request}</Fact>
</Facts>;

/** Metadata presentation only: no value input, mutation, authorization decision,
 * subscription or legacy command. Root owns write-only forms and approval cards.
 * Non-live/principal-mismatched snapshots never mount retained rows or controls. */
export function SecretsView({ snapshot, member, zone, folder, selected, select, changeFolder, cards, pieces = [] }: {
  snapshot: SecretsSnapshot; member: string; zone?:string; folder: SecretsFolder; selected?: SecretsSelection;
  select: (selection: SecretsSelection | undefined) => void;
  changeFolder: (folder: SecretsFolder) => void;
  cards?: { add?: () => ReactNode; secret?: (name: string) => ReactNode; request?: (id: string) => ReactNode; grant?: (id: string) => ReactNode; piece?: (id: string) => ReactNode };
  pieces?: readonly { id: string; label: string; description: string; open: () => void }[];
}) {
  if (snapshot.member !== member || snapshot.status === 'loading') return <Loading label="Opening Settings…" />;
  if (snapshot.status === 'denied') return <Empty title="Household owners manage Settings" text="Ask a household owner about secrets and their access rules." />;
  if (snapshot.status !== 'live') return <Error text="Settings is unavailable. Reconnect to continue." />;
  const active = selected?.folder === folder ? selected.id : undefined;
  const secret = folder === 'secrets' ? snapshot.secrets.find(row => row.name === active) : undefined;
  const request = folder === 'requests' ? snapshot.requests.find(row => row.id === active) : undefined;
  const grant = folder === 'grants' ? snapshot.grants.find(row => row.id === active) : undefined;
  const view = folder === 'add' ? 'secrets' : folder;
  const open = (id: string) => select({ folder: view, id });
  const row = (id: string, title: string, meta: ReactNode, status?: string) =>
    <Row key={id} title={title} meta={meta} status={status} selected={id === active} onClick={() => open(id)} />;
  let reader: ReactNode = null;
  if (secret) {
    const rule = snapshot.rules.find(row => row.secret === secret.name);
    const grants=snapshot.grants.filter(row=>row.secret===secret.name);
    const uses=snapshot.uses.filter(row=>row.secret===secret.name);
    const changes=snapshot.changes.filter(row=>row.secret===secret.name);
    reader = <Reader className="p-5"><Title as="h1">{secret.name}</Title><p>{secret.description}</p>
      <Meta>Changed {time(secret.changedAt,zone)} by {secret.changedBy}</Meta>
      {grants.length>0 && <Section label="Who may use it">{grants.map(value => <div key={value.id}>{grantDetails(value,zone)}</div>)}</Section>}
      <Section label="Rules">{rule ? <p>Standing answer: {rule.answer} · Automatic grant: {rule.minutes} minutes</p>
        : <p>{snapshot.defaultAnswer ? `Household default: ${snapshot.defaultAnswer}` : 'No secret rule. Household default not loaded.'}</p>}
        {snapshot.ruleAgents.filter(row => row.secret === secret.name).map(value => <p key={JSON.stringify([value.agent, value.when])}>{value.agent} · {value.when === 'at_start' ? 'At startup' : 'When asked'}</p>)}
      </Section>
      {uses.length>0 && <Section label="Recorded use">{uses.map(value => <p key={value.id}>{time(value.at,zone)} · {value.agent} · Job: {value.job} · {useLabels[value.state]}</p>)}</Section>}
      {changes.length>0 && <Section label="Changes">{changes.map(value => <p key={value.id}>{time(value.at,zone)} · {value.action} · {value.by}</p>)}</Section>}
      <p>The value is write-only. It cannot be read back here.</p>{cards?.secret?.(secret.name)}
    </Reader>;
  } else if (request) reader = <Reader className="p-5"><Title as="h1">{request.agent} asks for {request.secret}</Title><p>{request.why}</p>
    <Meta>{request.state} · {request.minutes} minutes</Meta>
    <Facts><Fact label="Asked">{time(request.askedAt,zone)}</Fact>
      <Fact label="Job">{request.job}</Fact><Fact label="Conversation">{request.conversation}</Fact>
      <Fact label="Answered by">{request.answeredBy}</Fact><Fact label="Answered">{request.answeredAt && time(request.answeredAt,zone)}</Fact>
    </Facts>
    {request.always && <p>A standing rule was made with this answer.</p>}
    {request.state === 'pending' && cards?.request?.(request.id)}
  </Reader>;
  else if (grant) reader = <Reader className="p-5"><Title as="h1">{grant.secret}</Title>{grantDetails(grant,zone)}{cards?.grant?.(grant.id)}</Reader>;
  else if (folder === 'pieces' && active && pieces.some(piece => piece.id === active)) reader = <Reader className="p-5"><Title as="h1">{pieces.find(piece => piece.id === active)!.label}</Title>{cards?.piece?.(active)}</Reader>;
  else if (folder === 'add') reader = <Reader className="p-5"><Title as="h1">Add a secret</Title><p>The value is write-only. It cannot be read back here.</p>{cards?.add?.()}</Reader>;
  const rows = folder === 'requests' ? snapshot.requests.map(value => row(value.id, `${value.agent}: ${value.secret}`, value.why, value.state))
    : folder === 'grants' ? snapshot.grants.map(value => row(value.id, `${value.agent}: ${value.secret}`, value.job ? `Job: ${value.job}` : 'Agent-wide', `Expires ${fullTime(value.expiresAt,zone)}`))
    : folder === 'pieces' ? pieces.map(value => <Row key={value.id} title={value.label} meta={value.description} onClick={value.open} />)
    : snapshot.secrets.map(value => row(value.name, value.name, value.description));
  return <Split label="Settings" folders={[
    { id: 'secrets', label: labels.secrets, count: snapshot.secrets.length },
    { id: 'requests', label: labels.requests, count: snapshot.requests.filter(value => value.state === 'pending').length },
    { id: 'grants', label: labels.grants, count: snapshot.grants.length }, { id: 'pieces', label: labels.pieces },
  ]} folder={view} onFolder={id => { select(undefined); changeFolder(id as SecretsFolder); }} listTitle={labels[view]}
    listAction={view === 'secrets' && cards?.add ? <Button onClick={() => { select(undefined); changeFolder('add'); }}>Add a secret</Button> : undefined}
    list={rows.length ? <List label={labels[view]}>{rows}</List> : <Empty title={`No ${labels[view].toLowerCase()}`} />}
    reader={reader} open={reader !== null} onBack={() => { select(undefined); if (folder === 'add') changeFolder('secrets'); }} backLabel="Back to Settings"
    blank={<Empty title={active ? 'This item is no longer available' : 'Choose an item'} />} />;
}
