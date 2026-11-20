import { expect, it } from 'vitest';
import { householdChanges } from './shared-household-proposals.js';
import { factLines, proposalCard, storedProposal, type CardNames } from './proposal-words.js';

const gage = { platform: 'slack', workspace: 'T02AYL3QM', user: 'U07V8CZUC1J' };
const tool = { name: 'pond_status', description: 'Read station status in the Pond deployment.', repository: 'https://github.com/org/house.git', commit: 'a'.repeat(40), image: 'sha256:' + 'b'.repeat(64),
  program: 'bin/pond-kit-read', args: ['status', { parameter: 'station' }], parameters: { station: { type: 'string', description: 'Station' } }, secrets: { KIT_POND_TOKEN: 'pond-read-token' } };
/** One fixture input per kind of change `household.propose` takes, with the sentence it must say from the input alone. */
const kinds: Record<string, Array<[input: unknown, title: string, facts?: string[]]>> = {
  kit: [[{ agent: 'art', kit: 'pond-field', tools: [tool] }, 'Give Art a kit called pond-field, with 1 tool', ['Tool: pond_status: Read station status in the Pond deployment.', 'Runs: "bin/pond-kit-read"', 'Argument 1: "status"', 'Argument 2: Parameter "station"', 'Secret handed to it: pond-read-token as KIT_POND_TOKEN']],
    [{ agent: 'art', kit: 'pond-field', tools: null }, 'Remove Art’s pond-field kit']],
  kitGrant: [[{ agent: 'art', kit: 'pond-et-livonia', to: gage, grant: true }, 'Let the Slack account U07V8CZUC1J (workspace T02AYL3QM) use Art’s pond-et-livonia kit', ['Who: A Slack account', 'Workspace: T02AYL3QM', 'Applies: When Art works on that account’s word in an eligible conversation.', 'Account id: U07V8CZUC1J']],
    [{ agent: 'art', kit: 'pond-et-livonia', to: gage, grant: false }, 'Stop letting the Slack account U07V8CZUC1J (workspace T02AYL3QM) use Art’s pond-et-livonia kit'],
    [{ agent: 'art', kit: 'tools', to: { member: 'gage' }, grant: true }, 'Let Gage (a household member) use Art’s tools kit', ['Applies: When Art works for Gage.']],
    [{ agent: 'art', kit: 'tools', to: { project: 'pond' }, grant: false }, 'Stop letting everyone on the project pond use Art’s tools kit']],
  projectOutsidePerson: [[{ project: 'pond', ...gage, on: true }, 'Add the Slack account U07V8CZUC1J (workspace T02AYL3QM) to the project pond'],
    [{ project: 'pond', ...gage, on: false }, 'Remove the Slack account U07V8CZUC1J (workspace T02AYL3QM) from the project pond']],
  project: [[{ id: 'pond', name: 'Pond', members: ['sam', 'lee'], agents: ['art'], repositories: ['github:house/pond'] }, 'Set up the project Pond', ['Members: Sam, Lee', 'Agents: Art', 'Repositories: github:house/pond']]],
  projectMerge: [[{ from: 'pond', into: 'garden' }, 'Merge the project pond into the project garden', ['Afterwards: This cannot be undone.']]],
  projectRetire: [[{ project: 'pond' }, 'Retire the project pond']],
  projectRevive: [[{ project: 'pond' }, 'Revive the project pond']],
  projectJoin: [[{ project: 'pond', agent: 'mark' }, 'Let Mark work on the project pond']],
  member: [[{ id: 'lee', role: 'owner', fullOwner: false, agents: ['art'] }, 'Set Lee as an owner of the household', ['Role: Owner of the household', 'Their agents: Art']]],
  agent: [[{ id: 'art', about: 'Keeps the pond', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' }, 'Change how Art is described and drawn', ['About: Keeps the pond', 'Face: pebble with dot eyes']]],
  settings: [[{ timezone: 'America/Chicago' }, 'Set the household’s time zone to America/Chicago'], [{ commsDays: 7 }, 'Have Comms keep words for 7 days'], [{ defaultAgent: 'art' }, 'Make Art the household’s default agent'], [{ timezone: 'America/Chicago', commsDays: 7 }, 'Change 2 household settings', ['Days Comms keeps words: 7']]],
  rule: [[{ kind: 'merge', scope: 'project:pond', person: 'gage', tier: 'do' }, 'Set a standing rule for merging a pull request (the project pond), when asked for Gage: Just do it', ['Answer: Just do it']],
    [{ kind: 'setting', scope: '*', person: '', tier: null }, 'Remove the standing rule for changing a setting (everything)']],
  bodyPolicy: [[{ agent: 'art', people: [{ ...gage, tier: 2 }], deniedTools: [{ pattern: 'Bash', guestsOnly: true }] }, 'Change Art’s outside contacts and tool restrictions',
    ['Outside contacts: the Slack account U07V8CZUC1J (workspace T02AYL3QM): tier 2', 'Tools its body is not given: Bash (only when working for a guest)']]],
  secretRule: [[{ secret: 'pond-key', answer: 'auto', minutes: 30, agents: [{ agent: 'art', when: 'on_request' }] }, 'Change who may use the secret pond-key', ['Answer: Allow automatically', 'Automatic grant lasts: 30 minutes', 'When asked: Art', 'At startup: No agent']]],
  secretDefault: [[{ answer: 'never' }, 'For a secret with no rule of its own: never allow']],
  houseSecrets: [[{ agent: 'art', repository: 'house-key', secrets: [{ alias: 'POND', secret: 'pond-key' }] }, 'Change which secrets Art’s house is handed when it starts', ['Secrets handed over at start: pond-key (as POND)']]],
  bridge: [[{ action: 'connection', id: 'art-slack', platform: 'slack', agent: 'art', workspace: 'T02AYL3QM', botUser: 'UBOT', tokenSecret: 'slack-token', appSecret: 'slack-app', enabled: true, only: [], ignore: ['C1'] }, 'Set up Art’s Slack connection (art-slack)', ['Switched on: Yes', 'Ignores: the channel C1 on Slack']],
    [{ action: 'disconnect', id: 'mark-discord' }, 'Disconnect the Discord or Slack connection mark-discord'],
    [{ action: 'channel', platform: 'discord', workspace: 'G1', channel: 'C9', answers: 'art', botsMayTalk: false }, 'Let Art answer in the channel C9 on Discord', ['Other bots may talk to it there: No', 'Channel id: C9']],
    [{ action: 'removeChannel', platform: 'discord', workspace: 'G1', channel: 'C9' }, 'Remove the answer rule for the channel C9 on Discord'],
    [{ action: 'person', ...gage, member: 'gage' }, 'Treat the Slack account U07V8CZUC1J (workspace T02AYL3QM) as the household member Gage'],
    [{ action: 'removePerson', ...gage }, 'Stop treating the Slack account U07V8CZUC1J (workspace T02AYL3QM) as a household member']],
  tempoTimings: [[{ who: { kind: 'agent', id: 'art' }, settleSeconds: 60, dimDays: 2 }, 'Change Tempo’s timings for the agent Art', ['Inbox settle time: 60 seconds', 'Dim ends after: 2 days']]],
  measuring: [[{ on: true, send_outside: false, outside_address: '', keep_days: 7 }, 'Have loom measure itself', ['Keeps history for: 7 days']], [{ on: false, send_outside: false, outside_address: '', keep_days: 7 }, 'Stop loom measuring itself']],
  boxSettings: [[{ box: 'box-1', name: 'one', hostsAny: true, reportOnly: false, alwaysOn: true, agents: [{ agent: 'art', lent: false }], facts: ['gpu'] }, 'Change the settings of the machine one', ['Always on: Yes', 'Agents it runs: Art']]],
  runSettings: [[{ agent: 'art', houseRepository: 'https://example.com/house.git', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: true, boxes: ['box-1', 'box-2'], ports: [{ address: '127.0.0.1', port: 8080 }] }, 'Change how Art runs',
    ['Needs a graphics card: Yes', 'Machines, in order:\n  1. box-1\n  2. box-2', 'Ports its house may open: 127.0.0.1 port 8080']]],
  models: [[{ agent: 'art', models: ['fable', 'opus'] }, 'Change the models Art may use', ['Models, in order:\n  1. fable\n  2. opus']]],
  agentAccounts: [[{ agent: 'art', github: ['art-bot'] }, 'Set Art’s GitHub accounts', ['GitHub accounts: art-bot']]],
  order: [[{ of: 'agents', ids: ['mark', 'art'] }, 'Change the order agents are listed in', ['Order:\n  1. Mark\n  2. Art']]],
  remove: [[{ of: 'agent', id: 'mark' }, 'Remove the agent Mark from the household', ['What happens: It no longer runs, and its bridge connections are switched off. Nothing is erased, and it can be restored later.']], [{ of: 'bridge', id: 'mark-discord' }, 'Remove the Discord or Slack connection mark-discord']],
  restore: [[{ of: 'member', id: 'lee' }, 'Restore Lee to the household'], [{ of: 'project', id: 'pond' }, 'Restore the project pond']],
  secretDescription: [[{ secret: 'pond-key', description: 'Reads the pond' }, 'Change what the secret pond-key is said to be for', ['What it is for: Reads the pond', 'Its value: Not shown, and not changed.']]],
  tokenRevoke: [[{ label: 'lee' }, 'Revoke the token lee']],
  boxRevoke: [[{ name: 'workshop' }, 'Revoke the machine workshop']],
  browserSignOut: [[{ member: 'lee', device: 'Chrome on Mac' }, 'Sign out Lee’s browser Chrome on Mac']],
};
const everything = (card: NonNullable<ReturnType<typeof proposalCard>>) => [card.title, factLines(card.facts), card.ifYes ?? '', card.ifNo ?? ''].join('\n');

it('has a fixture for every kind of change household.propose takes', () => {
  expect(Object.keys(kinds).sort()).toEqual([...householdChanges].sort());
});
it.each(Object.entries(kinds).flatMap(([change, rows]) => rows.map(([input, title, facts]) => ({ change, input, title, facts: facts ?? [] }))))('says a $change card as one sentence and plain facts: $title', ({ change, input, title, facts }) => {
  const card = proposalCard(change, input, { name: id => id.charAt(0).toUpperCase() + id.slice(1) })!;
  expect(card.title).toBe(title);
  expect(card.title).not.toMatch(/[.?]$/);
  const lines = factLines(card.facts);
  for (const fact of facts) expect(lines).toContain(fact);
  // Never raw JSON, in anything the card says: not its sentence, its facts, or its exact fields.
  expect(everything(card)).not.toMatch(/\{"|\[\{|":|\[object/);
  expect(card.nothing).toBe(false);
  expect(card.facts.every(fact => fact.label && fact.value)).toBe(true);
});

const names: CardNames = {
  person: (platform, _workspace, user) => platform === 'slack' && user === 'U07V8CZUC1J' ? { name: 'Gage Taylor', source: 'Art’s person card, which lists this account' } : null,
  channel: (_platform, _workspace, channel) => channel === 'C9' ? { name: '#pond', source: 'The name Discord gave with a message from there' } : null,
  workspace: (_platform, workspace) => workspace === 'T02AYL3QM' ? { name: 'art-slack', source: 'reached by the connection' } : null,
};
it('says who an outside account is for a household owner, and says so when loom holds no name', () => {
  const state = { agentLive: true, tools: [tool], known: true, linked: null, on: false };
  const named = proposalCard('kitGrant', { agent: 'art', kit: 'pond-et-livonia', to: gage, grant: true }, { names, before: { value: state } })!;
  expect(named.title).toBe('Let Gage Taylor (Slack) use Art’s pond-et-livonia kit');
  expect(named.facts.map(fact => fact.label)).toEqual(['Who', 'Name from', 'Workspace', 'Workspace id', 'Kit', 'What the kit does', 'Applies', 'Now', 'Account id']);
  expect(factLines(named.facts)).toContain('Who: Gage Taylor, on Slack\nName from: Art’s person card, which lists this account\nWorkspace: Slack connection art-slack');
  expect(factLines(named.facts)).toContain('What the kit does: pond_status: Read station status in the Pond deployment.');
  // The raw account id is kept, small and last, for certainty.
  expect(named.facts.at(-1)).toEqual({ label: 'Account id', value: 'U07V8CZUC1J', small: true });
  const nameless = proposalCard('kitGrant', { agent: 'art', kit: 'pond-et-livonia', to: { ...gage, user: 'U0STRANGER', workspace: 'T0OTHER' }, grant: true }, { names, before: { value: state } })!;
  expect(nameless.title).toBe('Let an unnamed Slack account use Art’s pond-et-livonia kit');
  expect(factLines(nameless.facts)).toContain('Who: An unnamed Slack account\nWorkspace: Unnamed Slack workspace');
  expect(proposalCard('bridge', { action: 'channel', platform: 'discord', workspace: 'G1', channel: 'C9', answers: 'art', botsMayTalk: false }, { names, before: { value: null } })!.title).toBe('Let Art answer in #pond on Discord');
  expect(proposalCard('bridge', { action: 'person', ...gage, member: 'gage' }, { names, before: { value: null } })!.title).toBe('Treat Gage Taylor (Slack) as the household member Gage');
  expect(proposalCard('bridge', { action: 'disconnect', id: 'mark-discord' }, { names, before: { value: { id: 'mark-discord', agent: 'mark', platform: 'discord', workspace: 'G1', enabled: true } } })!.title).toBe('Disconnect Mark’s Discord connection (mark-discord)');
});
it('says what actually changes, field by field, from what is there, and says when nothing would', () => {
  const was = { box: 'box-1', name: 'one', hostsAny: true, reportOnly: false, alwaysOn: false, agents: [{ agent: 'art', lent: false }], facts: ['gpu'] };
  const always = proposalCard('boxSettings', { ...was, alwaysOn: true }, { before: { value: was } })!;
  expect(always).toMatchObject({ title: 'Keep the machine one always on', nothing: false, facts: [{ label: 'Always on', value: 'No → Yes' }] });
  const several = proposalCard('boxSettings', { ...was, name: 'uno', agents: [{ agent: 'art', lent: false }, { agent: 'mark', lent: true }] }, { before: { value: was } })!;
  expect(several.title).toBe('Change the settings of the machine uno');
  expect(factLines(several.facts)).toBe('Name: one → uno\nAgents it runs: Art → Art, Mark (lent to it)');
  const same = proposalCard('boxSettings', was, { before: { value: was } })!;
  expect(same).toMatchObject({ nothing: true, facts: [{ label: 'What changes', value: 'Nothing would change: it is already like this.' }] });
  expect(factLines(proposalCard('models', { agent: 'art', models: ['opus', 'fable'] }, { before: { value: { agent: 'art', models: ['fable'] } } })!.facts)).toBe('Models, in order, now: 1. fable\nModels, in order, if allowed:\n  1. opus\n  2. fable');
  expect(proposalCard('kitGrant', { agent: 'art', kit: 'tools', to: { member: 'lee' }, grant: true }, { before: { value: { agentLive: true, tools: [], memberLive: true, on: true } } })).toMatchObject({ nothing: true });
  expect(proposalCard('remove', { of: 'agent', id: 'mark' }, { before: { value: { of: 'agent', id: 'mark', removed: true } } })).toMatchObject({ nothing: true });
});
it('reads the change a stored household card keeps, and says nothing for any other card or a kind it does not know', () => {
  const details = JSON.stringify({ change: 'kitGrant', after: { agent: 'art', grant: true, kit: 'pond-et-livonia', to: gage }, seal: { nonce: 'n', digest: 'd' } });
  expect(storedProposal({ operation: 'household.change', details })).toEqual({ change: 'kitGrant', input: { agent: 'art', grant: true, kit: 'pond-et-livonia', to: gage } });
  expect(storedProposal({ operation: null, details })).toBeUndefined();
  expect(storedProposal({ operation: 'household.change', details: 'not json' })).toBeUndefined();
  expect(proposalCard('somethingNew', { a: 1 })).toBeUndefined();
  expect(proposalCard('kitGrant', null)).toBeDefined();
});

it('resolves channel filters and distinguishes report destinations sharing a name', () => {
  const shared = { ...names, channel: () => ({ name: '#reports', source: 'Discord' }) };
  const connection = { action: 'connection', id: 'art-discord', agent: 'art', platform: 'discord', workspace: 'G1', only: ['C1'], ignore: ['C2'] };
  const facts = proposalCard('bridge', connection, { names: shared, before: { value: null } })!.facts;
  expect(facts).toContainEqual({ label: 'Listens only in', value: '#reports on Discord (C1)' });
  expect(facts).toContainEqual({ label: 'Ignores', value: '#reports on Discord (C2)' });
  const input = { action: 'channel', platform: 'discord', workspace: 'G1', channel: 'C0', answers: 'art', botsMayTalk: false, reportsTo: { platform: 'discord', workspace: 'G2', channel: 'C2' } };
  const preview = proposalCard('bridge', input, { names: shared, before: { value: { ...input, reportsTo: '["discord","G1","C1"]' } } })!;
  expect(preview.nothing).toBe(false);
  expect(preview.facts).toContainEqual({ label: 'Notes from guests’ work go to', value: '#reports on Discord (C1 in G1) → #reports on Discord (C2 in G2)' });
});

it('shows machine needs and preferences on a repeating schedule', () => {
  const input = { action: 'set', agent: 'art', conversation: 'cv-one',
    asker: { kind: 'outside', id: JSON.stringify([gage.platform, gage.workspace, gage.user]) },
    trigger: { needs: ['gpu', 'local'], prefers: ['fast'] } };
  const card = proposalCard('placeSchedule', input, { names, before: { value: null } })!;
  expect(card.title).toBe('Set a repeating schedule for Art, requested by Gage Taylor (Slack)');
  expect(card.facts).toContainEqual({label:'Conversation id',value:'cv-one',small:true});
  expect(card.facts).toContainEqual({ label: 'Asked by', value: 'Gage Taylor (Slack)' });
  expect(factLines(card.facts)).toContain('Machine needs: gpu, local\nMachine preferences: fast');
  expect(factLines(card.facts)).not.toContain('["');
});

it('shows argument boundaries in both versions of a kit', () => {
  const before = [{ ...tool, args: ['north pond'] }];
  const after = [{ ...tool, args: ['north', 'pond'] }];
  const card = proposalCard('kit', { agent: 'art', kit: 'field', tools: after }, { before: { value: { tools: before } } })!;
  expect(card.facts.filter(fact => fact.label.startsWith('Argument')).map(fact => fact.value)).toEqual(['"north"', '"pond"', '"north pond"']);
});

it('describes the member scope of approvals moved by a project merge', () => {
  const card = proposalCard('projectMerge', { from: 'pond', into: 'garden' })!;
  expect(card.ifYes).toContain('Member-scoped approvals keep their member scope.');
});

it('names an unknown bot and workspace and bounds channel name reads to displayed filters', () => {
  const connection = { action: 'connection', id: 'art-discord', agent: 'art', platform: 'discord',
    workspace: 'G1', botUser: 'B1', only: Array.from({ length: 100 }, (_, i) => 'C' + i), ignore: ['C100'] };
  let reads = 0;
  const reader = { ...names, channel: () => { reads++; return null; } };
  const card = proposalCard('bridge', connection, { names: reader, before: { value: { ...connection, only: [] } } })!;
  expect(card.facts).toContainEqual({ label: 'Bot account', value: 'A Discord account loom has no name for (B1 in G1)' });
  expect(card.facts).toContainEqual({ label: 'Workspace', value: 'A workspace loom has no name for (G1)' });
  expect(reads).toBe(10);
  expect(factLines(card.facts)).toContain("and 90 more");
});

it('clips a long kit argument independently and counts omitted tools and arguments', () => {
  const args = ['x'.repeat(2000), 'second argument', ...Array.from({ length: 10 }, () => 'extra')];
  const tools = [{ ...tool, args, description: 'd'.repeat(2000) },
    ...Array.from({ length: 11 }, (_, index) => ({ ...tool, name: 'tool_' + index, description: 'A separate tool.' }))];
  const card = proposalCard('kit', { agent: 'art', kit: 'field', tools })!;
  const first = JSON.parse(card.facts.find(fact => fact.label === 'Argument 1')!.value) as string;
  const clipped = first.match(/…\(\+(\d+) more characters\)$/u)!;
  expect(clipped.index! + Number(clipped[1])).toBe(2_000);
  expect(card.facts).toContainEqual({ label: 'Argument 2', value: '"second argument"' });
  expect(card.facts).toContainEqual({ label: 'Arguments', value: 'and 2 more' });
  expect(card.facts).toContainEqual({ label: 'Tool', value: 'tool_0: A separate tool.' });
  expect(card.facts).toContainEqual({ label: 'Tool', value: 'and 2 more' });
  expect(card.facts.find(fact => fact.label === 'Tool')!.value).toMatch(/…\(\+\d+ more characters\)$/u);
});

it('shows that measuring sends nothing while off and report-only machines run no agents', () => {
  const measuring = proposalCard('measuring', { on: false, send_outside: true, outside_address: 'https://traces.example', keep_days: 7 })!;
  expect(factLines(measuring.facts)).toContain('Sends measurements outside: Off while measuring is off');
  const machine = proposalCard('boxSettings', { box: 'one', name: 'one', reportOnly: true, agents: [{ agent: 'art', lent: false }] })!;
  expect(factLines(machine.facts)).toContain('Agents it runs: None while report-only. Configured: art');
});
