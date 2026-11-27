import type { DataQuerySnapshot } from '../../data/graphql';
import type { BridgesSnapshot } from '../bridges-view';

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
