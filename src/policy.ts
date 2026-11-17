import { isInternalCaller } from './core/internal.js';
/** The household's permission rules, stated once.
 *
 * A rule is data (Rule, below). It has two faces that read the same statement:
 *  - holds() in this file answers for one row or one action;
 *  - sqlRule() in policy-sql.ts turns it into a filter for a list read.
 * policy-sql.ts holds no rule of its own, and policy-sql.test.ts checks that the
 * two faces agree for every rule on a generated matrix of viewers and rows.
 * A door that needs a decision imports it from here; it does not restate it.
 *
 * Transport credentials never imply ownership. */
export type Viewer =
  | { kind: 'member'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'runner'; id: string }
  | { kind: 'service'; id: string };
export interface Scope { project?: string; agent?: string; member?: string }
export interface RecordScope extends Scope { type?: string }
/** Current household facts. A removed member is left out: to every rule a removed
 * member is nobody, whatever links to agents and projects they left behind. */
export interface Sharing {
  members: Record<string, { owner: boolean; agents: string[] }>;
  projects: Record<string, { members: string[]; agents: string[] }>;
  services: Record<string, { types: string[]; operations: string[] }>;
  /** Agents that are not removed. A snapshot built without it knows no current agent. */
  agents?: readonly string[];
}
export type Action = 'act' | 'give-work' | 'agent-setup' | 'household';
const entry = <T>(map: Record<string, T>, id: string): T | undefined => Object.hasOwn(map, id) ? map[id] : undefined;

/** The tables with a read rule in tableRules, by schema key. */
export type TableWithRule = 'tasks' | 'taskComments' | 'taskLinks' | 'projects' | 'projectMembers'
  | 'agents' | 'agentStatus' | 'agentPauses' | 'agentModels' | 'agentRunSettings' | 'agentBoxes' | 'agentHousePorts' | 'agentHouseSecrets' | 'agentPeople' | 'agentDeniedTools'
  | 'members' | 'memberAgents' | 'memberPreferences'
  | 'approvals' | 'approvalRecord' | 'approvalNotices' | 'approvalRules' | 'changeSync' | 'changes' | 'changeChecks' | 'changePeople' | 'changeTasks'
  | 'conversations' | 'conversationPeople' | 'turns' | 'digests' | 'conversationDays' | 'findings' | 'digestItems'
  | 'triggers' | 'triggerEdits' | 'triggerLog' | 'boxes' | 'boxAgents' | 'boxFacts' | 'timingDays' | 'measuringSettings';
/** The tables a child row can be seen with; each is keyed by `id`. */
export type ParentTable = Extract<TableWithRule, 'tasks' | 'approvals' | 'changes' | 'conversations' | 'digests' | 'triggers' | 'boxes'>;
/** One rule about one row. `field` names a column of the row by its schema key. */
export type Rule =
  | { is: 'never' }
  /** The viewer is a current member whose role is owner. */
  | { is: 'householdOwner' }
  | { is: 'viewerIs'; kind: 'member' | 'agent' }
  /** The viewer is a current member, or an agent that is not removed. */
  | { is: 'currentViewer' }
  /** The field names the viewing member. */
  | { is: 'self'; field: string }
  /** The field names a project the viewer is in: a member through project members, an agent through project agents. */
  | { is: 'inProject'; field: string }
  /** The field names an agent on the viewing member's own list, or the viewing agent itself. */
  | { is: 'ownsAgent'; field: string }
  /** The field names an agent that is in some project the viewer is in. */
  | { is: 'sharesProjectWithAgent'; field: string }
  /** The field names a current member, or an agent that is not removed. */
  | { is: 'names'; kind: 'member' | 'agent'; field: string }
  | { is: 'equal'; field: string; value: string | null }
  | { is: 'set'; field: string }
  | { is: 'any'; of: readonly Rule[] }
  | { is: 'all'; of: readonly Rule[] }
  /** The first case whose `when` holds decides; with none, `otherwise` does. */
  | { is: 'first'; cases: readonly (readonly [when: Rule, then: Rule])[]; otherwise: Rule }
  /** The field holds the id of a row of `table`, and that row passes that table's own rule. */
  | { is: 'seenWith'; table: ParentTable; field: string };

const never: Rule = { is: 'never' };
const householdOwner: Rule = { is: 'householdOwner' };
const viewerIs = (kind: 'member' | 'agent'): Rule => ({ is: 'viewerIs', kind });
const self = (field: string): Rule => ({ is: 'self', field });
const inProject = (field: string): Rule => ({ is: 'inProject', field });
const ownsAgent = (field: string): Rule => ({ is: 'ownsAgent', field });
const names = (kind: 'member' | 'agent', field: string): Rule => ({ is: 'names', kind, field });
const equal = (field: string, value: string | null): Rule => ({ is: 'equal', field, value });
const set = (field: string): Rule => ({ is: 'set', field });
const any = (...of: Rule[]): Rule => ({ is: 'any', of });
const all = (...of: Rule[]): Rule => ({ is: 'all', of });
const first = (cases: (readonly [Rule, Rule])[], otherwise: Rule): Rule => ({ is: 'first', cases, otherwise });
const seenWith = (table: ParentTable, field: string): Rule => ({ is: 'seenWith', table, field });

/** A record labelled with a member, a project and an agent (approvals, conversations, jobs, inbox items).
 * A household owner sees it. A member label makes it private to that member, whatever else it carries.
 * Otherwise being in its project or owning its agent is enough. */
const labelled: Rule = any(householdOwner, first([[set('member'), self('member')]], any(inProject('project'), ownsAgent('agent'))));
/** A task shares by project first. Without a project it is its owner's: a member's own, or an agent's owners'. */
const task: Rule = any(householdOwner, first([
  [set('project'), inProject('project')],
  [equal('ownerKind', 'member'), self('owner')],
  [equal('ownerKind', 'agent'), ownsAgent('owner')],
], never));
/** The roster: who an agent is, what it reports it is doing, whether it is paused and which models it
 * prefers. Its owners, the agent itself, and anyone who shares a project with it. */
const agentRoster = (field: string): Rule => any(householdOwner, ownsAgent(field), { is: 'sharesProjectWithAgent', field });
/** How an agent is set up to run: its house, machines, ports, startup-secret names, how it treats outside
 * people and which tools it is denied. Read by those who may change it (mayAct 'agent-setup'), household
 * owners and the agent itself. Sharing a project with an agent does not show its setup. */
const agentSetup = (field: string): Rule => any(householdOwner, ownsAgent(field));
/** Something one member owns (a machine, a model account's private detail): that member and household owners. */
const ownedByMember = (field: string): Rule => any(householdOwner, self(field));
const trigger: Rule = any(householdOwner,
  // A person sees, and so can stop, a trigger they set for themselves or one that is for them.
  all(equal('ownerKind', 'member'), self('owner')), all(equal('toKind', 'person'), self('to')),
  inProject('project'),
  all(equal('toKind', 'agent'), ownsAgent('to')),
  // An agent's own operation trigger has no recipient; it belongs to the agent.
  all(equal('targetKind', 'operation'), equal('toKind', null), equal('to', null), equal('ownerKind', 'agent'), ownsAgent('owner')));
/** Who may address something to this recipient (new scheduled work, an inbox item's volume). To an agent:
 * whoever directs it. To a person: that person, or a household owner on their behalf. The recipient must be
 * in the household now. */
const recipient: Rule = first([
  [equal('toKind', 'agent'), all(names('agent', 'to'), ownsAgent('to'))],
], all(names('member', 'to'), ownedByMember('to')));
/** Who may set how loudly an inbox item arrives: someone in the household who may address its recipient. */
const inboxVolume: Rule = all({ is: 'currentViewer' }, recipient);

export const rules = { labelled, task, trigger, recipient, inboxVolume, agentRoster, agentSetup, ownedByMember, householdOwner,
  project: any(householdOwner, inProject('id')) } as const;

/** The read rule of every table served by the shared query door, by schema key. The bridge and secret
 * tables are stated beside their door in core/data/bridge-secrets-visibility.ts. */
export const tableRules: Readonly<Record<TableWithRule, Rule>> = {
  tasks: task,
  taskComments: seenWith('tasks', 'task'),
  // Both ends are part of a link, even when the caller selects only ids.
  taskLinks: all(seenWith('tasks', 'task'), seenWith('tasks', 'dependsOn')),
  projects: rules.project,
  // Membership ids are part of a visible project, not a member directory.
  projectMembers: any(householdOwner, inProject('project')),
  agents: agentRoster('id'),
  agentStatus: agentRoster('agent'),
  agentPauses: agentRoster('agent'),
  agentModels: agentRoster('agent'),
  agentRunSettings: agentSetup('agent'),
  agentBoxes: agentSetup('agent'),
  agentHousePorts: agentSetup('agent'),
  agentHouseSecrets: agentSetup('agent'),
  agentPeople: agentSetup('agent'),
  agentDeniedTools: agentSetup('agent'),
  members: ownedByMember('id'),
  memberAgents: householdOwner,
  memberPreferences: self('member'),
  approvals: labelled,
  approvalRecord: seenWith('approvals', 'approval'),
  // Notices carry no project or member label; never infer one from their target text.
  approvalNotices: any(householdOwner, ownsAgent('agent')),
  // Household-wide configuration and sync state carry no sharing label.
  approvalRules: householdOwner,
  changeSync: householdOwner,
  changes: any(householdOwner, inProject('project'), ownsAgent('agent')),
  changeChecks: seenWith('changes', 'change'),
  changePeople: seenWith('changes', 'change'),
  changeTasks: all(seenWith('changes', 'change'), seenWith('tasks', 'task')),
  conversations: labelled,
  conversationPeople: seenWith('conversations', 'conversation'),
  turns: seenWith('conversations', 'conversation'),
  digests: seenWith('conversations', 'conversation'),
  conversationDays: seenWith('conversations', 'conversation'),
  findings: seenWith('conversations', 'conversation'),
  digestItems: seenWith('digests', 'digest'),
  triggers: trigger,
  triggerEdits: seenWith('triggers', 'trigger'),
  triggerLog: seenWith('triggers', 'trigger'),
  // Machines: their member's, and household owners'. Hosting an agent is permission to run it, not to read
  // its owner's registry: an agent reads no machine.
  boxes: ownedByMember('owner'),
  // Which agents may run on a machine is seen with the machine, except that an agent sees its own rows, so it
  // can name a machine when it proposes a change, and nothing else about that machine.
  boxAgents: first([[viewerIs('agent'), ownsAgent('agent')]], seenWith('boxes', 'box')),
  boxFacts: seenWith('boxes', 'box'),
  timingDays: any(householdOwner, all(viewerIs('agent'), { is: 'currentViewer' })),
  measuringSettings: householdOwner,
};

export type Row = Readonly<Record<string, unknown>>;
/** Finds the row of `table` with this id, for seenWith. Returns nothing when there is none. */
export type ParentLookup = (table: ParentTable, id: string) => Row | undefined;

/** The predicate face: does this rule hold for this viewer and this row, on the current facts?
 * Only members and agents read rows; every other kind of viewer gets false. */
export function holds(rule: Rule, v: Viewer, row: Row, s: Sharing, parent?: ParentLookup): boolean {
  if (v.kind !== 'member' && v.kind !== 'agent') return false;
  const m = v.kind === 'member' ? entry(s.members, v.id) : undefined;
  const text = (field: string) => { const value = row[field]; return typeof value === 'string' ? value : undefined; };
  const inside = (p: { members: string[]; agents: string[] } | undefined) => !!p && (v.kind === 'member' ? !!m && p.members.includes(v.id) : p.agents.includes(v.id));
  switch (rule.is) {
    case 'never': return false;
    case 'householdOwner': return !!m?.owner;
    case 'viewerIs': return v.kind === rule.kind;
    case 'currentViewer': return v.kind === 'member' ? !!m : !!s.agents?.includes(v.id);
    case 'self': return !!m && text(rule.field) === v.id;
    case 'inProject': { const id = text(rule.field); return id !== undefined && inside(entry(s.projects, id)); }
    case 'ownsAgent': { const id = text(rule.field); return id !== undefined && (v.kind === 'agent' ? id === v.id : !!m?.agents.includes(id)); }
    case 'sharesProjectWithAgent': { const id = text(rule.field); return id !== undefined && Object.values(s.projects).some(p => p.agents.includes(id) && inside(p)); }
    case 'names': { const id = text(rule.field); return id !== undefined && (rule.kind === 'member' ? !!entry(s.members, id) : !!s.agents?.includes(id)); }
    case 'equal': return (row[rule.field] ?? null) === rule.value;
    case 'set': return (row[rule.field] ?? null) !== null;
    case 'any': return rule.of.some(part => holds(part, v, row, s, parent));
    case 'all': return rule.of.every(part => holds(part, v, row, s, parent));
    case 'first': {
      const found = rule.cases.find(([when]) => holds(when, v, row, s, parent));
      return holds(found ? found[1] : rule.otherwise, v, row, s, parent);
    }
    case 'seenWith': {
      if (!parent) throw new Error(`Rule needs a lookup for ${rule.table}`);
      const id = text(rule.field), found = id === undefined ? undefined : parent(rule.table, id);
      return !!found && holds(tableRules[rule.table], v, found, s, parent);
    }
  }
}

/** Is the viewer in the household now: a member who is not removed, or an agent that is not removed? */
export function inHousehold(v: Viewer, s: Sharing): boolean {
  return holds({ is: 'currentViewer' }, v, {}, s);
}
/** A current member whose role is owner. The role runs the household and sees every record; it does not by
 * itself direct an agent (directsAgent). */
export function isHouseholdOwner(v: Viewer, s: Sharing): boolean {
  return holds(householdOwner, v, {}, s);
}
/** Who may put an agent to work, pause it or schedule for it: a member with the agent on their own list,
 * or the agent itself. A full owner has every agent on their list. */
export function directsAgent(v: Viewer, agent: string, s: Sharing): boolean {
  return holds(ownsAgent('agent'), v, { agent }, s);
}

export function maySee(v: Viewer, r: RecordScope, s: Sharing): boolean {
  if (isInternalCaller(v)) return true;
  if (v.kind === 'service') return r.member === undefined && !!r.type && !!entry(s.services, v.id)?.types.includes(r.type);
  // A worker is given its jobs by Runtime, on proof of assignment checked at that door; it reads no record here.
  if (v.kind === 'runner') return false;
  // A task is labelled by its owner, not by member and agent columns; it answers to the tasks rule.
  const seen = r.type === 'task'
    ? holds(task, v, { project: r.project, ownerKind: r.member !== undefined ? 'member' : r.agent !== undefined ? 'agent' : 'household', owner: r.member ?? r.agent }, s)
    : holds(labelled, v, { member: r.member, project: r.project, agent: r.agent }, s);
  // Knowledge is the household's shared file store: every agent reads it. Viewer identity is supplied by
  // authentication, including an agent terminal session without a job.
  return seen || r.type === 'knowledge' && v.kind === 'agent' && r.member === undefined && r.agent === undefined;
}
export function mayAct(v: Viewer, r: RecordScope, s: Sharing, action: Action = 'act', operation?: string): boolean {
  if (isInternalCaller(v)) return true;
  if (!maySee(v, r, s)) return false;
  if (v.kind === 'service') return action === 'act' && !!operation && !!entry(s.services, v.id)?.operations.includes(operation);
  if (action === 'household') return isHouseholdOwner(v, s);
  // Giving an agent work and changing its setup belong to the members who own it.
  if (action === 'give-work' || action === 'agent-setup') return v.kind === 'member' && !!r.agent && directsAgent(v, r.agent, s);
  return true;
}
/** New fields must be visible separately; project access cannot smuggle in an agent. */
export function mayCreate(v: Viewer, r: RecordScope, s: Sharing, operation?: string): boolean {
  if (isInternalCaller(v)) return true;
  if (r.member !== undefined && (v.kind !== 'member' || r.member !== v.id)) return false;
  return mayAct(v, r, s, 'act', operation)
    && (r.project === undefined || maySee(v, { project: r.project }, s))
    && (r.agent === undefined || maySee(v, { agent: r.agent }, s));
}

/** Owning Clock/Runtime execution only. A committed source supplies scope;
 * current membership and both project grants supply authority. This confers
 * no registry visibility, member identity, or service private-read access. */
export function mayRunPrivateWork(r: Scope & {agent:string}, s:Sharing):boolean {
  const member=r.member===undefined?undefined:entry(s.members,r.member);
  const project=r.project===undefined?undefined:entry(s.projects,r.project);
  return !!member?.agents.includes(r.agent) && (r.project===undefined
    || !!project?.agents.includes(r.agent) && (member.owner || project.members.includes(r.member!)));
}
