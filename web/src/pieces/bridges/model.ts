import type { LiveRecord } from '../../data';
/** Metadata only: no message words or credential values belong in these records. */
export interface VenueRecord extends LiveRecord {
  id: string; platform: 'discord' | 'slack'; agent: string; workspace: string; bot: string;
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
