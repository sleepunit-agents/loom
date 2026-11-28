/** Gallery fixtures (development only) for the bricks about agents and their work: agent, agents, session, tempo
 * and trigger. Each scene answers every read its brick makes, by the name of the query. */
import type { DoingItem } from '../../../pieces/attention/doing-model';
import type { Event, Outcome } from '../../../pieces/tempo/day-model';
import type { AgentPause, Trigger, TriggerEvent } from '../../../pieces/tempo/model';
import type { TriggerRun } from '../../../pieces/tempo/runs';
import type { TraceStep } from '../../session-trace';
import type { Answer, BrickScenes } from '../scenes';
import { ago, ahead } from './time';

type Data = Record<string, Answer>;
const zone = 'Europe/Amsterdam';

// ── The household's agents, as every agent brick reads them ─────────────────────────────────────────────────────
const directory = {
  memoryPeopleAccess: { directory: true },
  memoryPeople: [
    { id: 'commons:fern', slug: 'fern', agent: null, name: 'Fern', kind: 'agent' },
    { id: 'commons:moss', slug: 'moss', agent: null, name: 'Moss', kind: 'agent' },
    { id: 'commons:art', slug: 'art', agent: null, name: 'Art', kind: 'agent' },
    { id: 'commons:juniper', slug: 'juniper', agent: null, name: 'Juniper', kind: 'agent' },
    { id: 'commons:sam', slug: 'sam', agent: null, name: 'Sam Okafor', kind: 'person' },
  ],
};
/** Each agent's own colour, shape and eyes (pieces/attention/agent-displays.ts). */
const displays = { agents: [
  { id: 'fern', markBg: '#7FD1A6', markFg: '#0B1F15', faceShape: 'clover', faceEyes: 'dot', spriteVersion: null },
  { id: 'moss', markBg: '#B8A6FF', markFg: '#15102B', faceShape: 'pebble', faceEyes: 'oval', spriteVersion: null },
  { id: 'art', markBg: '#6FD3E0', markFg: '#08222A', faceShape: 'drop', faceEyes: 'dot', spriteVersion: null },
  { id: 'juniper', markBg: '#F2B880', markFg: '#2A1806', faceShape: 'trefoil', faceEyes: 'oval', spriteVersion: null },
  { id: 'reed', markBg: '#F29CB1', markFg: '#2A0A14', faceShape: 'pebble', faceEyes: 'dot', spriteVersion: null },
] };
const profiles = { agents: [
  { id: 'fern', about: 'Keeps the garden project moving: plans the beds, orders what is needed and writes up what was done each week.', aboutAskedAt: null },
  { id: 'moss', about: 'Looks after the pond and the greenhouse sensors, and reads the pump logs every morning.', aboutAskedAt: null },
  { id: 'art', about: 'The household’s general agent. Answers on the boards page and hands longer work off to sessions.', aboutAskedAt: null },
  { id: 'juniper', about: '', aboutAskedAt: ago(3 * 1440) },
  { id: 'reed', about: 'Reads the mail and files receipts.', aboutAskedAt: null },
] };
const statuses = (over: Record<string, [string, string]> = {}) => ({ agentStatus: Object.entries({
  fern: ['working', 'Rebuilding the fence plan for the north bed'], moss: ['idle', ''], art: ['waiting', 'Waiting for an answer about the pump filter'],
  juniper: ['offline', ''], reed: ['idle', 'Filed 14 receipts'], ...over,
}).map(([agent, [state, work]], n) => ({ agent, state, work, changedAt: ago(6 + n * 37) })) });
const waiting = (needs: Record<string, number> = { fern: 0, moss: 0, art: 2, juniper: 0, reed: 0 }) => ({
  homeComms: { member: 'alex' },
  inboxFolders: { needs: Object.values(needs).reduce((a, b) => a + b, 0), agents: Object.entries(needs).map(([id, n]) => ({ id, needs: n })) },
});
const owned = ['fern', 'moss', 'art', 'juniper', 'reed'];
const homeComms = { homeComms: { member: 'alex', agents: owned, summaries: [
  { agent: 'fern', unread: 3, last: { thread: 'th:fern-fence', title: 'The fence along the north bed', at: ago(12) }, first: { thread: 'th:fern-fence' } },
  { agent: 'moss', unread: 0, last: { thread: 'th:moss-pump', title: 'Pump readings', at: ago(2 * 1440) }, first: null },
  { agent: 'art', unread: 1, last: { thread: 'th:board-alex-art', title: 'Boards', at: ago(4) }, first: { thread: 'th:board-alex-art' } },
] } };
const roster = (ids: string[] = owned) => ({
  homeComms: { member: 'alex', agents: ids },
  agents: [...ids.map((id, position) => ({ id, position, removedAt: null })), { id: 'willow', position: 9, removedAt: ago(40 * 1440) }],
});
const item = (over: Partial<DoingItem> & Pick<DoingItem, 'id' | 'kind'>): DoingItem => ({
  title: null, with: null, place: null, direct: null, ref: null, machine: null, since: ago(25), state: 'running', href: null, task: null, quietSince: null, ...over,
});
const fernDoing: DoingItem[] = [
  item({ id: 'job-fence-7', kind: 'handoff', with: 'alex', title: 'Rebuild the fence plan for the north bed and price the posts from two suppliers', ref: 't-3', task: 'Fence the north bed', machine: 'shed-mini', since: ago(47) }),
  item({ id: 't-3', kind: 'task', title: 'Fence the north bed before the first frost', ref: 't-3', since: ago(190) }),
  item({ id: 'job-slack-2', kind: 'slack', with: 'sam', direct: 'person', since: ago(9) }),
  item({ id: 'job-trig-4', kind: 'trigger', title: 'Morning walk-round of the beds', state: 'queued', since: ago(2) }),
  item({ id: 'job-term-1', kind: 'terminal', title: 'claude · ~/house/garden', machine: 'shed-mini', since: ago(310), quietSince: ago(95) }),
];
const doing = (items: DoingItem[], more = 0, claimed = 0) => ({ agentDoing: { items, more, claimed } });
const doingBy = (by: Record<string, DoingItem[]>, more: Record<string, number> = {}): Answer =>
  (v: Record<string, unknown>) => doing(by[String(v.agent)] ?? [], more[String(v.agent)] ?? 0);

type Job = { id: string; title: string; state: string; conversation: string | null; queuedAt: string; endedAt: string | null };
const job = (n: number, title: string, state: string, queued: number, ended: number | null, conversation: string | null = `cv-fern-${String(n).padStart(4, '0')}`): Job =>
  ({ id: 'job-' + n, title, state, conversation, queuedAt: ago(queued), endedAt: ended == null ? null : ago(ended) });
const fernJobs: Job[] = [
  job(31, 'Rebuild the fence plan for the north bed and price the posts from two suppliers', 'running', 47, null, 'cv-fence-0001'),
  job(30, 'Morning walk-round of the beds', 'queued', 2, null),
  job(29, 'Reply to Sam about the delivery window', 'starting', 1, null, null),
  job(28, 'Write up the week in the garden', 'done', 26 * 60, 25 * 60),
  job(27, 'Order mulch for the south beds', 'done', 2 * 1440, 2 * 1440 - 14),
  job(26, 'Check the seed order against the planting plan and flag anything that will arrive too late to sow', 'failed', 3 * 1440, 3 * 1440 - 3),
  job(25, '', 'stopped', 4 * 1440, 4 * 1440 - 40),
  job(24, 'Measure the north bed from the survey photos', 'done', 5 * 1440, 5 * 1440 - 22),
  job(23, 'Compare cedar and larch posts', 'done', 6 * 1440, 6 * 1440 - 31),
  job(22, 'Morning walk-round of the beds', 'done', 7 * 1440, 7 * 1440 - 6),
  job(21, 'Morning walk-round of the beds', 'lost', 8 * 1440, 8 * 1440 - 60),
];
const tickets = (rows: [string, string, string][]) => ({ rows: rows.map(([id, title, status]) => ({ id, title, status })) });
const fernTickets = tickets([
  ['t-3', 'Fence the north bed before the first frost', 'in_progress'], ['t-7', 'Order mulch for the south beds', 'in_progress'],
  ['t-11', 'Label every row in the kitchen garden', 'open'], ['t-12', 'Find out why the water butt overflows', 'open'],
]);
const agentData = (over: Data = {}): Data => ({
  DeskAgentProfiles: profiles, DeskAgentStatus: statuses(), DeskWaitingCounts: waiting(), DeskHomeComms: homeComms, DeskAgentDirectory: directory, DeskAgentDisplays: displays,
  DeskDoing: doing(fernDoing.slice(0, 4), 1), DeskDoingAll: doing(fernDoing, 0, 2),
  BrickAgentJobs: (v: Record<string, unknown>) => ({ jobs: fernJobs.slice(0, Number(v.first)) }),
  BrickAssigned: fernTickets, ...over,
});

// ── A session: one handed-off job and the steps its body reported ───────────────────────────────────────────────
const hex = (n: number) => n.toString(16).padStart(24, '0');
const sessionJob = 'job-fence-7';
/** Steps said in order: each is [call, parent call or 0, tool, state, words, minutes ago]. */
type Said = [number, number, string, TraceStep['cardState'], string | null, number];
const stepsFrom = (said: Said[]): TraceStep[] => said.map(([call, parent, tool, cardState, words, minutes], n) => ({
  seq: n + 1, job: sessionJob, at: ago(minutes), tool, cardState, words, clientId: `${sessionJob}:pair.${hex(call)}.${parent ? hex(parent) : '-'}.${n + 1}`,
}));
const said: Said[] = [
  [1, 0, 'Read', 'running', 'house/garden/fence-plan.md', 46],
  [1, 0, 'Read', 'done', 'house/garden/fence-plan.md · 84 lines', 46],
  [2, 0, 'Terminal', 'running', 'git status --short', 45],
  [2, 0, 'Terminal', 'done', ' M house/garden/fence-plan.md\n?? house/garden/suppliers/', 45],
  [3, 0, 'Grep', 'running', 'post spacing', 44],
  [3, 0, 'Grep', 'done', 'house/garden/fence-plan.md:31: post spacing 1.8 m, corner posts set in concrete\nhouse/garden/notes/2025-frost.md:12: post spacing was too wide on the east run', 44],
  [4, 0, 'Terminal', 'running', 'node scripts/bed-length.mjs --bed north --from survey/2026-11-02.json', 42],
  [4, 0, 'Terminal', 'done', 'north bed\n  west run   11.4 m\n  north run  23.9 m\n  east run   11.6 m\n  gate        1.2 m (west run)\ntotal fence  45.7 m\nposts at 1.8 m: 27 (4 corner, 2 gate)', 41],
  [5, 0, 'Subagent', 'running', 'Survey what two suppliers charge for 27 larch posts, 100 mm square, 2.4 m', 40],
  [6, 5, 'Subagent → WebFetch', 'running', 'https://timber.example.test/posts/larch-100', 39],
  [6, 5, 'Subagent → WebFetch', 'done', 'Larch post 100 × 100 × 2400 mm · €18.40 each · delivery €45 over 20 posts', 39],
  [7, 5, 'Subagent → Terminal', 'running', 'curl -s https://yard.example.test/api/price?sku=LP-100-24 | jq .', 38],
  [7, 5, 'Subagent → Terminal', 'done', '{\n  "sku": "LP-100-24",\n  "each": 16.9,\n  "stock": 19,\n  "delivery": 60\n}', 38],
  [5, 0, 'Subagent', 'done', 'Timber Yard North: €18.40 each, 27 in stock, €45 delivery (€541.80).\n\nThe Yard: €16.90 each but only 19 in stock, €60 delivery. The rest would follow in two weeks.', 36],
  [8, 0, 'Edit', 'running', 'house/garden/fence-plan.md', 34],
  [8, 0, 'Edit', 'done', 'house/garden/fence-plan.md · 3 hunks, +41 −12', 34],
  [9, 0, 'Terminal', 'running', 'npx markdownlint house/garden/fence-plan.md', 33],
  [9, 0, 'Terminal', 'failed', 'house/garden/fence-plan.md:58 MD056/table-column-count Table column count [Expected: 4; Actual: 5; Too many cells, extra data will be missing]\nhouse/garden/fence-plan.md:59 MD056/table-column-count Table column count [Expected: 4; Actual: 5; Too many cells, extra data will be missing]\nexit 1', 33],
  [10, 0, 'Edit', 'running', 'house/garden/fence-plan.md', 31],
  [10, 0, 'Edit', 'done', 'house/garden/fence-plan.md · 1 hunk, +2 −2', 31],
  [11, 0, 'Terminal', 'running', 'npx markdownlint house/garden/fence-plan.md', 30],
  [11, 0, 'Terminal', 'done', '', 30],
  [12, 0, 'Write', 'running', 'house/garden/suppliers/2026-11-posts.md', 22],
  [12, 0, 'Write', 'done', 'house/garden/suppliers/2026-11-posts.md · 38 lines', 22],
  [13, 0, 'Terminal', 'running', 'git add -A house/garden && git commit -s -m "Garden: the north bed’s fence, measured and priced"', 9],
  [13, 0, 'Terminal', 'done', '[art/fence-plan 4c1e9a2] Garden: the north bed’s fence, measured and priced\n 2 files changed, 79 insertions(+), 12 deletions(-)\n create mode 100644 house/garden/suppliers/2026-11-posts.md', 9],
  [15, 0, 'Terminal', 'running', 'git push -u origin art/fence-plan\ngh pr create --fill', 5],
  [15, 0, 'Terminal', 'done', 'branch \'art/fence-plan\' set up to track \'origin/art/fence-plan\'.\nhttps://git.example.test/house/garden/pull/12', 5],
  [14, 0, 'Terminal', 'running', 'npm test -- house/garden', 2],
];
const steps = stepsFrom(said);
const usage = { model: 'claude-fable-5-2', harness: 'claude-code', tools: [
  { name: 'Terminal', count: 6 }, { name: 'Edit', count: 2 }, { name: 'Read', count: 1 }, { name: 'Grep', count: 1 }, { name: 'Subagent', count: 1 }, { name: 'Write', count: 1 }, { name: 'TodoWrite', count: null },
] };
const brief = 'Rebuild the fence plan for the north bed from the survey Sam took on the second. Work out how many posts it needs at the spacing we settled on last winter, and price them from two suppliers. Write the plan up in house/garden and tell me which supplier you would choose and why.';
const fenceReport = 'The plan is in **house/garden/fence-plan.md**. The north bed needs 23 posts at the 1.8 m spacing.\n\n- Ashby Timber: 23 posts for £437, delivered Thursday\n- Brook Yard: 23 posts for £402, collect only\n\nI would choose Ashby: the £35 saved at Brook Yard goes on the van to fetch them.';
const sessionTitle = 'Rebuild the fence plan for the north bed and price the posts from two suppliers';
const sessionData = (state: string, over: { queued?: number; detail?: object; venue?: string; steps?: TraceStep[] | 'offline'; title?: string; total?: number; earlier?: TraceStep[]; report?: string } = {}): Data => {
  const trace = over.steps ?? steps;
  return {
    BrickSession: {
      jobs: [
        { id: 'job-fence-3', title: 'An earlier try at the fence plan', state: 'stopped', queuedAt: ago(3 * 1440), usage: null },
        { id: sessionJob, title: over.title ?? sessionTitle, state, queuedAt: ago(over.queued ?? 47), usage },
      ],
      cv: { agent: 'fern', label: 'Fence plan', venue: over.venue ?? 'handoff' },
    },
    BrickSessionJob: { rows: [{ brief, logTail: null, endedNote: null, claimedAt: ago((over.queued ?? 47) - 1), endedAt: null, ...over.detail }] },
    BrickSessionTrace: trace === 'offline' ? 'offline' : { steps: trace, total: over.total ?? trace.length, gone: false },
    BrickSessionEarlier: { steps: over.earlier ?? [] },
    BrickSessionStep: trace === 'offline' ? 'offline' : { steps: trace.slice(-1).map(({ seq, tool, cardState }) => ({ seq, tool, cardState })) },
    BrickSessionReport: { report: over.report ? { words: over.report } : null },
  };
};
const doneSteps = stepsFrom([...said.slice(0, -1), [14, 0, 'Terminal', 'running', 'npm test -- house/garden', 2], [14, 0, 'Terminal', 'done', ' ✓ house/garden/plan.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)', 1]]);

// ── Tempo: triggers of every kind and state ─────────────────────────────────────────────────────────────────────
const trigger = (id: string, note: string, over: Partial<Trigger> = {}): Trigger => ({
  id, ownerKind: 'agent', owner: 'fern', sourceKind: 'time', watches: null, times: '07:30', days: null, lifespan: 'until-stopped',
  targetKind: 'inbox', target: null, toKind: 'agent', to: 'fern', project: 'garden', instructions: null, file: null, note, enabled: true,
  scheduleRemovedAt: null, hasProgram: false, wantsModel: null, needs: null, prefers: null,
  state: 'standing', nextDueAt: ahead(600), lastFiredAt: ago(840), createdAt: ago(60 * 1440), changedAt: ago(9 * 1440), ...over,
});
const walkWords = 'Walk the beds in the order of the planting plan. For each bed say what changed since yesterday, what needs water and what is ready to pick.\n\nIf anything looks diseased, take a note of the row and ask Alex before doing anything about it. Keep the write-up to one short paragraph per bed, and put it in house/garden/walks under today’s date.';
const tWalk = trigger('tr-walk-0001', 'Morning walk-round of the beds', { instructions: walkWords, times: '07:30', nextDueAt: ahead(540), lastFiredAt: ago(310), needs: ['shed-mini'], prefers: ['gpu', 'fast-disk'], wantsModel: 'claude-fable-5-2' });
const tFrost = trigger('tr-frost-0002', 'Frost watch: cover the seedlings when the forecast drops below two degrees', { hasProgram: true, times: '16:00, 20:00', days: 'Oct–Mar', nextDueAt: ahead(95), lastFiredAt: ago(145), state: 'due' });
const tWeek = trigger('tr-week-0003', 'Write up the week in the garden', { times: '17:00', days: 'Fri', nextDueAt: ahead(3 * 1440), lastFiredAt: ago(4 * 1440), file: 'house/garden/lanes/weekly.md' });
const tPull = trigger('tr-pull-0004', 'When the fence plan’s pull request changes', { sourceKind: 'pull-request', watches: 'acme/house#41', times: null, nextDueAt: null, lastFiredAt: ago(52), state: 'firing' });
const tAnswer = trigger('tr-answer-0005', 'When Alex answers about the pump filter', { sourceKind: 'answer', watches: 'in-pump', times: null, lifespan: 'once', nextDueAt: null, lastFiredAt: null, state: 'held' });
const tJob = trigger('tr-job-0006', 'When the seed order check stops', { sourceKind: 'job', watches: 'job-26', times: null, lifespan: 'once', nextDueAt: null, lastFiredAt: ago(3 * 1440), state: 'failed', enabled: false });
const tOnce = trigger('tr-once-0007', 'Remind Sam the timber is delivered on Thursday', { ownerKind: 'member', owner: 'alex', lifespan: 'once', times: '09:00', toKind: 'person', to: 'sam', nextDueAt: ahead(2 * 1440), lastFiredAt: null, project: null });
const tSpent = trigger('tr-once-0008', 'Ask about the mulch delivery', { lifespan: 'once', times: '12:00', state: 'fired', enabled: false, nextDueAt: null, lastFiredAt: ago(2 * 1440) });
const tStopped = trigger('tr-water-0009', 'Evening watering check', { times: '19:00', state: 'stopped', enabled: false, nextDueAt: null, lastFiredAt: ago(11 * 1440) });
const tToday = trigger('tr-today-0010', 'Check the cold frame every two hours', { lifespan: 'today', times: '10:00, 12:00, 14:00, 16:00', nextDueAt: ahead(40), lastFiredAt: ago(80) });
const tBackup = trigger('tr-backup-0011', 'Nightly backup of the household records', { ownerKind: 'household', owner: null, targetKind: 'operation', target: 'household.backup', toKind: null, to: null, times: '02:15', project: null, nextDueAt: ahead(800), lastFiredAt: ago(640) });
const tMoss = trigger('tr-pump-0012', 'Read the pump log', { owner: 'moss', to: 'moss', project: 'pond', times: '06:45' });
const fernTriggers = [tWalk, tFrost, tWeek, tPull, tAnswer, tJob, tOnce, tSpent, tStopped, tToday];
const event = (seq: number, t: Trigger, minutes: number, name: string, note = ''): Event => ({ trigger: t.id, seq, at: ago(minutes), event: name, note });
const dayLog: Event[] = [
  event(101, tWalk, 310, 'fired'), event(102, tToday, 250, 'fired'), event(103, tFrost, 145, 'failed'), event(104, tFrost, 145, 'failure', 'The forecast service did not answer in 30 s.'),
  event(105, tToday, 130, 'missed', '2 more, the last at time: 14:00'), event(106, tToday, 80, 'fired'), event(107, tPull, 52, 'fired'),
  event(108, tStopped, 45, 'stopped', 'Next due ' + ahead(120)), event(109, tAnswer, 30, 'held'), event(110, tMoss, 20, 'fired'),
];
const dayOutcomes: Outcome[] = [
  { event: 101, kind: 'mail', state: 'done', reason: null }, { event: 102, kind: 'mail', state: 'done', reason: null },
  { event: 106, kind: 'mail', state: 'failed', reason: 'The agent’s machine was offline.' }, { event: 106, kind: 'notice', state: null, reason: null },
  { event: 107, kind: 'mail', state: 'running', reason: null },
];
const tempoData = (triggers: Trigger[], pauses: AgentPause[] = [], log: Event[] | 'offline' = dayLog, outcomes: Outcome[] = dayOutcomes): Data => ({
  Tempo: { tempoTimezone: zone, triggers, agentPauses: pauses },
  BrickTempoClock: { deskTime: { at: Date.now() } },
  TempoDayHistory: log === 'offline' ? 'offline' : { triggerLog: log, tempoCalendarOutcomes: outcomes },
});

// ── One trigger ─────────────────────────────────────────────────────────────────────────────────────────────────
const runOf = (n: number, minutes: number, state: string | null, over: Partial<TriggerRun> = {}): TriggerRun => ({
  event: n, kind: 'mail', at: ago(minutes),
  job: state ? { state, startedAt: ago(minutes), endedAt: state === 'running' ? null : ago(minutes - 6) } : null,
  usage: state && state !== 'running' ? { tokensOut: 4200 + n * 310, largestContext: 61000 + n * 900, wallMs: 372000 + n * 1000 } : null,
  conversation: state ? { id: `cv-walk-${String(n).padStart(4, '0')}`, venue: 'tempo', place: 'tempo' } : null, ...over,
});
const walkRuns: TriggerRun[] = [runOf(9, 310, 'done'), runOf(8, 1750, 'done'), runOf(7, 3190, 'lost'), runOf(6, 4630, 'done'), runOf(5, 6070, null), runOf(4, 7510, 'done'), runOf(3, 8950, 'stopped')];
const logOf = (id: string, rows: [number, string, string][]): TriggerEvent[] => rows.map(([minutes, name, note], n) => ({ seq: 400 - n, trigger: id, at: ago(minutes), event: name, note }));
const walkLog = logOf(tWalk.id, [
  [310, 'fired', ''], [1750, 'fired', ''], [3190, 'failed', ''], [3190, 'failure', 'The job was lost: its machine stopped answering.'], [4630, 'fired', ''],
  [6070, 'fired', ''], [7400, 'changed', 'times 07:00 → 07:30'], [7510, 'fired', ''], [8950, 'fired', ''], [9 * 1440, 'resumed', 'agent resumed by alex'],
  [10 * 1440, 'held', 'agent paused by alex'], [11 * 1440, 'missed', 'more than 3 more, the last at time: 07:00'], [60 * 1440, 'created', 'set by fern'],
]);
const triggerData = (t: Trigger, over: { pauses?: AgentPause[]; runs?: TriggerRun[]; log?: TriggerEvent[]; history?: 'offline'; program?: object | null; journal?: object | null } = {}): Data => ({
  TempoCard: { tempoTimezone: zone, triggers: [t], agentPauses: over.pauses ?? [] },
  TriggerHistory: over.history ?? { tempoRecentRuns: over.runs ?? [], triggerLog: over.log ?? [] },
  ProgramDetails: { tempoProgram: over.program ?? null },
  JournalDetails: { tempoJournal: over.journal ?? null },
  DeskAgentDirectory: directory, DeskAgentDisplays: displays,
});
const journal = {
  lessons: 'The north bed drains slowly: do not call it dry on the morning after rain.\nSam waters the greenhouse on Tuesdays, so skip it then.\nPhotos from the shed camera before 07:15 are too dark to read in winter.',
  state: '{\n  "lastBed": "kitchen garden",\n  "openQuestions": ["row 4 leaf spot"],\n  "picked": { "kale": "2026-11-25", "leeks": "2026-11-21" }\n}',
  stateChangedAt: ago(305),
};
const frostProgram = {
  program: { name: 'frost-watch', when: { forecast: 'min-temperature', below: 2, within: '18h' }, then: { wake: 'fern', words: 'Cover the seedlings tonight.' }, otherwise: 'skip' },
  programState: { lastForecast: 3.4, lastChecked: ago(145), coveredOn: ['2026-11-19', '2026-11-22'] },
  lastResult: 'Skipped: the lowest forecast for tonight is 3.4 °C.',
};

export const scenes: BrickScenes[] = [
  { brick: 'agent', scenes: [
    { name: 'default', params: { agent: 'fern' }, data: agentData() },
    { name: 'idle', params: { agent: 'moss' }, data: agentData({
      DeskDoing: doing([]), DeskDoingAll: doing([]), BrickAssigned: tickets([]),
      BrickAgentJobs: { jobs: [job(12, 'Read the pump log', 'done', 300, 296, 'cv-moss-0012'), job(11, 'Read the pump log', 'done', 1740, 1735, 'cv-moss-0011')] },
    }) },
    { name: 'waiting-on-you', params: { agent: 'art' }, flag: 'Waiting on you', data: agentData({
      DeskDoing: doing([]), DeskDoingAll: doing([]), BrickAgentJobs: { jobs: [] },
      BrickAssigned: tickets([['t-1', 'Decide where the compost bays go', 'open'], ['t-2', 'Replace the pump filter', 'in_progress'], ['t-4', 'Greenhouse vents stick', 'open'], ['t-5', 'Net the brassicas', 'open'], ['t-8', 'Oil the shed door', 'open'], ['t-9', 'Sharpen the secateurs', 'open']]),
    }) },
    { name: 'new-agent', params: { agent: 'juniper' }, only: ['primary', 'side'], data: agentData({
      DeskDoing: doing([]), DeskDoingAll: doing([]), BrickAgentJobs: { jobs: [] }, BrickAssigned: tickets([]),
      DeskHomeComms: { homeComms: { member: 'alex', agents: owned, summaries: [] } },
    }) },
    { name: 'partly-unavailable', params: { agent: 'fern' }, only: ['primary', 'side'], data: agentData({ DeskDoing: 'offline', DeskDoingAll: 'offline', BrickAgentJobs: 'offline', BrickAssigned: 'offline' }) },
    { name: 'loading', params: { agent: 'fern' }, only: ['side'], data: agentData({ DeskAgentProfiles: 'loading' }) },
    { name: 'unavailable', params: { agent: 'heron' }, data: agentData() },
  ] },
  { brick: 'agents', scenes: [
    { name: 'default', params: {}, data: {
      DeskRoster: roster(), DeskAgentStatus: statuses(), DeskWaitingCounts: waiting(), DeskAgentDirectory: directory, DeskAgentDisplays: displays,
      DeskDoing: doingBy({ fern: fernDoing.slice(0, 4), reed: [item({ id: 'job-mail-1', kind: 'discord', place: '#receipts' })] }, { fern: 1 }),
      BrickAgentsAtWork: { agentsAtWork: ['fern', 'reed'] },
    } },
    { name: 'all-quiet', params: {}, data: {
      DeskRoster: roster(['fern', 'moss', 'art']), DeskAgentStatus: statuses({ fern: ['idle', ''], art: ['idle', ''] }), DeskWaitingCounts: waiting({ fern: 0, moss: 0, art: 0 }),
      DeskAgentDirectory: directory, DeskAgentDisplays: displays, DeskDoing: doing([]), BrickAgentsAtWork: { agentsAtWork: [] },
    } },
    { name: 'empty', params: {}, data: {
      DeskRoster: roster([]), DeskAgentStatus: { agentStatus: [] }, DeskWaitingCounts: waiting({}), DeskAgentDirectory: directory, DeskAgentDisplays: displays, DeskDoing: doing([]), BrickAgentsAtWork: { agentsAtWork: [] },
    } },
    { name: 'unavailable', params: {}, data: {
      DeskRoster: 'offline', DeskAgentStatus: 'offline', DeskWaitingCounts: 'offline', DeskAgentDirectory: 'offline', DeskDoing: 'offline', BrickAgentsAtWork: 'offline',
    } },
  ] },
  { brick: 'session', scenes: [
    { name: 'default', params: { session: 'cv-fence-0001' }, data: sessionData('running') },
    { name: 'done', params: { session: 'cv-fence-0001' }, flag: 'Finished', data: sessionData('done', { queued: 180, steps: doneSteps, report: fenceReport, detail: { endedAt: ago(128), endedNote: 'Finished: the plan is written and the two prices are compared.' } }) },
    { name: 'failed', params: { session: 'cv-fence-0001' }, flag: 'Failed', data: sessionData('failed', { queued: 95, steps: steps.slice(0, 18), detail: {
      endedAt: ago(70), endedNote: 'The harness left with status 1 after 25 minutes.',
      logTail: 'npx markdownlint house/garden/fence-plan.md\nhouse/garden/fence-plan.md:58 MD056/table-column-count Table column count [Expected: 4; Actual: 5]\nError: the session’s token budget was spent (200000 of 200000)\n    at Harness.turn (file:///opt/loom/runtime/harness.js:412:17)\n    at async Body.run (file:///opt/loom/runtime/body.js:88:5)\nexit 1',
    } }) },
    { name: 'queued', params: { session: 'cv-fence-0001' }, only: ['primary', 'side'], data: sessionData('queued', { queued: 1, steps: [], detail: { claimedAt: null } }) },
    { name: 'no-trace', params: { session: 'cv-walk-0009' }, data: sessionData('done', { venue: 'tempo', title: 'Morning walk-round of the beds', queued: 310, steps: [], detail: { brief: walkWords, endedAt: ago(304), endedNote: null } }) },
    { name: 'steps-erased', params: { session: 'cv-fence-0001' }, only: ['primary'], data: sessionData('done', { queued: 100 * 1440, steps: doneSteps.map((s) => ({ ...s, words: null })), detail: { endedAt: ago(100 * 1440 - 52), claimedAt: ago(100 * 1440 - 1) } }) },
    // A long session: the page holds its latest steps, and the earlier ones are a press away.
    { name: 'many-steps', params: { session: 'cv-fence-0001' }, only: ['primary'], data: sessionData('running', { queued: 300,
      steps: steps.map((s) => ({ ...s, seq: s.seq + 100 })), total: 100 + steps.length, earlier: stepsFrom(said.slice(0, 12)).map((s) => ({ ...s, clientId: s.clientId.replace('pair.0', 'pair.e') })) }) },
    { name: 'steps-unavailable', params: { session: 'cv-fence-0001' }, only: ['primary', 'side'], data: sessionData('running', { steps: 'offline' }) },
    { name: 'loading', params: { session: 'cv-fence-0001' }, only: ['side'], data: { ...sessionData('running'), BrickSession: 'loading' } },
    { name: 'unavailable', params: { session: 'cv-gone-0404' }, data: { ...sessionData('running'), BrickSession: { jobs: [], cv: null } } },
  ] },
  { brick: 'tempo', scenes: [
    { name: 'default', params: { agent: 'fern' }, data: tempoData([...fernTriggers, tBackup, tMoss]) },
    { name: 'agent-paused', params: { agent: 'fern' }, data: tempoData([tWalk, tFrost, tWeek], [{ agent: 'fern', since: ago(190) }], [event(101, tWalk, 310, 'fired'), event(111, tFrost, 60, 'held', 'Next due ' + ago(60))], [{ event: 101, kind: 'mail', state: 'done', reason: null }]) },
    { name: 'flagged', params: { agent: 'fern' }, flag: 'A firing failed', only: ['side', 'compact'], data: tempoData([tWalk, tFrost, tJob]) },
    { name: 'quiet-day', params: { agent: 'moss' }, only: ['primary', 'side'], data: tempoData([tMoss, tWalk], [], [], []) },
    { name: 'history-unavailable', params: { agent: 'fern' }, only: ['primary'], data: tempoData([tWalk, tWeek], [], 'offline') },
    { name: 'empty', params: { agent: 'art' }, data: tempoData([tMoss, tBackup], [], [], []) },
    { name: 'loading', params: { agent: 'fern' }, only: ['side'], data: { ...tempoData([]), Tempo: 'loading' } },
    { name: 'unavailable', params: { agent: 'fern' }, data: { Tempo: 'offline', BrickTempoClock: 'offline', TempoDayHistory: 'offline' } },
    // The desktop's Create trigger, opened by its press: as it opens, and for the household's sweep watching a job.
    { name: 'creating', params: { agent: 'fern' }, only: ['primary'], press: ['New trigger…'], data: tempoData([...fernTriggers, tBackup, tMoss]) },
    { name: 'creating-operation', params: { agent: 'fern' }, only: ['primary'], press: ['New trigger…', 'A job stopping', 'The household', 'An operation'], data: tempoData([...fernTriggers, tBackup, tMoss]) },
  ] },
  { brick: 'trigger', scenes: [
    { name: 'default', params: { trigger: tWalk.id }, data: triggerData(tWalk, { runs: walkRuns, log: walkLog, journal }) },
    { name: 'asking-stop', only: ['side'], press: ['Stop…'], params: { trigger: tWalk.id }, data: triggerData(tWalk, { runs: walkRuns, log: walkLog, journal }) },
    { name: 'program', params: { trigger: tFrost.id }, data: triggerData(tFrost, {
      program: frostProgram, journal: { lessons: '', state: '', stateChangedAt: null },
      runs: [runOf(21, 145, null, { kind: 'program' }), runOf(20, 385, 'done', { kind: 'program' }), runOf(19, 1585, 'done')],
      log: logOf(tFrost.id, [[145, 'program', 'Skipped: the lowest forecast for tonight is 3.4 °C.'], [385, 'fired', ''], [1585, 'fired', ''], [30 * 1440, 'created', 'set by fern']]),
    }) },
    { name: 'paused', params: { trigger: tWalk.id }, data: triggerData(tWalk, { pauses: [{ agent: 'fern', since: ago(190) }], runs: walkRuns.slice(0, 2), log: walkLog }) },
    { name: 'failed', params: { trigger: tWalk.id }, flag: 'Failed', data: triggerData(tWalk, { runs: [runOf(10, 14, 'failed'), ...walkRuns], log: [...logOf(tWalk.id, [[14, 'failed', ''], [14, 'failure', 'The agent’s machine was offline.']]).map((e, n) => ({ ...e, seq: 500 - n })), ...walkLog] }) },
    { name: 'firing-on-a-pull-request', params: { trigger: tPull.id }, only: ['primary', 'side'], data: triggerData(tPull, { runs: [runOf(31, 52, 'running')], log: logOf(tPull.id, [[52, 'fired', 'acme/house#41 · checks passing'], [5 * 1440, 'created', 'set by fern']]) }) },
    { name: 'once-for-a-person', params: { trigger: tOnce.id }, only: ['primary', 'side'], data: triggerData(tOnce, { log: logOf(tOnce.id, [[400, 'created', 'set by alex']]) }) },
    { name: 'household-operation', params: { trigger: tBackup.id }, only: ['primary', 'side'], data: triggerData(tBackup, { runs: [], log: logOf(tBackup.id, [[640, 'fired', ''], [2080, 'fired', '']]) }) },
    { name: 'stopped', params: { trigger: tStopped.id }, data: triggerData(tStopped, { runs: walkRuns.slice(3, 5), log: logOf(tStopped.id, [[11 * 1440 - 30, 'stopped', 'stopped by alex'], [11 * 1440, 'fired', '']]) }) },
    { name: 'history-unavailable', params: { trigger: tWeek.id }, only: ['primary'], data: triggerData(tWeek, { history: 'offline' }) },
    { name: 'loading', params: { trigger: tWalk.id }, only: ['side'], data: { ...triggerData(tWalk), TempoCard: 'loading' } },
    { name: 'unavailable', params: { trigger: 'tr-gone-0404' }, data: triggerData(tWalk) },
  ] },
];
