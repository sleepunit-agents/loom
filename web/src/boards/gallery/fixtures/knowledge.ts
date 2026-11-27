/** Gallery fixtures (development only): what loom knows and who it knows, and the member's own account and
 * appearance. Bricks: knowledge-page, knowledge, person, people, activity, account, appearance. The shapes are the
 * raw answers of the reads those bricks make (memory/queries.ts, pieces/account/query.ts, shell/member-preferences.ts). */
import type { BrickScenes } from '../scenes';
import { ago, day } from './time';

const zone = { deskTime: { at: Date.now(), timezone: 'UTC' } };
const idle = { MemoryIdle: {}, DeskTime: zone };

// ── Knowledge ──────────────────────────────────────────────────────────────────────────────────────────────────
type Fresh = 'fresh' | 'aging' | 'due';
const row = (slug: string, title: string, domain: string, updatedDays: number, verifiedDays: number | null, fresh: Fresh, by: string | null = 'fern') => ({
  slug, title, domain, updated: ago(updatedDays * 1440), verified_at: verifiedDays === null ? null : ago(verifiedDays * 1440), fresh, by,
  recent: verifiedDays !== null && verifiedDays <= 7 ? true : null,
});
const pages = [
  row('pond-pump', 'The pond pump and its filter', 'garden/pond', 3, 2, 'fresh'),
  row('greenhouse-heating', 'How the greenhouse is heated through a cold week, and what to do when the thermostat disagrees with the thermometer', 'garden/greenhouse', 41, 38, 'aging', 'moss'),
  row('seed-orders', 'Seed orders and who supplies what', 'garden', 12, 5, 'fresh'),
  row('water-butts', 'Water butts and the overflow', 'garden', 96, 94, 'due', 'moss'),
  row('frost-dates', 'First and last frost dates', 'garden/greenhouse', 130, 121, 'due'),
  row('wifi-and-network', 'Wi-Fi, the router and the mesh points', 'house/network', 20, 6, 'fresh', 'art'),
  row('boiler-service', 'Boiler service and the engineer', 'house/heating', 75, null, 'aging', 'alex'),
  row('bin-days', 'Bin days', 'house', 8, 1, 'fresh', 'sam'),
  row('car-insurance', 'Car insurance renewal', 'paperwork/insurance', 200, 190, 'due', 'alex'),
  row('school-terms', 'School terms and inset days', 'family/school', 30, 28, 'fresh', 'robin'),
  row('vet', 'The vet, and what the cat is allergic to', 'family/pets', 55, 50, 'aging', 'fern'),
  row('loom-backups', 'Where loom is backed up', 'house/network', 15, 4, 'fresh', 'art'),
  row('compost', 'Compost bays: what goes where', 'garden', 61, null, 'aging', 'moss'),
  row('passport-renewals', 'Passport renewals', 'paperwork', 320, 300, 'due', 'alex'),
];
const knowledgeIndex = (list: typeof pages) => ({ memoryKnowledge: { timezone: 'UTC', total: list.length, checkDays: 90, recentDays: 7, pages: list } });
const access = (can: boolean) => ({ memoryKnowledgeAccess: { allowed: true, canAdd: can, canVerify: can, canRecheck: can } });
const found = { rows: [pages[0], pages[3], pages[12]].map(({ slug, title, domain, updated, verified_at }) => ({ slug, title, domain, updated, verified_at })) };

const pumpBody = `The pump sits in the chamber at the north end of the pond, under the slate lid. It runs all day from April to October and for four hours around noon in winter.

## Cleaning the filter

1. Switch it off at the outdoor socket by the shed, not at the timer.
2. Lift the foam blocks out and rinse them **in pond water**, never tap water.
3. Check the impeller turns freely before the lid goes back.

It needs doing about every three weeks in summer. A clogged filter shows first as a weak [[water-butts|overflow]] and a pump that reads low.

## Parts

| Part | Model | Last replaced |
| --- | --- | --- |
| Pump | Oase AquaMax Eco 6000 | 2024 |
| Foam set | 30 ppi, three blocks | this spring |
| UV lamp | 11 W PL-S | due each April |

The timer is set from the house:

\`\`\`
pump schedule --summer 06:00-22:00 --winter 10:00-14:00
\`\`\`

See also [[greenhouse-heating]] for the socket circuit the two share, and [[frost-dates]] for when to switch to the winter schedule.`;
const knowledgePage = (over: object = {}) => ({ memoryKnowledgePage: {
  ...pages[0], archiveCandidate: null, routineCheckDays: 90, body: pumpBody, sourcing: 'From the installer’s handover sheet and two seasons of Moss’s notes.',
  sources: [
    { claim: 'Pump model and flow rate', kind: 'document', locator: 'Handover sheet, page 2', href: null, excerpt: 'AquaMax Eco Premium 6000, 6000 l/h', retrievedAt: ago(60 * 1440), createdAt: ago(60 * 1440) },
    { claim: 'Rinse foam in pond water only', kind: 'web', locator: 'oase.com/en/guides/filter-care', href: 'https://www.oase.com/en/guides/filter-care', excerpt: 'Tap water kills the bacteria the filter depends on.', retrievedAt: ago(20 * 1440), createdAt: ago(20 * 1440) },
    { claim: 'Three-week cleaning interval', kind: 'conversation', locator: null, href: null, excerpt: 'Sam: it was clogged again after three weeks', retrievedAt: ago(9 * 1440), createdAt: ago(9 * 1440) },
  ],
  citedBy: [{ slug: 'water-butts', title: 'Water butts and the overflow' }, { slug: 'greenhouse-heating', title: pages[1].title }],
  annotations: [
    { id: 2, kind: 'note', actor: 'sam', words: 'The slate lid is cracked at one corner. Lift it from the house side.', evidence: '', created: ago(4 * 1440) },
    { id: 1, kind: 'intent', actor: 'alex', words: 'We mean to move the socket inside the shed before next winter.', evidence: 'Quote from the electrician, in Paperwork.', created: ago(33 * 1440) },
  ],
  checked: { at: ago(2 * 1440), outcome: 'confirmed', by: 'alex' },
  checks: [{ at: ago(2 * 1440), outcome: 'confirmed', by: 'alex' }, { at: ago(95 * 1440), outcome: 'stale', by: 'moss' }, { at: ago(190 * 1440), outcome: 'confirmed', by: null }],
  history: [],
  ...over,
} });
const stalePage = knowledgePage({
  ...pages[3], body: 'Two butts by the shed, one by the greenhouse. The overflow from the shed pair runs to the pond.\n\nThe tap on the left butt drips; a washer was ordered.\n\nNobody has checked whether the washer arrived.',
  archiveCandidate: true, sourcing: null, sources: [], citedBy: [], annotations: [{ id: 3, kind: 'outdated', actor: 'moss', words: 'The greenhouse butt was removed in the autumn.', evidence: '', created: ago(12 * 1440) }],
  checked: { at: ago(3 * 1440), outcome: 'stale', by: 'moss' }, checks: [{ at: ago(3 * 1440), outcome: 'stale', by: 'moss' }, { at: ago(94 * 1440), outcome: 'confirmed', by: 'alex' }],
});

// ── People ─────────────────────────────────────────────────────────────────────────────────────────────────────
const text = (value: string) => ({ text: value, number: null, boolean: null, strings: null });
const strings = (value: string[]) => ({ text: null, number: null, boolean: null, strings: value });
type Where = { key: string; value: string; label?: string; source?: string; verifiedDays?: number; state?: 'fresh' | 'stale' | 'unverified' };
type Sketch = { slug: string; name: string; kind?: 'person' | 'agent'; agent?: string; summary?: string; where?: Where[]; how?: Record<string, string | string[]>; may?: { text: string; source: string }[];
  evidence?: { created: string; category: string; title: string; content: string }[]; projects?: { agent: string; slug: string; name: string; status: string }[]; owner?: boolean | string[]; newer?: number; updatedDays?: number; mergedFrom?: string };
const cardOf = (p: Sketch) => ({
  slug: p.slug, name: p.name, summary: p.summary ?? null,
  where: (p.where ?? []).map((w) => ({ key: w.key, value: text(w.value), label: w.label ?? null, source: w.source ?? null, verified_at: w.verifiedDays === undefined ? null : ago(w.verifiedDays * 1440), stale_after_days: 180 })),
  how: Object.entries(p.how ?? {}).map(([key, value]) => ({ key, value: Array.isArray(value) ? strings(value) : text(value) })),
  may: p.may ?? [],
});
const record = (p: Sketch) => ({
  id: (p.agent ?? 'commons') + ':' + p.slug, slug: p.slug, agent: p.agent ?? null, name: p.name, updated: ago((p.updatedDays ?? 6) * 1440), synthesizedAt: p.agent ? ago((p.updatedDays ?? 6) * 1440) : null,
  kind: p.kind ?? 'person', newer: p.newer ?? 0, mergedFrom: p.mergedFrom ?? null, card: cardOf(p), evidence: p.evidence ?? [],
  fields: (p.where ?? []).map((w) => ({ key: w.key, value: w.value, label: w.label ?? null, source: w.source ?? null, verifiedAt: w.verifiedDays === undefined ? null : ago(w.verifiedDays * 1440), state: w.state ?? (w.verifiedDays === undefined ? 'unverified' : 'fresh') })),
  projects: (p.projects ?? []).map((project) => ({ ...project, href: null })),
  ownership: p.owner === undefined ? null : { owner: p.owner === true, agents: Array.isArray(p.owner) ? p.owner : [] },
});
const anton: Sketch = {
  slug: 'anton', name: 'Anton Avguchenko', mergedFrom: 'anton-a',
  summary: 'Fits and repairs pond liners. Did ours in 2023 and comes back each spring to look it over; prefers a text the day before.',
  where: [
    { key: 'email', value: 'anton@avguchenko-ponds.example', label: 'work', source: 'His invoice', verifiedDays: 40 },
    { key: 'phone', value: '+44 7700 900412', label: 'mobile', source: 'Sam', verifiedDays: 230, state: 'stale' },
    { key: 'github', value: '@anton-ponds' },
  ],
  how: { 'Best time': 'Weekday mornings before nine', Languages: ['English', 'Ukrainian'], Rate: '£45 an hour, half-day minimum' },
  projects: [{ agent: 'fern', slug: 'pond', name: 'Pond', status: 'active' }, { agent: 'moss', slug: 'garden', name: 'Garden', status: 'active' }],
};
const antonFern: Sketch = { ...anton, agent: 'fern', newer: 3, updatedDays: 9, summary: 'Reliable, slow to reply by email. Quotes are honoured.',
  where: [{ key: 'slack', value: 'U04ANTON', label: 'Pond Trade workspace', verifiedDays: 12 }], how: { Tone: 'Short, practical messages' },
  may: [{ text: 'May be sent photos of the pond', source: 'alex, in Comms' }, { text: 'May be given the side-gate code on visit days', source: 'sam' }],
  evidence: [
    { created: ago(9 * 1440), category: 'conversation', title: 'Agreed the spring visit', content: 'Anton will come the second week of April. He asked that the pump be off for an hour before he arrives.' },
    { created: ago(70 * 1440), category: 'observation', title: 'Invoice paid late', content: 'The March invoice was paid eleven days late; he did not chase it.' },
  ] };
const antonMoss: Sketch = { ...anton, agent: 'moss', newer: 0, updatedDays: 31, summary: 'Knows which marginal plants survive our clay.', where: [], how: {}, may: [], evidence: [] };
const sam: Sketch = { slug: 'sam', name: 'Sam', owner: ['moss'], summary: 'Looks after the garden and the pond. Away most Thursdays.',
  where: [{ key: 'email', value: 'sam@household.example', label: 'home', verifiedDays: 3 }, { key: 'discord', value: '228800114477', label: 'sam.g', verifiedDays: 15 }],
  how: { Notify: 'Phone first, then email' }, projects: [{ agent: 'moss', slug: 'garden', name: 'Garden', status: 'active' }, { agent: 'fern', slug: 'greenhouse', name: 'Greenhouse', status: 'paused' }] };
const directory = [
  record({ slug: 'alex', name: 'Alex', owner: true, summary: 'Owns the household.', where: [{ key: 'email', value: 'alex@household.example', verifiedDays: 2 }] }),
  record(sam), record({ ...sam, agent: 'moss', summary: 'Decides what is planted where.', where: [], how: {}, newer: 1 }),
  record({ slug: 'robin', name: 'Robin', owner: [], summary: 'At school in term time.', where: [{ key: 'phone', value: '+44 7700 900155', verifiedDays: 300, state: 'stale' }] }),
  record(anton), record(antonFern), record(antonMoss),
  record({ slug: 'priya-natarajan', name: 'Priya Natarajan', summary: 'Electrician. Quoted for the shed socket.', where: [{ key: 'email', value: 'priya@brightspark.example', verifiedDays: 20 }] }),
  record({ slug: 'priya-natarajan', name: 'Priya Natarajan', agent: 'art', summary: 'Answers within the hour.' }),
  record({ slug: 'dr-okafor', name: 'Dr. Chidi Okafor', summary: 'The vet at Millbrook.', where: [{ key: 'phone', value: '+44 1632 960222', verifiedDays: 400, state: 'stale' }] }),
  record({ slug: 'marguerite', name: 'Marguerite Delacroix-Hetherington', summary: 'Next door at number 14. Waters the greenhouse when we are away.', where: [{ key: 'phone', value: '+44 7700 900671' }] }),
  record({ slug: 'marguerite', name: 'Marguerite Delacroix-Hetherington', agent: 'fern' }), record({ slug: 'marguerite', name: 'Marguerite Delacroix-Hetherington', agent: 'moss' }),
  record({ slug: 'tom-seeds', name: 'Tom at Hollow Seeds', summary: 'Takes the autumn seed order.', where: [{ key: 'email', value: 'orders@hollowseeds.example', verifiedDays: 60 }] }),
  record({ slug: 'boiler-engineer', name: 'Jas Dhillon', summary: 'Services the boiler each September.' }),
  record({ slug: 'school-office', name: 'School office', where: [{ key: 'email', value: 'office@millbrook-school.example', verifiedDays: 90 }] }),
  record({ slug: 'grandma-june', name: 'June', summary: 'Robin’s grandmother. Visits most Sundays.', where: [{ key: 'phone', value: '+44 1632 960871', verifiedDays: 10 }] }),
  record({ slug: 'fern', name: 'Fern', kind: 'agent', summary: 'Keeps the pond and the greenhouse.' }),
  record({ slug: 'moss', name: 'Moss', kind: 'agent', summary: 'Keeps the garden.' }),
  record({ slug: 'art', name: 'Art', kind: 'agent', summary: 'The household’s default agent.' }),
];
const peopleAccess = (canAdd: boolean) => ({ memoryPeopleAccess: { allowed: true, directory: true, canAdd, agents: ['art', 'fern', 'moss'] } });
const opened = (p: Sketch, more: object = {}) => ({ memoryPerson: { ...record(p), sightings: [], conversations: { available: true, rows: [] }, history: [], ...more } });
const tickets = (rows: [string, string, string][]) => ({ rows: rows.map(([id, title, status]) => ({ id, title, status })) });
const samTickets = tickets([['t-212', 'Order replacement foam for the pond filter', 'in_progress'], ['t-208', 'Decide where the new water butt goes', 'open'], ['t-197', 'Net the brassicas before the pigeons find them', 'open'], ['t-181', 'Greenhouse: reseat the loose pane', 'blocked']]);

// ── Activity ───────────────────────────────────────────────────────────────────────────────────────────────────
type What = 'conversation' | 'work' | 'system';
let n = 0;
const entry = (minutes: number, agent: string, title: string, what: What, venue: string, where: string, line: string | null = null, owner = false) => {
  const at = ago(minutes);
  return { id: (what === 'work' ? 'e~' : what === 'system' ? 's~' : 'c~') + ++n, agent, at, day: at.slice(0, 10), hour: new Date(at).getUTCHours(), title, line, venue, where, what, owner: owner ? true : null, expires: null };
};
const entries = [
  entry(14, 'fern', 'Ordered the foam set for the pond filter', 'work', 'comms', 'Comms · Pond', 'Closed t-212 once the order confirmation arrived.', true),
  entry(52, 'moss', 'Which bed do the leeks go in this year?', 'conversation', 'discord', 'Discord · #garden', 'Sam and Moss settled on the bed by the shed.'),
  entry(95, 'art', 'Morning wake', 'system', 'wakes', 'Wakes', 'Read the inbox, found two approvals waiting.'),
  entry(160, 'fern', 'Read the pump twice before trusting a low reading, and say so in the alert rather than raising it straight away', 'work', 'terminal', 'Terminal · loom-repo', 'Opened a pull request for t-204.'),
  entry(240, 'art', 'Car insurance renewal: three quotes compared', 'conversation', 'comms', 'Comms · Paperwork', 'Waiting on you to choose.', true),
  entry(410, 'moss', 'Frost warning for tonight', 'system', 'wakes', 'Wakes', 'Told Sam; fleece is in the shed.'),
  entry(600, 'fern', 'Greenhouse thermostat disagrees with the thermometer', 'conversation', 'slack', 'Slack · #greenhouse', null),
  entry(1500, 'art', 'Backed up loom and checked the restore', 'work', 'terminal', 'Terminal', 'Shipped t-190.'),
  entry(1560, 'moss', 'Seed order drafted', 'work', 'comms', 'Comms · Garden', 'Sixteen packets, £41.20. See t-208 for the water butt.', true),
  entry(1620, 'fern', 'Anton confirmed the spring visit', 'conversation', 'comms', 'Comms · Pond', null, true),
  entry(1700, 'art', 'Evening digest', 'system', 'wakes', 'Wakes', 'Nothing needed you.'),
  entry(1790, 'moss', 'Pigeon netting: what size mesh?', 'conversation', 'discord', 'Discord · #garden', 'Linked t-197.'),
  entry(1900, 'fern', 'Web research: UV lamp replacements', 'work', 'web', 'Web', null),
  entry(2100, 'art', 'School inset days added to the calendar', 'work', 'mcp', 'MCP · Calendar', null),
  entry(2950, 'moss', 'Compost bay two is full', 'conversation', 'voice', 'Voice', 'Robin mentioned it at breakfast.'),
  entry(3000, 'fern', 'Pump read low for an hour', 'system', 'relay', 'Relay · pond sensor', 'Cleared by itself.'),
  entry(3100, 'art', 'Router firmware update planned', 'conversation', 'comms', 'Comms · House', null, true),
  entry(3200, 'moss', 'Watered the greenhouse seedlings', 'work', 'comms', 'Comms · Greenhouse', null),
  entry(3300, 'fern', 'Morning wake', 'system', 'wakes', 'Wakes', null),
  entry(3400, 'art', 'Passport renewal forms found', 'work', 'terminal', 'Terminal', 'Robin’s expires in March.'),
  entry(3550, 'moss', 'Asked Marguerite about watering in August', 'conversation', 'slack', 'Slack · neighbours', null),
  entry(4000, 'fern', 'Boiler service booked', 'work', 'comms', 'Comms · House', 'Jas Dhillon, second week of September.', true),
];
const activityAccess = { memoryActivityAccess: { allowed: true, agents: ['art', 'fern', 'moss'], owner: 'alex', timezone: 'UTC', today: day(0), windows: ['recent', day(3), day(6), day(9)], expires: 60 } };
const activityWindow = (list: typeof entries, over: object = {}) => ({ memoryActivity: { id: 'w-recent', to: 'recent', days: [day(0), day(1), day(2)], earlier: day(3), entries: list, conversations: 'available', episodes: 'available', truncated: false, expires: 60, ...over } });
const activityEntry = (variables: Record<string, unknown>) => {
  const e = entries.find((x) => x.id === variables.id) ?? entries[0];
  return { memoryActivityEntry: { ...e,
    needs: e.owner ? 'Choose between the two foam densities before Friday, or the order goes out as quoted.' : null,
    asked: ['Order replacement foam for the pond filter.', 'Keep it under thirty pounds.'],
    story: 'Fern compared three suppliers. The cheapest was out of stock in **30 ppi**, so it ordered from the second, which delivers on Thursday.\n\nIt then closed the ticket and wrote the part number into the knowledge page.',
    decided: ['Order from Pondkeeper at £24.90', 'Record the part number on the pump page'],
    steps: [{ label: 'Search suppliers', state: 'done', tool: 'web' }, { label: 'Compare prices', state: 'done', tool: 'web' }, { label: 'Place order', state: 'done', tool: 'browser' }, { label: 'Write knowledge page', state: 'error', tool: 'knowledge' }, { label: 'Close ticket', state: 'running', tool: 'tasks' }],
    more: [],
    tasks: [{ label: 't-212', href: '/task/t-212' }, { label: 't-204', href: null }, { label: 'Supplier comparison', href: 'https://example.test/comparison' }],
    prs: [{ label: 'acme/app#12 Read the pump twice', href: 'https://github.com/acme/app/pull/12' }],
    links: [{ label: 'Order confirmation', href: 'https://example.test/orders/88213' }, { label: 'The pump page', href: '/p/knowledge/pond-pump' }],
  } };
};

// ── Account and appearance ─────────────────────────────────────────────────────────────────────────────────────
const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const safariPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1';
const firefoxLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
const account = { account: { member: 'alex',
  notifications: { publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', devices: [
    { ref: 'nd-1', device: 'Chrome on macOS', createdAt: ago(40 * 1440), seenAt: ago(35) },
    { ref: 'nd-2', device: 'Safari on iPhone', createdAt: ago(21 * 1440), seenAt: ago(3 * 1440) },
    { ref: 'nd-3', device: 'Firefox on Linux', createdAt: ago(200 * 1440), seenAt: ago(90 * 1440) },
  ] },
  passkeys: [
    { ref: 'pk-1', label: 'MacBook Touch ID', createdAt: ago(300 * 1440), lastUsedAt: ago(35), ended: false },
    { ref: 'pk-2', label: 'iPhone', createdAt: ago(120 * 1440), lastUsedAt: ago(3 * 1440), ended: false },
    { ref: 'pk-3', label: 'YubiKey 5C, the one on the blue lanyard in the hall drawer', createdAt: ago(290 * 1440), lastUsedAt: null, ended: false },
    { ref: 'pk-4', label: 'Old work laptop', createdAt: ago(500 * 1440), lastUsedAt: ago(210 * 1440), ended: true },
  ],
  sessions: [
    { ref: 'se-1', device: chromeMac, issuedAt: ago(8 * 1440), seenAt: ago(1), ended: false },
    { ref: 'se-2', device: safariPhone, issuedAt: ago(21 * 1440), seenAt: ago(190), ended: false },
    { ref: 'se-3', device: firefoxLinux, issuedAt: ago(60 * 1440), seenAt: ago(12 * 1440), ended: false },
    { ref: 'se-4', device: 'Kitchen tablet', issuedAt: ago(200 * 1440), seenAt: ago(150 * 1440), ended: true },
  ],
} };
const bareAccount = { account: { member: 'robin', notifications: { publicKey: null, devices: [] }, passkeys: [], sessions: [{ ref: 'se-9', device: chromeMac, issuedAt: ago(2), seenAt: ago(1), ended: false }] } };
const homeComms = { homeComms: { member: 'alex', agents: ['art', 'fern', 'moss'], summaries: [] } };
const prefs = (over: object = {}) => ({ memberPreferences: [
  { member: 'alex', look: 'lowlight', ground: 'contours', sound: false, pixel: true, haptics: true, oneWindow: false, zoom: false, motion: 'follow', contrast: 'off', changedAt: ago(900), ...over },
  { member: 'sam', look: 'daylight', ground: 'wash', sound: true, pixel: false, haptics: false, oneWindow: true, zoom: true, motion: 'on', contrast: 'on', changedAt: ago(4000) },
] });

export const scenes: BrickScenes[] = [
  { brick: 'knowledge-page', scenes: [
    { name: 'default', params: { page: 'pond-pump' }, data: { ...idle, MemoryKnowledgePage: knowledgePage(), MemoryKnowledgeAccess: access(true) } },
    { name: 'stale', params: { page: 'water-butts' }, data: { ...idle, MemoryKnowledgePage: stalePage, MemoryKnowledgeAccess: access(true) } },
    { name: 'read-only', params: { page: 'pond-pump' }, only: ['primary', 'side'], data: { ...idle, MemoryKnowledgePage: knowledgePage({ annotations: [], checks: [], checked: null }), MemoryKnowledgeAccess: access(false) } },
    { name: 'unavailable', params: { page: 'gone-page' }, data: { ...idle, MemoryKnowledgePage: { memoryKnowledgePage: null }, MemoryKnowledgeAccess: access(true) } },
    { name: 'loading', params: { page: 'pond-pump' }, only: ['side'], data: { ...idle, MemoryKnowledgePage: 'loading', MemoryKnowledgeAccess: 'loading' } },
  ] },
  { brick: 'knowledge', scenes: [
    { name: 'default', params: { show: 'all' }, data: { ...idle, MemoryKnowledge: knowledgeIndex(pages), MemoryKnowledgeAccess: access(true), BrickKnowledgeSearch: found } },
    { name: 'adding', params: { show: 'all' }, only: ['primary'], press: ['Add a fact'], data: { ...idle, MemoryKnowledge: knowledgeIndex(pages.slice(0, 2)), MemoryKnowledgeAccess: access(true), BrickKnowledgeSearch: found } },
    { name: 'due', params: { show: 'due' }, data: { ...idle, MemoryKnowledge: knowledgeIndex(pages), MemoryKnowledgeAccess: access(true), BrickKnowledgeSearch: found } },
    { name: 'topic', params: { show: 'all', domain: 'garden' }, only: ['primary', 'side'], data: { ...idle, MemoryKnowledge: knowledgeIndex(pages), MemoryKnowledgeAccess: access(false), BrickKnowledgeSearch: found } },
    { name: 'empty', params: { show: 'all' }, data: { ...idle, MemoryKnowledge: knowledgeIndex([]), MemoryKnowledgeAccess: access(true), BrickKnowledgeSearch: { rows: [] } } },
    { name: 'unavailable', params: { show: 'all' }, only: ['side'], data: { ...idle, MemoryKnowledge: 'offline', MemoryKnowledgeAccess: 'offline' } },
  ] },
  { brick: 'person', scenes: [
    { name: 'default', params: { person: 'member:sam' }, data: { ...idle, MemoryPerson: opened(sam, { sightings: [{ platform: 'discord', workspace: 'Household', account: '228800114477', label: 'sam.g', seenAt: ago(52) }] }), MemoryPeople: { memoryPeople: directory }, BrickAssigned: samTickets } },
    { name: 'contact', params: { person: 'contact:anton' }, data: { ...idle, MemoryPeople: { memoryPeople: directory }, BrickAssigned: tickets([]),
      MemoryPerson: opened(anton, {
        sightings: [{ platform: 'slack', workspace: 'Pond Trade', account: 'U04ANTON', label: 'Anton A.', seenAt: ago(3 * 1440) }, { platform: 'discord', workspace: 'Koi Keepers', account: '554433221100', label: null, seenAt: ago(44 * 1440) }],
        conversations: { available: true, rows: [{ id: 'cv-anton-spring-0001', title: 'Spring visit and the liner warranty', href: '/p/comms/cv-anton-spring-0001' }, { id: 'cv-anton-quote-0002', title: 'Quote for the waterfall', href: '/p/comms/cv-anton-quote-0002' }] },
        history: [{ id: 1, op: 'update', replacedAt: ago(40 * 1440), actor: 'fern', card: cardOf({ ...anton, summary: 'Fits pond liners.' }) }],
      }) } },
    { name: 'member-no-card', params: { person: 'member:robin' }, only: ['primary', 'side'], data: { ...idle, MemoryPerson: { memoryPerson: null }, MemoryPeople: { memoryPeople: directory }, BrickAssigned: tickets([]) } },
    { name: 'sparse', params: { person: 'contact:boiler-engineer' }, only: ['primary', 'side'], data: { ...idle, MemoryPeople: { memoryPeople: directory }, BrickAssigned: tickets([]),
      MemoryPerson: opened({ slug: 'boiler-engineer', name: 'Jas Dhillon' }, { conversations: { available: false, rows: [] } }) } },
    { name: 'unavailable', params: { person: 'contact:nobody' }, data: { ...idle, MemoryPerson: { memoryPerson: null }, MemoryPeople: { memoryPeople: directory }, BrickAssigned: 'offline' } },
  ] },
  { brick: 'people', scenes: [
    { name: 'default', params: { folder: 'all' }, data: { ...idle, MemoryPeopleAccess: peopleAccess(true), MemoryPeople: { memoryPeople: directory } } },
    { name: 'adding', params: { folder: 'all' }, only: ['primary'], press: ['Add a person'], data: { ...idle, MemoryPeopleAccess: peopleAccess(true), MemoryPeople: { memoryPeople: directory.slice(0, 2) } } },
    { name: 'agents', params: { folder: 'agent' }, only: ['primary', 'side'], data: { ...idle, MemoryPeopleAccess: peopleAccess(false), MemoryPeople: { memoryPeople: directory } } },
    { name: 'empty', params: { folder: 'all' }, data: { ...idle, MemoryPeopleAccess: peopleAccess(true), MemoryPeople: { memoryPeople: [] } } },
    { name: 'unavailable', params: { folder: 'all' }, only: ['side'], data: { ...idle, MemoryPeopleAccess: { memoryPeopleAccess: { allowed: false, directory: false, canAdd: false, agents: [] } }, MemoryPeople: { memoryPeople: [] } } },
  ] },
  { brick: 'activity', scenes: [
    { name: 'default', params: { days: 3 }, data: { ...idle, MemoryActivityAccess: activityAccess, MemoryActivity: activityWindow(entries), MemoryActivityEntry: activityEntry } },
    { name: 'filtering', params: { days: 3 }, only: ['primary'], press: ['Filter activity', 'Ordered the foam set for the pond filter'], data: { ...idle, MemoryActivityAccess: activityAccess, MemoryActivity: activityWindow(entries), MemoryActivityEntry: activityEntry } },
    { name: 'today', params: { days: 1 }, data: { ...idle, MemoryActivityAccess: activityAccess, MemoryActivity: activityWindow(entries, { conversations: 'unavailable', episodes: 'error', truncated: true }), MemoryActivityEntry: activityEntry } },
    { name: 'empty', params: { days: 1 }, data: { ...idle, MemoryActivityAccess: activityAccess, MemoryActivity: activityWindow([]), MemoryActivityEntry: { memoryActivityEntry: null } } },
    { name: 'unavailable', params: { days: 1 }, only: ['side'], data: { ...idle, MemoryActivityAccess: { memoryActivityAccess: null }, MemoryActivity: 'offline' } },
  ] },
  { brick: 'account', scenes: [
    { name: 'default', params: {}, data: { ...idle, Account: account } },
    { name: 'bare', params: {}, data: { ...idle, Account: bareAccount } },
    { name: 'unavailable', params: {}, only: ['side'], data: { ...idle, Account: { account: null } } },
  ] },
  { brick: 'appearance', scenes: [
    { name: 'default', params: {}, data: { ...idle, DeskHomeComms: homeComms, DeskPreferences: prefs() } },
    { name: 'all-on', params: {}, only: ['primary', 'side'], data: { ...idle, DeskHomeComms: homeComms, DeskPreferences: prefs({ look: 'daylight', ground: 'depth', sound: true, oneWindow: true, zoom: true, motion: 'on', contrast: 'on' }) } },
    { name: 'unset', params: {}, only: ['primary'], data: { ...idle, DeskHomeComms: homeComms, DeskPreferences: { memberPreferences: [] } } },
    { name: 'unavailable', params: {}, only: ['side'], data: { ...idle, DeskHomeComms: 'offline', DeskPreferences: 'offline' } },
  ] },
];
