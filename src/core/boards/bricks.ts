/** The brick catalogue: every kind of thing a board can show (docs/specs/boards.md, "The first bricks").
 * A brick is a name, a parameter schema and its actions. The agent sends these and nothing else; the page
 * draws them.
 *
 * Adding a brick (docs/specs/boards.md, "Adding a brick") touches:
 *   1. its definition, src/core/boards/bricks/<name>.ts (default export, made with `brick` from bricks/kit.ts),
 *      and its pins beside it, src/core/boards/bricks/<name>.test.ts;
 *   2. ONE line here: its import, and its place in `bricks` below, which is the catalogue's order and the only
 *      place that order is stated;
 *   3. its page module web/src/boards/bricks-<name>.tsx and page test web/src/boards/bricks-<name>.test.tsx;
 *   4. ONE line in the page's registry, web/src/boards/bricks.tsx;
 *   5. its rows in the spec's two tables.
 * No other list of bricks exists: the suites read this catalogue and the registry (src/core/boards/catalogue.test.ts). */
import { z } from 'zod';
import type { Brick } from './bricks/kit.js';
import activity from './bricks/activity.js';
import agent from './bricks/agent.js';
import agents from './bricks/agents.js';
import approval from './bricks/approval.js';
import approvals from './bricks/approvals.js';
import backlog from './bricks/backlog.js';
import comments from './bricks/comments.js';
import inbox from './bricks/inbox.js';
import knowledge from './bricks/knowledge.js';
import knowledgePage from './bricks/knowledge-page.js';
import lanes from './bricks/lanes.js';
import newTicket from './bricks/new-ticket.js';
import people from './bricks/people.js';
import person from './bricks/person.js';
import project from './bricks/project.js';
import pull from './bricks/pull.js';
import question from './bricks/question.js';
import repository from './bricks/repository.js';
import session from './bricks/session.js';
import threads from './bricks/threads.js';
import ticket from './bricks/ticket.js';
import trend from './bricks/trend.js';
import unfiled from './bricks/unfiled.js';
import tempo from './bricks/tempo.js';
import trigger from './bricks/trigger.js';
import account from './bricks/account.js';
import appearance from './bricks/appearance.js';
import secrets from './bricks/secrets.js';
import machines from './bricks/machines.js';
import subscriptions from './bricks/subscriptions.js';
import usage from './bricks/usage.js';
import bridges from './bricks/bridges.js';
import household from './bricks/household.js';
import sharing from './bricks/sharing.js';
import projects from './bricks/projects.js';

export { recordKinds, type Brick, type RecordKind } from './bricks/kit.js';
export { questionAnswers } from './bricks/question.js';
export { inboxFolders } from './bricks/inbox.js';
export { ticketPriorities } from './bricks/backlog.js';
export { threadScopes } from './bricks/threads.js';
export { knowledgeAnnotations, knowledgeLists, knowledgePageRef, knowledgeTopicRef, peopleFolders, triggerRef } from './refs.js';

/** The catalogue, in the order `bricks.catalogue` lists it to an agent. A new brick goes at the end. */
export const bricks: readonly Brick[] = [
  project, lanes, trend, ticket, comments, pull, repository, person, agent, question, approval, session,
  inbox, approvals, newTicket, backlog, unfiled, knowledgePage, knowledge, people, activity, threads, agents,
  tempo, trigger,
  account, appearance, secrets,
  machines, subscriptions, usage, bridges, household, sharing,
  projects,
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
