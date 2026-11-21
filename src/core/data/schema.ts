import type {KitTool} from '../../runtime/kit-manifest.js';
/** Approved how-it-works model. SQL names match model.py; application names use camelCase.
 * Times are UTC ISO-8601 text. Words already encrypted by Comms are opaque bytes.
 * This is the only authored database shape; drizzle-kit emits the fresh database DDL.
 */
import type { HouseProgram } from '../../runtime/house-program.js';
import { relations, sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, blob, primaryKey, check, index, uniqueIndex, foreignKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/** Canonical UTC timestamps, with either whole seconds or milliseconds. */
function utc(column: AnySQLiteColumn) {
  return sql`${column} is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', ${column}) = ${column} or strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}, 0)`;
}

/** One row per person in the household. */
export const members = sqliteTable('members', {
  id: text('id').primaryKey().notNull(),
  role: text('role', { enum: ["owner", "member"] }).notNull(),
  fullOwner: integer('full_owner', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull().default(0),
  joinedAt: text('joined_at').notNull(),
  removedAt: text('removed_at'),
}, t => [
  check('members_joined_at_utc', utc(t.joinedAt)),
  check('members_removed_at_utc', utc(t.removedAt)),
  check('members_role_choice', sql`${t.role} in ('owner', 'member')`),
  check('members_full_owner_boolean', sql`${t.fullOwner} in (0, 1)`),
  check('members_full_owner_role', sql`not ${t.fullOwner} or ${t.role} = 'owner'`),
]);

/** One row per agent. */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().notNull(),
  position: integer('position').notNull().default(0),
  about: text('about').notNull(),
  aboutAskedAt: text('about_asked_at'),
  markBg: text('mark_bg').notNull(),
  markFg: text('mark_fg').notNull(),
  faceShape: text('face_shape', { enum: ["pebble", "trefoil", "clover", "drop"] }).notNull(),
  faceEyes: text('face_eyes', { enum: ["dot", "oval"] }).notNull(),
  spriteVersion: text('sprite_version'),
  removedAt: text('removed_at'),
}, t => [
  check('agents_about_asked_at_utc', utc(t.aboutAskedAt)),
  check('agents_removed_at_utc', utc(t.removedAt)),
  check('agents_about_length', sql`length(${t.about}) <= 600`),
  check('agents_face_shape_choice', sql`${t.faceShape} in ('pebble', 'trefoil', 'clover', 'drop')`),
  check('agents_face_eyes_choice', sql`${t.faceEyes} in ('dot', 'oval')`),
]);

/** Which member owns which agent. */
export const memberAgents = sqliteTable('member_agents', {
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
}, t => [
  primaryKey({ columns: [t.member, t.agent] }),
]);

/** One row per project. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  removedAt: text('removed_at'),
  /** When the project was retired, if it is: kept whole and readable, with its unfinished tasks shelved. */
  retiredAt: text('retired_at'),
}, t => [
  check('projects_removed_at_utc', utc(t.removedAt)),
  check('projects_retired_at_utc', utc(t.retiredAt)),
]);

/** Who is on a project. */
export const projectMembers = sqliteTable('project_members', {
  project: text('project').notNull().references((): AnySQLiteColumn => projects.id),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
}, t => [
  primaryKey({ columns: [t.project, t.member] }),
]);

/** Which agents work on a project. */
export const projectAgents = sqliteTable('project_agents', {
  project: text('project').notNull().references((): AnySQLiteColumn => projects.id),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
}, t => [
  primaryKey({ columns: [t.project, t.agent] }),
]);

/** The code repositories that belong to a project. A pull request is filed under a project by matching its repository here. */
export const projectRepositories = sqliteTable('project_repositories', {
  project: text('project').notNull().references((): AnySQLiteColumn => projects.id),
  repository: text('repository').notNull(),
}, t => [
  primaryKey({ columns: [t.project, t.repository] }),
]);

/** An agent's accounts on outside services, used to tell which agent opened a pull request. */
export const agentAccounts = sqliteTable('agent_accounts', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  service: text('service', { enum: ["github"] }).notNull(),
  login: text('login').notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.service, t.login] }),
  check('agent_accounts_service_choice', sql`${t.service} in ('github')`),
  uniqueIndex('agent_accounts_login_unique').on(t.service, t.login),
]);

/** An agent's animated portrait: the picture sheets and how to cut them up. */
export const agentSprites = sqliteTable('agent_sprites', {
  agent: text('agent').primaryKey().notNull().references((): AnySQLiteColumn => agents.id),
  layout: text('layout').notNull(),
  sheets: blob('sheets', { mode: 'buffer' }).notNull(),
});

/** One row of household-wide settings. */
export const household = sqliteTable('household', {
  singleton: integer('singleton').primaryKey().default(1).notNull(),
  defaultAgent: text('default_agent').references((): AnySQLiteColumn => agents.id),
  timezone: text('timezone').notNull().default('UTC'),
  commsDays: integer('comms_days').notNull().default(14),
  githubOwner: text('github_owner').notNull().default(''),
  secretsDefault: text('secrets_default', { enum: ["ask", "auto", "never"] }).notNull().default('ask'),
  backupTarget: text('backup_target').notNull().default(''),
  backupAt: text('backup_at').notNull().default('03:00'),
  backupKeep: integer('backup_keep').notNull().default(7),
}, t => [
  check('household_singleton', sql`${t.singleton} = 1`),
  check('household_secrets_default_choice', sql`${t.secretsDefault} in ('ask', 'auto', 'never')`),
  check('household_comms_days_range', sql`${t.commsDays} between 1 and 14`),
  check('household_backup_keep_range', sql`${t.backupKeep} between 1 and 90`),
]);

/** The public keys a backup is encrypted to. */
export const backupRecipients = sqliteTable('backup_recipients', {
  recipient: text('recipient').primaryKey().notNull(),
});

/** How one person likes loom to look and behave. */
export const memberPreferences = sqliteTable('member_preferences', {
  member: text('member').primaryKey().notNull().references((): AnySQLiteColumn => members.id),
  look: text('look', { enum: ["neon", "lowlight", "daylight"] }).notNull(),
  ground: text('ground', { enum: ["depth", "contours", "wash"] }).notNull(),
  sound: integer('sound', { mode: 'boolean' }).notNull(),
  pixel: integer('pixel', { mode: 'boolean' }).notNull(),
  icons: integer('icons', { mode: 'boolean' }).notNull(),
  haptics: integer('haptics', { mode: 'boolean' }).notNull(),
  oneWindow: integer('one_window', { mode: 'boolean' }).notNull(),
  zoom: integer('zoom', { mode: 'boolean' }).notNull(),
  motion: text('motion', { enum: ["follow", "on", "off"] }).notNull(),
  contrast: text('contrast', { enum: ["follow", "on", "off"] }).notNull(),
  changedAt: text('changed_at').notNull(),
}, t => [
  check('member_preferences_changed_at_utc', utc(t.changedAt)),
  check('member_preferences_look_choice', sql`${t.look} in ('neon', 'lowlight', 'daylight')`),
  check('member_preferences_ground_choice', sql`${t.ground} in ('depth', 'contours', 'wash')`),
  check('member_preferences_sound_boolean', sql`${t.sound} in (0, 1)`),
  check('member_preferences_pixel_boolean', sql`${t.pixel} in (0, 1)`),
  check('member_preferences_icons_boolean', sql`${t.icons} in (0, 1)`),
  check('member_preferences_haptics_boolean', sql`${t.haptics} in (0, 1)`),
  check('member_preferences_one_window_boolean', sql`${t.oneWindow} in (0, 1)`),
  check('member_preferences_zoom_boolean', sql`${t.zoom} in (0, 1)`),
  check('member_preferences_motion_choice', sql`${t.motion} in ('follow', 'on', 'off')`),
  check('member_preferences_contrast_choice', sql`${t.contrast} in ('follow', 'on', 'off')`),
]);

/** One row per credential. Loom stores only a fingerprint of each token, never the token. */
export const tokens = sqliteTable('tokens', {
  fingerprint: text('fingerprint').primaryKey().notNull(),
  label: text('label').notNull(),
  kind: text('kind', { enum: ["owner", "agent", "runner"] }).notNull(),
  member: text('member').references((): AnySQLiteColumn => members.id),
  agent: text('agent').references((): AnySQLiteColumn => agents.id),
  job: text('job').references((): AnySQLiteColumn => jobs.id),
  box: text('box').references((): AnySQLiteColumn => boxes.id),
  madeFrom: text('made_from').references((): AnySQLiteColumn => tokens.fingerprint),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  lastUsedAt: text('last_used_at'),
}, t => [
  check('tokens_created_at_utc', utc(t.createdAt)),
  check('tokens_expires_at_utc', utc(t.expiresAt)),
  check('tokens_revoked_at_utc', utc(t.revokedAt)),
  check('tokens_last_used_at_utc', utc(t.lastUsedAt)),
  check('tokens_identity', sql`(${t.kind} = 'owner' and ${t.member} is not null and ${t.agent} is null and ${t.box} is null and ${t.job} is null) or (${t.kind} = 'agent' and ${t.agent} is not null and ${t.member} is null and ${t.box} is null) or (${t.kind} = 'runner' and ${t.box} is not null and ${t.member} is null and ${t.agent} is null and ${t.job} is null)`),
  check('tokens_kind_choice', sql`${t.kind} in ('owner', 'agent', 'runner')`),
  index('tokens_label_idx').on(t.label),
  index('tokens_expires_at_idx').on(t.expiresAt),
]);

/** Internal outside-program restrictions. The marker survives an empty grant set. */
export const programTokens = sqliteTable('program_tokens', {
  token: text('token').primaryKey().notNull().references((): AnySQLiteColumn => tokens.fingerprint, {onDelete:'cascade'}),
});
export const programRecordGrants = sqliteTable('program_record_grants', {
  token: text('token').notNull().references((): AnySQLiteColumn => programTokens.token, {onDelete:'cascade'}),
  recordType: text('record_type').notNull(),
}, t => [primaryKey({columns:[t.token,t.recordType]}),check('program_record_grants_name',sql`length(${t.recordType}) between 1 and 200`)]);
export const programOperationGrants = sqliteTable('program_operation_grants', {
  token: text('token').notNull().references((): AnySQLiteColumn => programTokens.token, {onDelete:'cascade'}),
  operation: text('operation').notNull(),
}, t => [primaryKey({columns:[t.token,t.operation]}),check('program_operation_grants_name',sql`length(${t.operation}) between 1 and 200`)]);

/** One row per signed-in browser. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey().notNull(),
  token: text('token').notNull().references((): AnySQLiteColumn => tokens.fingerprint),
  device: text('device').notNull(),
  via: text('via', { enum: ["link", "passkey", "token"] }).notNull(),
  isAgent: integer('is_agent', { mode: 'boolean' }).notNull(),
  issuedAt: text('issued_at').notNull(),
  seenAt: text('seen_at').notNull(),
  provedAt: text('proved_at').notNull(),
  passkey: text('passkey').references((): AnySQLiteColumn => passkeys.id),
  // The browser whose sign-in link signed this one in. Ending that browser ends this one.
  madeBy: text('made_by').references((): AnySQLiteColumn => sessions.id),
}, t => [
  check('sessions_issued_at_utc', utc(t.issuedAt)),
  check('sessions_seen_at_utc', utc(t.seenAt)),
  check('sessions_proved_at_utc', utc(t.provedAt)),
  check('sessions_via_choice', sql`${t.via} in ('link', 'passkey', 'token')`),
  check('sessions_is_agent_boolean', sql`${t.isAgent} in (0, 1)`),
]);

/** One-time links that sign a browser in. */
export const signinLinks = sqliteTable('signin_links', {
  id: text('id').primaryKey().notNull(),
  token: text('token').notNull().references((): AnySQLiteColumn => tokens.fingerprint),
  label: text('label').notNull(),
  expiresAt: text('expires_at').notNull(),
  // The browser that made the link, when a browser did. The link is good only while that browser is signed in.
  session: text('session').references((): AnySQLiteColumn => sessions.id),
  // Whoever made the link said it is for an automated browser.
  isAgent: integer('is_agent', { mode: 'boolean' }).notNull().default(false),
}, t => [
  check('signin_links_expires_at_utc', utc(t.expiresAt)),
  check('signin_links_is_agent_boolean', sql`${t.isAgent} in (0, 1)`),
]);

/** Passkeys people have registered. */
export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey().notNull(),
  token: text('token').notNull().references((): AnySQLiteColumn => tokens.fingerprint),
  label: text('label').notNull(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
}, t => [
  check('passkeys_created_at_utc', utc(t.createdAt)),
  check('passkeys_last_used_at_utc', utc(t.lastUsedAt)),
]);

/** Phones and browsers that receive notifications. */
export const notificationDevices = sqliteTable('notification_devices', {
  endpoint: text('endpoint').primaryKey().notNull(),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
  session: text('session').notNull().references((): AnySQLiteColumn => sessions.id),
  keys: text('keys').notNull(),
  device: text('device').notNull(),
  createdAt: text('created_at').notNull(),
  seenAt: text('seen_at').notNull(),
}, t => [
  check('notification_devices_created_at_utc', utc(t.createdAt)),
  check('notification_devices_seen_at_utc', utc(t.seenAt)),
]);

/** One row per task. */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull(),
  title: text('title').notNull(),
  type: text('type', { enum: ["task", "bug", "feature", "epic"] }).notNull().default('task'),
  status: text('status', { enum: ["open", "in_progress", "closed"] }).notNull().default('open'),
  priority: integer('priority').notNull().default(2),
  ownerKind: text('owner_kind', { enum: ["member", "agent", "household"] }).notNull(),
  owner: text('owner'),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  assigneeKind: text('assignee_kind', { enum: ["member", "agent"] }),
  assignee: text('assignee'),
  goal: text('goal').notNull().default(''),
  why: text('why').notNull().default(''),
  doneWhen: text('done_when').notNull().default(''),
  description: text('description').notNull().default(''),
  ask: text('ask'),
  ifYes: text('if_yes'),
  ifNo: text('if_no'),
  answers: text('answers').$type<'yes-no' | 'words'>(),
  askedByKind: text('asked_by_kind', { enum: ["member", "agent"] }),
  askedBy: text('asked_by'),
  sourceKind: text('source_kind'),
  sourceId: text('source_id'),
  specItem: text('spec_item'),
  criterion: text('criterion'),
  closeReason: text('close_reason'),
  createdByKind: text('created_by_kind', { enum: ["member", "agent"] }).notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  closedAt: text('closed_at'),
  changedAt: text('changed_at').notNull(),
  position: integer('position').notNull().default(0),
}, t => [
  check('tasks_created_at_utc', utc(t.createdAt)),
  check('tasks_started_at_utc', utc(t.startedAt)),
  check('tasks_closed_at_utc', utc(t.closedAt)),
  check('tasks_changed_at_utc', utc(t.changedAt)),
  check('tasks_type_choice', sql`${t.type} in ('task', 'bug', 'feature', 'epic')`),
  check('tasks_status_choice', sql`${t.status} in ('open', 'in_progress', 'closed')`),
  check('tasks_owner_kind_choice', sql`${t.ownerKind} in ('member', 'agent', 'household')`),
  check('tasks_assignee_kind_choice', sql`${t.assigneeKind} in ('member', 'agent')`),
  check('tasks_answers_choice', sql`${t.answers} in ('yes-no', 'words')`),
  check('tasks_asked_by_kind_choice', sql`${t.askedByKind} in ('member', 'agent')`),
  check('tasks_created_by_kind_choice', sql`${t.createdByKind} in ('member', 'agent')`),
  check('tasks_priority_range', sql`${t.priority} between 0 and 4`),
  check('tasks_owner_required', sql`(${t.ownerKind} = 'household' and ${t.owner} is null) or (${t.ownerKind} <> 'household' and ${t.owner} is not null)`),
  check('tasks_assignee_pair', sql`(${t.assigneeKind} is null) = (${t.assignee} is null)`),
  uniqueIndex('tasks_spec_line_unique').on(t.specItem, t.criterion).where(sql`${t.specItem} is not null and ${t.criterion} is not null`),
  index('tasks_status_priority_position_idx').on(t.status, t.priority, t.position),
  index('tasks_project_status_idx').on(t.project, t.status),
  index('tasks_owner_kind_owner_idx').on(t.ownerKind, t.owner),
  index('tasks_assignee_kind_assignee_idx').on(t.assigneeKind, t.assignee),
]);

/** How tasks depend on each other. */
export const taskLinks = sqliteTable('task_links', {
  task: text('task').notNull().references((): AnySQLiteColumn => tasks.id),
  dependsOn: text('depends_on').notNull().references((): AnySQLiteColumn => tasks.id),
  type: text('type').$type<'parent-child' | 'blocks'>().notNull(),
}, t => [
  primaryKey({ columns: [t.task, t.dependsOn, t.type] }),
  check('task_links_type_choice', sql`${t.type} in ('parent-child', 'blocks')`),
  check('task_links_no_self_link', sql`${t.task} <> ${t.dependsOn}`),
  uniqueIndex('task_links_one_parent_unique').on(t.task).where(sql`${t.type} = 'parent-child'`),
]);

/** Notes left on a task, oldest first. */
export const taskComments = sqliteTable('task_comments', {
  task: text('task').notNull().references((): AnySQLiteColumn => tasks.id),
  seq: integer('seq').notNull(),
  actorKind: text('actor_kind', { enum: ["member", "agent"] }).notNull(),
  actor: text('actor').notNull(),
  at: text('at').notNull(),
  text: text('text').notNull(),
}, t => [
  check('task_comments_at_utc', utc(t.at)),
  primaryKey({ columns: [t.task, t.seq] }),
  check('task_comments_actor_kind_choice', sql`${t.actorKind} in ('member', 'agent')`),
]);

/** One row per conversation. This single table replaces three that used to describe the same thing from different sides. */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey().notNull(),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  member: text('member').references((): AnySQLiteColumn => members.id),
  venue: text('venue', { enum: ["loom", "discord", "slack", "wake", "handoff", "terminal"] }).notNull(),
  place: text('place').notNull(),
  label: text('label').notNull(),
  direct: integer('direct', { mode: 'boolean' }).notNull().default(false),
  startedAt: text('started_at').notNull(),
  lastAt: text('last_at').notNull(),
  turnCount: integer('turn_count').notNull(),
  handoffNotBefore: text('handoff_not_before'),
}, t => [
  check('conversations_handoff_not_before_utc', utc(t.handoffNotBefore)),
  check('conversations_direct_boolean', sql`${t.direct} in (0, 1)`),
  check('conversations_started_at_utc', utc(t.startedAt)),
  check('conversations_last_at_utc', utc(t.lastAt)),
  check('conversations_venue_choice', sql`${t.venue} in ('loom', 'discord', 'slack', 'wake', 'handoff', 'terminal')`),
  uniqueIndex('conversations_place_unique').on(t.agent, t.venue, t.place),
  index('conversations_project_idx').on(t.project),
  index('conversations_member_idx').on(t.member),
  index('conversations_agent_last_at_idx').on(t.agent, t.lastAt),
]);

/** Who has spoken in a conversation. */
export const conversationPeople = sqliteTable('conversation_people', {
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  whoKind: text('who_kind', { enum: ["person", "agent"] }).notNull(),
  who: text('who').notNull(),
}, t => [
  primaryKey({ columns: [t.conversation, t.whoKind, t.who] }),
  check('conversation_people_who_kind_choice', sql`${t.whoKind} in ('person', 'agent')`),
]);

/** One row per thing said or done in a conversation. No words are kept here. */
export const turns = sqliteTable('turns', {
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  seq: integer('seq').notNull(),
  at: text('at').notNull(),
  kind: text('kind', { enum: ["message", "reply", "action", "wake", "note", "refused"] }).notNull(),
  fromKind: text('from_kind', { enum: ["person", "agent", "schedule", "unknown"] }).notNull(),
  fromId: text('from_id'),
  run: text('run'),
  model: text('model'),
  outcome: text('outcome', { enum: ["answered", "progressed", "deferred", "failed", "none"] }),
  latencyMs: real('latency_ms'),
}, t => [
  check('turns_at_utc', utc(t.at)),
  primaryKey({ columns: [t.conversation, t.seq] }),
  check('turns_kind_choice', sql`${t.kind} in ('message', 'reply', 'action', 'wake', 'note', 'refused')`),
  check('turns_from_kind_choice', sql`${t.fromKind} in ('person', 'agent', 'schedule', 'unknown')`),
  check('turns_outcome_choice', sql`${t.outcome} in ('answered', 'progressed', 'deferred', 'failed', 'none')`),
]);

/** An agent's write-up at the end of a stretch of work. */
export const digests = sqliteTable('digests', {
  id: text('id').primaryKey().notNull(),
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  run: text('run').notNull(),
  revision: integer('revision').notNull(),
  at: text('at').notNull(),
  summary: text('summary').notNull(),
  inboxItem: text('inbox_item').references((): AnySQLiteColumn => inbox.id),
}, t => [
  check('digests_summary_length', sql`length(${t.summary}) <= 600`),
  check('digests_at_utc', utc(t.at)),
]);

/** The lists inside a digest. */
export const digestItems = sqliteTable('digest_items', {
  digest: text('digest').notNull().references((): AnySQLiteColumn => digests.id),
  kind: text('kind', { enum: ["decision", "ask", "task", "project"] }).notNull(),
  text: text('text').notNull(),
}, t => [
  primaryKey({ columns: [t.digest, t.kind, t.text] }),
  check('digest_items_kind_choice', sql`${t.kind} in ('decision', 'ask', 'task', 'project')`),
]);

/** What each agent is doing right now. */
export const agentStatus = sqliteTable('agent_status', {
  agent: text('agent').primaryKey().notNull().references((): AnySQLiteColumn => agents.id),
  state: text('state', { enum: ["working", "waiting", "idle", "offline"] }).notNull(),
  work: text('work').notNull(),
  changedAt: text('changed_at').notNull(),
}, t => [
  check('agent_status_changed_at_utc', utc(t.changedAt)),
  check('agent_status_state_choice', sql`${t.state} in ('working', 'waiting', 'idle', 'offline')`),
]);

/** A daily roll-up kept after a conversation's turns are 90 days old. */
export const conversationDays = sqliteTable('conversation_days', {
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  day: text('day').notNull(),
  messages: integer('messages').notNull(),
  replies: integer('replies').notNull(),
  actions: integer('actions').notNull(),
  medianLatencyMs: real('median_latency_ms').notNull(),
}, t => [
  primaryKey({ columns: [t.conversation, t.day] }),
]);

/** A reviewer's score for one of an agent's turns. */
export const findings = sqliteTable('findings', {
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  day: text('day').notNull(),
  turnSeq: integer('turn_seq').notNull(),
  measure: text('measure').notNull(),
  score: real('score').notNull(),
  text: text('text').notNull(),
}, t => [
  primaryKey({ columns: [t.conversation, t.day, t.turnSeq, t.measure] }),
  check('findings_score_range', sql`${t.score} between 1 and 5`),
]);

/** One row per thing sent to a person or an agent. This single table replaces the agent's five inboxes and the list of questions for people. */
export const inbox = sqliteTable('inbox', {
  id: text('id').primaryKey().notNull(),
  toKind: text('to_kind', { enum: ["person", "agent"] }).notNull(),
  to: text('to').notNull(),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  seq: integer('seq'),
  source: text('source').$type<'thread' | 'discord' | 'slack' | 'trigger' | 'handoff' | 'answer' | 'task' | 'approval' | 'secret-request' | 'notice'>().notNull(),
  sourceId: text('source_id'),
  fromKind: text('from_kind', { enum: ["person", "agent", "schedule", "unknown"] }).notNull(),
  fromId: text('from_id'),
  words: text('words'),
  at: text('at').notNull(),
  state: text('state', { enum: ["waiting", "taken", "done", "answered", "resolved"] }).notNull(),
  volume: text('volume', { enum: ["full", "dim", "mute"] }).notNull().default('full'),
  quietUntil: text('quiet_until'),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  agent: text('agent').references((): AnySQLiteColumn => agents.id),
  member: text('member').references((): AnySQLiteColumn => members.id),
  job: text('job').references((): AnySQLiteColumn => jobs.id),
  takenAt: text('taken_at'),
  firstAcceptedAt: text('first_accepted_at'),
  // Internal lease metadata: current quiet volume can change after confirmation.
  takenVolume: text('taken_volume', {enum:['full','dim','mute']}),
  doneAt: text('done_at'),
  answers: text('answers').$type<'yes-no' | 'words'>(),
  why: text('why'),
  ifYes: text('if_yes'),
  ifNo: text('if_no'),
  link: text('link'),
  waitsOnKind: text('waits_on_kind'),
  waitsOnId: text('waits_on_id'),
  thread: text('thread').references((): AnySQLiteColumn => threads.id),
  messageSeq: integer('message_seq'),
  answer: text('answer', { enum: ["yes", "no", "done", "dismiss", "words", "replied"] }),
  answerText: text('answer_text'),
  answeredBy: text('answered_by').references((): AnySQLiteColumn => members.id),
  answeredAt: text('answered_at'),
  resolution: text('resolution'),
  changedAt: text('changed_at').notNull(),
  /** The person on whose word this mail was sent, when that is not who sent it: the asker of a trigger's
   * firing, and the person a body was working for when it handed a note on. A member's id or an outside
   * account's key. The job this mail starts counts them as in the room (runtime/body-policy.ts). */
  onWordKind: text('on_word_kind', { enum: ["member", "outside"] }),
  onWord: text('on_word'),
  /** For a note one body of an agent hands to another: the conversations the chain of hand-offs has run
   * through, oldest first, as a JSON list of ids ending with the one this note came from; and when the
   * first note of the chain was sent. Its length is json_array_length(chain). */
  chain: text('chain'),
  chainStartedAt: text('chain_started_at'),
}, t => [
  check('inbox_chain_started_at_utc', utc(t.chainStartedAt)),
  check('inbox_on_word_kind_choice', sql`${t.onWordKind} in ('member', 'outside')`),
  check('inbox_on_word_pair', sql`(${t.onWordKind} is null) = (${t.onWord} is null)`),
  check('inbox_chain_pair', sql`(${t.chain} is null) = (${t.chainStartedAt} is null) and (${t.chain} is null or (json_valid(${t.chain}) and json_type(${t.chain}) = 'array'))`),
  check('inbox_at_utc', utc(t.at)),
  check('inbox_quiet_until_utc', utc(t.quietUntil)),
  check('inbox_taken_at_utc', utc(t.takenAt)),
  check('inbox_first_accepted_at_utc', utc(t.firstAcceptedAt)),
  check('inbox_done_at_utc', utc(t.doneAt)),
  check('inbox_answered_at_utc', utc(t.answeredAt)),
  check('inbox_changed_at_utc', utc(t.changedAt)),
  foreignKey({ columns: [t.thread, t.messageSeq], foreignColumns: [messages.thread, messages.seq] }),
  check('inbox_message_pair', sql`${t.messageSeq} is null or ${t.thread} is not null`),
  check('inbox_to_kind_choice', sql`${t.toKind} in ('person', 'agent')`),
  check('inbox_source_choice', sql`${t.source} in ('thread', 'discord', 'slack', 'trigger', 'handoff', 'answer', 'task', 'approval', 'secret-request', 'notice')`),
  check('inbox_from_kind_choice', sql`${t.fromKind} in ('person', 'agent', 'schedule', 'unknown')`),
  check('inbox_state_choice', sql`${t.state} in ('waiting', 'taken', 'done', 'answered', 'resolved')`),
  check('inbox_taken_volume_choice', sql`${t.takenVolume} in ('full', 'dim', 'mute')`),
  check('inbox_volume_choice', sql`${t.volume} in ('full', 'dim', 'mute')`),
  check('inbox_answers_choice', sql`${t.answers} in ('yes-no', 'words')`),
  check('inbox_answer_choice', sql`${t.answer} in ('yes', 'no', 'done', 'dismiss', 'words', 'replied')`),
  uniqueIndex('inbox_source_unique').on(t.toKind, t.to, t.source, t.sourceId).where(sql`${t.sourceId} is not null`),
  uniqueIndex('inbox_sequence_unique').on(t.conversation, t.seq).where(sql`${t.conversation} is not null`),
  index('inbox_to_kind_to_state_at_idx').on(t.toKind, t.to, t.state, t.at),
  index('inbox_conversation_seq_idx').on(t.conversation, t.seq),
]);

/** The things an inbox item is about. */
export const inboxRefs = sqliteTable('inbox_refs', {
  item: text('item').notNull().references((): AnySQLiteColumn => inbox.id),
  ref: text('ref').notNull(),
}, t => [
  primaryKey({ columns: [t.item, t.ref] }),
]);

/** Which member has opened which item. */
export const inboxReads = sqliteTable('inbox_reads', {
  item: text('item').notNull().references((): AnySQLiteColumn => inbox.id),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
  readAt: text('read_at').notNull(),
}, t => [
  check('inbox_reads_read_at_utc', utc(t.readAt)),
  primaryKey({ columns: [t.item, t.member] }),
]);

/** The outcome of the last few things a person did, shown as small notices. */
export const actionResults = sqliteTable('action_results', {
  id: text('id').primaryKey().notNull(),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
  at: text('at').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  text: text('text').notNull(),
  page: text('page').notNull(),
  readAt: text('read_at'),
}, t => [
  check('action_results_at_utc', utc(t.at)),
  check('action_results_read_at_utc', utc(t.readAt)),
  check('action_results_ok_boolean', sql`${t.ok} in (0, 1)`),
]);

/** One row per chat between a person and an agent. */
export const threads = sqliteTable('threads', {
  id: text('id').primaryKey().notNull(),
  conversation: text('conversation').notNull().references((): AnySQLiteColumn => conversations.id),
  title: text('title').notNull(),
  titledBy: text('titled_by', { enum: ["member", "agent"] }).notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull(),
  archivedAt: text('archived_at'),
  openedAt: text('opened_at').notNull(),
  lastAt: text('last_at').notNull(),
  readSeq: integer('read_seq').notNull(),
  working: integer('working', { mode: 'boolean' }).notNull(),
  workingSince: text('working_since'),
  workingBeat: text('working_beat'),
  stopRequested: integer('stop_requested', { mode: 'boolean' }).notNull(),
}, t => [
  check('threads_archived_at_utc', utc(t.archivedAt)),
  check('threads_opened_at_utc', utc(t.openedAt)),
  check('threads_last_at_utc', utc(t.lastAt)),
  check('threads_working_since_utc', utc(t.workingSince)),
  check('threads_working_beat_utc', utc(t.workingBeat)),
  check('threads_titled_by_choice', sql`${t.titledBy} in ('member', 'agent')`),
  check('threads_title_length', sql`length(${t.title}) <= 60`),
  check('threads_pinned_boolean', sql`${t.pinned} in (0, 1)`),
  check('threads_working_boolean', sql`${t.working} in (0, 1)`),
  check('threads_stop_requested_boolean', sql`${t.stopRequested} in (0, 1)`),
  uniqueIndex('threads_conversation_unique').on(t.conversation),
]);

/** One row per message in a thread. */
export const messages = sqliteTable('messages', {
  thread: text('thread').notNull().references((): AnySQLiteColumn => threads.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  kind: text('kind', { enum: ["message", "reply", "card", "ask", "answer", "notice"] }).notNull(),
  sender: text('sender').notNull(),
  at: text('at').notNull(),
  words: blob('words', { mode: 'buffer' }),
  keepUntil: text('keep_until'),
  delivery: text('delivery', { enum: ["sending", "held", "failed", "delivered"] }),
  inboxItem: text('inbox_item').references((): AnySQLiteColumn => inbox.id),
  verdict: text('verdict', { enum: ["yes", "no"] }),
  run: text('run'),
  tool: text('tool'),
  cardState: text('card_state', { enum: ["running", "done", "failed"] }),
  clientId: text('client_id'),
}, t => [
  check('messages_at_utc', utc(t.at)),
  check('messages_keep_until_utc', utc(t.keepUntil)),
  primaryKey({ columns: [t.thread, t.seq] }),
  check('messages_kind_choice', sql`${t.kind} in ('message', 'reply', 'card', 'ask', 'answer', 'notice')`),
  check('messages_delivery_choice', sql`${t.delivery} in ('sending', 'held', 'failed', 'delivered')`),
  check('messages_verdict_choice', sql`${t.verdict} in ('yes', 'no')`),
  check('messages_card_state_choice', sql`${t.cardState} in ('running', 'done', 'failed')`),
  uniqueIndex('messages_client_id_unique').on(t.thread, t.sender, t.clientId).where(sql`${t.clientId} is not null`),
  index('messages_keep_until_idx').on(t.keepUntil),
]);

/** Tasks, pull requests and notes mentioned in a thread. */
export const threadRefs = sqliteTable('thread_refs', {
  thread: text('thread').notNull().references((): AnySQLiteColumn => threads.id, { onDelete: 'cascade' }),
  ref: text('ref').notNull(),
  messageSeq: integer('message_seq').notNull(),
}, t => [
  primaryKey({ columns: [t.thread, t.ref] }),
  foreignKey({ columns: [t.thread, t.messageSeq], foreignColumns: [messages.thread, messages.seq] }).onDelete('cascade'),
]);

/** A marker left when a thread is deleted, so its id is never reused. */
export const deletedThreads = sqliteTable('deleted_threads', {
  id: text('id').primaryKey().notNull(),
  conversation: text('conversation').notNull(),
  at: text('at').notNull(),
}, t => [
  check('deleted_threads_at_utc', utc(t.at)),
]);

/** One row per request for permission. */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey().notNull(),
  kind: text('kind', { enum: ["merge", "command", "setting", "dangerous"] }).notNull(),
  operation: text('operation'),
  changeSummary: text('change_summary'),
  target: text('target').notNull(),
  what: text('what').notNull(),
  why: text('why').notNull(),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  askedFrom: text('asked_from').notNull(),
  actingFor: text('acting_for').notNull(),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  member: text('member').references((): AnySQLiteColumn => members.id),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  state: text('state', { enum: ["pending", "allowed", "denied", "used", "withdrawn", "expired"] }).notNull(),
  minutes: integer('minutes').notNull(),
  ask: text('ask').notNull(),
  ifYes: text('if_yes').notNull(),
  ifNo: text('if_no').notNull(),
  details: text('details').notNull(),
  decidedBy: text('decided_by').references((): AnySQLiteColumn => members.id),
  askedAt: text('asked_at').notNull(),
  decidedAt: text('decided_at'),
  expiresAt: text('expires_at'),
  usedAt: text('used_at'),
  overriddenBy: text('overridden_by').references((): AnySQLiteColumn => approvals.id),
}, t => [
  check('approvals_asked_at_utc', utc(t.askedAt)),
  check('approvals_decided_at_utc', utc(t.decidedAt)),
  check('approvals_expires_at_utc', utc(t.expiresAt)),
  check('approvals_used_at_utc', utc(t.usedAt)),
  check('approvals_kind_choice', sql`${t.kind} in ('merge', 'command', 'setting', 'dangerous')`),
  check('approvals_state_choice', sql`${t.state} in ('pending', 'allowed', 'denied', 'used', 'withdrawn', 'expired')`),
]);

/** Standing answers. */
export const approvalRules = sqliteTable('approval_rules', {
  kind: text('kind', { enum: ["merge", "command", "setting", "dangerous"] }).notNull(),
  scope: text('scope').notNull(),
  person: text('person').notNull().default(''),
  tier: text('tier', { enum: ["do", "tell", "ask"] }).notNull(),
  setBy: text('set_by').notNull().references((): AnySQLiteColumn => members.id),
  setAt: text('set_at').notNull(),
}, t => [
  check('approval_rules_set_at_utc', utc(t.setAt)),
  primaryKey({ columns: [t.kind, t.scope, t.person] }),
  check('approval_rules_kind_choice', sql`${t.kind} in ('merge', 'command', 'setting', 'dangerous')`),
  check('approval_rules_tier_choice', sql`${t.tier} in ('do', 'tell', 'ask')`),
]);

/** Things an agent did under a do-and-tell rule. */
export const approvalNotices = sqliteTable('approval_notices', {
  id: text('id').primaryKey().notNull(),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  kind: text('kind').notNull(),
  target: text('target').notNull(),
  what: text('what').notNull(),
  at: text('at').notNull(),
}, t => [
  check('approval_notices_at_utc', utc(t.at)),
]);

/** The permanent record: every request, answer and use, never edited. */
export const approvalRecord = sqliteTable('approval_record', {
  seq: integer('seq').primaryKey().notNull(),
  at: text('at').notNull(),
  event: text('event').$type<'request' | 'allow' | 'deny' | 'use' | 'withdraw' | 'grant' | 'refused-use'>().notNull(),
  approval: text('approval').notNull().references((): AnySQLiteColumn => approvals.id),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  note: text('note').notNull(),
}, t => [
  check('approval_record_at_utc', utc(t.at)),
  check('approval_record_event_choice', sql`${t.event} in ('request', 'allow', 'deny', 'use', 'withdraw', 'grant', 'refused-use')`),
]);

/** One row per trigger. Schedules, lanes, one-off wakes and parked waits are all rows here. */
export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey().notNull(),
  ownerKind: text('owner_kind', { enum: ["member", "agent", "household"] }).notNull(),
  owner: text('owner'),
  sourceKind: text('source_kind').$type<'time' | 'pull-request' | 'answer' | 'job'>().notNull(),
  watches: text('watches'),
  times: text('times'),
  days: text('days'),
  lifespan: text('lifespan').$type<'until-stopped' | 'today' | 'once'>().notNull(),
  targetKind: text('target_kind', { enum: ["operation", "inbox"] }).notNull(),
  target: text('target'),
  toKind: text('to_kind', { enum: ["person", "agent"] }),
  to: text('to'),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  instructions: text('instructions'),
  file: text('file'),
  note: text('note').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  state: text('state', { enum: ["standing", "due", "firing", "held", "fired", "stopped", "failed"] }).notNull(),
  nextDueAt: text('next_due_at'),
  lastFiredAt: text('last_fired_at'),
  createdAt: text('created_at').notNull(),
  changedAt: text('changed_at').notNull(),
  wantsModel: text('wants_model'),
  /** The member whose work a firing is, when the trigger puts an agent to work: apart from who set it
   * (owner). Absent for the agent's own. */
  member: text('member').references((): AnySQLiteColumn => members.id),
  /** The bridge conversation a firing is mail in, instead of a wake of its own (src/shared-place-triggers.ts).
   * Not a reference: a conversation that is gone stops the trigger at its next firing. */
  conversation: text('conversation'),
  /** Who asked for it, for a trigger that names a conversation: the person on whose word a firing's job
   * runs. A member's id, an outside account's key, or the agent itself. */
  askedByKind: text('asked_by_kind', { enum: ["member", "outside", "agent"] }),
  askedBy: text('asked_by'),
  askedAt: text('asked_at'),
  needs: text('needs', { mode: 'json' }).$type<string[]>(),
  prefers: text('prefers', { mode: 'json' }).$type<string[]>(),
  program: text('program', { mode: 'json' }).$type<Omit<HouseProgram, 'state' | 'payload'>>(),
  programPeriod: text('program_period', { enum: ['day'] }),
  readStateFrom: text('read_state_from').references((): AnySQLiteColumn => triggers.id),
  programState: text('program_state', { mode: 'json' }).$type<HouseProgram['state']>(),
  parked: integer('parked', {mode:'boolean'}).default(false).notNull(),
  scheduleName: text('schedule_name'),
  scheduleRemovedAt: text('schedule_removed_at'),
}, t => [
  check('triggers_asked_at_utc', utc(t.askedAt)),
  check('triggers_asked_by_kind_choice', sql`${t.askedByKind} in ('member', 'outside', 'agent')`),
  check('triggers_asker_with_conversation', sql`(${t.conversation} is null) = (${t.askedByKind} is null) and (${t.askedByKind} is null) = (${t.askedBy} is null) and (${t.askedByKind} is null) = (${t.askedAt} is null)`),
  check('triggers_next_due_at_utc', utc(t.nextDueAt)),
  check('triggers_last_fired_at_utc', utc(t.lastFiredAt)),
  check('triggers_created_at_utc', utc(t.createdAt)),
  check('triggers_changed_at_utc', utc(t.changedAt)),
  check('triggers_owner_required', sql`(${t.ownerKind} = 'household' and ${t.owner} is null) or (${t.ownerKind} <> 'household' and ${t.owner} is not null)`),
  check('triggers_target_required', sql`(${t.targetKind} = 'operation' and ${t.target} is not null and length(${t.target}) > 0) or (${t.targetKind} = 'inbox' and ${t.toKind} is not null and ${t.to} is not null)`),
  check('triggers_owner_kind_choice', sql`${t.ownerKind} in ('member', 'agent', 'household')`),
  check('triggers_source_kind_choice', sql`${t.sourceKind} in ('time', 'pull-request', 'answer', 'job')`),
  check('triggers_lifespan_choice', sql`${t.lifespan} in ('until-stopped', 'today', 'once')`),
  check('triggers_target_kind_choice', sql`${t.targetKind} in ('operation', 'inbox')`),
  check('triggers_to_kind_choice', sql`${t.toKind} in ('person', 'agent')`),
  check('triggers_enabled_boolean', sql`${t.enabled} in (0, 1)`),
  check('triggers_state_choice', sql`${t.state} in ('standing', 'due', 'firing', 'held', 'fired', 'stopped', 'failed')`),
  check('triggers_parked_boolean', sql`${t.parked} in (0, 1)`),
  check('triggers_schedule_removed_at_utc', utc(t.scheduleRemovedAt)),
  check('triggers_removed_schedule_stopped', sql`${t.scheduleRemovedAt} is null or (${t.enabled} = 0 and ${t.state} = 'stopped' and ${t.nextDueAt} is null)`),
  index('triggers_enabled_next_due_at_idx').on(t.enabled, t.nextDueAt),
]);

/** Older schedules use their trigger ID as their clock-local name. Drizzle Kit does not
 * serialize expression indexes for SQLite, so the installer emits this index directly. */
export const clockScheduleNameIndex = `CREATE UNIQUE INDEX triggers_clock_schedule_name ON triggers
  ("to", coalesce(schedule_name, id)) WHERE schedule_removed_at IS NULL AND source_kind = 'time'
  AND lifespan = 'until-stopped' AND target_kind = 'inbox' AND to_kind = 'agent';`;

/** What happened to each trigger, in order. */
export const programFirings = sqliteTable('program_firings', {
  id: text('id').primaryKey().notNull(),
  trigger: text('trigger').notNull().references(() => triggers.id),
  at: text('at').notNull(),
  period: text('period'),
  job: text('job').notNull().references(() => jobs.id),
  program: text('program', { mode: 'json' }).$type<HouseProgram>().notNull(),
  status: text('status', { enum: ['pending', 'done', 'failed'] }).notNull(),
  line: text('line'),
}, t => [
  uniqueIndex('program_firings_job').on(t.job),
  uniqueIndex('program_firings_pending').on(t.trigger).where(sql`${t.status} = 'pending'`),
  uniqueIndex('program_firings_period').on(t.trigger, t.period),
]);

export const triggerLog = sqliteTable('trigger_log', {
  seq: integer('seq').primaryKey().notNull(),
  trigger: text('trigger').notNull().references((): AnySQLiteColumn => triggers.id),
  at: text('at').notNull(),
  event: text('event').notNull(),
  note: text('note').notNull(),
}, t => [
  check('trigger_log_at_utc', utc(t.at)),
]);

/** What a trigger said before each edit, and who made it. */
export const triggerEdits = sqliteTable('trigger_edits', {
  seq: integer('seq').primaryKey().notNull(),
  trigger: text('trigger').notNull().references((): AnySQLiteColumn => triggers.id),
  at: text('at').notNull(),
  byKind: text('by_kind', { enum: ["member", "agent"] }).notNull(),
  by: text('by').notNull(),
  before: text('before').notNull(),
}, t => [
  check('trigger_edits_at_utc', utc(t.at)),
  check('trigger_edits_by_kind_choice', sql`${t.byKind} in ('member', 'agent')`),
  index('trigger_edits_trigger_idx').on(t.trigger),
]);

/** Agents whose triggers are being held. */
export const agentPauses = sqliteTable('agent_pauses', {
  agent: text('agent').primaryKey().notNull().references((): AnySQLiteColumn => agents.id),
  since: text('since').notNull(),
}, t => [
  check('agent_pauses_since_utc', utc(t.since)),
]);

/** Tempo's timings, for each person or agent that has changed them. Everyone else gets the defaults. */
export const tempoSettings = sqliteTable('tempo_settings', {
  whoKind: text('who_kind', { enum: ["person", "agent"] }).notNull(),
  who: text('who').notNull(),
  settleSeconds: integer('settle_seconds').notNull().default(5),
  dimDays: integer('dim_days').notNull().default(1),
  muteDays: integer('mute_days').notNull().default(7),
}, t => [
  primaryKey({ columns: [t.whoKind, t.who] }),
  check('tempo_settings_who_kind_choice', sql`${t.whoKind} in ('person', 'agent')`),
]);

/** One row per pull request. */
export const changes = sqliteTable('changes', {
  id: text('id').primaryKey().notNull(),
  repository: text('repository').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  url: text('url').notNull(),
  state: text('state', { enum: ["open", "merged", "closed"] }).notNull(),
  draft: integer('draft', { mode: 'boolean' }).notNull(),
  authorLogin: text('author_login').notNull(),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  agent: text('agent').references((): AnySQLiteColumn => agents.id),
  branch: text('branch').notNull(),
  headCommit: text('head_commit').notNull(),
  baseBranch: text('base_branch').notNull(),
  checks: text('checks', { enum: ["passing", "failing", "running", "none"] }).notNull(),
  review: text('review', { enum: ["approved", "changes_requested", "required", "not_required"] }).notNull(),
  mergeable: text('mergeable', { enum: ["yes", "no", "unknown"] }).notNull(),
  waitingOn: text('waiting_on', { enum: ["you", "agent", "ci", "reviewer", "author", "done"] }).notNull(),
  openedAt: text('opened_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  closedAt: text('closed_at'),
}, t => [
  check('changes_opened_at_utc', utc(t.openedAt)),
  check('changes_updated_at_utc', utc(t.updatedAt)),
  check('changes_closed_at_utc', utc(t.closedAt)),
  check('changes_state_choice', sql`${t.state} in ('open', 'merged', 'closed')`),
  check('changes_draft_boolean', sql`${t.draft} in (0, 1)`),
  check('changes_checks_choice', sql`${t.checks} in ('passing', 'failing', 'running', 'none')`),
  check('changes_review_choice', sql`${t.review} in ('approved', 'changes_requested', 'required', 'not_required')`),
  check('changes_mergeable_choice', sql`${t.mergeable} in ('yes', 'no', 'unknown')`),
  check('changes_waiting_on_choice', sql`${t.waitingOn} in ('you', 'agent', 'ci', 'reviewer', 'author', 'done')`),
]);

/** Checks that are failing or still running on a change. */
export const changeChecks = sqliteTable('change_checks', {
  change: text('change').notNull().references((): AnySQLiteColumn => changes.id),
  name: text('name').notNull(),
  state: text('state', { enum: ["failing", "running"] }).notNull(),
}, t => [
  primaryKey({ columns: [t.change, t.name] }),
  check('change_checks_state_choice', sql`${t.state} in ('failing', 'running')`),
]);

/** People on a change. */
export const changePeople = sqliteTable('change_people', {
  change: text('change').notNull().references((): AnySQLiteColumn => changes.id),
  login: text('login').notNull(),
  role: text('role', { enum: ["author", "reviewer", "requested", "assignee", "commenter"] }).notNull(),
}, t => [
  primaryKey({ columns: [t.change, t.login, t.role] }),
  check('change_people_role_choice', sql`${t.role} in ('author', 'reviewer', 'requested', 'assignee', 'commenter')`),
]);

/** Tasks a change mentions. */
export const changeTasks = sqliteTable('change_tasks', {
  change: text('change').notNull().references((): AnySQLiteColumn => changes.id),
  task: text('task').notNull().references((): AnySQLiteColumn => tasks.id),
}, t => [
  primaryKey({ columns: [t.change, t.task] }),
]);

/** One row saying when loom last read GitHub. */
export const changeSync = sqliteTable('change_sync', {
  singleton: integer('singleton').primaryKey().default(1).notNull(),
  readAt: text('read_at'),
  failed: integer('failed', { mode: 'boolean' }).notNull(),
  nextAt: text('next_at'),
}, t => [
  check('change_sync_read_at_utc', utc(t.readAt)),
  check('change_sync_next_at_utc', utc(t.nextAt)),
  check('change_sync_singleton', sql`${t.singleton} = 1`),
  check('change_sync_failed_boolean', sql`${t.failed} in (0, 1)`),
]);

/** One row per machine with a worker on it. */
export const boxes = sqliteTable('boxes', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  owner: text('owner').notNull().references((): AnySQLiteColumn => members.id),
  sameMachineAsLoom: integer('same_machine_as_loom', { mode: 'boolean' }).notNull(),
  hostsAny: integer('hosts_any', { mode: 'boolean' }).notNull(),
  reportOnly: integer('report_only', { mode: 'boolean' }).notNull(),
  alwaysOn: integer('always_on', { mode: 'boolean' }).notNull(),
  enrolledAt: text('enrolled_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
  slots: integer('slots'),
  readers: text('readers', { mode: 'json' }).$type<string[]>(),
  readingSequence: integer('reading_sequence').notNull().default(0),
  readingsLeftOut: integer('readings_left_out').notNull().default(0),
  readingSilenceSequence: integer('reading_silence_sequence').notNull().default(0),
}, t => [
  check('boxes_enrolled_at_utc', utc(t.enrolledAt)),
  check('boxes_last_seen_at_utc', utc(t.lastSeenAt)),
  check('boxes_revoked_at_utc', utc(t.revokedAt)),
  check('boxes_same_machine_as_loom_boolean', sql`${t.sameMachineAsLoom} in (0, 1)`),
  check('boxes_hosts_any_boolean', sql`${t.hostsAny} in (0, 1)`),
  check('boxes_report_only_boolean', sql`${t.reportOnly} in (0, 1)`),
  check('boxes_always_on_boolean', sql`${t.alwaysOn} in (0, 1)`),
  uniqueIndex('boxes_live_name_unique').on(t.name).where(sql`${t.revokedAt} is null`),
]);

/** Which agents may run on a box. */
export const boxAgents = sqliteTable('box_agents', {
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  lent: integer('lent', { mode: 'boolean' }).notNull(),
}, t => [
  primaryKey({ columns: [t.box, t.agent] }),
  check('box_agents_lent_boolean', sql`${t.lent} in (0, 1)`),
]);

/** What a machine has, used to match work to it. */
export const boxFacts = sqliteTable('box_facts', {
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  fact: text('fact').notNull(),
  fromOwner: integer('from_owner', { mode: 'boolean' }).notNull(),
}, t => [
  primaryKey({ columns: [t.box, t.fact] }),
  check('box_facts_from_owner_boolean', sql`${t.fromOwner} in (0, 1)`),
]);

/** Latest reading and condition for each machine and watched thing. Each disk path has its own row.
 * The last successful values stay on the row while it is unknown. Durations accrue between reports
 * on Loom's process clock. The sequence records which report updated the row. */
export const boxReadings = sqliteTable('box_readings', {
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  kind: text('kind', { enum: ["disk", "memory", "containers"] }).notNull(),
  thing: text('thing').notNull(),
  generation: text('generation').notNull(),
  occasion: integer('occasion').notNull().default(0),
  urgentOccasion: integer('urgent_occasion').notNull().default(0),
  ordinaryLine: text('ordinary_line', { enum: ['percent', 'floor', 'engine'] }),
  ordinaryLineValue: integer('ordinary_line_value'),
  urgentLineValue: integer('urgent_line_value'),
  lastLines: text('last_lines', { mode: 'json' }).$type<{ diskPercent: number; diskUrgentPercent: number; diskFreeMib: number; memoryFreeMib: number }>(),
  usedPercent: integer('used_percent'),
  sizeMib: integer('size_mib'),
  freeMib: integer('free_mib'),
  engineStatus: integer('engine_status'),
  level: text('level', { enum: ["ok", "raised", "urgent"] }).notNull(),
  since: text('since'),
  urgentSince: text('urgent_since'),
  readAt: text('read_at'),
  unknownSince: text('unknown_since'),
  observedAt: text('observed_at'),
  unknownMs: integer('unknown_ms').notNull().default(0),
  absentMs: integer('absent_ms'),
  reportSequence: integer('report_sequence').notNull().default(0),
  stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
}, t => [
  primaryKey({ columns: [t.box, t.kind, t.thing] }),
  check('box_readings_kind', sql`${t.kind} in ('disk', 'memory', 'containers')`),
  check('box_readings_level', sql`${t.level} in ('ok', 'raised', 'urgent')`),
  check('box_readings_used_percent_range', sql`${t.usedPercent} is null or ${t.usedPercent} between 0 and 100`),
  check('box_readings_engine_status_range', sql`${t.engineStatus} is null or ${t.engineStatus} = 200 or ${t.engineStatus} between 300 and 599`),
  check('box_readings_since_utc', utc(t.since)),
  check('box_readings_urgent_since_utc', utc(t.urgentSince)),
  check('box_readings_read_at_utc', utc(t.readAt)),
  check('box_readings_unknown_since_utc', utc(t.unknownSince)),
  check('box_readings_stale_boolean', sql`${t.stale} in (0, 1)`),
]);

/** The household’s effective alert lines. Installation and upgrade seed the singleton with defaults. */
export const boxAlertSettings = sqliteTable('box_alert_settings', {
  singleton: integer('singleton').primaryKey().default(1).notNull(),
  diskPercent: integer('disk_percent').notNull().default(85),
  diskUrgentPercent: integer('disk_urgent_percent').notNull().default(95),
  diskFreeMib: integer('disk_free_mib').notNull().default(5120),
  memoryFreeMib: integer('memory_free_mib').notNull().default(512),
}, t => [
  check('box_alert_settings_singleton', sql`${t.singleton} = 1`),
  // A line clears a few points under itself (machine-conditions.ts, CLEAR_POINTS): one too low could never clear.
  check('box_alert_settings_disk_percent_range', sql`typeof(${t.diskPercent}) = 'integer' and ${t.diskPercent} between 10 and 99`),
  check('box_alert_settings_disk_urgent_percent_range', sql`typeof(${t.diskUrgentPercent}) = 'integer' and ${t.diskUrgentPercent} > ${t.diskPercent} and ${t.diskUrgentPercent} <= 100`),
  check('box_alert_settings_disk_free_mib_range', sql`typeof(${t.diskFreeMib}) = 'integer' and ${t.diskFreeMib} between 0 and 1000000000`),
  check('box_alert_settings_memory_free_mib_range', sql`typeof(${t.memoryFreeMib}) = 'integer' and ${t.memoryFreeMib} between 0 and 1000000000`),
]);

/** One row per run of an agent. */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey().notNull(),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  project: text('project').references((): AnySQLiteColumn => projects.id),
  member: text('member').references((): AnySQLiteColumn => members.id),
  box: text('box').references((): AnySQLiteColumn => boxes.id),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  title: text('title').notNull(),
  state: text('state', { enum: ["queued", "starting", "running", "done", "failed", "stopped", "lost"] }).notNull(),
  brief: text('brief').notNull(),
  model: text('model').notNull(),
  // Actual placement, absent until an account/harness has been selected.
  account: text('account').references((): AnySQLiteColumn => modelAccounts.id),
  harness: text('harness'),
  startedByKind: text('started_by_kind').notNull(),
  startedBy: text('started_by').notNull(),
  retryOf: text('retry_of').references((): AnySQLiteColumn => jobs.id),
  retryAt: text('retry_at'),
  houseRepository: text('house_repository').notNull(),
  houseFile: text('house_file').notNull(),
  houseBranch: text('house_branch').notNull(),
  build: text('build'),
  exitCode: integer('exit_code'),
  // Who chose exit_code: loom's body program, the worker, loom itself, or a machine's own runner. Absent
  // when nobody said (a job ended before this column, or reported by a worker from before it).
  exitBy: text('exit_by', { enum: ["body", "worker", "loom", "runner"] }),
  logTail: text('log_tail'),
  endedBy: text('ended_by').references((): AnySQLiteColumn => members.id),
  // Why a person ended it: stuck work reset, work given up on, or Stop pressed in its conversation.
  endedReason: text('ended_reason').$type<'reset' | 'write-off' | 'stop'>(),
  // loom's own line on an ending it decided itself (lost, never placed). A runner's output is log_tail.
  endedNote: text('ended_note'),
  queuedAt: text('queued_at').notNull(),
  claimedAt: text('claimed_at'),
  heardAt: text('heard_at'),
  endedAt: text('ended_at'),
  prefers: text('prefers', { mode: 'json' }).$type<string[]>(),
  placementDecision: text('placement_decision', { mode: 'json' }).$type<{ box: string; outcome: 'taken' | 'passed'; reason: string }[]>(),
}, t => [
  check('jobs_retry_at_utc', utc(t.retryAt)),
  check('jobs_queued_at_utc', utc(t.queuedAt)),
  check('jobs_claimed_at_utc', utc(t.claimedAt)),
  check('jobs_heard_at_utc', utc(t.heardAt)),
  check('jobs_ended_at_utc', utc(t.endedAt)),
  check('jobs_state_choice', sql`${t.state} in ('queued', 'starting', 'running', 'done', 'failed', 'stopped', 'lost')`),
  check('jobs_ended_reason_choice', sql`${t.endedReason} in ('reset', 'write-off', 'stop')`),
  check('jobs_exit_by_choice', sql`${t.exitBy} in ('body', 'worker', 'loom', 'runner')`),
  uniqueIndex('jobs_one_active_unique').on(t.conversation).where(sql`${t.state} in ('queued', 'starting', 'running')`),
  index('jobs_agent_state_idx').on(t.agent, t.state),
  index('jobs_box_state_idx').on(t.box, t.state),
]);

/** Counts for one attempt. An absent counter is unknown, including for jobs with no report. */
export const jobUsage = sqliteTable('job_usage', {
  job: text('job').primaryKey().notNull().references(() => jobs.id),
  source: text('source', {enum: ['report', 'transcript', 'none', 'program']}).notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  cacheRead: integer('cache_read'),
  cacheWritten: integer('cache_written'),
  modelCalls: integer('model_calls'),
  toolCalls: integer('tool_calls'),
  tools: text('tools', {mode: 'json'}).$type<Record<string, number>>(),
  firstContext: integer('first_context'),
  largestContext: integer('largest_context'),
  wallMs: integer('wall_ms'),
  harness: text('harness'),
  model: text('model'),
}, t => [check('job_usage_source_choice', sql`${t.source} in ('report','transcript','none','program')`)]);

/** What a job needs from a machine. */
export const jobNeeds = sqliteTable('job_needs', {
  job: text('job').notNull().references((): AnySQLiteColumn => jobs.id),
  need: text('need').notNull(),
}, t => [
  primaryKey({ columns: [t.job, t.need] }),
]);

/** How and where each agent runs. */
export const agentRunSettings = sqliteTable('agent_run_settings', {
  agent: text('agent').primaryKey().notNull().references((): AnySQLiteColumn => agents.id),
  houseRepository: text('house_repository').notNull(),
  houseFile: text('house_file').notNull(),
  houseBranch: text('house_branch').notNull(),
  repositorySecret: text('repository_secret').references((): AnySQLiteColumn => secrets.name),
  nestedContainers: integer('nested_containers', { mode: 'boolean' }).notNull(),
  gpu: integer('gpu', { mode: 'boolean' }).notNull(),
  prefers: text('prefers', { mode: 'json' }).$type<string[]>(),
}, t => [
  check('agent_run_settings_nested_containers_boolean', sql`${t.nestedContainers} in (0, 1)`),
  check('agent_run_settings_gpu_boolean', sql`${t.gpu} in (0, 1)`),
]);

/** An agent's preferred machines, in order. */
export const agentBoxes = sqliteTable('agent_boxes', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  position: integer('position').notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.box] }),
]);

/** Secrets an agent's house is given when it starts. */
export const agentHouseSecrets = sqliteTable('agent_house_secrets', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  alias: text('alias').notNull(),
  secret: text('secret').notNull().references((): AnySQLiteColumn => secrets.name),
}, t => [
  primaryKey({ columns: [t.agent, t.alias] }),
]);

/** Network ports an agent's house may open. */
export const agentHousePorts = sqliteTable('agent_house_ports', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  address: text('address').notNull(),
  port: integer('port').notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.address, t.port] }),
]);

/** How an agent treats each person who talks to it from outside, such as on Discord. */
export const agentPeople = sqliteTable('agent_people', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  person: text('person').notNull(),
  tier: integer('tier').$type<1 | 2 | 3>().notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.person] }),
  check('agent_people_tier_choice', sql`${t.tier} in ('1', '2', '3')`),
]);

/** Tools an agent's body is not given. */
export const agentDeniedTools = sqliteTable('agent_denied_tools', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  pattern: text('pattern').notNull(),
  guestsOnly: integer('guests_only', { mode: 'boolean' }).notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.pattern, t.guestsOnly] }),
  check('agent_denied_tools_guests_only_boolean', sql`${t.guestsOnly} in (0, 1)`),
]);

/** One row per subscription with a model provider. */
export const modelAccounts = sqliteTable('model_accounts', {
  id: text('id').primaryKey().notNull(),
  owner: text('owner').notNull().references((): AnySQLiteColumn => members.id),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  usage: real('usage'),
  usageReadAt: text('usage_read_at'),
  resetsAt: text('resets_at'),
  hasRoom: integer('has_room', { mode: 'boolean' }).notNull(),
}, t => [
  check('model_accounts_usage_read_at_utc', utc(t.usageReadAt)),
  check('model_accounts_resets_at_utc', utc(t.resetsAt)),
  check('model_accounts_has_room_boolean', sql`${t.hasRoom} in (0, 1)`),
  check('model_accounts_usage_range', sql`${t.usage} is null or ${t.usage} between 0 and 1`),
]);

/** Provider usage observations for every account/window, shared across agents.
 * The site describes an account summary, but is silent on multiple simultaneous
 * limits. Keep each provider window as named columns rather than an opaque blob.
 * A missing observation is unknown; reset time alone is not fresh capacity.
 */
export const modelAccountWindows = sqliteTable('model_account_windows', {
  account: text('account').notNull().references((): AnySQLiteColumn => modelAccounts.id),
  window: text('window').notNull(),
  usage: real('usage'),
  usageReadAt: text('usage_read_at'),
  resetsAt: text('resets_at'),
  durationMs: real('duration_ms').notNull(),
  reserve: real('reserve').notNull().default(0.05),
}, t => [
  primaryKey({ columns: [t.account, t.window] }),
  check('model_account_windows_name', sql`length(trim(${t.window})) > 0`),
  check('model_account_windows_usage_range', sql`${t.usage} is null or ${t.usage} between 0 and 1`),
  check('model_account_windows_usage_read_at_utc', utc(t.usageReadAt)),
  check('model_account_windows_resets_at_utc', utc(t.resetsAt)),
  check('model_account_windows_duration_positive', sql`${t.durationMs} > 0 and ${t.durationMs} < 1e100`),
  check('model_account_windows_reserve_range', sql`${t.reserve} between 0 and 1`),
]);

/** Successive provider readings for attribution within a subscription's current week. */
export const accountWeekReadings = sqliteTable('account_week_readings', {
  account: text('account').notNull().references(() => modelAccounts.id, { onDelete: 'cascade' }),
  window: text('window').notNull(),
  resetsAt: text('resets_at').notNull(),
  readAt: text('read_at').notNull(),
  usage: real('usage').notNull(),
}, t => [
  primaryKey({columns:[t.account,t.window,t.resetsAt,t.readAt]}),
  check('account_week_readings_usage', sql`${t.usage} between 0 and 1`),
  check('account_week_readings_read_utc', utc(t.readAt)),
  check('account_week_readings_reset_utc', utc(t.resetsAt)),
]);

/** Which worker machines an account is signed in on. */
export const modelAccountBoxes = sqliteTable('model_account_boxes', {
  account: text('account').notNull().references((): AnySQLiteColumn => modelAccounts.id),
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
}, t => [
  primaryKey({ columns: [t.account, t.box] }),
]);

/** One sign-in of a model account: which account, on which machine, for which harness, in which place.
 * A place is where the token lives on that machine: `containers` is the directory every house there mounts,
 * `host` is the machine user's own sign-in. Tokens are never copied between places, so each is its own
 * sign-in with its own end. A row is the last thing loom learned about that sign-in; nothing here is a
 * credential. `expires_at` is absent where the provider's files do not say. */
export const modelAccountLogins = sqliteTable('model_account_logins', {
  account: text('account').notNull().references((): AnySQLiteColumn => modelAccounts.id),
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  harness: text('harness').notNull(),
  place: text('place', { enum: ["containers", "host"] }).notNull(),
  state: text('state', { enum: ["signed-in", "signed-out"] }).notNull(),
  expiresAt: text('expires_at'),
  // When the state last changed: how long a sign-in has been gone, and which time it was found gone.
  since: text('since').notNull(),
  checkedAt: text('checked_at').notNull(),
  learnedFrom: text('learned_from', { enum: ["check", "job"] }).notNull(),
  why: text('why'),
}, t => [
  primaryKey({ columns: [t.account, t.box, t.harness, t.place] }),
  check('model_account_logins_harness', sql`length(trim(${t.harness})) > 0`),
  check('model_account_logins_place', sql`${t.place} in ('containers', 'host')`),
  check('model_account_logins_state', sql`${t.state} in ('signed-in', 'signed-out')`),
  check('model_account_logins_learned_from', sql`${t.learnedFrom} in ('check', 'job')`),
  check('model_account_logins_expires_at_utc', utc(t.expiresAt)),
  check('model_account_logins_checked_at_utc', utc(t.checkedAt)),
  check('model_account_logins_since_utc', utc(t.since)),
]);

/** An agent's allowed and preferred models, in order. */
export const agentModels = sqliteTable('agent_models', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  model: text('model').notNull(),
  position: integer('position').notNull(),
}, t => [
  primaryKey({ columns: [t.agent, t.model] }),
]);

/** A request to sign a model account in on a worker machine, and how far it has got. */
export const accountSignins = sqliteTable('account_signins', {
  id: text('id').primaryKey().notNull(),
  account: text('account').notNull().references((): AnySQLiteColumn => modelAccounts.id),
  box: text('box').notNull().references((): AnySQLiteColumn => boxes.id),
  askedByKind: text('asked_by_kind', { enum: ["member", "agent"] }).notNull(),
  askedBy: text('asked_by').notNull(),
  state: text('state', { enum: ["asked", "started", "waiting", "done", "failed"] }).notNull(),
  item: text('item'),
  why: text('why'),
  askedAt: text('asked_at').notNull(),
  changedAt: text('changed_at').notNull(),
}, t => [
  check('account_signins_asked_at_utc', utc(t.askedAt)),
  check('account_signins_changed_at_utc', utc(t.changedAt)),
  check('account_signins_asked_by_kind_choice', sql`${t.askedByKind} in ('member', 'agent')`),
  check('account_signins_state_choice', sql`${t.state} in ('asked', 'started', 'waiting', 'done', 'failed')`),
  index('account_signins_box_state_idx').on(t.box, t.state),
]);

/** One row per bot signed in to a server or workspace. */
export const bridgeConnections = sqliteTable('bridge_connections', {
  id: text('id').primaryKey().notNull(),
  platform: text('platform', { enum: ["discord", "slack"] }).notNull(),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  workspace: text('workspace').notNull(),
  botUser: text('bot_user').notNull(),
  tokenSecret: text('token_secret').notNull().references((): AnySQLiteColumn => secrets.name),
  appSecret: text('app_secret').references((): AnySQLiteColumn => secrets.name),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  state: text('state', { enum: ["connecting", "connected", "backoff", "disconnected"] }).notNull(),
  stateAt: text('state_at').notNull(),
  removedAt: text('removed_at'),
}, t => [
  check('bridge_connections_state_at_utc', utc(t.stateAt)),
  check('bridge_connections_removed_at_utc', utc(t.removedAt)),
  check('bridge_connections_platform_choice', sql`${t.platform} in ('discord', 'slack')`),
  check('bridge_connections_enabled_boolean', sql`${t.enabled} in (0, 1)`),
  check('bridge_connections_state_choice', sql`${t.state} in ('connecting', 'connected', 'backoff', 'disconnected')`),
]);

/** Channels a connection listens to, or ignores. */
export const bridgeChannelFilters = sqliteTable('bridge_channel_filters', {
  connection: text('connection').notNull().references((): AnySQLiteColumn => bridgeConnections.id),
  channel: text('channel').notNull(),
  rule: text('rule', { enum: ["only", "ignore"] }).notNull(),
}, t => [
  primaryKey({ columns: [t.connection, t.channel, t.rule] }),
  check('bridge_channel_filters_rule_choice', sql`${t.rule} in ('only', 'ignore')`),
]);

/** Who answers in a channel. */
export const bridgeChannels = sqliteTable('bridge_channels', {
  platform: text('platform').notNull(),
  workspace: text('workspace').notNull(),
  channel: text('channel').notNull(),
  answers: text('answers').notNull().references((): AnySQLiteColumn => agents.id),
  botsMayTalk: integer('bots_may_talk', { mode: 'boolean' }).notNull(),
  /** The name of a role page of the answering agent, given to the body of every conversation in this
   * channel beside the venue's own. Empty: the channel has no brief of its own. */
  brief: text('brief'),
  /** Where a body working here for somebody who is neither an owner nor has the agent may hand a note:
   * one channel on any of the agent's bridges, as bridgePlaceKey writes a place. Empty: nowhere. */
  reportsTo: text('reports_to'),
}, t => [
  primaryKey({ columns: [t.platform, t.workspace, t.channel] }),
  check('bridge_channels_bots_may_talk_boolean', sql`${t.botsMayTalk} in (0, 1)`),
]);

/** Which member an outside user is. */
export const bridgePeople = sqliteTable('bridge_people', {
  platform: text('platform').notNull(),
  workspace: text('workspace').notNull(),
  user: text('user').notNull(),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
}, t => [
  primaryKey({ columns: [t.platform, t.workspace, t.user] }),
]);

/** Messages received from Discord and Slack. */
export const bridgeIncoming = sqliteTable('bridge_incoming', {
  id: text('id').primaryKey().notNull(),
  connection: text('connection').notNull().references((): AnySQLiteColumn => bridgeConnections.id),
  channel: text('channel').notNull(),
  thread: text('thread'),
  isDm: integer('is_dm', { mode: 'boolean' }).notNull(),
  user: text('user').notNull(),
  member: text('member').references((): AnySQLiteColumn => members.id),
  text: text('text').notNull(),
  postedAt: text('posted_at').notNull(),
  receivedAt: text('received_at').notNull(),
  deliveredAt: text('delivered_at'),
  state: text('state', { enum: ["pending", "held", "dropped", "delivered"] }).notNull(),
  reason: text('reason'),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  mentions: text('mentions'),
  repliesTo: text('replies_to'),
  parent: text('parent'),
  groupDm: integer('group_dm', { mode: 'boolean' }),
  bot: integer('bot', { mode: 'boolean' }),
  webhook: integer('webhook', { mode: 'boolean' }),
}, t => [
  check('bridge_incoming_group_dm_boolean', sql`${t.groupDm} in (0, 1)`),
  check('bridge_incoming_bot_boolean', sql`${t.bot} in (0, 1)`),
  check('bridge_incoming_webhook_boolean', sql`${t.webhook} in (0, 1)`),
  check('bridge_incoming_posted_at_utc', utc(t.postedAt)),
  check('bridge_incoming_received_at_utc', utc(t.receivedAt)),
  check('bridge_incoming_delivered_at_utc', utc(t.deliveredAt)),
  check('bridge_incoming_is_dm_boolean', sql`${t.isDm} in (0, 1)`),
  check('bridge_incoming_state_choice', sql`${t.state} in ('pending', 'held', 'dropped', 'delivered')`),
]);

/** Replies sent out to Discord and Slack. */
export const bridgeSends = sqliteTable('bridge_sends', {
  id: text('id').primaryKey().notNull(),
  /** The message this post answers. Absent for a post that answers none: a firing's or a note's reply,
   * and an agent's own work posting to a channel; `conversation` then says where it belongs. */
  incoming: text('incoming').references((): AnySQLiteColumn => bridgeIncoming.id),
  connection: text('connection').notNull().references((): AnySQLiteColumn => bridgeConnections.id),
  channel: text('channel').notNull(),
  thread: text('thread'),
  /** The conversation a post that answers no message was made in. Not a reference: the post's record
   * outlives its conversation. */
  conversation: text('conversation'),
  text: text('text').notNull(),
  state: text('state', { enum: ["pending", "held", "sending", "sent", "uncertain", "dismissed"] }).notNull(),
  createdAt: text('created_at').notNull(),
}, t => [
  check('bridge_sends_created_at_utc', utc(t.createdAt)),
  check('bridge_sends_state_choice', sql`${t.state} in ('pending', 'held', 'sending', 'sent', 'uncertain', 'dismissed')`),
  check('bridge_sends_answers_or_placed', sql`coalesce(${t.incoming}, ${t.conversation}) is not null`),
]);

/** Attachments fetched from Slack and Discord, kept for 14 days. Which messages carried one is bridge_file_messages. */
export const bridgeFiles = sqliteTable('bridge_files', {
  connection: text('connection').notNull().references((): AnySQLiteColumn => bridgeConnections.id),
  file: text('file').notNull(),
  name: text('name').notNull(),
  contents: blob('contents', { mode: 'buffer' }).notNull(),
  fetchedAt: text('fetched_at').notNull(),
}, t => [
  check('bridge_files_fetched_at_utc', utc(t.fetchedAt)),
  primaryKey({ columns: [t.connection, t.file] }),
]);

/** One row per named credential. Never the value. */
export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey().notNull(),
  description: text('description').notNull(),
  changedAt: text('changed_at').notNull(),
  changedBy: text('changed_by').notNull().references((): AnySQLiteColumn => members.id),
}, t => [
  check('secrets_changed_at_utc', utc(t.changedAt)),
]);

/** Who may be handed a secret. */
export const secretGrants = sqliteTable('secret_grants', {
  id: text('id').primaryKey().notNull(),
  secret: text('secret').notNull().references((): AnySQLiteColumn => secrets.name),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  job: text('job').references((): AnySQLiteColumn => jobs.id),
  request: text('request').references((): AnySQLiteColumn => secretRequests.id),
  grantedBy: text('granted_by').notNull(),
  grantedAt: text('granted_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, t => [
  check('secret_grants_granted_at_utc', utc(t.grantedAt)),
  check('secret_grants_expires_at_utc', utc(t.expiresAt)),
]);

/** An agent asking for a secret. */
export const secretRequests = sqliteTable('secret_requests', {
  id: text('id').primaryKey().notNull(),
  secret: text('secret').notNull().references((): AnySQLiteColumn => secrets.name),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  job: text('job').references((): AnySQLiteColumn => jobs.id),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  why: text('why').notNull(),
  state: text('state', { enum: ["pending", "allowed", "denied", "cancelled", "revoked"] }).notNull(),
  minutes: integer('minutes').notNull(),
  answeredBy: text('answered_by'),
  always: integer('always', { mode: 'boolean' }).notNull(),
  askedAt: text('asked_at').notNull(),
  answeredAt: text('answered_at'),
}, t => [
  check('secret_requests_asked_at_utc', utc(t.askedAt)),
  check('secret_requests_answered_at_utc', utc(t.answeredAt)),
  check('secret_requests_state_choice', sql`${t.state} in ('pending', 'allowed', 'denied', 'cancelled', 'revoked')`),
  check('secret_requests_always_boolean', sql`${t.always} in (0, 1)`),
]);

/** A standing answer for one secret. */
export const secretRules = sqliteTable('secret_rules', {
  secret: text('secret').primaryKey().notNull().references((): AnySQLiteColumn => secrets.name),
  answer: text('answer', { enum: ["ask", "auto", "never"] }).notNull(),
  minutes: integer('minutes').notNull(),
}, t => [
  check('secret_rules_answer_choice', sql`${t.answer} in ('ask', 'auto', 'never')`),
]);

/** The agents a rule applies to. */
export const secretRuleAgents = sqliteTable('secret_rule_agents', {
  secret: text('secret').notNull().references((): AnySQLiteColumn => secretRules.secret),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  when: text('when', { enum: ["on_request", "at_start"] }).notNull(),
}, t => [
  primaryKey({ columns: [t.secret, t.agent, t.when] }),
  check('secret_rule_agents_when_choice', sql`${t.when} in ('on_request', 'at_start')`),
]);

/** Each time a value was handed out. */
export const secretUses = sqliteTable('secret_uses', {
  id: text('id').primaryKey().notNull(),
  secret: text('secret').notNull().references((): AnySQLiteColumn => secrets.name),
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  job: text('job').notNull().references((): AnySQLiteColumn => jobs.id),
  at: text('at').notNull(),
  state: text('state', { enum: ["started", "released", "failed"] }).notNull(),
}, t => [
  check('secret_uses_at_utc', utc(t.at)),
  check('secret_uses_state_choice', sql`${t.state} in ('started', 'released', 'failed')`),
]);

/** Each time a secret's value was set, replaced or removed. */
export const secretChanges = sqliteTable('secret_changes', {
  id: text('id').primaryKey().notNull(),
  secret: text('secret').notNull().references((): AnySQLiteColumn => secrets.name),
  action: text('action', { enum: ["add", "replace", "removed"] }).notNull(),
  by: text('by').notNull().references((): AnySQLiteColumn => members.id),
  at: text('at').notNull(),
}, t => [
  check('secret_changes_at_utc', utc(t.at)),
  check('secret_changes_action_choice', sql`${t.action} in ('add', 'replace', 'removed')`),
]);

/** A rolled-up record per day of how long each kind of thing took and how often it ran. */
export const timingDays = sqliteTable('timing_days', {
  day: text('day').notNull(),
  kind: text('kind', { enum: ["request", "operation", "job"] }).notNull(),
  name: text('name').notNull(),
  count: integer('count').notNull(),
  totalMs: real('total_ms').notNull(),
  slowestMs: real('slowest_ms').notNull(),
  typicalMs: real('typical_ms').notNull(),
}, t => [
  primaryKey({ columns: [t.day, t.kind, t.name] }),
  check('timing_days_kind_choice', sql`${t.kind} in ('request', 'operation', 'job')`),
  index('timing_days_day_idx').on(t.day),
]);

/** One row saying whether measuring is on and where it goes. */
export const measuringSettings = sqliteTable('measuring_settings', {
  singleton: integer('singleton').primaryKey().default(1).notNull(),
  on: integer('on', { mode: 'boolean' }).notNull().default(false),
  sendOutside: integer('send_outside', { mode: 'boolean' }).notNull().default(false),
  outsideAddress: text('outside_address'),
  keepDays: integer('keep_days').notNull().default(90),
}, t => [
  check('measuring_settings_singleton', sql`${t.singleton} = 1`),
  check('measuring_settings_on_boolean', sql`${t.on} in (0, 1)`),
  check('measuring_settings_send_outside_boolean', sql`${t.sendOutside} in (0, 1)`),
  check('measuring_settings_keep_days_range', sql`${t.keepDays} between 0 and 3650`),
]);

export const membersRelations = relations(members, ({ many }) => ({
  memberAgentsByMember: many(memberAgents, { relationName: 'member_agents_member' }),
  projectMembersByMember: many(projectMembers, { relationName: 'project_members_member' }),
  memberPreferencesByMember: many(memberPreferences, { relationName: 'member_preferences_member' }),
  tokensByMember: many(tokens, { relationName: 'tokens_member' }),
  notificationDevicesByMember: many(notificationDevices, { relationName: 'notification_devices_member' }),
  conversationsByMember: many(conversations, { relationName: 'conversations_member' }),
  inboxByMember: many(inbox, { relationName: 'inbox_member' }),
  inboxByAnsweredBy: many(inbox, { relationName: 'inbox_answered_by' }),
  inboxReadsByMember: many(inboxReads, { relationName: 'inbox_reads_member' }),
  actionResultsByMember: many(actionResults, { relationName: 'action_results_member' }),
  approvalsByMember: many(approvals, { relationName: 'approvals_member' }),
  approvalsByDecidedBy: many(approvals, { relationName: 'approvals_decided_by' }),
  approvalRulesBySetBy: many(approvalRules, { relationName: 'approval_rules_set_by' }),
  boxesByOwner: many(boxes, { relationName: 'boxes_owner' }),
  jobsByMember: many(jobs, { relationName: 'jobs_member' }),
  triggersByMember: many(triggers, { relationName: 'triggers_member' }),
  jobsByEndedBy: many(jobs, { relationName: 'jobs_ended_by' }),
  modelAccountsByOwner: many(modelAccounts, { relationName: 'model_accounts_owner' }),
  bridgePeopleByMember: many(bridgePeople, { relationName: 'bridge_people_member' }),
  bridgeIncomingByMember: many(bridgeIncoming, { relationName: 'bridge_incoming_member' }),
  secretsByChangedBy: many(secrets, { relationName: 'secrets_changed_by' }),
  secretChangesByBy: many(secretChanges, { relationName: 'secret_changes_by' }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  memberAgentsByAgent: many(memberAgents, { relationName: 'member_agents_agent' }),
  projectAgentsByAgent: many(projectAgents, { relationName: 'project_agents_agent' }),
  agentAccountsByAgent: many(agentAccounts, { relationName: 'agent_accounts_agent' }),
  agentSpritesByAgent: many(agentSprites, { relationName: 'agent_sprites_agent' }),
  householdByDefaultAgent: many(household, { relationName: 'household_default_agent' }),
  tokensByAgent: many(tokens, { relationName: 'tokens_agent' }),
  conversationsByAgent: many(conversations, { relationName: 'conversations_agent' }),
  agentStatusByAgent: many(agentStatus, { relationName: 'agent_status_agent' }),
  inboxByAgent: many(inbox, { relationName: 'inbox_agent' }),
  approvalsByAgent: many(approvals, { relationName: 'approvals_agent' }),
  approvalNoticesByAgent: many(approvalNotices, { relationName: 'approval_notices_agent' }),
  approvalRecordByAgent: many(approvalRecord, { relationName: 'approval_record_agent' }),
  agentPausesByAgent: many(agentPauses, { relationName: 'agent_pauses_agent' }),
  changesByAgent: many(changes, { relationName: 'changes_agent' }),
  boxAgentsByAgent: many(boxAgents, { relationName: 'box_agents_agent' }),
  jobsByAgent: many(jobs, { relationName: 'jobs_agent' }),
  agentRunSettingsByAgent: many(agentRunSettings, { relationName: 'agent_run_settings_agent' }),
  agentBoxesByAgent: many(agentBoxes, { relationName: 'agent_boxes_agent' }),
  agentHouseSecretsByAgent: many(agentHouseSecrets, { relationName: 'agent_house_secrets_agent' }),
  agentHousePortsByAgent: many(agentHousePorts, { relationName: 'agent_house_ports_agent' }),
  agentPeopleByAgent: many(agentPeople, { relationName: 'agent_people_agent' }),
  agentDeniedToolsByAgent: many(agentDeniedTools, { relationName: 'agent_denied_tools_agent' }),
  agentModelsByAgent: many(agentModels, { relationName: 'agent_models_agent' }),
  bridgeConnectionsByAgent: many(bridgeConnections, { relationName: 'bridge_connections_agent' }),
  bridgeChannelsByAnswers: many(bridgeChannels, { relationName: 'bridge_channels_answers' }),
  secretGrantsByAgent: many(secretGrants, { relationName: 'secret_grants_agent' }),
  secretRequestsByAgent: many(secretRequests, { relationName: 'secret_requests_agent' }),
  secretRuleAgentsByAgent: many(secretRuleAgents, { relationName: 'secret_rule_agents_agent' }),
  secretUsesByAgent: many(secretUses, { relationName: 'secret_uses_agent' }),
}));

export const memberAgentsRelations = relations(memberAgents, ({ one }) => ({
  memberRow: one(members, { fields: [memberAgents.member], references: [members.id], relationName: 'member_agents_member' }),
  agentRow: one(agents, { fields: [memberAgents.agent], references: [agents.id], relationName: 'member_agents_agent' }),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  projectMembersByProject: many(projectMembers, { relationName: 'project_members_project' }),
  projectAgentsByProject: many(projectAgents, { relationName: 'project_agents_project' }),
  projectRepositoriesByProject: many(projectRepositories, { relationName: 'project_repositories_project' }),
  tasksByProject: many(tasks, { relationName: 'tasks_project' }),
  conversationsByProject: many(conversations, { relationName: 'conversations_project' }),
  inboxByProject: many(inbox, { relationName: 'inbox_project' }),
  approvalsByProject: many(approvals, { relationName: 'approvals_project' }),
  triggersByProject: many(triggers, { relationName: 'triggers_project' }),
  changesByProject: many(changes, { relationName: 'changes_project' }),
  jobsByProject: many(jobs, { relationName: 'jobs_project' }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  projectRow: one(projects, { fields: [projectMembers.project], references: [projects.id], relationName: 'project_members_project' }),
  memberRow: one(members, { fields: [projectMembers.member], references: [members.id], relationName: 'project_members_member' }),
}));

export const projectAgentsRelations = relations(projectAgents, ({ one }) => ({
  projectRow: one(projects, { fields: [projectAgents.project], references: [projects.id], relationName: 'project_agents_project' }),
  agentRow: one(agents, { fields: [projectAgents.agent], references: [agents.id], relationName: 'project_agents_agent' }),
}));

export const projectRepositoriesRelations = relations(projectRepositories, ({ one }) => ({
  projectRow: one(projects, { fields: [projectRepositories.project], references: [projects.id], relationName: 'project_repositories_project' }),
}));

export const agentAccountsRelations = relations(agentAccounts, ({ one }) => ({
  agentRow: one(agents, { fields: [agentAccounts.agent], references: [agents.id], relationName: 'agent_accounts_agent' }),
}));

export const agentSpritesRelations = relations(agentSprites, ({ one }) => ({
  agentRow: one(agents, { fields: [agentSprites.agent], references: [agents.id], relationName: 'agent_sprites_agent' }),
}));

export const householdRelations = relations(household, ({ one }) => ({
  defaultAgentRow: one(agents, { fields: [household.defaultAgent], references: [agents.id], relationName: 'household_default_agent' }),
}));

export const memberPreferencesRelations = relations(memberPreferences, ({ one }) => ({
  memberRow: one(members, { fields: [memberPreferences.member], references: [members.id], relationName: 'member_preferences_member' }),
}));

export const tokensRelations = relations(tokens, ({ one, many }) => ({
  memberRow: one(members, { fields: [tokens.member], references: [members.id], relationName: 'tokens_member' }),
  agentRow: one(agents, { fields: [tokens.agent], references: [agents.id], relationName: 'tokens_agent' }),
  jobRow: one(jobs, { fields: [tokens.job], references: [jobs.id], relationName: 'tokens_job' }),
  boxRow: one(boxes, { fields: [tokens.box], references: [boxes.id], relationName: 'tokens_box' }),
  madeFromRow: one(tokens, { fields: [tokens.madeFrom], references: [tokens.fingerprint], relationName: 'tokens_made_from' }),
  tokensByMadeFrom: many(tokens, { relationName: 'tokens_made_from' }),
  sessionsByToken: many(sessions, { relationName: 'sessions_token' }),
  signinLinksByToken: many(signinLinks, { relationName: 'signin_links_token' }),
  passkeysByToken: many(passkeys, { relationName: 'passkeys_token' }),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  tokenRow: one(tokens, { fields: [sessions.token], references: [tokens.fingerprint], relationName: 'sessions_token' }),
  madeByRow: one(sessions, { fields: [sessions.madeBy], references: [sessions.id], relationName: 'sessions_made_by' }),
  sessionsByMadeBy: many(sessions, { relationName: 'sessions_made_by' }),
  signinLinksBySession: many(signinLinks, { relationName: 'signin_links_session' }),
  notificationDevicesBySession: many(notificationDevices, { relationName: 'notification_devices_session' }),
}));

export const signinLinksRelations = relations(signinLinks, ({ one }) => ({
  tokenRow: one(tokens, { fields: [signinLinks.token], references: [tokens.fingerprint], relationName: 'signin_links_token' }),
  sessionRow: one(sessions, { fields: [signinLinks.session], references: [sessions.id], relationName: 'signin_links_session' }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  tokenRow: one(tokens, { fields: [passkeys.token], references: [tokens.fingerprint], relationName: 'passkeys_token' }),
}));

export const notificationDevicesRelations = relations(notificationDevices, ({ one }) => ({
  memberRow: one(members, { fields: [notificationDevices.member], references: [members.id], relationName: 'notification_devices_member' }),
  sessionRow: one(sessions, { fields: [notificationDevices.session], references: [sessions.id], relationName: 'notification_devices_session' }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  projectRow: one(projects, { fields: [tasks.project], references: [projects.id], relationName: 'tasks_project' }),
  taskLinksByTask: many(taskLinks, { relationName: 'task_links_task' }),
  taskLinksByDependsOn: many(taskLinks, { relationName: 'task_links_depends_on' }),
  taskCommentsByTask: many(taskComments, { relationName: 'task_comments_task' }),
  changeTasksByTask: many(changeTasks, { relationName: 'change_tasks_task' }),
}));

export const taskLinksRelations = relations(taskLinks, ({ one }) => ({
  taskRow: one(tasks, { fields: [taskLinks.task], references: [tasks.id], relationName: 'task_links_task' }),
  dependsOnRow: one(tasks, { fields: [taskLinks.dependsOn], references: [tasks.id], relationName: 'task_links_depends_on' }),
}));

export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  taskRow: one(tasks, { fields: [taskComments.task], references: [tasks.id], relationName: 'task_comments_task' }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  agentRow: one(agents, { fields: [conversations.agent], references: [agents.id], relationName: 'conversations_agent' }),
  projectRow: one(projects, { fields: [conversations.project], references: [projects.id], relationName: 'conversations_project' }),
  memberRow: one(members, { fields: [conversations.member], references: [members.id], relationName: 'conversations_member' }),
  conversationPeopleByConversation: many(conversationPeople, { relationName: 'conversation_people_conversation' }),
  turnsByConversation: many(turns, { relationName: 'turns_conversation' }),
  digestsByConversation: many(digests, { relationName: 'digests_conversation' }),
  conversationDaysByConversation: many(conversationDays, { relationName: 'conversation_days_conversation' }),
  findingsByConversation: many(findings, { relationName: 'findings_conversation' }),
  inboxByConversation: many(inbox, { relationName: 'inbox_conversation' }),
  threadsByConversation: many(threads, { relationName: 'threads_conversation' }),
  approvalsByConversation: many(approvals, { relationName: 'approvals_conversation' }),
  jobsByConversation: many(jobs, { relationName: 'jobs_conversation' }),
  bridgeIncomingByConversation: many(bridgeIncoming, { relationName: 'bridge_incoming_conversation' }),
  secretRequestsByConversation: many(secretRequests, { relationName: 'secret_requests_conversation' }),
}));

export const conversationPeopleRelations = relations(conversationPeople, ({ one }) => ({
  conversationRow: one(conversations, { fields: [conversationPeople.conversation], references: [conversations.id], relationName: 'conversation_people_conversation' }),
}));

export const turnsRelations = relations(turns, ({ one }) => ({
  conversationRow: one(conversations, { fields: [turns.conversation], references: [conversations.id], relationName: 'turns_conversation' }),
}));

export const digestsRelations = relations(digests, ({ one, many }) => ({
  conversationRow: one(conversations, { fields: [digests.conversation], references: [conversations.id], relationName: 'digests_conversation' }),
  inboxItemRow: one(inbox, { fields: [digests.inboxItem], references: [inbox.id], relationName: 'digests_inbox_item' }),
  digestItemsByDigest: many(digestItems, { relationName: 'digest_items_digest' }),
}));

export const digestItemsRelations = relations(digestItems, ({ one }) => ({
  digestRow: one(digests, { fields: [digestItems.digest], references: [digests.id], relationName: 'digest_items_digest' }),
}));

export const agentStatusRelations = relations(agentStatus, ({ one }) => ({
  agentRow: one(agents, { fields: [agentStatus.agent], references: [agents.id], relationName: 'agent_status_agent' }),
}));

export const conversationDaysRelations = relations(conversationDays, ({ one }) => ({
  conversationRow: one(conversations, { fields: [conversationDays.conversation], references: [conversations.id], relationName: 'conversation_days_conversation' }),
}));

export const findingsRelations = relations(findings, ({ one }) => ({
  conversationRow: one(conversations, { fields: [findings.conversation], references: [conversations.id], relationName: 'findings_conversation' }),
}));

export const inboxRelations = relations(inbox, ({ one, many }) => ({
  digestsByInboxItem: many(digests, { relationName: 'digests_inbox_item' }),
  conversationRow: one(conversations, { fields: [inbox.conversation], references: [conversations.id], relationName: 'inbox_conversation' }),
  projectRow: one(projects, { fields: [inbox.project], references: [projects.id], relationName: 'inbox_project' }),
  agentRow: one(agents, { fields: [inbox.agent], references: [agents.id], relationName: 'inbox_agent' }),
  memberRow: one(members, { fields: [inbox.member], references: [members.id], relationName: 'inbox_member' }),
  jobRow: one(jobs, { fields: [inbox.job], references: [jobs.id], relationName: 'inbox_job' }),
  threadRow: one(threads, { fields: [inbox.thread], references: [threads.id], relationName: 'inbox_thread' }),
  answeredByRow: one(members, { fields: [inbox.answeredBy], references: [members.id], relationName: 'inbox_answered_by' }),
  inboxRefsByItem: many(inboxRefs, { relationName: 'inbox_refs_item' }),
  inboxReadsByItem: many(inboxReads, { relationName: 'inbox_reads_item' }),
  messagesByInboxItem: many(messages, { relationName: 'messages_inbox_item' }),
}));

export const inboxRefsRelations = relations(inboxRefs, ({ one }) => ({
  itemRow: one(inbox, { fields: [inboxRefs.item], references: [inbox.id], relationName: 'inbox_refs_item' }),
}));

export const inboxReadsRelations = relations(inboxReads, ({ one }) => ({
  itemRow: one(inbox, { fields: [inboxReads.item], references: [inbox.id], relationName: 'inbox_reads_item' }),
  memberRow: one(members, { fields: [inboxReads.member], references: [members.id], relationName: 'inbox_reads_member' }),
}));

export const actionResultsRelations = relations(actionResults, ({ one }) => ({
  memberRow: one(members, { fields: [actionResults.member], references: [members.id], relationName: 'action_results_member' }),
}));

export const threadsRelations = relations(threads, ({ one, many }) => ({
  inboxByThread: many(inbox, { relationName: 'inbox_thread' }),
  conversationRow: one(conversations, { fields: [threads.conversation], references: [conversations.id], relationName: 'threads_conversation' }),
  messagesByThread: many(messages, { relationName: 'messages_thread' }),
  threadRefsByThread: many(threadRefs, { relationName: 'thread_refs_thread' }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  threadRow: one(threads, { fields: [messages.thread], references: [threads.id], relationName: 'messages_thread' }),
  inboxItemRow: one(inbox, { fields: [messages.inboxItem], references: [inbox.id], relationName: 'messages_inbox_item' }),
}));

export const threadRefsRelations = relations(threadRefs, ({ one }) => ({
  threadRow: one(threads, { fields: [threadRefs.thread], references: [threads.id], relationName: 'thread_refs_thread' }),
}));

export const approvalsRelations = relations(approvals, ({ one, many }) => ({
  agentRow: one(agents, { fields: [approvals.agent], references: [agents.id], relationName: 'approvals_agent' }),
  projectRow: one(projects, { fields: [approvals.project], references: [projects.id], relationName: 'approvals_project' }),
  memberRow: one(members, { fields: [approvals.member], references: [members.id], relationName: 'approvals_member' }),
  conversationRow: one(conversations, { fields: [approvals.conversation], references: [conversations.id], relationName: 'approvals_conversation' }),
  decidedByRow: one(members, { fields: [approvals.decidedBy], references: [members.id], relationName: 'approvals_decided_by' }),
  overriddenByRow: one(approvals, { fields: [approvals.overriddenBy], references: [approvals.id], relationName: 'approvals_overridden_by' }),
  approvalsByOverriddenBy: many(approvals, { relationName: 'approvals_overridden_by' }),
  approvalRecordByApproval: many(approvalRecord, { relationName: 'approval_record_approval' }),
}));

export const approvalRulesRelations = relations(approvalRules, ({ one }) => ({
  setByRow: one(members, { fields: [approvalRules.setBy], references: [members.id], relationName: 'approval_rules_set_by' }),
}));

export const approvalNoticesRelations = relations(approvalNotices, ({ one }) => ({
  agentRow: one(agents, { fields: [approvalNotices.agent], references: [agents.id], relationName: 'approval_notices_agent' }),
}));

export const approvalRecordRelations = relations(approvalRecord, ({ one }) => ({
  approvalRow: one(approvals, { fields: [approvalRecord.approval], references: [approvals.id], relationName: 'approval_record_approval' }),
  agentRow: one(agents, { fields: [approvalRecord.agent], references: [agents.id], relationName: 'approval_record_agent' }),
}));

export const triggersRelations = relations(triggers, ({ one, many }) => ({
  projectRow: one(projects, { fields: [triggers.project], references: [projects.id], relationName: 'triggers_project' }),
  memberRow: one(members, { fields: [triggers.member], references: [members.id], relationName: 'triggers_member' }),
  triggerLogByTrigger: many(triggerLog, { relationName: 'trigger_log_trigger' }),
  triggerEditsByTrigger: many(triggerEdits, { relationName: 'trigger_edits_trigger' }),
}));

export const triggerLogRelations = relations(triggerLog, ({ one }) => ({
  triggerRow: one(triggers, { fields: [triggerLog.trigger], references: [triggers.id], relationName: 'trigger_log_trigger' }),
}));

export const triggerEditsRelations = relations(triggerEdits, ({ one }) => ({
  triggerRow: one(triggers, { fields: [triggerEdits.trigger], references: [triggers.id], relationName: 'trigger_edits_trigger' }),
}));

export const agentPausesRelations = relations(agentPauses, ({ one }) => ({
  agentRow: one(agents, { fields: [agentPauses.agent], references: [agents.id], relationName: 'agent_pauses_agent' }),
}));

export const changesRelations = relations(changes, ({ one, many }) => ({
  projectRow: one(projects, { fields: [changes.project], references: [projects.id], relationName: 'changes_project' }),
  agentRow: one(agents, { fields: [changes.agent], references: [agents.id], relationName: 'changes_agent' }),
  changeChecksByChange: many(changeChecks, { relationName: 'change_checks_change' }),
  changePeopleByChange: many(changePeople, { relationName: 'change_people_change' }),
  changeTasksByChange: many(changeTasks, { relationName: 'change_tasks_change' }),
}));

export const changeChecksRelations = relations(changeChecks, ({ one }) => ({
  changeRow: one(changes, { fields: [changeChecks.change], references: [changes.id], relationName: 'change_checks_change' }),
}));

export const changePeopleRelations = relations(changePeople, ({ one }) => ({
  changeRow: one(changes, { fields: [changePeople.change], references: [changes.id], relationName: 'change_people_change' }),
}));

export const changeTasksRelations = relations(changeTasks, ({ one }) => ({
  changeRow: one(changes, { fields: [changeTasks.change], references: [changes.id], relationName: 'change_tasks_change' }),
  taskRow: one(tasks, { fields: [changeTasks.task], references: [tasks.id], relationName: 'change_tasks_task' }),
}));

export const boxesRelations = relations(boxes, ({ one, many }) => ({
  tokensByBox: many(tokens, { relationName: 'tokens_box' }),
  ownerRow: one(members, { fields: [boxes.owner], references: [members.id], relationName: 'boxes_owner' }),
  boxAgentsByBox: many(boxAgents, { relationName: 'box_agents_box' }),
  boxFactsByBox: many(boxFacts, { relationName: 'box_facts_box' }),
  boxReadingsByBox: many(boxReadings, { relationName: 'box_readings_box' }),
  jobsByBox: many(jobs, { relationName: 'jobs_box' }),
  agentBoxesByBox: many(agentBoxes, { relationName: 'agent_boxes_box' }),
  modelAccountBoxesByBox: many(modelAccountBoxes, { relationName: 'model_account_boxes_box' }),
  modelAccountLoginsByBox: many(modelAccountLogins, { relationName: 'model_account_logins_box' }),
  accountSigninsByBox: many(accountSignins, { relationName: 'account_signins_box' }),
}));

export const boxAgentsRelations = relations(boxAgents, ({ one }) => ({
  boxRow: one(boxes, { fields: [boxAgents.box], references: [boxes.id], relationName: 'box_agents_box' }),
  agentRow: one(agents, { fields: [boxAgents.agent], references: [agents.id], relationName: 'box_agents_agent' }),
}));

export const boxFactsRelations = relations(boxFacts, ({ one }) => ({
  boxRow: one(boxes, { fields: [boxFacts.box], references: [boxes.id], relationName: 'box_facts_box' }),
}));

export const boxReadingsRelations = relations(boxReadings, ({ one }) => ({
  boxRow: one(boxes, { fields: [boxReadings.box], references: [boxes.id], relationName: 'box_readings_box' }),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  tokensByJob: many(tokens, { relationName: 'tokens_job' }),
  inboxByJob: many(inbox, { relationName: 'inbox_job' }),
  agentRow: one(agents, { fields: [jobs.agent], references: [agents.id], relationName: 'jobs_agent' }),
  projectRow: one(projects, { fields: [jobs.project], references: [projects.id], relationName: 'jobs_project' }),
  memberRow: one(members, { fields: [jobs.member], references: [members.id], relationName: 'jobs_member' }),
  boxRow: one(boxes, { fields: [jobs.box], references: [boxes.id], relationName: 'jobs_box' }),
  conversationRow: one(conversations, { fields: [jobs.conversation], references: [conversations.id], relationName: 'jobs_conversation' }),
  accountRow: one(modelAccounts, { fields: [jobs.account], references: [modelAccounts.id], relationName: 'jobs_account' }),
  retryOfRow: one(jobs, { fields: [jobs.retryOf], references: [jobs.id], relationName: 'jobs_retry_of' }),
  jobsByRetryOf: many(jobs, { relationName: 'jobs_retry_of' }),
  endedByRow: one(members, { fields: [jobs.endedBy], references: [members.id], relationName: 'jobs_ended_by' }),
  jobNeedsByJob: many(jobNeeds, { relationName: 'job_needs_job' }),
  secretGrantsByJob: many(secretGrants, { relationName: 'secret_grants_job' }),
  secretRequestsByJob: many(secretRequests, { relationName: 'secret_requests_job' }),
  secretUsesByJob: many(secretUses, { relationName: 'secret_uses_job' }),
}));

export const jobNeedsRelations = relations(jobNeeds, ({ one }) => ({
  jobRow: one(jobs, { fields: [jobNeeds.job], references: [jobs.id], relationName: 'job_needs_job' }),
}));

export const agentRunSettingsRelations = relations(agentRunSettings, ({ one }) => ({
  agentRow: one(agents, { fields: [agentRunSettings.agent], references: [agents.id], relationName: 'agent_run_settings_agent' }),
  repositorySecretRow: one(secrets, { fields: [agentRunSettings.repositorySecret], references: [secrets.name], relationName: 'agent_run_settings_repository_secret' }),
}));

export const agentBoxesRelations = relations(agentBoxes, ({ one }) => ({
  agentRow: one(agents, { fields: [agentBoxes.agent], references: [agents.id], relationName: 'agent_boxes_agent' }),
  boxRow: one(boxes, { fields: [agentBoxes.box], references: [boxes.id], relationName: 'agent_boxes_box' }),
}));

export const agentHouseSecretsRelations = relations(agentHouseSecrets, ({ one }) => ({
  agentRow: one(agents, { fields: [agentHouseSecrets.agent], references: [agents.id], relationName: 'agent_house_secrets_agent' }),
  secretRow: one(secrets, { fields: [agentHouseSecrets.secret], references: [secrets.name], relationName: 'agent_house_secrets_secret' }),
}));

export const agentHousePortsRelations = relations(agentHousePorts, ({ one }) => ({
  agentRow: one(agents, { fields: [agentHousePorts.agent], references: [agents.id], relationName: 'agent_house_ports_agent' }),
}));

export const agentPeopleRelations = relations(agentPeople, ({ one }) => ({
  agentRow: one(agents, { fields: [agentPeople.agent], references: [agents.id], relationName: 'agent_people_agent' }),
}));

export const agentDeniedToolsRelations = relations(agentDeniedTools, ({ one }) => ({
  agentRow: one(agents, { fields: [agentDeniedTools.agent], references: [agents.id], relationName: 'agent_denied_tools_agent' }),
}));

export const modelAccountsRelations = relations(modelAccounts, ({ one, many }) => ({
  jobsByAccount: many(jobs, { relationName: 'jobs_account' }),
  modelAccountWindowsByAccount: many(modelAccountWindows, { relationName: 'model_account_windows_account' }),
  ownerRow: one(members, { fields: [modelAccounts.owner], references: [members.id], relationName: 'model_accounts_owner' }),
  modelAccountBoxesByAccount: many(modelAccountBoxes, { relationName: 'model_account_boxes_account' }),
  modelAccountLoginsByAccount: many(modelAccountLogins, { relationName: 'model_account_logins_account' }),
  accountSigninsByAccount: many(accountSignins, { relationName: 'account_signins_account' }),
}));

export const modelAccountWindowsRelations = relations(modelAccountWindows, ({ one }) => ({
  accountRow: one(modelAccounts, { fields: [modelAccountWindows.account], references: [modelAccounts.id], relationName: 'model_account_windows_account' }),
}));

export const accountSigninsRelations = relations(accountSignins, ({ one }) => ({
  accountRow: one(modelAccounts, { fields: [accountSignins.account], references: [modelAccounts.id], relationName: 'account_signins_account' }),
  boxRow: one(boxes, { fields: [accountSignins.box], references: [boxes.id], relationName: 'account_signins_box' }),
}));

export const modelAccountBoxesRelations = relations(modelAccountBoxes, ({ one }) => ({
  accountRow: one(modelAccounts, { fields: [modelAccountBoxes.account], references: [modelAccounts.id], relationName: 'model_account_boxes_account' }),
  boxRow: one(boxes, { fields: [modelAccountBoxes.box], references: [boxes.id], relationName: 'model_account_boxes_box' }),
}));

export const modelAccountLoginsRelations = relations(modelAccountLogins, ({ one }) => ({
  accountRow: one(modelAccounts, { fields: [modelAccountLogins.account], references: [modelAccounts.id], relationName: 'model_account_logins_account' }),
  boxRow: one(boxes, { fields: [modelAccountLogins.box], references: [boxes.id], relationName: 'model_account_logins_box' }),
}));

export const agentModelsRelations = relations(agentModels, ({ one }) => ({
  agentRow: one(agents, { fields: [agentModels.agent], references: [agents.id], relationName: 'agent_models_agent' }),
}));

export const bridgeConnectionsRelations = relations(bridgeConnections, ({ one, many }) => ({
  agentRow: one(agents, { fields: [bridgeConnections.agent], references: [agents.id], relationName: 'bridge_connections_agent' }),
  tokenSecretRow: one(secrets, { fields: [bridgeConnections.tokenSecret], references: [secrets.name], relationName: 'bridge_connections_token_secret' }),
  appSecretRow: one(secrets, { fields: [bridgeConnections.appSecret], references: [secrets.name], relationName: 'bridge_connections_app_secret' }),
  bridgeChannelFiltersByConnection: many(bridgeChannelFilters, { relationName: 'bridge_channel_filters_connection' }),
  bridgeIncomingByConnection: many(bridgeIncoming, { relationName: 'bridge_incoming_connection' }),
  bridgeSendsByConnection: many(bridgeSends, { relationName: 'bridge_sends_connection' }),
  bridgeFilesByConnection: many(bridgeFiles, { relationName: 'bridge_files_connection' }),
}));

export const bridgeChannelFiltersRelations = relations(bridgeChannelFilters, ({ one }) => ({
  connectionRow: one(bridgeConnections, { fields: [bridgeChannelFilters.connection], references: [bridgeConnections.id], relationName: 'bridge_channel_filters_connection' }),
}));

export const bridgeChannelsRelations = relations(bridgeChannels, ({ one }) => ({
  answersRow: one(agents, { fields: [bridgeChannels.answers], references: [agents.id], relationName: 'bridge_channels_answers' }),
}));

export const bridgePeopleRelations = relations(bridgePeople, ({ one }) => ({
  memberRow: one(members, { fields: [bridgePeople.member], references: [members.id], relationName: 'bridge_people_member' }),
}));

export const bridgeIncomingRelations = relations(bridgeIncoming, ({ one, many }) => ({
  connectionRow: one(bridgeConnections, { fields: [bridgeIncoming.connection], references: [bridgeConnections.id], relationName: 'bridge_incoming_connection' }),
  memberRow: one(members, { fields: [bridgeIncoming.member], references: [members.id], relationName: 'bridge_incoming_member' }),
  conversationRow: one(conversations, { fields: [bridgeIncoming.conversation], references: [conversations.id], relationName: 'bridge_incoming_conversation' }),
  bridgeSendsByIncoming: many(bridgeSends, { relationName: 'bridge_sends_incoming' }),
}));

export const bridgeSendsRelations = relations(bridgeSends, ({ one }) => ({
  incomingRow: one(bridgeIncoming, { fields: [bridgeSends.incoming], references: [bridgeIncoming.id], relationName: 'bridge_sends_incoming' }),
  connectionRow: one(bridgeConnections, { fields: [bridgeSends.connection], references: [bridgeConnections.id], relationName: 'bridge_sends_connection' }),
}));

export const bridgeFilesRelations = relations(bridgeFiles, ({ one }) => ({
  connectionRow: one(bridgeConnections, { fields: [bridgeFiles.connection], references: [bridgeConnections.id], relationName: 'bridge_files_connection' }),
}));

export const secretsRelations = relations(secrets, ({ one, many }) => ({
  agentRunSettingsByRepositorySecret: many(agentRunSettings, { relationName: 'agent_run_settings_repository_secret' }),
  agentHouseSecretsBySecret: many(agentHouseSecrets, { relationName: 'agent_house_secrets_secret' }),
  bridgeConnectionsByTokenSecret: many(bridgeConnections, { relationName: 'bridge_connections_token_secret' }),
  bridgeConnectionsByAppSecret: many(bridgeConnections, { relationName: 'bridge_connections_app_secret' }),
  changedByRow: one(members, { fields: [secrets.changedBy], references: [members.id], relationName: 'secrets_changed_by' }),
  secretGrantsBySecret: many(secretGrants, { relationName: 'secret_grants_secret' }),
  secretRequestsBySecret: many(secretRequests, { relationName: 'secret_requests_secret' }),
  secretRulesBySecret: many(secretRules, { relationName: 'secret_rules_secret' }),
  secretRuleAgentsBySecret: many(secretRuleAgents, { relationName: 'secret_rule_agents_secret' }),
  secretUsesBySecret: many(secretUses, { relationName: 'secret_uses_secret' }),
  secretChangesBySecret: many(secretChanges, { relationName: 'secret_changes_secret' }),
}));

export const secretGrantsRelations = relations(secretGrants, ({ one }) => ({
  secretRow: one(secrets, { fields: [secretGrants.secret], references: [secrets.name], relationName: 'secret_grants_secret' }),
  agentRow: one(agents, { fields: [secretGrants.agent], references: [agents.id], relationName: 'secret_grants_agent' }),
  jobRow: one(jobs, { fields: [secretGrants.job], references: [jobs.id], relationName: 'secret_grants_job' }),
  requestRow: one(secretRequests, { fields: [secretGrants.request], references: [secretRequests.id], relationName: 'secret_grants_request' }),
}));

export const secretRequestsRelations = relations(secretRequests, ({ one, many }) => ({
  secretGrantsByRequest: many(secretGrants, { relationName: 'secret_grants_request' }),
  secretRow: one(secrets, { fields: [secretRequests.secret], references: [secrets.name], relationName: 'secret_requests_secret' }),
  agentRow: one(agents, { fields: [secretRequests.agent], references: [agents.id], relationName: 'secret_requests_agent' }),
  jobRow: one(jobs, { fields: [secretRequests.job], references: [jobs.id], relationName: 'secret_requests_job' }),
  conversationRow: one(conversations, { fields: [secretRequests.conversation], references: [conversations.id], relationName: 'secret_requests_conversation' }),
}));

export const secretRulesRelations = relations(secretRules, ({ one, many }) => ({
  agents: many(secretRuleAgents, { relationName: 'secret_rule_assignments' }),
  secretRow: one(secrets, { fields: [secretRules.secret], references: [secrets.name], relationName: 'secret_rules_secret' }),
}));

export const secretRuleAgentsRelations = relations(secretRuleAgents, ({ one }) => ({
  ruleRow: one(secretRules, { fields: [secretRuleAgents.secret], references: [secretRules.secret], relationName: 'secret_rule_assignments' }),
  secretRow: one(secrets, { fields: [secretRuleAgents.secret], references: [secrets.name], relationName: 'secret_rule_agents_secret' }),
  agentRow: one(agents, { fields: [secretRuleAgents.agent], references: [agents.id], relationName: 'secret_rule_agents_agent' }),
}));

export const secretUsesRelations = relations(secretUses, ({ one }) => ({
  secretRow: one(secrets, { fields: [secretUses.secret], references: [secrets.name], relationName: 'secret_uses_secret' }),
  agentRow: one(agents, { fields: [secretUses.agent], references: [agents.id], relationName: 'secret_uses_agent' }),
  jobRow: one(jobs, { fields: [secretUses.job], references: [jobs.id], relationName: 'secret_uses_job' }),
}));

export const secretChangesRelations = relations(secretChanges, ({ one }) => ({
  secretRow: one(secrets, { fields: [secretChanges.secret], references: [secrets.name], relationName: 'secret_changes_secret' }),
  byRow: one(members, { fields: [secretChanges.by], references: [members.id], relationName: 'secret_changes_by' }),
}));

/** Internal bookkeeping has named columns too. Opaque bytes are never queried as facts. */
export const changeReviewRounds = sqliteTable('change_review_rounds', {
  job: text('job').primaryKey().notNull().references(() => jobs.id),
  change: text('change').notNull().references(() => changes.id),
  headCommit: text('head_commit').notNull(),
  tier: text('tier', { enum: ['medium', 'high'] }).notNull(),
  round: integer('round').notNull(),
  requestedAt: text('requested_at').notNull(),
  completedAt: text('completed_at'),
  verdict: text('verdict', { enum: ['CLEAR', 'BLOCKING', 'NONE'] }),
  findings: text('findings'),
}, t => [
  index('change_review_rounds_history').on(t.change, t.headCommit, t.requestedAt),
  check('change_review_rounds_commit', sql`length(cast(${t.headCommit} as blob)) = 40 and length(${t.headCommit}) = 40 and ${t.headCommit} not glob '*[^0-9a-f]*'`),
  check('change_review_rounds_tier', sql`${t.tier} in ('medium','high')`),
  check('change_review_rounds_round', sql`typeof(${t.round}) = 'integer' and ${t.round} >= 1`),
  check('change_review_rounds_requested_utc', utc(t.requestedAt)),
  check('change_review_rounds_completed_utc', utc(t.completedAt)),
  check('change_review_rounds_result', sql`(${t.completedAt} is null and ${t.verdict} is null and ${t.findings} is null) or
    (${t.completedAt} is not null and ${t.verdict} is not null and ${t.verdict} in ('CLEAR','BLOCKING','NONE') and ${t.findings} is not null)`),
]);

// A v1 archive may have issued task numbers whose rows were subsequently deleted.
export const importedTaskSequence = sqliteTable('imported_task_sequence', {
  singleton: integer('singleton').primaryKey().notNull(),
  lastIssued: integer('last_issued').notNull(),
}, t => [
  check('imported_task_sequence_singleton', sql`${t.singleton} = 1`),
  check('imported_task_sequence_range', sql`typeof(${t.lastIssued}) = 'integer' and ${t.lastIssued} between 0 and 9007199254740991`),
]);

export const migrations = sqliteTable('migrations', {
  number: integer('number').primaryKey().notNull(),
  appliedAt: text('applied_at').notNull(),
}, t => [
  check('migrations_appliedAt_utc', utc(t.appliedAt)),
]);
export const operationResults = sqliteTable('operation_results', {
  caller: text('caller').notNull(),
  id: text('id').notNull(),
  operation: text('operation').notNull(),
  inputHash: text('input_hash').notNull(),
  result: blob('result', { mode: 'buffer' }).notNull(),
  expiresAt: text('expires_at').notNull(),
}, t => [
  check('operationResults_expiresAt_utc', utc(t.expiresAt)),primaryKey({ columns: [t.caller, t.id] }), index('operation_results_expiry_idx').on(t.expiresAt)]);
export const notificationQueue = sqliteTable('notification_queue', {
  id: text('id').primaryKey().notNull(),
  device: text('device').notNull().references(() => notificationDevices.endpoint),
  item: text('item').notNull().references(() => inbox.id),
  queuedAt: text('queued_at').notNull(),
  sentAt: text('sent_at'),
  attempts: integer('attempts').notNull().default(0),
}, t => [
  check('notificationQueue_queuedAt_utc', utc(t.queuedAt)),
  check('notificationQueue_sentAt_utc', utc(t.sentAt)),
]);
/** Each part of a reply the platform confirmed, in order. A long reply is posted in parts; the rows say how
 * far it got and which outside messages are the bot's, so a thread under any part addresses it. */
export const bridgeSendParts = sqliteTable('bridge_send_parts', {
  send: text('send').notNull().references(() => bridgeSends.id),
  part: integer('part').notNull(),
  postedId: text('posted_id').notNull(),
}, t => [primaryKey({ columns: [t.send, t.part] }), index('bridge_send_parts_posted_id_idx').on(t.postedId)]);
export interface DirectSendTarget {
  origin:string;person:string;platform:'slack'|'discord';workspace:string;user:string;member:string|null;
}
/** Private provenance for delivery receipts. Historical sends have no entry. */
export const bridgeSendJobs = sqliteTable('bridge_send_jobs', {
  send: text('send').primaryKey().notNull().references(() => bridgeSends.id, { onDelete:'cascade' }),
  job: text('job').notNull().references(() => jobs.id, { onDelete:'cascade' }),
  directTarget:text('direct_target',{mode:'json'}).$type<DirectSendTarget & {channel:string}>(),
  finalReply:integer('final_reply',{mode:'boolean'}).notNull().default(false),
});
/** Which messages carried a kept Slack or Discord file. The same file shared in a second message is listed under
 * both and its bytes are kept once; a file with no message left is removed. */
export const bridgeFileMessages = sqliteTable('bridge_file_messages', {
  connection: text('connection').notNull(),
  file: text('file').notNull(),
  incoming: text('incoming').notNull().references(() => bridgeIncoming.id),
}, t => [primaryKey({ columns: [t.connection, t.file, t.incoming] }),
  foreignKey({ columns: [t.connection, t.file], foreignColumns: [bridgeFiles.connection, bridgeFiles.file] }),
  index('bridge_file_messages_incoming_idx').on(t.incoming)]);
/** The files a post carries, until the post is settled. Written with the post; removed when it is sent,
 * dismissed or left in doubt (a post in doubt is never sent again), so nothing here outlives its post. */
export const bridgeSendFiles = sqliteTable('bridge_send_files', {
  send: text('send').notNull().references(() => bridgeSends.id),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  contents: blob('contents', { mode: 'buffer' }).notNull(),
}, t => [primaryKey({ columns: [t.send, t.position] })]);
/** A harness's own record of a conversation, kept between bodies so the next body of the same harness
 * resumes it. One for a conversation and harness; `files` is sealed with the household's words key and
 * read by nothing but the body it is handed to. `bytes` is the size of what was sealed. `started_at` is the
 * time of the oldest erasable word the session holds: when it was first saved, or earlier when its first
 * body was handed older words of a direct conversation. It is erased when the household's keep time has
 * passed since then, however often it has been saved again (core/conversations/sessions.ts). */
export const conversationSessions = sqliteTable('conversation_sessions', {
  conversation: text('conversation').notNull().references(() => conversations.id),
  harness: text('harness').notNull(),
  session: text('session').notNull(),
  files: blob('files', { mode: 'buffer' }).notNull(),
  bytes: integer('bytes').notNull(),
  startedAt: text('started_at').notNull(),
}, t => [primaryKey({ columns: [t.conversation, t.harness] }), check('conversation_sessions_started_at_utc', utc(t.startedAt))]);
export const bridgeRawEvents = sqliteTable('bridge_raw_events', {
  connection: text('connection').notNull().references(() => bridgeConnections.id),
  id: text('id').notNull(),
  receivedAt: text('received_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  event: blob('event', { mode: 'buffer' }).notNull(),
}, t => [
  check('bridgeRawEvents_receivedAt_utc', utc(t.receivedAt)),
  check('bridgeRawEvents_expiresAt_utc', utc(t.expiresAt)),primaryKey({ columns: [t.connection, t.id] }), index('bridge_raw_events_expiry_idx').on(t.expiresAt)]);
export const bridgeResume = sqliteTable('bridge_resume', {
  connection: text('connection').primaryKey().notNull().references(() => bridgeConnections.id),
  session: text('session').notNull(),
  sequence: integer('sequence').notNull(),
  resumeUrl: text('resume_url').notNull(),
  identity: text('identity').notNull(),
});
export const secretWriteJournal = sqliteTable('secret_write_journal', {
  id: text('id').primaryKey().notNull(),
  secret: text('secret').notNull(),
  member: text('member').notNull().references(() => members.id),
  description: text('description').notNull().default(''),
  /** Consumer supplies a daemon-keyed canonical-input HMAC, never value bytes
   * or an unkeyed value hash. Its encoding belongs to the write service. */
  inputHash: text('input_hash').notNull(),
  operation: text('operation', { enum: ['add', 'replace', 'remove'] }).notNull(),
  state: text('state', { enum: ['prepared', 'committed', 'undone'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, t => [
  check('secretWriteJournal_startedAt_utc', utc(t.startedAt)),
  check('secretWriteJournal_completedAt_utc', utc(t.completedAt)),
  check('secret_write_journal_operation_choice', sql`${t.operation} in ('add', 'replace', 'remove')`),
  check('secret_write_journal_state_choice', sql`${t.state} in ('prepared', 'committed', 'undone')`),
  // SQLite trim defaults to ASCII spaces; include Unicode whitespace too.
  check('secret_write_journal_input_hash_required', sql`length(trim(${t.inputHash}, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0`),
]);
/** A grant pins the enrolled machine and its owner at issuance. */
export const terminalCredentials = sqliteTable('terminal_credentials', {
  fingerprint: text('fingerprint').primaryKey().notNull().references(() => tokens.fingerprint, {onDelete:'cascade'}),
  machine: text('machine').notNull().references(() => boxes.id),
  member: text('member').notNull().references(() => members.id),
  // Who made the binding. Only one its own member made puts the agent at that member's terminal for reading
  // their private talk and answering for them (policy.ts, Viewer.atTerminalOf); any binding reports the
  // sessions of its machine. Absent on a binding made before this was recorded.
  issuedBy: text('issued_by').references(() => members.id),
});

/** One observed harness session inside its authenticated machine, agent and member scope. */
export const terminalSessions = sqliteTable('terminal_sessions', {
  job: text('job').primaryKey().notNull().references(() => jobs.id),
  thread: text('thread').references(() => threads.id, {onDelete:'set null'}),
  sessionId: text('session_id').notNull(),
  instanceId: text('instance_id'),
  machine: text('machine').notNull().references(() => boxes.id),
  member: text('member').notNull().references(() => members.id),
  agent: text('agent').notNull().references(() => agents.id),
  harness: text('harness').notNull(),
  cwd: text('cwd').notNull(),
}, t => [uniqueIndex('terminal_sessions_identity').on(t.machine,t.member,t.agent,t.harness,t.sessionId)]);

/** Each transcript has its own byte revision and one cumulative job_usage snapshot. */
export const terminalRuns = sqliteTable('terminal_runs', {
  job: text('job').primaryKey().notNull().references(() => jobs.id),
  parent: text('parent').notNull().references(() => terminalSessions.job),
  runId: text('run_id').notNull(),
  revision: integer('revision').notNull(),
}, t => [uniqueIndex('terminal_runs_identity').on(t.parent,t.runId)]);

export const agentKits = sqliteTable('agent_kits', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  kit: text('kit').notNull(),
  tools: text('tools', {mode:'json'}).$type<KitTool[]>().notNull(),
}, t => [
  primaryKey({columns:[t.agent, t.kit]}),
]);

export const agentKitProjects = sqliteTable('agent_kit_projects', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  kit: text('kit').notNull(),
  project: text('project').notNull().references((): AnySQLiteColumn => projects.id),
}, t => [
  primaryKey({columns:[t.agent, t.kit, t.project]}),
  foreignKey({columns:[t.agent,t.kit],foreignColumns:[agentKits.agent,agentKits.kit]}).onDelete('cascade'),
]);

export const agentKitMembers = sqliteTable('agent_kit_members', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  kit: text('kit').notNull(),
  member: text('member').notNull().references((): AnySQLiteColumn => members.id),
}, t => [
  primaryKey({columns:[t.agent, t.kit, t.member]}),
  foreignKey({columns:[t.agent,t.kit],foreignColumns:[agentKits.agent,agentKits.kit]}).onDelete('cascade'),
]);

export const agentKitOutsidePeople = sqliteTable('agent_kit_outside_people', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  kit: text('kit').notNull(),
  platform: text('platform').notNull(),
  workspace: text('workspace').notNull(),
  user: text('user').notNull(),
}, t => [
  primaryKey({columns:[t.agent, t.kit, t.platform, t.workspace, t.user]}),
  foreignKey({columns:[t.agent,t.kit],foreignColumns:[agentKits.agent,agentKits.kit]}).onDelete('cascade'),
]);

export const projectOutsidePeople = sqliteTable('project_outside_people', {
  project: text('project').notNull().references((): AnySQLiteColumn => projects.id),
  platform: text('platform').notNull(),
  workspace: text('workspace').notNull(),
  user: text('user').notNull(),
}, t => [
  primaryKey({columns:[t.project, t.platform, t.workspace, t.user]}),
]);

export const kitUses = sqliteTable('kit_uses', {
  agent: text('agent').notNull().references((): AnySQLiteColumn => agents.id),
  conversation: text('conversation').references((): AnySQLiteColumn => conversations.id),
  personKind: text('person_kind', {enum:['member','outside']}),
  person: text('person'),
  id: text('id').notNull(),
  job: text('job').notNull().references((): AnySQLiteColumn => jobs.id),
  kit: text('kit').notNull(),
  tool: text('tool').notNull(),
  at: text('at').notNull(),
  outcome: text('outcome').notNull(),
}, t => [
  primaryKey({columns:[t.id]}),
]);

export const machineReads = sqliteTable('machine_reads', {
  id: text('id').primaryKey().notNull(),
  machine: text('machine').notNull(),
  agent: text('agent').notNull(),
  job: text('job').notNull(),
  conversation: text('conversation'),
  word: text('word').notNull(),
  person: text('person'),
  read: text('read').notNull(),
  args: text('args').notNull(),
  askedAt: text('asked_at').notNull(),
  bytes: integer('bytes').notNull(),
  outcome: text('outcome').notNull(),
}, t => [index('machine_reads_machine_time').on(t.machine,t.askedAt)]);

/** Private carry-over for a trigger. Access is scoped to the firing that produced it. */
export const triggerJournals = sqliteTable('trigger_journals', {
  trigger: text('trigger').primaryKey().references(() => triggers.id, { onDelete: 'cascade' }),
  lessons: text('lessons').notNull().default(''),
  state: text('state').notNull().default(''),
  stateRevision: integer('state_revision').notNull().default(0),
  stateChangedAt: text('state_changed_at'),
});

/** The job that acknowledged this trigger delivery, including after reassignment. */
export const triggerAcceptances = sqliteTable('trigger_acceptances', {
  item: text('item').primaryKey().references(() => inbox.id, { onDelete: 'cascade' }),
  job: text('job').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
});

export const plumbing = {
  accountWeekReadings,
  changeReviewRounds,
  importedTaskSequence,
  triggerAcceptances,
  triggerJournals,
  agentKits, agentKitProjects, agentKitMembers, agentKitOutsidePeople, projectOutsidePeople, kitUses,
  programFirings,
  machineReads,
  terminalCredentials, terminalSessions, terminalRuns,
  jobUsage,
  modelAccountLogins,
  programTokens, programRecordGrants, programOperationGrants, migrations, operationResults, notificationQueue, bridgeRawEvents, bridgeResume, bridgeSendParts, bridgeSendJobs, bridgeFileMessages, bridgeSendFiles, conversationSessions, secretWriteJournal };

export const tables = {
  members,
  agents,
  memberAgents,
  projects,
  projectMembers,
  projectAgents,
  projectRepositories,
  agentAccounts,
  agentSprites,
  household,
  backupRecipients,
  memberPreferences,
  tokens,
  sessions,
  signinLinks,
  passkeys,
  notificationDevices,
  tasks,
  taskLinks,
  taskComments,
  conversations,
  conversationPeople,
  turns,
  digests,
  digestItems,
  agentStatus,
  conversationDays,
  findings,
  inbox,
  inboxRefs,
  inboxReads,
  actionResults,
  threads,
  messages,
  threadRefs,
  deletedThreads,
  approvals,
  approvalRules,
  approvalNotices,
  approvalRecord,
  triggers,
  triggerLog,
  triggerEdits,
  agentPauses,
  tempoSettings,
  changes,
  changeChecks,
  changePeople,
  changeTasks,
  changeSync,
  boxes,
  boxAgents,
  boxFacts,
  boxReadings,
  boxAlertSettings,
  jobs,
  jobNeeds,
  agentRunSettings,
  agentBoxes,
  agentHouseSecrets,
  agentHousePorts,
  agentPeople,
  agentDeniedTools,
  modelAccounts,
  modelAccountWindows,
  modelAccountBoxes,
  accountSignins,
  agentModels,
  bridgeConnections,
  bridgeChannelFilters,
  bridgeChannels,
  bridgePeople,
  bridgeIncoming,
  bridgeSends,
  bridgeFiles,
  secrets,
  secretGrants,
  secretRequests,
  secretRules,
  secretRuleAgents,
  secretUses,
  secretChanges,
  timingDays,
  measuringSettings,
};

export const schema = { ...tables, ...plumbing,
  membersRelations,
  agentsRelations,
  memberAgentsRelations,
  projectsRelations,
  projectMembersRelations,
  projectAgentsRelations,
  projectRepositoriesRelations,
  agentAccountsRelations,
  agentSpritesRelations,
  householdRelations,
  memberPreferencesRelations,
  tokensRelations,
  sessionsRelations,
  signinLinksRelations,
  passkeysRelations,
  notificationDevicesRelations,
  tasksRelations,
  taskLinksRelations,
  taskCommentsRelations,
  conversationsRelations,
  conversationPeopleRelations,
  turnsRelations,
  digestsRelations,
  digestItemsRelations,
  agentStatusRelations,
  conversationDaysRelations,
  findingsRelations,
  inboxRelations,
  inboxRefsRelations,
  inboxReadsRelations,
  actionResultsRelations,
  threadsRelations,
  messagesRelations,
  threadRefsRelations,
  approvalsRelations,
  approvalRulesRelations,
  approvalNoticesRelations,
  approvalRecordRelations,
  triggersRelations,
  triggerLogRelations,
  triggerEditsRelations,
  agentPausesRelations,
  changesRelations,
  changeChecksRelations,
  changePeopleRelations,
  changeTasksRelations,
  boxesRelations,
  boxAgentsRelations,
  boxFactsRelations,
  boxReadingsRelations,
  jobsRelations,
  jobNeedsRelations,
  agentRunSettingsRelations,
  agentBoxesRelations,
  agentHouseSecretsRelations,
  agentHousePortsRelations,
  agentPeopleRelations,
  agentDeniedToolsRelations,
  modelAccountsRelations,
  modelAccountWindowsRelations,
  modelAccountBoxesRelations,
  modelAccountLoginsRelations,
  accountSigninsRelations,
  agentModelsRelations,
  bridgeConnectionsRelations,
  bridgeChannelFiltersRelations,
  bridgeChannelsRelations,
  bridgePeopleRelations,
  bridgeIncomingRelations,
  bridgeSendsRelations,
  bridgeFilesRelations,
  secretsRelations,
  secretGrantsRelations,
  secretRequestsRelations,
  secretRulesRelations,
  secretRuleAgentsRelations,
  secretUsesRelations,
  secretChangesRelations,
};

/** Polymorphic foreign keys: stored as the approved kind/id pair, enforced in SQL.
 * A null kind/id pair is absent; household ownership and a global rule have no id.
 */
export const polymorphicReferences = [
  { table: tasks, kind: 'owner_kind', id: 'owner', targets: { member: members, agent: agents } },
  { table: tasks, kind: 'assignee_kind', id: 'assignee', targets: { member: members, agent: agents } },
  { table: tasks, kind: 'asked_by_kind', id: 'asked_by', targets: { member: members, agent: agents } },
  { table: tasks, kind: 'created_by_kind', id: 'created_by', targets: { member: members, agent: agents } },
  { table: taskComments, kind: 'actor_kind', id: 'actor', targets: { member: members, agent: agents } },
  { table: triggers, kind: 'owner_kind', id: 'owner', targets: { member: members, agent: agents } },
  { table: triggers, kind: 'to_kind', id: 'to', targets: { person: members, agent: agents } },
  { table: inbox, kind: 'to_kind', id: 'to', targets: { person: members, agent: agents } },
  { table: tempoSettings, kind: 'who_kind', id: 'who', targets: { person: members, agent: agents } },
  { table: approvalRules, id: 'person', targets: { '': members }, emptyIsAbsent: true },
  { table: triggerEdits, kind: 'by_kind', id: 'by', targets: { member: members, agent: agents } },
  { table: accountSignins, kind: 'asked_by_kind', id: 'asked_by', targets: { member: members, agent: agents } },
] as const;

/** Lifecycle constraints that need triggers rather than static SQLite CHECKs. */
export const immutableTables = [approvalRecord, deletedThreads] as const;
export const expiringUniqueKeys = [{ table: tokens, key: 'label', identity: 'fingerprint', expires: 'expires_at', revoked: 'revoked_at' }] as const;
export const deletionMarkers = [{ table: threads, marker: deletedThreads, identity: 'id', copy: ['conversation'], at: 'at' }] as const;
