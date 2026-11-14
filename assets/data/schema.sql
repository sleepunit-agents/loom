-- Generated from src/core/data/schema.ts. Run npm run schema:generate.
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`full_owner` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`joined_at` text NOT NULL,
	CONSTRAINT "members_role_choice" CHECK("members"."role" in ('owner', 'member')),
	CONSTRAINT "members_full_owner_boolean" CHECK("members"."full_owner" in (0, 1)),
	CONSTRAINT "members_full_owner_role" CHECK(not "members"."full_owner" or "members"."role" = 'owner')
);

CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`about` text NOT NULL,
	`about_asked_at` text,
	`mark_bg` text NOT NULL,
	`mark_fg` text NOT NULL,
	`face_shape` text NOT NULL,
	`face_eyes` text NOT NULL,
	`sprite_version` text,
	CONSTRAINT "agents_face_shape_choice" CHECK("agents"."face_shape" in ('pebble', 'trefoil', 'clover', 'drop')),
	CONSTRAINT "agents_face_eyes_choice" CHECK("agents"."face_eyes" in ('dot', 'oval'))
);

CREATE TABLE `member_agents` (
	`member` text NOT NULL,
	`agent` text NOT NULL,
	PRIMARY KEY(`member`, `agent`),
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);

CREATE TABLE `project_members` (
	`project` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`project`, `member`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `project_agents` (
	`project` text NOT NULL,
	`agent` text NOT NULL,
	PRIMARY KEY(`project`, `agent`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `project_repositories` (
	`project` text NOT NULL,
	`repository` text NOT NULL,
	PRIMARY KEY(`project`, `repository`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_accounts` (
	`agent` text NOT NULL,
	`service` text NOT NULL,
	`login` text NOT NULL,
	PRIMARY KEY(`agent`, `service`, `login`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_accounts_service_choice" CHECK("agent_accounts"."service" in ('github'))
);

CREATE UNIQUE INDEX `agent_accounts_login_unique` ON `agent_accounts` (`service`,`login`);
CREATE TABLE `agent_sprites` (
	`agent` text PRIMARY KEY NOT NULL,
	`layout` text NOT NULL,
	`sheets` blob NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `household` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`default_agent` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`comms_days` integer DEFAULT 14 NOT NULL,
	`github_owner` text DEFAULT '' NOT NULL,
	`secrets_default` text DEFAULT 'ask' NOT NULL,
	`backup_target` text DEFAULT '' NOT NULL,
	`backup_at` text DEFAULT '03:00' NOT NULL,
	`backup_keep` integer DEFAULT 7 NOT NULL,
	FOREIGN KEY (`default_agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "household_singleton" CHECK("household"."singleton" = 1),
	CONSTRAINT "household_secrets_default_choice" CHECK("household"."secrets_default" in ('ask', 'auto', 'never')),
	CONSTRAINT "household_comms_days_range" CHECK("household"."comms_days" between 1 and 14),
	CONSTRAINT "household_backup_keep_range" CHECK("household"."backup_keep" between 1 and 90)
);

CREATE TABLE `backup_recipients` (
	`recipient` text PRIMARY KEY NOT NULL
);

CREATE TABLE `member_preferences` (
	`member` text PRIMARY KEY NOT NULL,
	`look` text NOT NULL,
	`ground` text NOT NULL,
	`sound` integer NOT NULL,
	`pixel` integer NOT NULL,
	`icons` integer NOT NULL,
	`haptics` integer NOT NULL,
	`one_window` integer NOT NULL,
	`zoom` integer NOT NULL,
	`motion` text NOT NULL,
	`contrast` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "member_preferences_look_choice" CHECK("member_preferences"."look" in ('neon', 'lowlight', 'daylight')),
	CONSTRAINT "member_preferences_ground_choice" CHECK("member_preferences"."ground" in ('depth', 'contours', 'wash')),
	CONSTRAINT "member_preferences_sound_boolean" CHECK("member_preferences"."sound" in (0, 1)),
	CONSTRAINT "member_preferences_pixel_boolean" CHECK("member_preferences"."pixel" in (0, 1)),
	CONSTRAINT "member_preferences_icons_boolean" CHECK("member_preferences"."icons" in (0, 1)),
	CONSTRAINT "member_preferences_haptics_boolean" CHECK("member_preferences"."haptics" in (0, 1)),
	CONSTRAINT "member_preferences_one_window_boolean" CHECK("member_preferences"."one_window" in (0, 1)),
	CONSTRAINT "member_preferences_zoom_boolean" CHECK("member_preferences"."zoom" in (0, 1)),
	CONSTRAINT "member_preferences_motion_choice" CHECK("member_preferences"."motion" in ('follow', 'on', 'off')),
	CONSTRAINT "member_preferences_contrast_choice" CHECK("member_preferences"."contrast" in ('follow', 'on', 'off'))
);

CREATE TABLE `tokens` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`member` text,
	`agent` text,
	`job` text,
	`box` text,
	`made_from` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`made_from`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tokens_kind_choice" CHECK("tokens"."kind" in ('owner', 'agent', 'runner'))
);

CREATE UNIQUE INDEX `tokens_live_label_unique` ON `tokens` (`label`) WHERE "tokens"."revoked_at" is null;
CREATE INDEX `tokens_expires_at_idx` ON `tokens` (`expires_at`);
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`device` text NOT NULL,
	`via` text NOT NULL,
	`is_agent` integer NOT NULL,
	`issued_at` text NOT NULL,
	`seen_at` text NOT NULL,
	`proved_at` text NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_via_choice" CHECK("sessions"."via" in ('link', 'passkey', 'token')),
	CONSTRAINT "sessions_is_agent_boolean" CHECK("sessions"."is_agent" in (0, 1))
);

CREATE TABLE `signin_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `notification_devices` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`member` text NOT NULL,
	`session` text NOT NULL,
	`keys` text NOT NULL,
	`device` text NOT NULL,
	`created_at` text NOT NULL,
	`seen_at` text NOT NULL,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`owner_kind` text NOT NULL,
	`owner` text,
	`project` text,
	`assignee_kind` text,
	`assignee` text,
	`goal` text DEFAULT '' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`done_when` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`ask` text,
	`if_yes` text,
	`if_no` text,
	`answers` text,
	`asked_by_kind` text,
	`asked_by` text,
	`source_kind` text,
	`source_id` text,
	`spec_item` text,
	`criterion` text,
	`close_reason` text,
	`created_by_kind` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`closed_at` text,
	`changed_at` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_type_choice" CHECK("tasks"."type" in ('task', 'bug', 'feature', 'epic')),
	CONSTRAINT "tasks_status_choice" CHECK("tasks"."status" in ('open', 'in_progress', 'closed')),
	CONSTRAINT "tasks_owner_kind_choice" CHECK("tasks"."owner_kind" in ('member', 'agent', 'household')),
	CONSTRAINT "tasks_assignee_kind_choice" CHECK("tasks"."assignee_kind" in ('member', 'agent')),
	CONSTRAINT "tasks_answers_choice" CHECK("tasks"."answers" in ('yes-no', 'words')),
	CONSTRAINT "tasks_asked_by_kind_choice" CHECK("tasks"."asked_by_kind" in ('member', 'agent')),
	CONSTRAINT "tasks_created_by_kind_choice" CHECK("tasks"."created_by_kind" in ('member', 'agent')),
	CONSTRAINT "tasks_priority_range" CHECK("tasks"."priority" between 0 and 4),
	CONSTRAINT "tasks_owner_required" CHECK(("tasks"."owner_kind" = 'household' and "tasks"."owner" is null) or ("tasks"."owner_kind" <> 'household' and "tasks"."owner" is not null)),
	CONSTRAINT "tasks_assignee_pair" CHECK(("tasks"."assignee_kind" is null) = ("tasks"."assignee" is null))
);

CREATE INDEX `tasks_status_priority_position_idx` ON `tasks` (`status`,`priority`,`position`);
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project`,`status`);
CREATE INDEX `tasks_owner_kind_owner_idx` ON `tasks` (`owner_kind`,`owner`);
CREATE INDEX `tasks_assignee_kind_assignee_idx` ON `tasks` (`assignee_kind`,`assignee`);
CREATE TABLE `task_links` (
	`task` text NOT NULL,
	`depends_on` text NOT NULL,
	`type` text NOT NULL,
	PRIMARY KEY(`task`, `depends_on`, `type`),
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_links_type_choice" CHECK("task_links"."type" in ('parent-child', 'blocks')),
	CONSTRAINT "task_links_no_self_link" CHECK("task_links"."task" <> "task_links"."depends_on")
);

CREATE UNIQUE INDEX `task_links_one_parent_unique` ON `task_links` (`task`) WHERE "task_links"."type" = 'parent-child';
CREATE TABLE `task_comments` (
	`task` text NOT NULL,
	`seq` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor` text NOT NULL,
	`at` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`task`, `seq`),
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_comments_actor_kind_choice" CHECK("task_comments"."actor_kind" in ('member', 'agent'))
);

CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`project` text,
	`member` text,
	`venue` text NOT NULL,
	`place` text NOT NULL,
	`label` text NOT NULL,
	`job` text,
	`started_at` text NOT NULL,
	`last_at` text NOT NULL,
	`turn_count` integer NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_venue_choice" CHECK("conversations"."venue" in ('loom', 'discord', 'slack', 'wake', 'handoff'))
);

CREATE UNIQUE INDEX `conversations_place_unique` ON `conversations` (`agent`,`venue`,`place`);
CREATE INDEX `conversations_project_idx` ON `conversations` (`project`);
CREATE INDEX `conversations_member_idx` ON `conversations` (`member`);
CREATE INDEX `conversations_agent_last_at_idx` ON `conversations` (`agent`,`last_at`);
CREATE TABLE `conversation_people` (
	`conversation` text NOT NULL,
	`who_kind` text NOT NULL,
	`who` text NOT NULL,
	PRIMARY KEY(`conversation`, `who_kind`, `who`),
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_people_who_kind_choice" CHECK("conversation_people"."who_kind" in ('person', 'agent'))
);

CREATE TABLE `turns` (
	`conversation` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text,
	`run` text,
	`model` text,
	`outcome` text,
	`latency_ms` real,
	PRIMARY KEY(`conversation`, `seq`),
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "turns_kind_choice" CHECK("turns"."kind" in ('message', 'reply', 'action', 'wake', 'note', 'refused')),
	CONSTRAINT "turns_from_kind_choice" CHECK("turns"."from_kind" in ('person', 'agent', 'schedule', 'unknown')),
	CONSTRAINT "turns_outcome_choice" CHECK("turns"."outcome" in ('answered', 'progressed', 'deferred', 'failed', 'none'))
);

CREATE TABLE `digests` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation` text NOT NULL,
	`run` text NOT NULL,
	`revision` integer NOT NULL,
	`at` text NOT NULL,
	`summary` text NOT NULL,
	`inbox_item` text,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inbox_item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `digest_items` (
	`digest` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`digest`, `kind`, `text`),
	FOREIGN KEY (`digest`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "digest_items_kind_choice" CHECK("digest_items"."kind" in ('decision', 'ask', 'task', 'project'))
);

CREATE TABLE `agent_status` (
	`agent` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`work` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_status_state_choice" CHECK("agent_status"."state" in ('working', 'waiting', 'idle', 'offline'))
);

CREATE TABLE `conversation_days` (
	`conversation` text NOT NULL,
	`day` text NOT NULL,
	`messages` integer NOT NULL,
	`replies` integer NOT NULL,
	`actions` integer NOT NULL,
	`median_latency_ms` real NOT NULL,
	PRIMARY KEY(`conversation`, `day`),
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `findings` (
	`conversation` text NOT NULL,
	`day` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`measure` text NOT NULL,
	`score` real NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`conversation`, `day`, `turn_seq`, `measure`),
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "findings_score_range" CHECK("findings"."score" between 1 and 5)
);

CREATE TABLE `inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`to_kind` text NOT NULL,
	`to` text NOT NULL,
	`conversation` text,
	`seq` integer,
	`source` text NOT NULL,
	`source_id` text,
	`from_kind` text NOT NULL,
	`from_id` text,
	`words` text,
	`at` text NOT NULL,
	`state` text NOT NULL,
	`volume` text DEFAULT 'full' NOT NULL,
	`quiet_until` text,
	`project` text,
	`agent` text,
	`member` text,
	`job` text,
	`taken_at` text,
	`done_at` text,
	`answers` text,
	`why` text,
	`if_yes` text,
	`if_no` text,
	`link` text,
	`waits_on_kind` text,
	`waits_on_id` text,
	`thread` text,
	`message_seq` integer,
	`answer` text,
	`answer_text` text,
	`answered_by` text,
	`answered_at` text,
	`resolution` text,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_to_kind_choice" CHECK("inbox"."to_kind" in ('person', 'agent')),
	CONSTRAINT "inbox_source_choice" CHECK("inbox"."source" in ('thread', 'discord', 'slack', 'trigger', 'handoff', 'answer', 'task', 'approval', 'secret-request', 'notice')),
	CONSTRAINT "inbox_from_kind_choice" CHECK("inbox"."from_kind" in ('person', 'agent', 'schedule', 'unknown')),
	CONSTRAINT "inbox_state_choice" CHECK("inbox"."state" in ('waiting', 'taken', 'done', 'answered', 'resolved')),
	CONSTRAINT "inbox_volume_choice" CHECK("inbox"."volume" in ('full', 'dim', 'mute')),
	CONSTRAINT "inbox_answers_choice" CHECK("inbox"."answers" in ('yes-no', 'words')),
	CONSTRAINT "inbox_answer_choice" CHECK("inbox"."answer" in ('yes', 'no', 'done', 'dismiss', 'words', 'replied'))
);

CREATE UNIQUE INDEX `inbox_source_unique` ON `inbox` (`to_kind`,`to`,`source`,`source_id`) WHERE "inbox"."source_id" is not null;
CREATE UNIQUE INDEX `inbox_sequence_unique` ON `inbox` (`conversation`,`seq`) WHERE "inbox"."conversation" is not null;
CREATE INDEX `inbox_to_kind_to_state_at_idx` ON `inbox` (`to_kind`,`to`,`state`,`at`);
CREATE INDEX `inbox_conversation_seq_idx` ON `inbox` (`conversation`,`seq`);
CREATE TABLE `inbox_refs` (
	`item` text NOT NULL,
	`ref` text NOT NULL,
	PRIMARY KEY(`item`, `ref`),
	FOREIGN KEY (`item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `inbox_reads` (
	`item` text NOT NULL,
	`member` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`item`, `member`),
	FOREIGN KEY (`item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `action_results` (
	`id` text PRIMARY KEY NOT NULL,
	`member` text NOT NULL,
	`at` text NOT NULL,
	`ok` integer NOT NULL,
	`text` text NOT NULL,
	`page` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "action_results_ok_boolean" CHECK("action_results"."ok" in (0, 1))
);

CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation` text NOT NULL,
	`title` text NOT NULL,
	`titled_by` text NOT NULL,
	`pinned` integer NOT NULL,
	`archived_at` text,
	`opened_at` text NOT NULL,
	`last_at` text NOT NULL,
	`read_seq` integer NOT NULL,
	`working` integer NOT NULL,
	`working_since` text,
	`working_beat` text,
	`stop_requested` integer NOT NULL,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "threads_titled_by_choice" CHECK("threads"."titled_by" in ('member', 'agent')),
	CONSTRAINT "threads_pinned_boolean" CHECK("threads"."pinned" in (0, 1)),
	CONSTRAINT "threads_working_boolean" CHECK("threads"."working" in (0, 1)),
	CONSTRAINT "threads_stop_requested_boolean" CHECK("threads"."stop_requested" in (0, 1))
);

CREATE UNIQUE INDEX `threads_conversation_unique` ON `threads` (`conversation`);
CREATE TABLE `messages` (
	`thread` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`sender` text NOT NULL,
	`at` text NOT NULL,
	`words` blob,
	`keep_until` text,
	`delivery` text,
	`inbox_item` text,
	`verdict` text,
	`run` text,
	`tool` text,
	`card_state` text,
	`client_id` text,
	PRIMARY KEY(`thread`, `seq`),
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_kind_choice" CHECK("messages"."kind" in ('message', 'reply', 'card', 'ask', 'answer', 'notice')),
	CONSTRAINT "messages_delivery_choice" CHECK("messages"."delivery" in ('sending', 'held', 'failed', 'delivered')),
	CONSTRAINT "messages_verdict_choice" CHECK("messages"."verdict" in ('yes', 'no')),
	CONSTRAINT "messages_card_state_choice" CHECK("messages"."card_state" in ('running', 'done', 'failed'))
);

CREATE UNIQUE INDEX `messages_client_id_unique` ON `messages` (`thread`,`sender`,`client_id`) WHERE "messages"."client_id" is not null;
CREATE INDEX `messages_keep_until_idx` ON `messages` (`keep_until`);
CREATE TABLE `thread_refs` (
	`thread` text NOT NULL,
	`ref` text NOT NULL,
	`message_seq` integer NOT NULL,
	PRIMARY KEY(`thread`, `ref`),
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread`,`message_seq`) REFERENCES `messages`(`thread`,`seq`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `deleted_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation` text NOT NULL,
	`at` text NOT NULL
);

CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`operation` text,
	`change_summary` text,
	`target` text NOT NULL,
	`what` text NOT NULL,
	`why` text NOT NULL,
	`agent` text NOT NULL,
	`asked_from` text NOT NULL,
	`acting_for` text NOT NULL,
	`project` text,
	`member` text,
	`conversation` text,
	`state` text NOT NULL,
	`minutes` integer NOT NULL,
	`ask` text NOT NULL,
	`if_yes` text NOT NULL,
	`if_no` text NOT NULL,
	`details` text NOT NULL,
	`decided_by` text,
	`asked_at` text NOT NULL,
	`decided_at` text,
	`expires_at` text,
	`used_at` text,
	`overridden_by` text,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`overridden_by`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_kind_choice" CHECK("approvals"."kind" in ('merge', 'command', 'setting', 'dangerous')),
	CONSTRAINT "approvals_state_choice" CHECK("approvals"."state" in ('pending', 'allowed', 'denied', 'used', 'withdrawn', 'expired'))
);

CREATE TABLE `approval_rules` (
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`person` text DEFAULT '' NOT NULL,
	`tier` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` text NOT NULL,
	PRIMARY KEY(`kind`, `scope`, `person`),
	FOREIGN KEY (`set_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_rules_kind_choice" CHECK("approval_rules"."kind" in ('merge', 'command', 'setting', 'dangerous')),
	CONSTRAINT "approval_rules_tier_choice" CHECK("approval_rules"."tier" in ('do', 'tell', 'ask'))
);

CREATE TABLE `approval_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`what` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `approval_record` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`event` text NOT NULL,
	`approval` text NOT NULL,
	`agent` text NOT NULL,
	`note` text NOT NULL,
	FOREIGN KEY (`approval`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_record_event_choice" CHECK("approval_record"."event" in ('request', 'allow', 'deny', 'use', 'withdraw', 'grant', 'refused-use'))
);

CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner` text,
	`source_kind` text NOT NULL,
	`watches` text,
	`times` text,
	`days` text,
	`lifespan` text NOT NULL,
	`target_kind` text NOT NULL,
	`target` text,
	`to_kind` text,
	`to` text,
	`project` text,
	`instructions` text,
	`file` text,
	`note` text NOT NULL,
	`enabled` integer NOT NULL,
	`state` text NOT NULL,
	`next_due_at` text,
	`last_fired_at` text,
	`created_at` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "triggers_owner_kind_choice" CHECK("triggers"."owner_kind" in ('member', 'agent', 'household')),
	CONSTRAINT "triggers_source_kind_choice" CHECK("triggers"."source_kind" in ('time', 'pull-request', 'answer', 'job')),
	CONSTRAINT "triggers_lifespan_choice" CHECK("triggers"."lifespan" in ('until-stopped', 'today', 'once')),
	CONSTRAINT "triggers_target_kind_choice" CHECK("triggers"."target_kind" in ('operation', 'inbox')),
	CONSTRAINT "triggers_to_kind_choice" CHECK("triggers"."to_kind" in ('person', 'agent')),
	CONSTRAINT "triggers_enabled_boolean" CHECK("triggers"."enabled" in (0, 1)),
	CONSTRAINT "triggers_state_choice" CHECK("triggers"."state" in ('standing', 'due', 'firing', 'held', 'fired', 'stopped', 'failed'))
);

CREATE INDEX `triggers_enabled_next_due_at_idx` ON `triggers` (`enabled`,`next_due_at`);
CREATE TABLE `trigger_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`at` text NOT NULL,
	`event` text NOT NULL,
	`note` text NOT NULL,
	FOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_pauses` (
	`agent` text PRIMARY KEY NOT NULL,
	`since` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `tempo_settings` (
	`who_kind` text NOT NULL,
	`who` text NOT NULL,
	`settle_seconds` integer DEFAULT 5 NOT NULL,
	`dim_days` integer DEFAULT 1 NOT NULL,
	`mute_days` integer DEFAULT 7 NOT NULL,
	PRIMARY KEY(`who_kind`, `who`),
	CONSTRAINT "tempo_settings_who_kind_choice" CHECK("tempo_settings"."who_kind" in ('person', 'agent'))
);

CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer NOT NULL,
	`author_login` text NOT NULL,
	`project` text,
	`agent` text,
	`branch` text NOT NULL,
	`head_commit` text NOT NULL,
	`base_branch` text NOT NULL,
	`checks` text NOT NULL,
	`review` text NOT NULL,
	`mergeable` text NOT NULL,
	`waiting_on` text NOT NULL,
	`opened_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "changes_state_choice" CHECK("changes"."state" in ('open', 'merged', 'closed')),
	CONSTRAINT "changes_draft_boolean" CHECK("changes"."draft" in (0, 1)),
	CONSTRAINT "changes_checks_choice" CHECK("changes"."checks" in ('passing', 'failing', 'running', 'none')),
	CONSTRAINT "changes_review_choice" CHECK("changes"."review" in ('approved', 'changes_requested', 'required', 'not_required')),
	CONSTRAINT "changes_mergeable_choice" CHECK("changes"."mergeable" in ('yes', 'no', 'unknown')),
	CONSTRAINT "changes_waiting_on_choice" CHECK("changes"."waiting_on" in ('you', 'agent', 'ci', 'reviewer', 'author', 'done'))
);

CREATE TABLE `change_checks` (
	`change` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`change`, `name`),
	FOREIGN KEY (`change`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_checks_state_choice" CHECK("change_checks"."state" in ('failing', 'running'))
);

CREATE TABLE `change_people` (
	`change` text NOT NULL,
	`login` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`change`, `login`, `role`),
	FOREIGN KEY (`change`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_people_role_choice" CHECK("change_people"."role" in ('author', 'reviewer', 'requested', 'assignee', 'commenter'))
);

CREATE TABLE `change_tasks` (
	`change` text NOT NULL,
	`task` text NOT NULL,
	PRIMARY KEY(`change`, `task`),
	FOREIGN KEY (`change`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `change_sync` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`read_at` text,
	`failed` integer NOT NULL,
	`next_at` text,
	CONSTRAINT "change_sync_singleton" CHECK("change_sync"."singleton" = 1),
	CONSTRAINT "change_sync_failed_boolean" CHECK("change_sync"."failed" in (0, 1))
);

CREATE TABLE `boxes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`same_machine_as_loom` integer NOT NULL,
	`hosts_any` integer NOT NULL,
	`report_only` integer NOT NULL,
	`always_on` integer NOT NULL,
	`enrolled_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	FOREIGN KEY (`owner`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "boxes_same_machine_as_loom_boolean" CHECK("boxes"."same_machine_as_loom" in (0, 1)),
	CONSTRAINT "boxes_hosts_any_boolean" CHECK("boxes"."hosts_any" in (0, 1)),
	CONSTRAINT "boxes_report_only_boolean" CHECK("boxes"."report_only" in (0, 1)),
	CONSTRAINT "boxes_always_on_boolean" CHECK("boxes"."always_on" in (0, 1))
);

CREATE UNIQUE INDEX `boxes_live_name_unique` ON `boxes` (`name`) WHERE "boxes"."revoked_at" is null;
CREATE TABLE `box_agents` (
	`box` text NOT NULL,
	`agent` text NOT NULL,
	`lent` integer NOT NULL,
	PRIMARY KEY(`box`, `agent`),
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "box_agents_lent_boolean" CHECK("box_agents"."lent" in (0, 1))
);

CREATE TABLE `box_facts` (
	`box` text NOT NULL,
	`fact` text NOT NULL,
	`from_owner` integer NOT NULL,
	PRIMARY KEY(`box`, `fact`),
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "box_facts_from_owner_boolean" CHECK("box_facts"."from_owner" in (0, 1))
);

CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`project` text,
	`member` text,
	`box` text,
	`conversation` text,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`brief` text NOT NULL,
	`model` text NOT NULL,
	`started_by_kind` text NOT NULL,
	`started_by` text NOT NULL,
	`retry_of` text,
	`retry_at` text,
	`house_repository` text NOT NULL,
	`house_file` text NOT NULL,
	`house_branch` text NOT NULL,
	`build` text,
	`exit_code` integer,
	`log_tail` text,
	`ended_by` text,
	`ended_reason` text,
	`queued_at` text NOT NULL,
	`claimed_at` text,
	`heard_at` text,
	`ended_at` text,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retry_of`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ended_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_state_choice" CHECK("jobs"."state" in ('queued', 'starting', 'running', 'waiting', 'done', 'failed', 'stopped', 'lost')),
	CONSTRAINT "jobs_ended_reason_choice" CHECK("jobs"."ended_reason" in ('reset', 'write-off'))
);

CREATE UNIQUE INDEX `jobs_one_active_unique` ON `jobs` (`conversation`) WHERE "jobs"."state" in ('queued', 'starting', 'running', 'waiting');
CREATE INDEX `jobs_agent_state_idx` ON `jobs` (`agent`,`state`);
CREATE INDEX `jobs_box_state_idx` ON `jobs` (`box`,`state`);
CREATE TABLE `job_needs` (
	`job` text NOT NULL,
	`need` text NOT NULL,
	PRIMARY KEY(`job`, `need`),
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_run_settings` (
	`agent` text PRIMARY KEY NOT NULL,
	`house_repository` text NOT NULL,
	`house_file` text NOT NULL,
	`house_branch` text NOT NULL,
	`repository_secret` text,
	`nested_containers` integer NOT NULL,
	`gpu` integer NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_settings_nested_containers_boolean" CHECK("agent_run_settings"."nested_containers" in (0, 1)),
	CONSTRAINT "agent_run_settings_gpu_boolean" CHECK("agent_run_settings"."gpu" in (0, 1))
);

CREATE TABLE `agent_boxes` (
	`agent` text NOT NULL,
	`box` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`agent`, `box`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_house_secrets` (
	`agent` text NOT NULL,
	`alias` text NOT NULL,
	`secret` text NOT NULL,
	PRIMARY KEY(`agent`, `alias`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_house_ports` (
	`agent` text NOT NULL,
	`address` text NOT NULL,
	`port` integer NOT NULL,
	PRIMARY KEY(`agent`, `address`, `port`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_people` (
	`agent` text NOT NULL,
	`person` text NOT NULL,
	`tier` integer NOT NULL,
	PRIMARY KEY(`agent`, `person`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_people_tier_choice" CHECK("agent_people"."tier" in ('1', '2', '3'))
);

CREATE TABLE `agent_denied_tools` (
	`agent` text NOT NULL,
	`pattern` text NOT NULL,
	`guests_only` integer NOT NULL,
	PRIMARY KEY(`agent`, `pattern`, `guests_only`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_denied_tools_guests_only_boolean" CHECK("agent_denied_tools"."guests_only" in (0, 1))
);

CREATE TABLE `model_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`usage` real,
	`usage_read_at` text,
	`resets_at` text,
	`has_room` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_accounts_has_room_boolean" CHECK("model_accounts"."has_room" in (0, 1)),
	CONSTRAINT "model_accounts_usage_range" CHECK("model_accounts"."usage" is null or "model_accounts"."usage" between 0 and 1)
);

CREATE TABLE `model_account_boxes` (
	`account` text NOT NULL,
	`box` text NOT NULL,
	PRIMARY KEY(`account`, `box`),
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_models` (
	`agent` text NOT NULL,
	`model` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`agent`, `model`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `bridge_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`agent` text NOT NULL,
	`workspace` text NOT NULL,
	`bot_user` text NOT NULL,
	`token_secret` text NOT NULL,
	`app_secret` text,
	`enabled` integer NOT NULL,
	`state` text NOT NULL,
	`state_at` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_connections_platform_choice" CHECK("bridge_connections"."platform" in ('discord', 'slack')),
	CONSTRAINT "bridge_connections_enabled_boolean" CHECK("bridge_connections"."enabled" in (0, 1)),
	CONSTRAINT "bridge_connections_state_choice" CHECK("bridge_connections"."state" in ('connecting', 'connected', 'backoff', 'disconnected'))
);

CREATE TABLE `bridge_channel_filters` (
	`connection` text NOT NULL,
	`channel` text NOT NULL,
	`rule` text NOT NULL,
	PRIMARY KEY(`connection`, `channel`, `rule`),
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_channel_filters_rule_choice" CHECK("bridge_channel_filters"."rule" in ('only', 'ignore'))
);

CREATE TABLE `bridge_channels` (
	`platform` text NOT NULL,
	`workspace` text NOT NULL,
	`channel` text NOT NULL,
	`answers` text NOT NULL,
	`bots_may_talk` integer NOT NULL,
	PRIMARY KEY(`platform`, `workspace`, `channel`),
	FOREIGN KEY (`answers`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_channels_bots_may_talk_boolean" CHECK("bridge_channels"."bots_may_talk" in (0, 1))
);

CREATE TABLE `bridge_people` (
	`platform` text NOT NULL,
	`workspace` text NOT NULL,
	`user` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`platform`, `workspace`, `user`),
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `bridge_incoming` (
	`id` text PRIMARY KEY NOT NULL,
	`connection` text NOT NULL,
	`channel` text NOT NULL,
	`thread` text,
	`is_dm` integer NOT NULL,
	`user` text NOT NULL,
	`member` text,
	`text` text NOT NULL,
	`posted_at` text NOT NULL,
	`received_at` text NOT NULL,
	`delivered_at` text,
	`state` text NOT NULL,
	`reason` text,
	`conversation` text,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_incoming_is_dm_boolean" CHECK("bridge_incoming"."is_dm" in (0, 1)),
	CONSTRAINT "bridge_incoming_state_choice" CHECK("bridge_incoming"."state" in ('pending', 'held', 'dropped', 'delivered'))
);

CREATE TABLE `bridge_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`incoming` text NOT NULL,
	`connection` text NOT NULL,
	`channel` text NOT NULL,
	`thread` text,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`posted_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_sends_state_choice" CHECK("bridge_sends"."state" in ('pending', 'held', 'sending', 'sent', 'uncertain', 'dismissed'))
);

CREATE TABLE `bridge_files` (
	`connection` text NOT NULL,
	`file` text NOT NULL,
	`incoming` text NOT NULL,
	`name` text NOT NULL,
	`contents` blob NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`connection`, `file`),
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`changed_at` text NOT NULL,
	`changed_by` text NOT NULL,
	FOREIGN KEY (`changed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `secret_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`agent` text NOT NULL,
	`job` text,
	`request` text,
	`granted_by` text NOT NULL,
	`granted_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request`) REFERENCES `secret_requests`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `secret_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`agent` text NOT NULL,
	`job` text,
	`conversation` text,
	`why` text NOT NULL,
	`state` text NOT NULL,
	`minutes` integer NOT NULL,
	`answered_by` text,
	`always` integer NOT NULL,
	`asked_at` text NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_requests_state_choice" CHECK("secret_requests"."state" in ('pending', 'allowed', 'denied', 'cancelled', 'revoked')),
	CONSTRAINT "secret_requests_always_boolean" CHECK("secret_requests"."always" in (0, 1))
);

CREATE TABLE `secret_rules` (
	`secret` text PRIMARY KEY NOT NULL,
	`answer` text NOT NULL,
	`minutes` integer NOT NULL,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_rules_answer_choice" CHECK("secret_rules"."answer" in ('ask', 'auto', 'never'))
);

CREATE TABLE `secret_rule_agents` (
	`secret` text NOT NULL,
	`agent` text NOT NULL,
	`when` text NOT NULL,
	PRIMARY KEY(`secret`, `agent`, `when`),
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_rule_agents_when_choice" CHECK("secret_rule_agents"."when" in ('on_request', 'at_start'))
);

CREATE TABLE `secret_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`agent` text NOT NULL,
	`job` text NOT NULL,
	`at` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_uses_state_choice" CHECK("secret_uses"."state" in ('started', 'released', 'failed'))
);

CREATE TABLE `secret_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`action` text NOT NULL,
	`by` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_changes_action_choice" CHECK("secret_changes"."action" in ('add', 'replace', 'removed'))
);

CREATE TABLE `timing_days` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`count` integer NOT NULL,
	`total_ms` real NOT NULL,
	`slowest_ms` real NOT NULL,
	`typical_ms` real NOT NULL,
	PRIMARY KEY(`day`, `kind`, `name`),
	CONSTRAINT "timing_days_kind_choice" CHECK("timing_days"."kind" in ('request', 'operation', 'job'))
);

CREATE INDEX `timing_days_day_idx` ON `timing_days` (`day`);
CREATE TABLE `measuring_settings` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`on` integer DEFAULT false NOT NULL,
	`send_outside` integer DEFAULT false NOT NULL,
	`outside_address` text,
	`keep_days` integer DEFAULT 90 NOT NULL,
	CONSTRAINT "measuring_settings_singleton" CHECK("measuring_settings"."singleton" = 1),
	CONSTRAINT "measuring_settings_on_boolean" CHECK("measuring_settings"."on" in (0, 1)),
	CONSTRAINT "measuring_settings_send_outside_boolean" CHECK("measuring_settings"."send_outside" in (0, 1)),
	CONSTRAINT "measuring_settings_keep_days_range" CHECK("measuring_settings"."keep_days" between 1 and 3650)
);

CREATE TABLE `migrations` (
	`number` integer PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
);

CREATE TABLE `operation_results` (
	`caller` text NOT NULL,
	`id` text NOT NULL,
	`operation` text NOT NULL,
	`result` blob NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`caller`, `id`)
);

CREATE INDEX `operation_results_expiry_idx` ON `operation_results` (`expires_at`);
CREATE TABLE `outside_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`target` text NOT NULL,
	`created_at` text NOT NULL,
	`released_at` text,
	`completed_at` text
);

CREATE TABLE `notification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`device` text NOT NULL,
	`item` text NOT NULL,
	`queued_at` text NOT NULL,
	`sent_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`device`) REFERENCES `notification_devices`(`endpoint`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `signin_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `bridge_raw_events` (
	`connection` text NOT NULL,
	`id` text NOT NULL,
	`received_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`event` blob NOT NULL,
	PRIMARY KEY(`connection`, `id`),
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `bridge_raw_events_expiry_idx` ON `bridge_raw_events` (`expires_at`);
CREATE TABLE `bridge_resume` (
	`connection` text PRIMARY KEY NOT NULL,
	`session` text NOT NULL,
	`sequence` integer NOT NULL,
	`resume_url` text NOT NULL,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `secret_write_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`operation` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "secret_write_journal_operation_choice" CHECK("secret_write_journal"."operation" in ('add', 'replace', 'remove')),
	CONSTRAINT "secret_write_journal_state_choice" CHECK("secret_write_journal"."state" in ('prepared', 'committed', 'undone'))
);

