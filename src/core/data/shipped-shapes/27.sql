-- Generated from src/core/data/schema.ts. Run npm run schema:generate.
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`full_owner` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`joined_at` text NOT NULL,
	`removed_at` text,
	CONSTRAINT "members_joined_at_utc" CHECK("members"."joined_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "members"."joined_at") = "members"."joined_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "members"."joined_at") = "members"."joined_at", 0)),
	CONSTRAINT "members_removed_at_utc" CHECK("members"."removed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "members"."removed_at") = "members"."removed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "members"."removed_at") = "members"."removed_at", 0)),
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
	`removed_at` text,
	CONSTRAINT "agents_about_asked_at_utc" CHECK("agents"."about_asked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "agents"."about_asked_at") = "agents"."about_asked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "agents"."about_asked_at") = "agents"."about_asked_at", 0)),
	CONSTRAINT "agents_removed_at_utc" CHECK("agents"."removed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "agents"."removed_at") = "agents"."removed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "agents"."removed_at") = "agents"."removed_at", 0)),
	CONSTRAINT "agents_about_length" CHECK(length("agents"."about") <= 600),
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
	`name` text NOT NULL,
	`removed_at` text,
	`retired_at` text,
	CONSTRAINT "projects_removed_at_utc" CHECK("projects"."removed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "projects"."removed_at") = "projects"."removed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "projects"."removed_at") = "projects"."removed_at", 0)),
	CONSTRAINT "projects_retired_at_utc" CHECK("projects"."retired_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "projects"."retired_at") = "projects"."retired_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "projects"."retired_at") = "projects"."retired_at", 0))
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
	CONSTRAINT "member_preferences_changed_at_utc" CHECK("member_preferences"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "member_preferences"."changed_at") = "member_preferences"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "member_preferences"."changed_at") = "member_preferences"."changed_at", 0)),
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
	CONSTRAINT "tokens_created_at_utc" CHECK("tokens"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tokens"."created_at") = "tokens"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tokens"."created_at") = "tokens"."created_at", 0)),
	CONSTRAINT "tokens_expires_at_utc" CHECK("tokens"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tokens"."expires_at") = "tokens"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tokens"."expires_at") = "tokens"."expires_at", 0)),
	CONSTRAINT "tokens_revoked_at_utc" CHECK("tokens"."revoked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tokens"."revoked_at") = "tokens"."revoked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tokens"."revoked_at") = "tokens"."revoked_at", 0)),
	CONSTRAINT "tokens_last_used_at_utc" CHECK("tokens"."last_used_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tokens"."last_used_at") = "tokens"."last_used_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tokens"."last_used_at") = "tokens"."last_used_at", 0)),
	CONSTRAINT "tokens_identity" CHECK(("tokens"."kind" = 'owner' and "tokens"."member" is not null and "tokens"."agent" is null and "tokens"."box" is null and "tokens"."job" is null) or ("tokens"."kind" = 'agent' and "tokens"."agent" is not null and "tokens"."member" is null and "tokens"."box" is null) or ("tokens"."kind" = 'runner' and "tokens"."box" is not null and "tokens"."member" is null and "tokens"."agent" is null and "tokens"."job" is null)),
	CONSTRAINT "tokens_kind_choice" CHECK("tokens"."kind" in ('owner', 'agent', 'runner'))
);

CREATE INDEX `tokens_label_idx` ON `tokens` (`label`);
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
	`passkey` text,
	`made_by` text,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`passkey`) REFERENCES `passkeys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`made_by`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_issued_at_utc" CHECK("sessions"."issued_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "sessions"."issued_at") = "sessions"."issued_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "sessions"."issued_at") = "sessions"."issued_at", 0)),
	CONSTRAINT "sessions_seen_at_utc" CHECK("sessions"."seen_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "sessions"."seen_at") = "sessions"."seen_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "sessions"."seen_at") = "sessions"."seen_at", 0)),
	CONSTRAINT "sessions_proved_at_utc" CHECK("sessions"."proved_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "sessions"."proved_at") = "sessions"."proved_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "sessions"."proved_at") = "sessions"."proved_at", 0)),
	CONSTRAINT "sessions_via_choice" CHECK("sessions"."via" in ('link', 'passkey', 'token')),
	CONSTRAINT "sessions_is_agent_boolean" CHECK("sessions"."is_agent" in (0, 1))
);

CREATE TABLE `signin_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` text NOT NULL,
	`session` text,
	`is_agent` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signin_links_expires_at_utc" CHECK("signin_links"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "signin_links"."expires_at") = "signin_links"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "signin_links"."expires_at") = "signin_links"."expires_at", 0)),
	CONSTRAINT "signin_links_is_agent_boolean" CHECK("signin_links"."is_agent" in (0, 1))
);

CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "passkeys_created_at_utc" CHECK("passkeys"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "passkeys"."created_at") = "passkeys"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "passkeys"."created_at") = "passkeys"."created_at", 0)),
	CONSTRAINT "passkeys_last_used_at_utc" CHECK("passkeys"."last_used_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "passkeys"."last_used_at") = "passkeys"."last_used_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "passkeys"."last_used_at") = "passkeys"."last_used_at", 0))
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
	FOREIGN KEY (`session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_devices_created_at_utc" CHECK("notification_devices"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "notification_devices"."created_at") = "notification_devices"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "notification_devices"."created_at") = "notification_devices"."created_at", 0)),
	CONSTRAINT "notification_devices_seen_at_utc" CHECK("notification_devices"."seen_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "notification_devices"."seen_at") = "notification_devices"."seen_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "notification_devices"."seen_at") = "notification_devices"."seen_at", 0))
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
	CONSTRAINT "tasks_created_at_utc" CHECK("tasks"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tasks"."created_at") = "tasks"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tasks"."created_at") = "tasks"."created_at", 0)),
	CONSTRAINT "tasks_started_at_utc" CHECK("tasks"."started_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tasks"."started_at") = "tasks"."started_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tasks"."started_at") = "tasks"."started_at", 0)),
	CONSTRAINT "tasks_closed_at_utc" CHECK("tasks"."closed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tasks"."closed_at") = "tasks"."closed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tasks"."closed_at") = "tasks"."closed_at", 0)),
	CONSTRAINT "tasks_changed_at_utc" CHECK("tasks"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "tasks"."changed_at") = "tasks"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "tasks"."changed_at") = "tasks"."changed_at", 0)),
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

CREATE UNIQUE INDEX `tasks_spec_line_unique` ON `tasks` (`spec_item`,`criterion`) WHERE "tasks"."spec_item" is not null and "tasks"."criterion" is not null;
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
	CONSTRAINT "task_comments_at_utc" CHECK("task_comments"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "task_comments"."at") = "task_comments"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "task_comments"."at") = "task_comments"."at", 0)),
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
	`direct` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`last_at` text NOT NULL,
	`turn_count` integer NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_direct_boolean" CHECK("conversations"."direct" in (0, 1)),
	CONSTRAINT "conversations_started_at_utc" CHECK("conversations"."started_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "conversations"."started_at") = "conversations"."started_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "conversations"."started_at") = "conversations"."started_at", 0)),
	CONSTRAINT "conversations_last_at_utc" CHECK("conversations"."last_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "conversations"."last_at") = "conversations"."last_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "conversations"."last_at") = "conversations"."last_at", 0)),
	CONSTRAINT "conversations_venue_choice" CHECK("conversations"."venue" in ('loom', 'discord', 'slack', 'wake', 'handoff', 'terminal'))
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
	CONSTRAINT "turns_at_utc" CHECK("turns"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "turns"."at") = "turns"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "turns"."at") = "turns"."at", 0)),
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
	FOREIGN KEY (`inbox_item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "digests_summary_length" CHECK(length("digests"."summary") <= 600),
	CONSTRAINT "digests_at_utc" CHECK("digests"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "digests"."at") = "digests"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "digests"."at") = "digests"."at", 0))
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
	CONSTRAINT "agent_status_changed_at_utc" CHECK("agent_status"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "agent_status"."changed_at") = "agent_status"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "agent_status"."changed_at") = "agent_status"."changed_at", 0)),
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
	`first_accepted_at` text,
	`taken_volume` text,
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
	`on_word_kind` text,
	`on_word` text,
	`chain` text,
	`chain_started_at` text,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread`,`message_seq`) REFERENCES `messages`(`thread`,`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_chain_started_at_utc" CHECK("inbox"."chain_started_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."chain_started_at") = "inbox"."chain_started_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."chain_started_at") = "inbox"."chain_started_at", 0)),
	CONSTRAINT "inbox_on_word_kind_choice" CHECK("inbox"."on_word_kind" in ('member', 'outside')),
	CONSTRAINT "inbox_on_word_pair" CHECK(("inbox"."on_word_kind" is null) = ("inbox"."on_word" is null)),
	CONSTRAINT "inbox_chain_pair" CHECK(("inbox"."chain" is null) = ("inbox"."chain_started_at" is null) and ("inbox"."chain" is null or (json_valid("inbox"."chain") and json_type("inbox"."chain") = 'array'))),
	CONSTRAINT "inbox_at_utc" CHECK("inbox"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."at") = "inbox"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."at") = "inbox"."at", 0)),
	CONSTRAINT "inbox_quiet_until_utc" CHECK("inbox"."quiet_until" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."quiet_until") = "inbox"."quiet_until" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."quiet_until") = "inbox"."quiet_until", 0)),
	CONSTRAINT "inbox_taken_at_utc" CHECK("inbox"."taken_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."taken_at") = "inbox"."taken_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."taken_at") = "inbox"."taken_at", 0)),
	CONSTRAINT "inbox_first_accepted_at_utc" CHECK("inbox"."first_accepted_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."first_accepted_at") = "inbox"."first_accepted_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."first_accepted_at") = "inbox"."first_accepted_at", 0)),
	CONSTRAINT "inbox_done_at_utc" CHECK("inbox"."done_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."done_at") = "inbox"."done_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."done_at") = "inbox"."done_at", 0)),
	CONSTRAINT "inbox_answered_at_utc" CHECK("inbox"."answered_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."answered_at") = "inbox"."answered_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."answered_at") = "inbox"."answered_at", 0)),
	CONSTRAINT "inbox_changed_at_utc" CHECK("inbox"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox"."changed_at") = "inbox"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox"."changed_at") = "inbox"."changed_at", 0)),
	CONSTRAINT "inbox_message_pair" CHECK("inbox"."message_seq" is null or "inbox"."thread" is not null),
	CONSTRAINT "inbox_to_kind_choice" CHECK("inbox"."to_kind" in ('person', 'agent')),
	CONSTRAINT "inbox_source_choice" CHECK("inbox"."source" in ('thread', 'discord', 'slack', 'trigger', 'handoff', 'answer', 'task', 'approval', 'secret-request', 'notice')),
	CONSTRAINT "inbox_from_kind_choice" CHECK("inbox"."from_kind" in ('person', 'agent', 'schedule', 'unknown')),
	CONSTRAINT "inbox_state_choice" CHECK("inbox"."state" in ('waiting', 'taken', 'done', 'answered', 'resolved')),
	CONSTRAINT "inbox_taken_volume_choice" CHECK("inbox"."taken_volume" in ('full', 'dim', 'mute')),
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
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_reads_read_at_utc" CHECK("inbox_reads"."read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "inbox_reads"."read_at") = "inbox_reads"."read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "inbox_reads"."read_at") = "inbox_reads"."read_at", 0))
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
	CONSTRAINT "action_results_at_utc" CHECK("action_results"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "action_results"."at") = "action_results"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "action_results"."at") = "action_results"."at", 0)),
	CONSTRAINT "action_results_read_at_utc" CHECK("action_results"."read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "action_results"."read_at") = "action_results"."read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "action_results"."read_at") = "action_results"."read_at", 0)),
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
	CONSTRAINT "threads_archived_at_utc" CHECK("threads"."archived_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "threads"."archived_at") = "threads"."archived_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "threads"."archived_at") = "threads"."archived_at", 0)),
	CONSTRAINT "threads_opened_at_utc" CHECK("threads"."opened_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "threads"."opened_at") = "threads"."opened_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "threads"."opened_at") = "threads"."opened_at", 0)),
	CONSTRAINT "threads_last_at_utc" CHECK("threads"."last_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "threads"."last_at") = "threads"."last_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "threads"."last_at") = "threads"."last_at", 0)),
	CONSTRAINT "threads_working_since_utc" CHECK("threads"."working_since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "threads"."working_since") = "threads"."working_since" or strftime('%Y-%m-%dT%H:%M:%fZ', "threads"."working_since") = "threads"."working_since", 0)),
	CONSTRAINT "threads_working_beat_utc" CHECK("threads"."working_beat" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "threads"."working_beat") = "threads"."working_beat" or strftime('%Y-%m-%dT%H:%M:%fZ', "threads"."working_beat") = "threads"."working_beat", 0)),
	CONSTRAINT "threads_titled_by_choice" CHECK("threads"."titled_by" in ('member', 'agent')),
	CONSTRAINT "threads_title_length" CHECK(length("threads"."title") <= 60),
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
	CONSTRAINT "messages_at_utc" CHECK("messages"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "messages"."at") = "messages"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "messages"."at") = "messages"."at", 0)),
	CONSTRAINT "messages_keep_until_utc" CHECK("messages"."keep_until" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "messages"."keep_until") = "messages"."keep_until" or strftime('%Y-%m-%dT%H:%M:%fZ', "messages"."keep_until") = "messages"."keep_until", 0)),
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
	`at` text NOT NULL,
	CONSTRAINT "deleted_threads_at_utc" CHECK("deleted_threads"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "deleted_threads"."at") = "deleted_threads"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "deleted_threads"."at") = "deleted_threads"."at", 0))
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
	CONSTRAINT "approvals_asked_at_utc" CHECK("approvals"."asked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approvals"."asked_at") = "approvals"."asked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approvals"."asked_at") = "approvals"."asked_at", 0)),
	CONSTRAINT "approvals_decided_at_utc" CHECK("approvals"."decided_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approvals"."decided_at") = "approvals"."decided_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approvals"."decided_at") = "approvals"."decided_at", 0)),
	CONSTRAINT "approvals_expires_at_utc" CHECK("approvals"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approvals"."expires_at") = "approvals"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approvals"."expires_at") = "approvals"."expires_at", 0)),
	CONSTRAINT "approvals_used_at_utc" CHECK("approvals"."used_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approvals"."used_at") = "approvals"."used_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approvals"."used_at") = "approvals"."used_at", 0)),
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
	CONSTRAINT "approval_rules_set_at_utc" CHECK("approval_rules"."set_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approval_rules"."set_at") = "approval_rules"."set_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approval_rules"."set_at") = "approval_rules"."set_at", 0)),
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
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_notices_at_utc" CHECK("approval_notices"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approval_notices"."at") = "approval_notices"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approval_notices"."at") = "approval_notices"."at", 0))
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
	CONSTRAINT "approval_record_at_utc" CHECK("approval_record"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "approval_record"."at") = "approval_record"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "approval_record"."at") = "approval_record"."at", 0)),
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
	`wants_model` text,
	`member` text,
	`conversation` text,
	`asked_by_kind` text,
	`asked_by` text,
	`asked_at` text,
	`needs` text,
	`prefers` text,
	`program` text,
	`program_period` text,
	`read_state_from` text,
	`program_state` text,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`read_state_from`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "triggers_asked_at_utc" CHECK("triggers"."asked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "triggers"."asked_at") = "triggers"."asked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "triggers"."asked_at") = "triggers"."asked_at", 0)),
	CONSTRAINT "triggers_asked_by_kind_choice" CHECK("triggers"."asked_by_kind" in ('member', 'outside', 'agent')),
	CONSTRAINT "triggers_asker_with_conversation" CHECK(("triggers"."conversation" is null) = ("triggers"."asked_by_kind" is null) and ("triggers"."asked_by_kind" is null) = ("triggers"."asked_by" is null) and ("triggers"."asked_by_kind" is null) = ("triggers"."asked_at" is null)),
	CONSTRAINT "triggers_next_due_at_utc" CHECK("triggers"."next_due_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "triggers"."next_due_at") = "triggers"."next_due_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "triggers"."next_due_at") = "triggers"."next_due_at", 0)),
	CONSTRAINT "triggers_last_fired_at_utc" CHECK("triggers"."last_fired_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "triggers"."last_fired_at") = "triggers"."last_fired_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "triggers"."last_fired_at") = "triggers"."last_fired_at", 0)),
	CONSTRAINT "triggers_created_at_utc" CHECK("triggers"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "triggers"."created_at") = "triggers"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "triggers"."created_at") = "triggers"."created_at", 0)),
	CONSTRAINT "triggers_changed_at_utc" CHECK("triggers"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "triggers"."changed_at") = "triggers"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "triggers"."changed_at") = "triggers"."changed_at", 0)),
	CONSTRAINT "triggers_owner_required" CHECK(("triggers"."owner_kind" = 'household' and "triggers"."owner" is null) or ("triggers"."owner_kind" <> 'household' and "triggers"."owner" is not null)),
	CONSTRAINT "triggers_target_required" CHECK(("triggers"."target_kind" = 'operation' and "triggers"."target" is not null and length("triggers"."target") > 0) or ("triggers"."target_kind" = 'inbox' and "triggers"."to_kind" is not null and "triggers"."to" is not null)),
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
	FOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trigger_log_at_utc" CHECK("trigger_log"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "trigger_log"."at") = "trigger_log"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "trigger_log"."at") = "trigger_log"."at", 0))
);

CREATE TABLE `trigger_edits` (
	`seq` integer PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`at` text NOT NULL,
	`by_kind` text NOT NULL,
	`by` text NOT NULL,
	`before` text NOT NULL,
	FOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trigger_edits_at_utc" CHECK("trigger_edits"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "trigger_edits"."at") = "trigger_edits"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "trigger_edits"."at") = "trigger_edits"."at", 0)),
	CONSTRAINT "trigger_edits_by_kind_choice" CHECK("trigger_edits"."by_kind" in ('member', 'agent'))
);

CREATE INDEX `trigger_edits_trigger_idx` ON `trigger_edits` (`trigger`);
CREATE TABLE `agent_pauses` (
	`agent` text PRIMARY KEY NOT NULL,
	`since` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_pauses_since_utc" CHECK("agent_pauses"."since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "agent_pauses"."since") = "agent_pauses"."since" or strftime('%Y-%m-%dT%H:%M:%fZ', "agent_pauses"."since") = "agent_pauses"."since", 0))
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
	CONSTRAINT "changes_opened_at_utc" CHECK("changes"."opened_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "changes"."opened_at") = "changes"."opened_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "changes"."opened_at") = "changes"."opened_at", 0)),
	CONSTRAINT "changes_updated_at_utc" CHECK("changes"."updated_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "changes"."updated_at") = "changes"."updated_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "changes"."updated_at") = "changes"."updated_at", 0)),
	CONSTRAINT "changes_closed_at_utc" CHECK("changes"."closed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "changes"."closed_at") = "changes"."closed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "changes"."closed_at") = "changes"."closed_at", 0)),
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
	CONSTRAINT "change_sync_read_at_utc" CHECK("change_sync"."read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "change_sync"."read_at") = "change_sync"."read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "change_sync"."read_at") = "change_sync"."read_at", 0)),
	CONSTRAINT "change_sync_next_at_utc" CHECK("change_sync"."next_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "change_sync"."next_at") = "change_sync"."next_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "change_sync"."next_at") = "change_sync"."next_at", 0)),
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
	`slots` integer,
	`readers` text,
	`reading_sequence` integer DEFAULT 0 NOT NULL,
	`readings_left_out` integer DEFAULT 0 NOT NULL,
	`reading_silence_sequence` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "boxes_enrolled_at_utc" CHECK("boxes"."enrolled_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "boxes"."enrolled_at") = "boxes"."enrolled_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "boxes"."enrolled_at") = "boxes"."enrolled_at", 0)),
	CONSTRAINT "boxes_last_seen_at_utc" CHECK("boxes"."last_seen_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "boxes"."last_seen_at") = "boxes"."last_seen_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "boxes"."last_seen_at") = "boxes"."last_seen_at", 0)),
	CONSTRAINT "boxes_revoked_at_utc" CHECK("boxes"."revoked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "boxes"."revoked_at") = "boxes"."revoked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "boxes"."revoked_at") = "boxes"."revoked_at", 0)),
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

CREATE TABLE `box_readings` (
	`box` text NOT NULL,
	`kind` text NOT NULL,
	`thing` text NOT NULL,
	`generation` text NOT NULL,
	`occasion` integer DEFAULT 0 NOT NULL,
	`urgent_occasion` integer DEFAULT 0 NOT NULL,
	`ordinary_line` text,
	`ordinary_line_value` integer,
	`urgent_line_value` integer,
	`last_lines` text,
	`used_percent` integer,
	`size_mib` integer,
	`free_mib` integer,
	`engine_status` integer,
	`level` text NOT NULL,
	`since` text,
	`urgent_since` text,
	`read_at` text,
	`unknown_since` text,
	`observed_at` text,
	`unknown_ms` integer DEFAULT 0 NOT NULL,
	`absent_ms` integer,
	`report_sequence` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`box`, `kind`, `thing`),
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "box_readings_kind" CHECK("box_readings"."kind" in ('disk', 'memory', 'containers')),
	CONSTRAINT "box_readings_level" CHECK("box_readings"."level" in ('ok', 'raised', 'urgent')),
	CONSTRAINT "box_readings_used_percent_range" CHECK("box_readings"."used_percent" is null or "box_readings"."used_percent" between 0 and 100),
	CONSTRAINT "box_readings_engine_status_range" CHECK("box_readings"."engine_status" is null or "box_readings"."engine_status" = 200 or "box_readings"."engine_status" between 300 and 599),
	CONSTRAINT "box_readings_since_utc" CHECK("box_readings"."since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "box_readings"."since") = "box_readings"."since" or strftime('%Y-%m-%dT%H:%M:%fZ', "box_readings"."since") = "box_readings"."since", 0)),
	CONSTRAINT "box_readings_urgent_since_utc" CHECK("box_readings"."urgent_since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "box_readings"."urgent_since") = "box_readings"."urgent_since" or strftime('%Y-%m-%dT%H:%M:%fZ', "box_readings"."urgent_since") = "box_readings"."urgent_since", 0)),
	CONSTRAINT "box_readings_read_at_utc" CHECK("box_readings"."read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "box_readings"."read_at") = "box_readings"."read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "box_readings"."read_at") = "box_readings"."read_at", 0)),
	CONSTRAINT "box_readings_unknown_since_utc" CHECK("box_readings"."unknown_since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "box_readings"."unknown_since") = "box_readings"."unknown_since" or strftime('%Y-%m-%dT%H:%M:%fZ', "box_readings"."unknown_since") = "box_readings"."unknown_since", 0)),
	CONSTRAINT "box_readings_stale_boolean" CHECK("box_readings"."stale" in (0, 1))
);

CREATE TABLE `box_alert_settings` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`disk_percent` integer DEFAULT 85 NOT NULL,
	`disk_urgent_percent` integer DEFAULT 95 NOT NULL,
	`disk_free_mib` integer DEFAULT 5120 NOT NULL,
	`memory_free_mib` integer DEFAULT 512 NOT NULL,
	CONSTRAINT "box_alert_settings_singleton" CHECK("box_alert_settings"."singleton" = 1),
	CONSTRAINT "box_alert_settings_disk_percent_range" CHECK(typeof("box_alert_settings"."disk_percent") = 'integer' and "box_alert_settings"."disk_percent" between 10 and 99),
	CONSTRAINT "box_alert_settings_disk_urgent_percent_range" CHECK(typeof("box_alert_settings"."disk_urgent_percent") = 'integer' and "box_alert_settings"."disk_urgent_percent" > "box_alert_settings"."disk_percent" and "box_alert_settings"."disk_urgent_percent" <= 100),
	CONSTRAINT "box_alert_settings_disk_free_mib_range" CHECK(typeof("box_alert_settings"."disk_free_mib") = 'integer' and "box_alert_settings"."disk_free_mib" between 0 and 1000000000),
	CONSTRAINT "box_alert_settings_memory_free_mib_range" CHECK(typeof("box_alert_settings"."memory_free_mib") = 'integer' and "box_alert_settings"."memory_free_mib" between 0 and 1000000000)
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
	`account` text,
	`harness` text,
	`started_by_kind` text NOT NULL,
	`started_by` text NOT NULL,
	`retry_of` text,
	`retry_at` text,
	`house_repository` text NOT NULL,
	`house_file` text NOT NULL,
	`house_branch` text NOT NULL,
	`build` text,
	`exit_code` integer,
	`exit_by` text,
	`log_tail` text,
	`ended_by` text,
	`ended_reason` text,
	`ended_note` text,
	`queued_at` text NOT NULL,
	`claimed_at` text,
	`heard_at` text,
	`ended_at` text,
	`prefers` text,
	`placement_decision` text,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retry_of`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ended_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_retry_at_utc" CHECK("jobs"."retry_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "jobs"."retry_at") = "jobs"."retry_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "jobs"."retry_at") = "jobs"."retry_at", 0)),
	CONSTRAINT "jobs_queued_at_utc" CHECK("jobs"."queued_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "jobs"."queued_at") = "jobs"."queued_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "jobs"."queued_at") = "jobs"."queued_at", 0)),
	CONSTRAINT "jobs_claimed_at_utc" CHECK("jobs"."claimed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "jobs"."claimed_at") = "jobs"."claimed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "jobs"."claimed_at") = "jobs"."claimed_at", 0)),
	CONSTRAINT "jobs_heard_at_utc" CHECK("jobs"."heard_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "jobs"."heard_at") = "jobs"."heard_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "jobs"."heard_at") = "jobs"."heard_at", 0)),
	CONSTRAINT "jobs_ended_at_utc" CHECK("jobs"."ended_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "jobs"."ended_at") = "jobs"."ended_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "jobs"."ended_at") = "jobs"."ended_at", 0)),
	CONSTRAINT "jobs_state_choice" CHECK("jobs"."state" in ('queued', 'starting', 'running', 'done', 'failed', 'stopped', 'lost')),
	CONSTRAINT "jobs_ended_reason_choice" CHECK("jobs"."ended_reason" in ('reset', 'write-off', 'stop')),
	CONSTRAINT "jobs_exit_by_choice" CHECK("jobs"."exit_by" in ('body', 'worker', 'loom', 'runner'))
);

CREATE UNIQUE INDEX `jobs_one_active_unique` ON `jobs` (`conversation`) WHERE "jobs"."state" in ('queued', 'starting', 'running');
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
	`prefers` text,
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
	CONSTRAINT "model_accounts_usage_read_at_utc" CHECK("model_accounts"."usage_read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_accounts"."usage_read_at") = "model_accounts"."usage_read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_accounts"."usage_read_at") = "model_accounts"."usage_read_at", 0)),
	CONSTRAINT "model_accounts_resets_at_utc" CHECK("model_accounts"."resets_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_accounts"."resets_at") = "model_accounts"."resets_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_accounts"."resets_at") = "model_accounts"."resets_at", 0)),
	CONSTRAINT "model_accounts_has_room_boolean" CHECK("model_accounts"."has_room" in (0, 1)),
	CONSTRAINT "model_accounts_usage_range" CHECK("model_accounts"."usage" is null or "model_accounts"."usage" between 0 and 1)
);

CREATE TABLE `model_account_windows` (
	`account` text NOT NULL,
	`window` text NOT NULL,
	`usage` real,
	`usage_read_at` text,
	`resets_at` text,
	`duration_ms` real NOT NULL,
	`reserve` real DEFAULT 0.05 NOT NULL,
	PRIMARY KEY(`account`, `window`),
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_account_windows_name" CHECK(length(trim("model_account_windows"."window")) > 0),
	CONSTRAINT "model_account_windows_usage_range" CHECK("model_account_windows"."usage" is null or "model_account_windows"."usage" between 0 and 1),
	CONSTRAINT "model_account_windows_usage_read_at_utc" CHECK("model_account_windows"."usage_read_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_account_windows"."usage_read_at") = "model_account_windows"."usage_read_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_account_windows"."usage_read_at") = "model_account_windows"."usage_read_at", 0)),
	CONSTRAINT "model_account_windows_resets_at_utc" CHECK("model_account_windows"."resets_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_account_windows"."resets_at") = "model_account_windows"."resets_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_account_windows"."resets_at") = "model_account_windows"."resets_at", 0)),
	CONSTRAINT "model_account_windows_duration_positive" CHECK("model_account_windows"."duration_ms" > 0 and "model_account_windows"."duration_ms" < 1e100),
	CONSTRAINT "model_account_windows_reserve_range" CHECK("model_account_windows"."reserve" between 0 and 1)
);

CREATE TABLE `model_account_boxes` (
	`account` text NOT NULL,
	`box` text NOT NULL,
	PRIMARY KEY(`account`, `box`),
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `account_signins` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`box` text NOT NULL,
	`asked_by_kind` text NOT NULL,
	`asked_by` text NOT NULL,
	`state` text NOT NULL,
	`item` text,
	`why` text,
	`asked_at` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_signins_asked_at_utc" CHECK("account_signins"."asked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "account_signins"."asked_at") = "account_signins"."asked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "account_signins"."asked_at") = "account_signins"."asked_at", 0)),
	CONSTRAINT "account_signins_changed_at_utc" CHECK("account_signins"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "account_signins"."changed_at") = "account_signins"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "account_signins"."changed_at") = "account_signins"."changed_at", 0)),
	CONSTRAINT "account_signins_asked_by_kind_choice" CHECK("account_signins"."asked_by_kind" in ('member', 'agent')),
	CONSTRAINT "account_signins_state_choice" CHECK("account_signins"."state" in ('asked', 'started', 'waiting', 'done', 'failed'))
);

CREATE INDEX `account_signins_box_state_idx` ON `account_signins` (`box`,`state`);
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
	`removed_at` text,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_secret`) REFERENCES `secrets`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_connections_state_at_utc" CHECK("bridge_connections"."state_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_connections"."state_at") = "bridge_connections"."state_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_connections"."state_at") = "bridge_connections"."state_at", 0)),
	CONSTRAINT "bridge_connections_removed_at_utc" CHECK("bridge_connections"."removed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_connections"."removed_at") = "bridge_connections"."removed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_connections"."removed_at") = "bridge_connections"."removed_at", 0)),
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
	`brief` text,
	`reports_to` text,
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
	`mentions` text,
	`replies_to` text,
	`parent` text,
	`group_dm` integer,
	`bot` integer,
	`webhook` integer,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_incoming_group_dm_boolean" CHECK("bridge_incoming"."group_dm" in (0, 1)),
	CONSTRAINT "bridge_incoming_bot_boolean" CHECK("bridge_incoming"."bot" in (0, 1)),
	CONSTRAINT "bridge_incoming_webhook_boolean" CHECK("bridge_incoming"."webhook" in (0, 1)),
	CONSTRAINT "bridge_incoming_posted_at_utc" CHECK("bridge_incoming"."posted_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_incoming"."posted_at") = "bridge_incoming"."posted_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_incoming"."posted_at") = "bridge_incoming"."posted_at", 0)),
	CONSTRAINT "bridge_incoming_received_at_utc" CHECK("bridge_incoming"."received_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_incoming"."received_at") = "bridge_incoming"."received_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_incoming"."received_at") = "bridge_incoming"."received_at", 0)),
	CONSTRAINT "bridge_incoming_delivered_at_utc" CHECK("bridge_incoming"."delivered_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_incoming"."delivered_at") = "bridge_incoming"."delivered_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_incoming"."delivered_at") = "bridge_incoming"."delivered_at", 0)),
	CONSTRAINT "bridge_incoming_is_dm_boolean" CHECK("bridge_incoming"."is_dm" in (0, 1)),
	CONSTRAINT "bridge_incoming_state_choice" CHECK("bridge_incoming"."state" in ('pending', 'held', 'dropped', 'delivered'))
);

CREATE TABLE `bridge_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`incoming` text,
	`connection` text NOT NULL,
	`channel` text NOT NULL,
	`thread` text,
	`conversation` text,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_sends_created_at_utc" CHECK("bridge_sends"."created_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_sends"."created_at") = "bridge_sends"."created_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_sends"."created_at") = "bridge_sends"."created_at", 0)),
	CONSTRAINT "bridge_sends_state_choice" CHECK("bridge_sends"."state" in ('pending', 'held', 'sending', 'sent', 'uncertain', 'dismissed')),
	CONSTRAINT "bridge_sends_answers_or_placed" CHECK(coalesce("bridge_sends"."incoming", "bridge_sends"."conversation") is not null)
);

CREATE TABLE `bridge_files` (
	`connection` text NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`contents` blob NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`connection`, `file`),
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridge_files_fetched_at_utc" CHECK("bridge_files"."fetched_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_files"."fetched_at") = "bridge_files"."fetched_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_files"."fetched_at") = "bridge_files"."fetched_at", 0))
);

CREATE TABLE `secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`changed_at` text NOT NULL,
	`changed_by` text NOT NULL,
	FOREIGN KEY (`changed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secrets_changed_at_utc" CHECK("secrets"."changed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secrets"."changed_at") = "secrets"."changed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secrets"."changed_at") = "secrets"."changed_at", 0))
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
	FOREIGN KEY (`request`) REFERENCES `secret_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secret_grants_granted_at_utc" CHECK("secret_grants"."granted_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_grants"."granted_at") = "secret_grants"."granted_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_grants"."granted_at") = "secret_grants"."granted_at", 0)),
	CONSTRAINT "secret_grants_expires_at_utc" CHECK("secret_grants"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_grants"."expires_at") = "secret_grants"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_grants"."expires_at") = "secret_grants"."expires_at", 0))
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
	CONSTRAINT "secret_requests_asked_at_utc" CHECK("secret_requests"."asked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_requests"."asked_at") = "secret_requests"."asked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_requests"."asked_at") = "secret_requests"."asked_at", 0)),
	CONSTRAINT "secret_requests_answered_at_utc" CHECK("secret_requests"."answered_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_requests"."answered_at") = "secret_requests"."answered_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_requests"."answered_at") = "secret_requests"."answered_at", 0)),
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
	FOREIGN KEY (`secret`) REFERENCES `secret_rules`(`secret`) ON UPDATE no action ON DELETE no action,
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
	CONSTRAINT "secret_uses_at_utc" CHECK("secret_uses"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_uses"."at") = "secret_uses"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_uses"."at") = "secret_uses"."at", 0)),
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
	CONSTRAINT "secret_changes_at_utc" CHECK("secret_changes"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_changes"."at") = "secret_changes"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_changes"."at") = "secret_changes"."at", 0)),
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
	CONSTRAINT "measuring_settings_keep_days_range" CHECK("measuring_settings"."keep_days" between 0 and 3650)
);

CREATE TABLE `change_review_rounds` (
	`job` text PRIMARY KEY NOT NULL,
	`change` text NOT NULL,
	`head_commit` text NOT NULL,
	`tier` text NOT NULL,
	`round` integer NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text,
	`verdict` text,
	`findings` text,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_review_rounds_commit" CHECK(length(cast("change_review_rounds"."head_commit" as blob)) = 40 and length("change_review_rounds"."head_commit") = 40 and "change_review_rounds"."head_commit" not glob '*[^0-9a-f]*'),
	CONSTRAINT "change_review_rounds_tier" CHECK("change_review_rounds"."tier" in ('medium','high')),
	CONSTRAINT "change_review_rounds_round" CHECK(typeof("change_review_rounds"."round") = 'integer' and "change_review_rounds"."round" >= 1),
	CONSTRAINT "change_review_rounds_requested_utc" CHECK("change_review_rounds"."requested_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "change_review_rounds"."requested_at") = "change_review_rounds"."requested_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "change_review_rounds"."requested_at") = "change_review_rounds"."requested_at", 0)),
	CONSTRAINT "change_review_rounds_completed_utc" CHECK("change_review_rounds"."completed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "change_review_rounds"."completed_at") = "change_review_rounds"."completed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "change_review_rounds"."completed_at") = "change_review_rounds"."completed_at", 0)),
	CONSTRAINT "change_review_rounds_result" CHECK(("change_review_rounds"."completed_at" is null and "change_review_rounds"."verdict" is null and "change_review_rounds"."findings" is null) or
    ("change_review_rounds"."completed_at" is not null and "change_review_rounds"."verdict" is not null and "change_review_rounds"."verdict" in ('CLEAR','BLOCKING','NONE') and "change_review_rounds"."findings" is not null))
);

CREATE INDEX `change_review_rounds_history` ON `change_review_rounds` (`change`,`head_commit`,`requested_at`);
CREATE TABLE `imported_task_sequence` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`last_issued` integer NOT NULL,
	CONSTRAINT "imported_task_sequence_singleton" CHECK("imported_task_sequence"."singleton" = 1),
	CONSTRAINT "imported_task_sequence_range" CHECK(typeof("imported_task_sequence"."last_issued") = 'integer' and "imported_task_sequence"."last_issued" between 0 and 9007199254740991)
);

CREATE TABLE `trigger_acceptances` (
	`item` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	FOREIGN KEY (`item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `trigger_journals` (
	`trigger` text PRIMARY KEY NOT NULL,
	`lessons` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`state_revision` integer DEFAULT 0 NOT NULL,
	`state_changed_at` text,
	FOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `agent_kits` (
	`agent` text NOT NULL,
	`kit` text NOT NULL,
	`tools` text NOT NULL,
	PRIMARY KEY(`agent`, `kit`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_kit_projects` (
	`agent` text NOT NULL,
	`kit` text NOT NULL,
	`project` text NOT NULL,
	PRIMARY KEY(`agent`, `kit`, `project`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `agent_kit_members` (
	`agent` text NOT NULL,
	`kit` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`agent`, `kit`, `member`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `agent_kit_outside_people` (
	`agent` text NOT NULL,
	`kit` text NOT NULL,
	`platform` text NOT NULL,
	`workspace` text NOT NULL,
	`user` text NOT NULL,
	PRIMARY KEY(`agent`, `kit`, `platform`, `workspace`, `user`),
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `project_outside_people` (
	`project` text NOT NULL,
	`platform` text NOT NULL,
	`workspace` text NOT NULL,
	`user` text NOT NULL,
	PRIMARY KEY(`project`, `platform`, `workspace`, `user`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `kit_uses` (
	`agent` text NOT NULL,
	`conversation` text,
	`person_kind` text,
	`person` text,
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`kit` text NOT NULL,
	`tool` text NOT NULL,
	`at` text NOT NULL,
	`outcome` text NOT NULL,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `program_firings` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`at` text NOT NULL,
	`period` text,
	`job` text NOT NULL,
	`program` text NOT NULL,
	`status` text NOT NULL,
	`line` text,
	FOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `program_firings_job` ON `program_firings` (`job`);
CREATE UNIQUE INDEX `program_firings_pending` ON `program_firings` (`trigger`) WHERE "program_firings"."status" = 'pending';
CREATE UNIQUE INDEX `program_firings_period` ON `program_firings` (`trigger`,`period`);
CREATE TABLE `machine_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`machine` text NOT NULL,
	`agent` text NOT NULL,
	`job` text NOT NULL,
	`conversation` text,
	`word` text NOT NULL,
	`person` text,
	`read` text NOT NULL,
	`args` text NOT NULL,
	`asked_at` text NOT NULL,
	`bytes` integer NOT NULL,
	`outcome` text NOT NULL
);

CREATE INDEX `machine_reads_machine_time` ON `machine_reads` (`machine`,`asked_at`);
CREATE TABLE `terminal_credentials` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`machine` text NOT NULL,
	`member` text NOT NULL,
	`issued_by` text,
	FOREIGN KEY (`fingerprint`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `terminal_sessions` (
	`job` text PRIMARY KEY NOT NULL,
	`thread` text,
	`session_id` text NOT NULL,
	`instance_id` text,
	`machine` text NOT NULL,
	`member` text NOT NULL,
	`agent` text NOT NULL,
	`harness` text NOT NULL,
	`cwd` text NOT NULL,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`machine`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `terminal_sessions_identity` ON `terminal_sessions` (`machine`,`member`,`agent`,`harness`,`session_id`);
CREATE TABLE `terminal_runs` (
	`job` text PRIMARY KEY NOT NULL,
	`parent` text NOT NULL,
	`run_id` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent`) REFERENCES `terminal_sessions`(`job`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `terminal_runs_identity` ON `terminal_runs` (`parent`,`run_id`);
CREATE TABLE `job_usage` (
	`job` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read` integer,
	`cache_written` integer,
	`model_calls` integer,
	`tool_calls` integer,
	`tools` text,
	`first_context` integer,
	`largest_context` integer,
	`wall_ms` integer,
	`harness` text,
	`model` text,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_usage_source_choice" CHECK("job_usage"."source" in ('report','transcript','none','program'))
);

CREATE TABLE `model_account_logins` (
	`account` text NOT NULL,
	`box` text NOT NULL,
	`harness` text NOT NULL,
	`place` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text,
	`since` text NOT NULL,
	`checked_at` text NOT NULL,
	`learned_from` text NOT NULL,
	`why` text,
	PRIMARY KEY(`account`, `box`, `harness`, `place`),
	FOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_account_logins_harness" CHECK(length(trim("model_account_logins"."harness")) > 0),
	CONSTRAINT "model_account_logins_place" CHECK("model_account_logins"."place" in ('containers', 'host')),
	CONSTRAINT "model_account_logins_state" CHECK("model_account_logins"."state" in ('signed-in', 'signed-out')),
	CONSTRAINT "model_account_logins_learned_from" CHECK("model_account_logins"."learned_from" in ('check', 'job')),
	CONSTRAINT "model_account_logins_expires_at_utc" CHECK("model_account_logins"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_account_logins"."expires_at") = "model_account_logins"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_account_logins"."expires_at") = "model_account_logins"."expires_at", 0)),
	CONSTRAINT "model_account_logins_checked_at_utc" CHECK("model_account_logins"."checked_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_account_logins"."checked_at") = "model_account_logins"."checked_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_account_logins"."checked_at") = "model_account_logins"."checked_at", 0)),
	CONSTRAINT "model_account_logins_since_utc" CHECK("model_account_logins"."since" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "model_account_logins"."since") = "model_account_logins"."since" or strftime('%Y-%m-%dT%H:%M:%fZ', "model_account_logins"."since") = "model_account_logins"."since", 0))
);

CREATE TABLE `program_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `program_record_grants` (
	`token` text NOT NULL,
	`record_type` text NOT NULL,
	PRIMARY KEY(`token`, `record_type`),
	FOREIGN KEY (`token`) REFERENCES `program_tokens`(`token`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "program_record_grants_name" CHECK(length("program_record_grants"."record_type") between 1 and 200)
);

CREATE TABLE `program_operation_grants` (
	`token` text NOT NULL,
	`operation` text NOT NULL,
	PRIMARY KEY(`token`, `operation`),
	FOREIGN KEY (`token`) REFERENCES `program_tokens`(`token`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "program_operation_grants_name" CHECK(length("program_operation_grants"."operation") between 1 and 200)
);

CREATE TABLE `migrations` (
	`number` integer PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL,
	CONSTRAINT "migrations_appliedAt_utc" CHECK("migrations"."applied_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "migrations"."applied_at") = "migrations"."applied_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "migrations"."applied_at") = "migrations"."applied_at", 0))
);

CREATE TABLE `operation_results` (
	`caller` text NOT NULL,
	`id` text NOT NULL,
	`operation` text NOT NULL,
	`input_hash` text NOT NULL,
	`result` blob NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`caller`, `id`),
	CONSTRAINT "operationResults_expiresAt_utc" CHECK("operation_results"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "operation_results"."expires_at") = "operation_results"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "operation_results"."expires_at") = "operation_results"."expires_at", 0))
);

CREATE INDEX `operation_results_expiry_idx` ON `operation_results` (`expires_at`);
CREATE TABLE `notification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`device` text NOT NULL,
	`item` text NOT NULL,
	`queued_at` text NOT NULL,
	`sent_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`device`) REFERENCES `notification_devices`(`endpoint`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item`) REFERENCES `inbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notificationQueue_queuedAt_utc" CHECK("notification_queue"."queued_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "notification_queue"."queued_at") = "notification_queue"."queued_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "notification_queue"."queued_at") = "notification_queue"."queued_at", 0)),
	CONSTRAINT "notificationQueue_sentAt_utc" CHECK("notification_queue"."sent_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "notification_queue"."sent_at") = "notification_queue"."sent_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "notification_queue"."sent_at") = "notification_queue"."sent_at", 0))
);

CREATE TABLE `bridge_raw_events` (
	`connection` text NOT NULL,
	`id` text NOT NULL,
	`received_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`event` blob NOT NULL,
	PRIMARY KEY(`connection`, `id`),
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bridgeRawEvents_receivedAt_utc" CHECK("bridge_raw_events"."received_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_raw_events"."received_at") = "bridge_raw_events"."received_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_raw_events"."received_at") = "bridge_raw_events"."received_at", 0)),
	CONSTRAINT "bridgeRawEvents_expiresAt_utc" CHECK("bridge_raw_events"."expires_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "bridge_raw_events"."expires_at") = "bridge_raw_events"."expires_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "bridge_raw_events"."expires_at") = "bridge_raw_events"."expires_at", 0))
);

CREATE INDEX `bridge_raw_events_expiry_idx` ON `bridge_raw_events` (`expires_at`);
CREATE TABLE `bridge_resume` (
	`connection` text PRIMARY KEY NOT NULL,
	`session` text NOT NULL,
	`sequence` integer NOT NULL,
	`resume_url` text NOT NULL,
	`identity` text NOT NULL,
	FOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `bridge_send_parts` (
	`send` text NOT NULL,
	`part` integer NOT NULL,
	`posted_id` text NOT NULL,
	PRIMARY KEY(`send`, `part`),
	FOREIGN KEY (`send`) REFERENCES `bridge_sends`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `bridge_send_parts_posted_id_idx` ON `bridge_send_parts` (`posted_id`);
CREATE TABLE `bridge_send_jobs` (
	`send` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`direct_target` text,
	`final_reply` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`send`) REFERENCES `bridge_sends`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `bridge_file_messages` (
	`connection` text NOT NULL,
	`file` text NOT NULL,
	`incoming` text NOT NULL,
	PRIMARY KEY(`connection`, `file`, `incoming`),
	FOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection`,`file`) REFERENCES `bridge_files`(`connection`,`file`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `bridge_file_messages_incoming_idx` ON `bridge_file_messages` (`incoming`);
CREATE TABLE `bridge_send_files` (
	`send` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`contents` blob NOT NULL,
	PRIMARY KEY(`send`, `position`),
	FOREIGN KEY (`send`) REFERENCES `bridge_sends`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `conversation_sessions` (
	`conversation` text NOT NULL,
	`harness` text NOT NULL,
	`session` text NOT NULL,
	`files` blob NOT NULL,
	`bytes` integer NOT NULL,
	`started_at` text NOT NULL,
	PRIMARY KEY(`conversation`, `harness`),
	FOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_sessions_started_at_utc" CHECK("conversation_sessions"."started_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "conversation_sessions"."started_at") = "conversation_sessions"."started_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "conversation_sessions"."started_at") = "conversation_sessions"."started_at", 0))
);

CREATE TABLE `secret_write_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`member` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`input_hash` text NOT NULL,
	`operation` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "secretWriteJournal_startedAt_utc" CHECK("secret_write_journal"."started_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_write_journal"."started_at") = "secret_write_journal"."started_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_write_journal"."started_at") = "secret_write_journal"."started_at", 0)),
	CONSTRAINT "secretWriteJournal_completedAt_utc" CHECK("secret_write_journal"."completed_at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "secret_write_journal"."completed_at") = "secret_write_journal"."completed_at" or strftime('%Y-%m-%dT%H:%M:%fZ', "secret_write_journal"."completed_at") = "secret_write_journal"."completed_at", 0)),
	CONSTRAINT "secret_write_journal_operation_choice" CHECK("secret_write_journal"."operation" in ('add', 'replace', 'remove')),
	CONSTRAINT "secret_write_journal_state_choice" CHECK("secret_write_journal"."state" in ('prepared', 'committed', 'undone')),
	CONSTRAINT "secret_write_journal_input_hash_required" CHECK(length(trim("secret_write_journal"."input_hash", char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0)
);

CREATE TRIGGER "tasks_owner_member_insert" BEFORE INSERT ON "tasks" WHEN NEW."owner_kind" = 'member' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_member_update" BEFORE UPDATE ON "tasks" WHEN NEW."owner_kind" = 'member' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "owner" = OLD.id AND "owner_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "owner" = OLD.id AND "owner_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_agent_insert" BEFORE INSERT ON "tasks" WHEN NEW."owner_kind" = 'agent' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_agent_update" BEFORE UPDATE ON "tasks" WHEN NEW."owner_kind" = 'agent' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "owner" = OLD.id AND "owner_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "owner" = OLD.id AND "owner_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_owner_pair_insert" BEFORE INSERT ON "tasks" WHEN NOT coalesce(((NEW."owner" IS NULL AND NEW."owner_kind" IS NULL) OR (NEW."owner" IS NULL AND NEW."owner_kind" = 'household') OR (NEW."owner" IS NOT NULL AND NEW."owner_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_owner_pair_update" BEFORE UPDATE ON "tasks" WHEN NOT coalesce(((NEW."owner" IS NULL AND NEW."owner_kind" IS NULL) OR (NEW."owner" IS NULL AND NEW."owner_kind" = 'household') OR (NEW."owner" IS NOT NULL AND NEW."owner_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_assignee_member_insert" BEFORE INSERT ON "tasks" WHEN NEW."assignee_kind" = 'member' AND NEW."assignee" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."assignee") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_member_update" BEFORE UPDATE ON "tasks" WHEN NEW."assignee_kind" = 'member' AND NEW."assignee" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."assignee") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "assignee" = OLD.id AND "assignee_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "assignee" = OLD.id AND "assignee_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_agent_insert" BEFORE INSERT ON "tasks" WHEN NEW."assignee_kind" = 'agent' AND NEW."assignee" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."assignee") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_agent_update" BEFORE UPDATE ON "tasks" WHEN NEW."assignee_kind" = 'agent' AND NEW."assignee" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."assignee") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "assignee" = OLD.id AND "assignee_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "assignee" = OLD.id AND "assignee_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_assignee_pair_insert" BEFORE INSERT ON "tasks" WHEN NOT coalesce(((NEW."assignee" IS NULL AND NEW."assignee_kind" IS NULL) OR (NEW."assignee" IS NOT NULL AND NEW."assignee_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_assignee_pair_update" BEFORE UPDATE ON "tasks" WHEN NOT coalesce(((NEW."assignee" IS NULL AND NEW."assignee_kind" IS NULL) OR (NEW."assignee" IS NOT NULL AND NEW."assignee_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_asked_by_member_insert" BEFORE INSERT ON "tasks" WHEN NEW."asked_by_kind" = 'member' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_member_update" BEFORE UPDATE ON "tasks" WHEN NEW."asked_by_kind" = 'member' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_agent_insert" BEFORE INSERT ON "tasks" WHEN NEW."asked_by_kind" = 'agent' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_agent_update" BEFORE UPDATE ON "tasks" WHEN NEW."asked_by_kind" = 'agent' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_asked_by_pair_insert" BEFORE INSERT ON "tasks" WHEN NOT coalesce(((NEW."asked_by" IS NULL AND NEW."asked_by_kind" IS NULL) OR (NEW."asked_by" IS NOT NULL AND NEW."asked_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_asked_by_pair_update" BEFORE UPDATE ON "tasks" WHEN NOT coalesce(((NEW."asked_by" IS NULL AND NEW."asked_by_kind" IS NULL) OR (NEW."asked_by" IS NOT NULL AND NEW."asked_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_created_by_member_insert" BEFORE INSERT ON "tasks" WHEN NEW."created_by_kind" = 'member' AND NEW."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."created_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_member_update" BEFORE UPDATE ON "tasks" WHEN NEW."created_by_kind" = 'member' AND NEW."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."created_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "created_by" = OLD.id AND "created_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "created_by" = OLD.id AND "created_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_agent_insert" BEFORE INSERT ON "tasks" WHEN NEW."created_by_kind" = 'agent' AND NEW."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."created_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_agent_update" BEFORE UPDATE ON "tasks" WHEN NEW."created_by_kind" = 'agent' AND NEW."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."created_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "tasks" WHERE "created_by" = OLD.id AND "created_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tasks" WHERE "created_by" = OLD.id AND "created_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tasks_created_by_pair_insert" BEFORE INSERT ON "tasks" WHEN NOT coalesce(((NEW."created_by" IS NULL AND NEW."created_by_kind" IS NULL) OR (NEW."created_by" IS NOT NULL AND NEW."created_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tasks_created_by_pair_update" BEFORE UPDATE ON "tasks" WHEN NOT coalesce(((NEW."created_by" IS NULL AND NEW."created_by_kind" IS NULL) OR (NEW."created_by" IS NOT NULL AND NEW."created_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "task_comments_actor_member_insert" BEFORE INSERT ON "task_comments" WHEN NEW."actor_kind" = 'member' AND NEW."actor" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."actor") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_member_update" BEFORE UPDATE ON "task_comments" WHEN NEW."actor_kind" = 'member' AND NEW."actor" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."actor") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "task_comments" WHERE "actor" = OLD.id AND "actor_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "task_comments" WHERE "actor" = OLD.id AND "actor_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_agent_insert" BEFORE INSERT ON "task_comments" WHEN NEW."actor_kind" = 'agent' AND NEW."actor" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."actor") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_agent_update" BEFORE UPDATE ON "task_comments" WHEN NEW."actor_kind" = 'agent' AND NEW."actor" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."actor") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "task_comments" WHERE "actor" = OLD.id AND "actor_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "task_comments" WHERE "actor" = OLD.id AND "actor_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "task_comments_actor_pair_insert" BEFORE INSERT ON "task_comments" WHEN NOT coalesce(((NEW."actor" IS NULL AND NEW."actor_kind" IS NULL) OR (NEW."actor" IS NOT NULL AND NEW."actor_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "task_comments_actor_pair_update" BEFORE UPDATE ON "task_comments" WHEN NOT coalesce(((NEW."actor" IS NULL AND NEW."actor_kind" IS NULL) OR (NEW."actor" IS NOT NULL AND NEW."actor_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "triggers_owner_member_insert" BEFORE INSERT ON "triggers" WHEN NEW."owner_kind" = 'member' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_member_update" BEFORE UPDATE ON "triggers" WHEN NEW."owner_kind" = 'member' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "triggers" WHERE "owner" = OLD.id AND "owner_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "triggers" WHERE "owner" = OLD.id AND "owner_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_agent_insert" BEFORE INSERT ON "triggers" WHEN NEW."owner_kind" = 'agent' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_agent_update" BEFORE UPDATE ON "triggers" WHEN NEW."owner_kind" = 'agent' AND NEW."owner" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."owner") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "triggers" WHERE "owner" = OLD.id AND "owner_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "triggers" WHERE "owner" = OLD.id AND "owner_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_owner_pair_insert" BEFORE INSERT ON "triggers" WHEN NOT coalesce(((NEW."owner" IS NULL AND NEW."owner_kind" IS NULL) OR (NEW."owner" IS NULL AND NEW."owner_kind" = 'household') OR (NEW."owner" IS NOT NULL AND NEW."owner_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "triggers_owner_pair_update" BEFORE UPDATE ON "triggers" WHEN NOT coalesce(((NEW."owner" IS NULL AND NEW."owner_kind" IS NULL) OR (NEW."owner" IS NULL AND NEW."owner_kind" = 'household') OR (NEW."owner" IS NOT NULL AND NEW."owner_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "triggers_to_person_insert" BEFORE INSERT ON "triggers" WHEN NEW."to_kind" = 'person' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_person_update" BEFORE UPDATE ON "triggers" WHEN NEW."to_kind" = 'person' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_person_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "triggers" WHERE "to" = OLD.id AND "to_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_person_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "triggers" WHERE "to" = OLD.id AND "to_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_agent_insert" BEFORE INSERT ON "triggers" WHEN NEW."to_kind" = 'agent' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_agent_update" BEFORE UPDATE ON "triggers" WHEN NEW."to_kind" = 'agent' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "triggers" WHERE "to" = OLD.id AND "to_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "triggers" WHERE "to" = OLD.id AND "to_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "triggers_to_pair_insert" BEFORE INSERT ON "triggers" WHEN NOT coalesce(((NEW."to" IS NULL AND NEW."to_kind" IS NULL) OR (NEW."to" IS NOT NULL AND NEW."to_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "triggers_to_pair_update" BEFORE UPDATE ON "triggers" WHEN NOT coalesce(((NEW."to" IS NULL AND NEW."to_kind" IS NULL) OR (NEW."to" IS NOT NULL AND NEW."to_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "inbox_to_person_insert" BEFORE INSERT ON "inbox" WHEN NEW."to_kind" = 'person' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_person_update" BEFORE UPDATE ON "inbox" WHEN NEW."to_kind" = 'person' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_person_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "inbox" WHERE "to" = OLD.id AND "to_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_person_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "inbox" WHERE "to" = OLD.id AND "to_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_agent_insert" BEFORE INSERT ON "inbox" WHEN NEW."to_kind" = 'agent' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_agent_update" BEFORE UPDATE ON "inbox" WHEN NEW."to_kind" = 'agent' AND NEW."to" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."to") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "inbox" WHERE "to" = OLD.id AND "to_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "inbox" WHERE "to" = OLD.id AND "to_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "inbox_to_pair_insert" BEFORE INSERT ON "inbox" WHEN NOT coalesce(((NEW."to" IS NULL AND NEW."to_kind" IS NULL) OR (NEW."to" IS NOT NULL AND NEW."to_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "inbox_to_pair_update" BEFORE UPDATE ON "inbox" WHEN NOT coalesce(((NEW."to" IS NULL AND NEW."to_kind" IS NULL) OR (NEW."to" IS NOT NULL AND NEW."to_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tempo_settings_who_person_insert" BEFORE INSERT ON "tempo_settings" WHEN NEW."who_kind" = 'person' AND NEW."who" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."who") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_person_update" BEFORE UPDATE ON "tempo_settings" WHEN NEW."who_kind" = 'person' AND NEW."who" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."who") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_person_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "tempo_settings" WHERE "who" = OLD.id AND "who_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_person_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tempo_settings" WHERE "who" = OLD.id AND "who_kind" = 'person') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_agent_insert" BEFORE INSERT ON "tempo_settings" WHEN NEW."who_kind" = 'agent' AND NEW."who" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."who") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_agent_update" BEFORE UPDATE ON "tempo_settings" WHEN NEW."who_kind" = 'agent' AND NEW."who" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."who") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "tempo_settings" WHERE "who" = OLD.id AND "who_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "tempo_settings" WHERE "who" = OLD.id AND "who_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "tempo_settings_who_pair_insert" BEFORE INSERT ON "tempo_settings" WHEN NOT coalesce(((NEW."who" IS NULL AND NEW."who_kind" IS NULL) OR (NEW."who" IS NOT NULL AND NEW."who_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "tempo_settings_who_pair_update" BEFORE UPDATE ON "tempo_settings" WHEN NOT coalesce(((NEW."who" IS NULL AND NEW."who_kind" IS NULL) OR (NEW."who" IS NOT NULL AND NEW."who_kind" IN ('person', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "approval_rules_person_member_insert" BEFORE INSERT ON "approval_rules" WHEN NEW."person" IS NOT NULL AND NEW."person" <> '' AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."person") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "approval_rules_person_member_update" BEFORE UPDATE ON "approval_rules" WHEN NEW."person" IS NOT NULL AND NEW."person" <> '' AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."person") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "approval_rules_person_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "approval_rules" WHERE "person" = OLD.id) BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "approval_rules_person_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "approval_rules" WHERE "person" = OLD.id) BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_member_insert" BEFORE INSERT ON "trigger_edits" WHEN NEW."by_kind" = 'member' AND NEW."by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_member_update" BEFORE UPDATE ON "trigger_edits" WHEN NEW."by_kind" = 'member' AND NEW."by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "trigger_edits" WHERE "by" = OLD.id AND "by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "trigger_edits" WHERE "by" = OLD.id AND "by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_agent_insert" BEFORE INSERT ON "trigger_edits" WHEN NEW."by_kind" = 'agent' AND NEW."by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_agent_update" BEFORE UPDATE ON "trigger_edits" WHEN NEW."by_kind" = 'agent' AND NEW."by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "trigger_edits" WHERE "by" = OLD.id AND "by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "trigger_edits" WHERE "by" = OLD.id AND "by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "trigger_edits_by_pair_insert" BEFORE INSERT ON "trigger_edits" WHEN NOT coalesce(((NEW."by" IS NULL AND NEW."by_kind" IS NULL) OR (NEW."by" IS NOT NULL AND NEW."by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "trigger_edits_by_pair_update" BEFORE UPDATE ON "trigger_edits" WHEN NOT coalesce(((NEW."by" IS NULL AND NEW."by_kind" IS NULL) OR (NEW."by" IS NOT NULL AND NEW."by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "account_signins_asked_by_member_insert" BEFORE INSERT ON "account_signins" WHEN NEW."asked_by_kind" = 'member' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_member_update" BEFORE UPDATE ON "account_signins" WHEN NEW."asked_by_kind" = 'member' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_member_parent_delete" BEFORE DELETE ON "members" WHEN 1 AND EXISTS (SELECT 1 FROM "account_signins" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_member_parent_update" BEFORE UPDATE OF id ON "members" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "account_signins" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'member') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_agent_insert" BEFORE INSERT ON "account_signins" WHEN NEW."asked_by_kind" = 'agent' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_agent_update" BEFORE UPDATE ON "account_signins" WHEN NEW."asked_by_kind" = 'agent' AND NEW."asked_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" WHERE id = NEW."asked_by") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_agent_parent_delete" BEFORE DELETE ON "agents" WHEN 1 AND EXISTS (SELECT 1 FROM "account_signins" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_agent_parent_update" BEFORE UPDATE OF id ON "agents" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "account_signins" WHERE "asked_by" = OLD.id AND "asked_by_kind" = 'agent') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;
CREATE TRIGGER "account_signins_asked_by_pair_insert" BEFORE INSERT ON "account_signins" WHEN NOT coalesce(((NEW."asked_by" IS NULL AND NEW."asked_by_kind" IS NULL) OR (NEW."asked_by" IS NOT NULL AND NEW."asked_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "account_signins_asked_by_pair_update" BEFORE UPDATE ON "account_signins" WHEN NOT coalesce(((NEW."asked_by" IS NULL AND NEW."asked_by_kind" IS NULL) OR (NEW."asked_by" IS NOT NULL AND NEW."asked_by_kind" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;
CREATE TRIGGER "approval_record_immutable_update" BEFORE UPDATE ON "approval_record" BEGIN SELECT RAISE(ABORT, 'permanent record cannot be edited'); END;
CREATE TRIGGER "approval_record_immutable_delete" BEFORE DELETE ON "approval_record" BEGIN SELECT RAISE(ABORT, 'permanent record cannot be edited'); END;
CREATE TRIGGER "deleted_threads_immutable_update" BEFORE UPDATE ON "deleted_threads" BEGIN SELECT RAISE(ABORT, 'permanent record cannot be edited'); END;
CREATE TRIGGER "deleted_threads_immutable_delete" BEFORE DELETE ON "deleted_threads" BEGIN SELECT RAISE(ABORT, 'permanent record cannot be edited'); END;
CREATE TRIGGER "tokens_live_key_insert" BEFORE INSERT ON "tokens" WHEN NEW."revoked_at" IS NULL AND (NEW."expires_at" IS NULL OR julianday(NEW."expires_at") > julianday(loom_now())) AND EXISTS (SELECT 1 FROM "tokens" WHERE "label" = NEW."label" AND "fingerprint" <> NEW."fingerprint" AND "revoked_at" IS NULL AND ("expires_at" IS NULL OR julianday("expires_at") > julianday(loom_now()))) BEGIN SELECT RAISE(ABORT, 'live label must be unique'); END;
CREATE TRIGGER "tokens_live_key_update" BEFORE UPDATE ON "tokens" WHEN NEW."revoked_at" IS NULL AND (NEW."expires_at" IS NULL OR julianday(NEW."expires_at") > julianday(loom_now())) AND EXISTS (SELECT 1 FROM "tokens" WHERE "label" = NEW."label" AND "fingerprint" <> NEW."fingerprint" AND "revoked_at" IS NULL AND ("expires_at" IS NULL OR julianday("expires_at") > julianday(loom_now()))) BEGIN SELECT RAISE(ABORT, 'live label must be unique'); END;
CREATE TRIGGER "threads_no_reuse" BEFORE INSERT ON "threads" WHEN EXISTS (SELECT 1 FROM "deleted_threads" WHERE "id" = NEW."id") BEGIN SELECT RAISE(ABORT, 'deleted id cannot be reused'); END;
CREATE TRIGGER "threads_fixed_id" BEFORE UPDATE OF "id" ON "threads" WHEN NEW."id" <> OLD."id" BEGIN SELECT RAISE(ABORT, 'id cannot be changed'); END;
CREATE TRIGGER "threads_mark_deleted" AFTER DELETE ON "threads" BEGIN INSERT OR IGNORE INTO "deleted_threads" ("id", "conversation", "at") VALUES (OLD."id", OLD."conversation", loom_now()); END;
INSERT INTO box_alert_settings (singleton) VALUES (1);
