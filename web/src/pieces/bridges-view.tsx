import {ToolbarFrame} from '../kit/toolbar';
import type { ReactNode } from 'react';
import { activityLine, awaitingReview, bridgeLabels, sendNotes } from './bridges/data';
import {fullTime} from '../kit/time';
import { Button, Fact, Facts, Meta, Reader, Section, Title, Empty, Error, List, Loading, Row, Split } from '../kit';

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
const labels: Record<BridgeFolder, string> = bridgeLabels;

/** Presentation only. Authenticated generated queries supply rows; the root
 * supplies owner controls and send review. No token, API call, or
 * mutation lives here. A non-live snapshot never displays retained rows. */
export function BridgesView({ snapshot, member, folder, selected, select, changeFolder, cards, zone, creating, onCreate }: {
  snapshot: BridgesSnapshot;
  member: string;
  zone?:string;
  creating?:boolean;
  onCreate?:()=>void;
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
  const recent=new Map(snapshot.activity.map(entry=>[entry.connection,entry]));
  const open = (id: string) => select({ folder, id });
  const row = (id: string, title: string, meta: ReactNode, status?: string) =>
    <Row key={id} title={title} meta={meta} status={status} selected={id === active} onClick={() => open(id)} />;
  let reader: ReactNode = null;
  const createLabel=folder==='connections'?'New connection':folder==='channels'?'New channel rule':'New person link';
  if (creating && cards?.create && folder!=='sends') reader=<Reader className="p-5"><Title as="h1">{createLabel}</Title>{cards.create}</Reader>;
  else if (connection) {
    const activity = recent.get(connection.id);
    reader = <Reader className="p-5">
      <Title as="h1">{connection.agent} · {connection.platform}</Title>
      <Meta>{connection.state} · {connection.enabled ? 'Enabled' : 'Disabled'}</Meta>
      <Facts><Fact label="Workspace">{connection.workspace}</Fact>
      <Fact label="State changed"><time dateTime={connection.stateAt}>{fullTime(connection.stateAt,zone)}</time></Fact><Fact label="Bot user">{connection.botUser}</Fact></Facts>
      {activity && <Section label="Last 24 hours"><p>{activityLine(activity)}</p></Section>}
      <Section label="Channel filters">{(['only', 'ignore'] as const).map(rule => {
        const channels = snapshot.filters.filter(filter => filter.connection === connection.id && filter.rule === rule);
        return <p key={rule}>{rule === 'only' ? 'Only channels' : 'Ignored channels'}: {channels.map(filter => filter.channel).join(', ') || 'None'}</p>;
      })}</Section>
      <Section label="Stored secret names"><p>Bot token: {connection.tokenSecret}</p>{connection.appSecret && <p>App token: {connection.appSecret}</p>}</Section>
      {cards?.connection?.(connection.id)}
    </Reader>;
  } else if (channel) reader = <Reader className="p-5"><Title as="h1">{channel.channel}</Title><p>{channel.platform} · {channel.workspace}</p><p>Answers when nobody is addressed: {channel.answers}</p><p>Bots may talk: {channel.botsMayTalk ? 'Yes' : 'No'}</p>{cards?.channel?.(channel)}</Reader>;
  else if (person) reader = <Reader className="p-5"><Title as="h1">{person.member}</Title><p>{person.platform} · {person.workspace}</p><p>Outside user: {person.user}</p>{cards?.person?.(person)}</Reader>;
  else if (send) reader = <Reader className="p-5"><Title as="h1">Reply to {send.channel}</Title><p>{send.state}</p><p>{send.text}</p>
    {send.thread && <p>Thread: {send.thread}</p>}
    {send.state === 'uncertain' && <p>{sendNotes.uncertain}</p>}
    {send.state === 'held' && <p>{sendNotes.held}</p>}
    {cards?.send?.(send.id)}
  </Reader>;
  const rows = folder === 'connections' ? snapshot.connections.map(value => {
      const activity=recent.get(value.id);
      const detail=activity?value.workspace+' · '+activityLine(activity)+' in 24 hours':value.workspace;
      return row(value.id, `${value.agent} · ${value.platform}`, detail, value.state);})
    : folder === 'channels' ? snapshot.channels.map(value => row(bridgePlaceKey(value), value.channel, `${value.platform} · ${value.workspace}`, `Answers: ${value.answers}`))
    : folder === 'people' ? snapshot.people.map(value => row(bridgePersonKey(value), value.member, `${value.platform} · ${value.workspace} · ${value.user}`))
    : sends.map(value => row(value.id, value.channel, value.text, value.state));
  return <ToolbarFrame title="Bridges" controls={onCreate&&cards?.create?<Button onClick={onCreate}>{createLabel}</Button>:undefined}>
    <Split label="Bridges" folders={(Object.keys(labels) as BridgeFolder[]).map(id => ({ id, label: labels[id], count: counts[id] }))}
    folder={folder} onFolder={id => { select(undefined); changeFolder(id as BridgeFolder); }}  listTop={onCreate?undefined:cards?.create} listTitle={labels[folder]}
    list={rows.length ? <List label={labels[folder]}>{rows}</List> : <Empty title={`No ${labels[folder].toLowerCase()}`} />}
    reader={reader} open={reader !== null} onBack={() => select(undefined)} backLabel={`Back to ${labels[folder].toLowerCase()}`}
    blank={<Empty title={active ? 'This item is no longer available' : 'Choose an item'} />} />
  </ToolbarFrame>;
}
