/** The brick catalogue: every kind of thing a board can show (docs/specs/boards.md, "The first bricks").
 * A brick is a name, a parameter schema and its actions. The agent sends these and nothing else; the page
 * draws them. A new brick is added here, with its forms on the page, and nowhere else. */
import { z } from 'zod';

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

export const recordKinds = [
  'project', 'ticket', 'change', 'repository', 'person', 'agent', 'inbox item', 'approval', 'session',
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
  brick({ name: 'project', big: true, shows: "A project: its goal, where it stands, who is on it.",
    params: z.object({ project: ref }).strict(), references: { project: 'project' }, linkKey: 'project', actions: {} }),
  brick({ name: 'lanes', big: true, shows: "A project's active tickets in lanes: working, verifying, waiting.",
    params: z.object({ project: ref }).strict(), references: { project: 'project' }, actions: {} }),
  brick({ name: 'trend', big: true, shows: 'Tickets opened and closed per day in a project.',
    params: z.object({ project: ref, days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }).strict(),
    references: { project: 'project' }, actions: {} }),
  brick({ name: 'ticket', big: true, flags: ['closed', 'reopened'], shows: 'One ticket: goal, why, done when, status, who has it.',
    params: z.object({ ticket }).strict(), references: { ticket: 'ticket' }, linkKey: 'ticket',
    // What tasks.command offers a member on one ticket. A close takes a reason in words; the words go to the
    // ticket and never to the board, so every detail here is empty.
    actions: {
      claim: { operation: 'tasks.command', detail: none },
      unclaim: { operation: 'tasks.command', detail: none },
      close: { operation: 'tasks.command', detail: none },
      reopen: { operation: 'tasks.command', detail: none },
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
  brick({ name: 'person', shows: 'A person: who they are, where they are reached, their work.',
    params: z.object({ person }).strict(), references: { person: 'person' }, linkKey: 'person', actions: {} }),
  brick({ name: 'agent', shows: 'An agent: what it is and what it is working on.',
    params: z.object({ agent: ref }).strict(), references: { agent: 'agent' }, linkKey: 'agent', actions: {} }),
  brick({ name: 'question', shows: 'A question waiting on the member, answered from the board.',
    params: z.object({ item: ref }).strict(), references: { item: 'inbox item' }, linkKey: 'item',
    actions: { answer: { operation: 'inbox.answer', detail: z.object({ answer: z.enum(questionAnswers) }).strict() } } }),
  // Read-only on a board. approvals.answer is called only from the desktop's approval card, which holds its
  // safeguards (who may answer, the reviewed version of a household change, the second yes for a dangerous one).
  brick({ name: 'approval', shows: 'An approval request: what it allows, why, for which agent, its state. It is answered on the desktop, not here.',
    params: z.object({ approval: ref }).strict(), references: { approval: 'approval' }, linkKey: 'approval', actions: {} }),
  // One piece of agent work with its own conversation: what the agent handed off, or other work the member may read.
  brick({ name: 'session', big: true, flags: ['finished', 'failed', 'stopped'],
    shows: 'A session of agent work: what it was asked, where it stands, what it has used. Its conversation id is what conversation.handoff returns.',
    params: z.object({ session: ref }).strict(), references: { session: 'session' }, linkKey: 'session',
    actions: { stop: { operation: 'runtime.jobStop', detail: none } } }),
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
