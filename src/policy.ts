/** The ordered household rule. Transport credentials never imply ownership. */
export type Viewer =
  | { kind: 'member'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'runner'; id: string }
  | { kind: 'service'; id: string };
export interface Scope { project?: string; agent?: string; member?: string }
export interface RecordScope extends Scope { type?: string; runner?: string; /** Trusted runtime binding proof; never an input field. */ privateControl?: boolean }
export interface Sharing {
  members: Record<string, { owner: boolean; agents: string[] }>;
  projects: Record<string, { members: string[]; agents: string[] }>;
  services: Record<string, { types: string[]; operations: string[] }>;
}
export type Action = 'act' | 'give-work' | 'agent-setup' | 'household' | 'answer-person' | 'report-job' | 'report-box';
const entry = <T>(map: Record<string, T>, id: string): T | undefined => Object.hasOwn(map, id) ? map[id] : undefined;
export function maySee(v: Viewer, r: RecordScope, s: Sharing): boolean {
  if (v.kind === 'runner') return r.member === undefined && r.type === 'runtime.job' && r.runner === v.id;
  if (v.kind === 'service') return r.member === undefined && !!r.type && !!entry(s.services, v.id)?.types.includes(r.type);
  if (r.member !== undefined) return v.kind === 'member' && v.id === r.member && !!entry(s.members, v.id);
  const m = v.kind === 'member' ? entry(s.members, v.id) : undefined;
  if (m?.owner) return true;
  if (r.project !== undefined) {
    const p = entry(s.projects, r.project);
    return !!p && (v.kind === 'member' ? !!m && p.members.includes(v.id) : p.agents.includes(v.id));
  }
  if (r.agent !== undefined) return v.kind === 'agent' ? v.id === r.agent : !!m?.agents.includes(r.agent);
  return false;
}
export function mayAct(v: Viewer, r: RecordScope, s: Sharing, action: Action = 'act', operation?: string): boolean {
  // A runner may update its own box report without gaining registry read access.
  if (action === 'report-box') return v.kind === 'runner' && r.type === 'runtime.box' && r.runner === v.id && r.member === undefined;
  // Control of an assigned job reveals no private words or registry visibility.
  if (action === 'report-job' && v.kind === 'runner') return r.type === 'runtime.job' && r.runner === v.id && (r.member === undefined || r.privateControl === true);
  if (!maySee(v, r, s)) return false;
  if (v.kind === 'service') return action === 'act' && !!operation && !!entry(s.services, v.id)?.operations.includes(operation);
  if (v.kind === 'runner') return action === 'report-job';
  const m = v.kind === 'member' ? entry(s.members, v.id) : undefined;
  if (action === 'household') return !!m?.owner;
  if (action === 'answer-person') return v.kind === 'member';
  if (action === 'give-work' || action === 'agent-setup') return !!r.agent && !!m && m.agents.includes(r.agent);
  return true;
}
/** New fields must be visible separately; project access cannot smuggle in an agent. */
export function mayCreate(v: Viewer, r: RecordScope, s: Sharing, operation?: string): boolean {
  if (r.member !== undefined && (v.kind !== 'member' || r.member !== v.id)) return false;
  return mayAct(v, r, s, 'act', operation)
    && (r.project === undefined || maySee(v, { project: r.project }, s))
    && (r.agent === undefined || maySee(v, { agent: r.agent }, s));
}
export function mayMove(v: Viewer, before: RecordScope, after: RecordScope, s: Sharing, operation?: string): boolean {
  return before.member === after.member && mayAct(v, before, s, 'act', operation) && mayCreate(v, after, s, operation);
}

/** Private Comms membership is independent of project and household-owner access. */
export function mayUseThread(v: Viewer, r: { member: string; agent: string }, s: Sharing): boolean {
  return v.kind === 'member' && v.id === r.member && !!entry(s.members, v.id)?.agents.includes(r.agent);
}
