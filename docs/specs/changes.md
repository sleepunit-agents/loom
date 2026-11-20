# Changes: what's waiting to go up, and standing rules for merging it

*2026-11-05. Status: **proposed**. A design doc in the `docs/specs/` sense: it says what will be built and the acceptance
criteria each implementation's tests must pin. It covers two pieces, which ship separately:

- **Changes** (`loom-changes`, a new piece): proposed changes to code (pull requests, merge requests) across the forges
  a household's projects live on, read-only, with a page per change and a section in each project's hub.
- **Standing rules** (an addition to the approvals piece, `loom-approvals`): per repo or per project, whether an agent
  may merge on its own, merge and say so after, or must ask first; and the `merge` approval an agent spends when it asks.

Both depend on core only through seams that already exist or that [projects.md](projects.md) adds (the `--repo` feed
argument, `waiting` groups, linked items).*

## Why

> "A bunch of your permission requests are basically, can you review this PR / can I send this thing. Feels like PRs
> need an app that shows what's out there, links to it, and lets me easily approve or deny stuff. I'm getting a lot of
> requests where the answer is you can just do this yourself, that I should be able to always allow, and then the
> client ones should be obvious for me so I know what's waiting to go up." — the owner, 2026-11-05

Today an agent that wants to merge asks in words, one ask at a time. The owner's answer for most repos is always the
same ("yes, you don't need to ask"), and for the repos where it isn't, nothing shows what is waiting, why, or whether
CI is even green. Approvals are single-use by design, so a "yes" teaches nothing.

## Decided

1. **Tiers.** Each rule says one of three things: **just do it** (merge on green CI and a clean review, no ask),
   **tell me after** (merge, then file a notice), **ask me** (ask for a `merge` approval and wait).
2. **The agent merges.** The owner never merges from loom. Changes is how the owner says "yes, please merge it".
3. **Other people's changes show, read-only.** A change opened by someone who isn't one of the household's agents is
   listed with its state and has no buttons.
4. **Forge-generic.** Changes reads forges through adapters. GitHub is the first and only adapter in the first
   version; the interface below names nothing GitHub-specific, so a Forgejo or Azure DevOps adapter is an addition,
   not a redesign.
5. **Read-only.** The Changes piece never writes to a forge: no merges, comments, labels or reviews. Its only writes are
   its own snapshot and, on the owner's buttons, an approval (Yes, Not yet) and a standing rule (Always), both made by
   the approvals piece through its own verbs.

## Vocabulary (to be added to CONTEXT.md)

**Change**:
A proposed change to one repo, open for review: a GitHub pull request, a Forgejo pull request, an Azure DevOps pull
request. Identified by its change id.
_Avoid_: PR (that's GitHub's word; fine in prose about GitHub), patch, diff

**Forge**:
A service that hosts repos and their changes (`github`, `forgejo`, `azure`).
_Avoid_: host (that's a machine), remote (that's git's)

**Forge adapter**:
The part of the Changes piece that reads one forge, behind the interface below.

**Repo selector**:
A project card's `links.repos` entry, `<forge>:<locator>` (projects.md).

**Tier**:
What a standing rule says about merging: `do` (just do it), `tell` (tell me after) or `ask` (ask me).

**Standing rule**:
The owner's lasting answer for a scope (a repo pattern or a project): a tier. Kept by the approvals piece.
_Avoid_: policy, permission (a permission is the wall; a rule is the owner's answer to it)

**Merge approval**:
An approval (the approvals piece) of kind `merge` whose target is one change at one head: `<change id>@<head>`.

## Ids

- **Repo id**: `<forge>:<locator>`. The locator's grammar is the adapter's:
  - `github`: `<owner>/<repo>` (`github:onterris/on-pond`). Case-insensitive; stored lowercase.
  - `forgejo` (not built): `<host>/<owner>/<repo>` (`forgejo:codeberg.org/acme/app`).
  - `azure` (not built): `<org>/<project>/<repo>`.
  A locator is **literal**: two to four `/`-separated segments of `[A-Za-z0-9._-]`, at most 120 characters, so a merge
  target always fits in 200 and nothing in one can read as a pattern (`*`, `?`, `[`). Patterns exist only in rules the
  owner writes (or the seed), never in a target a body sends.
- **Owner key**: the part of a repo id an identity is configured by, as the adapter defines it: `github:<owner>`,
  `forgejo:<host>/<owner>`, `azure:<org>`.
- **Change id**: `<repo id>#<n>`, where `n` is the forge's number for the change, a positive integer
  (`github:onterris/on-pond#212`).
- **Head**: the forge's identifier for the commit the change currently proposes. For git forges, the full 40-hex
  commit sha, lowercase. An adapter whose forge has no such id may not be used for merge approvals.
- **Merge target**: `<change id>@<head>`. It is the approvals piece's `--target` for a merge approval, printable ASCII,
  at most 200 characters, compared exactly.
- **Page path** for a change: `c/<forge>/<locator, lowercase>/<n>` (at most 160 characters), which fits loom's page
  path rule (lowercase letters, digits and `. _ ~ / -`, extensions.md "Pages"). An adapter whose locators can't be
  lowercased losslessly maps them to a path-safe form itself (`page` below) and keeps the map.

## The forge adapter

An adapter is a module with three reads. Nothing in it writes.

```
list(repo)          -> [Change]       the repo's open changes, and those closed or merged in the last 8 days
read(changeId)      -> Change | None  one change, fresh
people(changeId)    -> [Person]       who's involved (also on Change; split so an adapter may fetch it lazily)
```

```jsonc
// Change: what every adapter returns, in these words only
{
  "id": "github:onterris/on-pond#212",
  "repo": "github:onterris/on-pond",
  "number": 212,
  "page": "c/github/onterris/on-pond/212",       // the page path
  "title": "…",                                    // ≤ 300
  "url": "https://…",                              // the change on the forge, https only
  "state": "open",                                 // open | merged | closed
  "draft": false,
  "author": { "login": "…", "name": "…" },        // the forge's login; name optional
  "created": "2026-11-05T14:00:00Z", "updated": "…", "closed": null,   // ISO-8601 UTC
  "head": { "ref": "art/contextual-help", "id": "<40 hex>" },
  "base": { "ref": "dev" },
  "body": "…",                                     // ≤ 4,000, cut at a line, plain text
  "checks": { "state": "passing", "failing": ["build"], "running": [], "total": 6 },
                                                   // passing | failing | running | none (no checks configured);
                                                   // any failed check makes it failing, even with others running
  "review": { "state": "approved", "by": ["…"] },  // approved | changes_requested | required | not_required
  "mergeable": "yes",                              // yes | no | unknown (the forge hasn't computed it yet)
  "conflicts": false,                              // true when the forge says the head conflicts with the base
  "people": [ { "login": "…", "name": "…", "role": "author" } ]
                                                   // role: author | reviewer | requested | assignee | commenter
}
```

- **What it maps, not what it passes through.** The adapter turns the forge's own fields into the words above. No
  forge field name (a GitHub `statusCheckRollup`, `mergeStateStatus`, `reviewDecision`) appears in a Change, in the
  snapshot, or in a page.
- **Who reads.** The adapter reads as the identity the owner configured for the repo's owner key (settings, below). It
  gets that identity's credential from the forge's own credential store when it runs a call, puts it only in that
  call's child environment, and never prints, logs, writes or returns it. A Change shows only what the forge showed
  that identity.
- **Read-only, enforced.** Every adapter makes its forge calls through one function that refuses anything but a read,
  before it runs. For GitHub that is `gh api` with a GET (no `-X`/`--method` other than GET, no `-f`/`-F` field outside
  `graphql`) and `gh api graphql` with a query document; a document containing the word `mutation`, and any other `gh`
  subcommand, is refused. A new adapter states its own rule in the same terms. A test checks every call each adapter
  can make against its rule.
- **Failure is per repo.** A repo the identity can't read, a timeout (20 s a call) or a malformed answer is that repo's
  error in the snapshot (`{repo, error, at}`); every other repo still syncs.

## The Changes piece

### Settings

| Setting | Default | What it is |
|---|---|---|
| `CHANGES_DIR` | `${LOOM_PIECE_HOME}/data` | Where the snapshot lives (`snapshot.json`, 0600) |
| `CHANGES_INTERVAL` | `180` | Seconds between syncs, clamped to 60 to 3600 |
| `CHANGES_IDENTITIES` | none | JSON: which forge identity reads which owner key, `{"github:sleepunit-agents": "art-e-fish", "github:onterris": "jbarket"}`. A repo whose owner key has no entry is read with the forge CLI's default identity |
| `CHANGES_AGENTS` | none | JSON: which changes are an agent's, `{"art": {"logins": ["art-e-fish"], "branches": ["art/"]}}`. A change is the agent's when its author's login is listed, or when its head ref starts with a listed prefix **and** its author is one of `CHANGES_OWNER_LOGINS` (an agent that opens changes under the owner's account). A branch name alone never makes anyone's change an agent's, so nobody outside can name a branch to get a Yes button |
| `CHANGES_OWNER_LOGINS` | none | JSON list: the owner's own forge logins, so their own changes read "yours" |
| `CHANGES_PROJECTS` | `loom project list --json` | The command that lists project cards. The default lists loom's default agent's; another agent's projects' repos are read only if this command lists them |
| `CHANGES_TASKS` | `loom tasks` | The tasks piece's command; its `export` is read once a sync for citations |
| `CHANGES_GH` | `gh` | The GitHub CLI to run, when the one on `PATH` is a wrapper |
| `CHANGES_APPROVALS` | the approvals piece's bin | The approvals command, found as loom finds pieces (`$LOOM_HOME/pieces/bin`, then `PATH`) |

Settings are the owner's (loom's page, pieces-install.md). None holds a secret. A credential is never a setting (pieces-install.md: there's no secret kind).

### Sync

A declared service, `sync` (pieces-install.md, "Services"), reads the project cards, then each distinct repo selector
across them, with its adapter, every `CHANGES_INTERVAL` seconds, and writes the snapshot atomically (a temporary file,
then rename). A Refresh button on the page asks for a sync now: the action touches a file the service watches and
returns at once.

- **Snapshot**: `{v: 1, at, projects: [{slug, name, repos}], repos: {<repo id>: {at, error?}}, changes: [Change]}`.
  Each sync replaces it whole, so a repo no card names any more drops out with its changes. A repo that failed keeps
  its previous changes, marked with the error, until it reads again.
  Pages and feeds read only the snapshot, so they answer inside loom's 3 s limit however many repos there are.
- A page says how old the snapshot is when it is older than three intervals ("Last read 14 min ago").
- A repo that's in no live project card is never read.

### Who a change waits on

Computed when a page or feed is drawn (the hub feed too), from the Change and the approvals piece: one call per agent
with open changes, `approvals rule merge <target>… --for <agent> --json` (below), 2.5 s at most; when it doesn't answer,
rows 7–8 read as row 7 without buttons. First match wins:

| # | When | Waits on | Words |
|---|---|---|---|
| 1 | `state` is `merged` or `closed` | nobody | "Merged" / "Closed" |
| 2 | `draft` | its author | "Draft" |
| 3 | `conflicts`, or `mergeable` is `no`, or `checks.state` is `failing`, or `review.state` is `changes_requested` | its author | "Conflicts" / "Can't be merged" / "CI red" / "Changes asked for" |
| 4 | `checks.state` is `running`, or `mergeable` is `unknown` | CI | "CI running" / "Checking for conflicts" |
| 5 | `review.state` is `required` | a reviewer (the requested people, by name, when there are any) | "Needs review" |
| 6 | not an agent's change | its author | "Ready", or "Yours" when its author is one of `CHANGES_OWNER_LOGINS` |
| 7 | an agent's change, its rule `ask`, and no allowed merge approval for its exact merge target | **you** | "Waiting on you" |
| 8 | otherwise (an agent's change, ready, and either its rule allows it or the owner said yes) | the agent | "Ready for <agent> to merge" |

"Ready" at rows 6–8 means CI is passing or none is configured, and the review is approved or not required. An agent's
change at row 7 whose approval is `denied` reads "You said not yet" and still waits on you.

The row's state line is in words, in this order, each part present only when it applies: CI ("CI green", "CI red:
build", "CI running"), review ("approved", "needs review", "changes asked for"), "conflicts", then who it waits on.

### Pages

- **Index** (`""`): grouped by project in the order of `project_list` (a repo is only read because a project names it,
  so there is no "no project" group; a repo two projects name is listed under each). Within a project, rows are ordered by who they wait on (you, then the agent,
  then CI, a reviewer, an author), then newest `updated` first. Each row: `<repo name>#<n>` and the title as its text;
  the state line, the author's name and its age as its meta; it links to the change's page. A project's first group is
  "Waiting on you" when it has any. Merged and closed changes are under each project's folded "Lately" (8 days). A
  `filters` block narrows to one project (`?project=<slug>`).
- **A change** (`c/…`): a `kv` of repo, branch into base, author, opened and updated; CI with each failing or running
  check by name; review and who reviewed; conflicts and mergeability in words; its people; its linked tasks (below);
  a link out to the forge (`href`). For a change that waits on you: **Yes, merge it** and **Not yet**, and, in the same
  buttons block, **Always for <project>**. For an agent's change whose rule is `do` or `tell`, a line saying so ("Art
  merges this on its own once it's green"). For anyone else's change, no buttons.
- **Unknown path**: `{"title": "Not found", "sections": []}`.

### Actions

Each one requires the owner: loom's `caller` with `kind: "owner"` and unrestricted `agents` (absent or `"*"`, loom's own
rule for an owner's grant). It fails closed: with no caller (a loom without a household, a run by hand) the buttons
are absent and every action gets `ok: false`, as does any other caller. The piece offers no API. **The member** below is the caller's `who`, and `--by` is left out when there is no
caller. Yes, Not yet and Always carry `fields.id` and `fields.head`: each reads the change again from the snapshot and
refuses when its head is no longer that one, saying a new commit arrived.

- **Yes, merge it** (`yes`, fields `id`, `head`): asks the approvals piece to grant a merge approval for the agent whose
  change it is, target `<id>@<head>` (`approvals grant`, below). It answers with the approval's id.
- **Not yet** (`not-yet`, fields `id`, `head`): `approvals grant … --deny`, which denies a pending merge approval for
  that target or records a denied one, so the agent's next check reads `denied`.
- **Always for <project>** (`always`, fields `id`, `head`): sets the standing rule `project:<slug>` to `do` (the
  approvals piece's own owner action, `ui act` `rule` with the owner's caller passed through), then grants this change
  as Yes does. With the change in more than one project, the first in `project_list`'s order.
- **Refresh** (`refresh`): asks for a sync.

The piece makes these calls with `approvals … --by <member>` on loom's machine (the approvals bin, found as loom finds
pieces). With the approvals piece not installed, the buttons are absent and the page says why.

### Its hub section

The piece declares `sections.project` (projects.md). For a project it answers from the snapshot, for the changes in the
repos it was passed with `--repo` (with none, the repos the snapshot read for that project's slug or names): one group
per "waits on" class that has any, in the index's order (you, the agent, CI, a reviewer, an author, then "Lately"), "Waiting on you"
marked `"waiting": true`; each item is the change (`title` `<repo name>#<n> <title>`, cut to 200 at a word with "…";
`when` updated; `who` the author; `status` the table's Words, cut to 24; `ref` the change id; `page` the change's
page). Within a group, newest `updated` first; over 50 items in all, the later groups' oldest are left out, so the
answer always fits projects.md's caps. A project with no `--repo` gets
`{"groups": []}`. `unfiled` is false: a change is only read through a project.

### Linked tasks

A change cites a task when its title, body or head ref contains a task id (`t-<digits>`, as a word: `t-12` in
`art/t-12-fix` and `(t-12)`, not in `at-12`), or its head ref has a segment that starts `t<digits>` and a `-`, `_` or
`/` (`art/t1781-summary`: agents' branches name tasks that way). A task cites a change when its description or a comment contains the
change's id or its GitHub short form, `<owner>/<repo>#<n>` (the short form maps to `github:`). Both directions are
shown on the change's page as one list, deduplicated, each linking to `loom:p/tasks/task/<id>`. The piece reads task
text once a sync through the tasks piece's own CLI, read-only (`CHANGES_TASKS export`, default `loom tasks export`: its
search doesn't reach comments), and keeps only the citations in the snapshot; without it, only the change's own
citations are listed.

**Made in a conversation** ([comms.md](comms.md), "Made here"). A change was made in a conversation only when a task
vouches for it and that task's `source` is `conversation:<that id>`. A task vouches for a change when its
description cites it, or a comment on it does whose author is one of `CHANGES_AGENTS`' agents or the owner
(`CHANGES_TASK_OWNER`, the tasks piece's name for them). The change's own text never counts, whoever wrote it: a
title, body or branch can be typed into by anyone with access, and edited after an agent opened it. The sync keeps,
beside the citations, `trusted` (`{change id: [task id]}`, those vouching citations only) and `sources` (`{task id:
cv id}` for the tasks the export says came from a conversation), and nothing else of them. Such a change's page carries a `from` block in its side column,
and the piece answers a Comms thread's feed (`sections.thread`, `loom-changes thread-feed --json --conversation <cv>
[--ref github:owner/repo#n]…`): each change ref it was given, from the snapshot, with its Words (CI red, Conflicts,
Changes asked for and Can't be merged `bad`; Waiting on you `warn`; Merged `ok`), a ref it doesn't hold as "Not
tracked" opening on GitHub, and every change made in the conversation, `made: true`, those first. Its project feed
accepts `--conversation <cv>` and adds nothing for it: only a project's own repos count.

The tasks piece shows a task's changes on its own page when Changes is installed, by asking it `loom-changes
cited-by <task id> --json` (`[{id, title, state words, page}]`, from the snapshot). That is the tasks piece's change,
in its own repo.

## Standing rules (the approvals piece)

### The rule store

`rules.json` in `APPROVALS_DIR`, 0600, written under the store's lock:

```jsonc
{ "v": 1, "rules": [
    { "kind": "merge", "scope": "github:sleepunit-agents/*", "tier": "do",  "by": "jonathan-barket", "at": "…" },
    { "kind": "merge", "scope": "github:onterris/*",         "tier": "ask", "by": "jonathan-barket", "at": "…" },
    { "kind": "merge", "scope": "project:pond",              "tier": "ask", "by": "jonathan-barket", "at": "…" } ] }
```

- `kind`: an approval kind. Only `merge` has rules in the first version; any other kind is refused.
- `scope`: a **repo pattern**, `<forge>:<locator pattern>` where `*` matches any characters but `/` within one segment
  (`github:onterris/*`, `github:acme/app-*`), or a **project**, `project:<slug>`. At most 100 rules, one per
  (kind, scope).
- `tier`: `do`, `tell` or `ask`.
- **Seed.** When `rules.json` doesn't exist, the piece writes the rules in its setting `APPROVALS_SEED_RULES` (JSON, the
  `rules` array without `by` and `at`; `by` is written `"seed"`). With no seed, there are no rules.

### Which rule applies

For a merge target, the piece takes its repo id (everything before `#`) and finds every rule of that kind whose scope
matches:

- a repo pattern matches when its forge is the repo's and its pattern matches the locator, case-insensitively;
- `project:<slug>` matches when that live project's `links.repos` (read with `APPROVALS_PROJECTS`, default `loom
  project list --json`, loom's default agent's projects) contains the repo id.
- **Failing closed.** When a project rule exists and the project list can't be read, the answer is `ask`, whatever a
  pattern says, and it says why on stderr: a missing project list never loosens a tier.

The most specific wins: an exact repo (no `*`) over a project over a pattern with fewer `*` over one with more. Two rules
at the same rank: the stricter wins (`ask` over `tell` over `do`). No rule: `ask`.

### What a body asks

```
approvals rule merge <merge target>      do | tell | ask, and for ask the approval's state when there is one
approvals tell --kind merge --target <merge target> --what "…"
```

- `approvals rule merge github:onterris/on-pond#212@<sha>` prints one line: `do`, `tell`, or `ask`, then for `ask`
  either nothing (none asked), `pending a-…`, `allowed a-…`, or `denied a-…`, from the newest merge approval for that
  exact target and this agent. Exit 0. A target that isn't a merge target exits 1, saying why. Over the piece API it's a
  body's `run` like `check`.
- `approvals tell` files a **notice** (the manifest's `notices`, FYI): "Art merged github:…#212", with `--what` as its
  meta. A body may only tell about a kind whose rule for that target is `tell` or `do`; otherwise it's refused.
- The rest is unchanged: `request`, `check` and `use` work for `merge` as for any kind.

### What the owner does

- **The page.** A "Standing rules" section, owner-only: a `panel` row per rule, its label the scope in words
  ("Everything in onterris", "The pond project", "sleepunit-agents/loom"), its value the tier in words, and a `choice`
  of Just do it / Tell me after / Ask me / No rule that applies at once. The panel's action, **Add a rule**, opens a
  sheet with the scope and the tier.
- **Always allow for this project.** On the page, the sheet of a pending `merge` approval holds **Allow once**,
  **Always for <project>** (or **Always for <owner/repo>** when no project names the repo) and **Deny**. Always sets the
  rule to `do` for that scope and allows this approval. The Inbox card keeps its two buttons (extensions.md: at most
  two), and its page link opens that sheet.
- **`approvals rule merge <target>… --for <agent> --json`** (loom's machine only): the same answer for many targets
  and another agent, as `{<target>: {tier, scope?, approval?: {id, state}}}`. It's how the Changes piece draws a page.
- **`approvals grant`** (loom's machine only; refused over the API and in a house):
  `approvals grant --kind merge --target T --for <agent> --by <member> [--deny]` makes an allowed (or denied) approval
  for that agent without a request, or answers the agent's pending one for that target. A granted merge approval lasts
  24 hours. It is spent by `use` from any of that agent's houses or from loom's machine (the agent is matched; the
  place isn't, since no place asked).
- **Rules are the owner's.** `ui act` changes a rule only for the owner (as Actions above); the piece API never
  changes one, and a body's `run` has no verb that does. The seed comes from a setting, which is the owner's.
- **The boundary is loom's machine's user account.** A body that runs *on* loom's machine, as that user, can run
  `grant` or `ui act` itself, exactly as it can already run `allow` today or the forge CLI directly. That is the
  approvals piece's existing trust model, unchanged: approvals bind houses and API callers, not the host's own user.

### What it does not change

- A rule never grants a write a guard would refuse. `do` means the agent doesn't ask the owner; the agent still merges
  through whatever account and guard it always would, and a guard that refuses the write still refuses it.
- A `merge` approval binds one head. A push after the owner's Yes changes the head, so the old approval's target no
  longer matches and `use` refuses it.

## Agent-side guidance (the agent's own configuration, outside loom)

Before merging a change, a body runs `approvals rule merge <target>` for the change's current head and:

- `do`: merges when CI is passing (or none is configured) and the review is approved or not required, with no ask.
- `tell`: merges as for `do`, then `approvals tell`.
- `ask`: `approvals request --kind merge --target <target> --what … --why …`, parks on the approval (the agent's
  clock), and merges after it's allowed with `approvals use`. A new push means a new target and a new ask.
- Whatever the tier, it merges **only that head**, with the forge's own guard where it has one (GitHub:
  `gh pr merge --match-head-commit <head>`), so a push between the check and the merge fails the merge instead of
  merging something nobody looked at.

That replaces "may I merge" asks in words. It widens no write access.

## Acceptance criteria

**Changes piece** (its own test suite):

1. The GitHub adapter maps a recorded GraphQL answer (a fixture with passing, failing, running, mixed failed-and-running
   and absent checks; an approved, changes-requested and required review; a conflicting and an unknown-mergeability
   change; a draft) to the Change shape exactly, and none of GitHub's own names (`statusCheckRollup`, `reviewDecision`,
   `mergeStateStatus`, `headRefOid`, `isDraft`, `bodyText`, `MERGEABLE`, `CONFLICTING`, `REVIEW_REQUIRED`) appears in
   its output.
2. Every call the adapter can make is a GET or a `graphql` query, checked at the gate and at the process boundary (a
   sync against a fake `gh` that records its argv sees only `auth token` and those reads); a document with `mutation`, a method other than GET,
   or any other subcommand is refused before it runs. The credential is in the child's environment only, and a planted
   token is absent from every file under `CHANGES_DIR` after a sync, the snapshot, every page, every feed answer, and
   the piece's stdout and stderr.
2a. `CHANGES_IDENTITIES`: a repo is read with the identity for its owner key (a test's fake forge CLI records which),
   and with the default identity when its key has none.
3. Sync reads only the repos the project cards name (selectors normalized, a bare `owner/repo` as `github:`), keeps
   going past a repo that fails, records that repo's error, and replaces the snapshot atomically.
4. "Waits on" follows the table, each row tested, first match winning, including a change that is an agent's by its
   branch prefix under the owner's login, one with that prefix by anyone else (not the agent's: no buttons), one
   that's the owner's own ("Yours"), `mergeable: no`, a denied approval, and checks `none` counting as ready.
5. The index groups by project, waiting-on-you first, then the documented order; merged and closed changes are under
   "Lately"; the project filter narrows. A page older than three intervals says how old.
6. A change's page shows Yes, Not yet and Always only when it waits on you, a do/tell line for an agent's change that
   its rule allows, and no buttons for anyone else's change.
7. Yes, Not yet and Always refuse a caller who isn't the owner, and a stale head. Yes runs exactly `approvals grant
   --kind merge --target <id>@<head> --for <agent> --by <member>`; Not yet the same with `--deny`; Always runs the
   approvals piece's `rule` action for `project:<the first project's slug>` with tier `do` and the owner's caller,
   then the same grant as Yes. Refresh needs only the owner.
8. The section feed answers by the projects.md schema, groups in the documented order, `waiting: true` on "Waiting on
   you", `page` on each item, every cap held against data that would break it (long titles and words, over 50
   changes); with no `--repo`, the project's repos as the snapshot read them, and `{"groups": []}` for a project the
   snapshot doesn't know.
9. Task citations: the word rule (`t-12` in a branch and in parentheses, not inside another word), both directions,
   deduplicated; `cited-by` answers from the snapshot.

**Approvals piece** (its suite):

10. Rule resolution: exact repo over project over fewer `*` over more; strictest at a tie; `ask` with no rule; a project
    rule from the project list; and `ask` when a project rule exists and the list can't be read, even under a `do`
    pattern.
11. The seed is written once, only when `rules.json` doesn't exist.
12. `rule merge` prints each documented answer, including the newest approval's state for that exact target and agent;
    `--for` and `--json` answer many targets for another agent, and `--for` is refused over the API.
13. `grant` makes an allowed approval spendable once by that agent from a house or loom's machine, for that target only,
    for 24 hours; it answers a pending request instead of making a second; it is refused over the API and in a house.
14. A push (a different head) makes `use` refuse the old approval. A deny (Deny on the card, or Not yet) for a kind,
    target and agent denies every earlier unspent pending or allowed approval for the same three, and `use` refuses
    one the owner has said no to since; a later yes counts again.
14a. A merge target, or a repo selector the Changes piece reads, that isn't literal (`github:acme/*#1@…`, `?`, `[`, a space, one segment) is refused at `request`
    and `grant`, and Always never makes a rule with a pattern in it from a target.
15. Rule edits through `ui act` require the owner, and `api` has no path that changes a rule.
16. Always on a pending merge approval sets the scope's rule to `do` and allows that approval, as one write.
17. `tell` files a notice for a `do` or `tell` target and refuses an `ask` one.

## Open questions

- **Review as a gate.** "A clean review" for a repo that doesn't require review is "not required". Whether `do` should
  wait for an optional review that someone was asked for is the agent's guidance, not a rule field, until it's needed.

## Review gate

Before this doc merges, a context-stripped reviewer reviews it, and each finding is recorded in the PR thread as folded,
accepted as a trade-off, or rejected with a quote.
