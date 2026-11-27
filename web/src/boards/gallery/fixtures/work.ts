/** Gallery fixtures for the bricks of Work: project, lanes, trend, ticket, comments, new-ticket, backlog, unfiled,
 * pull and repository (development only; ../scenes.ts). One household throughout: alex owns it, sam and robin
 * live there; fern, moss and art are its agents; garden, pond and greenhouse are its projects. */
import type { Answer, BrickScenes } from '../scenes';
import { ago } from './time';

const zone = { deskTime: { at: Date.now(), timezone: 'Europe/Amsterdam' } };
const taskChoices = {
  projects: [
    { id: 'garden', name: 'Garden', projectMembersByProject: [{ member: 'alex' }, { member: 'sam' }] },
    { id: 'pond', name: 'Pond', projectMembersByProject: [{ member: 'alex' }, { member: 'robin' }] },
    { id: 'greenhouse', name: 'Greenhouse', projectMembersByProject: [{ member: 'sam' }] },
  ],
  agents: [{ id: 'fern', removedAt: null }, { id: 'moss', removedAt: null }, { id: 'art', removedAt: null }, { id: 'thistle', removedAt: ago(60 * 24 * 40) }],
  members: [{ id: 'alex' }, { id: 'sam' }, { id: 'robin' }],
};
const viewer = { homeComms: { member: 'alex' } };

/** Every ticket the household's projects hold, by id and title: what a picker searches. */
const titles: [string, string][] = [
  ['t-1', 'Raise the north bed and line it before the first frost'],
  ['t-2', 'Order seed potatoes'],
  ['t-3', 'Work out why the drip line on the south fence loses pressure after the third emitter, and replace whatever is clogged'],
  ['t-4', 'Label the seed trays'],
  ['t-5', 'Compost bin: second bay'],
  ['t-6', 'Move the rain barrel to the corner by the shed and fit the overflow so it stops flooding the path every time it rains hard'],
  ['t-7', 'Mulch the fruit trees'],
  ['t-8', 'Fix the gate latch'],
  ['t-9', 'Plan the spring sowing calendar'],
  ['t-10', 'Net the brassicas against pigeons'],
  ['t-11', 'Sharpen and oil the hand tools'],
  ['t-12', 'Replace the pump filter'],
  ['t-13', 'Test the soil pH in every bed and write the numbers into the garden notes'],
  ['t-14', 'Prune the old apple'],
  ['t-15', 'Find a second water butt'],
  ['t-16', 'Clear the bindweed from behind the greenhouse'],
  ['t-17', 'Sow the broad beans'],
  ['t-18', 'Repair the cold frame lid'],
  ['t-19', 'Decide where the new herb spiral goes'],
  ['t-20', 'Garden: winter readiness'],
];
const ticketChoices = { tasks: titles.map(([id, title]) => ({ id, title })) };
const title = (id: string) => titles.find(([t]) => t === id)?.[1] ?? id;
const shared: Record<string, Answer> = { DeskTime: zone, TaskChoices: taskChoices, WorkViewer: viewer, BrickTicketChoices: ticketChoices, LiveAgents: { agents: taskChoices.agents } };

// ── project ────────────────────────────────────────────────────────────────────────────────────────────────────
const projectRow = {
  name: 'Garden',
  goal: 'Get the garden through winter in good shape: **beds raised and mulched**, water sorted before the frost, and a sowing plan ready for March.\n\nNothing here is urgent on its own; what matters is that it is all done before the ground freezes.',
  lifecycle: 'active',
  projectMembersByProject: [{ member: 'alex' }, { member: 'sam' }, { member: 'robin' }],
};
const contributions = [
  { id: 'fern:garden', agent: 'fern', name: 'Garden beds', goal: 'Keep the beds, the compost and the sowing calendar moving.', summary: 'Three beds raised, one to go. The compost bay is waiting on timber that arrives Thursday.' },
  { id: 'moss:garden-water', agent: 'moss', name: 'Garden water', goal: 'Rain capture and irrigation that needs no one to remember it.', summary: 'The drip line loses pressure past the third emitter; I think it is a clogged filter, not a leak. The barrel move is planned for the weekend.' },
  { id: 'art:garden', agent: 'art', name: 'Garden', goal: null, summary: 'I answer questions about it and file what comes up in conversation.' },
];
const projectCard = (id: string, repos: string[]) => ({ memoryProject: { id, agent: id.split(':')[0], agents: [id.split(':')[0]], now: 0, slug: id.split(':')[1], name: 'Garden', updated: '', activity: '', archived: false, unknown: false,
  card: { slug: id.split(':')[1], name: 'Garden', status: 'active', summary: null, goal: null, where: [], links: { aliases: null, notes: null, epic: null, repos, venues: null } },
  sections: [], waiting: [], lately: [], people: [], spark: [], changes: null, fields: [] } });
const cardRepos: Record<string, string[]> = { 'fern:garden': ['github:hollow-lane/garden-notes.git', 'hollow-lane/sowing-calendar'], 'moss:garden-water': ['hollow-lane/irrigation-controller'], 'art:garden': [] };
const claimStates = { projectClaimStates: [
  { agent: 'fern', paused: false, revision: 3, at: ago(60 * 26) },
  { agent: 'moss', paused: true, revision: 7, at: ago(95) },
] };
const projectData = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  ...shared,
  BrickProject: { project: projectRow },
  WorkProjectNotes: { workProjectContributions: contributions },
  WorkClaimStates: claimStates,
  MemoryProject: (v: Record<string, unknown>) => projectCard(String(v.id), cardRepos[String(v.id)] ?? []),
  ...over,
});

// ── lanes ──────────────────────────────────────────────────────────────────────────────────────────────────────
const laneRows = [
  { id: 't-1', title: title('t-1'), lane: 'Working', reason: 'PR #41 · Checks running', assignee: 'fern', priority: 1 },
  { id: 't-3', title: title('t-3'), lane: 'Working', reason: 'Session running for 42 min', assignee: 'moss', priority: 0 },
  { id: 't-5', title: title('t-5'), lane: 'Working', reason: null, assignee: 'sam', priority: 2 },
  { id: 't-9', title: title('t-9'), lane: 'Working', reason: 'PR #44 · Draft', assignee: 'fern', priority: 2 },
  { id: 't-11', title: title('t-11'), lane: 'Working', reason: null, assignee: 'robin', priority: 4 },
  { id: 't-6', title: title('t-6'), lane: 'Verifying', reason: 'PR #39 · Waiting on you', assignee: 'moss', priority: 1 },
  { id: 't-8', title: title('t-8'), lane: 'Verifying', reason: 'Merged · waiting to be checked', assignee: 'fern', priority: 3 },
  { id: 't-2', title: title('t-2'), lane: 'Waiting', reason: 'Which variety: Charlotte or Pink Fir Apple?', assignee: 'fern', priority: 1 },
  { id: 't-19', title: title('t-19'), lane: 'Waiting', reason: 'Asked Sam where the afternoon sun falls', assignee: 'art', priority: 3 },
  { id: 't-15', title: title('t-15'), lane: 'Waiting', reason: 'Blocked by t-6', assignee: null, priority: 2 },
  { id: 't-18', title: title('t-18'), lane: 'Waiting', reason: 'Approval: buy polycarbonate sheet', assignee: 'moss', priority: 2 },
];
const manyWorking = Array.from({ length: 11 }, (_, i) => ({ id: `t-${40 + i}`, title: ['Turn the compost', 'Stake the dahlias before the wind gets them', 'Clean the greenhouse glass', 'Patch the hose'][i % 4], lane: 'Working', reason: null, assignee: ['fern', 'moss', 'sam'][i % 3], priority: i % 5 }));
const lanesData = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  ...shared,
  BrickLanes: { projectBoardTickets: laneRows },
  WorkProjectDecisions: { inboxProjectNeeds: [{ project: 'garden', needs: 2 }, { project: 'pond', needs: 1 }] },
  WorkClaimStates: claimStates,
  ...over,
});

// ── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Counts per day back from today, oldest last: a slow week, a burst of filing, then steady closing. */
const openedPerDay = [2, 1, 0, 3, 1, 0, 0, 4, 2, 1, 0, 5, 7, 2, 1, 0, 0, 2, 3, 1, 0, 1, 0, 0, 2, 1, 0, 0, 1, 3];
const closedPerDay = [1, 3, 2, 0, 2, 1, 0, 1, 4, 2, 0, 1, 0, 2, 3, 0, 0, 1, 1, 2, 0, 0, 1, 0, 0, 2, 1, 0, 0, 1];
const trendRows = (counts: number[], from: number) => counts.flatMap((n, daysBack) => Array.from({ length: n }, (_, i) => {
  const k = from + daysBack * 7 + i;
  return { id: `t-${100 + k}`, title: titles[k % titles.length][1], at: ago(daysBack * 1440 + 30 + i * 7) };
}));
const trendData = { opened: trendRows(openedPerDay, 0), closed: trendRows(closedPerDay, 3) };

// ── ticket ─────────────────────────────────────────────────────────────────────────────────────────────────────
const ticketBase = {
  id: 't-3', title: title('t-3'), status: 'in_progress', assignee: 'moss', assigneeKind: 'agent', project: 'garden',
  goal: 'The south fence drip line waters every emitter evenly again, **without anyone having to check it**.',
  why: 'The beans at the far end have had almost no water for two weeks. The line is on a timer, so nobody notices until the plants wilt.',
  doneWhen: '- Pressure at the last emitter is within 10% of the first\n- The filter is cleaned or replaced\n- A note in the garden log says what was wrong',
};
const ticketMore = {
  ...ticketBase, type: 'bug', priority: 0,
  description: 'Emitters 1 to 3 run fine; from the fourth on it is a slow drip. The line was flushed in spring. Sam thinks the inline filter was never cleaned after the well water ran brown in August.\n\nThe spare filter is in the shed, top shelf, in the box marked `irrigation`.',
  ask: null, ifYes: null, ifNo: null, createdAt: ago(60 * 24 * 9), createdBy: 'sam', closedAt: null, closeReason: null,
  taskLinksByTask: [
    { dependsOn: 't-20', type: 'parent-child', dependsOnRow: { id: 't-20', title: title('t-20') } },
    { dependsOn: 't-12', type: 'blocks', dependsOnRow: { id: 't-12', title: title('t-12') } },
    { dependsOn: 't-77', type: 'blocks', dependsOnRow: null },
  ],
  taskLinksByDependsOn: [
    { task: 't-17', type: 'blocks', taskRow: { id: 't-17', title: title('t-17') } },
    { task: 't-10', type: 'blocks', taskRow: { id: 't-10', title: title('t-10') } },
  ],
};
const ticketSessions = { rows: [
  { conversation: 'cv-drip-0003', title: 'Trace the pressure drop on the south fence line', state: 'running', at: ago(42) },
  { conversation: 'cv-drip-0002', title: 'Read the irrigation timer log for the last fortnight', state: 'done', at: ago(60 * 20) },
  { conversation: 'cv-drip-0001', title: 'Find where the spare filter is kept', state: 'failed', at: ago(60 * 24 * 3) },
  { conversation: 'cv-drip-0000', title: '', state: null, at: ago(60 * 24 * 8) },
] };
const ticketData = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  ...shared,
  BrickTicket: { ticket: ticketBase },
  BrickTicketMore: { ticket: ticketMore },
  BrickTicketSessions: ticketSessions,
  ...over,
});
const closedTicket = { ...ticketBase, id: 't-8', title: title('t-8'), status: 'closed', assignee: 'fern', goal: 'The gate closes and stays closed in wind.', why: 'The hens got out twice last week.', doneWhen: null };
const closedMore = { ...ticketMore, ...closedTicket, type: 'task', priority: 3, description: '', createdBy: 'alex', createdAt: ago(60 * 24 * 21), closedAt: ago(60 * 24 * 2),
  closeReason: 'Replaced the latch with a self-closing one and re-hung the gate on the lower hinge. Checked in a gale on Tuesday: it held.', taskLinksByTask: [], taskLinksByDependsOn: [] };
const bareTicket = { id: 't-4', title: title('t-4'), status: 'open', assignee: null, assigneeKind: null, goal: null, why: null, doneWhen: null, project: null };
const bareMore = { ...bareTicket, type: 'task', priority: 3, description: '', ask: null, ifYes: null, ifNo: null, createdAt: ago(60 * 5), createdBy: 'robin', closedAt: null, closeReason: null, taskLinksByTask: [], taskLinksByDependsOn: [] };

// ── comments ───────────────────────────────────────────────────────────────────────────────────────────────────
const noteTexts: [string, string][] = [
  ['moss', 'Pressure at emitter 4 is 0.4 bar against 1.6 at the head. That is not a leak; a leak would drop the head too. Pulling the inline filter next.'],
  ['sam', 'The filter housing is the grey one just after the timer. You need the strap wrench, it is on the nail by the shed door.'],
  ['moss', 'Filter is **packed with brown silt**. Rinsed it; pressure at the last emitter is now 1.5 bar. I would still replace it: the mesh is torn in one corner.\n\n- rinsed: done\n- replacement: see t-12'],
  ['alex', 'Good. Use the spare.'],
  ['fern', 'I moved the beans watering to mornings while this was low. I will put it back once t-12 is closed.'],
  ['robin', 'Is this why the path was dry?'],
  ['moss', 'Yes.'],
  ['sam', 'Filed after I found the far beans wilting on Saturday. The timer log says it ran every day, so it is the line and not the schedule.'],
];
const notes = noteTexts.map(([actor, text], i) => ({ seq: noteTexts.length - i, text, actor, at: ago(18 + i * i * 170) }));
const commentsData = (taskCommentsByTask: unknown[]): Record<string, Answer> => ({ ...shared, BrickComments: { ticket: { title: title('t-3'), taskCommentsByTask } } });

// ── backlog ────────────────────────────────────────────────────────────────────────────────────────────────────
const backlogIds = ['t-12', 't-13', 't-7', 't-10', 't-14', 't-16', 't-17', 't-4', 't-21', 't-22', 't-23', 't-24'];
const backlogTitles: Record<string, string> = { 't-21': 'Ask the neighbours about sharing a chipper for a weekend', 't-22': 'Paint the shed door', 't-23': 'Bulb order', 't-24': 'Draw the beds to scale so the sowing calendar can say which bed, not just which crop, and keep the drawing where everyone can find it' };
const backlogOpen = [
  ...backlogIds.map((id, i) => ({ id, title: backlogTitles[id] ?? title(id), status: 'open', priority: [0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4][i], isShelved: false })),
  // In a lane, in progress or shelved: read, and left out of the backlog.
  { id: 't-2', title: title('t-2'), status: 'open', priority: 1, isShelved: false },
  { id: 't-3', title: title('t-3'), status: 'in_progress', priority: 0, isShelved: false },
  { id: 't-30', title: 'Old orchard plan', status: 'open', priority: 2, isShelved: true },
];
const backlogData = (open: unknown[]): Record<string, Answer> => ({ ...shared, BrickBacklog: { project: { id: 'garden', name: 'Garden' }, open }, BrickBacklogLaned: { projectBoardTickets: laneRows.map((t) => ({ id: t.id })) } });

// ── unfiled ────────────────────────────────────────────────────────────────────────────────────────────────────
const unfiledRows = [
  ['t-51', 'Renew the allotment society membership', 'open'],
  ['t-52', 'Find out whether the council still collects green waste in January, and if not where the nearest site that takes it is', 'in_progress'],
  ['t-53', 'Borrow a ladder', 'open'],
  ['t-54', 'Return the hired rotavator', 'closed'],
  ['t-55', 'Book the chimney sweep', 'open'],
  ['t-56', 'Photograph the beds for the insurance', 'open'],
  ['t-57', 'Ask Robin about the wheelbarrow tyre', 'closed'],
  ['t-58', 'Look into a grant for the rainwater tank', 'in_progress'],
  ['t-59', 'Sort the seed tin', 'open'],
].map(([id, t, status], i) => ({ id, title: t, status, changedAt: ago(30 + i * 400) }));
const unfiledData = (unfiled: unknown[], over: Record<string, Answer> = {}): Record<string, Answer> => ({ ...shared, WorkUnfiled: { unfiled }, ...over });

// ── pull, repository ───────────────────────────────────────────────────────────────────────────────────────────
const change = { id: 'github:hollow-lane/irrigation-controller#39', repository: 'hollow-lane/irrigation-controller', number: 39,
  title: 'Read line pressure at both ends and warn when the far end falls below the head by more than a tenth', state: 'open', draft: false, authorLogin: 'moss-bot',
  project: 'garden', agent: 'moss', branch: 'moss/pressure-both-ends', baseBranch: 'main', checks: 'failing', review: 'required', mergeable: 'unknown', waitingOn: 'author' };
const pullData = (over: object = {}, parts: { checks?: unknown[]; people?: unknown[]; tasks?: unknown[] } = {}): Record<string, Answer> => ({
  ...shared,
  BrickPull: {
    changes: [{ ...change, ...over }],
    changeChecks: parts.checks ?? [{ change: change.id, name: 'unit', state: 'running' }, { change: change.id, name: 'build (linux, arm64)', state: 'failing' }, { change: change.id, name: 'lint', state: 'failing' }],
    changePeople: parts.people ?? [{ change: change.id, login: 'moss-bot', role: 'author' }, { change: change.id, login: 'sam', role: 'requested' }, { change: change.id, login: 'alex', role: 'reviewer' }, { change: change.id, login: 'robin', role: 'commenter' }],
    changeTasks: parts.tasks ?? [
      { change: change.id, task: 't-3', taskRow: { id: 't-3', title: title('t-3'), status: 'in_progress' } },
      { change: change.id, task: 't-12', taskRow: { id: 't-12', title: title('t-12'), status: 'open' } },
      { change: change.id, task: 't-99', taskRow: null },
    ],
  },
});
const openPulls = [
  { number: 39, title: change.title, draft: false, checks: 'passing', review: 'approved', waitingOn: 'you', agent: 'moss' },
  { number: 44, title: 'Sowing calendar: frost dates per bed', draft: true, checks: 'none', review: 'required', waitingOn: 'author', agent: 'fern' },
  { number: 43, title: 'Timer: skip a run when it rained more than 5 mm overnight', draft: false, checks: 'running', review: 'required', waitingOn: 'ci', agent: 'moss' },
  { number: 42, title: 'Fix the valve order', draft: false, checks: 'failing', review: 'required', waitingOn: 'author', agent: 'moss' },
  { number: 41, title: 'Raise the north bed: cut list and liner sizes', draft: false, checks: 'passing', review: 'required', waitingOn: 'reviewer', agent: 'fern' },
  { number: 40, title: 'Log every run with its duration so a short run can be told from a skipped one without reading the controller', draft: false, checks: 'passing', review: 'changes_requested', waitingOn: 'author', agent: null },
  { number: 38, title: 'Bump the sensor library', draft: false, checks: 'passing', review: 'approved', waitingOn: 'agent', agent: 'moss' },
  { number: 36, title: 'Docs: where each valve is', draft: false, checks: 'passing', review: 'approved', waitingOn: 'you', agent: 'art' },
].map((c) => ({ ...c, id: `github:hollow-lane/irrigation-controller#${c.number}`, state: 'open', project: 'garden' }));
const repositoryData = (open: unknown[], known = true): Record<string, Answer> => ({ ...shared, BrickRepository: { open, known: known ? [{ id: change.id }] : [] } });

export const scenes: BrickScenes[] = [
  { brick: 'project', scenes: [
    { name: 'default', params: { project: 'garden' }, data: projectData() },
    { name: 'empty', params: { project: 'greenhouse' }, data: projectData({ BrickProject: { project: { name: 'Greenhouse', goal: null, lifecycle: 'planned', projectMembersByProject: [] } }, WorkProjectNotes: { workProjectContributions: [] }, WorkClaimStates: { projectClaimStates: [] } }) },
    { name: 'retired', params: { project: 'pond' }, only: ['side', 'compact'], data: projectData({ BrickProject: { project: { name: 'Pond', goal: 'Keep the pond clear and the pump running through summer.', lifecycle: 'retired', projectMembersByProject: [{ member: 'robin' }] } }, WorkProjectNotes: { workProjectContributions: [contributions[1]] }, WorkClaimStates: { projectClaimStates: [] } }) },
    { name: 'unavailable', params: { project: 'garden' }, only: ['side'], data: projectData({ BrickProject: 'offline' }) },
  ] },
  { brick: 'lanes', scenes: [
    { name: 'default', params: { project: 'garden' }, data: lanesData() },
    { name: 'pausing', params: { project: 'garden' }, only: ['primary'], press: ['Pause…'], data: lanesData() },
    { name: 'many', params: { project: 'garden' }, only: ['primary', 'side'], data: lanesData({ BrickLanes: { projectBoardTickets: [...manyWorking, ...laneRows.filter((t) => t.lane === 'Waiting')] } }) },
    { name: 'empty', params: { project: 'greenhouse' }, data: lanesData({ BrickLanes: { projectBoardTickets: [] }, WorkProjectDecisions: { inboxProjectNeeds: [] }, WorkClaimStates: { projectClaimStates: [] } }) },
    { name: 'unavailable', params: { project: 'garden' }, only: ['side'], data: lanesData({ BrickLanes: 'offline' }) },
  ] },
  { brick: 'trend', scenes: [
    { name: 'default', params: { project: 'garden', days: 30 }, data: { ...shared, BrickTrend: trendData } },
    { name: 'week', params: { project: 'garden', days: 7 }, only: ['primary', 'side'], data: { ...shared, BrickTrend: trendData } },
    { name: 'empty', params: { project: 'greenhouse', days: 30 }, data: { ...shared, BrickTrend: { opened: [], closed: [] } } },
    { name: 'unavailable', params: { project: 'garden', days: 30 }, only: ['side'], data: { ...shared, BrickTrend: 'offline' } },
  ] },
  { brick: 'ticket', scenes: [
    { name: 'default', params: { ticket: 't-3' }, data: ticketData() },
    { name: 'bare', params: { ticket: 't-4' }, data: ticketData({ BrickTicket: { ticket: bareTicket }, BrickTicketMore: { ticket: bareMore }, BrickTicketSessions: { rows: [] } }) },
    { name: 'closed', params: { ticket: 't-8' }, data: ticketData({ BrickTicket: { ticket: closedTicket }, BrickTicketMore: { ticket: closedMore }, BrickTicketSessions: { rows: [ticketSessions.rows[1]] } }) },
    { name: 'flagged', params: { ticket: 't-8' }, flag: 'Closed', only: ['side', 'compact'], data: ticketData({ BrickTicket: { ticket: closedTicket }, BrickTicketMore: { ticket: closedMore }, BrickTicketSessions: { rows: [ticketSessions.rows[1]] } }) },
    { name: 'sessions-unavailable', params: { ticket: 't-3' }, only: ['primary'], data: ticketData({ BrickTicketSessions: 'offline' }) },
    { name: 'loading', params: { ticket: 't-3' }, only: ['side'], data: ticketData({ BrickTicket: 'loading' }) },
    { name: 'unavailable', params: { ticket: 't-3' }, only: ['side'], data: ticketData({ BrickTicket: 'offline' }) },
  ] },
  { brick: 'comments', scenes: [
    { name: 'default', params: { ticket: 't-3' }, data: commentsData(notes) },
    { name: 'flagged', params: { ticket: 't-3' }, flag: 'New comment', only: ['side', 'compact'], data: commentsData(notes) },
    { name: 'empty', params: { ticket: 't-3' }, data: commentsData([]) },
    { name: 'unavailable', params: { ticket: 't-3' }, only: ['side'], data: { ...shared, BrickComments: 'offline' } },
  ] },
  { brick: 'new-ticket', scenes: [
    { name: 'default', params: { project: 'garden' }, data: { ...shared, BrickNewTicket: { project: { id: 'garden', name: 'Garden', lifecycle: 'active' } } } },
    { name: 'unavailable', params: { project: 'garden' }, only: ['side'], data: { ...shared, BrickNewTicket: 'offline' } },
  ] },
  { brick: 'backlog', scenes: [
    { name: 'default', params: { project: 'garden' }, data: backlogData(backlogOpen) },
    { name: 'setting-priority', params: { project: 'garden' }, only: ['primary'], press: ['Priority…'], data: backlogData(backlogOpen) },
    { name: 'empty', params: { project: 'garden' }, data: backlogData(backlogOpen.slice(-3)) },
    { name: 'unavailable', params: { project: 'garden' }, only: ['side'], data: { ...backlogData([]), BrickBacklog: 'offline' } },
  ] },
  { brick: 'unfiled', scenes: [
    { name: 'default', params: {}, data: unfiledData(unfiledRows) },
    { name: 'filing', params: {}, only: ['primary'], press: ['File…'], data: unfiledData(unfiledRows) },
    { name: 'many', params: {}, only: ['primary', 'compact'], data: unfiledData(Array.from({ length: 51 }, (_, i) => ({ ...unfiledRows[i % unfiledRows.length], id: `t-${200 + i}` }))) },
    { name: 'empty', params: {}, data: unfiledData([]) },
    { name: 'no-projects', params: {}, only: ['primary'], data: unfiledData(unfiledRows.slice(0, 3), { TaskChoices: { ...taskChoices, projects: [] } }) },
    { name: 'unavailable', params: {}, only: ['side'], data: unfiledData([], { WorkUnfiled: 'offline' }) },
  ] },
  { brick: 'pull', scenes: [
    { name: 'default', params: { change: change.id }, data: pullData() },
    { name: 'waiting-on-you', params: { change: change.id }, data: pullData({ checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you' }, { checks: [] }) },
    { name: 'draft', params: { change: change.id }, only: ['side', 'compact'], data: pullData({ draft: true, checks: 'none', title: 'Sowing calendar: frost dates per bed', project: null, agent: null }, { checks: [], people: [], tasks: [] }) },
    { name: 'merged', params: { change: change.id }, data: pullData({ state: 'merged', checks: 'passing', review: 'approved', mergeable: 'unknown', waitingOn: 'done' }, { checks: [] }) },
    { name: 'flagged', params: { change: change.id }, flag: 'Checks failing', only: ['side', 'compact'], data: pullData() },
    { name: 'unavailable', params: { change: change.id }, only: ['side'], data: { ...shared, BrickPull: 'offline' } },
  ] },
  { brick: 'repository', scenes: [
    { name: 'default', params: { repository: 'hollow-lane/irrigation-controller', project: 'garden' }, data: repositoryData(openPulls) },
    { name: 'no-project', params: { repository: 'hollow-lane/irrigation-controller' }, only: ['side', 'compact'], data: repositoryData(openPulls.slice(1, 3)) },
    { name: 'empty', params: { repository: 'hollow-lane/garden-notes' }, data: repositoryData([]) },
    { name: 'unavailable', params: { repository: 'hollow-lane/unknown' }, only: ['side'], data: repositoryData([], false) },
  ] },
];

