import type { DataQuerySnapshot } from '../../data/graphql';

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

/** The shared root resolves the reader from its authenticated executor. */
export const bridgesQuery = `query Bridges {
  bridgeReader { id manage }
  bridgeActivity { id received delivered held }
  bridgeConnections { id platform agent workspace botUser tokenSecret appSecret enabled state stateAt }
  bridgeChannelFilters { connection channel rule }
  bridgeChannels { platform workspace channel answers botsMayTalk }
  bridgePeople { platform workspace user member }
  bridgeSends { id incoming connection channel thread text state createdAt }
}`;
export interface BridgesData {
  bridgeReader: { id: string; manage?: boolean } | null;
  bridgeActivity: readonly { id: string; received: number; delivered: number; held: number }[];
  bridgeConnections: BridgesSnapshot['connections'];
  bridgeChannelFilters: BridgesSnapshot['filters'];
  bridgeChannels: BridgesSnapshot['channels'];
  bridgePeople: BridgesSnapshot['people'];
  bridgeSends: BridgesSnapshot['sends'];
}
export function bridgesSnapshot(query: DataQuerySnapshot<BridgesData>): BridgesSnapshot {
  const empty: BridgesSnapshot = { status: query.status === 'loading' ? 'loading' : query.status === 'offline' ? 'offline' : 'error',
    member: '', connections: [], filters: [], channels: [], people: [], sends: [], activity: [] };
  if (query.status !== 'live' || !query.data?.bridgeReader?.id) return empty;
  const data = query.data;
  return { status: 'live', member: data.bridgeReader!.id, connections: data.bridgeConnections,
    filters: data.bridgeChannelFilters, channels: data.bridgeChannels, people: data.bridgePeople,
    sends: data.bridgeSends, activity: data.bridgeActivity.map(({ id, ...counts }) => ({ connection: id, ...counts })) };
}

/** A reply that has not gone out and is not put aside: what "Pending sends" lists. */
export const awaitingReview = (send: { state: string }) => ['pending', 'held', 'sending', 'uncertain'].includes(send.state);
/** What a reply in doubt and a held reply say under their words. */
export const sendNotes = { uncertain: 'Delivery could not be confirmed. Review before sending again.', held: 'This send waits for a person to release or dismiss it.' };
/** The Bridges folders' names, and a connection's activity over the last day. */
export const bridgeLabels = { connections: 'Connections', channels: 'Channel rules', people: 'Person links', sends: 'Pending sends' } as const;
export const activityLine = (activity: { received: number; delivered: number; held: number }) => `${activity.received} received · ${activity.delivered} delivered · ${activity.held} held`;
