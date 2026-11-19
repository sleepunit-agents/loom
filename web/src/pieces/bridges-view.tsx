import type { ReactNode } from 'react';
import { Empty, Error, List, Loading, Row, Split } from '../kit';

export interface BridgeConnectionRow {
  id: string; platform: 'discord' | 'slack'; agent: string; workspace: string;
  botUser: string; tokenSecret: string; appSecret: string | null; enabled: boolean;
  state: 'connecting' | 'connected' | 'backoff' | 'disconnected'; stateAt: string;
}
export interface BridgeChannelRow {
  platform: string; workspace: string; channel: string; answers: string; botsMayTalk: boolean;
}
export interface BridgePersonRow { platform: string; workspace: string; user: string; member: string }
export interface BridgeSendRow {
  id: string; incoming: string; connection: string; channel: string; thread: string | null;
  text: string; state: 'pending' | 'held' | 'sending' | 'sent' | 'uncertain' | 'dismissed';
  createdAt: string;
}
export type BridgeFolder = 'connections' | 'channels' | 'people' | 'sends';
export interface BridgeSelection { folder: BridgeFolder; id: string }
export interface BridgesSnapshot {
  status: 'loading' | 'live' | 'offline' | 'error';
  /** Scope is the authenticated query principal. All rows must belong to it.
   * The root must replace rows together when authentication changes. */
  member: string;
  connections: readonly BridgeConnectionRow[];
  filters: readonly { connection: string; channel: string; rule: 'only' | 'ignore' }[];
  channels: readonly BridgeChannelRow[];
  people: readonly BridgePersonRow[];
  sends: readonly BridgeSendRow[];
  activity: readonly { connection: string; received: number; delivered: number; held: number }[];
}
export const bridgePlaceKey = (row: { platform: string; workspace: string; channel: string }) =>
  JSON.stringify([row.platform, row.workspace, row.channel]);
export const bridgePersonKey = (row: BridgePersonRow) => JSON.stringify([row.platform, row.workspace, row.user]);
const labels: Record<BridgeFolder, string> = {
  connections: 'Connections', channels: 'Channel rules', people: 'Person links', sends: 'Pending sends',
};
const awaitingReview = (send: BridgeSendRow) => ['pending', 'held', 'sending', 'uncertain'].includes(send.state);

/** Presentation only. Authenticated generated queries supply rows; the root
 * supplies owner controls and send review. No token, API call, or
 * mutation lives here. A non-live snapshot never displays retained rows. */
export function BridgesView({ snapshot, member, folder, selected, select, changeFolder, cards }: {
  snapshot: BridgesSnapshot;
  member: string;
  folder: BridgeFolder;
  selected?: BridgeSelection;
  select: (selection: BridgeSelection | undefined) => void;
  changeFolder: (folder: BridgeFolder) => void;
  cards?: { create?: ReactNode; channel?: (row: BridgeChannelRow) => ReactNode; person?: (row: BridgePersonRow) => ReactNode; connection?: (id: string) => ReactNode; send?: (id: string) => ReactNode };
}) {
  if (snapshot.member !== member || snapshot.status === 'loading') return <Loading label="Opening Bridges…" />;
  if (snapshot.status !== 'live') return <Error text="Bridges is unavailable. Reconnect to continue." />;
  const sends = snapshot.sends.filter(awaitingReview);
  const active = selected?.folder === folder ? selected.id : undefined;
  const connection = folder === 'connections' ? snapshot.connections.find(row => row.id === active) : undefined;
  const channel = folder === 'channels' ? snapshot.channels.find(row => bridgePlaceKey(row) === active) : undefined;
  const person = folder === 'people' ? snapshot.people.find(row => bridgePersonKey(row) === active) : undefined;
  const send = folder === 'sends' ? sends.find(row => row.id === active) : undefined;
  const counts = { connections: snapshot.connections.length, channels: snapshot.channels.length, people: snapshot.people.length, sends: sends.length };
  const open = (id: string) => select({ folder, id });
  const row = (id: string, title: string, meta: ReactNode, status?: string) =>
    <Row key={id} title={title} meta={meta} status={status} selected={id === active} onClick={() => open(id)} />;
  let reader: ReactNode = null;
  if (connection) {
    const activity = snapshot.activity.find(value => value.connection === connection.id);
    reader = <article className="grid gap-4 p-5">
      <h1>{connection.agent} · {connection.platform}</h1>
      <p>Workspace: {connection.workspace}</p><p>{connection.state} · {connection.enabled ? 'Enabled' : 'Disabled'}</p>
      <p>State changed: {connection.stateAt}</p><p>Bot user: {connection.botUser}</p>
      {activity && <section><h2>Last 24 hours</h2><p>{activity.received} received · {activity.delivered} delivered · {activity.held} held</p></section>}
      <section><h2>Channel filters</h2>{(['only', 'ignore'] as const).map(rule => {
        const channels = snapshot.filters.filter(filter => filter.connection === connection.id && filter.rule === rule);
        return <p key={rule}>{rule === 'only' ? 'Only channels' : 'Ignored channels'}: {channels.map(filter => filter.channel).join(', ') || 'None'}</p>;
      })}</section>
      <section><h2>Stored secret names</h2><p>Bot token: {connection.tokenSecret}</p>{connection.appSecret && <p>App token: {connection.appSecret}</p>}</section>
      {cards?.connection?.(connection.id)}
    </article>;
  } else if (channel) reader = <article className="grid gap-4 p-5"><h1>{channel.channel}</h1><p>{channel.platform} · {channel.workspace}</p><p>Answers when nobody is addressed: {channel.answers}</p><p>Bots may talk: {channel.botsMayTalk ? 'Yes' : 'No'}</p>{cards?.channel?.(channel)}</article>;
  else if (person) reader = <article className="grid gap-4 p-5"><h1>{person.member}</h1><p>{person.platform} · {person.workspace}</p><p>Outside user: {person.user}</p>{cards?.person?.(person)}</article>;
  else if (send) reader = <article className="grid gap-4 p-5"><h1>Reply to {send.channel}</h1><p>{send.state}</p><p>{send.text}</p>
    {send.thread && <p>Thread: {send.thread}</p>}
    {send.state === 'uncertain' && <p>Delivery could not be confirmed. Review before sending again.</p>}
    {send.state === 'held' && <p>This send waits for a person to release or dismiss it.</p>}
    {cards?.send?.(send.id)}
  </article>;
  const rows = folder === 'connections' ? snapshot.connections.map(value => row(value.id, `${value.agent} · ${value.platform}`, value.workspace, value.state))
    : folder === 'channels' ? snapshot.channels.map(value => row(bridgePlaceKey(value), value.channel, `${value.platform} · ${value.workspace}`, `Answers: ${value.answers}`))
    : folder === 'people' ? snapshot.people.map(value => row(bridgePersonKey(value), value.member, `${value.platform} · ${value.workspace} · ${value.user}`))
    : sends.map(value => row(value.id, value.channel, value.text, value.state));
  return <Split label="Bridges" folders={(Object.keys(labels) as BridgeFolder[]).map(id => ({ id, label: labels[id], count: counts[id] }))}
    folder={folder} onFolder={id => { select(undefined); changeFolder(id as BridgeFolder); }} listTop={cards?.create} listTitle={labels[folder]}
    list={rows.length ? <List label={labels[folder]}>{rows}</List> : <Empty title={`No ${labels[folder].toLowerCase()}`} />}
    reader={reader} open={reader !== null} onBack={() => select(undefined)} backLabel={`Back to ${labels[folder].toLowerCase()}`}
    blank={<Empty title={active ? 'This item is no longer available' : 'Choose an item'} />} />;
}
