/** Each source selects public fields through the same member-scoped reader as the desktop. */
export interface EntityType {
  label: string;
  table?: string;
  numberKeys?: string[];
  booleanKeys?: string[];
  searchFields?: string[];
  query: string;
  path: string[];
  key: string[];
  title: string[];
}
function source(
  label: string,
  field: string,
  fields: string,
  key = 'id',
  title = 'title name label id',
  child?: string,
): EntityType {
  return {
    label,
    query:
      (field.includes('$agent')
        ? 'query AgentRecords($agent:String!) '
        : field.includes('$from')
          ? 'query UsageRecords($from:String!,$to:String!) '
          : '') +
      '{ rows: ' +
      field +
      ' { ' +
      (child ? child + ' { ' + fields + ' }' : fields) +
      ' } }',
    path: child ? ['rows', child] : ['rows'],
    key: key.split(' '),
    title: title.split(' '),
  };
}
function table(
  label: string,
  field: string,
  fields: string,
  settings: { key?: string; title?: string; numbers?: string; booleans?: string; search?: string } = {},
): EntityType {
  const options = source(label, field, fields, settings.key, settings.title);
  const filterType = field[0].toUpperCase() + field.slice(1) + 'Filters';
  const order = options.key
    .map((k, i) => k + ':{direction:asc,priority:' + (options.key.length - i) + '}')
    .join(',');
  return {
    ...options,
    table: field,
    numberKeys: settings.numbers?.split(' '),
    booleanKeys: settings.booleans?.split(' '),
    searchFields: settings.search?.split(' '),
    query:
      'query EntityRows($where:' +
      filterType +
      ',$offset:Int!,$limit:Int!){rows:' +
      field +
      '(where:$where,orderBy:{' +
      order +
      '},offset:$offset,limit:$limit){' +
      fields +
      '}}',
  };
}
export const entities = {
  boxAgent: table('Machine assignments', 'boxAgents', 'box agent lent', {
    key: 'box agent',
    title: 'agent',
    search: 'agent box',
  }),
  boxFact: table('Machine facts', 'boxFacts', 'box fact fromOwner', {
    key: 'box fact',
    title: 'fact',
    search: 'box',
  }),
  machineAlert: table(
    'Machine alert settings',
    'boxAlertSettings',
    'singleton diskPercent diskUrgentPercent diskFreeMib memoryFreeMib',
    { key: 'singleton', title: 'singleton', numbers: 'singleton' },
  ),
  runSetting: table(
    'Agent run settings',
    'agentRunSettings',
    'agent houseRepository houseFile houseBranch nestedContainers gpu prefers',
    { key: 'agent', title: 'agent', search: 'agent' },
  ),
  agentBox: table('Agent machine preferences', 'agentBoxes', 'agent box position', {
    key: 'agent box',
    title: 'box',
    search: 'agent box',
  }),
  port: table('House ports', 'agentHousePorts', 'agent address port', {
    key: 'agent address port',
    title: 'address',
    numbers: 'port',
    search: 'agent',
  }),
  houseSecret: table('House secret references', 'agentHouseSecrets', 'agent alias secret', {
    key: 'agent alias',
    title: 'alias',
    search: 'agent secret',
  }),
  tier: table('Agent permissions', 'agentPeople', 'agent person tier', {
    key: 'agent person',
    title: 'person',
    search: 'agent',
  }),
  deniedTool: table('Tool restrictions', 'agentDeniedTools', 'agent pattern guestsOnly', {
    key: 'agent pattern guestsOnly',
    title: 'pattern',
    booleans: 'guestsOnly',
    search: 'agent',
  }),
  comment: table('Ticket comments', 'taskComments', 'task seq actor at text', {
    key: 'task seq',
    title: 'task',
    numbers: 'seq',
    search: 'task text',
  }),
  dependency: table('Ticket dependencies', 'taskLinks', 'task dependsOn type', {
    key: 'task dependsOn type',
    title: 'task',
    search: 'task',
  }),
  projectMember: table('Project members', 'projectMembers', 'project member', {
    key: 'project member',
    title: 'member',
    search: 'project',
  }),
  agentStatus: table('Agent status', 'agentStatus', 'agent state work changedAt', {
    key: 'agent',
    title: 'agent',
    search: 'agent',
  }),
  model: table('Agent models', 'agentModels', 'agent model position', {
    key: 'agent model',
    title: 'model',
    search: 'agent model',
  }),
  approvalEvent: table('Approval history', 'approvalRecord', 'seq at event approval agent note', {
    key: 'seq',
    title: 'event',
    numbers: 'seq',
    search: 'agent note',
  }),
  approvalNotice: table('Approval notices', 'approvalNotices', 'id agent kind target what at', {
    title: 'what',
    search: 'id agent',
  }),
  approvalRule: table('Approval rules', 'approvalRules', 'kind scope person tier setBy setAt', {
    key: 'kind scope person',
    title: 'kind',
  }),
  check: table('Pull request checks', 'changeChecks', 'change name state', {
    key: 'change name',
    title: 'name',
    search: 'name',
  }),
  reviewer: table('Pull request participants', 'changePeople', 'change login role', {
    key: 'change login role',
    title: 'login',
    search: 'login',
  }),
  changeTask: table('Linked tickets', 'changeTasks', 'change task', {
    key: 'change task',
    title: 'task',
    search: 'task',
  }),
  sync: table('Repository sync', 'changeSync', 'singleton readAt failed nextAt', {
    key: 'singleton',
    title: 'readAt',
    numbers: 'singleton',
  }),
  preference: table(
    'Appearance preferences',
    'memberPreferences',
    'member look ground sound pixel haptics oneWindow zoom motion contrast changedAt',
    { key: 'member', title: 'member' },
  ),
  memberAgent: table('Member agents', 'memberAgents', 'member agent', {
    key: 'member agent',
    title: 'agent',
    search: 'agent',
  }),
  channelFilter: table('Channel filters', 'bridgeChannelFilters', 'connection channel rule', {
    key: 'connection channel rule',
    title: 'channel',
    search: 'channel',
  }),
  incoming: table(
    'Incoming bridge messages',
    'bridgeIncoming',
    'id connection channel user postedAt receivedAt deliveredAt state reason',
    { title: 'channel', search: 'id channel' },
  ),
  secretRule: table('Secret rules', 'secretRules', 'secret answer minutes', {
    key: 'secret',
    title: 'secret',
    search: 'secret',
  }),
  secretRuleAgent: table('Agent secret rules', 'secretRuleAgents', 'secret agent when', {
    key: 'secret agent when',
    title: 'secret',
    search: 'agent secret',
  }),
  secretUse: table('Secret usage', 'secretUses', 'id secret agent job at state', {
    title: 'secret',
    search: 'id agent secret',
  }),
  secretChange: table('Secret changes', 'secretChanges', 'id secret action by at', {
    title: 'secret',
    search: 'id secret',
  }),
  episode: table(
    'Agent conversations',
    'conversations',
    'id agent project venue label place startedAt lastAt turnCount',
    { title: 'label id', search: 'label id agent project' },
  ),
  participant: table('Conversation participants', 'conversationPeople', 'conversation whoKind who', {
    key: 'conversation whoKind who',
    title: 'who',
    search: 'who',
  }),
  turn: table('Conversation turns', 'turns', 'conversation seq at kind fromId run model outcome latencyMs', {
    key: 'conversation seq',
    title: 'kind',
    numbers: 'seq',
    search: 'model',
  }),
  digest: table(
    'Conversation digests',
    'digests',
    'id conversation run revision at summary inboxItem digestItemsByDigest { kind text }',
    { title: 'summary id', search: 'id' },
  ),
  day: table(
    'Conversation days',
    'conversationDays',
    'conversation day messages replies actions medianLatencyMs',
    { key: 'conversation day', title: 'day' },
  ),
  finding: table('Findings', 'findings', 'conversation day turnSeq measure score text', {
    key: 'conversation day turnSeq measure',
    title: 'measure',
    numbers: 'turnSeq',
    search: 'measure text',
  }),
  timing: table('Timing measurements', 'timingDays', 'day kind name count totalMs slowestMs typicalMs', {
    key: 'day kind name',
    title: 'name',
    search: 'name',
  }),
  measuring: table('Measurement settings', 'measuringSettings', 'singleton on sendOutside keepDays', {
    key: 'singleton',
    title: 'singleton',
    numbers: 'singleton',
  }),
  firing: table('Trigger history', 'triggerLog', 'seq trigger at event note', {
    key: 'seq',
    title: 'event',
    numbers: 'seq',
    search: 'note',
  }),
  triggerEdit: table('Trigger revisions', 'triggerEdits', 'seq trigger at byKind by', {
    key: 'seq',
    title: 'trigger',
    numbers: 'seq',
  }),
  pause: table('Paused agents', 'agentPauses', 'agent since', {
    key: 'agent',
    title: 'agent',
    search: 'agent',
  }),
  ticket: table(
    'Tickets',
    'tasks',
    'id title type status goal why doneWhen description priority project ownerKind owner assigneeKind assignee ask ifYes ifNo answers askedByKind askedBy sourceKind sourceId specItem criterion closeReason createdByKind createdBy startedAt closedAt changedAt createdAt isReady isShelved',
    {
      search: 'title id project',
    },
  ),
  project: table('Projects', 'projects', 'id name goal lifecycle', { search: 'name id' }),
  change: table(
    'Pull requests',
    'changes',
    'id repository number title body url state draft authorLogin project agent branch headCommit baseBranch checks review mergeable waitingOn openedAt updatedAt closedAt',
    { search: 'title id project repository' },
  ),
  approval: table(
    'Approvals',
    'approvals',
    'id kind target operation what why agent project member state ask ifYes ifNo askedAt expiresAt',
    { title: 'what id', search: 'id agent project' },
  ),
  question: source(
    'Inbox items',
    'inboxItems',
    'id source sourceId fromId agent project thread at state answers',
    'id',
    'sourceId id',
  ),
  message: {
    label: 'Messages',
    query: '',
    path: [],
    key: ['thread', 'seq'],
    title: ['sender'],
  } as EntityType,
  conversation: source(
    'Conversations',
    'commsThreads',
    'id title agent member project pinned lastAt working readSeq',
  ),
  agent: table('Agents', 'agents', 'id about removedAt', { search: 'id' }),
  member: table('Household members', 'members', 'id role fullOwner joinedAt removedAt', {
    title: 'id',
    search: 'id',
  }),
  person: source(
    'People',
    'memoryPeople(includeRemovedAgents:false)',
    'id name slug agent kind updated card {summary}',
  ),
  effect: { label: 'Held outside work', query: '', path: [], key: ['id'], title: ['title'] } as EntityType,
  sharing: source(
    'Project sharing',
    'householdSharing',
    'id name goal members agents repositories',
    'id',
    'name',
    'projects',
  ),
  account: source('Your account', 'account', 'member', 'member', 'member'),
  household: source(
    'Household',
    'householdSetup',
    'defaultAgent members {id role} agents {id about}',
    'defaultAgent',
    'defaultAgent',
  ),
  knowledge: source(
    'Knowledge pages',
    'memoryKnowledge',
    'slug title domain updated fresh by',
    'slug',
    'title slug',
    'pages',
  ),
  activity: source(
    'Activity',
    'memoryActivity(to:"recent")',
    'id agent title line at venue where what',
    'id',
    'title id',
    'entries',
  ),
  trigger: table(
    'Triggers',
    'triggers',
    'id owner sourceKind watches times days project instructions note enabled state nextDueAt',
    { title: 'note id', search: 'id project note' },
  ),
  projectNotes: source('Project notes', 'memoryProjects', 'id agent slug name updated activity archived'),
  memory: source('Project memories', 'memoryProjects', 'id agent sections { key items {ref title} }'),
  device: source(
    'Notification devices',
    'account',
    'notifications { devices {ref device createdAt seenAt} }',
    'ref',
    'device',
  ),
  token: source(
    'Household tokens',
    'householdSetup',
    'fingerprint label kind expired identity createdAt expiresAt revokedAt lastUsedAt',
    'fingerprint',
    'label',
    'tokens',
  ),
  householdSession: source(
    'Household sessions',
    'householdSetup',
    'ref device member tokenLabel isAgent ended issuedAt seenAt',
    'ref',
    'device',
    'sessions',
  ),
  usage: source(
    'Job usage',
    'conversationJobUsage(from:$from,to:$to)',
    'id title runKind state observations usage { harness model tokensIn tokensOut cacheRead cacheWritten modelCalls toolCalls firstContext largestContext wallMs }',
  ),
  post: source(
    'Agent activity threads',
    'agentActivityFeed(agent:$agent,limit:30)',
    'thread title latest {id at words}',
    'thread',
    'title',
  ),
  actionResult: source(
    'Action receipts',
    'inboxActionResults(limit:50)',
    'id at ok text readAt',
    'id',
    'text id',
  ),
  machineJob: source(
    'Machine jobs',
    'privateMachineJobs(agent:$agent)',
    'id agent box state queuedAt claimedAt endedAt summary',
    'id',
    'summary id',
  ),
  job: source(
    'Jobs',
    'jobHistory(agent:$agent,first:100)',
    'id agent title state box model queuedAt claimedAt endedAt',
  ),
  box: table('Machines', 'boxes', 'id name owner readers revokedAt', { search: 'name id' }),
  reading: table(
    'Machine readings',
    'boxReadings',
    'box kind thing usedPercent sizeMib freeMib engineStatus level readAt stale',
    { key: 'box kind thing', title: 'thing kind box', search: 'box' },
  ),
  subscription: source(
    'Model subscriptions',
    'modelAccounts',
    '... on RuntimeAccount { label level } ... on RuntimeAccountDetail { id owner provider usage usageReadAt resetsAt hasRoom windows {window usage resetsAt reserve} logins {box {id name} harness place state expiresAt} }',
    'label',
    'label',
  ),
  bridge: table(
    'Bridge connections',
    'bridgeConnections',
    'id platform agent workspace enabled state stateAt',
    { title: 'workspace id', search: 'id agent' },
  ),
  channel: table('Bridge channels', 'bridgeChannels', 'platform workspace channel answers botsMayTalk', {
    key: 'platform workspace channel',
    title: 'channel',
    search: 'channel',
  }),
  bridgePerson: table('Bridge identities', 'bridgePeople', 'platform workspace user member', {
    key: 'platform workspace user',
    title: 'user',
  }),
  bridgeSend: table(
    'Bridge deliveries',
    'bridgeSends',
    'id incoming connection channel thread state createdAt',
    { search: 'id channel' },
  ),
  secret: table('Secrets', 'secrets', 'name description changedAt changedBy', {
    key: 'name',
    title: 'name',
    search: 'name description',
  }),
  grant: table('Secret grants', 'secretGrants', 'id secret agent job request grantedBy grantedAt expiresAt', {
    title: 'secret id',
    search: 'id agent secret',
  }),
  secretRequest: table(
    'Secret requests',
    'secretRequests',
    'id secret agent job conversation why state minutes askedAt answeredAt',
    { title: 'secret id', search: 'id agent secret' },
  ),
  passkey: source(
    'Passkeys',
    'account',
    'ref label createdAt lastUsedAt ended',
    'ref',
    'label ref',
    'passkeys',
  ),
  session: source(
    'Sign-in sessions',
    'account',
    'ref device issuedAt seenAt ended',
    'ref',
    'device ref',
    'sessions',
  ),
  program: source(
    'Program grants',
    'programSetup',
    'fingerprint label member ended records operations',
    'fingerprint',
    'label',
    'tokens',
  ),
} satisfies Record<string, EntityType>;
export type EntityKind = keyof typeof entities;
export const ticketViews = { history: 'History', decision: 'Decisions' } as const;
export type TicketView = keyof typeof ticketViews;
export type EntityTarget = {
  kind: EntityKind;
  id?: string;
  scope?: string;
  part?: string[];
  view?: TicketView;
};
export function entityName(target: EntityTarget) {
  return target.id
    ? (target.part
        ? target.part.filter((v) => !/^([0-9a-f]{64}|record|related|detail)$/.test(v)).join(' · ') + ' · '
        : '') +
        (target.view ? ticketViews[target.view] + ' · ' : '') +
        target.kind +
        ' ' +
        target.id
    : entities[target.kind].label;
}
export function entityAddress(target: EntityTarget) {
  const params = new URLSearchParams();
  if (target.view) params.set('view', target.view);
  if (target.scope) params.set('scope', target.scope);
  if (target.part) params.set('part', JSON.stringify(target.part));
  return (
    'entity/' +
    target.kind +
    (target.id ? '/' + encodeURIComponent(target.id) : '') +
    (params.size ? '?' + params.toString() : '')
  );
}
export function entityAt(address: string): EntityTarget | null {
  const [path, params] = address.split('?');
  const [, kind, ...id] = path.split('/');
  const scope = new URLSearchParams(params).get('scope');
  if (!address.startsWith('entity/') || !Object.hasOwn(entities, kind)) return null;
  try {
    const view = new URLSearchParams(params).get('view');
    if (view && (kind !== 'ticket' || !id.length || !Object.hasOwn(ticketViews, view))) return null;
    const raw = new URLSearchParams(params).get('part');
    const part = raw ? JSON.parse(raw) : undefined;
    if (
      part &&
      (!Array.isArray(part) || !part.length || part.length > 32 || !part.every((k) => typeof k === 'string'))
    )
      return null;
    return {
      kind: kind as EntityKind,
      ...(view ? { view: view as TicketView } : {}),
      ...(part ? { part } : {}),
      ...(scope ? { scope } : {}),
      ...(id.length ? { id: decodeURIComponent(id.join('/')) } : {}),
    };
  } catch {
    return null;
  }
}
const aliases: Partial<Record<EntityKind, string[]>> = {
  ticket: ['task', 'tasks', 'epic', 'epics'],
  change: ['pull request', 'pr', 'prs'],
  question: ['inbox', 'question', 'questions'],
  box: ['machine', 'machines'],
  knowledge: ['knowledge', 'knowledge page'],
  subscription: ['subscription', 'subscriptions'],
  memory: ['memory', 'memories'],
  person: ['person', 'people'],
  conversation: ['thread', 'threads', 'chat', 'chats'],
  trigger: ['schedule', 'schedules'],
  post: ['activity thread'],
  projectNotes: ['project note'],
};
const nouns = Object.entries(entities)
  .flatMap(([key, spec]) => {
    const kind = key as EntityKind;
    return [spec.label, key, ...(aliases[kind] || [])].map((noun) => ({ kind, noun: noun.toLowerCase() }));
  })
  .sort((a, b) => b.noun.length - a.noun.length);
export function entityRequest(words: string): EntityTarget | null {
  const match = /^(?:show|open|find|list|bring up)\s+(?:me\s+)?(?:(?:the|my|all)\s+)?(.+?)\s*[?.!]?$/i.exec(
    words.trim(),
  );
  if (!match) return null;
  const text = match[1],
    lower = text.toLowerCase();
  if (/^t-\d+$/.test(lower)) return { kind: 'ticket', id: lower };
  for (const { kind, noun } of nouns) {
    if (lower === noun) return { kind };
    if (lower.startsWith(noun + ' ')) {
      const id = text.slice(noun.length + 1);
      return { kind, id: kind === 'ticket' && /^t-\d+$/i.test(id) ? id.toLowerCase() : id };
    }
  }
  return null;
}

export function entityKey(spec: EntityType, row: Record<string, unknown>) {
  return spec.key.length === 1 ? String(row[spec.key[0]]) : JSON.stringify(spec.key.map((k) => row[k]));
}
export function tableWhere(spec: EntityType, id: string | undefined, search: string) {
  if (id !== undefined) {
    let values: unknown[];
    try {
      values = spec.key.length === 1 ? [id] : JSON.parse(id);
    } catch {
      return { OR: [] };
    }
    if (!Array.isArray(values) || values.length !== spec.key.length) return { OR: [] };
    return Object.fromEntries(
      spec.key.map((k, i) => [
        k,
        {
          eq: spec.numberKeys?.includes(k)
            ? Number(values[i])
            : spec.booleanKeys?.includes(k)
              ? String(values[i]) === 'true'
              : values[i],
        },
      ]),
    );
  }
  if (!search.trim() || !spec.searchFields?.length) return undefined;
  return { OR: spec.searchFields.map((k) => ({ [k]: { like: '%' + search.trim() + '%' } })) };
}

export const entityGroups = {
  Work: [
    'ticket',
    'project',
    'change',
    'approval',
    'comment',
    'dependency',
    'projectMember',
    'check',
    'reviewer',
    'changeTask',
    'sync',
    'approvalEvent',
    'approvalNotice',
    'approvalRule',
    'sharing',
  ],
  'People and knowledge': ['person', 'knowledge', 'memory', 'projectNotes', 'activity'],
  Conversations: [
    'conversation',
    'message',
    'question',
    'post',
    'episode',
    'participant',
    'turn',
    'digest',
    'day',
    'finding',
    'actionResult',
  ],
  Automation: [
    'trigger',
    'firing',
    'triggerEdit',
    'pause',
    'effect',
    'job',
    'machineJob',
    'timing',
    'measuring',
  ],
  'Agents and machines': [
    'agent',
    'agentStatus',
    'box',
    'boxAgent',
    'boxFact',
    'reading',
    'machineAlert',
    'runSetting',
    'agentBox',
    'port',
    'model',
    'subscription',
    'usage',
  ],
  Bridges: ['bridge', 'channel', 'bridgePerson', 'bridgeSend', 'channelFilter', 'incoming'],
  'Secrets and access': [
    'secret',
    'grant',
    'secretRequest',
    'secretRule',
    'secretRuleAgent',
    'secretUse',
    'secretChange',
    'houseSecret',
    'tier',
    'deniedTool',
    'program',
    'token',
  ],
  Household: [
    'household',
    'account',
    'member',
    'memberAgent',
    'preference',
    'passkey',
    'session',
    'householdSession',
    'device',
  ],
} satisfies Record<string, EntityKind[]>;
