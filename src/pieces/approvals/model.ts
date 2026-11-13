import type { RecordScope } from '../../core/index.js';
/** The old program's receipts, kept losslessly; authority comes only from authenticated context. */
export interface Who { agent: string; where: string }
export interface Principal { for: string; people?: string[] }
export interface Caller extends Principal { who: Who; conversation?: string; project?: string; member?: string }
export interface Approval extends Principal {
  id: string; kind: string; target: string; what: string; why: string; who: Who;
  minutes: number; at: string; state: 'pending' | 'allowed' | 'denied' | 'used' | 'withdrawn' | 'expired';
  ask?: string; if_yes?: string; if_no?: string; details?: string; conversation?: string;
  digest?: string; decided?: string; expires?: string; by?: string; used?: string; withdrawn?: string;
  granted?: boolean; superseded_by?: string; project?: string; agent?: string; member?: string;
}
export interface Rule { kind: string; scope: string; tier: string; by: string; at: string; person?: string }
export interface Standing extends Principal {
  id: string; kind: string; agent: string; member?: string; project?: string; target: string; digest: string; who: Who; from: string;
  what: string; details?: string; at: string; by?: string; uses: number; used?: string; off?: { at: string; by?: string };
}
export interface Notice { at: string; agent: string; kind: string; target: string; what: string; for?: string }
export interface State { approvals: Approval[]; rules: Rule[]; grants: Rule[]; standing: Standing[]; notices: Notice[]; audit: Record<string, unknown>[] }
export const retiredAgentGrantReason = 'no longer applies: agent access follows record scope';
export const empty = (): State => ({ approvals: [], rules: [], grants: [], standing: [], notices: [], audit: [] });
export const iso = (now: number) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const stateOf = (a: Approval, now: number) => a.state === 'allowed' && a.expires && Date.parse(a.expires) <= now ? 'expired' : a.state;
export const forOf = (a: { for?: string }) => a.for ?? 'owner';
export const samePrincipal = (a: { for?: string; people?: string[]; member?: string }, p: Principal & {member?: string}) => a.member === p.member && forOf(a) === p.for && (p.for !== '?' || JSON.stringify([...(a.people ?? [])].sort()) === JSON.stringify([...(p.people ?? [])].sort()));
export const serviceOf = (who: Who) => /\(([^()]*)\)$/.exec(who.where)?.[1];
export const maySpend = (asked: Who, who: Who) => asked.agent === who.agent && (serviceOf(who) === undefined || serviceOf(who) === serviceOf(asked));
export const pieceKinds = new Set(['local-wake', 'vouch-wake', 'principal-reset', 'box-write-off']);
export const ownerApplied = new Set(['vouch-wake', 'principal-reset', 'box-write-off']);
export const pieceSpent = new Set([...ownerApplied, 'host', 'local-wake']);
export const ownerAnswered = new Set([...ownerApplied, 'host']);

export const approvalScope = (a: Approval): RecordScope => ({ type:'approval', ...(a.project ? {project:a.project}:{}), ...(a.agent ?? a.who.agent ? {agent:a.agent ?? a.who.agent}:{}), ...(a.member ? {member:a.member}:{}) });
