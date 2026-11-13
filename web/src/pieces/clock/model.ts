import type { LiveRecord } from '../../data';
export interface Work extends LiveRecord {
  agent: string; project?: string; member?: string; note: string; prompt?: string; file?: string; model?: string; slot?: string;
}
export interface Wake extends Work {
  due: number; state: 'pending' | 'parked' | 'held' | 'firing' | 'fired' | 'failed' | 'cancelled';
  hold?: string; outcome?: string; schedule?: string; failures: number; wait?: { id: string; until: number };
}
export interface Schedule extends Work {
  at: string[]; days: string; enabled: boolean; lane?: string;
  laneDetails?: { text: string; source?: string; local: boolean };
}
export interface Clock extends LiveRecord { paused: boolean }
export const active = (w: Wake) => ['pending','parked','held','firing'].includes(w.state);
export const time = (at: number) => new Date(at).toLocaleString('en-US', { timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short' }) + ' CT';
export const title = (w: Work) => w.note || w.file || w.id;
export const state = (w: Wake, paused: boolean) => w.state === 'parked' ? 'Parked · awaiting answer' : w.state === 'held' ? `Held · ${w.hold ?? 'review required'}` : w.state === 'pending' && paused ? 'Waiting · paused' : w.state;
