/** Gallery fixtures for the bricks about what waits on the member: inbox, question, approvals, approval, threads.
 * One household throughout: alex (an owner, the one looking), sam and robin; the agents fern, moss and art; the
 * projects garden, pond and greenhouse. Development only (../scenes.ts). */
import type { BrickScenes } from '../scenes';
import { ago, ahead } from './time';

const directory = { memoryPeopleAccess: { directory: true }, memoryPeople: [
  { id: 'commons:fern', slug: 'fern', agent: null, name: 'Fern', kind: 'agent' },
  { id: 'commons:moss', slug: 'moss', agent: null, name: 'Moss', kind: 'agent' },
  { id: 'commons:art', slug: 'art', agent: null, name: 'Art', kind: 'agent' },
] };
const viewer = { homeComms: { member: 'alex' } };
const owner = { workAnswerOwner: true, workChangesRefresh: true, members: [{ id: 'alex', role: 'owner' }, { id: 'sam', role: 'member' }, { id: 'robin', role: 'member' }] };
const notOwner = { workAnswerOwner: false, workChangesRefresh: false, members: [] };

// ── Inbox items ─────────────────────────────────────────────────────────────────────────────────────────────────
type Body = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
interface Item {
  id: string; canAnswer: boolean; canSetVolume: boolean; quietUntil: string | null; source: string; sourceId: string | null; fromId: string | null;
  agent: string | null; project: string | null; thread: string | null; at: string; state: 'waiting' | 'taken' | 'done' | 'answered' | 'resolved';
  volume: 'full' | 'dim' | 'mute'; answers: 'yes-no' | 'words' | null; waitsOnKind: string | null; waitsOnId: string | null;
  bodyKeepUntil: string | null; answerKeepUntil: string | null; body: Body | null; read: boolean; refs: string[];
  answer: string | null; answerText: string | null; answeredBy: string | null; answeredAt: string | null; resolution: string | null;
  discussionAgent?: string | null;
}
const item = (id: string, over: Partial<Item>): Item => ({
  id, canAnswer: true, canSetVolume: true, quietUntil: null, source: 'agent', sourceId: null, fromId: null, agent: 'fern', project: 'garden', thread: null,
  at: ago(30), state: 'waiting', volume: 'full', answers: 'yes-no', waitsOnKind: null, waitsOnId: null, bodyKeepUntil: null, answerKeepUntil: null,
  body: { words: 'A question' }, read: false, refs: [], answer: null, answerText: null, answeredBy: null, answeredAt: null, resolution: null, ...over,
});

const beds = item('in-beds', { at: ago(12), refs: ['t-3'], body: {
  words: 'The raised beds on the south side are drying out faster than the schedule assumes. Should I move them from every third day to every second day until the first frost?',
  why: 'Soil moisture at 10 cm has been under 18% on four of the last six mornings, and the lettuce in bed 2 is starting to bolt.',
  ifYes: 'I change the irrigation schedule tonight and add about 40 litres a week to the rain-barrel draw.',
  ifNo: 'The schedule stays as it is and I check again after the weekend rain.' } });
const filter = item('in-filter', { at: ago(95), agent: 'moss', project: 'pond', refs: ['t-7', 't-12'], read: true, body: {
  words: 'Replace the pond pump filter, or clean the old one again?', why: 'It clogged twice this month and flow is down a third.',
  ifYes: 'I order the 40-micron cartridge; it arrives Thursday.', ifNo: 'I clean the old one on Saturday and log the flow after.' } });
const seedOrder = item('in-seeds', { at: ago(260), answers: 'words', agent: 'fern', project: 'greenhouse', refs: ['t-21'], body: {
  words: 'Which tomato varieties do you want started in the greenhouse this winter? I have room for three trays.',
  why: 'The seed order closes on Friday and last year’s San Marzano did poorly under the grow lights.', link: 'https://seeds.example.test/winter-catalogue' } });
const merge = item('in-merge', { at: ago(400), source: 'approval', sourceId: 'a-merge', waitsOnKind: 'approval', waitsOnId: 'a-merge', agent: 'art', project: 'pond', refs: ['a-merge'],
  body: { words: 'Merge “Read the pump pressure twice before alarming”?', why: 'Checks pass and Sam reviewed it.' } });
const taskAsk = item('in-task', { at: ago(600), source: 'task', sourceId: 't-9', waitsOnKind: 'task', waitsOnId: 't-9', agent: 'moss', project: 'pond', refs: ['t-9'], canAnswer: false, canSetVolume: false,
  body: { words: 'Is the old liner worth patching, or should I plan for a new one?', why: 'Three patches so far this year; the fourth leak is near the inlet.',
    ifYes: 'I patch it this week and reopen the ticket if it leaks again.', ifNo: 'I price a new 6 × 4 m liner and write up the swap.' } });
const join = item('in-join', { at: ago(45), source: 'notice', sourceId: 'worker-join:3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f:K7QX-M2NP', agent: null, fromId: null, project: null, answers: null, canAnswer: false,
  canSetVolume: false, body: { words: 'A machine named “shed-pi” is asking to join the household as a worker.', why: 'It showed the code K7QX-M2NP. Let it in only if you started this yourself.' } });
const frost = item('in-frost', { at: ago(150), source: 'notice', sourceId: 'frost-warning', agent: null, project: 'greenhouse', answers: null, discussionAgent: 'fern', read: false,
  body: { words: 'Frost is forecast for Thursday night: −3 °C from about 2 AM.', why: 'The greenhouse heater is still on its summer setting.' } });
const disk = item('in-disk', { at: ago(1500), source: 'notice', sourceId: 'machine-disk', agent: null, project: null, answers: null, read: true, discussionAgent: 'art',
  body: { words: 'The machine “attic” has 6% of its disk left.', why: 'Backups have grown by 4 GB a week since October.' } });
const fyiDone = item('in-fyi-compost', { at: ago(2000), agent: 'fern', answers: null, read: true, volume: 'dim', quietUntil: ahead(4000), refs: ['t-14'],
  body: { words: 'The compost thermometer is back in range.\nIt read 58 °C this morning after two days at 40.' } });
const fyiPond = item('in-fyi-heron', { at: ago(3100), agent: 'moss', project: 'pond', answers: null, read: true,
  body: { words: 'The heron net is back up over the pond; I counted all eleven koi this morning.' } });
const answeredYes = item('in-net', { at: ago(4300), agent: 'moss', project: 'pond', state: 'answered', read: true, answer: 'yes', answeredBy: 'alex', answeredAt: ago(4200),
  body: { words: 'Put the heron net back over the pond this week?', why: 'A heron was on the camera twice on Tuesday.', ifYes: 'I put it up tomorrow morning.', ifNo: 'I leave it off and keep the camera alert on.' } });
const answeredWords = item('in-mulch', { at: ago(5800), agent: 'fern', state: 'answered', read: true, answers: 'words', answer: 'words', answeredBy: 'alex', answeredAt: ago(5700),
  answerText: 'Bark for the paths, straw for the beds. Skip the cocoa shell, the dog eats it.', refs: ['t-2'],
  body: { words: 'Which mulch should I order for the autumn top-up?', why: 'The supplier has bark, straw and cocoa shell in stock.' } });
const settled = item('in-gate', { at: ago(7400), source: 'task', sourceId: 't-5', waitsOnKind: null, agent: 'fern', state: 'resolved', read: true, refs: ['t-5'], canAnswer: false,
  resolution: 'Its task was closed before this was answered.', body: { words: 'Should the gate latch ticket wait for the new hinges?' } });
const dismissed = item('in-wasp', { at: ago(9000), agent: 'moss', state: 'done', read: true, answer: 'dismiss', answeredBy: 'sam', answeredAt: ago(8800),
  body: { words: 'Do you want me to keep watching the wasp nest by the shed?' } });
const privateAsk = item('in-thread', { at: ago(20), source: 'thread', agent: 'art', project: null, thread: 'th:board-alex-art', bodyKeepUntil: ahead(40000), answerKeepUntil: ahead(40000),
  body: { words: 'You mentioned moving the weekly summary to Sunday evening. Do you want that from this week?', ifYes: 'This Sunday at 6 PM, and every Sunday after.', ifNo: 'It stays on Monday morning.' } });

const all = [privateAsk, beds, join, filter, frost, seedOrder, merge, taskAsk, disk, fyiDone, fyiPond, answeredYes, answeredWords, settled, dismissed];
const needs = all.filter((row) => row.state === 'waiting' && row.answers).length;
const alerts = all.filter((row) => row.state === 'waiting' && row.source === 'notice' && !row.answers).length;
const fyi = all.filter((row) => row.state === 'waiting' && !row.answers).length;
const answered = all.filter((row) => ['answered', 'resolved', 'done'].includes(row.state)).length;
const folders = { needs, alerts, answered, fyi, all: all.length, agents: [{ id: 'fern', count: 5 }, { id: 'moss', count: 5 }, { id: 'art', count: 2 }] };
const results = [
  { id: 'r-1', at: ago(8), ok: false, text: 'Your answer to “Put the heron net back” was not saved: the connection dropped.', page: null, readAt: null },
  { id: 'r-2', at: ago(70), ok: true, text: 'Allowed: merge “Soften the pump alarm”.', page: null, readAt: null },
  { id: 'r-3', at: ago(3000), ok: true, text: 'Answered: mulch order.', page: null, readAt: ago(2900) },
];
const strip = ({ discussionAgent: _d, ...row }: Item) => row;
const inboxAnswer = { inboxItems: all.map(strip), inboxFolders: folders, inboxActionResults: results };
const inboxApprovals = { approvals: [{ id: 'a-merge', operation: null, what: 'Merge “Read the pump pressure twice before alarming”', details: '' }] };
const noTitles = { inboxProposalTitles: [] };
const inboxData = { Inbox: inboxAnswer, InboxApprovals: inboxApprovals, InboxProposalTitles: noTitles, DeskAgentDirectory: directory };
const emptyFolders = { needs: 0, alerts: 0, answered: 0, fyi: 0, all: 0, agents: [] };

const question = (row: Item) => ({ InboxItem: { inboxItem: { discussionAgent: null, ...row } }, InboxApprovals: inboxApprovals, InboxProposalTitles: noTitles, DeskAgentDirectory: directory });

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────────────────────
interface Card {
  id: string; kind: 'merge' | 'command' | 'setting' | 'dangerous'; target: string; actingFor: string; operation: string | null; what: string; why: string; agent: string;
  project: string | null; member: string | null; conversation: string | null; state: 'pending' | 'allowed' | 'denied' | 'used' | 'withdrawn' | 'expired';
  ask: string; ifYes: string; ifNo: string; details: string; changeSummary: string | null; askedAt: string; decidedBy: string | null; expiresAt: string | null;
}
const card = (id: string, over: Partial<Card>): Card => ({
  id, kind: 'command', target: 'shed-pi', actingFor: 'alex', operation: null, what: 'Run a command', why: 'It is needed.', agent: 'fern', project: 'garden', member: null,
  conversation: null, state: 'pending', ask: '', ifYes: 'It runs.', ifNo: 'It does not run.', details: '', changeSummary: null, askedAt: ago(60), decidedBy: null, expiresAt: null, ...over,
});
type Rec = { seq: number; at: string; event: string; approval: string; agent: string; note: string };

const head = '9f3c2b7a1d4e5f60718293a4b5c6d7e8f9012345';
const mergeCard = card('a-merge', { kind: 'merge', target: `github:hollow/pond-watch#48@${head}`, actingFor: 'sam', what: 'Merge “Read the pump pressure twice before alarming”',
  why: 'All four checks pass, Sam approved the review, and the false alarms on Tuesday and Thursday both came from single low readings.', agent: 'art', project: 'pond',
  ask: 'Merge pull request #48 into main now?', ifYes: 'The change is merged and the pond watcher restarts with the new reading rule.',
  ifNo: 'The pull request stays open and the alarm keeps firing on single readings.', askedAt: ago(400) });
const dangerous = card('a-drain', { kind: 'dangerous', target: 'pond/pump', actingFor: 'alex', what: 'Drain the pond to the lower mark', agent: 'moss', project: 'pond',
  why: 'The liner is leaking near the inlet and the patch needs a dry surface for at least six hours.',
  ask: 'Drain the pond to the lower mark tonight so the liner can be patched tomorrow morning?',
  ifYes: 'The pump runs for about three hours from 9 PM. The koi stay in the deep end; the plants on the shelf will be exposed until it is refilled.',
  ifNo: 'The pond keeps losing roughly 4 cm a day and I top it up from the mains each evening.',
  details: 'pump --drain --to lower-mark \\\n  --max-minutes 200 \\\n  --stop-if oxygen<5.5 \\\n  --notify alex,sam', askedAt: ago(35) });
const shell = card('a-prune', { kind: 'command', target: 'attic', what: 'Prune backups older than 90 days on attic', agent: 'art', project: null, member: 'alex',
  why: 'The disk is at 94% and the nightly backup failed twice for lack of room.', ask: 'Delete the backups older than 90 days on attic?',
  ifYes: 'About 61 GB is freed. The weekly and monthly snapshots are kept.', ifNo: 'Nothing is deleted and tonight’s backup will likely fail again.',
  details: 'restic -r /mnt/backup/loom forget \\\n  --keep-within 90d --keep-weekly 26 --keep-monthly 24 \\\n  --prune --verbose', askedAt: ago(180) });
const timings = { settleSeconds: 30, dimDays: 7, muteDays: 30 }, quicker = { settleSeconds: 120, dimDays: 3, muteDays: 14 };
const tempoCard = card('a-tempo', { kind: 'setting', target: 'tempo:agent:fern', what: 'Change Fern’s Tempo timings', agent: 'fern', project: null,
  why: 'Garden notices arrive in bursts at dawn; a longer settle time would fold them into one Inbox item.', ask: 'Change Fern’s Tempo timings?',
  ifYes: 'The new timings apply from the next notice.', ifNo: 'The timings stay as they are.',
  details: JSON.stringify({ who: { kind: 'agent', id: 'fern' }, before: timings, after: quicker }),
  changeSummary: `Tempo for agent fern: settle ${timings.settleSeconds} → ${quicker.settleSeconds} seconds; dim ${timings.dimDays} → ${quicker.dimDays} days; mute ${timings.muteDays} → ${quicker.muteDays} days`, askedAt: ago(900) });
const measureOff = { on: false, send_outside: false, outside_address: '', keep_days: 90 };
const measureOn = { on: true, send_outside: true, outside_address: 'https://otel.hollow-house.example.test/v1/metrics/household/loom-primary', keep_days: 14 };
const measuringCard = card('a-measure', { kind: 'setting', target: 'measuring', what: 'Turn Measuring on', agent: 'art', project: null,
  why: 'Two slow mornings this week could not be explained without timings.', ask: 'Turn Measuring on and send to the monitoring tool?',
  ifYes: 'loom starts recording timings and sends them out.', ifNo: 'Measuring stays off.', details: JSON.stringify({ before: measureOff, after: measureOn }),
  changeSummary: `Measuring: ${JSON.stringify(measureOff)} → ${JSON.stringify(measureOn)}`, askedAt: ago(1300) });
const household = card('a-house', { kind: 'setting', operation: 'household.change', target: 'household', what: 'Make Robin an owner of the household', agent: 'art', project: null,
  why: 'Robin now pays for two of the subscriptions and needs to answer their approvals.', ask: '', ifYes: '', ifNo: '',
  details: JSON.stringify({ change: 'members.role', member: 'robin', role: 'owner' }), askedAt: ago(2200) });
const allowed = card('a-heater', { kind: 'command', target: 'greenhouse-pi', what: 'Switch the greenhouse heater to its winter setting', agent: 'fern', project: 'greenhouse', state: 'used',
  why: 'Frost is forecast for Thursday night.', ask: 'Switch the heater to winter now?', ifYes: 'The heater holds 8 °C overnight.', ifNo: 'It stays on the summer setting.',
  details: 'heaterctl set --profile winter --min 8', askedAt: ago(3000), decidedBy: 'alex', expiresAt: null });
const denied = card('a-prune-old', { kind: 'dangerous', target: 'garden/orchard', what: 'Remove the old plum tree', agent: 'fern', project: 'garden', state: 'denied',
  why: 'It has silver leaf on two main limbs.', ask: 'Book the tree surgeon to remove the old plum?', ifYes: 'It is felled next week.', ifNo: 'It stays and I prune the infected limbs.',
  askedAt: ago(6000), decidedBy: 'sam' });
const standingAllowed = card('a-merge-old', { kind: 'merge', target: `github:hollow/garden-log#31@${'a'.repeat(40)}`, actingFor: 'alex', what: 'Merge “Log rainfall hourly”', agent: 'fern',
  project: 'garden', state: 'allowed', why: 'Checks pass.', ask: 'Merge pull request #31?', ifYes: 'It is merged.', ifNo: 'It stays open.', askedAt: ago(4500), decidedBy: 'alex', expiresAt: ahead(2800) });
const expired = card('a-expired', { kind: 'command', target: 'shed-pi', what: 'Restart the irrigation controller', agent: 'fern', project: 'garden', state: 'expired',
  why: 'It stopped answering after the power cut.', ask: 'Restart the controller on shed-pi?', ifYes: 'It restarts; watering resumes on schedule.', ifNo: 'Watering stays off until someone restarts it.',
  details: 'systemctl restart irrigation.service', askedAt: ago(11000) });
const withdrawn = card('a-withdrawn', { kind: 'setting', target: 'alerts:pond', what: 'Raise the pond low-water alert to 30 cm', agent: 'moss', project: 'pond', state: 'withdrawn',
  why: 'Superseded by the liner repair.', askedAt: ago(8000) });

const cards = [dangerous, shell, mergeCard, tempoCard, measuringCard, household, allowed, standingAllowed, denied, withdrawn, expired];
const record: Rec[] = [
  { seq: 1, at: ago(400), event: 'request', approval: 'a-merge', agent: 'art', note: '' },
  { seq: 2, at: ago(180), event: 'request', approval: 'a-prune', agent: 'art', note: 'Literal shell command' },
  { seq: 3, at: ago(35), event: 'request', approval: 'a-drain', agent: 'moss', note: '' },
  { seq: 10, at: ago(3000), event: 'request', approval: 'a-heater', agent: 'fern', note: 'Literal shell command' },
  { seq: 11, at: ago(2980), event: 'allow', approval: 'a-heater', agent: 'fern', note: 'alex' },
  { seq: 12, at: ago(2975), event: 'use', approval: 'a-heater', agent: 'fern', note: '' },
  { seq: 13, at: ago(2970), event: 'use', approval: 'a-heater', agent: 'fern', note: 'Reported step: Heater is holding 8 °C; next check at dawn.' },
  { seq: 20, at: ago(6000), event: 'request', approval: 'a-prune-old', agent: 'fern', note: '' },
  { seq: 21, at: ago(5900), event: 'deny', approval: 'a-prune-old', agent: 'fern', note: 'Denied by Sam: “Prune it first, we decide in spring.”' },
  { seq: 30, at: ago(4500), event: 'request', approval: 'a-merge-old', agent: 'fern', note: '' },
  { seq: 31, at: ago(4490), event: 'allow', approval: 'a-merge-old', agent: 'fern', note: 'alex' },
  { seq: 32, at: ago(4490), event: 'grant', approval: 'a-merge-old', agent: 'fern', note: 'Always for garden' },
];
const approvalsView = (list: Card[]) => ({ approvals: list, approvalRules: [{ kind: 'merge', scope: 'project:garden', person: '', tier: 'do', setBy: 'alex', setAt: ago(4490) }],
  approvalNotices: [], approvalRecord: record });
const rules = [
  { kind: 'merge', scope: 'project:garden', person: '', tier: 'do', setBy: 'alex', setAt: ago(4490) },
  { kind: 'command', scope: '*', person: '', tier: 'ask', setBy: 'alex', setAt: ago(40000) },
  { kind: 'setting', scope: 'project:greenhouse', person: 'sam', tier: 'tell', setBy: 'alex', setAt: ago(9000) },
  { kind: 'command', scope: 'pond/pump-*', person: '', tier: 'tell', setBy: 'sam', setAt: ago(12000) },
  { kind: 'dangerous', scope: '*', person: '', tier: 'ask', setBy: 'alex', setAt: ago(52000) },
];
const notices = [
  { id: 'n-vent', agent: 'fern', kind: 'setting', target: 'greenhouse/vents', what: 'Opened the greenhouse vents to a third: it reached 27 °C at noon.', at: ago(50) },
  { id: 'n-pump', agent: 'moss', kind: 'command', target: 'pond/pump-north', what: 'Restarted the north pump after it stalled for four minutes.', at: ago(620) },
  { id: 'n-mist', agent: 'fern', kind: 'setting', target: 'greenhouse/misting', what: 'Moved the misting from every two hours to every three.', at: ago(2100) },
  { id: 'n-filter', agent: 'moss', kind: 'command', target: 'pond/pump-south', what: 'Ran the south filter backwash.', at: ago(5200) },
];
const one = (a: Card, access: object = owner, change: object[] = []) => ({
  InlineApproval: { approvals: [a], approvalRecord: record.filter((r) => r.approval === a.id) }, WorkAnswerOwner: access, WorkViewer: viewer, ApprovalChange: { changes: change } });
const openChange = [{ id: 'github:hollow/pond-watch#48', state: 'open', agent: 'art', project: 'pond', headCommit: head }];

// ── Conversations ───────────────────────────────────────────────────────────────────────────────────────────────
export const thread = (id: string, title: string, agent: string, lastAt: string, over: object = {}) => ({ id, conversation: 'cv-' + id.slice(3), venue: 'comms', title, agent, project: null,
  member: 'alex', pinned: false, archivedAt: null, lastAt, readSeq: 0, working: false, stopRequested: false, unread: false, ...over });
export const open = [
  thread('th:board-alex-art', 'Boards', 'art', ago(4), { pinned: true, working: true }),
  thread('th:pond-liner', 'The pond liner: patch it again or replace it before winter', 'moss', ago(22), { project: 'pond', unread: true }),
  thread('th:beds', 'Watering the raised beds', 'fern', ago(75), { project: 'garden', working: true, unread: true }),
  thread('th:seeds', 'Winter seed order', 'fern', ago(260), { project: 'greenhouse' }),
  thread('th:weekly', 'Weekly summary, and whether it should move to Sunday evening', 'art', ago(900), { pinned: true }),
  thread('th:heron', 'Heron on the camera', 'moss', ago(1500), { project: 'pond', unread: true }),
  thread('th:frost', 'Frost plan for the greenhouse', 'fern', ago(2900), { project: 'greenhouse' }),
  thread('th:backups', 'Backups filling the attic machine', 'art', ago(4400)),
  thread('th:compost', 'Compost temperature', 'fern', ago(7000), { project: 'garden' }),
  thread('th:koi', 'Counting the koi', 'moss', ago(10200), { project: 'pond' }),
  thread('th:shed', 'Shed inventory', 'art', ago(15000)),
  thread('th:bulbs', 'Where the spring bulbs went', 'fern', ago(21000), { project: 'garden' }),
];
const archived = [
  thread('th:old-fence', 'Fence repair quotes', 'art', ago(40000), { archivedAt: ago(30000) }),
  thread('th:old-pump', 'Choosing the pond pump', 'moss', ago(52000), { archivedAt: ago(45000), project: 'pond' }),
  thread('th:old-plan', 'Planting plan for last spring', 'fern', ago(90000), { archivedAt: ago(80000), project: 'garden' }),
];
const home = { member: 'alex', agents: ['art', 'fern', 'moss'] };
export const threadsData = (rows: object[]) => ({ BoardsThreads: { homeComms: home, commsThreads: rows }, DeskAgentDirectory: directory });

export const scenes: BrickScenes[] = [
  { brick: 'inbox', scenes: [
    { name: 'default', params: { folder: 'needs' }, data: inboxData },
    { name: 'all', params: { folder: 'all' }, data: inboxData, only: ['primary', 'side'] },
    { name: 'answered', params: { folder: 'answered' }, data: inboxData, only: ['primary', 'side'] },
    { name: 'alerts', params: { folder: 'alerts' }, data: inboxData, only: ['primary', 'side'] },
    { name: 'errors', params: { folder: 'errors' }, data: inboxData, only: ['primary', 'side'] },
    { name: 'empty', params: { folder: 'needs' }, data: { ...inboxData, Inbox: { inboxItems: [], inboxFolders: emptyFolders, inboxActionResults: [] } } },
    { name: 'flagged', params: { folder: 'needs' }, data: inboxData, flag: 'New item', only: ['side', 'compact'] },
    { name: 'loading', params: { folder: 'needs' }, data: { ...inboxData, Inbox: 'loading' }, only: ['side'] },
    { name: 'unavailable', params: { folder: 'needs' }, data: { ...inboxData, Inbox: 'offline' }, only: ['primary', 'side'] },
  ] },
  { brick: 'question', scenes: [
    { name: 'default', params: { item: beds.id }, data: question(beds) },
    { name: 'words', params: { item: seedOrder.id }, data: question(seedOrder), only: ['primary', 'side'] },
    { name: 'private-thread', params: { item: privateAsk.id }, data: question(privateAsk), only: ['primary', 'side'] },
    { name: 'task-question', params: { item: taskAsk.id }, data: question(taskAsk), only: ['primary', 'side'] },
    { name: 'approval-elsewhere', params: { item: merge.id }, data: question(merge), only: ['primary', 'side'] },
    { name: 'machine-join', params: { item: join.id }, data: question(join) },
    { name: 'notice-discuss', params: { item: frost.id }, data: question(frost), only: ['primary', 'side'] },
    { name: 'quiet', params: { item: fyiDone.id }, data: question(fyiDone), only: ['primary', 'side'] },
    { name: 'answered', params: { item: answeredYes.id }, data: question(answeredYes) },
    { name: 'answered-words', params: { item: answeredWords.id }, data: question(answeredWords) },
    { name: 'settled', params: { item: settled.id }, data: question(settled), only: ['primary', 'side'] },
    { name: 'unavailable', params: { item: 'in-gone' }, data: { ...question(beds), InboxItem: 'offline' }, only: ['side'] },
  ] },
  { brick: 'approvals', scenes: [
    { name: 'default', params: { state: 'pending' }, data: { BrickApprovals: approvalsView(cards) } },
    { name: 'answered', params: { state: 'answered' }, data: { BrickApprovals: approvalsView(cards) }, only: ['primary', 'side'] },
    { name: 'empty', params: { state: 'pending' }, data: { BrickApprovals: { approvals: [], approvalRules: [], approvalNotices: [], approvalRecord: [] } } },
    { name: 'flagged', params: { state: 'pending' }, data: { BrickApprovals: approvalsView(cards) }, flag: 'New approval', only: ['side', 'compact'] },
    { name: 'unavailable', params: { state: 'pending' }, data: { BrickApprovals: 'offline' }, only: ['side'] },
    { name: 'rules', params: { state: 'rules' }, data: { BrickApprovalRules: { approvals: cards.map(({ id, state }) => ({ id, state })), approvalRules: rules } } },
    { name: 'no-rules', params: { state: 'rules' }, data: { BrickApprovalRules: { approvals: [], approvalRules: [] } }, only: ['primary', 'side'] },
    { name: 'notices', params: { state: 'notices' }, data: { BrickApprovalNotices: { approvals: cards, approvalNotices: notices, approvalRecord: record } } },
    { name: 'no-notices', params: { state: 'notices' }, data: { BrickApprovalNotices: { approvals: [], approvalNotices: [], approvalRecord: [] } }, only: ['primary', 'side'] },
  ] },
  { brick: 'approval', scenes: [
    { name: 'default', params: { approval: shell.id }, data: one(shell) },
    { name: 'dangerous', params: { approval: dangerous.id }, data: one(dangerous) },
    { name: 'merge-standing', params: { approval: mergeCard.id }, data: one(mergeCard, owner, openChange), only: ['primary', 'side'] },
    { name: 'tempo-change', params: { approval: tempoCard.id }, data: one(tempoCard), only: ['primary', 'side'] },
    { name: 'measuring-change', params: { approval: measuringCard.id }, data: one(measuringCard), only: ['primary', 'side'] },
    { name: 'household-change', params: { approval: household.id }, data: one(household, notOwner), only: ['primary', 'side'] },
    { name: 'not-yours-to-answer', params: { approval: dangerous.id }, data: one(dangerous, notOwner), only: ['side'] },
    { name: 'used', params: { approval: allowed.id }, data: one(allowed) },
    { name: 'allowed-until', params: { approval: standingAllowed.id }, data: one(standingAllowed), only: ['primary', 'side'] },
    { name: 'denied', params: { approval: denied.id }, data: one(denied) },
    { name: 'expired', params: { approval: expired.id }, data: one(expired), only: ['side', 'compact'] },
    { name: 'unavailable', params: { approval: 'a-gone' }, data: { ...one(shell), InlineApproval: 'offline' }, only: ['side'] },
  ] },
  { brick: 'threads', scenes: [
    { name: 'default', params: { scope: 'open' }, data: threadsData(open) },
    { name: 'archived', params: { scope: 'archived' }, data: threadsData(archived), only: ['primary', 'side'] },
    { name: 'empty', params: { scope: 'open' }, data: threadsData([]) },
    { name: 'unavailable', params: { scope: 'open' }, data: { BoardsThreads: 'offline', DeskAgentDirectory: directory }, only: ['side'] },
    // Delete… on the first row opens the question that names it, in place of that row's controls.
    { name: 'deleting', params: { scope: 'open' }, data: threadsData(open), press: ['Delete…'], only: ['primary'] },
    // The page is open on one of these conversations: its row has Pin and no Delete.
    { name: 'open-here', params: { scope: 'open' }, data: threadsData(open), here: (open[0] as { id: string }).id, only: ['primary'] },
  ] },
];
