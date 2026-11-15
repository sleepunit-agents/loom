import type { DataQuerySnapshot } from '../../data/graphql';
import type { BridgesSnapshot } from '../bridges-view';

/** The root mounts these generated tables and its existing authenticated Comms
 * member field on the same schema. No viewer id comes from the URL or storage. */
export const bridgesQuery = `query Bridges {
  homeComms { member }
  bridgeConnections { id platform agent workspace botUser tokenSecret appSecret enabled state stateAt }
  bridgeChannelFilters { connection channel rule }
  bridgeChannels { platform workspace channel answers botsMayTalk }
  bridgePeople { platform workspace user member }
  bridgeSends { id incoming connection channel thread text state postedId createdAt }
}`;
export interface BridgesData {
  homeComms: { member: string } | null;
  bridgeConnections: BridgesSnapshot['connections'];
  bridgeChannelFilters: BridgesSnapshot['filters'];
  bridgeChannels: BridgesSnapshot['channels'];
  bridgePeople: BridgesSnapshot['people'];
  bridgeSends: BridgesSnapshot['sends'];
}
export function bridgesSnapshot(query: DataQuerySnapshot<BridgesData>): BridgesSnapshot {
  const empty: BridgesSnapshot = { status: query.status === 'loading' ? 'loading' : query.status === 'offline' ? 'offline' : 'error',
    member: '', connections: [], filters: [], channels: [], people: [], sends: [], activity: [] };
  if (query.status !== 'live' || !query.data?.homeComms?.member) return empty;
  const data = query.data;
  return { status: 'live', member: data.homeComms!.member, connections: data.bridgeConnections,
    filters: data.bridgeChannelFilters, channels: data.bridgeChannels, people: data.bridgePeople,
    sends: data.bridgeSends, activity: [] };
}
