import type { LiveRecord } from '../../data';
/** Metadata only: no message words or credential values belong in these records. */
export interface VenueRecord extends LiveRecord {
  id: string; platform: 'discord' | 'slack'; agent: string; workspace: string; bot: string;
  tokenSecret: string; appSecret?: string; only: string[]; ignore: string[]; botRoles: string[];
  enabled: boolean; connection: string; received: number; delivered: number | null; held: number | null;
}
export interface RouteRecord extends LiveRecord {
  id: string; platform: 'discord' | 'slack'; workspace: string; channel: string;
  parent?: string; primary?: string; pair?: string; peer: boolean; guest: boolean; readers: string[]; notes: string[];
}
export interface SendRecord extends LiveRecord {
  id: string; venue: string; incoming: string; state: string; remoteId?: string; created: number;
}
export interface EffectRecord extends LiveRecord {
  id: string; kind: string; title: string; state: 'due' | 'released' | 'started' | 'done' | 'uncertain';
}
export const bridgeEffects = (effects: readonly EffectRecord[]) => effects.filter(e => e.kind === 'bridge-send' && e.state !== 'done');
export function sendStatus(send: SendRecord, effect?: EffectRecord): string {
  if (send.state === 'uncertain' || effect?.state === 'uncertain') return 'Uncertain · review required';
  if (effect?.state === 'due') return 'Held in staging';
  if (effect?.state === 'released' || effect?.state === 'started') return 'Attempt in progress';
  return send.state === 'held' ? 'Held · review required' : send.state;
}

export type RouteInput = Pick<RouteRecord, 'id' | 'platform' | 'workspace' | 'channel' | 'parent' | 'primary' | 'pair' | 'peer' | 'guest' | 'readers' | 'notes'>;
export function routeInput(route: RouteRecord): RouteInput {
  return { id: route.id, platform: route.platform, workspace: route.workspace, channel: route.channel,
    parent: route.parent, primary: route.primary, pair: route.pair, peer: route.peer, guest: route.guest,
    readers: route.readers, notes: route.notes };
}

export type VenueInput = Pick<VenueRecord, 'id' | 'platform' | 'agent' | 'workspace' | 'bot' | 'tokenSecret' | 'appSecret' | 'enabled' | 'only' | 'ignore' | 'botRoles'>;
export function venueInput(v: VenueRecord): VenueInput {
  return { id: v.id, platform: v.platform, agent: v.agent, workspace: v.workspace, bot: v.bot,
    tokenSecret: v.tokenSecret, appSecret: v.appSecret, enabled: v.enabled,
    only: v.only, ignore: v.ignore, botRoles: v.botRoles };
}

export interface LinkRecord extends LiveRecord {
  id: string; platform: 'discord' | 'slack'; workspace: string; user: string; person: string;
}
export type LinkInput = Pick<LinkRecord, 'id' | 'platform' | 'workspace' | 'user' | 'person'>;
export function linkInput(link: LinkRecord): LinkInput {
  return { id: link.id, platform: link.platform, workspace: link.workspace, user: link.user, person: link.person };
}
