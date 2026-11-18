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
 * Transport credentials never imply ownership.
 *
 * An agent's body doing a member's private work is still the agent, never that member. But it reaches
 * no further than the member does: see `workingFor`. */
export type Viewer =
  | { kind: 'member'; id: string }
  /** `workingFor` is the member whose private work this agent's body is doing. It is set where the credential is
   * resolved, from the job the body's token is bound to (currentToken in core/data/authentication.ts),
   * never from request input. A terminal session, and a body whose job is for no member, has none and is the agent alone.
   *
   * With it, each way the agent reaches a record counts only while that member has the same reach:
   *  - a project (inProject, sharesProjectWithAgent): the member is in it too, or is a household owner;
   *  - being the agent a record names (ownsAgent): the member has this agent on their own list;
   *  - being in the household (currentViewer): the member is in it too.
   * So a body working for a member reads and changes nothing through a project the member is not in, and
   * nothing at all once the member has left or lost the agent. It never gains what only a member holds
   * (self, householdOwner). What stays the agent's own whoever it works for is listed in
   * docs/accepted-tradeoffs.md, "A body keeps the agent's own knowledge". */
  | { kind: 'agent'; id: string; workingFor?: string }
  | { kind: 'runner'; id: string }
  | { kind: 'service'; id: string };
export interface Scope { project?: string; agent?: string; member?: string }
/** `direct` is a conversation's label for a direct message on a bridge; only a record of type `conversation` has it. */
export interface RecordScope extends Scope { type?: string; direct?: boolean }
/** Current household facts. A removed member is left out: to every rule a removed
 * member is nobody, whatever links to agents and projects they left behind. */
export interface Sharing {
  members: Record<string, { owner: boolean; agents: string[] }>;
  projects: Record<string, { members: string[]; agents: string[] }>;
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
  | 'conversations' | 'conversationPeople' | 'turns' | 'digests' | 'conversationDays' | 'findings' | 'digestItems' | 'jobs' | 'inbox'
  | 'bridgeConnections' | 'bridgeChannelFilters' | 'bridgeChannels' | 'bridgePeople' | 'bridgeIncoming' | 'bridgeSends'
  | 'secrets' | 'secretGrants' | 'secretRequests' | 'secretRules' | 'secretRuleAgents' | 'secretUses' | 'secretChanges'
  | 'triggers' | 'triggerEdits' | 'triggerLog' | 'boxes' | 'boxAgents' | 'boxFacts' | 'timingDays' | 'measuringSettings';
/** The tables a child row can be seen with; each is keyed by `id`. */
export type ParentTable = Extract<TableWithRule, 'tasks' | 'approvals' | 'changes' | 'conversations' | 'digests' | 'triggers' | 'boxes' | 'bridgeConnections' | 'bridgeIncoming' | 'secretRequests'>;
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
  | { is: 'equal'; field: string; value: string | boolean | null }
  | { is: 'set'; field: string }
  | { is: 'any'; of: readonly Rule[] }
  | { is: 'all'; of: readonly Rule[] }
  /** The first case whose `when` holds decides; with none, `otherwise` does. */
  | { is: 'first'; cases: readonly (readonly [when: Rule, then: Rule])[]; otherwise: Rule }
  /** The field holds the id of a row of `table`, and that row passes that table's own rule, or `as` when one is given. */
  | { is: 'seenWith'; table: ParentTable; field: string; as?: Rule }
  /** The viewer is a body working for a member who has its agent on their own list, and `rule` holds for
   * that member. The one way a body does something on its member's word; a rule that does not say this
   * gives a body nothing of its member's. */
  | { is: 'forItsMember'; rule: Rule };

const never: Rule = { is: 'never' };
const householdOwner: Rule = { is: 'householdOwner' };
const viewerIs = (kind: 'member' | 'agent'): Rule => ({ is: 'viewerIs', kind });
const self = (field: string): Rule => ({ is: 'self', field });
const inProject = (field: string): Rule => ({ is: 'inProject', field });
const ownsAgent = (field: string): Rule => ({ is: 'ownsAgent', field });
const names = (kind: 'member' | 'agent', field: string): Rule => ({ is: 'names', kind, field });
const equal = (field: string, value: string | boolean | null): Rule => ({ is: 'equal', field, value });
const set = (field: string): Rule => ({ is: 'set', field });
const any = (...of: Rule[]): Rule => ({ is: 'any', of });
const all = (...of: Rule[]): Rule => ({ is: 'all', of });
const first = (cases: (readonly [Rule, Rule])[], otherwise: Rule): Rule => ({ is: 'first', cases, otherwise });
const seenWith = (table: ParentTable, field: string, as?: Rule): Rule => ({ is: 'seenWith', table, field, ...(as ? { as } : {}) });
const currentViewer: Rule = { is: 'currentViewer' };

/** A record labelled with a member, a project and an agent, that a household owner runs: an approval card,
 * a machine, a model account. A household owner sees it. A member label makes it that member's and the
 * household owners'. Otherwise being in its project or owning its agent is enough. */
const labelled: Rule = any(householdOwner, first([[set('member'), self('member')]], any(inProject('project'), ownsAgent('agent'))));
/** The members who have the agent on their own list: not the agent itself, and not the owner role alone. */
const agentOwners: Rule = all(viewerIs('member'), ownsAgent('agent'));
/** Somebody's talk with an agent, and what hangs off it (its mail, its jobs, its questions).
 *
 * A member label makes it private to that member: a member's own thread with an agent. Nobody else reads
 * it, and that includes a household owner and the agent's other owners (docs/specs/comms.md, "Who may use
 * it", rule 2). The owner role runs the household; it does not read another person's conversation.
 *
 * `direct` marks a direct message on a bridge. One from a linked member carries that member and is private
 * to them, as above. One from anybody else, and a group direct message, has no member to be private to: it
 * is read by the members who have the agent on their own list and by no one else. The agent's own token
 * does not read it, so a body of the agent working in a public room cannot; the body working that
 * conversation is handed its mail and files at the body doors, on proof of its job.
 *
 * Anything else is read by household owners, the people in its project and whoever owns its agent. */
const privateTalk = (...more: (readonly [Rule, Rule])[]): Rule =>
  first([[set('member'), self('member')], ...more], any(householdOwner, inProject('project'), ownsAgent('agent')));
const conversation: Rule = privateTalk([equal('direct', true), agentOwners]);
/** A record that carries a conversation's labels and may name the conversation (a job, an inbox item, a
 * question). In a conversation it is seen with it, so the direct label reaches it; either way a member label
 * keeps it that member's alone. */
const inTalk: Rule = all(privateTalk(), any(equal('conversation', null), seenWith('conversations', 'conversation')));
/** What an inbox item waits on must itself be readable. A question about a task, an approval card or a
 * secret request is seen only by someone who may read that record, by that record's own rule; an item
 * that waits on nothing names nothing. This is part of the inbox rule, so no reader of the Inbox can be
 * built without it. */
const waitsOnReadable: Rule = first([
  [equal('waitsOnKind', 'task'), seenWith('tasks', 'waitsOnId')],
  [equal('waitsOnKind', 'approval'), seenWith('approvals', 'waitsOnId')],
  [equal('waitsOnKind', 'secret-request'), seenWith('secretRequests', 'waitsOnId')],
], all(equal('waitsOnKind', null), equal('waitsOnId', null)));
/** A bridge connection: household owners, and the members who own its agent. Never the agent itself. */
const bridgeConnection: Rule = any(householdOwner, agentOwners);
/** Who reads a post loom queued: whoever reads the message it answers, or, for a post that answers none (a
 * firing's or a note's answer, an agent's own post), whoever reads the conversation it was made in. */
const seesSend: Rule = any(seenWith('bridgeIncoming', 'incoming'), all(equal('incoming', null), seenWith('conversations', 'conversation')));
/** Who may review a reply that did not go out (release a held one, dismiss one held or in doubt): a member
 * who reads it, by the read rule of `bridgeSends`, and who is a household owner, since running the
 * household's bridges is theirs; or, when it answers a direct message, or answers none and was made in a
 * direct conversation, any member who reads it. The owner role does not read a direct message (rule
 * `conversation`), so there the reply is reviewed by the people the message is shown to: the conversation's
 * own member for their private one, the agent's owners for one from anybody else. So every reply awaiting
 * review has someone who can see it and decide. Never an agent. */
const reviewsReply: Rule = all(viewerIs('member'), currentViewer, seesSend,
  any(householdOwner, seenWith('bridgeIncoming', 'incoming', equal('isDm', true)), all(equal('incoming', null), seenWith('conversations', 'conversation', equal('direct', true)))));
/** Whose a task is when it has no project: a member's own, or an agent's owners' and the agent's. The household's
 * own task has nobody of that kind. */
const taskOwner: Rule = first([
  [equal('ownerKind', 'member'), self('owner')],
  [equal('ownerKind', 'agent'), ownsAgent('owner')],
], never);
/** A task shares by project first. Without a project it is its owner's: a member's own, or an agent's owners'. */
const task: Rule = any(householdOwner, first([[set('project'), inProject('project')]], taskOwner));
/** Who may move a task to another project, or out of every project. The row is the task's labels as they
 * are now, with `to`: the project it would go to, or null for none.
 *
 * The mover must be able to act on the task where it is (rule `task`), and must be someone who could have
 * filed it where it is going:
 *  - into a project: a member or agent on that project, or a household owner;
 *  - out of every project, where it becomes its owner's alone: that owner (`taskOwner`), or a household owner.
 * So moving a task shows it to nobody the mover could not already have shown it to by filing it there
 * themselves. Being in the destination is not enough to pull a task in, and being in the task's project is
 * not enough to push it somewhere else, or to make it private to its owner.
 *
 * That `to` names a project in use is asked beside this rule, as it is for a new task's project
 * (apps/tasks.ts, `taskProjectRefusal`): a removed project is nobody's destination, a household owner's included. */
const moveTask: Rule = all(task, any(householdOwner, first([[set('to'), inProject('to')]], taskOwner)));
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
/** Who may answer an inbox item: the person it is addressed to, and nobody on their behalf. This is
 * narrower than `recipient` on purpose: a household owner may address something to another member, and
 * set how loudly it arrives, but does not answer for them. The read side's "can answer" and every door
 * that records an answer ask this one rule. */
const answers: Rule = all(equal('toKind', 'person'), self('to'));
/** Who may set how loudly an inbox item arrives: someone in the household who may address its recipient.
 * A body may also set it for the member it is working for, on that member's word in the chat: how loudly
 * that member's own mail arrives is theirs to say, and saying it to their agent is how they say it. */
const addressesRecipient: Rule = all(currentViewer, recipient);
const inboxVolume: Rule = any(addressesRecipient, { is: 'forItsMember', rule: addressesRecipient });
/** Who may end a job by hand (a reset of stuck work, a write-off): a household owner, or a member who has
 * the job's agent on their own list. Never an agent.
 *
 * This is decided on the job's agent alone and reads nothing, so it is wider than the jobs read rule on
 * purpose: a household owner may end a job of another member's private thread, which no list shows them
 * (rule `inTalk`). They must already know its id (from the worker's machine or a log), and the door
 * answers with nothing of the job but that it stopped. The household has to be able to stop work on its
 * own machines; it does not get to read the work to do so. */
const stopJob: Rule = all(viewerIs('member'), any(householdOwner, ownsAgent('agent')));
/** The agent a record names, acting for itself and in the household now: asking for a secret in its own
 * name, reading the state of its own request or of a secret handed to its own job. Asking grants nothing:
 * who answers a request is the household owners' (rule for `secretRequests`) or a secret rule they set. */
const agentItself: Rule = all(viewerIs('agent'), currentViewer, ownsAgent('agent'));
/** Who may ask for an agent to be let onto a project: the agent itself, for itself, or a household owner
 * for any agent. Another agent, and a member who is not a household owner, may not ask for it. Asking
 * grants nothing: a household owner allows the card, and only then is the agent on the project. No standing
 * approval rule answers such a card (shared-household-proposals.ts, `alwaysAsks`). */
const asksToJoin: Rule = any(agentItself, householdOwner);
/** Using a secret. Secrets are the household owners' (tableRules.secrets): no other member reads one, sets
 * one or answers for one. An agent uses a secret on a household owner's word, and that word comes two ways:
 *  - a standing answer: a secret rule, the household default, or a grant made for the agent and no one job;
 *  - an owner's own answer to a request for one job.
 * A standing answer is about the agent: a secret a household owner has said the agent may have is the
 * agent's to use, in its own work and in work it does for anyone. Whether the agent may do a piece of work
 * for a person is a separate question, and it is not asked through the secret (the owner's ruling,
 * 2026-11-17: "you have permission to have the key, the ask is different: can I perform this task for
 * allison"). So a rule or the household default answers a request from any of the agent's bodies.
 * A body whose member has left the household or lost the agent gets nothing (agentItself).
 *
 * The worker's own hand-off is asked for apart: a worker fetches the house's repository with the agent's
 * repository secret before any body runs (shared-secret-inputs.ts, the `repository` read), and what it is
 * granted for that serves no body. */
const usesSecretsOnStandingWord: Rule = agentItself;
export function standingSecretAnswerServes(v: Viewer, s: Sharing): boolean {
  return v.kind === 'agent' && holds(usesSecretsOnStandingWord, v, { agent: v.id, workingFor: v.workingFor ?? null }, s);
}
/** Who may ask for a model account to be signed in on a machine. A member asks for an account and a machine
 * they may act on: their own, or any as a household owner. A body asks on the word of the member its work
 * is for, with that member's reach and nobody else's: not its agent's other owners', not the household
 * owners'. Asking finishes nothing: the account's owner still has to sign in themselves. */
const signInAsker: Rule = all(ownedByMember('accountOwner'), ownedByMember('boxOwner'));
const asksSignIn: Rule = any(signInAsker, { is: 'forItsMember', rule: signInAsker });
/** A member in the household now, for what every member may do for themselves (their own preferences,
 * passkeys, browsers and devices). */
const currentMember: Rule = all(viewerIs('member'), currentViewer);
/** The notice of a person's own action ("Saved in Tasks"): the member it was written for, and nobody else.
 * Reading the notices and marking one read ask this one rule. */
const ownNotice: Rule = all(currentMember, self('member'));
/** A model account's name and how full it is, in one coarse word: anyone in the household now, since work
 * is placed by it and people are told why work waits. Everything else about an account is its member's
 * and the household owners' (ownedByMember('owner'), asked by the same read). */
const accountSummary: Rule = currentViewer;

export const rules = { labelled, conversation, inTalk, waitsOnReadable, reviewsReply, task, moveTask, asksToJoin, trigger, recipient, addressesRecipient, inboxVolume, answers, stopJob, agentItself, asksSignIn, currentMember, currentViewer, ownNotice, accountSummary,
  agentRoster, agentSetup, ownedByMember, householdOwner, project: any(householdOwner, inProject('id')) } as const;

/** The read rule of every table served by the shared query door, by schema key. */
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
  conversations: conversation,
  conversationPeople: seenWith('conversations', 'conversation'),
  turns: seenWith('conversations', 'conversation'),
  digests: seenWith('conversations', 'conversation'),
  conversationDays: seenWith('conversations', 'conversation'),
  findings: seenWith('conversations', 'conversation'),
  digestItems: seenWith('digests', 'digest'),
  // A job's title, brief and log tail are words of its conversation.
  jobs: inTalk,
  // An item is read as its labels say. One exception: an item addressed to a household owner is theirs
  // whatever labels it carries, which is how an owner is handed the approval card raised in someone else's
  // thread (only household owners answer those). The card is all they get of that thread.
  //
  // Being addressed is otherwise not enough, on purpose: a member who leaves a project stops reading the
  // questions put to them in it. So whoever files an item for a person must label it so that this rule
  // lets that person read it: with the labels of a record they read (apps/tasks.ts, `labels`), with a
  // conversation they read (shared-conversation-questions.ts, `ask`), or with the person themselves as
  // its member (a notice). A member label on anything else hides the item from the person it is for.
  inbox: all(any(all(householdOwner, equal('toKind', 'person'), self('to')), inTalk), waitsOnReadable),
  bridgeConnections: bridgeConnection,
  // How a household's bridges are set up, and who its outside people are, is the household owners'.
  bridgeChannelFilters: householdOwner, bridgeChannels: householdOwner, bridgePeople: householdOwner,
  // A received message is read with the conversation it went into. One that went into none (held or
  // dropped) is seen by household owners, who are the ones who can clear what held it; unless it is a
  // direct message, which is read as the conversation it would have joined: a linked member's own
  // one-to-one message by that member alone, any other by the owners of its connection's agent.
  bridgeIncoming: first([[set('conversation'), seenWith('conversations', 'conversation')],
    [all(equal('isDm', true), equal('groupDm', true)), seenWith('bridgeConnections', 'connection', agentOwners)],
    [all(equal('isDm', true), set('member')), self('member')],
    [equal('isDm', true), seenWith('bridgeConnections', 'connection', agentOwners)]], householdOwner),
  bridgeSends: seesSend,
  secrets: householdOwner, secretGrants: householdOwner, secretRequests: householdOwner, secretRules: householdOwner,
  secretRuleAgents: householdOwner, secretUses: householdOwner, secretChanges: householdOwner,
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
  timingDays: any(householdOwner, all(viewerIs('agent'), currentViewer)),
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
  // A body working for a member: `its` is that member while they are in the household. See Viewer.
  const bound = v.kind === 'agent' && v.workingFor !== undefined ? v.workingFor : undefined;
  const its = bound === undefined ? undefined : entry(s.members, bound);
  const text = (field: string) => { const value = row[field]; return typeof value === 'string' ? value : undefined; };
  const inside = (p: { members: string[]; agents: string[] } | undefined) => !!p && (v.kind === 'member' ? !!m && p.members.includes(v.id)
    : p.agents.includes(v.id) && (bound === undefined || !!its && (its.owner || p.members.includes(bound))));
  switch (rule.is) {
    case 'never': return false;
    case 'householdOwner': return !!m?.owner;
    case 'viewerIs': return v.kind === rule.kind;
    case 'currentViewer': return v.kind === 'member' ? !!m : !!s.agents?.includes(v.id) && (bound === undefined || !!its);
    case 'self': return !!m && text(rule.field) === v.id;
    case 'inProject': { const id = text(rule.field); return id !== undefined && inside(entry(s.projects, id)); }
    case 'ownsAgent': { const id = text(rule.field); return id !== undefined && (v.kind === 'agent' ? id === v.id && (bound === undefined || !!its?.agents.includes(v.id)) : !!m?.agents.includes(id)); }
    case 'sharesProjectWithAgent': { const id = text(rule.field); return id !== undefined && Object.values(s.projects).some(p => p.agents.includes(id) && inside(p)); }
    case 'names': { const id = text(rule.field); return id !== undefined && (rule.kind === 'member' ? !!entry(s.members, id) : !!s.agents?.includes(id)); }
    // A yes/no column reads as true or false through the schema and as 1 or 0 from SQL.
    case 'equal': { const value = row[rule.field] ?? null; return value === rule.value || typeof rule.value === 'boolean' && value === (rule.value ? 1 : 0); }
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
      return !!found && holds(rule.as ?? tableRules[rule.table], v, found, s, parent);
    }
    case 'forItsMember': return bound !== undefined && !!its?.agents.includes(v.id) && holds(rule.rule, { kind: 'member', id: bound }, row, s, parent);
  }
}

/** Is the viewer in the household now: a member who is not removed, or an agent that is not removed? */
export function inHousehold(v: Viewer, s: Sharing): boolean {
  return holds(currentViewer, v, {}, s);
}
/** Is this id a member, or an agent, that is in the household now? For a name a caller writes on a record. */
export function namesCurrent(kind: 'member' | 'agent', id: string, s: Sharing): boolean {
  return holds(names(kind, 'id'), { kind: 'member', id: '' }, { id }, s);
}
/** A current member whose role is owner. The role runs the household and sees its records. It does not by
 * itself direct an agent (directsAgent), and it does not read another member's conversation (conversation). */
export function isHouseholdOwner(v: Viewer, s: Sharing): boolean {
  return holds(householdOwner, v, {}, s);
}
/** Who may put an agent to work, pause it or schedule for it: a member with the agent on their own list,
 * or the agent itself. A full owner has every agent on their list. */
export function directsAgent(v: Viewer, agent: string, s: Sharing): boolean {
  return holds(ownsAgent('agent'), v, { agent }, s);
}

/** The members who have this agent on their own list now, in id order. A removed member is not among
 * them. The one reading of "who has the agent" for code that is not judging a viewer: where a machine
 * may run it, and who is told that it cannot run. */
export function membersWithAgent(agent: string, s: Sharing): string[] {
  return Object.keys(s.members).filter(id => s.members[id].agents.includes(agent)).sort();
}
/** The people an agent's own notices and troubles go to: the members who have it on their own list, or the
 * household's owners when nobody has it. In id order. The one reading of it: a notice the agent raises
 * (shared-notices.ts) and loom's own notice that the agent's mail got no job (runtime/jobs.ts) both ask. */
export function agentsPeople(agent: string, s: Sharing): string[] {
  const has = membersWithAgent(agent, s);
  return has.length ? has : Object.keys(s.members).filter(id => s.members[id].owner).sort();
}
/** May this machine be handed this agent's work? A machine is its owner's, and a removed member is nobody:
 * their machine runs nothing, whatever lists it was left on. Otherwise the agent must be in the household
 * and either
 *  - the machine lists the agent, and its owner has the agent or has lent the machine to it (`lent`); or
 *  - the machine takes any agent of its owner's (`hostsAny`), and its owner has this one.
 * `listed` is the machine's own entry for the agent, when it has one. */
export function machineMayHost(machine: { owner: string; hostsAny: boolean }, listed: { lent: boolean } | undefined, agent: string, s: Sharing): boolean {
  const owner = entry(s.members, machine.owner);
  if (!owner || !s.agents?.includes(agent)) return false;
  const has = owner.agents.includes(agent);
  return listed ? has || listed.lent : machine.hostsAny && has;
}

/** Nobody: the principal of work with no member behind it that is not the agent's own. It reads no rule. */
export const NOBODY = 'unknown';
/** Is this principal nobody? Empty, and an older card's `?`, are too. */
export const isNobody = (principal: string | null | undefined): boolean => !principal || principal === NOBODY || principal === '?';
/** The principal of a household change (`household.propose`): the member whose thread it was asked in, or the
 * household owner who filed it, or nobody. Never the agent's own account: a household change with no member
 * behind it always asks, from a terminal and from a lane alike. */
export const householdChangePrincipal = (member: string | null | undefined, filedBy: string | undefined): string => member ?? filedBy ?? NOBODY;
/** The kinds of card the agent's own work reads standing rules for: its own account is for merging and for
 * commands. For every other kind (a household setting, a dangerous action) it reads none, by any door. */
const OWN_WORK_KINDS: readonly string[] = ['merge', 'command'];
/** The beginning of the principal of an agent's own work: `agent:<id>`, which no member's id can be. */
export const OWN_WORK = 'agent:';
/** Whose standing approval rules answer for a piece of an agent's work.
 *
 * A standing rule has a `person`. A rule with none is the household's own: a household owner's answer, given
 * ahead of time, for work done for a household owner. A rule that names a person answers for that person's
 * work and nobody else's. Every piece of work has a principal, recorded on its card (`acting_for`):
 *  - work for a member (their own thread, their trigger): that member;
 *  - the agent's own work, done for no member: a terminal session, or a lane (a `wake` conversation with no
 *    member). Written `agent:<id>`, which no member's id can be;
 *  - anything else for no member (a room on a bridge, a handoff with no member): `unknown`. People outside
 *    the household talk to an agent in a shared place; what is asked there is nobody's account.
 * A handoff carries the member it was opened for (core/conversations/handoff.ts), so work handed on for a
 * person is still that person's: the first case.
 * `workPrincipal` names the principal; `rulesPerson` says which rules it reads. */
export function workPrincipal(agent: string, where: { member: string | null; venue: string } | undefined): string {
  return where?.member ?? (where === undefined || where.venue === 'wake' ? OWN_WORK + agent : NOBODY);
}
/** The `person` a rule of this kind must carry to answer for this principal: '' for the household's own rules,
 * a member's id for rules naming them, or nothing when no standing rule answers and the card always asks.
 *  - A member who is a household owner reads the household's own rules. Any other member reads only rules
 *    that name them: an owner's rule with no person is never read for their work.
 *  - The agent's own work reads the household's own rules, as a household owner's work does, while the agent
 *    is in the household and some current household owner has it on their own list. An agent that only
 *    members who are not owners have reads none: otherwise such a member would get, through the agent's lane
 *    or terminal, an answer no rule gives their own work.
 *    And only for merges and commands (`OWN_WORK_KINDS`): for any other kind it reads none.
 *  - Someone removed, and nobody, read none. */
export function rulesPerson(principal: string, kind: string, s: Sharing): string | undefined {
  if (isNobody(principal)) return undefined;
  if (principal.startsWith(OWN_WORK)) {
    if (!OWN_WORK_KINDS.includes(kind)) return undefined;
    const agent = principal.slice(OWN_WORK.length);
    return s.agents?.includes(agent) && membersWithAgent(agent, s).some(id => s.members[id].owner) ? '' : undefined;
  }
  const member = entry(s.members, principal);
  return member ? member.owner ? '' : principal : undefined;
}

/** Scheduled work: who may set a trigger, whose work its firing is, and who may fire it by hand.
 *
 * A trigger records who set it (`ownerKind`, `owner`) and may name a recipient (`toKind`, `to`). The agent
 * it puts to work is its agent recipient, or, with no recipient, the agent whose own operation it is.
 *
 * Whose work a firing is follows who set the trigger, as every other piece of work follows who asked:
 *  - A trigger an agent set for itself (in a terminal session, a job for no member, or work for a
 *    household owner), and one a household owner set, is the agent's own. It fires as the whole agent.
 *  - A trigger set by a member who is not a household owner, or by a body doing that member's private
 *    work, is that member's direction. It is recorded as theirs (`ownerKind` member, `owner` them; triggerAsSet), and
 *    each firing is private work for them: the body it starts reaches no further than they do
 *    (Viewer.workingFor), so it reads no project they are not in and is served no standing answer about
 *    a secret. The member is read from the trigger when it fires and judged on the facts of that moment:
 *    one who has since become a household owner is not narrowed, one who has stopped being one is, and
 *    for one who has left or lost the agent the firing fails (mayRunPrivateWork).
 * Such a member's trigger can only send the agent words (an inbox target). An operation target (the
 * sweep) gathers records by the agent's whole reach, so it is not theirs to schedule, and a stored one
 * does not fire. */
export interface TriggerFacts { ownerKind: 'member' | 'agent' | 'household'; owner?: string | null; targetKind: 'operation' | 'inbox';
  toKind?: 'person' | 'agent' | null; to?: string | null; project?: string | null }
/** The agent a trigger puts to work, if it does. */
export const triggerAgent = (t: Pick<TriggerFacts, 'ownerKind' | 'owner' | 'toKind' | 'to'>): string | null =>
  t.toKind === 'agent' ? t.to ?? null : !t.toKind && t.ownerKind === 'agent' ? t.owner ?? null : null;
/** The member whose direction a trigger for an agent is when this viewer sets it: a member who is not a
 * household owner, or the member such a body is working for. Nobody for anyone else. */
export function triggerSetFor(v: Viewer, s: Sharing): string | undefined {
  const member = v.kind === 'member' ? v.id : v.kind === 'agent' ? v.workingFor : undefined;
  return member === undefined || entry(s.members, member)?.owner ? undefined : member;
}
/** A new trigger as it is recorded when this viewer sets it. A request that names an agent as the owner of
 * a trigger that puts an agent to work is how an agent's own trigger is written; set by or for a member
 * who is not a household owner, it is recorded as that member's instead. So a body asks the same way
 * whoever it works for, and what it is given is decided here. Any other owner is taken as written and
 * judged by maySetTrigger. */
export function triggerAsSet<T extends TriggerFacts>(v: Viewer, t: T, s: Sharing): T {
  const member = triggerSetFor(v, s);
  return member !== undefined && t.ownerKind === 'agent' && triggerAgent(t) !== null ? { ...t, ownerKind: 'member', owner: member } : t;
}
/** The member a firing of this trigger is private work for, or nobody when it is the agent's own. */
export function triggerWorksFor(t: Pick<TriggerFacts, 'ownerKind' | 'owner' | 'toKind' | 'to'>, s: Sharing): string | undefined {
  return t.toKind === 'agent' && t.ownerKind === 'member' && t.owner && !entry(s.members, t.owner)?.owner ? t.owner : undefined;
}
/** Who may set a trigger, and change the words and times of one that is set (the same question, asked of
 * the stored trigger). The viewer must be in the household now and:
 *  - have authored it: a household owner authors any; an agent, and a member who has it, authors the
 *    agent's own; a member authors their own. Where triggerSetFor names a member, a trigger that puts an
 *    agent to work is authored only as that member's, with an inbox target: such a viewer neither sets
 *    nor rewords the agent's own trigger, whose words run with the agent's whole reach;
 *  - be in its project, if it has one;
 *  - may address its recipient (rule `recipient`: an agent by whoever directs it, a person by themselves
 *    or a household owner). With no recipient it is a household owner's, or the agent's own operation. */
export function maySetTrigger(v: Viewer, t: TriggerFacts, s: Sharing): boolean {
  if (!inHousehold(v, s)) return false;
  const owner = isHouseholdOwner(v, s), member = triggerSetFor(v, s), agent = triggerAgent(t);
  const own = t.ownerKind === 'agent' && !!t.owner && holds(recipient, v, { toKind: 'agent', to: t.owner }, s);
  const authored = member !== undefined && agent !== null ? t.ownerKind === 'member' && t.owner === member && t.targetKind === 'inbox'
    : owner || own || t.ownerKind === 'member' && v.kind === 'member' && t.owner === v.id;
  if (!authored || t.project && !(Object.hasOwn(s.projects, t.project) && holds(rules.project, v, { id: t.project }, s))) return false;
  return t.toKind && t.to ? holds(recipient, v, { toKind: t.toKind, to: t.to }, s) : owner || own;
}
/** Where a body works limits what it may schedule. A **shared place** is a Discord or Slack conversation
 * that is not one member's own: a channel, a thread, a group direct message, a direct message from
 * somebody who is no member. Its body works with whoever is in the room: the people behind its mail, and
 * the tools a body is not given when one of them is a guest. A trigger it set for its agent's own wake
 * would later run words chosen there without any of that. So a shared place's body may set, reword, stop,
 * start and run only a trigger whose firing comes back into that same conversation (`triggers.conversation`),
 * as a job on its asker's word (src/shared-place-triggers.ts). A body in one member's own thread or direct
 * message is not in a shared place: maySetTrigger decides for it, as for a person and for an agent's own
 * session. Beside where it works, on whose word a job works limits it everywhere (sharedPlaceRefusal): a
 * job with anybody but owners behind it schedules only into its own bridge conversation. */
export const isSharedPlace = (conversation: { venue: string; member: string | null }): boolean =>
  (conversation.venue === 'discord' || conversation.venue === 'slack') && conversation.member === null;
export const SHARED_PLACE_SCHEDULE_REFUSAL = 'A body working in a shared place cannot schedule work: ask in your own thread, or have an owner schedule it.';
/** Whether the body of a job in this conversation may set, reword, stop, start or run this trigger, as far as where it works goes: anywhere but a shared place, and there only a trigger that names its own conversation. */
export function maySchedule(conversation: { id?: string; venue: string; member: string | null }, trigger: { conversation?: string | null }): boolean {
  return !isSharedPlace(conversation) || (!!conversation.id && trigger.conversation === conversation.id);
}
/** On whose word a body is working, by least reach (shared-place-mail.ts, jobWord): the agent's own work,
 * with no person behind it; `owners`, when everybody behind it is a household owner or a member who has
 * the agent; `others`, when anybody else is: a guest, an unlinked coworker, a member without the agent. */
export type Woke = 'own' | 'owners' | 'others';
/** A person mail is sent on the word of: a household member, or an outside account by the key loom knows it by. */
export type OnWord = { kind: 'member' | 'outside'; id: string };
/** Who asked for a trigger that names a conversation: such a person, or the agent itself. */
export type Asker = OnWord | { kind: 'agent'; id: string };
/** Who may hand a note to the agent's body where, and post there as the agent's own work. The one statement.
 * The agent's own work and a body working for owners: any conversation of that agent, and any channel it
 * has a rule for. A body working for anybody else: only the one channel its own channel's rule names as
 * where it reports (`reportsTo`); with none named, nowhere. A stranger wakes no body and so hands nothing.
 * By the person and not by the venue: the same person has the same reach on Discord and on Slack. */
export function mayHandTo(woke: Woke, target: string, reportsTo: string | null): boolean {
  return woke !== 'others' || (reportsTo !== null && target === reportsTo);
}
/** Who may fire a trigger by hand, or turn a stopped one back on: someone who reads it (rule `trigger`,
 * which the caller checks on the stored row) and who may put its agent to work (directsAgent), as for
 * pausing the agent and setting the trigger. Being in the trigger's project shows it and lets a person
 * stop it; it does not start an agent they do not direct. One that puts no agent to work is started by
 * whoever may address its recipient, or with no recipient by a household owner. */
export function mayStartTrigger(v: Viewer, t: Pick<TriggerFacts, 'ownerKind' | 'owner' | 'toKind' | 'to'>, s: Sharing): boolean {
  if (!inHousehold(v, s)) return false;
  const agent = triggerAgent(t);
  if (agent !== null) return holds(recipient, v, { toKind: 'agent', to: agent }, s);
  return t.toKind && t.to ? holds(recipient, v, { toKind: t.toKind, to: t.to }, s) : isHouseholdOwner(v, s);
}

export function maySee(v: Viewer, r: RecordScope, s: Sharing): boolean {
  if (isInternalCaller(v)) return true;
  // One of loom's own parts is known by the object it was handed (core/internal.ts), never by a name: a
  // caller that only says it is a service reads nothing.
  if (v.kind === 'service') return false;
  // A worker is given its jobs by Runtime, on proof of assignment checked at that door; it reads no record here.
  if (v.kind === 'runner') return false;
  // A task is labelled by its owner, not by member and agent columns; it answers to the tasks rule.
  const seen = r.type === 'task'
    ? holds(task, v, { project: r.project, ownerKind: r.member !== undefined ? 'member' : r.agent !== undefined ? 'agent' : 'household', owner: r.member ?? r.agent }, s)
    : r.type === 'conversation' ? holds(conversation, v, { member: r.member, project: r.project, agent: r.agent, direct: r.direct ?? false }, s)
    : holds(labelled, v, { member: r.member, project: r.project, agent: r.agent }, s);
  // Knowledge is the household's shared file store: every agent reads it. Viewer identity is supplied by
  // authentication, including an agent terminal session without a job.
  return seen || r.type === 'knowledge' && v.kind === 'agent' && r.member === undefined && r.agent === undefined;
}
export function mayAct(v: Viewer, r: RecordScope, s: Sharing, action: Action = 'act'): boolean {
  if (isInternalCaller(v)) return true;
  if (!maySee(v, r, s)) return false;
  if (action === 'household') return isHouseholdOwner(v, s);
  // Giving an agent work and changing its setup belong to the members who own it.
  if (action === 'give-work' || action === 'agent-setup') return v.kind === 'member' && !!r.agent && directsAgent(v, r.agent, s);
  return true;
}
/** New fields must be visible separately; project access cannot smuggle in an agent. */
export function mayCreate(v: Viewer, r: RecordScope, s: Sharing): boolean {
  if (isInternalCaller(v)) return true;
  if (r.member !== undefined && (v.kind !== 'member' || r.member !== v.id)) return false;
  return mayAct(v, r, s)
    && (r.project === undefined || maySee(v, { project: r.project }, s))
    && (r.agent === undefined || maySee(v, { agent: r.agent }, s));
}

/** A member named by a request, asked about as a reader: "could the person this is addressed to see
 * it?". A door asks this so that nothing is sent to someone about a record they may not read. The answer
 * may only ever narrow what the caller is allowed. It is never the caller's own authority: nothing is
 * granted, read or done as this viewer, and a viewer for any other purpose comes from authentication. */
export const addressee = (member: string): Viewer => ({ kind: 'member', id: member });

/** May a question about a task be put to this person, or stay with them: only if they could read the task
 * themselves, by the tasks rule, on the labels given. Asked at three doors with the one answer: when a
 * question is put on a task (shared-task-access.ts), when a body puts one to a person about a task from a
 * conversation (shared-conversation-questions.ts), both on the task's labels now; and when a task that
 * carries an unanswered question would move, on its labels as they would be. So nobody is asked to do something on a project they are not on, and no move leaves
 * a question with someone who can no longer see what it is about. A household owner reads every project,
 * so one can always be asked. Nothing is granted or read as this person (see `addressee`). */
export function mayBeAskedAbout(member: string, taskLabels: Row, s: Sharing): boolean {
  return holds(task, addressee(member), taskLabels, s);
}

/** May one agent hand work to another in the open, outside any member's private thread? Both must be
 * agents of the household now. In a project, both must be in it. Outside one, some current member must
 * have both on their own list. A removed member is nobody here too: the agents left on their list are
 * not thereby each other's peers. */
export function mayHandOff(from: string, to: string, project: string | null, s: Sharing): boolean {
  if (!s.agents?.includes(from) || !s.agents.includes(to)) return false;
  if (project !== null) { const found = entry(s.projects, project); return !!found && found.agents.includes(from) && found.agents.includes(to); }
  return Object.values(s.members).some(member => member.agents.includes(from) && member.agents.includes(to));
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
