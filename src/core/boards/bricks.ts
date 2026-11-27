/** The brick catalogue: every kind of thing a board can show (docs/specs/boards.md, "The first bricks").
 * A brick is a name, a parameter schema and its actions. The agent sends these and nothing else; the page
 * draws them. A new brick is added here, with its forms on the page, and nowhere else. */
import { z } from 'zod';
import { inbox } from '../data/schema.js';
import { taskLinkType } from '../../apps/tasks.js';
import { knowledgeAnnotations, knowledgeLists, knowledgePageRef, knowledgeTopicRef, peopleFolders } from './refs.js';

/** Record references are checked for shape only. Whether the record exists, and whether the member looking
 * may read it, is decided by the read that draws the brick. The shape is an id's: ASCII letters, digits and
 * the few marks loom's ids use, so a reference cannot carry a sentence, a look-alike letter or blank space
 * onto a board. The page shows a reference only in its small monospace line, never as a heading. */
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/);
const ticket = z.string().regex(/^t-[1-9]\d*$/);
const person = z.string().regex(/^(member|contact):[a-z0-9][a-z0-9._-]{0,99}$/);
/** A change's id as loom writes it (src/apps/changes.ts): `github:`, the repository as owner/repo in lower case,
 * `#` and the pull request's number. `#` is in no other reference. */
const change = z.string().max(120).regex(/^github:[a-z0-9._-]+\/[a-z0-9._-]+#[1-9]\d*$/);
/** What inbox.answer takes as its `answer` from a member's hand (web/src/pieces/inbox-view/model.ts, InboxAnswer).
 * `words` says the member answered in words; the words themselves go to inbox.answer and never to the board. */
export const questionAnswers = ['yes', 'no', 'words', 'done', 'dismiss'] as const;
/** The Inbox's fixed folders, as the desktop lists them (web/src/pieces/inbox-view/model.ts, folderWords and
 * errorsFolder). The first holds what waits on the member. A folder per agent is not one of them. */
export const inboxFolders = ['needs', 'alerts', 'answered', 'fyi', 'all', 'errors'] as const;

/** A ticket's priorities, 0 to 4 (src/apps/tasks.ts, `summary.priority`), as the words a detail may hold. The
 * suite holds them to that schema. The two ways one ticket depends on another are that file's `taskLinkType`. */
export const ticketPriorities = ['0', '1', '2', '3', '4'] as const;

export { knowledgeAnnotations, knowledgeLists, knowledgePageRef, knowledgeTopicRef, peopleFolders } from './refs.js';

/** Comms' two folders of a member's threads (web/src/pieces/comms-view, "Threads" and "Archived"). */
export const threadScopes = ['open', 'archived'] as const;

export const recordKinds = [
  'project', 'ticket', 'change', 'repository', 'person', 'agent', 'inbox item', 'approval', 'session',
  'knowledge page', 'knowledge topic',
] as const;
export type RecordKind = (typeof recordKinds)[number];

export interface Brick {
  name: string;
  shows: string;
  /** Strict: an unknown parameter is refused. Every parameter that is not a record reference has a default. */
  params: z.ZodObject;
  /** The parameters that are record references, and the kind of record each names. Only these can be left
   * open in a blueprint. */
  references: Record<string, RecordKind>;
  /** The parameter a chip's link key fills, for a brick that can be written in words. */
  linkKey?: string;
  /** Whether it has a primary form. Every brick has the small forms; only some can be the big one. */
  big: boolean;
  /** The changes to its own record the page marks it for, by name. The page raises these; nothing is stored. */
  flags: readonly string[];
  /** Action name → the schema of its detail, which holds only choices and ids. */
  actions: Record<string, { detail: z.ZodObject; operation: string }>;
}

const none = z.object({}).strict();
const brick = (b: Omit<Brick, 'big' | 'flags'> & Partial<Pick<Brick, 'big' | 'flags'>>): Brick => ({ big: false, flags: [], ...b });

export const bricks: readonly Brick[] = [
  brick({ name: 'project', big: true, shows: "A project: its goal, where it stands, the members and agents on it and, when big, what each agent calls it and its repositories.",
    params: z.object({ project: ref }).strict(), references: { project: 'project' }, linkKey: 'project', actions: {} }),
  brick({ name: 'lanes', big: true, shows: "A project's active tickets in lanes: working, verifying, waiting, each with who has it, its priority and why it waits. When big, how many questions wait on the member and whether each agent takes new tickets there.",
    params: z.object({ project: ref }).strict(), references: { project: 'project' },
    // The desktop's pause and resume of an agent's new claims in the project. Which agent is not told.
    actions: { pause: { operation: 'work.setProjectClaims', detail: none }, resume: { operation: 'work.setProjectClaims', detail: none } } }),
  brick({ name: 'trend', big: true, shows: 'Tickets opened and closed per day in a project.',
    params: z.object({ project: ref, days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }).strict(),
    references: { project: 'project' }, actions: {} }),
  brick({ name: 'ticket', big: true, flags: ['closed', 'reopened'], shows: 'One ticket: goal, why, done when, status, priority, who has it, who filed it, its links to other tickets and, when big, its edit and link forms and the sessions handed off for it (those whose conversation.handoff named it in tickets).',
    params: z.object({ ticket }).strict(), references: { ticket: 'ticket' }, linkKey: 'ticket',
    // What tasks.command offers a member on one ticket. A close takes a reason in words; the words go to the
    // ticket and never to the board, so every detail here is empty.
    actions: {
      claim: { operation: 'tasks.command', detail: none },
      unclaim: { operation: 'tasks.command', detail: none },
      close: { operation: 'tasks.command', detail: none },
      reopen: { operation: 'tasks.command', detail: none },
      // The desktop's Edit, Parent and Blocked by forms. What was typed goes to the ticket; a link says only its kind.
      edit: { operation: 'tasks.command', detail: none },
      link: { operation: 'tasks.command', detail: z.object({ type: taskLinkType }).strict() },
      unlink: { operation: 'tasks.command', detail: z.object({ type: taskLinkType }).strict() },
    } }),
  brick({ name: 'comments', big: true, flags: ['comment'], shows: "A ticket's comments, newest first.",
    params: z.object({ ticket }).strict(), references: { ticket: 'ticket' },
    actions: { comment: { operation: 'tasks.command', detail: none } } }),
  // A merge is answered through its approval (approvals.answer, changes.answer), with that card's safeguards,
  // on the desktop. This brick has no action.
  brick({ name: 'pull', big: true, flags: ['check failed', 'merged', 'closed'], shows: 'One pull request: state, checks, review, who it waits on, its tickets. Its id is github:owner/repo#number.',
    params: z.object({ change }).strict(), references: { change: 'change' }, linkKey: 'change', actions: {} }),
  brick({ name: 'repository', big: true, shows: 'A repository and its pull requests, in one project or across all.',
    params: z.object({ repository: ref, project: ref.optional() }).strict(),
    references: { repository: 'repository', project: 'project' }, linkKey: 'repository', actions: {} }),
  brick({ name: 'person', big: true, shows: "A person: who they are, where they are reached, the agents that know them and, when big, those agents' notes the member may read, their projects and conversations. A member also has their open tickets.",
    params: z.object({ person }).strict(), references: { person: 'person' }, linkKey: 'person', actions: {} }),
  // A running job is stopped as the session brick stops one, after asking. Nothing else about an agent is a member's to change here.
  brick({ name: 'agent', big: true, flags: ['waiting on you'],
    shows: 'An agent: who it is, its state and its own report, what it is doing now, its running and recent jobs (each a session chip where it has a conversation; when big, its last thirty), its open tickets, and the way to its conversation.',
    params: z.object({ agent: ref }).strict(), references: { agent: 'agent' }, linkKey: 'agent',
    actions: { stop: { operation: 'runtime.jobStop', detail: none } } }),
  brick({ name: 'question', shows: 'A question waiting on the member, answered from the board.',
    params: z.object({ item: ref }).strict(), references: { item: 'inbox item' }, linkKey: 'item',
    actions: { answer: { operation: 'inbox.answer', detail: z.object({ answer: z.enum(questionAnswers) }).strict() },
      // How loudly the item is shown, where the member may set it: the column's own choices.
      volume: { operation: 'inbox.volume', detail: z.object({ volume: z.enum(inbox.volume.enumValues) }).strict() } } }),
  // Answered from the board with the desktop's own safeguards, from the code the desktop's card runs
  // (web/src/pieces/approval-view/answering.ts): who may answer, the reviewed version of a household change, the
  // second yes for a dangerous one. A reason for denying goes to approvals.answer and never to the board.
  brick({ name: 'approval', shows: 'An approval request: what it allows, why, for which agent, its state. A member the household lets answer allows or denies it from the board.',
    params: z.object({ approval: ref }).strict(), references: { approval: 'approval' }, linkKey: 'approval',
    // `always` is the desktop's standing answer for a merge: asked about first, then sent by approvals.always.
    actions: { approve: { operation: 'approvals.answer', detail: none }, refuse: { operation: 'approvals.answer', detail: none },
      always: { operation: 'approvals.always', detail: none } } }),
  // One piece of agent work with its own conversation: what the agent handed off, or other work the member may read.
  brick({ name: 'session', big: true, flags: ['finished', 'failed', 'stopped'],
    shows: 'A session of agent work: what it was asked, where it stands, what it has used and, when big, the steps it reports as it works. Its conversation id is what conversation.handoff returns.',
    params: z.object({ session: ref }).strict(), references: { session: 'session' }, linkKey: 'session',
    actions: { stop: { operation: 'runtime.jobStop', detail: none } } }),
  // The two lists of what waits on the member. Neither answers anything: a row's chip places the brick that does.
  brick({ name: 'inbox', big: true, flags: ['new item'],
    shows: "The member's Inbox as a list, one folder at a time: each item's words, who asked, when and its state, and every folder's count. needs is what waits on the member. An item is answered in its question brick.",
    params: z.object({ folder: z.enum(inboxFolders).default('needs') }).strict(), references: {},
    actions: { read: { operation: 'inbox.read', detail: none }, dismissResult: { operation: 'inbox.dismissResult', detail: none } } }),
  brick({ name: 'approvals', big: true, flags: ['new approval'],
    shows: 'The list of approval requests the member may read: those pending, or those answered with their outcome. A request is answered in its approval brick.',
    params: z.object({ state: z.enum(['pending', 'answered']).default('pending') }).strict(), references: {}, actions: {} }),
  // Work, written from the board. Each sends the desktop's own tasks.command; what was typed goes to the ticket.
  brick({ name: 'new-ticket', big: true, shows: 'A form to file a new ticket in a project.',
    params: z.object({ project: ref }).strict(), references: { project: 'project' },
    actions: { create: { operation: 'tasks.command', detail: none } } }),
  brick({ name: 'backlog', big: true, shows: "A project's open tickets that are in no lane, most urgent first. When big, a ticket's priority is set from it.",
    params: z.object({ project: ref }).strict(), references: { project: 'project' },
    actions: { priority: { operation: 'tasks.command', detail: z.object({ priority: z.enum(ticketPriorities) }).strict() } } }),
  brick({ name: 'unfiled', big: true, shows: 'The tickets under no project. When big, one is filed into a project from it.',
    params: z.object({}).strict(), references: {},
    actions: { project: { operation: 'tasks.command', detail: none } } }),
  // What Knowledge's reader offers a member on one page. An annotation's words go to mind.knowledgeAnnotate and
  // never to the board; the board is told which kind was chosen.
  brick({ name: 'knowledge-page', big: true,
    shows: 'One shared knowledge page: its title, topic, words, sources, when it was last checked and whether it is due a check. Its id is the page slug knowledge_recall gives.',
    params: z.object({ page: z.string().regex(knowledgePageRef) }).strict(), references: { page: 'knowledge page' }, linkKey: 'page',
    actions: {
      verify: { operation: 'mind.knowledgeVerify', detail: none },
      recheck: { operation: 'mind.knowledgeRecheck', detail: none },
      annotate: { operation: 'mind.knowledgeAnnotate', detail: z.object({ kind: z.enum(knowledgeAnnotations) }).strict() },
    } }),
  // Knowledge's list. What the member searches for is typed inside the drawn brick and is no parameter.
  brick({ name: 'knowledge', big: true,
    shows: 'The shared knowledge pages, each a chip for its page: all of them, those verified lately or those due a check, in one topic or in every topic. When big the member can search them and add a page.',
    params: z.object({ show: z.enum(knowledgeLists).default('all'), domain: z.string().regex(knowledgeTopicRef).optional() }).strict(),
    references: { domain: 'knowledge topic' }, actions: { add: { operation: 'mind.knowledgeAdd', detail: none } } }),
  // People's directory. What the member searches for is typed inside the drawn brick and is no parameter.
  brick({ name: 'people', big: true,
    shows: 'The directory of people and agents the member may read, each a chip for its person or agent: everyone, only people or only agents. When big the member can search it and add a person.',
    params: z.object({ folder: z.enum(peopleFolders).default('all') }).strict(), references: {},
    actions: { add: { operation: 'mind.personAdd', detail: none } } }),
  // Activity's timeline, read-only. The windows Activity reads are three days each; the page keeps the newest `days`.
  brick({ name: 'activity', big: true,
    shows: "The household's timeline over the last day, 7 days or 30 days: what each agent did and where, newest first, with its tickets and pull requests as chips. When big the member can open an entry to read what was asked, what happened and what was decided.",
    params: z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(1) }).strict(), references: {}, actions: {} }),
  // The member's own conversations, read as the member looking: an agent names none of them and no member sees another's.
  brick({ name: 'threads', big: true,
    shows: "The member's conversations, as Comms lists them: each one's title and agent, whether the agent is working in it and whether a reply is unread, each a link that opens it. `scope` is open (the default) or archived.",
    params: z.object({ scope: z.enum(threadScopes).default('open') }).strict(), references: {}, actions: {} }),
  brick({ name: 'agents', shows: "The member's own agents as a roster: each one's name, its state and what it is doing now, each a chip that places its agent brick.",
    params: none, references: {}, actions: {} }),
];

const byName = new Map(bricks.map((b) => [b.name, b]));
export const brickNamed = (name: string) => byName.get(name);

/** Params with every default filled, keys in a fixed order: two placements are the same brick with the same
 * params exactly when these strings are equal. */
export function paramsKey(params: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

/** What `bricks.catalogue` returns: enough for an agent to choose and fill a brick. */
export function catalogue() {
  return bricks.map((b) => ({
    name: b.name,
    shows: b.shows,
    params: z.toJSONSchema(b.params, { io: 'input' }),
    references: b.references,
    linkKey: b.linkKey ?? null,
    canBeBig: b.big,
    flagsItselfFor: b.flags,
    actions: Object.fromEntries(Object.entries(b.actions).map(([name, a]) => [name, z.toJSONSchema(a.detail)])),
  }));
}
