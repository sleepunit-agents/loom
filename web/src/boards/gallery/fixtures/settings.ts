/** Gallery fixtures (development only) for the bricks that run the household: secrets, machines, subscriptions,
 * usage, bridges, household and sharing. Each answer has the shape the brick's own selection decodes. A selection
 * with no name (`{ householdSetup ... }`) is answered under the key `''`; where a brick has two of those, one
 * answer holds both selections' fields. The household: members alex (owner), sam, robin; agents fern, moss, art;
 * projects garden, pond, greenhouse. */
import type { BrickScenes, Scene } from '../scenes';
import { ago, ahead } from './time';

const deskTime = { deskTime: { at: Date.now(), timezone: 'Europe/Amsterdam' } };
const owner = { householdSetup: { defaultAgent: 'fern' } };
const notOwner = { householdSetup: null };
const agentRows = [{ id: 'fern', removedAt: null }, { id: 'moss', removedAt: null }, { id: 'art', removedAt: null }, { id: 'reed', removedAt: ago(60 * 24 * 40) }];

// ── secrets ────────────────────────────────────────────────────────────────────────────────────────────────
const secretNames: [string, string, string, number][] = [
  ['GITHUB_TOKEN', 'Fine-grained token for the household organisation: contents and pull requests on garden, pond and greenhouse.', 'alex', 60 * 24 * 3],
  ['WEATHER_API_KEY', 'Forecast service for the watering schedule.', 'alex', 60 * 24 * 12],
  ['PUMP_CONTROLLER_PASSWORD', 'Local admin of the pond pump controller at 192.168.4.20. Rotates every quarter.', 'sam', 60 * 24 * 31],
  ['SEED_SUPPLIER_LOGIN', 'Account at the seed supplier, for reorders.', 'alex', 60 * 24 * 58],
  ['SLACK_BOT_TOKEN', 'Bot token of the household workspace bridge.', 'alex', 60 * 24 * 75],
  ['SLACK_APP_TOKEN', 'App-level token of the household workspace bridge.', 'alex', 60 * 24 * 75],
  ['GREENHOUSE_SENSOR_HUB_KEY', '', 'robin', 60 * 24 * 90],
  ['BACKUP_BUCKET_ACCESS_KEY_ID_FOR_THE_OFFSITE_COPY', 'Read and write on the off-site backup bucket.', 'alex', 60 * 24 * 120],
  ['BACKUP_BUCKET_SECRET', 'Pairs with the access key above.', 'alex', 60 * 24 * 120],
];
const secretRows = secretNames.map(([name, description, changedBy, minutes]) => ({ name, description, changedBy, changedAt: ago(minutes) }));
const request = (id: string, secret: string, agent: string, state: string, why: string, over: object = {}) => ({
  id, secret, agent, job: 'job-' + id, conversation: 'cv-' + id, why, state, minutes: 30, answeredBy: state === 'pending' ? null : 'alex', always: false,
  askedAt: ago(14), answeredAt: state === 'pending' ? null : ago(9), ...over,
});
const secretsData = (over: object = {}) => ({
  secretsReader: { id: 'alex', defaultAnswer: 'ask' },
  secrets: secretRows,
  secretGrants: [
    { id: 'g-1', secret: 'GITHUB_TOKEN', agent: 'fern', job: null, request: null, grantedBy: 'alex', grantedAt: ago(60 * 5), expiresAt: ahead(60 * 19) },
    { id: 'g-2', secret: 'GITHUB_TOKEN', agent: 'moss', job: 'job-rebase-greenhouse-vents', request: 'rq-3', grantedBy: 'alex', grantedAt: ago(42), expiresAt: ahead(18) },
    { id: 'g-3', secret: 'WEATHER_API_KEY', agent: 'fern', job: null, request: null, grantedBy: 'rule', grantedAt: ago(60 * 2), expiresAt: ahead(60 * 22) },
    { id: 'g-4', secret: 'SLACK_BOT_TOKEN', agent: 'art', job: null, request: null, grantedBy: 'alex', grantedAt: ago(60 * 24), expiresAt: ahead(60 * 24 * 6) },
  ],
  secretRequests: [
    request('rq-1', 'PUMP_CONTROLLER_PASSWORD', 'moss', 'pending', 'The pump reads low twice an hour. I need the controller\'s admin page to read its fault log and restart the flow sensor.', { minutes: 30, askedAt: ago(6) }),
    request('rq-2', 'SEED_SUPPLIER_LOGIN', 'fern', 'pending', 'Reorder the winter lettuce and check whether the back-ordered tomato seed has shipped.', { minutes: 15, askedAt: ago(47), job: null }),
    request('rq-3', 'GITHUB_TOKEN', 'moss', 'allowed', 'Rebase the greenhouse vents branch.', { askedAt: ago(44), answeredAt: ago(42) }),
    request('rq-4', 'BACKUP_BUCKET_SECRET', 'art', 'denied', 'Check last night\'s backup.', { askedAt: ago(60 * 26), answeredAt: ago(60 * 25), always: true }),
    request('rq-5', 'WEATHER_API_KEY', 'fern', 'allowed', 'Forecast for the watering schedule.', { askedAt: ago(60 * 50), answeredAt: ago(60 * 50), always: true }),
    request('rq-6', 'GREENHOUSE_SENSOR_HUB_KEY', 'moss', 'cancelled', 'Read the hub.', { askedAt: ago(60 * 80), answeredAt: ago(60 * 79) }),
    request('rq-7', 'GITHUB_TOKEN', 'art', 'revoked', 'Open a pull request on pond.', { askedAt: ago(60 * 100), answeredAt: ago(60 * 99) }),
  ],
  secretRules: [
    { secret: 'WEATHER_API_KEY', answer: 'auto', minutes: 1440 },
    { secret: 'BACKUP_BUCKET_SECRET', answer: 'never', minutes: 0 },
    { secret: 'GITHUB_TOKEN', answer: 'ask', minutes: 60 },
  ],
  secretRuleAgents: [
    { secret: 'WEATHER_API_KEY', agent: 'fern', when: 'at_start' },
    { secret: 'GITHUB_TOKEN', agent: 'fern', when: 'on_request' },
    { secret: 'GITHUB_TOKEN', agent: 'moss', when: 'on_request' },
  ],
  secretUses: [
    { id: 'u-1', secret: 'GITHUB_TOKEN', agent: 'moss', job: 'job-rebase-greenhouse-vents', at: ago(40), state: 'started' },
    { id: 'u-2', secret: 'GITHUB_TOKEN', agent: 'fern', job: 'job-lanes', at: ago(60 * 3), state: 'released' },
    { id: 'u-3', secret: 'GITHUB_TOKEN', agent: 'fern', job: 'job-trend', at: ago(60 * 4), state: 'failed' },
    { id: 'u-4', secret: 'GITHUB_TOKEN', agent: 'fern', job: 'job-older', at: ago(60 * 9), state: 'released' },
    { id: 'u-5', secret: 'WEATHER_API_KEY', agent: 'fern', job: 'job-water', at: ago(60 * 2), state: 'released' },
    { id: 'u-6', secret: 'SLACK_BOT_TOKEN', agent: 'art', job: 'job-bridge', at: ago(60 * 20), state: 'started' },
  ],
  secretChanges: [
    { id: 'c-1', secret: 'GITHUB_TOKEN', action: 'replace', by: 'alex', at: ago(60 * 24 * 3) },
    { id: 'c-2', secret: 'OLD_FTP_PASSWORD', action: 'removed', by: 'alex', at: ago(60 * 24 * 20) },
  ],
  ...over,
});
const secrets: Scene[] = [
  { name: 'default', params: {}, data: { ...deskTime, SettingsSecrets: secretsData() } },
  { name: 'flagged', params: {}, flag: 'New request', only: ['side', 'compact'], data: { ...deskTime, SettingsSecrets: secretsData() } },
  { name: 'quiet', params: {}, data: { ...deskTime, SettingsSecrets: secretsData({ secretRequests: [], secretGrants: [], secretUses: [], secrets: secretRows.slice(0, 2), secretRules: [], secretRuleAgents: [] }) } },
  { name: 'empty', params: {}, data: { ...deskTime, SettingsSecrets: { secretsReader: { id: 'alex', defaultAnswer: 'never' }, secrets: [], secretGrants: [], secretRequests: [], secretRules: [], secretRuleAgents: [], secretUses: [], secretChanges: [] } } },
  { name: 'not-owner', params: {}, only: ['primary', 'side'], data: { ...deskTime, SettingsSecrets: { secretsReader: null, secrets: [], secretGrants: [], secretRequests: [], secretRules: [], secretRuleAgents: [], secretUses: [], secretChanges: [] } } },
  { name: 'unavailable', params: {}, only: ['side'], data: { ...deskTime, SettingsSecrets: 'offline' } },
  { name: 'loading', params: {}, only: ['side'], data: { ...deskTime, SettingsSecrets: 'loading' } },
];

// ── machines ───────────────────────────────────────────────────────────────────────────────────────────────
const hosting = (ownerId: string, agents: [string, boolean][], over: object = {}) => ({ owner: ownerId, revokedAt: null, hostsAny: false, reportOnly: false, boxAgentsByBox: agents.map(([agent, lent]) => ({ agent, lent })), ...over });
const boxRows = [
  { id: 'box-shed', name: 'shed-server', ...hosting('alex', [['fern', false], ['moss', false], ['art', true]], { hostsAny: true }) },
  { id: 'box-studio', name: 'studio-mini', ...hosting('alex', [['fern', false]]) },
  { id: 'box-sam', name: 'sams-laptop-with-a-long-hostname.local', ...hosting('sam', [['moss', true]], { reportOnly: true }) },
  { id: 'box-old', name: 'old-nuc', ...hosting('alex', [], { revokedAt: ago(60 * 24 * 60) }) },
];
const reading = (box: string, kind: string, thing: string, over: object = {}) => ({ box, kind, thing, usedPercent: null, sizeMib: null, freeMib: null, engineStatus: null, level: 'ok', readAt: ago(2), unknownSince: null, stale: false, ...over });
const boxReadings = [
  reading('box-shed', 'disk', '/', { usedPercent: 93, sizeMib: 476_000, freeMib: 33_300, level: 'raised' }),
  reading('box-shed', 'disk', '/var/lib/loom', { usedPercent: 98, sizeMib: 953_000, freeMib: 19_000, level: 'urgent' }),
  reading('box-shed', 'memory', '', { freeMib: 412, level: 'raised' }),
  reading('box-shed', 'containers', '', { engineStatus: 200 }),
  reading('box-studio', 'disk', '/', { usedPercent: 41, sizeMib: 245_000, freeMib: 144_500 }),
  reading('box-studio', 'memory', '', { freeMib: 9_800 }),
  reading('box-studio', 'containers', '', { engineStatus: 500, level: 'raised', readAt: ago(4) }),
];
const inventory = (member: string, boxes = boxRows) => ({
  account: { member }, agents: agentRows, boxes,
  modelAccounts: [{ logins: [{ box: { id: 'box-studio' }, needsSignIn: true }, { box: { id: 'box-shed' }, needsSignIn: false }] }, {}],
});
const ownerMachines = (boxes = boxRows.filter((b) => b.owner === 'alex')) => ({
  boxes: boxes.map((b) => ({ ...b, readers: b.id === 'box-shed' ? ['art'] : [], readingsLeftOut: b.id === 'box-shed' ? 3 : 0 })),
  boxReadings, agents: [{ id: 'fern' }, { id: 'moss' }, { id: 'art' }],
});
const machineFacts = (boxes = boxRows) => ({
  boxes: boxes.map((b, i) => ({ id: b.id, sameMachineAsLoom: b.id === 'box-shed', lastSeenAt: b.id === 'box-old' ? ago(60 * 24 * 61) : b.id === 'box-sam' ? null : ago(1 + i * 3), slots: b.id === 'box-sam' ? null : b.id === 'box-shed' ? 4 : 1 })),
  boxAlertSettings: [{ diskPercent: 85, diskUrgentPercent: 95, diskFreeMib: 20_480, memoryFreeMib: 512 }],
});
const job = (id: string, agent: string, title: string, state: string, box: string, minutes: number) => ({ id, agent, title, state, box, conversation: 'cv-' + id, queuedAt: ago(minutes) });
const machineJobs = {
  j0: [job('mj-1', 'fern', 'Rebuild the watering schedule from this week\'s forecast', 'running', 'box-shed', 12), job('mj-2', 'fern', 'Summarise the pond pump log', 'done', 'box-shed', 300)],
  p0: [{ id: 'mj-p1', agent: 'fern', box: 'box-shed', state: 'running', queuedAt: ago(3) }],
  j1: [job('mj-3', 'moss', 'Rebase the greenhouse vents branch onto next and rerun the checks', 'starting', 'box-shed', 2), job('mj-4', 'moss', '', 'queued', 'box-shed', 1)],
  p1: [],
  j2: [job('mj-5', 'art', 'Draft the weekly household note', 'running', 'box-studio', 25)],
  p2: [],
};
const machinesScene = (name: string, over: Record<string, unknown> = {}, more: Partial<Scene> = {}): Scene => ({
  name, params: {}, data: { ...deskTime, '': inventory('alex'), OwnerMachines: ownerMachines(), BrickMachineFacts: machineFacts(), BrickHouseholdOwner: owner, BrickMachineJobs: machineJobs, ...over }, ...more,
});
const machines: Scene[] = [
  machinesScene('default'),
  machinesScene('member', { '': inventory('sam'), OwnerMachines: ownerMachines(boxRows.filter((b) => b.owner === 'sam')), BrickHouseholdOwner: notOwner }, { only: ['primary'] }),
  machinesScene('all-well', { '': { ...inventory('alex', boxRows.slice(1, 2)), modelAccounts: [] }, OwnerMachines: { ...ownerMachines(boxRows.slice(1, 2)), boxReadings: boxReadings.filter((r) => r.box === 'box-studio' && r.kind !== 'containers') }, BrickMachineFacts: machineFacts(boxRows.slice(1, 2)) }),
  machinesScene('empty', { '': { ...inventory('alex', []), modelAccounts: [] }, OwnerMachines: { boxes: [], boxReadings: [], agents: [] }, BrickMachineFacts: machineFacts([]) }),
  machinesScene('unavailable', { '': 'offline' }, { only: ['side'] }),
];

// ── subscriptions ──────────────────────────────────────────────────────────────────────────────────────────
const login = (box: [string, string], over: object = {}) => ({ box: { id: box[0], name: box[1] }, harness: 'claude-code', place: 'host', state: 'signed-in', expiresAt: ahead(60 * 24 * 20), checkedAt: ago(4), reporting: true, expired: false, needsSignIn: false, canRequest: false, ...over });
const shed: [string, string] = ['box-shed', 'shed-server'], studio: [string, string] = ['box-studio', 'studio-mini'];
const account = (id: string, label: string, provider: string, level: string, usage: number, over: object = {}) => ({
  __typename: 'RuntimeAccountDetail', label, level, id, owner: 'alex', provider, usage, usageReadAt: ago(7), resetsAt: ahead(60 * 3), hasRoom: usage < 0.95,
  signedInOn: [{ id: shed[0], name: shed[1] }], pendingSignIns: [], logins: [login(shed)],
  windows: [
    { window: 'five-hour', usage: Math.max(0, usage - 0.3), usageReadAt: ago(7), resetsAt: ahead(60 * 3), reserve: null },
    { window: 'week', usage, usageReadAt: ago(7), resetsAt: ahead(60 * 24 * 4), reserve: 0.1 },
  ], ...over,
});
const accounts = [
  account('acct-main', 'Household Max', 'anthropic', 'getting full', 0.64, { signedInOn: [{ id: shed[0], name: shed[1] }, { id: studio[0], name: studio[1] }], logins: [login(shed), login(shed, { place: 'containers' }), login(studio, { state: 'signed-out', needsSignIn: true, canRequest: true, expiresAt: null })] }),
  account('acct-spare', 'Alex\'s second subscription, kept for the long overnight runs', 'anthropic', 'almost full', 0.97, { logins: [login(shed, { expired: true, needsSignIn: true, canRequest: true, expiresAt: ago(60 * 5) })], pendingSignIns: [{ id: studio[0], name: studio[1] }] }),
  account('acct-codex', 'Sam\'s Codex', 'openai', 'plenty', 0.12, { owner: 'sam', logins: [login(['box-sam', 'sams-laptop'], { harness: 'codex', reporting: false, checkedAt: ago(60 * 30) })], signedInOn: [{ id: 'box-sam', name: 'sams-laptop' }],
    windows: [{ window: 'week', usage: 0.12, usageReadAt: ago(95), resetsAt: ahead(60 * 24 * 2), reserve: null }, { window: 'session', usage: null, usageReadAt: null, resetsAt: null, reserve: null }] }),
  { __typename: 'RuntimeAccountSummary', label: 'Robin\'s subscription', level: 'plenty' },
];
const runtimeAccounts = (modelAccounts: unknown[] = accounts) => ({
  deskTime: { timezone: 'Europe/Amsterdam' }, agents: agentRows,
  agentModels: [
    { agent: 'fern', model: 'claude-opus-4-5', position: 0 }, { agent: 'fern', model: 'claude-sonnet-4-5', position: 1 }, { agent: 'fern', model: 'gpt-5-codex', position: 2 },
    { agent: 'moss', model: 'claude-sonnet-4-5', position: 0 }, { agent: 'art', model: 'claude-opus-4-5', position: 0 }, { agent: 'reed', model: 'claude-haiku-4-5', position: 0 },
  ],
  modelAccounts,
});
const group = (key: string | null, title: string, share: number) => ({ key, title, share, href: null });
const weekly = ({ detailId }: Record<string, unknown>) => ({ modelAccounts: [{ id: detailId, label: 'Household Max', weeklyUsage: [
  { window: 'week', resetsAt: ahead(60 * 24 * 4), usage: 0.64, unattributed: 0.0312,
    agents: [group('fern', 'fern', 0.3841), group('moss', 'moss', 0.1722), group('art', 'art', 0.0525)],
    triggers: [group('tr-morning-0001', 'Morning watering check', 0.1204), group('tr-weekly-0002', 'Weekly household note', 0.0431), group(null, 'No trigger', 0.4453)],
    conversations: [group('cv-fence-0001', 'Rebuild the watering schedule from this week\'s forecast', 0.2114), group('cv-pump-0002', 'Pond pump reads low', 0.1432), group('cv-vents-0003', 'Greenhouse vents', 0.0911), group(null, 'Other conversations', 0.1631)] },
  { window: 'five-hour', resetsAt: ahead(60 * 3), usage: 0.34, unattributed: 0.01,
    agents: [group('fern', 'fern', 0.25), group('moss', 'moss', 0.08)], triggers: [group(null, 'No trigger', 0.33)], conversations: [group('cv-fence-0001', 'Rebuild the watering schedule from this week\'s forecast', 0.33)] },
] }] });
const setup = { subscriptionSetup: { member: 'alex', providers: ['anthropic', 'openai', 'google'], machines: [{ id: shed[0], name: shed[1] }, { id: studio[0], name: studio[1] }] } };
const subsScene = (name: string, over: Record<string, unknown> = {}, more: Partial<Scene> = {}): Scene => ({ name, params: {}, data: { RuntimeModelAccounts: runtimeAccounts(), WeeklySubscriptions: weekly, '': setup, ...over }, ...more });
const subscriptions: Scene[] = [
  subsScene('default'),
  subsScene('flagged', {}, { flag: 'Sign-in needed', only: ['side', 'compact'] }),
  subsScene('one', { RuntimeModelAccounts: runtimeAccounts([account('acct-main', 'Household Max', 'anthropic', 'plenty', 0.12)]), WeeklySubscriptions: { modelAccounts: [] } }),
  subsScene('summaries-only', { RuntimeModelAccounts: { ...runtimeAccounts([accounts[3], { __typename: 'RuntimeAccountSummary', label: 'Household Max', level: 'almost full' }]), agentModels: [] }, '': { subscriptionSetup: null } }, { only: ['primary', 'side'] }),
  subsScene('empty', { RuntimeModelAccounts: { ...runtimeAccounts([]), agentModels: [] } }),
  subsScene('unavailable', { RuntimeModelAccounts: 'offline' }, { only: ['side'] }),
];

// ── usage ──────────────────────────────────────────────────────────────────────────────────────────────────
const rollup = (key: string | null, title: string | null, totalTokens: number | null, jobCount: number, retryCount = 0, largestContext: number | null = 96_400, measured = jobCount) =>
  ({ key, title, totalTokens, jobCount, retryCount, largestContext, jobsWithLargestContext: measured });
const usageGroups = [
  rollup('cv-fence-0001', 'Rebuild the watering schedule from this week\'s forecast and last month\'s soil readings', 4_812_330, 14, 2, 187_200, 13),
  rollup('cv-pump-0002', 'Pond pump reads low', 2_204_118, 9, 1, 142_050),
  rollup('cv-vents-0003', 'Greenhouse vents: rebase and checks', 1_530_772, 6, 0, 121_900),
  rollup('th:board-alex-fern', 'Boards', 988_410, 22, 0, 88_300, 20),
  rollup('cv-note-0004', 'Weekly household note', 640_205, 4),
  rollup('cv-seed-0005', 'Seed reorder', 412_880, 3),
  rollup('cv-backup-0006', 'Check last night\'s backup', 305_114, 2, 3),
  rollup('cv-liner-0007', 'Pond liner quotes', 211_006, 2),
  rollup('cv-compost-0008', '', 120_450, 1),
  rollup('cv-hedge-0009', 'Hedge trimming rota', 98_200, 1),
  rollup('cv-tools-0010', 'Tool shed inventory', 64_030, 1),
  rollup(null, null, 41_900, 5, 0, null, 0),
  rollup('cv-frost-0011', 'Frost warning', null, 1, 0, null, 0),
];
const measurement = (tokensIn: number, tokensOut: number, over: object = {}) => ({
  harness: 'claude-code', model: 'claude-opus-4-5', source: 'harness', tokensIn, tokensOut, cacheRead: tokensIn * 6, cacheWritten: Math.round(tokensIn / 3), modelCalls: 41, toolCalls: 63,
  tools: [{ name: 'Bash', count: 28 }, { name: 'Read', count: 17 }, { name: 'Edit', count: 11 }, { name: 'Grep', count: 5 }, { name: 'mcp__loom__task', count: 2 }], firstContext: 21_400, largestContext: 187_200, wallMs: 1_284_000, ...over,
});
const usageJob = (id: string, title: string, runKind: string | null, state: string, usage: object | null, over: object = {}) => ({ id, title, runKind, linkedWakeJob: null, state, observations: [], usage, ...over });
const usageJobs = { conversationJobUsage: [
  usageJob('job-2f81c0aa', 'Rebuild the watering schedule from this week\'s forecast', 'main', 'done', measurement(412_300, 38_120), { observations: ['The context passed 180,000 tokens twice.', 'One retry after a harness restart.'] }),
  usageJob('job-9b33e1d4', 'Read the soil sensor exports', 'subagent', 'done', measurement(96_010, 7_450, { model: 'claude-sonnet-4-5', largestContext: 64_200, tools: [{ name: 'Read', count: 22 }] })),
  usageJob('job-71aa02c9', '', 'program', 'failed', measurement(12_400, 310, { tools: [], modelCalls: 2, toolCalls: 0, wallMs: 9_300 }), { linkedWakeJob: 'job-2f81c0aa' }),
  usageJob('job-c04d77e2', 'Draft the schedule table', 'main', 'running', null),
  usageJob('job-55e09b13', 'Compare against last year', null, 'stopped', measurement(40_220, 2_018, { harness: null, model: null, tools: null, source: 'estimate' })),
] };
const usageData = (groups = usageGroups) => ({ UsageConversations: { jobUsageRollup: groups }, UsageJobs: usageJobs });
const usage: Scene[] = [
  { name: 'default', params: { days: 7 }, data: usageData() },
  { name: 'month', params: { days: 30 }, only: ['primary', 'compact'], data: usageData([...usageGroups, ...Array.from({ length: 9 }, (_, i) => rollup('cv-older-00' + (20 + i), 'Earlier conversation ' + (i + 1), 30_000 - i * 2_500, 1))]) },
  { name: 'today-one', params: { days: 1 }, data: usageData(usageGroups.slice(3, 4)) },
  { name: 'empty', params: { days: 1 }, data: usageData([]) },
  { name: 'unavailable', params: { days: 7 }, only: ['side'], data: { UsageConversations: 'offline', UsageJobs: 'offline' } },
];

// ── bridges ────────────────────────────────────────────────────────────────────────────────────────────────
const connection = (id: string, agent: string, state: string, over: object = {}) => ({ id, platform: 'slack', agent, workspace: 'pondside-household', botUser: 'U07' + id.toUpperCase().replace(/[^A-Z0-9]/g, ''), tokenSecret: 'SLACK_BOT_TOKEN', appSecret: 'SLACK_APP_TOKEN', enabled: true, state, stateAt: ago(60 * 7), ...over });
const send = (id: string, channel: string, state: string, text: string, over: object = {}) => ({ id, incoming: 'in-' + id, connection: 'bc-fern', channel, thread: null, text, state, createdAt: ago(18), ...over });
const bridgeSends = [
  send('bs-1', '#garden', 'held', 'The tomato seed is back-ordered until the 9th. I can switch the order to the supplier in Leiden, which costs 4 euro more and arrives Thursday. Shall I?', { thread: '1732711200.000400' }),
  send('bs-2', '#pond-pump-and-filter-maintenance', 'uncertain', 'Pump restarted. Flow is back to 38 l/min.', { createdAt: ago(55), connection: 'bc-moss' }),
  send('bs-3', '#garden', 'pending', 'Watering moved to 06:30 tomorrow: rain is forecast from nine.', { createdAt: ago(2) }),
  send('bs-4', '@robin', 'sending', 'Your greenhouse key is in the blue pot.', { createdAt: ago(1) }),
  send('bs-5', '#general', 'held', 'Reminder: bins go out tonight.\n\nGreen and paper this week.', { createdAt: ago(60 * 4) }),
  send('bs-6', '#garden', 'sent', 'Done.', { createdAt: ago(60 * 9) }),
  send('bs-7', '#garden', 'dismissed', 'Never mind.', { createdAt: ago(60 * 12) }),
];
const bridgesData = (over: object = {}) => ({
  bridgeReader: { id: 'alex', manage: true },
  bridgeActivity: [{ id: 'bc-fern', received: 46, delivered: 41, held: 2 }, { id: 'bc-moss', received: 9, delivered: 8, held: 0 }],
  bridgeConnections: [
    connection('bc-fern', 'fern', 'connected'),
    connection('bc-moss', 'moss', 'reconnecting', { stateAt: ago(3) }),
    connection('bc-art', 'art', 'stopped', { enabled: false, workspace: 'allotment-association', appSecret: null, tokenSecret: 'ALLOTMENT_SLACK_BOT_TOKEN', stateAt: ago(60 * 24 * 9) }),
  ],
  bridgeChannelFilters: [
    { connection: 'bc-fern', channel: '#garden', rule: 'only' }, { connection: 'bc-fern', channel: '#general', rule: 'only' }, { connection: 'bc-fern', channel: '#random', rule: 'ignore' },
    { connection: 'bc-moss', channel: '#pond-pump-and-filter-maintenance', rule: 'only' },
  ],
  bridgeChannels: [
    { platform: 'slack', workspace: 'pondside-household', channel: '#garden', answers: 'fern', botsMayTalk: false },
    { platform: 'slack', workspace: 'pondside-household', channel: '#pond-pump-and-filter-maintenance', answers: 'moss', botsMayTalk: true },
    { platform: 'slack', workspace: 'allotment-association', channel: '#plots', answers: 'art', botsMayTalk: false },
  ],
  bridgePeople: [
    { platform: 'slack', workspace: 'pondside-household', user: 'U07ALEX01', member: 'alex' },
    { platform: 'slack', workspace: 'pondside-household', user: 'U07SAM002', member: 'sam' },
    { platform: 'slack', workspace: 'pondside-household', user: 'U07ROBIN3', member: 'robin' },
    { platform: 'slack', workspace: 'allotment-association', user: 'U99ALEX77', member: 'alex' },
  ],
  bridgeSends,
  ...over,
});
const reviewerOnly = { bridgeReader: { id: 'sam', manage: false }, bridgeActivity: [], bridgeConnections: [], bridgeChannelFilters: [], bridgeChannels: [], bridgePeople: [], bridgeSends: bridgeSends.slice(0, 2) };
const bridges: Scene[] = [
  { name: 'default', params: {}, data: { Bridges: bridgesData() } },
  { name: 'flagged', params: {}, flag: 'Held send', only: ['side', 'compact'], data: { Bridges: bridgesData() } },
  { name: 'reviewer', params: {}, data: { Bridges: reviewerOnly } },
  { name: 'nothing-waiting', params: {}, data: { Bridges: bridgesData({ bridgeSends: bridgeSends.slice(5) }) } },
  { name: 'empty', params: {}, data: { Bridges: bridgesData({ bridgeActivity: [], bridgeConnections: [], bridgeChannelFilters: [], bridgeChannels: [], bridgePeople: [], bridgeSends: [] }) } },
  { name: 'unavailable', params: {}, only: ['primary', 'side'], data: { Bridges: { ...reviewerOnly, bridgeReader: null } } },
  { name: 'offline', params: {}, only: ['side'], data: { Bridges: 'offline' } },
];

// ── household ──────────────────────────────────────────────────────────────────────────────────────────────
const setupAgent = (id: string, about: string, github: string[], over: object = {}) => ({ id, about, markBg: '#1f6f63', markFg: '#ffffff', faceShape: 'round', faceEyes: 'dots', github, removedAt: null, spriteVersion: null, ...over });
const token = (fingerprint: string, label: string, kind: string, identity: string, over: object = {}) => ({ fingerprint, label, kind, expired: false, identity, createdAt: ago(60 * 24 * 30), expiresAt: null, revokedAt: null, lastUsedAt: ago(12), ...over });
const browser = (ref: string, device: string, member: string | null, over: object = {}) => ({ ref, device, member, tokenLabel: 'Passkey', isAgent: false, ended: false, issuedAt: ago(60 * 24 * 6), seenAt: ago(3), ...over });
const householdSetup = {
  defaultAgent: 'fern',
  members: [
    { id: 'alex', role: 'owner', fullOwner: true, agents: ['fern', 'moss', 'art', 'reed'] },
    { id: 'sam', role: 'member', fullOwner: false, agents: ['moss', 'reed'] },
    { id: 'robin', role: 'member', fullOwner: false, agents: [] },
  ],
  agents: [
    setupAgent('fern', 'Keeps the garden: watering, seed orders and the weekly plan.', ['fern-bot']),
    setupAgent('moss', 'Looks after the pond and the greenhouse hardware, and writes most of the code.', ['moss-bot', 'pondside-ci']),
    setupAgent('art', '', [], { spriteVersion: 'v3' }),
    setupAgent('reed', 'Retired.', [], { removedAt: ago(60 * 24 * 40) }),
  ],
  tokens: [
    token('fp-worker-shed', 'shed-server worker', 'worker', 'box-shed'),
    token('fp-agent-fern', 'fern', 'agent', 'fern', { lastUsedAt: ago(1) }),
    token('fp-program-water', 'Watering controller script', 'program', 'alex', { expiresAt: ahead(60 * 24 * 60) }),
    token('fp-cli-alex', 'Alex\'s laptop command line', 'member', 'alex', { expired: true, expiresAt: ago(60 * 24 * 2), lastUsedAt: ago(60 * 24 * 4) }),
    token('fp-old-nuc', 'old-nuc worker', 'worker', 'box-old', { revokedAt: ago(60 * 24 * 60), lastUsedAt: null }),
  ],
  sessions: [
    browser('s-1', 'Firefox on macOS', 'alex'),
    browser('s-2', 'Safari on iPhone', 'alex', { seenAt: ago(60 * 5) }),
    browser('s-3', 'Chrome on Windows', 'sam', { seenAt: ago(60 * 26) }),
    browser('s-4', 'Headless Chrome on shed-server', 'alex', { isAgent: true, tokenLabel: 'fern', seenAt: ago(8) }),
    browser('s-5', 'Chrome on Android', 'robin', { ended: true, seenAt: ago(60 * 24 * 12) }),
  ],
};
const programSetup = { owner: 'alex', catalogue: { records: ['tickets', 'projects', 'comments', 'knowledge pages', 'approvals'], operations: ['tasks.command', 'comms.send', 'knowledge.write', 'boards.open'] }, tokens: [
  { fingerprint: 'fp-program-water', label: 'Watering controller script', member: 'alex', ended: false, records: ['tickets', 'projects'], operations: ['tasks.command'] },
  { fingerprint: 'fp-program-notes', label: 'Meeting notes importer', member: 'sam', ended: false, records: [], operations: [] },
  { fingerprint: 'fp-program-old', label: 'Old spreadsheet sync', member: null, ended: true, records: ['tickets'], operations: [] },
] };
const householdAnswer = (setupRow: object | null, programs: object | null = programSetup) => ({
  householdSetup: setupRow, boxes: boxRows.map(({ id, name, revokedAt }) => ({ id, name, revokedAt })), boxAlertSettings: machineFacts().boxAlertSettings, programSetup: programs,
});
const household: Scene[] = [
  { name: 'default', params: {}, data: { '': householdAnswer(householdSetup) } },
  { name: 'small', params: {}, data: { '': householdAnswer({ defaultAgent: null, members: [householdSetup.members[0]], agents: [householdSetup.agents[0]], tokens: [], sessions: [] }, { ...programSetup, tokens: [] }) } },
  { name: 'not-owner', params: {}, only: ['primary', 'side'], data: { '': householdAnswer(null, null) } },
  { name: 'unavailable', params: {}, only: ['side'], data: { '': 'offline' } },
];

// ── sharing ────────────────────────────────────────────────────────────────────────────────────────────────
const householdSharing = {
  members: ['alex', 'sam', 'robin'], agents: ['fern', 'moss', 'art'],
  projects: [
    { id: 'garden', name: 'Garden', goal: 'A kitchen garden that feeds four people from May to October without anybody watering by hand.', members: ['alex', 'sam', 'robin'], agents: ['fern', 'art'], repositories: ['github:Pondside/garden.git', 'github:pondside/watering-controller'] },
    { id: 'pond', name: 'Pond', goal: 'Clear water and a pump that reports its own faults.', members: ['alex', 'sam'], agents: ['moss'], repositories: ['github:pondside/pond'] },
    { id: 'greenhouse', name: 'Greenhouse vents, heating and the winter lettuce experiment', goal: null, members: ['robin'], agents: ['moss', 'fern'], repositories: [] },
    { id: 'compost', name: 'Compost', goal: '', members: [], agents: [], repositories: [] },
    { id: 'hedge', name: 'Hedge', goal: 'Trimmed twice a year.', members: ['sam'], agents: [], repositories: [] },
    { id: 'tool-shed', name: 'Tool shed', goal: 'Everything has a hook.', members: ['alex'], agents: ['art'], repositories: ['github:pondside/shed-inventory'] },
    { id: 'orchard', name: 'Orchard', goal: 'Three apple trees and a pear.', members: ['alex', 'robin'], agents: ['fern'], repositories: [] },
    { id: 'bees', name: 'Bees', goal: null, members: ['robin'], agents: [], repositories: [] },
  ],
};
const sharing: Scene[] = [
  { name: 'default', params: {}, data: { '': { householdSharing } } },
  { name: 'one', params: {}, data: { '': { householdSharing: { members: ['alex'], agents: ['fern'], projects: householdSharing.projects.slice(0, 1) } } } },
  { name: 'empty', params: {}, data: { '': { householdSharing: { members: ['alex'], agents: [], projects: [] } } } },
  { name: 'not-owner', params: {}, only: ['primary', 'side'], data: { '': { householdSharing: null } } },
  { name: 'unavailable', params: {}, only: ['side'], data: { '': 'offline' } },
];

export const scenes: BrickScenes[] = [
  { brick: 'secrets', scenes: [...secrets, { ...secrets[0], name: 'opened', only: ['primary'], press: ['Remove…'] }] },
  { brick: 'machines', scenes: [...machines, { ...machines[0], name: 'opened', only: ['primary'], press: ['shed-server'] }] },
  { brick: 'subscriptions', scenes: [...subscriptions, { ...subscriptions[0], name: 'opened', only: ['primary'], press: ['Household Max'] }] },
  { brick: 'usage', scenes: [...usage, { ...usage[0], name: 'opened', only: ['primary'], press: ['Jobs'] }] },
  { brick: 'bridges', scenes: [...bridges, { ...bridges[0], name: 'opened', only: ['primary'], press: ['Release send…'] }] },
  { brick: 'household', scenes: [...household, { ...household[0], name: 'opened', only: ['primary'], press: ['Revoke token…'] }] },
  { brick: 'sharing', scenes: sharing },
];
