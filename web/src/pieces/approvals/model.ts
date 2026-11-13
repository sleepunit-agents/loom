import type { LiveRecord } from '../../data';
export interface Approval extends LiveRecord {
  title: string; kind: string; target: string; what: string; why: string;
  state: 'pending' | 'allowed' | 'denied' | 'used' | 'withdrawn' | 'expired';
  ask?: string; if_yes?: string; if_no?: string; details?: string;
  at: string; by?: string; decided?: string; who: { agent: string; where: string }; for: string;
}
export interface Rule extends LiveRecord {
  kind: string; scope?: string; tier?: string; person?: string; target?: string; off?: unknown;
}
export interface Open { open: boolean; mayAnswer: boolean; mayEveryTime: boolean; mayAlways: boolean }
export const matches = (a: Approval, query: string) => query.toLowerCase().trim().split(/\s+/).every(word =>
  [a.title,a.ask,a.why,a.kind,a.target,a.who.agent,a.for].join(' ').toLowerCase().includes(word));
