# Changelog

All notable changes to loom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Publish status:** `@jbarket/loomai@0.5.0` is the first version published to
> npm. `0.4.1` and everything before it exists only as a git tag — those versions
> were never on the registry, so the four months of work between `0.4.1`
> (2026-04-23) and this release ship together as `0.5.0`.

## [Unreleased]

- Fourteen more apps have loom's own icon: Agents, Knowledge, People, Projects, Activity, Sharing, Bridges, Settings, Appearance, Job usage, Household setup, Your account and the All apps key, with Approvals' redrawn clean. Home keeps its line icon for now.
- loom has its own app icons. Inbox, Comms, Tasks, Tempo, Changes and Approvals wear them on their dock keys, their windows' title strips, the launcher's tiles and the app switcher, tinted to each key in every look, light or dark, and with Higher contrast; the current key shows its icon dark on the lit key. An app whose icon isn't drawn yet keeps its line icon. Appearance's "Pixel icons" switch is gone, with the household icon set it turned on (the saved choice is kept on the server, unused). Icons are matched to apps by id, so renaming an app keeps its icon. To add or replace one: `scripts/build-house-icons.py <directory of <app>-src.png>` (`web/src/assets/house-icons/README.md`).
- What an agent is doing no longer lists every task it once claimed. A task is a pill only while it was touched in the last eight hours (three at most), and a job in the conversation a task was filed from names that task in its own pill. Every other task in progress is one quiet line under the pills, "54 tasks in progress ›", which opens Tasks on that agent's in-progress tasks; "+N more" counts only pills. A terminal pill says the machine's name, the harness and the folder ("At a terminal on loom · claude · loom") and never a machine's id, which sessions opened before today still hold in their title. A job the server has not heard from for longer than it allows stays listed, last, as "no word since Nov 14".
- An agent's card on Home is a summary that leads to the agent's own page. The card shows the face, name and state with "Open <name> ›" at the end of that row, what the agent is doing, the last answer in three lines (the block opens its conversation, and is absent when there is none), the three most recent conversations as quiet one-line links with "All conversations ›", and the message box. The agent's page in the Agents app holds everything in full: all it is doing, its jobs now and earlier with machine and times, its own report, what needs you, the whole last answer, more conversations, its last steps and its links to People, Activity and Comms. Steps, the reported line, the card's own ask and the People button moved there from the card. A rail card is the face, name, state, what the agent is doing and the unread count. "Runtime jobs" and "Current jobs" are "Jobs" everywhere, and an agent that has reported nothing is "Quiet".
- Each agent's card on Home, and its card in the rail, now starts with what the agent is doing right now, one pill per thing: "At a terminal on one · claude · loom", "Talking on Discord in #pond", "Talking with Alex in loom", "Running Plan the night", "Working on Order the pump · t-2190". A pill says since when, on which machine where you may see that machine, and whether it is still queued or starting, and opens what it names. The word beside the agent's name is "Working" whenever the list has anything, on Home and in the rail alike. A pill never says more than you could open: a job in a conversation you may not read says only "In a private conversation". The "Runtime jobs" and "Current jobs" blocks are gone; with nothing to show the card says "Nothing right now." Slack channels are not yet named ("Talking on Slack in a channel"): loom keeps a Slack channel's id and not its name.
- Home's top is a slim band again, with no "Home" heading and no Inbox button: "Needs you" and its count, the first three things waiting as chips (the words, wrapped to two lines, and who asked), then "+N more · Inbox ›" at the end, or "Inbox ›" when the chips show them all. A chip opens its item in the Inbox. A plain yes/no question can be answered from its chip; an approval, a secret request, a task's question and a question that says what Yes or No will do open in the Inbox to be read whole.
- A bare drop-down, text box or fieldset in an app keeps the kit's padding, corners and labels: the build had placed the kit's layer under the reset, which took them away. The icon in a tile's bar sits 3px further left, at the middle of its key.
- Comms reads like its page on the how-it-works site. A thread is a conversation: your messages are on the right in the app's tint and the agent's on the left, one name and one short time for each run of messages (the time alone today, a short date with it otherwise, in the household's time zone and never with a zone's name), and each message still says who and when to a screen reader. An agent's reply is drawn as markdown, with no raw HTML, no images and links only to http(s); a task or approval it mentions is a chip that opens it. A tool step is one dashed line with a dot ("Looked up three pumps · done"). A message says nothing once delivered, "Sending…" on its way, "On hold" or "Not delivered" otherwise. A question in the chat is a small card with the question, one line of what Yes and No do, its answer buttons and "Open in Inbox" for the rest; an open question shows once, where it was asked, or in one "Waiting on you" block over the message bar. The message bar is pinned under the thread: one line that grows, named "Message Art", with Send as the one filled button. Enter sends and Shift+Enter makes a new line; on a phone Enter makes a new line and the button sends. Where you cannot write (a terminal conversation, an archived one, someone else's) one line says why. Pin, Archive, Rename and Delete are behind one More menu in the thread's head, Stop stays beside it while work runs, and Delete still asks first. New conversation is the New button over the list. The list is headed by the folder's name and count, searches from a compact field, shows page buttons only when there is another page, and a row says a status only when it has one. "Earlier messages" loads above what you are reading without moving it, and the newest messages stay. Work is a column on the right where the tile is wide enough and one "Work · 3" line that opens in place where it is not; tasks are quiet rows, a pull request is a bordered card, anything else mentioned is a chip. The agent's face is a small one beside the title. Home's message box is the same bar. The Conversation activity page says each step in plain words.
- Opening an item no longer redraws the whole app. In Inbox and Comms, clicking a row changes the open item alone: the list keeps its place and the clicked row keeps the keyboard focus, and an Inbox item shows at once from what its row already holds. Changing folder, typing in search or turning a page keeps the folders, their counts, the search box and the last rows on screen until the new rows arrive, then starts the list from its top. Paging a thread's messages, a conversation's work, questions or activity, and changing Job usage's dates keep what was shown the same way. Anything kept is dropped the moment its feed fails or is refused.
- A dock key's name sits centred over its key again; it had been shifted left by its own width.
- A dock key's name is centred over its key, with a mouse and on a touch screen: measured in a browser this time. The earlier fix moved it from one side to the other.
- Inbox reads like its page on the how-it-works site. An open item shows who asked and whether it is open, the question as a title, when and for which project, then Why, If yes and If no beside their labels, and one "Record your answer" section: Yes and No, a line for your own words, and Record answer, Mark done and Dismiss as quiet buttons. A task's question uses the same section. Full, Dim and Mute are now one small Notify choice at the end of the item (Normal, Quiet, Hidden). "Open the task", "Open in Approvals" and "Open in Secrets" are links, and a task or approval the item is about opens from its chip. The list is headed by the folder's name and count, page buttons show only when there is another page, and the outcomes of your own actions are quiet rows with one Dismiss. Times read like "Nov 14, 2026, 9:20 AM CT".
- Apps share one quieter set of controls. Inside an app, a button is small and outlined, each screen has at most one filled button in the app's colour, and remove, delete, disconnect and revoke are outlined in red. Fields, drop-downs, checkboxes and search boxes are compact and match. An open item shows a title, small labels beside its facts and ruled sections. The open row in a list is marked by a bar on its left edge, a row's status is plain small text, and an empty list says so in a quiet line. Folders, list and open item each scroll on their own and fill the tile. On a phone, buttons and fields keep their full height.
- A tile's bar is the app's key, its title and three small drawn window controls (a square, a line, a cross): the back and forward arrows and the Trail are gone, while Alt+← and Alt+→ and the browser's own Back still travel a tile's history. Appearance is an app of its own, listed under Look & feel in the launcher, and no longer folds out of the top bar; it saves the same choices the same way, and Ground is called Desk background. The dock shows each app's name alone on hover, and its rule is as wide as the dock. Project sharing is named Sharing; Tempo and Sharing take their own colour. The ticker says how many boxes are enrolled without a health it has no source for, and no longer ends Tempo with a raw event name.
- Three keyboard shortcuts that work while typing: Ctrl+Space or a double tap of Shift opens and closes the launcher (Ctrl+Shift+Space still does), and holding Control while tapping the key under Escape switches between open apps, most recently used first. The launcher lists them.
- Owner cards can define pinned kit tools, grant kits to people or projects, and confirm outside project members. Kit calls use the current job’s asker and leave a metadata-only use record. Schema 15 starts existing households with empty kit tables.
- Tempo can schedule a named house program and record its decision, pass data to a wake, queue a ruled channel post, and keep small state between firings. Schema 16 retains existing schedules and job usage.
- Loom tracks each model account sign-in by account, machine, harness and place (the directory houses mount, or the machine user's own). The worker reads its machine's sign-in files and a job that got a model reply confirms its sign-in; no model takes part. The owner gets one notice when a sign-in is gone and one when it ends within three days, and placement passes over a machine whose houses are signed out. Workers take `hostLogins` and `loginCheckMs`. Schema 18 starts existing households with no sign-in records.
- A job that has no file tools (one on a guest's word) is shown the plain-text files sent with its Slack messages as words, within a size limit, and is told the names of the files it cannot open. Before, it was told nothing and said nothing had arrived.
- An agent reads back its own private conversation with a member where that member is the only one it can show it to: a body doing their work, and a session at their own terminal. From a session at a household owner's own terminal the agent can answer an approval for them, only on words loom recorded from them there. Terminal conversations are titled by machine name, harness and folder. Schema 19 records who made each terminal binding; the new reach needs one its own member made, so a machine-bound terminal credential from before is made again to gain it.
- An open window costs an idle household far less. A worker with no work asks for some about once a second, and each time every open live selection was read again twice: once for the worker credential's last-used time and once for the machine's last-seen time. A report that changes only such a time is now shown within a minute, not at once; a commit that wrote nothing tells nobody; and a change of who may see what still reaches every selection at once. What is left in an idle household is about four readings of each selection a minute: one after each thirty-second runtime sweep, one for the desk's clock and one for the stamps. Listing projects and reading activity read the sharing facts once per call, as listing people does, and finding the next activity deadline no longer reads every episode ever kept: the store leaves out those that cannot set one. `scripts/live-idle-cost.ts` counts the readings.
- Listing people reads the household's sharing facts once per listing, not several times per person. With a browser open, the server had spent nearly all its time there.
- Home no longer flickers between one column and two. Its scrollbar, a card's own, and the agents rail's keep their place whether or not they show, so a scrollbar appearing cannot change the width the layout is chosen by.
- House jobs can request fixed, audited diagnostics from opted-in machine workers. A report-only worker can answer without hosting jobs. Schema 17 adds explicit inspection grants and read history.

- Tempo lanes can require or prefer machine facts. Agent run settings can prefer facts for ordinary jobs. Placement falls back immediately when a preferred machine is unavailable, and job history explains the claim. Schema 14 preserves existing households.

- Claimed jobs and active bodies tolerate temporary Loom outages. Worker reports and replay-safe body calls retry for up to two minutes. Restarting the server gives claimed jobs a fresh reporting interval, including jobs still starting.

- Machine-bound terminal hooks can record private conversations, show live sessions, report measured main and subagent usage, and supply retained source turns for owner-word approvals. Schema 13 adds the machine binding and observed-session records.

- Job usage records show reported tokens, calls, tool names and peak context for each attempt. Open **Job usage** in the launcher to rank conversations by reported tokens and inspect their jobs over a date range. GraphQL also groups usage by trigger, day and model.

- Discord distinguishes a DM, a channel and a thread in the body's instructions. A person's taken message
  can show 👀, and typing follows work that owes the conversation an answer. An attachment-only message
  reaches the body under the same routing rules as text. A body with file tools receives local paths,
  and a body with loom's tools alone sees what was attached and why it cannot open it. A mention
  directed only at another bot stays with that bot even when it has no Loom connection.

- An agent can allow or deny an approval on a household owner's quoted words from its job's mail. With `onWord: {quote}`, exactly one eligible message must contain the quote. If several match, quote a longer passage. The card records the owner, agent and source. Owners can also record an unverified terminal instruction.

- **Review 3 folded: no schedules on anybody else's word, left-behind mail is its own asker's, and a guest's summary is stamped.** (1) A body on anybody else's word is refused every schedule door (`tempo.set`, `.edit`, `.start`, `.runNow`, `.stop`) with one line; the owner's card for a repeating schedule, the come-back and their notices stay in the code, dormant, until an owner can grant a person or a project tools of their own. This closes two one-time triggers restarting each other for ever unseen. These doors, and pause, resume and volume, now ask the job the credential is bound to. On a schedule card a trigger's id and wanted model are quoted, the id cut at 80 characters, and a change shows the standing note and words. (2) Mail an ended job left behind forms a job only when its own asker writes again; another asker's message no longer revives it or hands it back as fresh. A stop word, reset or write-off on an owners' job closes its mail with the reason. A guest's job set aside for an owner is retried after the owners' job as the same attempt. This closes an owner's stopped request being run again when a guest spoke, and two failing askers re-jobbing each other with nobody writing. (3) A held body's digest summary begins with loom's line (whose word, which conversation), its question may not wait on a task or an approval, and its status report no longer writes the agent's status row.

- **Jobs: owners first.** When mail on the owners' word waits in a conversation, its job is formed before anybody else's, whoever wrote first; other people follow, oldest first. A job on anybody else's word that no machine has taken yet is set aside when an owner's mail arrives behind it: the job is ended as `stopped` with a plain note, its mail waits again as fresh mail, and the owners' job is formed in the same write. A job a machine has claimed is left to finish, so the only wait left for an owner in a shared room is one running guest job. This replaces "the oldest waiting mail decides" from the entry below, and with it the wait of up to the queue deadline behind a guest's job that could not be placed.

- **Doors: of what the agent and the household keep, a body on anybody else's word only adds, and loom stamps what it adds.** Such a body may still `memory.remember` and write a note at a path no note has. loom writes on whose word and in which conversation: in the memory's `written_on_word` metadata (taken out of whatever a body sends), in its source, and as the first line of its words; and in the note's writer. Refused now: `memory.update`, `.archive`, `.restore`, `.forget`, `.restoreRevision`, `.propose`, `.ratify`, `.personWrite`, `.personRestoreRevision`, `.projectWrite`, overwriting a note, every `mind.knowledge*` write and `mind.personAdd`. A question such a body asks (`conversation.digest`) now goes only to the people who direct the agent (members who have it, or household owners when nobody has) and is refused if it carries a link.

- **Mail: reach follows who asked, never who else is in the room.** The owner's ruling of 2026-11-18. One job now holds one asker's mail. At admission a conversation's waiting mail is split by whose request it is: mail on the owners' word shares a job, with the agent's own work; mail on anybody else's word is jobbed by the person, one job to one such person. The rest waits for a job of its own; jobs in one conversation still run one at a time. Mail that arrives while a job is queued or running joins it only when the same asker wrote it. Before, one job took everything waiting and ran at the least reach in the batch: an owner who wrote beside a guest was answered with loom's tools only, and an owner's message joined a guest's queued job. Mail an ended job left behind (out of attempts, unplaced, stopped) is no longer marked into the next asker's job: when somebody speaks it is given back as fresh mail and gets a job of its own asker. A job the dispatcher ends because no harness can hold it is now reported like any job's end, so mail waiting behind it is admitted. The conversation's history names an outside account by its key instead of "someone outside the household", and the body of a Discord or Slack job is told before its mail who the job works for and that what others said in the room is talk, not instructions. See the entry above for the order (`docs/accepted-tradeoffs.md`, "One job holds one asker's mail").

- **Doors: on anybody else's word a body changes nothing outside its own conversation, except by asking the owners a question.** A sweep of every registered operation (100) found a body held to loom's tools could still raise and clear notices to the owners' phones, make and change tasks, file household proposals, and ask for, use, report on and withdraw approval cards, with no check of its job's word. All are now refused at the door with a plain line each (`heldRefusal`, `HELD_REFUSALS`): `notices.raise`, `notices.clear`, `tasks.command`, `household.propose`, `approvals.request`, `approvals.use`, `approvals.report`, `approvals.withdraw`. `conversation.digest` stays, and a question such a body asks now begins with loom's line saying on whose word the body was working. Left as it is: a brief to a peer agent. The memory, notes, cards and knowledge writes are in the entry above.

- **Tempo and bridges: numeric caps on a guest's job are replaced by notices, and a repeating schedule a guest asks for is an owner's to allow.** The owner's ruling of 2026-11-18: no numeric caps as guards, be loud instead. Removed: the limit of 5 notes and briefs a job on anybody else's word, the limit of 10 triggers standing for one conversation (for everybody), and the hourly rule for such a job's triggers, both the refusal at `tempo.set` / `tempo.edit` and the firing put off to the hour mark (the trigger log no longer says `put off`). Instead the members who have the agent, or the household's owners when nobody has it, get a notice and nothing is stopped: at 5 notes and briefs from one such job and each further 5; at 10 triggers standing for one conversation and each further 10; and at 5 come-backs in a row and each further 5. A job on anybody else's word that a firing or a note woke may now set and move a one-time trigger into its own conversation, to come back to work it is doing; it still sets, changes and starts no repeating one. A repeating trigger asked for on anybody else's word, or a change that leaves one repeating, is no longer set by the body: loom files a household card (`placeSchedule`) showing who asked, the conversation, the times and the note and words in full, `tempo.set` and `tempo.edit` answer with `waits` (and `tempo.edit` with `saved: false`), and the trigger is made or changed on the asker's word only when an owner allows the card. No standing rule answers it and `household.propose` does not take the kind. **Changed for existing setups:** a guest's body that set an hourly schedule directly now waits for an owner; triggers already standing are untouched.

- **Tempo: three holes a review found on a guest's job are closed.** A body on anybody else's word could pause and resume its whole agent (`tempo.pause`, `tempo.resume`) and could mute mail waiting for its agent in another conversation (`inbox.volume`), which then started no job; all three now ask the job's word and refuse it. And `tempo.edit` re-stamped a trigger's asker when its words were sent but not changed, so an owner's client sending a guest's trigger back as it stood made the guest's text fire on the owner's word: the asker now changes only when a word is different from what is stored, and an edit that changes one part of another person's words is refused whatever else it sends.

- **Bodies: reach `loom` now holds on Claude Code.** `--permission-mode dontAsk` with an allow list did not hold a body to loom's tools: checked on Claude Code 2.1.326, the model still ran read-only shell commands, read files and started subagents. A body whose reach is `loom`, by the machine's body file or because its job works on anybody else's word, is now started with `--tools ""` (no built-in tool) and with every built-in tool denied by name as well. `scripts/check-claude-floor.mjs` checks this against the real program, by effects; a person runs it, and it is not in the suite. **Changed for existing setups:** a machine whose body file says `reach: loom` (the default) gave its Claude bodies read-only shell, Read and subagents until now, and no longer does.

- **Runtime: a job no harness can run loom-only is ended with its reason.** A job on anybody else's word, for an agent whose every model runs on Codex or agy, is failed by loom as soon as a machine asks for work, with a note that says why and what to change. It used to wait for the 24-hour queue deadline. The mail that made the job anybody else's is closed with the same note, so it is carried into no later job: an owner's next message in that conversation starts a job on owners' word, which runs.

- **Bodies: a job on anybody else's word runs with loom's tools only.** One rule (`loomToolsOnly` in `src/policy.ts`), asked everywhere: a job whose word is not the agent's own work and not its owners' (`jobWord`) gets no shell, no files, no web and no helpers of the harness's own, on every machine, whatever the body file's `reach` says. Claude Code is started for it with no built-in tool (`--tools ""`), every built-in tool denied by name, and `--permission-mode dontAsk` with loom's tools as the allow list; Codex and agy always have a shell and are not given such a job. No startup secret is fetched for it, `request_secret` and `use_secret` are not served, and the secrets door and `secrets.request` refuse its body, so a body program that asks anyway gets nothing. It is handed no attachment files and `bridges.say` takes no file from it. It neither continues nor saves a kept harness session: `conversation.session` and `conversation.sessionSave` refuse its body, it starts fresh with the conversation's kept history, and the session an owners' job left is handed to the next owners' job as it was, without what the guest's job said in between. The dispatcher hands the word to the worker as `run.policy.word`; a room without one, and an assignment with no room, is read as anybody else's. **Changed for existing setups:** a tier 3 outside person and a household member who does not have the agent now count as anybody else for tools (they did not count as guests before), and a standing secret answer no longer serves a body working on such a word. A job on its owners' word, or the agent's own work, keeps everything it had on a machine whose body file says `reach: all`. **On a machine whose body file says `reach: loom` (the default), an owners' Claude job, and the agent's own work, lose read-only shell, Read and subagents:** `loom` now means loom's tools and nothing else, whoever asked (the first entry above). An owner cannot yet give a named outside person more than this floor (`docs/accepted-tradeoffs.md`).

- **Mail: a job's word does not fall while it runs.** A message from anybody else that arrives after an owners' job was admitted waits for the next job, as a note or a firing already did; before, the running job took it. The room and the word are read from the mail the job is offered, not from everything waiting in the conversation. The rule is a constructor argument of `Conversations` and is closed when none is given: such mail then waits.

- **Runtime: one body to a job.** `runtime.enrollBody` refuses another fingerprint while the job has a live body token. It used to end the first body's token and bind the second.

- **Bodies: no secret a body was handed is said by it.** The check on the final answer now also covers the values of startup secrets (eight bytes or longer), as bytes and as base64 like a used secret, and the same check is made on every text of every tool call a body makes: the commands it sends to loom, which covers `bridges.say`, `bridges.post` and `bridges.reply`, and the reason it gives `request_secret`.

- **Tempo and bridges: a trigger can name a conversation, bodies of one agent hand each other notes, and reach follows the person.** `tempo.set` takes `conversation`, a Discord or Slack conversation of the agent it puts to work: its firing is mail from the schedule there, on the word of whoever asked, and the answer is posted in the conversation as a new message. `conversation.handoff` takes `to`, a conversation of the agent or a channel it has a rule for; the agent's own work may post straight to a ruled channel with `bridges.post`. What a body may do with either follows the person on whose word its job works, least reach winning in a mixed batch, and never the place it sits in. Working for owners (household owners and members who have the agent) or as the agent's own work, it schedules and hands as it could from the owner's own thread. Working for anybody else, it schedules only into the shared place it is working in, with its own words, at listed times an hour apart; it hands only to its channel's report target (`reportsTo` on the channel's rule), one hop (a job a note or a brief started hands nothing on, to a peer agent either) and at most 5 notes and briefs a job; and once a firing or a note woke it, it schedules nothing more. For everybody: at most 10 triggers stand per conversation, no job fires again the trigger whose firing is in its mail, and into one member's private conversation only that member's word goes. A trigger's note counts as its words, with the same length limit. No firing carries one person's text on another's word: an owner who changes the words of a trigger a guest asked for replaces the note and the instructions together and becomes its asker, and changing only one of them is refused. The firing and admission hold these themselves: a firing or a note on the word of somebody no longer known, or into a private conversation on somebody else's word, is not delivered (the trigger is stopped, the note dropped, with a notice), and firings on a guest's word into one conversation are put off to an hour apart. After a stop word only a person's message un-parks a bridge conversation. Schema step 11 carries the columns and rebuilds `bridge_sends` so a post may answer no message.

- **Bridges: the second review folded.** A container worker always sets `LOOM_BODY_OWN_HARNESS`, to 1 or 0, so an image's own value never stands, and a body keeps sessions only where every step from its home to the sessions place is a real directory. No link is followed finding, reading, putting back or removing a session's files. Only a body with file tools of its own (full reach, Read not denied) is given attachments or may name a file for a post. A session's keep time counts from the oldest erasable word it holds (`conversation_sessions.started_at`, renamed in step 11). A stop word first taken in more than two minutes after it was said is spent. A reused post id with other files is refused.

- **Bridges: a body in a house continues its conversation's session.** The place a harness keeps its sessions is stated in the house layout (`/home/agent/.claude` for Claude Code), apart from the mounted sign-in. A container worker sets `LOOM_BODY_OWN_HARNESS=1` unless a mount is, holds, or is inside that place; an agent mount at `.claude` or under it turns resume off for that agent. The core house now makes `/home/agent/.claude`, since a body never makes it (the core's definition changes, so it is rebuilt). A worker that runs bodies as processes never sets the variable, and removes it if its configuration does.

- **Bridges: a harness session is kept only where the harness's directory is the body's own.** A worker sets `LOOM_BODY_OWN_HARNESS=1` in a body's container when nothing of the machine is mounted writable into it; only then does a body restore and keep a session. A body run as a process, or in a house with a sign-in directory mounted (`accountLogins`), starts fresh with the kept history every time. The body never creates the harness's directory, unpacks a session without following a link at any step, and the model's own tools cannot reach the session doors. A session's keep time now counts from when it was started, not from its last save.

- **Bridges: a body continues the session the last body of its conversation left.** When a Claude Code body of a Discord or Slack conversation has answered, it hands loom its session's files (gzipped, at most 700 KB); loom keeps one per conversation and harness in `conversation_sessions`, sealed with the words key, for the household's keep time. The next body is handed it and runs `claude --resume`, told only the new mail. With no session, another harness or model family, a session too large or too old, or one saved before the conversation's last answer, the body starts fresh with the kept history. New body operations `conversation.session` and `conversation.sessionSave`; nobody else can read a session, and no query serves the table. Claude Code no longer runs with `--no-session-persistence` for these bodies.

- **Bridges: `bridges.say` can carry files on Discord.** `files` takes up to four, 600 KB together. From a body's tools each is `{path}`, read by the body program from the body's working directory or scratch directory only; the door itself takes `{name, contents}` (base64). They are kept in `bridge_send_files` until the post is settled and go out with its last part.

- **Bridges: a body can open what was sent to it.** A delivered Discord message's attachments (the first five, up to 8 MB each) are fetched and kept like Slack files. A body with file tools is given the kept files of the messages it took, written into its scratch directory, with each path named in its input. The links stay in the words.

- **Bridges: the bot says "Stopped here." where a stop word stopped a job**, through the send queue.

- **Bridges: a channel's rule can name a brief.** The `channel` change takes `brief`, the name of a role page of the answering agent; the body of every conversation in that channel is given the page beside the venue's. With no such page the body works without it and the agent's owners get one notice in their Inbox. New body operations `bridges.brief` and `bridges.briefMissing`.

- **Schema step 11.** `bridge_channels` gains `brief`, empty on every rule there is. Two tables are added, both empty: `bridge_send_files` (the files a post carries until it is settled) and `conversation_sessions` (a harness's own record of a conversation, sealed, kept between bodies). The step adds only and touches no row. Neither table is read by the query door.

- **Bridges: a body is handed what was said earlier in its Discord or Slack conversation.** The take route attaches the conversation's earlier messages and posts (up to 1 MB and a hundred lines) to the first piece of bridge mail, as it does a Comms thread's dialogue. Before this a bridge body was given only the new message. A history line's `keepUntil` may now be `null` (words kept without limit); the body's client accepts history on `discord` and `slack` mail.

- **Bridges: a taken Discord message gets 👀, and the channel shows typing while the job works.** The reaction comes off when the reply is made or the job ends. Both are best effort and are never a job's failure. Slack shows neither.

- **Add `bridges.say`.** The body holding a Discord or Slack conversation's job can post more messages during its run (`{id, text}`), to where its reply will go, through the same send queue. It settles no mail; the final answer is still the reply. At most twenty posts are made for the mail one job took.

- **Bridges: "stop" or "cancel" stops the job working in that conversation.** Said alone (any case, a trailing `.` or `!`, mentions aside) on Discord or Slack by a linked member who may end the agent's jobs, in a place where a job of the agent's has not ended, it ends that job with the reason `stop` and is not delivered or answered. Otherwise the same words are an ordinary message. `jobs.ended_reason` `stop` can now also mean this.

- **Bridges: a ping of a bot's own role on Discord is a mention of the bot.** Discord's autocomplete offers a bot's managed role for its name; a written ping of that role now addresses the bot, for every bot in the guild. Any other role, `@everyone` and `@here` address nobody.
- **Bridges: a Discord thread under a bot's message addresses that bot, whoever posted the message.** A thread started from a message loom did not post (the older program, a script using the same token) used to address nobody. A reply inside a thread still answers the message it points at.
- **Bridges: Discord attachments are listed in the message's words**, with name, type, size and Discord's link, so a message that is only a picture is delivered and answered.
- **Bridges: a post on Discord can ping a person or a bot.** A written `<@id>` in a reply now pings; `@everyone`, `@here` and roles still do not. Before this nothing in a reply pinged.

- **Bridges: a stranger's message is not delivered.** A Discord or Slack message from a person is taken only when the account is linked to a member who is in the household now, or the answering agent's owner has given the account a tier (a `bodyPolicy` card). Anybody else is dropped with the reason `Unknown sender`, in a shared place and in a direct message, and keeps no words. Before this an unlinked person was delivered as a guest. An `only` filter still does not drop a direct message from someone known.
- **Bridges: a bot wakes an agent only by writing its mention.** In a channel whose rule has `botsMayTalk` on, a bot's or webhook's message is delivered when it mentions the agent's bot in writing, whether or not the bot is an agent of this household (one that is not is recorded as from nobody). Without a written mention a bot's post wakes nobody, including the channel's own agent. Before this a household bot woke the channel's agent with any post, and no other bot could wake an agent at all.

- **Container bodies can be given directories of the machine, and an engine other than runc.** Three new keys in the `loom-worker` configuration (`docs/runtime/worker.md`, "Container bodies"). `container.runtime` names the runtime the engine is asked for: `runc` as before, or `crun`. `accountLogins`, keyed by account id and then harness, mounts that account's sign-in directory read-write into its own jobs' containers and no others; once it is present, a job whose account and harness have no entry is refused before its build, with exit code 27. `container.mounts` gives every body fixed mounts, read-only unless one says `"readOnly": false`. The worker checks these paths when it starts and stops with the new exit code 52 if one cannot be used: a directory that is missing, a symbolic link, another user's or not written as its real absolute path, or two that overlap each other, an engine socket, the worker's state directory or its token file; nor may a mount's place in the container cover `/var/run/docker.sock` or `/run/docker.sock`. A job allowed nested containers holds the engine and can reach every sign-in directory through it (`docs/accepted-tradeoffs.md`).
- **`container.socket` and `container.nestedSocket` must be live sockets when the worker starts.** Each must be a plainly written absolute path to an existing Unix socket (through a symbolic link is fine, as with `/var/run/docker.sock`), or the worker stops with exit code 52. The line it stops with ends with the configuration key at fault, for example `(container.mounts[1].source)`, never a path. Before, a `nestedSocket` that was missing failed each nested job as it came (exit code 23), a `socket` that was missing stopped the worker when it first asked the engine (exit code 46), and a relative path for either was exit code 41.

- **One worker for an engine and for a sign-in directory, held by the worker.** Before it takes any work a worker with container bodies holds its engine (the real path of `container.socket`) and every `accountLogins` directory to itself; a second worker that names one of them stops with the new exit code 57 and the key in use. A worker that was killed blocks nobody. Two engines on one computer, each with its own socket and sign-in directories, are two machines (`docs/runtime/worker.md`, "One worker for an engine").
- **House images from before the core house are removed.** After its first build, a worker of this version removes every image named `localhost/loom-house-<hex>:<commit>` (the earlier naming), except one a container still runs in, which goes in a later upkeep.
- **A body in a house is told what its house was built from.** The worker sets `LOOM_HOUSE_REPOSITORY`, `LOOM_HOUSE_BRANCH` and `LOOM_HOUSE_COMMIT` on every body's container: the address as fetched (never with a credential), the job's branch, and the full commit id the image was built from, read from the image's name. An image's own `ENV` of those names is overridden.
- **loom provides a core house, and a worker builds it itself** (`docs/runtime/worker.md`, "The core house"). The definition ships in the package (`house/core`: a current Debian, basic tools, Node 24.18.1, Claude Code 2.1.326 and Codex 0.164.0 pinned, the layout, both labels); no image is published. A worker builds it through its engine the first time a house needs it, names it `localhost/loom-core:<digest>-<year>w<week>`, and builds it again when the definition changes and once in each new week. Every house build is given the core's image as the build argument `LOOM_CORE` (`ARG LOOM_CORE` then `FROM ${LOOM_CORE}`), and a house image's name now ends with the core's tag, so **every house image is built again once after this deploy and once a week**. The core's build falls under the same `buildTimeoutMs`, exit codes (22, 32) and reporting as a house's. Core images are kept while a kept house image was built on them and removed otherwise. A worker whose install has no `house/core/Housefile` stops with the new exit code 56. A Housefile that does not start from the core still works when its image meets the contract by itself.
- **An agent needs no Housefile.** `houseFile` in an agent's run settings may be empty: the agent runs in the core house with its repository copied to `/home/agent/repo`. A proposed change says so on its card ("in the core house with no Housefile of its own"). The worker writes that build in two parts, the commit's files in `repository/` and a three-line Housefile beside them, so the repository's own `.dockerignore` leaves nothing out and nothing has to be removed from the image. A Housefile path in run settings is now held to the worker's own rule (no part that is empty, `.` or `..`).
- **`accountSlots` can be given for each harness, and Codex defaults to 1.** `"accountSlots": 4` still sets every harness; `{"codex": 2}` sets one. Left out, a harness has 4 and `codex` has 1: Claude Code's renewal takes a lock in the sign-in directory (read in 2.1.326), and what Codex does when two bodies renew at once is not established (`docs/accepted-tradeoffs.md`). **Changed:** the limit is now for an account and a harness together, since each has its own sign-in directory; bodies of two harnesses on one account no longer wait for each other. Any worker that ran several Codex bodies on one account now runs them one after the other until its configuration says otherwise.
- **Breaking, for a worker with `container`: one layout inside every house** (`docs/runtime/worker.md`, "The layout of every house"). The home is `/home/agent`, the agent's repository `/home/agent/repo` (a body starts there, whatever the image's `WORKDIR`), node `/usr/local/bin/node`, a harness's body file `/etc/loom/body/<harness>.json`, and an account's sign-in directory is mounted at `/run/loom/login/<harness>`. The worker sets `HOME` itself. Three things change for a machine and a house. An `accountLogins` entry is `{"source": …}` only: one that still has a `target` stops the worker with exit code 53 and the key. A `container.mounts` target is a path under the home (`.local/state/x`, not `/home/art/.local/state/x`): an absolute one, or one that is or holds `repo`, stops the worker with 52. The image contract is version `2` with two labels, `loom.house="2"` and `loom.house.harnesses="claude codex"`; `loom.house.node` and `loom.house.body.<harness>` are gone, and an image that says `1` fails its job with exit code 30.
- **A `loom-worker` runs several jobs side by side.** `slots` in its configuration says how many, from 1 to 16; left out, it is 4 for a worker with container bodies (it was 1) and 1 for a worker whose bodies are processes (unchanged). A house being built no longer holds other agents' jobs. At most `accountSlots` bodies run on one account at once (4 by default, never more than `slots`; 1 runs them one after the other), and two jobs never publish one port: a job beyond that waits, reported as starting, until a body has ended. A process worker runs one build command at a time. loom itself is unchanged (`docs/runtime/worker.md`, "Several jobs at once").
- **One `loom-worker` with container bodies runs any agent's house, with nothing set up on the machine for that agent** (`docs/runtime/worker.md`, "Container bodies"). The worker fetches the job's house repository itself (`https` only, with the machine's `git` 2.32 or later, which it now needs: exit code 54 without it), writes the commit's files into a build context itself (no attribute, substitution or conversion applies; submodules are left out; 100 MiB a file and 1 GiB in all), builds the Housefile through its engine into `localhost/loom-house-<house>:<commit>`, and finds that image again for the next job. A house's repository secret is used for that fetch and nothing else. Every body runs the worker's own body program, mounted read-only at `/opt/loom`, so no image carries a copy of loom and a loom deploy rebuilds nothing; the worker's packages must therefore be in its own `node_modules`, as `npm install -g` puts them, or it stops with exit code 55. The image says how a body starts in it with labels (`loom.house`, `loom.house.node`, `loom.house.body.<harness>`), its `WORKDIR` and its `ENV`; one that does not, or that declares a `VOLUME`, fails that job with the new exit code 30 and the label or rule it breaks. `container.mounts` is now keyed by agent id, and a body gets only its own agent's.
- **Breaking, for a worker with `container`: `build`, `runners` and `accountRunners` are gone, and `container.mounts` as one list.** A configuration that still has one stops the worker with the new exit code 53, on a line that ends with the key: `(build)`, `(runners)`, `(accountRunners)` or `(container.mounts)`. Remove the first three; write the mounts as `{"<agent id>": [ … ]}`. The house's repository must be an `https` address and its Housefile must build from the repository and public registries alone, with the labels above. A worker without `container` is unchanged and still needs `build` and `runners`.
- **A long build no longer loses the job.** The worker reports a job as starting for as long as its house is fetched and built. `buildTimeoutMs` for a house defaults to 30 minutes (60 at most); a job still waiting then fails with the new exit code 32, "the build ran out of time". For every worker: a heartbeat loom did not answer is sent again at the next interval, and the job is given up only when no report has been answered for the length of loom's silence interval. Before, one unanswered heartbeat ended the job, which loom then recorded as lost.
- **A worker bounds what it leaves on the disk.** After a build it keeps the two newest images of each house and ten in all (and, beyond those, any a job still holds), keeps eight repository mirrors, and asks the engine to remove unnamed images older than a day and build cache unused for a week (every unnamed image on that engine: `docs/accepted-tradeoffs.md`).
- **Container bodies can be given directories of the machine, and an engine other than runc.** Three new keys in the `loom-worker` configuration (`docs/runtime/worker.md`, "Container bodies"). `container.runtime` names the runtime the engine is asked for: `runc` as before, or `crun`. `accountLogins`, keyed by account id and then harness, mounts that account's sign-in directory read-write into its own jobs' containers and no others; once it is present, a job whose account and harness have no entry is refused before its build, with exit code 27. `container.mounts`, keyed by agent id, gives that agent's bodies fixed mounts, read-only unless one says `"readOnly": false`. The worker checks these paths when it starts and stops with the new exit code 52 if one cannot be used: a directory that is missing, a symbolic link, another user's or not written as its real absolute path, or two that overlap each other, an engine socket, the worker's state directory or its token file; nor may a mount's place in the container cover `/var/run/docker.sock` or `/run/docker.sock`. A job allowed nested containers holds the engine and can reach every sign-in directory through it (`docs/accepted-tradeoffs.md`).
- **`container.socket` and `container.nestedSocket` must be live sockets when the worker starts.** Each must be a plainly written absolute path to an existing Unix socket (through a symbolic link is fine, as with `/var/run/docker.sock`), or the worker stops with exit code 52. The line it stops with ends with the configuration key at fault, for example `(container.mounts.art[1].source)`, never a path. Before, a `nestedSocket` that was missing failed each nested job as it came (exit code 23), a `socket` that was missing stopped the worker when it first asked the engine (exit code 46), and a relative path for either was exit code 41.
- **An agent's own credential can ask what a standing rule says, and file and spend a card.** `approvals.rule`, `.request`, `.use`, `.report` and `.withdraw` take the agent's terminal credential as well as a body's. Work the agent does on its own account (a terminal session, a lane for no member) now has a principal: it reads the household's own rules while a current household owner has the agent, where it used to always ask. Work for a member who is not a household owner still reads only rules that name them, and a room or a household change with no member behind it still always asks. A merge target in a repository loom does not read is answered, filed, allowed and spent on its own words (one exact commit); one in a repository loom reads is held to the agent's open change as before.
- **An agent can raise a notice for the people who have it.** `notices.raise {key, title, detail?, quiet?}` files one waiting notice per agent and key in each of those people's Inboxes and pushes to their devices; raising it again updates it, tells nobody twice and tells anyone who has gained the agent since; at most 50 keys wait per agent; a notice raised `quiet`, or raised again within ten minutes of being settled, is never pushed; `notices.clear {key, why}` resolves it. Who has the agent is read on every raise. Only the agent's own credential, for itself (`docs/specs/owners.md`).
- **Container bodies can be given directories of the machine, and an engine other than runc.** Three new keys in the `loom-worker` configuration (`docs/runtime/worker.md`, "Container bodies"). `container.runtime` names the runtime the engine is asked for: `runc` as before, or `crun`. `accountLogins`, keyed by account id and then harness, mounts that account's sign-in directory read-write into its own jobs' containers and no others; once it is present, a job whose account and harness have no entry is refused before its build, with exit code 27. `container.mounts` gives every body fixed mounts, read-only unless one says `"readOnly": false`. The worker checks these paths when it starts and stops with the new exit code 52 if one cannot be used: a directory that is missing, a symbolic link, another user's or not written as its real absolute path, or two that overlap each other, an engine socket, the worker's state directory or its token file; nor may a mount's place in the container cover `/var/run/docker.sock` or `/run/docker.sock`. A job allowed nested containers holds the engine and can reach every sign-in directory through it (`docs/accepted-tradeoffs.md`).
- **`container.socket` and `container.nestedSocket` must be live sockets when the worker starts.** Each must be a plainly written absolute path to an existing Unix socket (through a symbolic link is fine, as with `/var/run/docker.sock`), or the worker stops with exit code 52. The line it stops with ends with the configuration key at fault, for example `(container.mounts[1].source)`, never a path. Before, a `nestedSocket` that was missing failed each nested job as it came (exit code 23), a `socket` that was missing stopped the worker when it first asked the engine (exit code 46), and a relative path for either was exit code 41.

- **A body has the named tools a terminal session has.** `remember`, `recall`, `note_read`, `task_claim`, `propose` and the rest (36 in all, from the one definition in `src/shared-mcp-named.ts`) are now served to every body beside `request_secret`, `use_secret`, `loom_commands`, `loom_command` and `loom_query`. In a body each is the body's own `loom_command` or `loom_query` under a plain name: the same credential, the same doors, the same refusals, and nothing those two could not already do (`docs/runtime/terminal.md`, "The same tools in a body"). Nothing is added to the words a body starts with; the tools' definitions add about 19 KB to the harness's tool list. In a body `identity` does not repeat the creed, preferences and Top of Mind the body was handed at its start unless one is asked for by name.
- **Changed: a body's tools server is named `loom`, not `loom_secrets`.** In Claude Code a body's tools are now `mcp__loom__<name>` (`mcp__loom__use_secret`, `mcp__loom__loom_command`), the names a terminal session sees when its server is registered as `loom`. An agent's denied tool patterns written with the old name keep working: each tool such an entry covers is also denied by its new name. A room that is denied `loom_command` or `loom_query` is denied every named tool as well. A stored denial pattern is now read in one place (`denialEntries`) as the entries it holds, parted by commas and white space outside brackets, and a harness is handed one entry to an argument. Instructions that name a tool by its old full name need the new one. A body is served at most 64 tools (it was 34).
- **Schema step 10.** `projects` gains `retired_at`, empty on every project there is. The step adds the one column and touches no row.
- **A project can be retired, and revived.** Two household changes, `projectRetire` and `projectRevive`, set a project aside whole and bring it back. A retired project keeps everything, read by exactly who could read it before. Its unfinished tasks are shelved: not ready, in no list or count of open work, and none can be claimed (one already held keeps who holds it), and a question waiting on one stops asking for attention. Nothing is written on a task, so reviving restores each one as it was. No task is created in or moved into a retired project; one may be moved out, and a retired project may be merged into another. The task query has `isShelved`, which `loom-taskstore list` and `show` print; the app shows a shelved task under its project, marked (`docs/specs/projects.md`).
- **Tasks can be moved between projects, and two projects merged.** `tasks.command` takes `moveToProject` with `ids` and `project`: up to 500 tasks go to another project, or with `null` to none, all of them or none. The mover must be able to act on each task and be someone who could have filed it in the destination; only a task's owner or a household owner takes it out of every project. Each moved task gets a comment saying from where to where, and mail filed under the task's own labels goes with it. `move` still means only a task's place in the hand-kept order. A new household change, `projectMerge`, files every record of one project under another, adds its members and agents, moves its repositories and marks it removed. It cannot be undone, so its card is a dangerous one: an owner must allow and confirm it by hand, and no standing approval rule answers it. Terminal sessions have `task_move_to_project`, and `propose` takes `projectMerge`; `loom-taskstore command` prints the tasks a move moved. Splitting a project is making the new project and moving tasks into it (`docs/specs/owners.md`). No schema change.
- **Changing a task's project in an edit is now that same move.** An `edit` that names another project (the Tasks form, `task_edit`) leaves the comment and takes the task's mail with it, by the same rule. It used to leave no record, and left an answer about the task readable under the old project. A removed project is refused.
- **A question about a task stays with someone who can read the task.** `ask` already refused a person who cannot read the task. Moving a task (`moveToProject`, or an `edit` that names another project) is now refused while it carries an unanswered question for someone who could not read it where it is going; the refusal says to have it answered or put to someone who can first. One rule, `mayBeAskedAbout` in `src/policy.ts`, decides both.
- **An agent can ask to be let onto a project.** `propose` with `projectJoin` and `{project, agent}` files a card saying who wants onto which project and why; an agent asks only for itself, a household owner for any agent. Allowing it adds that one agent and changes nothing else about the project, no standing approval rule answers the card, and the answer reaches the agent in the conversation it asked from (`docs/specs/projects.md`).
- **Schema step 8.** A Slack file shared in a second message is listed under that message too and kept once (`bridge_file_messages`); a private direct message's files now expire with its words. The step also removes the old `runtime.signInCode` receipts, which used to be deleted at every start.
- **An older household database is checked as it is before it is upgraded.** Startup compares it with the shipped shape of its own schema number (`src/core/data/shipped-shapes/`, now packaged) before running any step, so a table changed by hand is refused untouched even when a later step would rebuild it.
- **`loom-worker` says why it stopped.** Each stage has its own line and exit code (40 to 50; `docs/runtime/worker.md`) in place of the one line and exit code 1.
- **A job that exits 0 without settling any of its own mail is retried at most three times.** It used to be admitted again as a new job with no limit.

- **Schema step 7.** Ending a browser (logout, a revoke in Setup, removing its passkey) now also ends every browser its sign-in links signed in, and theirs in turn, with any link it made that nobody used. A sign-in link keeps who made it and whether it is for an automated browser in its own row, so it is the same link after the program starts again. A long reply to Discord or Slack records each part as the platform confirms it: a reply that stopped part way goes on from there as the one reply it was, after a restart too, and a thread opened under any part of it addresses the bot. A job says in its own column (`ended_note`) when loom itself ended it as lost or never taken by a machine, and a Stop pressed in the conversation is recorded as `stop` instead of `write-off`. The `waiting` job state, which nothing ever set, is gone, and so are the unused `signin_challenges` table and `bridge_sends.posted_id`. Upgrading drops unused sign-in links (they last five minutes).
- **A body's reach is decided where its token is read.** A body working for a member is narrowed to that member by the credential itself, so every door sees it that way; the memory commands (`remember`, `forget` and the rest) now refuse a body whose member no longer has the agent, as the memory reads already did. A question in the Inbox is shown only to someone who may read the task, approval or secret request it waits on, by the inbox rule itself. A tier is looked up only under the outside account a message came from.

- **A sign-in link made in a browser carries that browser's proof, not a new one.** The browser such a link signs in is proved when the first one was and ends when the first one would, so passing a cookie along by links no longer renews the ten fresh minutes or the thirty days. The link works only while the browser that made it is still signed in. `loom signin --agent` makes a link for an automated browser: it gets a session of hours and can make no links or passkeys, whatever User-Agent it sends. The operator socket refuses a `ttl` longer than a link lasts (300 seconds) instead of silently shortening it.
- **Passkeys that keep no counter can sign in.** A synced passkey reports a signature counter of 0 every time; sign-in refused it after enrolment. A counter that goes back or stands still is still refused. Passkey sign-in records the browser by name like a link sign-in does. Asking for sign-in challenges in bulk no longer shuts passkey sign-in or enrolment out for five minutes.
- **One rule for browser origins.** The data door, the operation doors, the sign-in routes and the live socket ask the same function. A request that came to the public host is taken only from the public origin, on every door.
- **Revoking a machine's token ends the bodies it started.** A job body's token is current only while the machine token that enrolled it is.

- **A pasted sign-in code is handed over once, and loom enforces it.** The worker takes the code with a write, `runtime.signInTake`, which blanks it in the database and keeps it in memory for that take alone; `runtime.signInCode` now needs the take's id and gives the code to nobody else. A worker that lost a reply asks again under the same id. If loom restarts after the take, the sign-in fails and is asked for again. `runtime.signInDone` now stores loom's own sentence for a reason word and drops any other text; the worker sends words, including its own (`no-page`, `no-program`, `cannot-run`, `ended`, `timed-out`, `stopped`). A worker older than this change cannot relay a sign-in until it is updated.

- **Remove the older copies that sat beside the running program.** The file-based household and its `tokens.json` store (`src/household.ts`), the row-envelope household, token and sharing stores (`src/core/household`), both older browser-session stores, the older secrets implementation with its own tables and mutual-TLS holder socket, the composition nothing started (`createFoundation`, `httpDoor`, the `Signin` class) and its database opener, export and socket server are gone, with their tests: about 10,500 lines. Nothing `loom serve`, the worker, the body or the clients ran is removed. Test fixtures are no longer compiled into `dist`. The slug pattern, the Comms retention default and the door's request limit are each stated once. The `'mcp'` door, which no call ever arrived on, is gone from the dispatcher.

- **Ask for a sign-in link; startup no longer prints one.** `loom serve` used to print a live owner link at every start, which under a service manager put it in the log, and left an owner token row behind each time. Start now prints only how to ask. `loom signin --home <dir> [--member <id>]` asks the running program over its operator socket and prints a link, good once for five minutes, to the terminal of the OS user who owns the home. All of one member's local sign-ins ride on one token row, `Local sign-in: <member>`; revoking it in Setup ends the browsers and passkeys that came in that way. Scripts that read the link from startup's output must call `loom signin` instead.

- **A sign-in program says why it failed in one word.** The program a worker runs for `runtime.accountSignIn` writes a reason word in its `why` file: `refused`, `wrong-code`, `expired`, `unreachable` or `not-installed`. Loom shows its own sentence for the word and no longer forwards the program's text, which could repeat a code or a token. A program that still writes a sentence gets the plain "The provider's program says the account is not signed in" until it writes a word. A request that ran out of its 20 minutes is now closed by the program's own sweep, so a pasted code is blanked even when no worker polls. See `docs/runtime/accounts.md`.

- **Four things a scheduled lane needs.** Checking a knowledge page no longer changes its words: `mind.knowledgeVerify` and `mind.knowledgeRecheck` used to add a fixed line to the page every time, which grew the page, moved its `updated` date and used up its ten kept versions. They now take `{slug, note?, freshnessAnchor?}`; only a `note` is added to the page, as a dated section, and without one the check is recorded and the page left alone. A page's freshness anchor (the version or date it holds true as of) and its SLA class can be read as `freshness_anchor` and `sla_class` on `memoryKnowledge`, `memoryKnowledgePage` and `memoryKnowledgeSearch`, and `mind.knowledgeAdd` takes `freshnessAnchor` for a new page, which also sets its class. `memory.remember` takes `sourcing` (`observed`, `relayed`, `inferred` or `system`) and `provenance`; `memory.propose` does not, since a draft has nowhere to keep them. `memoryList(agent, category, project, first)` on GraphQL lists an agent's live memories newest first (50 by default, 500 at most) with the same IDs `memory.forget` accepts, to anyone who may see that agent's memory; it leaves out archived and expired memories and adds no recall heat. The `knowledge_check` tool takes the same optional `note` and `freshnessAnchor`.

- **A failed body says where it failed.** A body's diagnostics stay private, so a failed job used to record exit code 1 and nothing else. The body now exits with a code for the stage it reached: 1 input it could not accept, 11 startup secrets, 12 taking its mail, 13 loading identity, 14 the harness itself, 15 recording the reply. The job's `exit_code` already keeps it. No words leave the body.

- **Sign a model account in from anywhere.** `runtime.accountSignIn {account, box}` asks the worker on that machine to run the provider's own sign-in, with nobody at its terminal and no model running. The page to open arrives in the account owner's inbox; where the provider shows a code, the owner answers the item with it, and where it is a device flow the item shows the code to enter and clears by itself. Loom records the account as signed in on that machine only when the worker reports that the provider's own program says so. An owner can ask, and so can an agent on behalf of a member who owns it, so it can be done from an MCP conversation. `runtime.accountSignInStatus {id}` says how far it has got. The worker takes these when its config has `accountSignIn.programs` (one program per provider; the Art repo's `loom-signin` is one). No credential passes through loom; a pasted code is handed to the worker once and then blanked. A request nobody finishes ends after 20 minutes. Schema number 5 adds `account_signins`.

- **A lane says what kind of model it wants.** A model entry in the machine's catalogue can carry a `tag`, the operator's word for what kind of model it is within its family (for example `best`, `normal`, `low`). A trigger gains `wantsModel`: a tag, or one model's name. Work started by that trigger runs only on the agent's allowed models that match, in the agent's order, on whichever family's account has room; if none has room it waits. It is read when the job is placed, so editing the lane takes effect at once, and edits are in the trigger's history. Empty means the agent's own order, as before. An existing household database gains the column at start (schema number 4).

- **Gemini bodies.** A body can run on Gemini through the Antigravity CLI (`agy`), the third harness in `src/runtime/body-harnesses.ts`. agy reads its tool servers only from a file in its workspace, so each body gets a private temporary workspace holding that file, with the machine's body directory added to it; the workspace, and what agy saved for the conversation, are removed when the body ends. Like Codex it runs only where the machine gives bodies full reach, and not for a body with denied tools.

- **Codex bodies.** A body can now run on Codex as well as Claude. The body program picks the harness by the name a model's role gives it, from one list (`src/runtime/body-harnesses.ts`); adding another harness is one file and one line there. Codex runs isolated from the machine's own Codex settings, with loom's tools and the same identity and mail as a Claude body. Two limits, both because Codex always has its shell: it only runs where the machine gives bodies full reach, and not for a body with denied tools. Its replies carry the model the job asked for, since Codex does not name the one that answered.

- **A body is told how to work where it was started.** With its identity, a body now gets the agent's authored page for the venue of its conversation: `roles/<venue>.md` beside the creed. A body started by a trigger is on the `wake` venue, so `roles/wake.md` is what every lane is told, in one place, instead of a preamble and coda pasted around each lane's instructions.

- **Turn one trigger off and on, and edit it.** `tempo.start` turns a stopped trigger back on; its next time is worked out from now, so nothing it missed fires. `tempo.edit` changes a trigger's words, file, times, days or label. Each edit is recorded in the new `trigger_edits` table with who made it and what the changed parts said before. Whoever could set the trigger may edit it; a project member who can stop a shared trigger cannot rewrite it. A trigger's words are now limited to 100,000 characters. An existing household database gains the table at start (schema number 3).

- **A secret write no longer drops every bridge connection.** Only the connections that use the secret that changed are restarted.

- **Remove and restore.** `household.propose` takes `remove` and `restore` for a member, agent, project or bridge connection. Nothing is deleted: the row gets `removed_at` and its history stays. A removed person or agent is no longer recognised as a caller, a removed agent does not run, a removed connection is switched off. An existing household database gains the four columns at its next start (schema number 2).

- **Standing rules answer every kind of card.** Rules of kind `setting` and `dangerous` were stored but never consulted. A `household.propose` card is now answered by a matching rule when a known person is behind it and the last answer to the same thing was not a deny. A card that changes a rule always asks, and a rule that answers dangerous cards is itself a dangerous card to set. `household.propose` returns the card's `state`.

- **A member's token can talk and answer.** `comms.open`, `comms.send`, `comms.change`, `inbox.answer`, `inbox.read` and `inbox.dismissResult` no longer need a signed-in browser window; a member's own token is enough. A current member can also read the command list.

- **Recall is a read.** `memory.recall` needs no operation id, reserves nothing and stores no receipt. It still warms what it finds. Asking twice recalls twice.

- **Two more things to propose.** `household.propose` takes `order` (the order people or agents are listed in) and `secretDescription` (what a secret is for, without touching its value). `mind.knowledgeEdit` can add a source.

- **How an agent runs can be read.** `boxAgents`, `boxFacts`, `agentRunSettings`, `agentBoxes`, `agentHousePorts`, `agentHouseSecrets` (names only), `agentPeople` and `agentDeniedTools` are readable. Run settings follow the agent's visibility; a machine's lists follow the machine's; an agent sees only its own "may run there" rows.

- **No direct settings commands remain.** Removed `household.setMember`, `household.setAgent`, `household.setProject`, `household.setSettings`, `household.setAgentAccounts` and `approvals.setRule`. `secrets.command` keeps only the answers to a request (answer, cancel, revoke) and `bridges.command` keeps only the review of a held reply. Every one of these changes is now a `household.propose` card a household owner allows. `loom-household` is read-only.

- **One way to propose a change.** `household.propose` gains `secretRule`, `secretDefault`, `houseSecrets`, `bridge`, `tempoTimings` and `measuring`. Removed the seven older proposal commands, which only a body running a job could call: `runtime.proposeBoxSettings`, `runtime.proposeAgentRunSettings`, `runtime.proposeAgentModels`, `secrets.proposeSettings`, `bridges.proposeSettings`, `tempo.proposeSettings` and `measuring.propose`.

- **Machine and agent settings are proposed, not commanded.** Removed `runtime.boxSettingsSet`, `runtime.agentRunSettingsSet`, `runtime.agentModelsSet`, `runtime.agentBodyPolicySet` and `runtime.boxRevoke`. `household.propose` gains `boxSettings`, `runSettings`, `models` and `agentAccounts`, so each of these is a card a household owner allows. Installed code uses `services.setup`.

- Operations can declare `refuses`, so a service's own refusal reaches the caller as `invalid` with its words instead of `unavailable`.

- **Remove the older program.** The stdio memory server, its command line (`loom wake`, `recall`, `remember`, `memory`, `knowledge`, `migrate`, `bootstrap`, `inject`, `install`, `doctor` and the rest), its server-rendered pages, the installable pieces and their client binaries, the MCP-app widgets and the old-home migration tools are gone: about 139,000 lines. `loom serve` now always runs the household program and `loom mcp` proxies its door; `--next` is accepted and ignored. Removed binaries: `loom-secret-holder`, `loom-secrets-client`, `loom-bridges`, `loom-changes`, `loom-approvals-client`, `loom-secret-worker`.

- The MCP door gains twenty named tools: `memory_propose`, `memory_drafts`, `memory_ratify`, `memory_archive`, `memory_restore`, `memory_history`, `knowledge_read`, `knowledge_edit`, `knowledge_check`, `knowledge_restore`, `task_ready`, `task`, `task_create`, `task_edit`, `task_claim`, `task_close`, `task_comment`, `propose`, `approvals` and `inbox`.

- Allowing a dangerous approval card now needs `confirm: true` on `approvals.answer`. `household.propose` can also file two more dangerous actions: revoking a machine and signing out a browser.

- Remove the older listener's Measuring wiring (`/api/measuring/*` adapter and its meter). Measuring lives in the rebuilt program only.

- Add the `jobHistory` read (an agent's jobs, ended ones included) and `runtime.jobStop` (a household owner or the agent's owner ends a job by hand, as a reset or a write-off).

- The MCP door gains four named tools: `person`, `person_write`, `project` and `project_write`, for an agent's own person and project cards.

- `tasks.command` gains `move` (place a task before another in the hand-kept order, or last) and `create` accepts the spec line a task implements.

- Add the `bridges.file` read: list the Slack attachments a message carried, or return one, for the connection's agent and household owners.

- `secrets.command` gains the `house` action: an owner sets the secret that fetches an agent's house repository and the aliased secrets the house is handed at start.

- Add the `tempoTimings` read: a person's or an agent's own Tempo timings, with the defaults until one is changed.

- Add `household.propose`: an agent, with or without a job, files an approval card for a project, member, agent description, household settings, standing approval rule, or outside-people and denied-tools change. It also files one dangerous action the same way: revoking a token, named by its label. A household owner allows it through Approvals and loom then makes the change.

- Add `household.setSettings` and a `settings` field on `householdSetup`: an owner can change and read the default agent, time zone, keep time, GitHub owner and backup settings.

- Add `mind.knowledgeEdit` and `mind.knowledgeRestore`: change a Knowledge page's body or bring back one of its kept versions. Either saves the displaced body first.

- Remove `measuring.answer`. A Measuring settings card is answered through `approvals.answer`, like every other settings change.

- The approved site gains a Tools for agents page, describes notes, the further identity pages, memory time to live and confirm/contradict, and task unclaim and reopen.

- Add own-body Memory editing, retained-revision reads, and revision restoration through the canonical command and query doors.

- Add current-owner household membership and agent appearance commands on the shared data connection.

- Browser sign-in confirmation forms retain their origin check while keeping the link code out of referrers.

- Add a shared-data server composition for authenticated queries, Tasks, member appearance and sign-in on one initialized database.

- CI: test shards 1 and 2 run on loom's own runners and 3 and 4 on GitHub's when the runner switch is on; CodeQL runs nightly and on request instead of on every pull request and push.

- Docs: the how-it-works site is published to GitHub Pages from `docs/how-it-works/site` on every merge to main.

- Docs: `docs/how-it-works/` is the approved description of the finished product and the goal of the web rebuild; `docs/specs/web-foundation.md` is superseded where it differs.

- Comms preview resolves private conversation references to current thread cards for their original member, with live state and fixed reader links.

- Next Comms renders authorized reference chips in retained sealed questions, with live privacy fences and owning app navigation.
- Clock owners can recover plain disabled imported schedules through a fresh complete prompt and timing submission; archived authority and uncertain occurrences stay inert.

- Clock offers owners a blank, confirmed recovery form for eligible disabled imported schedules, with live availability and fresh work only.

- Reconcile Clock documentation with merged prompt/file execution, provenance, control and recovery work; retain explicit gaps before cutover.

- Clock owner vouch records fresh owner authorship so eligible imported prompts can reach the native worker after current authority checks.

- Clock native workers can opt into a bounded idle wait and resume later prompts in the same worker lifetime after fresh owning checks.
- Clock native resume chains retain their first admission deadline across joined turns; neither server nor worker renews retained history on resume.
- Next Comms: Tasks and Changes resolve reverse From links through Comms for the original viewer, with private labels hidden from other owners and on disconnect.

- Clock native workers can resolve standalone scheduled files in their own checkout, with exact source checks and native-only acknowledgement.
- Next Inbox delivers public Clock answers to the original active body, retaining verbatim member words and staging holds.
- Inbox explains supported conversation delivery, refused drafts and acknowledgements without claiming that a saved answer was read.
- Next Inbox can continue confirmed terminal public Clock work in a fresh owned job, preserving the original question and claim while staging the new body and answer words.
- Next Runtime records word-free incoming public Clock metadata atomically when its body accepts scheduled input or an Inbox answer, retaining the saved sender and project across retries.

- Next Comms keeps a bounded word-free reference index with message writes and preserves expired references during fixture imports.
- Next Comms backfills retained message references once on startup, with ownership and retention fences and safe retry after interruption.
- Next Comms renders authorized task/GitHub chips with live cards, keyboard controls and fixed owning reader navigation.
- Next Comms adds a window-only live backend for authorized task and GitHub chip cards; browser chips and other reference kinds remain unfinished.
- Next Comms lists authorized cited tasks and changes alongside made-here work, with safe GitHub destinations and unlinked note paths.
- Next Inbox retains member-private action success/error FYI for Tasks and central answers, with read marks and an Errors folder.

- Next Inbox retains fixed, member-private action receipts for the remaining registered app mutations; credential and private Comms actions remain excluded.
- File Approvals reported merge/host steps as scoped Inbox FYIs with stable event identities and an owning Reported steps view.

- Add an explicit external dedicated secret-command worker with authenticated Runtime stop/history checks and drained shutdown, reusing the Claude worker control owner.

- Read current sealed questions and send ephemeral private replies inline in next-mode Comms.
- Expose private persistent-holder worker route replacement with complete selection preflight and retirement of original claims and clients.

- Bind sealed typed Comms replies and retry receipts to the retained original encrypted question and owning route.
- Prune expired private Bridges attachments on next-mode startup and hourly, including staging and disconnected setups.
- Add native-age encryption and an actual encrypted restore drill for filtered next-database images; full household file coverage and backup execution remain pending.
- Add bounded, descriptor-pinned capture of allowlisted context documents and referenced note attachments for a future household bundle; full backup execution remains pending.
- Add explicit continuity database snapshots with captured-notes attachment pairing for the future household bundle; encrypted full restore and execution remain pending.

- Deliver sealed Comms yes/no decisions back to the owning private conversation through staged encrypted message delivery.
- Add a filtered next-database image exporter with an independent SQLite reconstruction drill; complete encrypted household backups and execution remain pending.

- Let a current private body ask an encrypted Comms question through its original member binding, with authority rechecked after encryption and a wordless acknowledgement.
- Add pure worker-checkout preparation for scheduled file inputs, using bounded descriptor-pinned reads; executable Clock file delivery stays held pending owning runner integration.
- Refuse public Clock runner start input after withdrawal or a change to its original destination or claim during preparation.
- Add a dedicated one-turn native Clock worker for stored prompts, with exact-source admission, bounded remote revocation and one durable attempt per source; standalone files remain held.
- Add owner-only next-mode backup configuration operations and Live status; saved configuration explicitly remains unscheduled pending the new runner.

- Deliver private timed prompts through Runtime’s bound inbox, retaining member scope and current grants through runner confirmation, reads and acknowledgment.
- Exclude private dispatched Clock prompts and correlated Runtime/Sign-in copies from filtered exports and backups while preserving public records.

- Deliver stored public household lane prompts through Runtime’s scheduled inbox, with runner confirmation, authenticated reads and staging holds.
- Add next-mode Bridges status JSON for Discord and Slack with configured agents, intake holds and explicit staging mode.
- Archive orphan Comms delivery bindings without inventing an owner, and report their skipped conversation ids through offline Runtime imports.
- Next-mode routine notifications now use current member-scoped Inbox and Comms candidates, durable dedupe, staging and bounded daemon-owned delivery.

- Tests: give each test 20 s on CI instead of 5 s, after unrelated tests timed out on loaded shared runners and left main without a deployable build.
- New desk: make request and form ids without `crypto.randomUUID`, which browsers withhold on plain HTTP, so the desk works on a home network address.
- Resolve original private loom parent metadata for Comms through the joined Runtime job and exact owning thread.

- Classify already owned Runtime spawn threads in Comms through original member metadata, preserving independent transport and execution holds.


- New desk: group the launcher inventory and make Profile discoverable through the account shortcut and search. Keep passkeys and sign-out in Your account, removing the provisional corner toolbar that overlapped apps.
- New desk: Comms owns a live portrait and moves it once into the permanently shown companion rail; counted pixel talking beats follow through completion, with crisp whole-scale compact portraits.
- Preserve the original member supplied by trusted spawn conversation metadata and refuse conflicting parents or retry owners.

- Check Clock lane reuse against current Runtime destination metadata and deliver public prompts through owning conversations, with service dispatch, authenticated read acknowledgements and staging holds.
- Suppress agent-authored file self-rearms only with fresh Runtime control, exact original steering and matching scope/service; omit private suppression receipts from exports.
- File spawned private Comms threads through unique owning metadata while preserving Runtime transport handles and execution holds.

- Preserve private ordinary schedule scope and bind body schedule controls and cancellation, including command receipt replay, to fresh Runtime conversation proof and current policy.
- Resolve unique member-private Comms ownership as metadata and refuse ambiguous or deleted Runtime routes.

- Add an unregistered pinned metadata ticket authority channel for the separate Secrets holder; worker delivery and public get remain unavailable.
- Runtime: expose authenticated private conversation description, title and activity controls through the next API; keep imported and policy-held execution fenced.

- Add unregistered one-use Secrets handoff tickets with durable claims, exact grant/Runtime fences and staging holds; real worker delivery remains disabled.

- Bridges import accepts sparse per-agent channel flags, blocks unrepresentable differences with source field evidence, and identifies conflicting present entries.

- Add member-private Inbox read facts without answering asks or copying draft words.
- Inbox now separates self-cleared asks into searchable FYI history, keeping human answers in Answered.
- Inbox: group Clock operational alerts, acknowledge them without changing scheduled work, and open Clock through its internal route.
- Inbox: reply privately to conversation asks through encrypted Comms, keep private drafts in the window only, and link sealed questions and reply receipts to their owning thread.
- Inbox reads sealed private questions and their retained history through scoped Comms records, with guarded encrypted replies.

- Reconcile public Attention waits without an open member page, using explicit public Tasks/Approvals read grants and the daemon clock.
- File pending Approvals in the new Inbox with exact source scope and owning decisions; keep private card wording in Approvals.
- Clear private Comms working state from committed terminal Runtime jobs and recover missed completion notifications at startup.

- Put the visible Comms thread’s agent above Needs you in the new rail, with selected priority and a short move.

- Give the new desk device-local rail and dock hide modes, overlay edge reveals and agent keyboard shortcuts.

- Fold overflowing agent-rail cards into compact lines, retaining the agent with current work or a question and retrying full cards when room returns.

- Show live new-side piece counts and a Boxes enrollment glyph in the desk bar, with unavailable sources and unknown health stated explicitly.

- Keep ordinary one-off Clock work filed by authenticated private bodies member-private, with original steering evidence and acknowledgements that omit words.
- Clock schedules retain original steering across replacement and run-now; private schedule receipts keep their window check after removal.
- Capture original household lane steering through edits, reassignment and occurrences, keeping historical unknowns and internal evidence out of lane lists.
- Add a pinned metadata-only holder handoff channel with fresh destination checks, buffer erasure and drained shutdown; runner ticket admission and production activation remain separate.
- Add a trusted Runtime destination metadata binding for future Secrets tickets, with fresh job, runner, box and claim checks.
- Bind authenticated HOUSE request/status metadata in the typed Secrets client, with exact-job assertions, stable retries and value-free JSON acknowledgements.
- Add worker-local Claude turns with exact tool denies and original-binding native history isolation; daemon policy execution remains held.

- Reserve one-off Clock capacity: at most forty API-created wakes per agent and twenty per proven conversation, with unbound bodies sharing one bucket.
- Add an internal Runtime role for current authenticated Clock conversation provenance, retaining private scope and sender history.
- Match imported private spawn bindings to Comms by conversation ownership, preserving job and spawn handles independently of thread ids.

- Add an unregistered exact-place-permit Discord history transport with bounded oldest-first reads; Runtime authorization, sender policy and the public read command remain pending.
- Bridges migration skips underscore annotation keys in every legacy source map before validation/assembly and reports safe file/field diagnostics; household rehearsal includes real note shapes.
- Preserve authoritative shuttle and Runtime store documents and revisions as bounded offline Bridges import evidence; do not select or apply authority.
- Import Bridges setup from explicit completed snapshots with authoritative source resolution, disabled connections, private evidence and independent verification.
- Import local bridge setup from household snapshots without inventing off-machine connections or Slack credentials; retain incomplete Slack and unprojectable audiences as private evidence.

- Limit newly created agent API schedules to twenty per target agent, preserving owner schedules and existing-schedule replacements.
- Prepare required Runtime policy files on Linux workers with descriptor-pinned reads and resolved-content history keys; configured-policy execution remains held.

- Add an offline Bridges configuration source inventory prerequisite with explicit files, source checksums, bounded reads and no credential acquisition; database import and migration registration remain pending.
- Preserve deleted private Comms bindings only in the Runtime import archive, report their skipped ids, and validate spawned thread ownership.

- Add a daemon-owned Secrets receipt reconciliation job that recovers confirmed writes without caller plaintext, retaining locks on uncertain writes and rechecking current authority.
- Bind Secrets house request and status to current central body credentials and exact Runtime job/service scope.
- Compose explicit authenticated Secrets mutations, retained retry keys and automatic recovery in next startup, with per-write staging holds.
- Bridges: bind household DMs to real runtime jobs and central body credentials, with private durable transcripts, stable reply outbox receipts, staging and stop/revocation checks.
- Persist Runtime owner gates and policy with revision-bound edits and exact archived proposal adoption, refusing unreconciled source restrictions.

- Retain encrypted-holder age identities and receipt keys across explicit key rotation without rewriting values or retry receipts.

- Prepare Runtime body policy rules for trusted external delivery, with complete guest rosters, standing restrictions and effective session keys.

- Secrets: allow explicit daemon retry-key rotation while retaining all historical keys and preserving old write identities across restart and receipt expiry.

### Added

- Show live Inbox read indicators and retain member-scoped device reply drafts through navigation, reload and failed sends.
- File owner-assigned Tasks in the shared Inbox with their original project/agent audience and source-owned decisions.

- Clock links local-work requests to private chat; its browser proof now files through a real Runtime-bound body before owner review and scheduling.

- Clock’s owning local-request reader now reviews explicit timing and schedules saved private words with one-time or existing every-time authority; Runtime delivery remains held.

- Add an authenticated owner-window recovery operation for saved private Clock local requests, retaining their exact scope and durable retry acknowledgement. App scheduling controls and Runtime delivery remain unfinished.
- Next Runtime retries definitively unstarted nonconversation manual/spawn jobs at most three times, retaining original intent, deadlines and current-policy checks across restarts.

- Import explicit Runtime snapshots with complete private source retention, scoped metadata, held old work and independent migration verification.
- Exclude source-owned Runtime repository mirrors under a named cache rule while retaining durable delivery and house working data.

### Fixed

- Stream offline migration files and Runtime archives in bounded chunks, including independent physical-byte verification of files larger than 600 MiB.

- Accept legacy Secrets timestamps at arbitrary fractional precision during offline import, retain validated audit text exactly, and report value-free source check names.
- Next Clock files local approval requests and recovers their exact saved words through authenticated Runtime body proof; `wake --approval` no longer requires retyping private words.

### Added

- Compose next Bridges from the explicit secret holder with scoped HTTP inspection/sends, policy-checked People labels and a durable engine that never receives raw credentials.
- Load the daemon Secrets retry key from an explicit private file and pin its identity before async value operations are registered; changed keys and unbound old journals fail closed.
- Next bridge credential lifetimes now follow asynchronous public holder generation, retiring both transports on rotation or holder failure without reading credential values.
- Persistent secret holder public generation for bridge credential lifetimes, atomically rotated with committed mutations and available through its authenticated read transport.

- Compose Discord Gateway intake with authenticated service credentials, durable receipts and staging-gated lifecycle in the opt-in next-mode bridge root.
### Added

- Add durable admission and retry reconciliation for explicitly composed async Secrets writes; normal Settings value edits remain disabled pending daemon key and reconciliation composition.

- Apply next-mode Runtime owner reset and silent-work write-off cards against durable original snapshots, with atomic body/session fencing and central credential revocation.

- Add a window-only encrypted Comms typed reply seam with atomic opaque Attention acknowledgement and first-answer retry fencing.
- Fit the Comms composer to its actual next-mode tile and fold Work when the reader is narrow. Exercise ordinary, filed and attached Comms delivery through real next-mode page sessions, Runner claims and bound-body replies in the two-window browser proof.
- Comms thread rows pin on a stationary touch or pen long press, without opening the thread; scrolling and cancelled holds leave it unchanged.
- Reduce first-page JavaScript while keeping app screens loaded on demand.

- Add keyboard-accessible Pin and Archive actions to Comms list rows, including right-click entry.

- Add a private Discord raw receipt drain with fresh metadata, bounded retries and durable normalized handoff; production activation remains pending.
- Show Stop only for active joined Comms threads, disabling it while disconnected or saving.
- Next mode retires per-agent piece/path grant approvals in favour of record scope and withdraws pending legacy grant imports.

- Add unregistered Discord service authentication and fresh channel, thread-parent and DM-recipient metadata reads for durable intake normalization.
- Show each Comms thread’s agent letter beside its title in the list.

- Add private Discord Gateway receipt/session storage with atomic checkpoints and credential-generation isolation; daemon registration remains pending.
- Show Comms thread activity times in CT and live working state in the thread list.
- Resolve next-mode Approvals callers from central authenticated body proof and current private Runtime/Comms membership, preserving service-house identity.

- Add an unregistered Discord Gateway transport with committed-sequence resume, service-scoped credentials, heartbeat recovery and awaited shutdown. Production receipt storage and daemon wiring remain required.
- Capture an explicit external Secrets source with `migrate snapshot --secrets`, using the same private inventory and confinement rules as other roots.
- Reconcile authoritative runner-fenced start failures into generation-matched private Comms notices, enabling member retry without automatically repeating an uncertain execution.

- Add explicit next-mode Slack lifecycle composition with service credentials, staged connection release, startup receipt recovery and awaited shutdown.

- Bridges: add a serialized Slack raw receipt normalizer with fresh metadata, bounded retries and commit-before-consume ordering.
- Connect next-mode private Comms messages to runtime jobs and authenticated body reads, replies and status, keeping private words out of runner inputs and retry receipts.

- Comms now shows work made in the thread, with live task/change statuses and links to their apps.

- Review local machine requests in Clock with the existing exact-word approval controls; private decisions use the owning signed-in window and start no work.

- Start conversations from Home with the shared Comms composer, retained drafts and recent/unread-thread navigation.

- Next desk: show loom's server minute/timezone and live connection/working-agent status glyphs on desktop; retain compact phone chrome.

- Restore the new desk's compact phone bar and centered ticker using live owned-agent status and Needs you counts.

- Keep long Home agent details scrollable within desktop cards, with a keyboard focus target and natural page scrolling on phones.

- Import registered agents’ pixel sheets with the household, serve them from the new database with current agent visibility, and honor Pixel faces on Home and the rail.

- Give next-mode Home desk-coloured cut cards and the member’s saved Depth, Contours or Wash ground.

- Give next Home and rail cards their agents’ database-backed colours and drawn faces, with expressions for reported work and asks.

- Keep a neighboring next-mode app's narrow reader from taking focus away from the chosen tile.

- Bridges: authenticate Slack workspace/bot/app evidence through service-scoped Web API calls for future receipt composition.
- Fold eligible private conversation metadata as the signed-in member while Home or Inbox is open, using the existing retention operation.
- Clock local requests from an authenticated owner conversation retain member-private approval, wake and standing scope; signed windows alone read the words, and exports omit private copies.
- Next runtime accepts stable body-start intents and connects Clock dispatch to runner-confirmed starts, preserving staging holds and uncertain outcomes.

- Bridges: add private, connection-bound Slack raw receipts that commit before Socket Mode ACK and retain restart deduplication.
- Add next-mode Household Setup for owner-managed members, agent ownership, project access, existing agent registration and GitHub attribution.

- Bridges: add unregistered Slack Socket Mode transport with durable-receiver-before-ACK ordering, fresh service credentials, reconnect and heartbeat bounds.
- Apply member appearance choices live in the next shell, with controls for look, reduced motion, contrast and zoom.

- Next-mode runtime releases claimed input once through the staging gate; HTTP supports asynchronous operations with authentication revalidation.
- Derive the private-app window capability from validated next-mode page sessions, while keeping bearer callers denied.
- Add an unregistered async holder mutation channel with trusted current-member authorization and durable-store acknowledgements.
- Add authenticated, value-free committed holder receipt lookup for uncertain write recovery; durable registry admission and metadata reconciliation remain required before enabling Settings values.
- Connect the persistent Secrets holder executable to authenticated current household authority over a dedicated private socket.

- Bridges: add service-credential Slack API inspection with fresh paginated membership and staging read gates.
- Add atomic offline Secrets metadata import, source-owned pending asks, migration-all discovery and independent destination verification.
- Add holder-owned age ciphertext storage with atomic, member-bound full-input retry receipts, ready for authenticated mutation composition.
- Add `loom-secrets-client`, a remote names/startup/request-state and stdin-only value command client with stable write retries and legacy metadata output fixtures.
- Require an explicit independent daemon key for secret value retry fingerprints; database backups no longer expose plain input hashes for new value writes.
- Add the new runtime runner's bounded, commit-pinned Git snapshot reader for house build inspection.
- Add next-mode member-private Appearance and Accessibility preference operations and Live records, preserving imported choices across owner changes.

- Reject asynchronous secret-holder mutation and handoff acknowledgements before reporting saved values or confirmed use.

- Preserve imported Comms attachment matching with a keyed fingerprint, omitting legacy raw pointers from thread metadata.
- Connect next-mode Secrets requests to managed household Attention asks, including restart and atomic owner answers.

- Add an explicit next-mode mutual-TLS Unix socket holder source and separate age decryption process for owner-granted service use.
- Keep bounded runtime job diagnostics outside live metadata, with scoped result reads and atomic completion.

- Discover visible reported runtime builds for the current house configuration without treating later progress as a newer image.

- Add confirmed dismissal of held and uncertain sends in the next-mode Bridges preview, with pending and error feedback across navigation.
- Retry runtime-held Bridges intake after daemon restart with the original receipt and fresh admission, while preserving administrative holds.
- Bound transient Bridges intake retries to a durable one-hour budget across restarts and duplicate receipts, erasing expired payloads while retaining deduplication.
- Let the owner review and count eligible unknown imported wakes as their work in the Clock app, retaining saved words, due times and current authority checks.
- Request owner review of an eligible imported wake in the Clock app, preserving saved words and due time while leaving work held.
- Show executable prompt or file excerpts alongside saved notes on Clock owner-vouch request cards, preserving every id and due time within the details limit.
- Automatically group eligible unsteered unknown Clock imports on one owner-vouch card, atomically refresh unanswered groups, retain Deny suppression and hold overflow.
- Clock: schedule exact filed local work through trusted standing authority, with a single outstanding target, durable atomic receipt and private binding checked against live authority before dispatch; public/runtime host composition remains unfinished.
- Clock: add a trusted owning standing-local approval use/check seam with exact receipt, full-digest, principal, service and project checks; Clock scheduling and fire-time composition remain pending.
- Clock: recover exact filed local words and notes through a trusted one-shot scheduling role, with current receipt checks and atomic capacity-before-spend scheduling; public runtime/client wiring remains uncomposed.
- Clock: add trusted owner-principal local-wake filing with full executable card words, exact saved prompt/note and project-preserving atomic approval filing; runtime/client recovery remains uncomposed.
- Preserve project scope on explicit Clock owner-vouch cards, reject mixed scopes and recheck the card scope before applying owner Allow.
- Clock can file an exact owner-vouch request for eligible held imports through `ask-vouch`; owner Allow applies it, and Deny prevents re-asking.
- Expose owner vouch for eligible unknown imported wakes through the opt-in wake API client, retaining owner policy and retry deduplication.
- Add owner vouch adoption for explicitly unknown plain imported Clock wakes, with atomic next-mode approval application.
- Add opt-in fixed 24-hour Clock safety wakes under explicitly configured agent authority, retaining restart deadlines and staging holds.
- Clock rejects continuation requests combined with a lane file, slot, place, approval or local-wake marker before saving work.
- Compose parked Clock wakes with current scoped Approvals and Secrets answers in next mode, without spending receipts or carrying grants.
- Add owner-controlled runtime house grant configuration with preserved secret scopes and repository-secret build provenance.

- Start the next-mode Changes daemon with durable refresh and explicit, owner-granted Secrets composition.
- Bind runtime job claims to configured house identity and record validated, immutable per-job build tags.

- Include Comms in offline migration plans, imports and independent private-content verification.
- Migration snapshots collect registered importer data and keys only, skip legacy aliases and live/program entries safely, explain refusals, and support a no-write `--dry-run` inventory.
- Prepare offline migration plans with snapshot-bound inputs, strict options and explicit audience/attribution defaults (CLI runner follows).
- Add read-only `migrate verify` that independently compares imported IDs, counts, metadata and content against the snapshot and full plan on every invocation.
- Add offline `migrate plan` and resumable `migrate all` with snapshot-bound receipts and stopped-home destination checks.
- Add centrally authorized runtime house build configuration in next mode, preserving box and model preferences without granting execution capabilities.

- Compose next-mode Changes with authenticated owner Approvals for exact-head answers and lasting project rules.
- Next runtime: atomically queue scoped body requests and private inputs with canonical box placement, without releasing executable work.

- Add explicit `loom mcp --next` stdio composition for row-backed household metadata and offline per-agent continuity.

- Add route creation, editing and confirmed removal to the next-mode Bridges preview, with pending-write and stale-draft guards.
- Add person-link creation, editing and confirmed removal to the next-mode Bridges preview with shared pending and stale-draft guards.
- Add owner-only terminal Bridges send dismissal through the registry and typed CLI, without replaying held or uncertain replies.
- Add connection creation, editing and confirmed removal to the Bridges preview, with secret-name references and shared pending setup guards.
- Add assigned runner completion acknowledgements with atomic, exact job credential revocation in next mode.
- Add next-mode assigned runner job claims and progress reports, with atomic retries and no input or credential delivery.
- Add the Projects preview app with private agent cards, Tasks-first computed hubs, independent role sections and live outside-write updates.
- Run next-mode Attention metadata retention daily as its registered service, respecting private scope and daemon shutdown.
- Add explicit Attention wait checks through visible Approvals and Tasks roles, preserving the caller and central ask history.
- Resolve Attention digest filing through visible private Comms thread metadata without reading message words.
- Attention wait checks recognize matching owner-attributed task answers through the Tasks role, preserving caller visibility and keeping reply words out of Attention.
- Activity preview on the new desk: live episode timeline, three-day windows, filters and full readers, with a synchronous seam for the new Conversations owner.

- Add an opt-in `loom-bridges` JSON setup client for next-mode connection, route and person-link operations.

- Add a Bridges preview for next mode with connection status, daily counts, routes and individually released staging sends; uncertain sends require review.
- Route explicitly selected project tools and hub memories to the context-local private store, ignoring legacy database and actor overrides.

- Add private, checksummed migration snapshots using SQLite online backups for rehearsal and the final move.

- Add the new Clock preview for live wakes, schedules, household lanes and pause/run/cancel actions; next-mode dispatch remains safely held pending runtime composition.

- Home shows each owned agent's Clock Next and live jobs, including paused and held work.
- Clock exposes scoped next-wake and complete scheduled/waiting/running job reads for the new desk.
- Add next-mode People with policy-scoped directory/relationships, evidence, agent filters and resumable person creation.

- Add explicit Attention project lookup roles for digest aliases, thread filing and unambiguous venue fallback; production wiring remains separate.
- Attention next-mode digests now resolve project aliases and venue filing through visible Projects cards for the conversation’s agent.

- Add next-mode Home with owned cards including idle agents, a central Needs you count/top three and the shared full question reader. Delivery and the remaining desk panels stay pending.
- Name owned Home cards from live shared-directory People entries and open their exact contact pages.
- Attention: public yes/no asks also accept a words answer in Inbox and Home; unsent drafts guard other answers, and private reply words are refused before central storage.
- Show the latest visible report's complete jobs and watched items on Home, with new-app and HTTP(S) source links; absent or unavailable reports never claim there are no jobs.

- Add an opt-in central Inbox preview with agent folders, answer history and daemon-confirmed answer controls. Source-owned decisions open their apps; private replies stay in Comms. Delivery remains pending.

- Add an opt-in Attention API client generated from operation command metadata, with authenticated JSON calls and safe write retries.
- Add next-mode Knowledge on live records: topics, page reader and durable check actions, with source socket lifecycle owned by the daemon.

- Next-mode Approvals uses current household project repositories for standing merge rules, asking safely when metadata cannot be read.
- Add the opt-in `loom-wake-client` API command for the new clock, with daemon-side command metadata, legacy scheduling text and bounded idempotent retries.
- Accept the new clock's UUID wake ids in approval vouch targets, preserving imported compact ids, exact matching and overlapping denials.

- Add an explicit offline Attention importer for copied conversation databases, with audience maps, atomic verification and repeat protection.
- Next mode signs in through database sessions, one-time links and passkeys, with bearer authentication for agents, runners and services.

- On the new clock side, count lane run-now against the one-off budget and wait for model quota reset without consuming job retries.
- Avoid redundant file-lane self-rearms within six hours of an authorized owner schedule on the new clock side.
- Preserve clock parked-work continuation instructions and readable answer notes; distinguish an unanswered wait from an expired Allow.
- Stop retrying a clock continuation after a definite non-quota runtime failure, retaining quota deferrals and uncertain dispatch holds.

- Keep long approval details and exact targets within the phone reader, with wrapping answer buttons.

- Register Approvals in `serve --next` so its app uses the new database and live feed without a fixture installer; runtime and clock action roles remain a separate integration.

- Add `loom migrate household --home <new-home> --from <old-home>`: a verified offline import of household, sign-in and piece settings into the new database, preserving credentials and leaving the old home untouched.
- Add `loom serve --next --staging`: the separate new shell, registered app tiles and phone pane, one address router, and individually released outside work. Existing serve behavior is unchanged.

- Keep agent-created unscoped foundation tasks in their own queue; let the offline tasks importer assign projectless tasks with `--agent`.

- Next-mode local operators can create audited, single-use sign-in links without a bearer token; first start prints an owner link once.

- Add a Tasks app preview at `/p/tasks-preview`, with live folders, task reading and actions through the foundation socket; the current Tasks entry stays unchanged until the import.

- Add an in-repo tasks piece, opt-in `loom-taskstore` API client, and offline verified tasks importer; existing taskstore and Tasks screens stay on their current path until cutover.

- Add the first web foundation slice: an app database, operation registry, central permission rule, live feed and
  in-process fixture harness beside the present page. Caller-owned operation ids replay stored results for 30 days;
  a failed live read closes its subscriber. No existing app data or screens move in this slice.

- A request that meets another process's lock waits for it without freezing the server (t-2130, t-2141): Comms posts
  and pages, live updates, turns, audit entries, deliveries, piece stores, household changes and sign-ins wait in a
  line, asynchronously, until the database (a held write lock, or a WAL recovery) or the lock file is free, then run.
  /login answers in about 100 ms meanwhile, where it waited 2 to 20 s behind the lock. Nothing fails sooner than
  before: a wait past its budget (5 s; 8 s for a Comms post, inside the runtime's 15 s; 2.5 s for a turn, inside its 5 s) goes on to the old synchronous wait, and only a lock still held
  after that is a 503 with retry-after. Replaces the fail-fast change (#776, #783) that refused Comms posts on deploy.
  `scripts/lock-smoke.ts` posts 50 Comms messages under a concurrent writer on a scratch copy of a household.

- Ask a piece's own service for its manifest over a local socket when it has one (`<piece home>/run/ui.sock`, this
  user's alone), instead of starting `ui --json`: the runtime's delivery service answers from memory in under a
  millisecond, where each run was a node start that re-read its state (t-2114). No socket, another version's or a
  failing one: `ui --json` as before.
- Pull a piece's shared records less often while they don't move: the Tasks and Changes pieces have no change log, so
  every pull is a full snapshot (a process per 500 records), and an open Tasks page made one per piece every 15 s
  (t-2110). A piece whose pulls find nothing is pulled at 15, 30, then every 60 s; its word that it wrote, or an action
  on it, pulls it at once and puts it back on 15 s. A burst of its writes is one snapshot per 3 s, not per 1.5 s, and an
  action's pull isn't followed by a second one for its own nudge.
- Run each piece's manifest once for every window that sees the same answer, and less often while it doesn't
  move: the runtime's ran once per open agent window on every round and every word (t-2110). A manifest that runs
  past a page's 3 s wait shows its last good answer instead of dropping off the page, and its late answer is kept
  (t-2064).
- Keep runtime job threads in Comms' Background work until their owner writes in them,
  exclude them from personal unread counts and notifications, and attribute agent job briefs correctly.


### Fixed

- **A device's notifications stopped without anyone turning them off** (t-1978). A subscription was kept under the
  session it was turned on in, and dropped when that session went. Agents' screenshot sign-ins filled the 50-session cap
  every two or three days, each evicting the oldest session, so a person's phone lost its notifications within days
  while it still said On. A subscription is now its person's and the device's: housekeeping (the cap, a session past
  its time, signing out and in again on the device, a plain token revoke) keeps it, and the app sends it again on each
  load. It goes when turned off there, removed on Profile, that device signed out on purpose (Profile's Sign out on its
  row, `loom sessions revoke`), its token revoked as compromised (`loom token revoke --with-devices`, or
  `--with-passkeys`), gone at the push service (404/410), or its person leaves the household. An agent's session can't
  turn notifications on. A push no longer carries the ask's words or a thread's title: only what it is, who it's from,
  and where a tap opens. Profile lists the devices that get notifications, each with **Send a test notification**.
  Agent owners can turn notifications on (`/push/*` was refused for them).
- **Agents' screenshot sign-ins pushed people's own sessions out** (t-1936). `loom token link --agent --label <text>`
  marks the session it opens as an agent's (a headless browser's counts too): listed as `(agent)`, ended six hours
  after it signed in, and first to go at the cap, after sessions already ended. `loom sessions revoke --label <text>`
  ends an agent's own sessions when it's done.

### Added

- Home shows current visible Runtime jobs from their live records, including concurrent work, actual states and boxes, with unavailable states that clear stale titles.
- Home and Inbox automatically reconcile visible approval/task waits as the signed-in member on arrival and every minute, keeping their counts current without a service grant.


- **A passkey signs its person in with a token of its own** (t-1969). Revoking the page sign-in links token (or any
  other) no longer stops the passkeys added from it, as it did Jonathan's on 2026-11-07. The passkey's token is an owner
  token naming its member, labeled `Passkey: <name> · <person> · …`, and says what it was made from. `loom token revoke
  <label> --with-passkeys` (Setup: "Revoke a token with its passkeys") takes the passkeys made from it too; plain revoke
  keeps them. Profile's "Remove a passkey with the ones added from it" does the same for a passkey. A passkey is added
  only within 10 minutes of signing in. Passkeys made before move onto their own token when loom-http starts if their
  token is live; one whose token was revoked stays stopped and is replaced by adding a new one. Agent owners can add
  passkeys (`/passkeys/options` was refused for them).

- **Needs you is the Inbox shrunk** (t-1925). On the desktop, Needs you's **Expand** grows it into the Inbox's tile on
  its Needs you folder, as an agent's card grows into its window (the same code: `tiling/widgets.ts` `pairOf`); an ask in
  it opens in the Inbox with that ask picked. While an Inbox tile is open, Needs you stands aside and the other widgets
  fill its room; the Inbox's **Shrink to widget** folds it back. Reduced motion: instant. Phones are unchanged.

- **A Comms thread says when an agent couldn't start, even after "queued"** (t-1946). The runtime can now tell core
  `status: start-retry` (with its attempt and next try) or `start-failed` on the adapter route, for a start that failed
  after it had already answered `queued`. The thread keeps one line per message, updated as attempts go by ("couldn't
  start (2 tries so far); retrying. Next try at 14:32."), the busy line no longer follows, and a late or repeated
  notice never brings a settled line back.
- **Sign one browser out alone** (t-1871). Profile's **Signed in** lists each browser session you may see (a household
  owner, all of them; an agent owner, their own): what it is (from its User-Agent), its sign-in link's label, how and
  when it signed in, when it was last used, and its token. **Sign out** on a row ends that session and its
  notifications only; other sessions of the same "page sign-in links" token stay. On loom's machine, `loom sessions
  list` and `loom sessions revoke <ref>`; `loom token link --label` names the session a link opens.
- **Asks answered only while open, everywhere** (t-1925). The asks inside a Comms thread and the desktop's Needs you
  now use the Inbox's rule (`web/src/ask-open.ts`): no buttons until loom confirms the ask is open now, checked again
  right before a send, and none when loom can't be reached or the copy came from this device's cache.
- **Comms' band** (Jonathan, 2026-11-07; `docs/specs/comms.md`, "Desktop"). A desktop thread has a band of fixed
  height over the chat: the comm screen at its own 2× size on the left, who's in the conversation and the thread's
  work on the right, scrolling inside the band. The chat takes the rest. The list sits beside the thread only where
  Comms is 1100 px or wider; narrower, it's the drawer from the thread's header. The comm screen never stretches.
- **An agent's window** (t-1925 D; `docs/specs/desk-tiling.md`, "An agent's window"). An agent's pages wear one header:
  its face in a Neon frame (no 000h shapes, no clock element), its name with a working pill, and a plain description
  of what it does (household.json `about`, never its creed) that a household owner edits in place or asks the agent to
  rewrite (the new `describe_self` MCP tool, refused unless asked). Its sections are a sidebar inside its window (an
  icon rail when narrow), so the desktop's dock no longer swaps; its window's corner wears its letter. Its desk card
  and its window are one app: Expand grows the card into the window, Shrink to widget folds it back. Phones keep the
  dock's swap, with the new header.
- **The Inbox is a mail client** (t-1925; `docs/specs/ui-app.md`, "Master/detail"). Folders (Needs you, Questions,
  Approvals, Alerts, Memory reviews, Done, and who it's from), the list, and the open ask beside it whole: why, if yes /
  if no, its buttons, a reply, where it lives and its trail. Answering moves it to Done and opens the next. In a narrow
  tile or on a phone the folders are chips and the ask slides over the list. Its buttons are live only once loom says
  the ask is still open (`GET /inbox/open`), and loom is asked again before any is sent. Old `?f=` folder addresses land
  on the new folders. The master/detail layout (`web/src/split.tsx`) is generic.
- **Comms polish** (t-1918, t-1925 C; `docs/specs/comms.md`). A thread's address has no colon (`/comms/<id>`), so a
  reload works; old `comms/th:…` links redirect. The comm screen's channel line says what the agent is doing
  (THINKING, WORKING, TALKING, WAITING ON YOU, DONE, NO CARRIER, plus ON CODEX), and the separate thinking blob is
  gone. A body that couldn't start says "couldn't start; retrying" with What happened, not "busy". The thread follows
  the bottom only while you're there; scrolled up, a New messages pill counts what's new, and a working line shows the
  step the agent is on. The Enter hint is faint and only on focus; in a narrow tile the threads are a drawer; the list
  wears the agents' letters.
- **The launcher** (t-1925 G; `docs/specs/desk-tiling.md`, "The launcher"). On a desktop the dock's last key, All apps, or
  Ctrl+Shift+Space opens every app in one grid, grouped as Work, People & agents, Library, System, Look & feel and
  Pieces, each tile with its live state. Search is focused at once and filters as you type; Enter opens the first match
  as a tile, Esc closes, the arrow keys move. It replaces Setup's dock key and the account key on the desktop; Setup and
  More are no longer tiles there (an old link opens the launcher), and Appearance, Accessibility, Members and Pieces each
  open in a tile of their own. Phones keep More and Places.
- **Tiling is the only desktop** (t-1884; `docs/specs/desk-tiling.md`, "A fresh desktop", "One window at a time"). At
  1024 px and wider, apps share the screen as tiles for everyone: Appearance's Desktop choice and the old single window
  are gone. A device with no saved layout starts with Needs you, each agent's card, Vitals, Backup and the ticker
  (`web/src/tiling/widgets.ts` `SEED`). One window at a time is now an Accessibility choice inside tiling, off unless
  turned on: one app tile at most, and opening another sends the one there to the dock, said in a toast. Whoever had
  One window at a time saved under Appearance has it on; the old `tiling` field is still taken, so an older app gets
  no error.
  A tile now does what the old window did: its page wears its app's colour, its pages reach Find's Recent, the bar's ⓘ
  is its page's, and the dock lights its key. Comms in a tile under 760 px keeps its comm screen to a strip's height,
  so the messages always have room.
- **Desk tiling: widgets are tiles** (t-1884, phase 4 of `docs/specs/desk-tiling.md`). With Tiling chosen
  (Appearance → Desktop), Home's widgets (Needs you, each agent's card, Vitals, Backup, the ticker) are the desktop
  with no app open, and move to the right edge beside the apps: in columns, a rail, or a strip of keys. Chat on an
  agent's card opens its latest Comms thread beside them; an agent's tile pins its card; the dock's + key and Find add
  widgets; × removes one. The set rides in the address (`w=`). A wide tile has Recent here.
- **Comms: asks inline** (t-1876). A thread shows its agent's pending approvals that were asked from it (the approvals
  piece's `--conversation`, kept beside the agent loom authenticated), with the ask, why, If you allow, If you deny
  and the fine print, and Allow once and Deny right there; while one waits, the comm screen's face is waiting on you.
  An ask naming a thread but from another agent never shows there.

- **Pixel icons** (t-1880). A household can install its own pixel icon set (`loom household icons install <dir>`, kept
  at `icons/<set>/`, served only to someone signed in), and a member can wear it with Appearance's "Pixel icons" (off
  unless turned on; not offered without a set). Each icon keeps its light and shade, recoloured to its key's ramp in
  each look, normal and lit, stronger with Higher contrast, by an SVG filter the page builds once from the look's own
  colours. The dock, the launcher's tiles, an app's tile in its header and in Find, and a window's title strip wear
  them; a 16 px row keeps its line icon, as does an app the set has none for.
- **Comms: a push when your agent replies** (t-1876). A reply in a thread you haven't read, with no app of yours on that
  thread for 2 minutes, pushes to your own devices only: "Art replied" and the thread's title (or "Art replied in a new
  thread"), never the reply's words. A tap opens the thread.

- **Comms, the app** (t-1876). A Comms key in the dock (for a member who owns an agent, with their unread threads),
  the thread list leading to a thread on a phone and the two side by side on a desktop, and each thread's comm screen:
  the agent's pixel portrait at 2x in a Neon OS frame (`NAME · CH nn · LINK OK`, a signal meter, a YOU panel on a
  desktop), its face following the thread (thinking, working, talking, done, waiting, error), a burst of static
  when a reply lands, and talking as a bounded run of 1-4 beats with a breath between. Pixel faces gain `talking`,
  which a manifest without it plays as `done`, then `working`. Activity cards fold to one line per run.
- **Comms: `comms_title`, and threads in their project's hub** (t-1876). A body names its Comms thread with
  `comms_title` (60 characters, one line, never over the owner's own name for it), and a thread's title is its
  conversation's label. A thread filed under a project is its digests' project when they name none, ahead of
  `links.venues`, and the hub's `conversations` section lists it from its first message.
- **Comms, core: talk with your own agents in loom, in threads** (t-1876, docs/specs/comms.md). A new core venue,
  `loom`, which core adapts itself (`adapter: "core"` in `GET /api/loom/venues`). Its threads live in
  `household.db`, and their words in `comms.db`, each age-encrypted to `comms.key`, kept `comms_days` (household.json,
  1-14, default 14) and never in a bundle. The page's `/comms` routes reach only a member's own threads with agents
  they own: anyone else, and a thread that never existed, gets the same 403. There's a live stream per thread
  (`/comms/<thread>/events`, `{seq}` only), and the runtime's `POST /api/loom/comms/adapter` and `/comms/activity`.
  The app comes in a later change.

- **One structure, three looks: Neon Noir, Low Light, Daylight** (t-1875).
  000h is no longer a look of its own: Neon Noir's structure (the phone bar
  and system bar, the dock's keys, cut-corner cards, the desktop at 1024 px
  and wider, Find as a command bar, the sheet's title bar, the power-on) is
  every look's, and a look is only tokens (colours, a few corners, glow,
  type) in `web/src/looks/looks.css`, part of the app's own stylesheet. Low
  Light is dark and calm (000h's soft dark colours, no glow but a face's,
  Figtree titles); Daylight is light (ink on warm paper, the tints deepened).
  A saved `look: '000h'` is worn as Daylight if its light or dark was light,
  else as Low Light; it stays on disk as it was until the person chooses, and
  an app from before may still save it. Appearance's Light/Dark/Auto row is
  gone. Every look meets the contrast floors with and without Higher
  contrast; no exception is named any more.
- **Pixel faces wherever an agent's face shows.** Under 36 px (Inbox rows, the
  desktop's widgets, a window's title, the side panel), an agent with a sprite
  sheet now wears a still pixel avatar: a crop of its rest frame, 24 sheet
  pixels square over the top of what's drawn (or the manifest's own
  `"avatar": {"x", "y", "w", "h"}`), at a whole-pixel scale, never smoothed,
  never moving. Agents without a sheet, and everyone with Pixel faces off, keep
  the drawn face; letter badges stay.
- **Neon on a big screen boots** (t-1868). With the app's arrival, once a
  session and never under reduced motion, a desktop shows a second or two of
  LOOM//OS™ coming up, licensed to the household owner by name, with chatter
  that is what loom has (the link, the agents and how each is, the pieces,
  what needs you) and the one joke: "validating LOOM//OS™ license …
  compliant". Any key or tap skips it; it never takes focus, and a screen
  reader doesn't hear it.
- **Neon on a big screen: apps open in a window** (t-1868). Every page but
  Home opens in one big framed window over the ground: a title strip in the
  app's colour with its key, its name and where it is, cut corners, a ruled
  edge, and Close. Close or Esc goes back to the desktop (not while a sheet,
  a dialog or a field has Esc), the window grows out of its dock key and
  shrinks back into it (View Transitions; never under reduced motion), focus
  lands on the window's title and goes back to the key it came from. The page
  inside reads at up to 72rem and scrolls inside the window; sheets and
  dialogs stay above it. From 1600 px, where you've been lately beside it.
- **Neon on a big screen: Home is a desktop** (t-1868). Under Neon at 1024 px
  and wider, Home is widgets on the ground instead of a scrolling page: what
  needs you (the first four, each answered where it stands: Yes and No for a
  yes/no ask, Allow and Deny under the approval's own words, else its own
  buttons; one asked in words opens its sheet), a card per agent with its face
  big and the one thing it's on, box vitals (the Boxes place's count and open
  alerts, and any place in trouble, from the shell every page has) and the
  nightly backup. One screen's height: a column with more than fits scrolls
  inside itself. The dock moves to the bottom centre (the phone's keys, the
  rail gone), and every other page scrolls in the space between the bars and
  the dock. Home's answer carries the first few waiting items whole
  (`stack`). Its own chunk, fetched only
  at that width under Neon. Phones, 000h and screens under 1024 px are
  unchanged.
- **A phone's Home with many agents is a row each** (t-1869). Up to four
  agents keep their big cards. Past four, a phone's Home lists them one row
  each (face, name, how it is in words, its last line), something wrong
  first, each a tap to that agent's page. Wider screens keep their cards.
- **Neon on a desktop wears the phone's bar** (t-1865). Wider than a phone,
  Neon's top is the phone's bar (the page's name and its ⓘ, the ticker,
  LOOM//OS and the count) in place of the old status line and big header,
  under a thin system bar where a phone's own would be: loom's clock (loom's
  time, from its answers' Date, in loom's time zone) on the left, and on the
  right a signal (live or offline), the agents at work, the boxes (how many,
  dimmed while one has an alert) and the nightly backup (its last good one, or
  what's wrong: a household owner's only), each with its words on hover and as
  its accessible name. Both span the page's column. The shell now carries
  loom's time zone, each piece's open alerts, which agents a piece reports at
  work, and the backup's state. A name with its ⓘ is no longer cut short on a phone
  ("Boxes", not "Bo…"). 000h is unchanged.
- **A long panel pages like a list.** A piece's panel of more than 15 rows
  shows 15 at a time, with numbered pages and its action under them. The
  Secrets page's 61-row store had been one 6,500 px wall; it's now 2,500 px
  and the sections under it can be reached.
- **An Accessibility app, beside Appearance** (t-1867). Its own tile in More
  and in Find, its own page and intro. **Allow zoom** moves there from
  Appearance (a choice already made carries over). **Reduce motion** (Follow
  the phone, On, Off) is one switch for everything that moves: On crossfades
  pages, stills the ticker, skips the opening animation, holds faces on their
  rest frame, fades the dock swap and drops the follow-the-finger swipes, even
  where the phone allows motion; Off runs them all, even where the phone asks
  for less. **Higher contrast** (Follow the phone, On, Off) raises Neon's and
  000h's light and dark tokens to 7:1 for text and 4.5:1 for the quieter texts
  and control edges, unfades hint text, thickens focus rings, puts solid
  ground behind words that sat on see-through surfaces, and turns Neon's glows
  off. Both are the person's, kept by loom on every device, and worn before
  the first paint. Under the hood every `prefers-reduced-motion` and
  `prefers-contrast: more` query, 000h's own included, is rewritten at build
  onto `<html data-motion>` and `<html data-contrast>`, and scripts ask
  `web/src/access.ts`.
- **Neon on a phone: a page's info is behind its name** (t-1863). The line
  under the phone bar is gone; when a page has a line or an intro, its name
  in the bar wears a small ⓘ and opens a sheet with both (with a haptic tick).
  A page without either has a plain name. 000h and wide screens are as they
  were.
- **loom on a phone holds still like an app** (t-1862). No pinch or
  double-tap zoom, no zoom-in when a field takes focus (every field is 16 px
  or more on a touch screen), no long-press menu or link preview on the bars,
  the dock, buttons, links and images, no selecting the app's own chrome (a
  message's or a note's words still select), no grey flash on a tap, and no
  rubber band or pull to refresh past the page's ends. Appearance gains
  **Allow zoom** (off by default) for anyone who needs to zoom to read. The
  browser's bar wears the look as it's worn (000h's light or dark as chosen),
  and the installed app holds portrait.
- **A phone's gestures, page moves and haptics** (t-1855). Swipe sideways to
  move between Home, Inbox, Places and More in the dock's order; swipe up from
  the dock for Find. A page change slides by the dock's order (a push into a
  page, a pop back out), with the bar and the dock left still, and a swipe
  drives the same move under the finger; reduced motion crossfades. The dock's
  keys slide down and up when they swap for an agent's own. Appearance gains
  **Haptics** (on by default): a tick on Android, and on iOS a real tap on a
  dock key or an ask's Yes and No.
- **Neon on a phone: one bar under the phone's own** (t-1849). At a phone's
  width the page's name sits small under the phone's clock, LOOM//OS and the
  needs-you count under its status icons, and between them a ticker (live, the
  agents and what each is up to, each place's tile). The ticker moves only when
  its words don't fit, at 24 px/s, stops while touched or hidden, and stands
  still under reduced motion; the count never moves. The big header stays on
  wider screens and in 000h.
- **Neon's dock, as the mockup**: no tray, a thin magenta rule over the row,
  dark keys with a neon edge and the current one lit, no names under them (a
  key's name shows on hover, keyboard focus, or held a moment).
- **A pixel face's own `scale` and `offset`** in its manifest (worn under
  Neon), so a face that reads bigger than the others is tuned without a
  deploy; Neon's agent card
  keeps a minimum gap between the face and its words.

- **Pixel faces.** An agent can have a pixel face (Jonathan's PixelLab
  portraits for Art): a manifest and its sprite sheets kept with the
  household's marks (`faces/<agent>/`, set with `loom household sprite`),
  drawn at whole pixels (1x, 2x on a card) in its own lazily loaded chunk.
  Each state plays as a beat, then rests, with a random gap per face; several
  weighted animations per state and facing (one picked per beat, a rare one
  never twice running); a glance to the south-east or south-west now and then
  while resting, waiting on you always facing you. Nothing moves off screen,
  in a hidden tab or under reduced motion. Appearance's "Pixel faces" (on by
  default where a face exists) is the person's, on every device. An agent
  without one keeps its drawn face.
- **Neon Noir's status bar, sheets, Find, power-on and sound.** Under Neon a
  status bar heads every page: LOOM//OS, live or offline (in words), how many
  agents and how many things need you, and loom's clock. The Inbox's sheet
  gets a title bar (what it is, who asks, its task) and a lit top edge, and
  Find is a command bar with a prompt and the current row's cyan edge. Under
  Neon the once-a-session arrival becomes a power-on (a line opens into the
  screen and the page flickers on, about a second, cut short by any tap or
  key, never under reduced motion); 000h's arrival is as it was. Appearance has Sound, off unless the person turns it on:
  a WebAudio chime (0.5 KB, loaded only when on) when loom opens and when
  something they did lands (once per outcome); no opening chime when the
  opening animation is skipped, and a browser that won't play sound before a
  tap stays quiet.
- **Neon Noir's faces, type, corners and glow.** An agent's face keeps its
  body and its expression and becomes dark glass rim-lit in its mark's neon
  (six marks re-pointed per look, `--mark-*`), with a soft glow that is the same
  in every state: the expression says the state. Titles are Oxanium, reading
  is Figtree, and numbers, ids and times are IBM Plex Mono (self-hosted Latin
  subsets, fetched only when Neon is worn). The app's hard-coded tile corners
  are tokens, Neon's radii step down, an agent's card has a 45° cut corner lit
  in its colour, and the dock, the launcher and an app's tile are dark keys
  with a neon edge (the current one lit solid). The depth background's lines
  glow. Glow sits on edges and what's current only, never on a state or a
  status, and goes under `prefers-contrast: more` (checked in a test).
- **Neon Noir, the page's new look, and the default.** Appearance has a
  Look: Neon Noir (dark only: a night-city control room, light from edges and
  states) or 000h (light or dark, as before). Neon is what a person who hasn't
  chosen sees, so everyone's page changes on update; 000h is one tap away and
  draws exactly as it did (until the same week's one structure, above). Its stylesheet is its own file, put on before first
  paint by a 0.5 KB script in the page's head (loom's CSP allows no inline
  script), so a page never flashes the other look. A person's Appearance (the
  look, light or dark, the background) is theirs on every device: kept by loom
  per member like the Inbox's read state (`ui-sessions.json`, a preference,
  never what they browsed), saved from any device (`POST /appearance/prefs`),
  and carried on every page's chrome; a device keeps a copy only for its first
  paint. Every look's colours are measured in a test (text 4.5:1 on every
  surface, control edges 3:1, ink on the tints 4.5:1; one exception is named
  there: 000h's count badge, 3.91:1, left as it was so 000h doesn't change), and the page's last hard-coded colours
  (status dots, warning rings, counts, the unread dot, how far the dark dims the
  ground) are tokens a look re-points.
- **The nightly backup is loom's own.** `loom backup set --target git:<url>|path:<dir>
  --recipient age1…` (docs/specs/keeping-watch.md): each night at `--at`, one of
  the listeners exports the household, drills a restore of it with the
  machine's own drill key, and writes it to the target (a git repo as one
  force-pushed commit, or a directory). The default agent's Setup has a Backup
  row; a failed or missed run is an Inbox alert for household owners, and
  `LOOM_ALERT_COMMAND` hears it. `loom backup run`, `status`, `off`.

- **Two cards that turn out to be one person become one.** `person_merge`
  (an agent of the household that holds both), `loom person merge <from>
  <into> [--dry-run]` (the owner) and `POST /api/loom/people/merge` (a
  household owner, the runtime) fold `from` into `into`: `where` is the union
  of both cards' values, `how` and `may` the union with `into` winning, `into`'s
  name and summary kept with a "Merged <from> (<name>) <date>" line, in the
  directory and every agent's copy. Every memory, proposal, conversation and
  turn tagged `from` is re-tagged, and `how.via`/`how.loop_in` relinked. `from`
  is left an archived redirect (`person_merges`): reading it answers `into`'s
  card with a note, and a later write, verify, ensure or reach lands on `into`.
  A dry run says what would change; the answer's `not_done` says to rename the
  slug in every agent's gates.

- **A person is one card, however they were added.** `POST
  /api/loom/people/ensure` and `loom person ensure` make sure someone has a
  person card: with none, a minimal one (the name, `<role>. From <source>.`,
  the `where` values); with one, only the `where` values it lacks, as `reach`
  adds an id. Name, summary, how and may are never changed, and a value
  already on another card is refused (409). A household owner, the runtime,
  and a piece's process in an owner's action (the grant loom minted for it,
  checked as `loom store` checks it) may call it; agents keep `person_write`,
  and `person ensure` never runs over `POST /cli`. `--dry-run` writes nothing.

- **Old piece names.** `box` is now `runtime`: the catalog lists loom-box's
  repo as `runtime` (37cc43d), and core's alias table (`PIECE_ALIASES`)
  maps `box` to `runtime` for `/api/box/…`, `/p/box/…` (a 308), `piece:box/…`
  credentials, a house's `loom box …` and the starters, while no `box` piece
  is installed. `loom pieces update box` says how to switch instead of
  failing.

- **Turn keys.** `POST /api/loom/conversations/turn` takes an optional `key`
  (the runtime's `<source>:<id>`, runtime role only): a repeat within 24
  hours answers the first `{conversation, seq}` and writes nothing, and the
  same key on a different turn is a 409. Kept in `household.db` (`turn_keys`).

- **Delivery, core's half.** `POST /api/loom/deliver`: the one core route every
  piece token reaches (and the runtime's token). Core checks the body and who
  may deliver what (the venue is the caller's, the agent the household's and
  granted, a person only from a venue adapter, an agent only from the
  runtime), each refused with a 403 that writes nothing; then forwards it to
  the one piece offering the new `delivery` offer key (a runtime-role piece
  only, one per household) under 120 s and 64 KB, and passes its answer
  back (a runtime's own `{status: 5xx, error}` passes through). Idempotent on
  (calling piece, id) for 24 hours, kept in `household.db`; a failed forward
  isn't kept. `GET /api/loom/venues` gives the runtime every venue with its
  `send` argv. Offer lookups by name use own keys only. A piece delivers on
  core's `wake` only if it declares `"wake": {}` in its venues. Replays are
  keyed on (calling piece, id) with a hash of the body (a changed body is a
  409), and one piece gets at most 2 running and 4 waiting forwards and
  10,000 kept answers a day (t-1744).
- **The audit log and review's records** (docs/specs/conversations.md, slices 2-3).
  `$LOOM_HOME/audit.db` holds raw turn text, age-encrypted to a review key made
  at first use (`review.key`/`review.pub`, 0600), written by the turn's writer
  (`POST /api/loom/audit`) and deleted on `audit/done` or 7 days after its
  turn (an hourly sweep, also at start). A review token takes entries
  (`audit/take`), redacted (people P…, agents A…, models M…, harnesses H…),
  posts `scores` by ref and at most one `findings` line per conversation per
  UTC day. Core aggregates `scorecards` (graded, plus the metadata measures),
  which the runtime reads with `GET /api/loom/scorecards`. household.json gains
  `families` (model → family). Bundles and exports never carry the audit log
  or its key.

- **Offers.** A managed piece's `loom` block may declare what it offers through
  core: `sections` (a project section feed), `venues`, `mcp_tools` and
  `grants`. Each is checked at install (a bad one rejects the whole block; a
  venue or tool name another piece has, or a second grants authority, is
  refused), kept in piece.json, listed by `src/offers-registry.ts`, and run
  through the manifest's runner: 3 s, process group killed, 6 at once, the
  answer checked against a schema (t-1738).

- **Local pieces.** `loom pieces install --from path:/abs/dir` manages a piece
  that will never be public (an agent's homelab wrappers) like any other: a
  snapshot of the directory (`npm pack`), versioned by its sha256, so
  `update` notices a change and `rollback` and `remove` work. `loom pieces`
  lists it as `managed <version> (local)` (t-1728).
- **`harness_patch`: a safe small edit to a harness manifest.** A harness
  manifest is normally read back through `identity()`, which bundles it into
  a combined payload capped by the transport — past that cap a read silently
  truncates mid-sentence, so a `harness_describe` overwrite built from that
  truncated read risks dropping everything past the cut. `harness_patch`
  applies an exact find/replace against the server's own on-disk copy
  instead, so the caller only ever has to hold the text of the edit itself,
  never the full manifest (t-1674).

- **A door for strangers, where a piece opens one.** A tokenless call reaches a
  managed piece's API only on a path its `loom` block lists in `strangers`, as
  `{kind:'stranger', address}`, 8 KB at most: so a new box can ask to join and
  the owner lets it in on the page, with nobody handling a credential (t-1617).

- **House tokens name their house.** Role `agent:<a>[/<service>][@<house>]`
  (`loom token create --agent art --house h-104`), and a piece's API sees
  `"house"` in the caller, so a piece can grant one house something: the
  secrets piece's requests.

- **A bundle brings the household back whole.** `household.json` travels whole
  (its own settings, like the relay pairs, came back stripped), and so do the
  managed pieces: which ones, at which commit, with the owner's settings.
  `loom restore` installs them (from this loom's catalog, at its commits: a
  bundle isn't signed, so it names pieces and never brings code) before it
  hands each piece its part, so a fresh
  machine gets working pieces, not parts left in `pieces-pending/`
  (`--no-install` skips it).

- **Service tokens.** `loom token create --agent art --service slack` mints
  role `agent:art/slack`: a service house's token. It's the agent in every
  way, and a piece's API sees `{"kind":"agent","agent":"art","service":"slack"}`,
  so a piece can tell the agent's bridge from its other bodies (t-1591,
  shuttle's `relay-take`).

- **`knowledge_list`** and **`person_evidence`** MCP tools: the CLI's
  `knowledge list` and `person evidence`, so an agent in a house has them as
  tools (t-1598). `knowledge_list` is on the full server only, not the
  commons-only peer scope.

- **`relay`** MCP tool, for a household served over HTTP: ask another agent
  something. It runs the clock piece's `wake relay` as the session's own
  agent, so it wakes a body of theirs in their house, and their answer comes
  back as a wake of yours (t-1597). Only between agents `household.json`'s
  `relay` list pairs.

- **`memory_recompute_salience`** MCP tool, and `loom memory recompute-salience`
  now runs over the remote CLI. A consolidation lane in a house (Mark's
  continuity, 2026-10-27) was refused it: "has no MCP tool, so it doesn't run
  remotely" (t-1544). `recall-stats` stays local.

### Changed

- **A Comms thread opens without an age process per message** (t-1926). Reading a thread decrypts its words in
  loom's own process with the age library (`age-encryption`, BSD-3-Clause), not one `age` process per message, so
  GET /comms/<thread> for 40 messages drops from over a second to well under 300 ms. The `age` program stays the
  fallback for a message the library can't read, and is logged without its words. Nothing decrypted is cached.
  `scripts/nav-bench.ts --server-only` times it, and fails at a median of 300 ms or more (`docs/specs/comms.md`,
  "The rules for the kept words").

- **Desktop right-click** (t-1925 E; `docs/specs/desk-tiling.md`, "Context menus"). Adding a widget moves from the
  dock's + key (gone) to a right-click on the desktop, or the Menu key or Shift+F10. Short menus on a tile's strip
  (Minimize, Make it the big one, Pin its card on an agent's, Close), an agent's card (Chat, Open, Unpin), a dock key (Open, Minimize, Close) and
  an Inbox row (Open, Mark done). Keyboard-operable, Esc and Tab close, focus never trapped.

- **Desktop tiles: strip, room, loader, moves** (t-1925 B; `docs/specs/desk-tiling.md`, "The frame", "Transitions"). A tile's strip never says its
  app's name twice ("COMMS › COMMS" is "COMMS", the way up to the app's start). The only app tile on the desktop, with no
  side of its own, has no Recent here: its page takes the room. One loader replaces every spinner: four neon segments
  lit in turn, 16, 24 or 40 px, never sized by the text around it. Opening, closing, minimizing, making a tile the
  big one and bringing it back from the dock each have their own short effect (a CRT's power-on and -off, a scanline
  wipe, a glitch); reduced motion has none.

- **The desktop's bar is one line** (t-1925 A; `docs/specs/desk-tiling.md`, "The bar"). At 1024 px and wider: loom's
  clock and the page's name on the left, LOOM//OS and the status glyphs on the right, the ticker scrolling between, 34
  px tall, where there were two bars. The ticker widget is gone (the bar has the same feed): a layout or an address
  that has it loads without it, and the device's copy is written again without it. The desktop draws no headline
  ("Everyone's fine"): just widgets and tiles. Phones and screens under 1024 px keep their bars.

- **Desktop Home: the three columns line up, and no Moving strip** (t-1884). How everyone is ("Everyone's fine")
  reads across the top, above all three columns, so Needs you, the first agent card and Vitals share a top edge; it
  used to sit in the middle column and push the agents down. The Moving strip under the agent cards is gone: each
  card already says what its agent is on.

- **Catalog: shuttle at bb5e92b.** A relay's words are quoted under a one-line
  header that says it carries none of the person's authority.
- **Catalog: shuttle at df79324.** Relay: a body asks the body that owns
  another conversation to say something (`piece-call shuttle relay --via slack
  --person <slug> --say …`), through loom's piece API; the Slack bridge hands
  it to that person's DM.
- **Catalog: tasks at da669f3.** The owner's comment from the page hands the
  task back to the agents and runs a command (a wake), set by
  TASKSTORE_ON_OWNER_COMMENT; the owner's comments carry their initial.
- **loom's mark on the page is the v7 icon,** not the four squares: the
  32px export beside "loom" in the rail and the phone header, the 192px one
  on the sign-in page.
- **The boards' "+".** A page may name where adding one goes (`add`: a page
  and a label), and loom draws it as a "+" beside the title. People adds a
  person (name, who they are, where to reach them) and Knowledge adds a fact
  (title, topic, what it says, where it came from: a link, or empty to keep it
  provisional), both as the owner, and an add never overwrites one that's
  there. Catalog: tasks at 44da8ae, whose Tasks page adds a task.
- **Catalog: shuttle at 05c4033.** An expired login's card on Home carries
  Renew login (the ask's own action).
- **An ask may carry its own buttons** (`actions`, up to two `buttons` items),
  drawn on its Home card in place of the link, as the board's Ratify and
  Reject. When one memory waits on an agent, Home's card quotes it and ratifies
  or rejects it right there.
- **Thread rows on a wide screen put where and when at the right edge** (the
  row's link, not its text, takes the room).
- **Catalog: shuttle at 21c35b6.** The Subscriptions tile on Home is the
  fullest usage window ("48%, Jonathan's Claude · 7 days, resets Mon").
- **Desktop per the Desktop board.** The rail stays put while the page scrolls,
  so its foot (owner, Passkeys, Sign out) is always there. Thread rows are one
  line on a wide screen, where and when at the right. Home's head carries a
  live dot. A long tile value is set smaller and a tile's detail is two lines
  at most. An agent's Today: its glance tiles two up in the side column, and
  its Thread says where in words.
- **Catalog: box at 4ab3b64.** Boxes per its board: the box card first (how long
  it's been up, its disk, its houses, the machine's facts folded), services
  with Restart at the row, sessions with Up/Down at the row.
- **Scope sheet and Manage pieces per their boards.** Each agent on the Scope
  sheet says how long since it was last active ("active 42m ago"), beside
  what waits on it. On Manage pieces the catalog is a row a piece with Install
  at its right, and pieces loom didn't install get their own "Managed by
  hand" section.
- **A page's title slides into the phone's header** once it scrolls under it,
  as iOS's large titles do (where the header has a way back; Home keeps its
  wordmark). A named back link gives up its word to make room.
- **Catalog: secrets at f6f1ee2.** Secrets per its board: what's stored
  first, each name a row to its own page (`secret?name=…`: names may have
  capitals, page paths may not), then Add a secret.
- **Catalog: secrets at 75e6cb4.** Secrets per its board: what's stored
  first, each name a row to its own page (Replace, and a Remove that asks
  first), then Add a secret.
- **Header touches from the boards.** A piece's page says "updated just now"
  under its title, and the script counts it up ("updated 40s ago", "offline ·
  updated 3m ago"). Search fields carry a magnifier. Places tiles are filled.
- **Mind, a memory, a person and a knowledge entry per their boards.** Mind
  leads with Your call (each drafted memory quoted, with Ratify and Reject),
  then Top of mind as a ranked list and "All N memories"; the filters and the
  heat detail are on that page. A memory shows its facts card first (with
  "Top of mind #N" when it's there), then what it says, History and Forget. A
  person's rows give each agent's summary in a line or two. A knowledge entry
  says when it was verified under its title, and Still true comes after its
  sources.
- **A list may be numbered** (`numbered: true`): a rank before each row.
- **Sign in, Passkeys and New agent per their boards.** Sign in: loom's mark
  in the middle, and at the bottom a passkey button, "or", a token and Go.
  Passkeys: each a row with an inline Remove, then Add a passkey, then Another
  device (a one-time sign-in link, what `loom token link` makes). New agent:
  name, a color (swatches from the mark palette), what it's for, a voice word
  (Dry, Warm, Terse); the short name comes from its name.
- **A choice field's options may be colors** (`swatch`, a hex): drawn as a
  row of swatches.

### Fixed

- **The desktop's boot tests failed whenever the machine was busy** (t-1949): 732 ms against a 600 ms limit on CI, 3491
  against 3200 locally, and with the merge queue each failure ejected a PR. They now hold the page's own clock
  (Playwright's) and move it on by hand, so they check what the boot does, and in what order, with no time limits left:
  it stands until 2.2 s on its clock, leaves then, is gone after its 0.25 s fade, and a key or tap ends it with no time
  passing at all. A fresh session is now cleared from a page that isn't the app, so an arrival still running can't mark
  it again. `expect.poll` waits up to 10 s (vitest's default gave up after 1 s, a limit no test meant to set).
- **`loom token link --help` minted a live sign-in link** (t-1950). `token`, `sessions` and `household` found
  their flags by looking for the ones they knew, so `--help` was ignored and `link` went ahead and printed a working
  link. They, and `backup`, `export`, `restore`, `store` and `pieces`, now parse every flag first (`src/cli/args.ts`,
  `parseVerb`): `-h`/`--help` prints usage and exits 0, and a flag the verb doesn't know is refused with 2, before
  anything is minted, revoked, written or installed. `harness init` checks `--help` before stamping a fresh context
  dir, and `knowledge`/`memory` honour `--help` anywhere after the verb. `src/cli/help-no-side-effects.test.ts` runs
  every verb that changes something with `--help` and with an unknown flag, and checks the household's files are
  unchanged.
- **A window's page ran over its frame** (t-1925; Jonathan, 2026-11-06). A tile's ring was a shadow under its page, and
  the page reached the tile's edge, so a page with a background (Activity's feed) covered the bottom edge, and every
  page sat a pixel over the sides. The ring is drawn over the page and its sheets now (the cut corner's diagonal too),
  and the page sits inside it; `src/ui/desk-window-overflow.integration.test.ts` holds every app to it.
- **The desktop's bar** (Jonathan, 2026-11-06): a quiet dot between the clock and the page's name, and between LOOM//OS
  and the status glyphs; the ticker's words stand in the middle of the room between them when they fit.
- **A reply's signal on the comm screen played for less than its 250 ms** (t-1925). The 250 ms counted from when the
  static was asked for, not from when it showed, so a busy render ate into it: 190-240 ms on a loaded machine, as
  little as 33 ms on CI, where the Comms test failed on main and on loom#589. They count from the screen now.
  Two backup tick tests no longer fail when run in a ten-minute window each day (02:45-02:55 or 20:45-20:55 in
  Chicago): they pin when the backup was set instead of taking it from the wall clock.
- **A restore could write into the live machine's piece stores** (t-1846). The backup drill (loom#488) restored
  into a throwaway home and handed taskstore its part with the caller's environment, which named the live store;
  it didn't write there only by luck. A restore now hands a part only to a piece it installed into the home it
  restores to, with that piece's settings from the restored household or its defaults, never the caller's
  environment, and refuses a piece whose setting names a path outside that home (its part waits in
  `pieces-pending/`, its services don't start). `loom restore --allow-outside`, for the owner's own restore onto a
  new machine, lets one name a path that isn't there yet; one that is, a live store, is refused even then. A piece found on PATH keeps its part pending too.
  And a restore starts services only into this machine's own household: a piece's units are named for it in the
  caller's systemd dir, so a restore into a throwaway `--to` would have repointed the live household's units.
- **Adding an agent kept only `agents`, `default` and `owner`** in
  household.json, dropping `marks` and anything else. It now keeps them.
- **An agent's Setup per its board.** Health first (Memory, Last active, Tokens
  as status rows), then Identity (Voice, Born, Harnesses, the bio, and the
  whole creed folded), then Tokens: each live one a row with an inline Revoke
  that asks first, the revoked folded, Create token folded.
- **A list row may carry one action** (`act`, a `buttons` item), drawn at its
  right as a text button: Revoke on a token, Remove on a passkey.
- **Thread: no "?" pill.** A row with no where is under All only, and its
  meta is just its age.
- **Catalog: tasks at be57bea.** Its asks carry when they were started (else
  filed), so Home's task cards show their age.
- **Home per its board: Your call and Thread.** Ask cards lead with a bold
  title (up to three lines), and past four the rest fold under "N more", so
  Home stays a glance. Thread rows say where in words ("Slack DM · Patrick
  Kells", "Discord #pond", "Wake", not `slack:dm:patrick-kells`). Its pills
  are each agent when there's more than one, then each place things happened.
  The tape and the household pages say where the same way.
- **Catalog: shuttle at 3893774.** Bridges and Subscriptions per their
  boards: a status row a bridge, Talking now, conversations with initials;
  usage meters, logins with how long each is good for and Renew when one
  runs out, accounts as cards with their credentials under Machine details.
  Also carries shuttle#4: a body that never shows is retried or held and
  paged, never dropped.
- **One stat alone is a hero.** A `stats` block with a single item renders
  full width at the boards' top size (the Clock's "Art wakes next 9:30"), with
  its detail line under it. Two or more are the grid, as before.
- **Catalog: box at 7fbba5d.** Boxes per its board, with Sessions first: each
  agent's box session and house session, their claude.ai links (talk to them
  from the Claude app) and one-tap up/down; a card per box with its houses;
  services with Restart. The agent form keeps tailnet grants.

- **Catalog: tasks at 0be3242.** The Tasks piece per its boards: Open · Blocked ·
  Done counts and pills, the owner's tasks first ("waiting on you"), agent
  marks, the description as prose, Mark done (with Undo) and a Reply box.
  Three stats sit in one row on a phone.

- **A table on a phone is compact rows, like the boards.** Column 1 is the
  title, a short column 2 sits on the right, the next two make one "label
  value · label value" line, and the rest is under "more" — instead of a grey
  card of label/value pairs per row. Every piece's tables (Clock's schedules,
  Boxes' services, Subscriptions' logins, Bridges' conversations) get it.
  A long stat value wraps at a smaller size instead of being cut off.

- **The scope moves to a pinned header.** On a phone the top bar now stays at
  the top of every page: the wordmark (or the way back) on the left, and on
  the right a pill with who you're looking at (Household, or an agent), which
  opens the scope sheet. The bottom bar is Home · Places · Find · Setup.

- **A person's page, per the Person board.** Under their name, their summary
  (or role); then how each agent knows them, one row per agent with its mark
  (every agent, "Hasn't met them" included); then Reach, a value per channel,
  with where each came from a tap away. Household pages now hand their agents
  to the renderer, so marks show wherever a row names one.

- **A memory's page, per the Memory board.** Under the memory: where it was
  learned, when it was first written, how often it's been recalled, and who
  it's about. Then its history, newest first: what it says now and each
  earlier body back to the first, as a timeline. The raw record moves behind
  "Machine details".

- **Knowledge pages and memories read as written.** A new `prose` block
  renders markdown (markdown-it, raw HTML off: HTML in a body is shown as
  text, never run; links only to `http(s)`; no images). A knowledge page's body is one prose
  block, not 1900-character slices.

- **Closer to the design, page by page.** A page below the top says where its
  back link goes ("‹ Knowledge", "‹ Mind"); an agent's own tabs carry the way
  around instead. Knowledge has a search field (a new optional `search` on the
  `filters` block, `?q=`), a "Needs a check · N" pill, and rows that say how
  fresh they are ("verified today", "unchecked for 41 days" in the warn tone).
  A knowledge page's body breaks between paragraphs, never mid-word. The
  Pieces page lists hand-installed pieces as one quiet list and counts what's
  installed. Places ends in Knowledge and People side by side and a Manage
  pieces link; the scope sheet counts what waits on each agent. A list row's
  meta is in the body font (mono is for machine text).

### Fixed

- **Catalog: box at c0a3751.** A tailnet grant must name a `tailscaled.sock`, with
  no `.` or `..` in its path.
- **Catalog: box at cce6357.** A house can use a box's tailnet when the owner
  grants it (`loom box agent … --tailnet fleet=/run/…/tailscaled.sock`).
- **Catalog: box at a3c7341.** Every house now runs with `--init`, so orphaned
  processes are reaped. Without it the bridges' houses filled their 2048-pid
  limit with zombie `git` and could no longer start a reply (2026-10-26).

### Added

- **"Still true" on a knowledge page.** One tap verifies it (knowledge_verify,
  outcome confirmed, as the owner): the verified date moves, which is the
  clock the nightly freshness pass reads.
- **Initials on the People list.** A list item may carry `avatar` (one or two
  letters), drawn in a plain circle; the household's People list gives each
  person theirs.

- **Setup, apart from Places.** A piece's tab can say `"kind": "setting"`
  (rarely visited: adding a box, a subscription, a secret); it goes under a
  new Setup tab in the bottom bar (a sheet, with Manage pieces and Passkeys)
  and a Setup group in the desktop rail. Places keeps the everyday ones beside
  Knowledge and People. Pieces that don't say get the catalog's default
  (`kinds` in assets/pieces.json: box, secrets, subscriptions).

- **Push for Your call.** Turn it on per device on the Passkeys page (https;
  on an iPhone, loom added to the Home Screen first). Each minute one of
  loom's listeners checks Your call and announces what's new, once; a tap
  opens Home at that ask. Subscriptions live with their session and go when
  it does; loom only sends to https endpoints on known push services, and the
  payload is encrypted to the browser. New dependency: web-push.

- **Undo on a message.** An action result may carry `"undo": {"action",
  "label"?, "fields"?}`: the message gets an Undo that posts that action back
  to the same piece, with the same anti-forgery token (it's an ordinary form,
  so it works without script too). loom's own: archiving a memory is undone by
  a new `restore` action.

- **Details open as a sheet on a phone.** Tapping a details row brings its
  blocks up in a bottom sheet (moved there, not copied, and back on close);
  an action taken in it closes the sheet. A desktop expands it in place.

- **First run and empty pages say something.** A household with no pieces
  yet says who's listening ("Art E Fish and Mark are here and listening. Add
  pieces to give them hands.") and offers two catalog pieces to install
  right there. A page with nothing on it says whose it is: "Tasks has nothing
  yet.", under its intro.

- **Find is a palette.** ⌘K (or the Find tab, or "Find anything") opens it
  over the page; results follow the typing, grouped **Do** (asks that
  match), **Go to** (places, knowledge pages, people) and **Memories** (the
  scope's agents), the match in bold. Arrows walk them, Enter takes the first.
  `/find?q=` is the same, as a page.

- **An agent's Mind, People and Setup wear its head.** Its mark and name and
  the Today · Mind · People · Setup tabs, the current one marked, in place of
  the page title (the tabs cap their width on a desktop).

- **loom's page installs as an app.** A manifest, icons and a service worker
  (on https, or localhost). Each page loom shows is kept; when loom can't be
  reached the last copy opens under "Offline · from 7:42 AM — what you see
  is 2 hours old", statuses go hollow, and actions read "needs connection"
  until it's back. A live page that loses the network says the same. A page
  that was never opened here says so, and never shows another page in its
  place. Nothing is kept from the sign-in pages or a page carrying a
  one-time message (a token), and signing out — or the session ending —
  drops every copy (`Clear-Site-Data` too).

- **The page acts in place.** With script, a form or button posts with
  `fetch` and the answer is a toast above the bottom bar (labeled with its
  piece; `"keep": true` on an action result holds it, for a token shown
  once), the page refreshing under it without moving. A `danger` button asks
  first in a sheet that names it and says what happens (a new optional
  `confirm` sentence on a button). Live pages re-fetch themselves every 20s
  instead of reloading: new asks go in at once, new Thread rows wait behind
  an "↑ N new" pill, and the footer says "live · checked 4s ago". A live
  check doesn't count as a new look. Without script, it's the old full-page
  post and meta refresh.

- **Home, redesigned.** The household Home leads with "N need you" and the
  count new since you last looked (a look within 15 minutes of the last one
  doesn't move the line). Your call cards, At a glance tiles (a swipeable
  strip on a phone, a 2-up grid beside the Thread on a desktop), the Thread
  of the last day with agent marks, an All/agent filter and a "seen up to"
  divider, and Shared (knowledge and people). An agent's `/a/<agent>` is now
  its Today: its mark, Today · Mind · People · Setup tabs, its own asks,
  tiles and thread.

- **Scope reaches pieces.** With an agent selected, loom runs pieces with
  `LOOM_SCOPE=<agent>` (manifest, page and action alike, the manifest cached
  per scope). A manifest may declare `"scope": true`; a piece that doesn't is
  shown under one line: "Showing the whole household — this piece can't
  narrow to <agent>."
- **Agent marks on rows:** a list item may name an `agent`; it carries that
  agent's mark in place of its tone glyph.
- **Asks may carry `tone`, `at` and `agent`** (for the redesigned Your call
  cards).

### Changed

- **The app shell** (the redesign's phase 2a). On a phone: a bottom bar, the
  scope chip, Home, Places and Find, with the active tab a pill. On a wide
  screen: a left rail, with the wordmark, the scope selector, Find (⌘K), Home
  with its count of asks, Knowledge, People, the Pieces group with a tone
  glyph beside any piece in trouble, Manage pieces, and the owner, Passkeys and
  Sign out at its foot.
- **Scope:** a sheet (`/scope`) lists Household and each agent with its mark,
  plus New agent. Choosing one sets it (a cookie) and goes to its home; Home
  follows the scope. **Places** (`/places`): every piece's tab with its tile
  value or tone, then Knowledge, People and Manage pieces. **Find** (`/find`):
  go to any place by name. Sheets open in place with script and work as pages
  without it.
- **Agent marks:** an initial on a color that differs in lightness, from a
  palette in order, or from `marks` in household.json. The household's mark is
  a woven 2x2 of ink and the agents' colors. Account controls moved out of the
  page header into the scope sheet and the rail's foot.

### Changed

- **The page's new look, phase 1** (Claude Design's handoff, 2026-10-26):
  Instrument Sans and JetBrains Mono, served by loom itself (OFL, `/fonts/`;
  CSP `font-src 'self'`), the warm ground and lime "thread" accent, light and
  dark. Tone is a shape and a word as well as a color (● ▲ ◆ ○, named for
  screen readers). Every block re-rendered to the design: a toned section tints
  only its header band; stats as tiles; rows, not cards; tables stack into
  cards on a phone; long kv values drop below their label; long text clamps
  with More; external links show their domain; choices of four or fewer are a
  segmented control; buttons lime / raised / danger-outlined; meters, code and
  status as drawn. Home leads with Your call, before the tiles, at every width.

### Added

- **Three blocks: `meter`, `code`, `status`** (docs/extensions.md). A usage
  bar with its percent; monospace text with a Copy button; a row per thing
  that's up, down or stale, with a colored dot.
- **A page's own `refresh`** (2 to 300 seconds), honored even with a form on
  the page. The Pieces page uses it while an install runs, so it shows the
  install finish without a manual reload.
- **loom's own script on every page** (`/app.js`, CSP `script-src 'self'`,
  never inline). Today it's the Copy button; it's where the page's app
  behavior goes. Pieces still can't put script on the page: theirs is data.

### Changed

- **The header on a phone:** the brand with Passkeys and Sign out on one row,
  the tabs in one scrolling row under them, and no clock.

### Added

- **Passkeys for loom's page** (docs/specs/passkeys.md). Sign in once with a
  token or a link, add a passkey on the new Passkeys page, and after that
  *Sign in with a passkey* is one tap and Face ID, a fingerprint or a PIN.
  Discoverable credentials with user verification, ES256/EdDSA/RS256,
  verified with node:crypto (no new dependencies). A passkey signs in as the
  token whose session added it, only while that token is live; its counter
  must go up; it can be removed from the page. Passkeys work at
  `LOOM_PUBLIC_URL` (https, or http://localhost). Only the sign-in and
  Passkeys pages allow a script, loom's own `/login/passkey.js`.

### Fixed

- The page's integration tests no longer see the host's own managed pieces
  (they run under their own `LOOM_HOME` and `XDG_CONFIG_HOME`).

### Changed

- **The catalog's shuttle is d8f5a8a** (shuttle#2, #3): its subscriptions broker
  names its client on every call, and its check fails when a refresh does. Cloudflare blocks Python's default
  User-Agent, so before this, a Claude session login was never refreshed.

### Fixed

- **A managed piece runs on the node it was installed with.** npm builds a
  piece's native modules (taskstore's better-sqlite3) for the node it runs on;
  the daemon's `PATH` may find another (`/usr/bin/node` 20 beside mise's 24).
  `piece.json` records that node, and loom puts its directory first on the
  piece's `PATH`, for its services too.

### Added

- **The pieces catalog has box, secrets, shuttle and tasks**, each pinned to its
  merged commit, so a fresh loom installs all three from the Pieces page.
- **A package with several `loom-<name>` bins** (shuttle's `loom-shuttle` and
  `loom-subscriptions`) names its piece with `loom.name`; the other bins are
  part of it and run with its environment.

### Added

- **Managed pieces: `loom pieces install | update | rollback | remove | set | catalog`**
  (docs/specs/pieces-install.md). loom installs a piece itself, from its
  catalog (`assets/pieces.json`, each pinned to a commit) or with
  `--from github:<owner>/<repo>#<commit> --yes`, as an npm package into
  `$LOOM_HOME/pieces/<name>/`. Managed pieces are found before `PATH`, run with
  their own `LOOM_PIECE_NAME`, `LOOM_PIECE_HOME` and declared settings, keep the
  version before for `rollback`, and leave what was current untouched when an
  install fails. Unmanaged pieces on `PATH` work as before.
- **The Pieces page** (`/pieces`, in the nav): installed pieces with their
  settings form, *Update*, *Roll back* and *Remove*; the catalog with
  *Install*; and *From GitHub*, a repo and a commit behind a preview and a
  plain warning. Installs run in the background. A managed piece missing a
  required setting is listed under "Your call" on Home.
- **Piece services.** A service a managed piece declares becomes a systemd
  user unit, `loom-piece-<name>-<service>.service`, run with the piece's own
  environment (`service.env`), restarted on failure, and on an update, a
  rollback or new settings, and removed with the piece. `keepChildren: true`
  is `KillMode=process`. Without a user systemd, install says how to start it
  by hand.

- Add an owner-only next-mode operation to change scoped member agent ownership, refreshing open windows immediately.

- Add the owner-only `household.setMemberProjects` operation to replace one member's project assignments atomically and refresh open windows.

- Add owner-only next-mode registration of existing agent contexts with atomic retries and live household updates.

- Add next-mode household member management with atomic first-owner credential bindings and immediate access refresh.

- Add the opt-in generated `loom-household` API client for next-mode member, agent and project administration.

- Add owner-only next-mode `household.show` and generated `loom-household show` JSON summary.

### Settings

- Add the new Settings app for secrets, pending requests, grants and household piece configuration links.

- New-side household token/session administration and generated `loom-token`/`loom-sessions` clients: safe lists, one-time minting, scoped session revocation and atomic passkey/device compromise cascades.
- Give the next desk app-tinted cut frames, the icon dock, a searchable launcher and a live owned-agent rail.

- Household Setup now manages tokens and sessions, with single-send browser token creation and private one-time bearer display.

- Record token and session last use on the new side, including activity in open windows.

- Add owner-controlled agent creation in next Setup, with portable creed/rules, recoverable context publication, first-token selection and an explicit next-mode harness snippet.

- Fresh next-mode households publish a complete default assistant context before first sign-in, with exclusive filesystem recovery on failed initialization.

- Add a private Your account app for named passkey registration, confirmed passkey/cascade removal and signing out individual browsers, with Live records and a generated `loom-account` client.

- Add row-backed agent profile descriptions to Setup, with owner edits/requests, scoped Live records and once-only authenticated agent replies.

- Add Account and Setup device sign-in links that inherit the source browser’s original sign-in time.

- Let the next-side service worker show content-free push notifications and open their signed-in destinations.

- Add next-mode member-private notification device operations with cookie-bound registration and persistent removal; Account controls and delivery remain pending.


- Account can register this browser for notifications and remove its own live notification devices, with confirmed removal and original-request retries. Sending remains pending.

- Add staged, durable own-device test notification sending in next mode; Account test controls and routine announcement dispatch remain pending.

- Account can queue a test notification for an exact device and follow private Live outcomes, preserving uncertain retries across navigation. Push acceptance is shown separately from device delivery.

- Add an explicit external Claude worker for unbound next-mode jobs, with authenticated stop/history polling and no automatic retry after uncertain execution.

- Require durable, wordless attempt receipts for the external Claude worker; preserve uncertain actions across restarts and add read-only receipt inspection.

## [0.16.1] - 2026-10-25

### Fixed

- **`loom token link --page-url <url>`** (was `--url`, which is loom's own
  global flag for remote mode, so the documented command refused to run).

## [0.16.0] - 2026-10-25

### Added

- **One-time sign-in links for the page: `loom token link`.** The CLI on
  loom's machine prints a link that signs a browser in once, within 10
  minutes (`--minutes`, up to a day), with no token to paste. Opening it shows
  a button; only the button's POST signs in, so a chat's link preview can't
  spend it. Its sessions belong to one owner token, "page sign-in links":
  revoke that and they all end.

### Fixed

- **A restart no longer signs everyone out of the page.** Browser sessions
  were kept in memory, so every daemon restart (a deploy, a reboot) ended
  them. They're on disk now (`ui-sessions.json`, 0600, beside
  household.json, ids kept only as hashes) and shared by every loom-http
  process on the machine, and the anti-forgery key is persisted too, so a
  form opened before a restart still posts after it.

## [0.15.0] - 2026-10-25

### Added

- **`loom person evidence <slug> [--since <iso>]`**: the memories a person
  card condenses (active, unexpired `user` and `feedback` memories tagged
  `metadata.person`, oldest first), with `--json`. It runs over the network
  like the other store verbs, so a synthesis lane no longer has to open the
  memory database file itself.
- **`loom knowledge list [--domain d]`**: every active page's freshness
  fields (slug, title, domain, created, `verified_at`, `freshness_anchor`,
  `sla_class`), no bodies, with `--json`. A listing, not a read: it doesn't
  count as an access. What a verification sweep picks from, over the network.

## [0.14.1] - 2026-10-25

### Changed

- **A piece's API answer may be up to 8 MB** (was the page's 512 KB).
  An API answer is data for a program, not a page for a person: a work
  store's whole export (taskstore's is 2.7 MB gzipped) has to fit. Pages keep
  512 KB.

## [0.14.0] - 2026-10-25

### Added

- **The piece API** (docs/extensions.md, "The API"). In a household,
  `POST /api/<piece>/<path>` runs `loom-<piece> api --json` with
  `{caller, path, body}` and passes the piece's `{status, body}` back. It's for
  callers that aren't a browser: a box calling home to the runtime piece, a
  body asking for a house. POST, JSON and no Origin, like `/cli`. It has its
  own pool (four running, eight waiting, then 503), so a flood can't starve
  the page.
- **Piece credentials:** a token role `piece:<piece>/<subject>`
  (`loom token create --piece box/thor`). It reaches only its own piece's
  API, as its subject: no MCP, no `/cli`, no page, no other piece.

### Security

- The household daemon's caller resolution now handles every role kind by
  name, and refuses anything that isn't one of them. Before this, a role
  kind it didn't know would have been served as the owner.

## [0.13.1] - 2026-10-24

### Changed

- **Bundles are gzipped** before they're encrypted, which makes a real
  household about a third of the size (40 MB down to about 13 MB). `loom restore`
  still reads the uncompressed bundles that 0.12 and 0.13 wrote.

## [0.13.0] - 2026-10-24

### Added

- **The household page** (docs/specs/household.md, phase 4). In a
  household, the page is the owner's view of all of it:
  - **Home:** every agent (what it's doing, from its tape), the tape across
    all of them, and the commons.
  - **Knowledge:** the commons' pages, by domain.
  - **People:** the directory, with every agent's relationship to each
    person, and who changed the shared entry.
  - **`/a/<agent>`:** that agent's view, plus **Setup**: its identity
    (read-only), its tokens (make one, shown once; revoke) and health.
  - **Add an agent:** creates its stack and its first token.

  A daemon now re-reads household.json as it changes, so a new agent is
  served at once. The old single-agent addresses (`/mind`, `/memory/…`)
  land on the default agent's view. A plain context dir keeps the
  single-agent page.

## [0.12.0] - 2026-10-24

### Added

- **The bundle: the household on a USB stick** (docs/specs/household.md,
  phase 3).
  - **`loom export --to <file> --recipient <age1…>`** writes the whole
    household into one file, encrypted with age to the owner's key: its
    files and tokens, the commons, every agent's directory (SQLite through
    the backup API), and each piece's own part (`loom-<piece> bundle export`,
    encrypted by the piece).
  - **`loom restore <file> --identity <key>`** lays it down in an empty
    LOOM_HOME and hands each piece its part (`bundle import`). A piece that isn't
    installed keeps its part in `pieces-pending/`.
  - **`--drill`** restores into a throwaway directory and compares it with
    the live household, touching nothing live.
  - **A plain context dir** exports as a household of one, and restores as
    one with its cards split.

## [0.11.0] - 2026-10-24

### Changed

- **The household, phase 2b: one directory entry per person, a relationship
  per agent.** In a household a person card is kept in two places:
  - **The directory** (`commons/people.db`): name, handles (`where`), and
    the facts in `how` (`tz`, `timezone`, `pronouns`, `languages`), shared
    by every agent.
  - **Each agent's relationship** (its own `memories.db`): the summary, the
    rest of `how` (how *this* agent talks to them) and `may`.

  How it behaves:
  - A read merges the two halves into one card, rendered exactly as before.
  - A write splits by field. Both halves are rehearsed in memory first, so
    a write either half would refuse changes neither.
  - Revisions record the agent that made them (`person_revisions.actor`),
    and `person_history` says which half each revision came from.
  - "Memories newer than the card" counts each agent's own memories.

  Moving in:
  - `loom household commons` and `init` split an existing agent's cards,
    checking first that every card still renders the same text. Running it
    again is safe.
  - A household daemon refuses to start with cards that haven't been split.
- **The household, phase 2a: knowledge is the commons.**
  - In a household, every agent reads and writes `commons/knowledge.db`.
  - `loom household init` moves the first agent's knowledge there.
  - `loom household commons` moves it for a household made before this
    release. It checkpoints the WAL first, and must run with every daemon
    stopped.
  - A household daemon refuses to start while an agent still has its own
    `knowledge.db`, so the knowledge base can't quietly fork.
  - A plain context dir keeps its own knowledge, as before.

## [0.10.0] - 2026-10-24

### Security

- **`harness_init` could write any file the daemon's user can.** Its
  `target` was a free path and the harness name could carry newlines, so any
  MCP caller could append to another agent's `IDENTITY.md` or plant a command
  in a shell rc file. Over HTTP the target is now refused: it names a file on
  the server, never the caller's. Locally it must be a harness instruction
  file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …), judged at its real path.
  Names refuse control characters, and managed-block writes use a random,
  exclusive temp file. Found by the security review of the household work.

### Added

- **The household, phase 1: one loom, several agents**
  (docs/specs/household.md).
  - `$LOOM_HOME/household.json` lists the agents and the default, and
    `tokens.json` holds every token by sha256 with a label and a role.
  - **Roles:** `agent:<name>` is MCP and `/cli` as that agent's stack only.
    `owner` gets the default agent, another at `/agents/<name>/`, and the
    page. `peer:<name>` gets knowledge tools only.
  - **On every request** the daemon resolves the role and builds the
    session's server over that agent's context dir. A session stays pinned
    to the role and agent it opened with, and a revoke takes effect on the
    next request.
  - **New commands:** `loom household init|add|show` and
    `loom token create|list|revoke`.
  - **Nothing changes for one agent:** a plain context dir is a household of
    one and behaves exactly as before.

## [0.9.2] - 2026-10-24

### Fixed

- **Logging in to the page (and every form on it) failed in a browser with
  "forbidden: cross-site request".** The page was served with
  `Referrer-Policy: no-referrer`, under which browsers send `Origin: null` on
  the page's own form posts, and the cross-site guard refuses that. It's
  `same-origin` now, which still sends nothing to links that leave the page.

## [0.9.1] - 2026-10-24

### Changed

- **loom's page is at the root.** `/`, `/mind`, `/people`, `/memory/<ref>`,
  `/p/<piece>/…`, `/act/<source>`, `/login`, `/logout` and `/pieces.json`.
  The old `/ui/…` addresses redirect (308) to the same page. MCP still
  answers everywhere else, and at `/` for a POST, a request with an MCP
  session, or an event-stream GET. The session cookie's path is `/`.

## [0.9.0] - 2026-10-24

### Changed

- **loom's page, v2.** Home is now the tape: the last day's episodes grouped
  by hour and filterable by where they happened, with tiles across the top
  and top of mind and the people who need a look beside it. **Mind** lists
  every memory by heat, marks exactly what the boot digest carries, and says
  why each one has its heat. Pending proposals moved there, with ratify and
  reject. One memory and People (each card, with what's newer than it) are
  their own pages.
- **The page contract, v2 (docs/extensions.md, "The page").** A piece answers
  `ui --json` with a manifest (a tab, a Home tile, "Your call" asks),
  `ui page --json` with pages, and `ui act --json` to run actions. New blocks:
  `kv`, `callout`, `filters`, `details`, `form`, `buttons`. Links can stay in
  the piece, go to loom's pages, or carry a query. A first-version
  `{sections}` answer still renders, as the piece's page.
  - **Actions:** a form posts to `/ui/act/<source>` with an anti-forgery token
    bound to the session cookie. Cross-site posts are refused. Fields go to
    the piece on stdin only, and the result shows once without touching the
    URL. A `secret` field never carries a value.
  - **Sessions:** the cookie is now a random session id held in memory, and
    signing out revokes it. Another site (or another port on the host) can
    link to the page but not embed or fetch it. At most 6 pieces run at
    once, and nothing a piece starts outlives its answer.
  - **`/ui/sections.json` is gone;** `/ui/pieces.json` lists the installed
    pieces' manifests, for scripts.
- **Top of mind reads heat live.** The boot digest and the page compute each
  memory's heat from its timestamps when read, instead of trusting the stored
  field the consolidation lane refreshes. Between passes the stored field went
  stale, and Top of Mind fell back to write order.
- **Recall adds heat by rank instead of resetting every result to full heat.**
  One vague query used to put ten unrelated memories at the top of mind. Now
  the top result gets 0.5, the next 0.3 and 0.2, and the rest 0.1, decaying
  on the memory's half-life and capped at 1. A write, an update or a repeat
  remember still makes a memory fully hot. `last_accessed` still records
  every look, for pruning. New columns `recall_heat` and `recall_heat_at`
  (migration `add_recall_heat`) start at 0.

## [0.8.0] - 2026-10-24

### Added

- **loom's page: `/ui` on the HTTP daemon.** A read-only web page with loom's
  own sections: top of mind, the last 24h of episodes, proposals waiting, and
  people. It also gets a group for each installed piece that answers
  `loom-<piece> ui --json` in a small section vocabulary (stats, list, table,
  text, link). Pieces send data, never markup: everything is escaped, the page
  has no script, and a CSP forbids script and framing. Invalid answers are
  dropped whole, and a slow or missing piece is left out.
  - **Login:** the bearer token, once. The page requires `LOOM_BEARER_TOKEN` (no
    token gives 403, like `/cli`). The cookie is keyed per daemon process, isn't
    the token, and lasts 30 days or until a restart. Pieces never see loom's
    tokens; on a timeout their whole process group is killed; concurrent loads
    share one run per piece.
  - **`/ui/sections.json`:** the same data, for scripts.
  - **Scope:** full scope only.

## [0.7.0] - 2026-10-24

### Added

- **Pieces: `loom <piece>` dispatches to `loom-<piece>` on PATH, and `loom
  pieces` lists them.** loom's command namespace now reaches separate,
  swappable extensions (tasks, secrets, a wake clock, …) the way `git` reaches
  `git-<cmd>`. loom never links them, and they never write loom's stores. Core
  commands always win, piece names are validated before PATH is searched,
  loom's env passes through unchanged, and the piece's exit code comes back.
  The tiers, the rules (alone, composes without requiring, a contract per
  role, no secrets in argv) and how pieces meet through named seams are in
  `docs/extensions.md`.

## [0.6.0] - 2026-10-24

### Added

- **CLI remote mode: `--url` / `LOOM_URL`, and `POST /cli` on loom-http.**
  The store verbs (`wake`, `recall`, `remember`, `update`, `forget`, `memory`,
  `knowledge`, `person`) can run against a daemon instead of a local stack,
  for hooks and scripts on a host or in a container where loom lives
  elsewhere. The CLI ships argv and stdin to `POST /cli`; the daemon runs the
  same CLI on its own stack and returns stdout, stderr and the exit code, so
  output and `--json` match a local run by construction. The bearer token
  comes from `LOOM_TOKEN_FILE`. The endpoint is full-scope only, needs
  `LOOM_BEARER_TOKEN` set, refuses browser requests (an `Origin` header or a
  non-JSON body), and sits behind the same bearer gate and payload cap as
  MCP. It takes only those verbs (minus `memory recompute-salience` and
  `memory recall-stats`, which have no MCP tool), refuses `--context-dir` and
  `--url`, and passes only `LOOM_CLIENT`/`LOOM_MODEL` through from the
  caller's env.

- **Person cards: `people` + `person_revisions`, eight `person_*` tools,
  `loom person show|list`, and identity's `people` param.** A card is the
  condensed current state of one human the agent works with: `where` fields
  carrying a freshness marker (`[ok]`, `[unverified]`, `[STALE <n>d]`), `how`
  fields (time zone, mode, who to loop in), descriptive `may` entries each with
  a source, and a short agent-written summary. One value per field,
  overwritten in place; every stored change snapshots the previous row (newest
  10 kept), and every mutation is one `BEGIN IMMEDIATE` transaction. Cards are
  not an authorization surface: the harness's gating names (`tier`, `field`,
  `projects`, `scope`, `trust`) are rejected anywhere on a card.
  `identity({people: [slug, ...]})` adds an `# In the room` block after the
  tape (≤ 4 cards, 6,500 chars, best-effort). The dossier now says worker
  bodies must not write cards. Design and acceptance criteria:
  `docs/specs/person-cards.md` (criteria 1–12; the misfile heuristic, 13, is
  still to come).

- **Knowledge actor attribution: `pages.author`, `page_revisions.actor`, and a
  `verifications` table (page_id, verifier, verified_at, outcome,
  citation_checked).** Previously the only attribution field was
  `created_by` — free text, meaning "who owns this `ours/` artifact," not
  "who actually wrote or verified it" — so there was no way to tell who wrote
  a page's first version, who performed a given body revision, or who has
  verified a page and found what. `pages.author` is stamped once at creation
  and never changed by later upserts; `page_revisions.actor` is stamped on
  every body-replacing write and every history-restore; `verifications` is an
  attributed audit trail additive to the existing `pages.verified_at` stamp
  (which stays as the fast single-column freshness field everything else
  sorts/filters on). All three are resolved server-side, never a free-text
  tool argument, so no caller can claim another identity's authorship or
  verification: MCP calls use the connection's identity from
  `registerKnowledgeTools` ('art' on the main server, the bearer-resolved
  identity on the knowledge-only service); the CLI and eurorack import use
  `resolveIdentityName()` (`LOOM_IDENTITY` env override, else the context
  dir's real basename).
  `knowledge_verify` gains `outcome` ('confirmed' | 'stale' | 'corrected') and
  `citation_checked` parameters; `knowledge_history`'s listing now shows who
  performed each revision and surfaces the page's verification history. (t-675)
  An outcome of 'stale' is a failed verification: it is recorded in
  `verifications` but does NOT advance `pages.verified_at`, so a known-wrong
  page keeps its place at the front of the stale-first queue; the result's
  new `stamped` flag (and the tool output) says whether the stamp moved.

- **`MemoryMatch` carries `similarity` alongside `relevance`, and `scope`
  alongside `project`.** `relevance` is now the post-MMR score that actually
  decided a result's rank — equal to `similarity` (raw cosine) unless MMR
  re-ranking traded a pick off against ones already selected, in which case
  the two now diverge and both are visible (modeled on MemoriLabs/Memori's
  `FactSearchResult.{similarity, rank_score}` split). Separately, every
  memory now has an effective `scope` ('project' or 'global'): `recall` and
  `memory similar` exclude a project-scoped memory tagged to a *different*
  project than the one passed via `--project`/`project`, while global-scoped
  memories (category default for `user`/`reference`, any untagged memory, or
  an explicit `scope: "global"` at write time) still come through regardless.
  Closes the gap where a preference learned on one project could surface
  while working on an unrelated one. `remember` (MCP tool and `loom remember
  --scope`) takes an explicit `project | global` override for the categories
  where the category default can't tell (`self`, `feedback`) — e.g. a
  security/git/tool-workflow lesson learned in one project but true
  everywhere. (t-337)

### Fixed

- **All 34 MCP tools now declare `ToolAnnotations`** (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client gating
  approval on these hints (e.g. Codex under `approval: never`) can tell a
  read from a write instead of refusing every call uniformly. Hints follow
  actual behavior, not tool-name conventions: `recall`/`knowledge_recall`
  are NOT read-only (they stamp `last_accessed`/`hit_count`, which
  `knowledge_maintain` reads to find cold pages); `knowledge_history` and
  `memory_revision_restore` are destructive in their restore mode even
  though the displaced body is snapshotted first. `update`,
  `knowledge_write` and `knowledge_move` are NOT idempotent: a repeated
  `observation` bumps the evidence count again, a repeated append stores
  the body twice, and a repeated prefix move into a child of itself
  (`music` → `music/gear`) nests again. `openWorldHint` is
  `false` everywhere — loom has no outbound network calls. This does not
  by itself prove any client relaxes its approval gate on these hints; that
  needs a live `tools/list` exchange against an updated server (tracked
  separately). (t-415)

- **`--context-dir` (and the other global flags) now work in front of the
  subcommand, as the help text has always claimed.** `loom --context-dir DIR
  knowledge write …` used to route to the stdio MCP server instead of the CLI:
  the entry point dispatched on `argv[2]`, which was `--context-dir`, not a known
  verb. The server read an empty stdin and exited 0, so a *write* verb reported
  success having never entered the write path — and never even reached argument
  validation, exiting 0 on an invocation that the working flag order rejects with
  exit 1. Measured against a disposable context dir: no `knowledge.db` was created
  and no row was written. Both entry points now resolve the subcommand past any
  leading global flags, skipping flag values in pairs so `--context-dir recall`
  still names a directory rather than invoking `recall`. Bare
  `loom --context-dir DIR` with no subcommand remains the MCP path. (t-665)

## [0.5.0] - 2026-09-04

### Changed

- **npm package renamed `loomai` → `@jbarket/loomai`.** The registry refused the
  unscoped name on publish: `403 Forbidden — Package name too similar to existing
  package loom-ai`. `loom-ai` is an unrelated, apparently abandoned package
  (0.1.1, 2026-06-03), and npm's similarity check is mechanical and applies only
  to unscoped names — so there is no appeal and no unscoped name in this family
  that is safe from it. Scoping settles it permanently. Nothing else moves: the
  brand is still `loom`, the CLI is still `loom`, the MCP server is still `loom`,
  the repo is still `sleepunit-agents/loom`. Only the install word changes:
  `npx loomai install` → `npx @jbarket/loomai install`. No version has ever been
  published under either name, so no installed tree anywhere needs migrating.

### Security

- **The `fastembed` dependency is gone; its ONNX runtime is vendored.** Six
  open Dependabot alerts (one critical, `GHSA-23hp-3jrh-7fpw`) all came from a
  single path: `fastembed@2.1.0` pins `tar: ^6.2.0`, and the 6.x line carries
  twelve unpatched advisories. `Anush008/fastembed-js` was archived on GitHub
  on 2025-12-15, so no upstream fix is coming, and an `overrides` bump to
  tar 7 does not work — fastembed does `import tar from "tar"`, which tar 7
  (no default export) turns into a `SyntaxError` at import, killing loom
  before it starts. The ~200 lines loom actually used now live in
  `src/backends/embedding-runtime.ts`, depending directly on
  `onnxruntime-node`, `@anush008/tokenizers` and `tar@^7.5.22`. `npm audit`
  is clean and the dependency tree loses `progress` and `@huggingface/hub`
  (both only reachable from the unused sparse-embedding path).

  Embedding output is **bit-for-bit identical** to `fastembed@2.1.0` — vectors
  already stored in a `memories.db` stay comparable to new ones. Two upstream
  quirks are preserved deliberately and marked in the source: vectors stay
  `Float32Array` through normalisation (so rounding matches), and `queryEmbed`
  keeps its E5-style `query: ` prefix even though BGE does not use one.
  `src/backends/embedding-runtime.parity.test.ts` asserts this against golden
  vectors captured from the upstream package before it was removed.

### Fixed

- **A failed model download poisoned the cache directory permanently.** The
  vendored downloader checks the HTTP status and deletes the partial file on
  failure. Previously a 403 or 404 from the model bucket was written into
  `<model>.tar.gz` as if it were the archive; the next run saw the file
  existed, skipped the download, and failed in `tar` — forever, until someone
  cleared the cache by hand. The error now names the URL, the status, and the
  new `LOOM_MODEL_BASE_URL` override.

- **The test suite was counting three abandoned worktrees.** `vitest` collected
  `.claude/worktrees/**`, so stale copies of the repo ran against current
  `node_modules` and inflated the reported total from 950 tests to ~2600.
  Excluded in `vitest.config.ts`.

- **The npm release path could never have worked, and the docs said it had.**
  Three separate blockers, none of which had ever been exercised because no
  `v*` tag has ever been pushed and `release.yml` has zero runs:
  1. `package.json` still declared `repository.url`, `homepage` and `bugs` as
     `jbarket/loom`, but the repo moved to `sleepunit-agents/loom`. With
     `publishConfig.provenance: true`, npm validates the manifest repository
     against the building repository and refuses to publish on a mismatch —
     so the very first tagged release would have failed at the publish step
     after a full build and test run.
  2. There were no publish credentials of any kind — no `NPM_TOKEN` repository
     or organization secret — so `npm publish` would have failed with
     `ENEEDAUTH`. Rather than add a 90-day token to rotate forever,
     `release.yml` now publishes with **npm trusted publishing** (OIDC): the
     workflow authenticates as `sleepunit-agents/loom` + `release.yml`, there
     is no secret to store or expire, and provenance is attested from the run
     itself. This requires npm >= 11.5.1, which Node 22.x does not ship, so
     the workflow upgrades npm before installing. See `docs/releasing.md` —
     trusted publishing cannot perform a package's *first* publish
     ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first
     release has to go up by hand once.
  3. The README advertised **Node.js ≥ 20 ("tested on 20 and 22")** while
     `engines` requires `>= 22` and CI only tests 22 and 24. A reader on
     Node 20 following the README would have hit `EBADENGINE`.
- Stale `jbarket/loom` links across `README.md`, `CHANGELOG.md` and
  `docs/privacy.md` now point at `sleepunit-agents/loom`, including the
  `gh attestation verify --owner` example (which named the wrong owner and
  a version that was never published).
- The README install section now states plainly that `loomai` is not on npm
  and gives the working `npx github:sleepunit-agents/loom` form. Remove that
  note in the commit that cuts the first real tag.

- **Every packaged install of loom was a silent no-op.** The entry-point guard
  in `src/index.ts` compared `process.argv[1]` against `import.meta.url` as raw
  strings. `npm i -g`, `npm link` and `npx` all install the bin as a *symlink*
  into a bin directory, so `argv[1]` was the symlink path while
  `import.meta.url` resolved to the real file — never equal, so `main()` never
  ran. `loom --version` exited 0 printing nothing, and `loom serve` started no
  server. Only `node dist/index.js` worked, which is exactly what every test
  and every dev checkout does, so nothing caught it. Both sides are now
  resolved with `realpathSync` before comparing, and
  `src/entry.integration.test.ts` invokes the built bin through a symlink so
  the packaged shape is exercised in CI.

### Added

- **The onboarding interview is four questions, and `bootstrap` writes a real
  identity.** The interview now asks for the *user's* name as well as the
  agent's name, purpose line and voice line — and nothing else. In exchange,
  `bootstrap` no longer emits a six-line IDENTITY.md: it writes the full
  scaffold underneath the four answers (what a persistent agent is and where
  its continuity lives, the three memory tiers, the reflection loop, honesty
  about what it knows, delegation, and a "Working with <user>" floor).
  `preferences.md` is seeded with the user's name. New optional `user` param
  on the `bootstrap` tool and `loom bootstrap --user`; the loom-setup skill
  shows an example answer *before* each question. Rationale: the structural
  half of an identity is the same for every loom agent, so asking for it wastes
  the interview — handing over the architecture is a hypothesis the agent can
  falsify, handing over a personality would be a verdict. (Art, 2026-09-04)

- **MMR diversity re-ranking on `recall`** — after the vector search, the
  candidate pool (`max(limit*3, 12)`) is re-ranked with Maximal Marginal
  Relevance (`λ·relevance − (1−λ)·max cosine sim to already-picked`,
  λ = 0.7) so near-duplicate memories on a well-covered topic stop crowding
  out different ones. The top result is unchanged; with ≤ `limit`
  candidates nothing moves. New optional `diversity` (0..1, default 0.3 =
  1−λ) on the `recall` tool and `loom recall --diversity`; `0` reproduces
  the old ranking exactly. Idea from xai-org/grok-build's memory search
  (Apache-2.0; idea only, no code). (Art, 2026-08-28)

- **Recall observation log** — every `recall` appends one JSON line to
  `<context>/telemetry/recall.jsonl` (query ≤120 chars, filters, pool
  size, returned, topScore, MMR drops, latency, hit). Local-only, never
  throws, `LOOM_RECALL_LOG=0` disables. `loom memory recall-stats
  [--since 7d] [--json]` reads it back: counts, hit rate, median latency
  and topScore, the 10 most recent misses. (Art, 2026-08-28)

- **Episode tier** — `episode` memory category (48h TTL by default), the
  `episodes` MCP tool and `loom memory tape [--hours N]` CLI, and a
  "Last 24h across bodies" block in `identity` (after preferences, before
  Top of Mind). Short-term cross-body memory: what other sleeves did in the
  last day, time-ordered and unconditional. Episodes are excluded from the
  salience digest (they would always be hottest). (Art t-142, 2026-08-25)

- **Soft-archive tier** (`memory_archive` / `memory_restore` MCP tools;
  `loom memory archive` / `loom memory restore` CLI subcommands). Memories
  can now be soft-retired with a tombstone (note + `archived_at` timestamp)
  instead of hard-deleted. Archived memories are excluded from `recall`,
  `memory_list`, `memory_prune`, `find_similar`, and `memory_audit` but
  remain fully recoverable. The original body is preserved in the row;
  `memory_restore` returns a memory to the active set and wipes the tombstone.
  Existing databases are migrated automatically on first open (`ALTER TABLE`
  guards against re-running on already-migrated schemas).

## [0.4.1] - 2026-04-23

Stabilization release consolidating v0.4.0-alpha.1 through alpha.7.
This is the first externally-promoted release: `npx loomai install` is
the canonical Quick Start path.

### Added

- **`loom install`** — writes the bundled `loom-setup` skill into a
  target harness's skills directory. Flag-driven (`--harness <key>`) or
  interactive single-select TUI. Targets: `claude-code`, `codex`,
  `gemini-cli`, `opencode`, `other`.
- **`loom doctor`** — read-only probe reporting node version, stack
  version compatibility, context dir resolution, and per-agent git
  fields.
- **`loom inject`** — writes a marker-bounded managed section into
  harness dotfiles (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`) telling the agent to load identity via loom.
  Idempotent; re-running is safe.
- **`loom procedures list|show|adopt`** — CLI for procedural-identity
  seed templates (stack spec v1 §4.9). Ships 6 seed templates:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`.
- **`loom harness init <name>`** — scaffolds a harness manifest from
  the template (stack spec v1 §4.7).
- **Full CLI surface** — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, `serve`. Write commands take body via stdin or
  `$VISUAL`/`$EDITOR`. `--json` on any command emits structured output.
- **MCP tools** for procedures and harness init:
  `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init`.
- **Harness manifest block** (`harnesses/<client>.md`) and **model
  manifest block** (`models/<model>.md`) — loaded by `identity()` when
  `LOOM_CLIENT` / `LOOM_MODEL` resolve. Missing-manifest nudges emitted
  when set but absent.
- **Procedures block** (`procedures/*.md`) with seed nudge — emitted by
  `identity()` whenever `procedures/` is missing or empty.
- `LOOM_STACK_VERSION` file auto-stamped on server boot; startup
  refuses stacks ahead of what this loom understands.
- `LOOM_MODEL` env var + optional `model` param on the `identity` tool.
- Reusable `src/cli/tui/multi-select.ts` keyboard-nav checkbox
  primitive with `single: boolean` option.
- `src/install/names.ts` — canonical agent-name validation and
  reserved-names list.
- `assets/skill/SKILL.md` — bundled first-run setup skill.
- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, GitHub release with auto-generated notes.
  Pre-release tags flagged as prereleases. Requires `NPM_TOKEN` secret.
- `docs/privacy.md` — trust doc covering data locality (everything
  local, only outbound call is the first-run fastembed model
  download), the no-opt-out-telemetry policy, and a walkthrough for
  verifying release provenance via `npm audit signatures` and
  `gh attestation verify`. Linked from README and CONTRIBUTING.
- Stack spec §11 (Injection), §13 (Multi-agent layout), §14
  (Git-backed agent dirs).

### Changed

- **npm package renamed `loom` → `loomai`.** Brand (`loom`), CLI
  binary (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`.
- **License: MIT → AGPL-3.0-or-later.** Forks that modify loom and
  expose it over a network must offer source. Pre-alpha-1 releases
  remain MIT.
- `package.json` adds `publishConfig: { access: public, provenance: true }`
  and a `files` array so `assets/` ships in the published tarball.
- `loom bootstrap --name` validates against canonical name rules.
- `assertStackVersionCompatible()` called at MCP startup and every CLI
  command.
- README Quick Start rewritten around `npx loomai install` +
  `/loom-setup`.
- **`release.yml` switches to npm Trusted Publishing (OIDC).** Removes
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from the publish step.
  Auth is handled by the OIDC token exchange between GitHub Actions and
  npm — no long-lived secret required. Requires a one-time bootstrap
  publish and Trusted Publisher configuration on npmjs.com.

## [0.4.0-alpha.7] - 2026-04-22

### Changed

- **npm package renamed `loom` → `loomai`.** The unscoped `loom`
  name is taken by an unrelated package. Brand (`loom`), CLI binary
  (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`. alpha.6 was
  never published to npm; alpha.7 is the first release tag.
- `package.json` adds `publishConfig: { access: public, provenance:
  true }` so tagged releases publish with Sigstore provenance.
- README Quick Start + CLI examples updated to `npx loomai`.

### Added

- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → runs `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, then creates a GitHub release with
  auto-generated notes. Pre-release tags (`-alpha`, `-beta`, `-rc`)
  are flagged as prereleases on GitHub. Requires `NPM_TOKEN`
  repository secret.

## [0.4.0-alpha.6] - 2026-04-21

### Added

- `loom install` — CLI that writes the bundled `loom-setup` skill
  into a target harness's skills directory. Flag-driven
  (`--harness <key>`) or single-select TUI on a TTY. Targets:
  `claude-code`, `codex`, `gemini-cli`, `opencode`, `other`. `--to`
  overrides destination; `--force` overwrites; `--dry-run` /
  `--json` for scripting. The "other" target writes
  `./loom-setup-skill.md` in the current directory.
- `loom doctor` — read-only CLI probe reporting node version, stack
  version compatibility, context dir resolution, and enumerating
  existing agents under `~/.config/loom/*` with forward-looking
  `git: { initialized, hasRemote, dirty, gitignorePresent }` fields
  per agent. `--json` for scripting.
- `assets/skill/SKILL.md` — bundled skill that drives first-run
  setup inside the target harness: probe → interview → bootstrap →
  procedures adopt → harness init → MCP config edit
  (verify-before-write) → inject → wake verify. Never clobbers
  existing agent dirs; never proposes `--force`.
- `src/install/names.ts` — canonical agent-name validation plus
  reserved-names list (`current`, `default`, `config`, `backups`,
  `cache`, `tmp`, `shared`).
- Stack spec §13 (Multi-agent layout) and §14 (Git-backed agent
  dirs).

### Changed

- `loom bootstrap --name` now validates against the canonical name
  rules. Invalid or reserved names exit with code 2 and a specific
  error.
- `src/cli/tui/multi-select.ts` gains a `single: boolean` option
  (reducer + TTY adapter). Existing multi-select consumers are
  unchanged — the option defaults to `false`.
- `package.json` adds a `files` array so `assets/` ships in the
  published tarball alongside `dist/`.
- README Quick Start rewritten around `npx loom install` +
  `/loom-setup`. Per-command reference sections unchanged.

## [0.4.0-alpha.5] - 2026-04-21

### Added

- `loom procedures list|show|adopt` — CLI for procedural-identity seed
  templates (stack spec v1 §4.9). `adopt` supports positional keys,
  `--all`, `--force` overwrite, and an interactive multi-select picker
  (reuses the `src/cli/tui/multi-select.ts` primitive from alpha.4) on
  TTY. Idempotent by default.
- `loom harness init <name>` — CLI that scaffolds a harness manifest
  (stack spec v1 §4.7) from the template. Falls back to `--client` /
  `$LOOM_CLIENT` when no name is given. `--force` overwrites.
- `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init` — MCP tools mirroring the CLI. Thin wrappers over the
  same shared core; first-class way for an agent to respond to the
  procedures seed nudge or a missing-manifest warning in the identity
  payload without needing harness-native filesystem tools.
- Stack spec §11 lists Procedures + Manifests as a new adapter.

### Changed

- `src/blocks/procedures.ts` gains `adoptProcedures`, `listProcedures`,
  `showProcedure`, and `UnknownProcedureError` (additive — existing
  exports untouched).
- `src/blocks/harness.ts` gains `initHarness` (additive).

## [0.4.0-alpha.4] - 2026-04-20

### Added

- `loom inject` — CLI command that writes a marker-bounded managed
  section into harness dotfiles (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). The managed section
  tells the agent how to load identity via loom — prefer MCP
  (`mcp__loom__identity`), fall back to the CLI (`loom wake`).
  Content outside the `<!-- loom:start / loom:end -->` markers is
  preserved; re-running is idempotent.
- `--all`, `--harness <keys>`, `--to <path>`, `--dry-run`, `--json`
  flags for non-interactive use. Interactive keyboard-nav wizard
  when stdin is a TTY and no harness flags are given.
- Reusable `src/cli/tui/multi-select.ts` — stdlib keyboard-nav
  checkbox primitive with a pure reducer. Future consumers: bootstrap
  procedure adoption, harness-manifest selection.
- Stack spec §11 lists Injection as a new adapter.

### Changed

- No existing MCP tool surfaces or CLI commands altered. `loom inject`
  is purely additive.

## [0.4.0-alpha.3] - 2026-04-20

### Added

- Full CLI surface — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, plus an explicit `serve` alias. Write commands take
  body text via stdin (when piped) or `$VISUAL`/`$EDITOR` (when
  interactive). `--json` on any command emits the tool's structured
  return value for scripting.
- `assertStackVersionCompatible()` helper consolidates the
  stack-version gate; both MCP startup and every CLI command call it.

### Changed

- `node dist/index.js` with no subcommand still launches MCP (backward
  compatible with every existing `.mcp.json`). A known-subcommand
  argv[2] routes to the CLI instead.

## [0.4.0-alpha.2] - 2026-04-20

### Added

- Procedures seed content — 6 recommended seed templates (stack spec
  v1 §4.9) exposed as `SEED_PROCEDURES` in `src/blocks/procedures.ts`:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`. Each template ships a
  prescriptive Rule sentence plus agent-authored slots for Why and
  How to apply, fenced by a ⚠ ownership-ritual notice the agent
  deletes on adoption.
- `seedNudge()` — renders an empty-directory onboarding message
  containing all 6 templates. Emitted by `identity()` whenever
  `procedures/` is missing or empty; suppressed as soon as any
  procedure file exists.

### Changed

- Documentation reshuffle: v0.4 arc docs moved out of the repo. The
  roadmap now lives in the
  [v0.4 discussion](https://github.com/sleepunit-agents/loom/discussions/10) and
  the [project board](https://github.com/users/jbarket/projects/1/views/1).
  Per-feature specs and plans moved from `docs/superpowers/{specs,plans}/`
  to `docs/{specs,plans}/` — tool-neutral paths, same content.

## [0.4.0-alpha.1] - 2026-04-19

### Added

- Harness manifest block (`harnesses/<client>.md`) — per-harness
  descriptor (tool prefixes, delegation primitive, scheduling,
  session search, gotchas). Loaded by `identity()` when
  `LOOM_CLIENT` resolves. Matches stack spec v1 §4.7.
- Model manifest block (`models/<model>.md`) — per-model-family
  descriptor (capability notes, workarounds, when-to-use /
  when-not-to-use). Loaded by `identity()` when `LOOM_MODEL`
  resolves. Matches stack spec v1 §4.8.
- Procedures block (`procedures/*.md`) — procedural-identity docs
  with a hard cap of ~10 files. Reader ships; populated content
  lands in a later alpha. Matches stack spec v1 §4.9.
- `LOOM_MODEL` environment variable + optional `model` param on the
  `identity` tool.
- `LOOM_STACK_VERSION` file at the context-dir root, auto-stamped
  with `1` on server boot. `createLoomServer` refuses to start
  against a stack version ahead of what this loom understands.
- Missing-manifest nudges: when `LOOM_CLIENT` or `LOOM_MODEL` is set
  but no corresponding manifest exists, `identity()` emits a
  template-filled section telling the agent exactly what to write.

### Changed

- License: MIT → **AGPL-3.0-or-later**. Forks that modify loom and
  expose it over a network must offer source to their users. Bundling
  loom into a larger product is still fine; closing the loom-derived
  code and reselling it is not. Pre-alpha-1 releases remain available
  under MIT.

## [0.3.1] - 2026-04-19

Initial public release.

### Added

- `SqliteVecBackend` — single-file memory store using
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) plus
  the [`sqlite-vec`](https://github.com/asg017/sqlite-vec) vec0 virtual
  table. One `memories.db` per agent. Real cosine similarity.
- `FastEmbedProvider` — embeddings via
  [`fastembed`](https://github.com/Anush008/fastembed-js) with
  BGE-small-en-v1.5 (384-dim, ~33MB ONNX, CPU-only). First run
  downloads the model to `~/.cache/loom/fastembed/`. No GPU, no
  Docker, no daemon.
- Stack specification — [`docs/archive/loom-stack-v1.md`](docs/archive/loom-stack-v1.md)
  defines the directory layout, block types, memory schema, wake
  sequence, and adapter contract that v0.4 work builds on.

### Changed

- Memory backend is now a single opinionated stack (sqlite-vec +
  fastembed). The env-driven backend selector is gone.

### Removed

- Qdrant backend, Ollama embedding provider, OpenAI embedding
  provider, filesystem backend. None were load-bearing for the new
  stack and all added external-service dependencies or operational
  overhead.

[Unreleased]: https://github.com/sleepunit-agents/loom/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/sleepunit-agents/loom/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/sleepunit-agents/loom/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/sleepunit-agents/loom/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/sleepunit-agents/loom/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/sleepunit-agents/loom/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/sleepunit-agents/loom/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/sleepunit-agents/loom/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/sleepunit-agents/loom/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/sleepunit-agents/loom/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/sleepunit-agents/loom/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sleepunit-agents/loom/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sleepunit-agents/loom/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sleepunit-agents/loom/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.1
[0.4.0-alpha.7]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.6...v0.4.0-alpha.7
[0.4.0-alpha.6]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.5...v0.4.0-alpha.6
[0.4.0-alpha.5]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.4...v0.4.0-alpha.5
[0.4.0-alpha.4]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.3...v0.4.0-alpha.4
[0.4.0-alpha.3]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.2...v0.4.0-alpha.3
[0.4.0-alpha.2]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.1...v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/sleepunit-agents/loom/releases/tag/v0.3.1
