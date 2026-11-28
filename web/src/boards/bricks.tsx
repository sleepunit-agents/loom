/** The page's registry of bricks (docs/specs/boards.md, "The first bricks"): for each brick, what the page must
 * know at once to lay a board out and head a placement (`fits`, `title`, `sub`), and a body that is loaded the
 * first time a board shows that brick. A brick reads its own data, live, as the member looking, and takes only the
 * parameters the server already checked. Three forms are drawn by Body; the chip and the hover are the same words
 * in one line.
 *
 * Adding a brick (docs/specs/boards.md, "Adding a brick") is ONE line in `bricks` below, beside its module
 * ./bricks-<name>.tsx and its suite ./bricks-<name>.test.tsx. This file imports no brick's module: each is named
 * only inside its own `import()`, so its code and what it alone depends on stay out of the page's first script.
 * What bricks share is ./brick-kit.tsx. The suites read this registry and the server's catalogue
 * (src/core/boards/bricks.ts) and hold no list of their own (src/core/boards/catalogue.test.ts). */
import { lazy, type ComponentType } from 'react';
import type { Fits } from './layout';
import { words, type BodyProps, type Params } from './brick-kit';

export type { Act, BodyProps, Params, Place, Raise } from './brick-kit';
type Body = ComponentType<BodyProps>;
export interface BrickView {
  fits: Fits;
  /** Its name and what it is about, as words: the heading, the chip, the folded row. */
  title(params: Params): string;
  sub(params: Params): string;
  /** Drawn inside a Suspense boundary: until its module has arrived it is the boundary's one loading line. */
  Body: Body;
  /** Fetches the body's module, once. A body whose module is here already draws at once, with no loading line. */
  load(): Promise<unknown>;
}

const fit = (primary: [number, number, number, number], side: number): Fits => ({
  primary: { min: primary[0], ideal: primary[1], max: primary[2], height: primary[3] },
  side: { min: 260, ideal: 360, max: 420, height: side },
  compact: { min: 220, ideal: 320, max: 420, height: 84 },
});

/** A body that is fetched when it is first drawn. React's `lazy` takes a module that is already here without
 * suspending, so a brick shown a second time, or one the suites loaded first, never shows the loading line. */
function later(fetch: () => Promise<Body>): Pick<BrickView, 'Body' | 'load'> {
  let got: Body | undefined, asked: Promise<Body> | undefined;
  const load = () => (asked ??= fetch().then((body) => (got = body)));
  const here = (): PromiseLike<{ default: Body }> => ({ then: (done: (module: { default: Body }) => unknown) => done({ default: got! }) }) as PromiseLike<{ default: Body }>;
  return { load, Body: lazy(() => (got ? here() : load().then((body) => ({ default: body }))) as Promise<{ default: Body }>) };
}

/** A brick the server knows and this page does not draw yet. It says so; it never guesses. */
const NotDrawn = ({ params }: { params: Params }) => (
  <p className="text-muted-foreground">This page does not draw this brick yet. {Object.entries(params).map(([k, v]) => `${k}: ${words(v)}`).join(', ')}</p>
);
const unknown = (name: string): BrickView => ({ fits: fit([420, 640, 760, 260], 130), title: () => name, sub: () => '', Body: NotDrawn, load: async () => {} });

export const bricks: Record<string, BrickView> = {
  project: { fits: fit([440, 680, 820, 300], 230), title: () => 'Project', sub: (p) => words(p.project), ...later(() => import('./bricks-project').then((m) => m.Project)) },
  lanes: { fits: fit([520, 820, 980, 480], 330), title: () => 'Lanes', sub: (p) => words(p.project), ...later(() => import('./bricks-lanes').then((m) => m.Lanes)) },
  trend: { fits: fit([460, 720, 860, 360], 215), title: () => 'Opened and closed', sub: (p) => `${words(p.project)} · ${words(p.days)} days`, ...later(() => import('./bricks-trend').then((m) => m.Trend)) },
  ticket: { fits: fit([460, 700, 820, 380], 360), title: () => 'Ticket', sub: (p) => words(p.ticket), ...later(() => import('./bricks-ticket').then((m) => m.Ticket)) },
  person: { fits: fit([440, 680, 820, 460], 285), title: () => 'Person', sub: (p) => words(p.person), ...later(() => import('./bricks-person').then((m) => m.Person)) },
  agent: { fits: fit([440, 680, 820, 460], 340), title: () => 'Agent', sub: (p) => words(p.agent), ...later(() => import('./bricks-agent').then((m) => m.Agent)) },
  comments: { fits: fit([440, 680, 820, 420], 260), title: () => 'Comments', sub: (p) => words(p.ticket), ...later(() => import('./bricks-comments').then((m) => m.Comments)) },
  session: { fits: fit([440, 680, 820, 360], 215), title: () => 'Session', sub: (p) => words(p.session).slice(0, 11), ...later(() => import('./bricks-session').then((m) => m.Session)) },
  pull: { fits: fit([440, 680, 820, 380], 280), title: () => 'Pull request', sub: (p) => words(p.change), ...later(() => import('./bricks-pull').then((m) => m.Pull)) },
  repository: { fits: fit([440, 680, 820, 360], 260), title: () => 'Repository', sub: (p) => [words(p.repository), words(p.project)].filter(Boolean).join(' · '), ...later(() => import('./bricks-repository').then((m) => m.Repository)) },
  question: { fits: fit([420, 640, 760, 300], 315), title: () => 'Question', sub: (p) => words(p.item), ...later(() => import('./bricks-question').then((m) => m.Question)) },
  approval: { fits: fit([420, 640, 760, 300], 300), title: () => 'Approval', sub: (p) => words(p.approval), ...later(() => import('./bricks-approval').then((m) => m.Approval)) },
  inbox: { fits: fit([460, 700, 860, 480], 260), title: () => 'Inbox', sub: (p) => words(p.folder), ...later(() => import('./bricks-inbox').then((m) => m.Inbox)) },
  approvals: { fits: fit([460, 700, 860, 480], 260), title: () => 'Approvals', sub: (p) => words(p.state), ...later(() => import('./bricks-approvals').then((m) => m.Approvals)) },
  'new-ticket': { fits: fit([440, 680, 820, 520], 340), title: () => 'New ticket', sub: (p) => words(p.project), ...later(() => import('./bricks-new-ticket').then((m) => m.NewTicket)) },
  backlog: { fits: fit([440, 680, 820, 420], 260), title: () => 'Backlog', sub: (p) => words(p.project), ...later(() => import('./bricks-backlog').then((m) => m.Backlog)) },
  unfiled: { fits: fit([440, 680, 820, 420], 260), title: () => 'Unfiled tickets', sub: () => '', ...later(() => import('./bricks-unfiled').then((m) => m.Unfiled)) },
  'knowledge-page': { fits: fit([460, 720, 860, 520], 300), title: () => 'Knowledge page', sub: (p) => words(p.page), ...later(() => import('./bricks-knowledge-page').then((m) => m.KnowledgePage)) },
  knowledge: { fits: fit([460, 720, 860, 520], 320), title: () => 'Knowledge', sub: (p) => [words(p.show), words(p.domain)].filter(Boolean).join(' · '), ...later(() => import('./bricks-knowledge').then((m) => m.Knowledge)) },
  people: { fits: fit([440, 680, 820, 480], 310), title: () => 'People', sub: (p) => words(p.folder), ...later(() => import('./bricks-people').then((m) => m.People)) },
  activity: { fits: fit([460, 720, 860, 520], 290), title: () => 'Activity', sub: (p) => (Number(p.days) === 1 ? '1 day' : `${words(p.days)} days`), ...later(() => import('./bricks-activity').then((m) => m.Activity)) },
  threads: { fits: fit([440, 680, 820, 420], 260), title: () => 'Conversations', sub: (p) => words(p.scope), ...later(() => import('./bricks-threads').then((m) => m.Threads)) },
  agents: { fits: fit([420, 640, 760, 260], 260), title: () => 'Agents', sub: () => '', ...later(() => import('./bricks-agents').then((m) => m.Agents)) },
  tempo: { fits: fit([460, 720, 860, 520], 300), title: () => 'Tempo', sub: (p) => words(p.agent), ...later(() => import('./bricks-tempo').then((m) => m.Tempo)) },
  trigger: { fits: fit([460, 700, 820, 520], 320), title: () => 'Trigger', sub: (p) => words(p.trigger).slice(0, 11), ...later(() => import('./bricks-trigger').then((m) => m.Trigger)) },
  account: { fits: fit([460, 700, 860, 560], 215), title: () => 'Your account', sub: () => '', ...later(() => import('./bricks-account').then((m) => m.Account)) },
  appearance: { fits: fit([440, 640, 760, 620], 270), title: () => 'Appearance', sub: () => '', ...later(() => import('./bricks-appearance').then((m) => m.Appearance)) },
  secrets: { fits: fit([460, 720, 860, 560], 260), title: () => 'Secrets', sub: () => '', ...later(() => import('./bricks-secrets').then((m) => m.Secrets)) },
  machines: { fits: fit([460, 720, 860, 520], 300), title: () => 'Machines', sub: () => '', ...later(() => import('./bricks-machines').then((m) => m.Machines)) },
  subscriptions: { fits: fit([460, 720, 860, 520], 300), title: () => 'Subscriptions', sub: () => '', ...later(() => import('./bricks-subscriptions').then((m) => m.Subscriptions)) },
  usage: { fits: fit([460, 720, 860, 520], 320), title: () => 'Job usage', sub: (p) => (Number(p.days) === 1 ? '1 day' : `${words(p.days)} days`), ...later(() => import('./bricks-usage').then((m) => m.Usage)) },
  bridges: { fits: fit([460, 720, 860, 520], 300), title: () => 'Bridges', sub: () => '', ...later(() => import('./bricks-bridges').then((m) => m.Bridges)) },
  household: { fits: fit([460, 720, 860, 520], 310), title: () => 'Household', sub: () => '', ...later(() => import('./bricks-household').then((m) => m.Household)) },
  sharing: { fits: fit([440, 680, 820, 460], 300), title: () => 'Sharing', sub: () => '', ...later(() => import('./bricks-sharing').then((m) => m.Sharing)) },
  tickets: { fits: fit([460, 720, 860, 520], 300), title: () => 'Tickets', sub: (p) => words(p.state).replace('-', ' '), ...later(() => import('./bricks-tickets').then((m) => m.Tickets)) },
  projects: { fits: fit([440, 680, 820, 460], 300), title: () => 'Projects', sub: () => '', ...later(() => import('./bricks-projects').then((m) => m.Projects)) },
};
export const brickView = (name: string): BrickView => (Object.hasOwn(bricks, name) ? bricks[name] : unknown(name));
/** Fetches every brick's body. The suites call it before they draw, so a body draws at once as it does on a page
 * that has shown the brick before. */
export const loadBricks = () => Promise.all(Object.values(bricks).map((b) => b.load()));
