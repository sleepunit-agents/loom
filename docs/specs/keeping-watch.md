# Keeping watch: the nightly backup, boots, failures and box health

*2026-11-04. Status: **proposed**. t-1834. Jonathan, 2026-11-04: the host jobs
that run as scripts out of Art's checkout on loom's machine "shouldn't be part
of any of this checkout or something the agents touch regularly"; they belong
in loom proper or the runtime. "Loom on its own should effectively bring art
back anywhere." A design doc in the `docs/specs/` sense: what will be built,
and what the tests must pin. Builds on [household.md](household.md) ("Export
and restore") and [runtime.md](runtime.md) ("Boxes").*

## Why

Five jobs keep Art's household safe today, and all five are scripts in
`~/Art/bin`, run by user timers on loom's machine:

| Job | What it does | Where it should live |
|---|---|---|
| `art-loom-bundle` (nightly) | `loom export`, `loom restore --drill`, push the encrypted bundle to `sleepunit-agents/art-vault` | **core**: the backup is continuity |
| `scripts/loom-backup.py` (weekly) | a *plaintext* JSONL dump of memories, knowledge and identity to `art-loom-backup` | gone: the nightly bundle covers it, encrypted |
| `host-watch` (every 2 min) | samples wunder, the Proxmox host, over root ssh; alerts when a problem lasts | **runtime**: every box watches itself |
| `art-boot-notify`, `art-boot.service` | on boot of loom's container, page Jonathan with the host's uptime; start the boot triage lane | **runtime**: a box says when it came back |
| `art-unit-alert`, `art-alert@.service` | `OnFailure=` sink: one alert per failed unit, rate-limited, with the journal's last lines | **runtime**: a box says when a unit fails |

Three things are wrong with that:

- **Any push to Art's `main` is code running on loom's machine** (t-1834):
  `~/Art` auto-pulls, and these jobs run from it.
- **Only Art's household has them.** A household that isn't Art's gets no
  backup, no watch and no boot or failure alerts.
- **Root ssh from a container to the hypervisor.** host-watch needs
  `root@wunder` from CT 103, so anything that owns CT 103 owns wunder.

## The alert path (shared by all three)

Every alert in this spec reaches the owner the way the runtime's alerts do
today (loom-box `alerthook.mjs`, t-1830):

1. **An Inbox alert** while the condition lasts: an ask with `kind: 'alert'`.
   For the backup it's one of core's own asks (`coreAsks` in
   `src/ui/handler.ts`, beside the memory proposals and Needs you); for a box
   it's an entry in the runtime piece's manifest `asks` (docs/extensions.md,
   "The manifest"; loom-box `src/ui.mjs`, `manifest`). Its text
   stays the same while the condition lasts, so a phone is pushed once; what
   changes goes in its `meta`. It leaves the Inbox when the condition ends,
   and an FYI says it's over ("OK again after 14 min").
2. **The owner's alert command**, if one is set: a JSON argv
   (`LOOM_RUNTIME_ALERT_COMMAND` for the runtime, `LOOM_ALERT_COMMAND` in the
   daemon's environment for core), run detached with
   `<source> --severity warn|bad --summary <one line> [--fact k=v]...`. In
   Art's household that's `bin/alert`, which wakes Art on `alert:<source>`
   to triage it (t-1830). A command that fails or isn't set changes nothing
   else. Core's is an environment variable, never a household setting: a
   bundle restored somewhere else can't plant a command to run.

**Every** condition in this spec, whatever section it's in, follows one
cadence: the alert command hears it once when it starts alerting, again every
6 hours while it lasts (its summary ending "(still)", with a `minutes` fact),
and once when it clears ("… is OK again", with `--fact cleared=1`), so the
triage conversation hears that it's over. That cadence replaces
`art-unit-alert`'s 15-minute cooldown, its suppressed-failure count and its
"ESCALATED" streak: an alert is now one per *episode* (a unit failing, a
condition holding), never one per failure event, so a crash loop is one alert
with a `restarts` fact, not fifty, and a four-hour outage reads as one alert
that has lasted four hours.

**When loom itself is down.** The runtime runs as its own service, apart from
loom's listeners, and the alert command runs on loom's machine without them.
In Art's household that command is `bin/alert`, which pages Jonathan
straight to Discord when it can't arm a wake, so an alert still gets out
while loom's page is down. A household without an alert command hears only
through loom's Inbox; a watch from off the machine is out of scope (the
off-box status board was tried and reverted, loom-box #65).

## 1. The nightly backup (core)

### Settings

The backup's settings live in `household.json` under `backup`, set with
`loom backup set` or on the default agent's Setup, and shown there:

```json
"backup": {
  "target": "git:https://github.com/sleepunit-agents/loom-household-backup.git",
  "recipients": ["age1…jonathan", "age1…yubikey"],
  "at": "02:55", "tz": "America/Chicago", "keep": 7
}
```

- **`target`** is `git:<https or ssh URL>` or `path:<absolute directory>` (a
  USB stick, a NAS mount).
- **`recipients`** are age public keys (or ssh public keys) the owner holds.
  At least one is required, and the drill key's isn't one of them (below).
- **`at`** and **`tz`**: when it runs each day (`HH:MM`, 24-hour, and an
  IANA zone). Defaults `03:00` and the time zone of the machine
  `loom backup set` runs on (`Intl.DateTimeFormat().resolvedOptions()`).
- **`keep`**: nights kept besides each month's first. Default 7.
- **Nothing in the settings is secret.** A bundle carries `household.json`,
  so a restored household keeps its backup settings.
- **A path target may not be inside `$LOOM_HOME`.**

**A restored household's backup waits.** The backup runs only on a machine
where `loom backup set` was run: it records `setAt` in
`$LOOM_HOME/backup/state.json`, which no bundle carries. A household restored
from a bundle has the settings and no `setAt`, so it never pushes to the
target the old machine is still writing; Setup says "restored here: run `loom
backup set` to resume", and it's no Inbox alert. Two machines both set up is
the owner's choice.

### The drill key

`loom backup set` makes **`$LOOM_HOME/backup/drill.key`** (age-keygen, 0600)
if there isn't one, and every bundle is also encrypted to its public key, so
the drill can open what was just written. It never leaves the machine:

- it isn't a setting, and it's never in a bundle (export refuses a staged
  file named `drill.key`, as it refuses the audit log);
- it opens only what the machine already holds in plaintext, so it adds no
  reach. Losing it loses nothing: the next `loom backup set` or run makes a
  new one, and the owner's key still opens every old bundle.

### Credentials

loom stores no credential for the target. **A git target pushes with the git
credentials of the user loom runs as** (its credential helper or ssh key),
exactly as `git push` would by hand in that user's shell. A path target needs
none.

Trade-off: a fresh machine needs git credentials before its first push, and
the backup says so ("git push failed: …") rather than working out of the
box. The alternative, a token fetched from the secrets piece, would make core
ask a piece for authority, which household.md rules out ("Does it hold
authority? Then it's never core").

### A run

`loom backup run` (the daemon starts it at `at`; the owner can run it by
hand):

1. **Export** the household to a 0700 temp dir with `exportBundle`, to the
   recipients plus the drill key: SQLite through the backup API, each
   piece's own encrypted part, as `loom export` does today.
2. **Drill** it with `drillBundle` and the drill key. The live household can
   move on between export and drill (a wake writes a memory), so a mismatch
   gets one fresh export and drill. Two mismatches: **nothing is pushed** and
   the run fails, naming the differences.
3. **Required parts.** Every piece whose part was in the last good bundle
   must be in this one. The **last good bundle** is the newest run recorded
   with `ok: true`; the state records each run's included pieces. One
   missing is still written (the rest is worth having offsite), and the run
   is recorded `ok: false`, naming it, so it never becomes the baseline: the
   next night is held to the same pieces until a run has them all.
   (2026-10-26 and -27: the box piece's part dropped out on ENOBUFS and the
   drill passed silently.)
4. **Write it to the target:**
   - **path:** `<dir>/loom-household-<YYYYMMDD-HHMM>.bundle`, written to a
     temp name and renamed;
   - **git:** loom keeps its own bare clone at `$LOOM_HOME/backup/repo.git`
     (nothing is checked out). A bundle over 90 MB (a constant the tests
     lower) is split into `bundles/<name>.part-00`, `-01`, … (GitHub refuses
     a file over 100 MB); a smaller one is `bundles/<name>`. The parts must
     rejoin, byte for byte, to the drilled file before anything is
     committed.
5. **Prune** to `keep` nights plus the first bundle of each month.
6. **Push (git).** The branch is `main`, and it's always **one commit**:
   the kept bundles, `RESTORE.md` and `.loom-backup`, committed with no
   parent and pushed with `--force-with-lease=refs/heads/main:<sha>`, where
   `<sha>` is what `git ls-remote` said `main` was at the start of this run
   (empty, so "must not exist", for an empty repo). Bundles are
   ~100 MB a night; a history of them would grow without end (art-vault is
   822 MB today), and every bundle that's kept is in the one commit.
   Blobs the remote already has aren't sent again.
7. **Record** the run in `$LOOM_HOME/backup/state.json`: when, ok or not and
   why, bytes, the bundle's name, its parts, the pushed commit, the drill's
   result and tries, and the pieces whose parts it held.

**loom only writes to a target that's its own.** The check reads the target
itself, never loom's clone: for git, the tree of the remote's `main` as
`ls-remote` names it (fetched if loom doesn't have that commit); for a path,
the directory. It must be empty (a git repo with no branches at all), or hold
a file `.loom-backup` at its root (any content; loom writes one line saying
what wrote it). Anything else is refused before export, so a force-push can't
wipe a repo that isn't the backup's (art-vault holds other things). A path
target that doesn't exist is refused too (an unmounted stick is a failure,
not an empty directory).

`RESTORE.md` in the target says, in plain words, how to bring the household
back: install loom, join the parts with `cat`, `loom restore <bundle>
--identity <key> --to <dir>`.

### The schedule

Each of loom's listeners checks every 10 minutes whether a run is due
(`at` has passed today, in `tz`, and no run has started since). One of them
takes `$LOOM_HOME/backup/run.lock` (created with `O_EXCL`, holding its pid
and when; one whose pid is gone, or older than 6 hours, is stale and taken
over) and runs the backup in a child process (`loom backup tick`), so a crash
in a run never takes a listener down, and three listeners never run three
backups.

### What the owner sees

- **Setup's Health** (the default agent's): a **Backup** row, "6 h ago ·
  drill passed · 104 MB to loom-household-backup", tone ok; or what's wrong.
  No settings: "not set up", tone warn, with the form.
- **One Inbox alert** from core, the household owner's (no agent), when:
  - **the newest run failed** ("The nightly backup failed", its meta the
    why), until a good run;
  - otherwise, **it's missed**: no good run in 26 hours (since the last good
    one, or since `setAt`) while `backup` is set ("No backup since Tue 2:55
    AM"), until a good run.

  A failed run and a miss at once are one alert: the failure.
- **The alert command** (source `loom-backup`, severity `bad`): each failed
  run once (a run is news); a miss on the cadence above; "OK again" at the
  next good run after either.

### Replacing the old jobs

When the core backup has run and drilled twice, it replaces
`art-loom-bundle` (art-vault) and `art-loom-backup`. Their timers are turned
off by Jonathan, not by this work, and art-vault and art-loom-backup stay as
they are.

## 2. Boots and failed units (runtime)

### A box says when it came back

Each box's poll carries **`boot`**: `{ id, kernel, up }`.

- `kernel` is `/proc/sys/kernel/random/boot_id`.
- `id` is `kernel` plus PID 1's start time (`/proc/1/stat`, field 22). In a
  container the kernel is the host's, so a restarted container keeps
  `kernel` and gets a new `id`; a rebooted host changes both.
- `up` is `/proc/uptime`'s first field (a container's own, under lxcfs).

The control plane keeps the last `boot` per box. When `id` changes:

- **An FYI**: "loom came back at 09:14, up 40 s after being dark 6 min", where
  dark is from the box's last poll before the boot to the boot (now − `up`).
  "The host restarted too" when `kernel` changed.
- **The alert command**: source `box-boot`, severity `warn`, facts `box`,
  `up_s`, `dark_s`, `kernel_restarted`.
- A box's first `boot` is only recorded.

A box restarting its runner (an upgrade, a crash) keeps its `id`: no notice.

### A box says when a unit fails

Each box samples its systemd units each minute: the runner's user's
(`systemctl --user`) and the system's (`systemctl`, which any user can
read). It reports:

- every unit in state `failed`, with its result and since when;
- every service whose `NRestarts` has gone up 3 or more times in 15 minutes
  (a crash loop with `Restart=always` is never `failed`);
- for each, the last 10 lines of its journal where the runner can read them,
  with what looks like a secret redacted (as `art-unit-alert` does: webhook
  URLs, bearer tokens, `key=value` for password, secret, token and api key,
  `sk-…`), capped at 1200 characters.

The control plane, per box and unit:

- **An Inbox alert** while it's failed: "art-slack.service failed on loom"
  (or "keeps restarting"), its meta the journal's last line. The box's page
  shows all of the journal lines, marked as the unit's own output.
- **The alert command**, on the cadence above: source `unit-` plus the unit's
  name with `.service` dropped, lowercased, every character outside
  `[a-z0-9-]` turned into `-`, cut to 34 characters, exactly as
  `art-unit-alert` names them (`art-slack.service` is `unit-art-slack`): one
  triage conversation per unit. Severity `bad`, facts `box`, `unit`,
  `scope` (user or system), `state` (failed or looping), `restarts`, and
  `log`: the journal's last 3 lines, redacted, joined, 300 characters.
- **When it's over:** a failed unit that's no longer `failed`, or a looping
  one whose `NRestarts` hasn't gone up for 15 minutes. The alert goes, an FYI
  says so, and the alert command hears `cleared=1`.
- **Dropped from `art-unit-alert`:** the alert ledger (`bin/alert-ledger` is
  Art's; his alert command writes it), and the Machine piece's Restart
  button: restarting a unit is an owner's action on a box the runtime
  doesn't do yet. The Machine piece keeps its button until it does.
- **What's ignored:** `LOOM_RUNTIME_UNITS_IGNORE`, a regex on unit names, set
  on the box. Default: none.

A unit that fails and is restarted by its timer before the next sample is
missed; `OnFailure=` caught it. Accepted: a minute's sampling misses a
oneshot that fails and succeeds again within the minute, and a unit that's
still failing is caught on the next sample.

## 3. Box health (runtime)

### What a box reports

Each box polls every 15 seconds; once a minute it takes a sample and sends it
with its next poll as **`health`**. A rate (disk busy and latency, arc_prune
calls) is measured over 5 seconds inside the sample, as host-watch measured
it, so the thresholds below mean what they meant there. Everything is read
without root; what can't be read is left out, never guessed, and the box's
page lists what wasn't read ("not read: SMART, pools").

**A container box reads only what's its own.** In a container (systemd's
`detect-virt --container`, or `/run/.containerenv`), `/proc/pressure` is the
host's, and so are the disks and ZFS. A container box takes pressure from its
own cgroup (`/sys/fs/cgroup/{cpu,io,memory}.pressure`) and leaves out disks,
ZFS and containers; memory, swap and load come from `/proc` as lxcfs gives
them (the container's own). The host's readings come from the host's own box,
once, never from each container on it.

| Reading | From |
|---|---|
| load (1, 5, 15), CPUs | `/proc/loadavg`, `os.cpus()` |
| memory and swap | `/proc/meminfo` (MemTotal, MemAvailable, SwapTotal, SwapFree) |
| pressure (cpu, io, memory: some and full, avg60) | `/proc/pressure/*` |
| filesystems: used % | `statfs` of each mount of a real filesystem (ext4, xfs, btrfs, zfs, vfat, f2fs) in `/proc/mounts`, one per device |
| disks: busy %, read and write latency, MB/s, rotational | `/proc/diskstats` (sd*, nvme*n*, vd*), the change since the last sample; `/sys/block/*/queue/rotational` |
| ZFS cache: size, dnodes, arc_prune per second | `/proc/spl/kstat/zfs/arcstats`, where it exists |
| ZFS pools: health, capacity | `zpool list -H`, where `zpool` runs (`/dev/zfs` is 0666 on wunder) |
| containers: io and memory pressure | `/sys/fs/cgroup/lxc/<id>/*.pressure`, where they exist (a Proxmox host) |
| SMART, container names | `/run/loom-box/root-health.json`, only if a root job writes it (below): `{"t": <unix s>, "smart": {"<disk>": {"passed", "temp_c", "reallocated", "pending", "wear_pct", "media_errors"}}, "containers": {"<id>": "<name>"}}`, the fields host-watch-sample.py reads; ignored when `t` is over 30 minutes old |
| failed units | section 2 |

### When it alerts

The control plane checks each sample against these rules: host-watch's since
2026-10-30, plus two new ones (marked). A condition **holds** from the first
sample that shows it; one sample without it ends it, and the next one that
shows it starts again from zero. It alerts once it has held for its *for*,
then follows the cadence above:

| Condition | For |
|---|---|
| io pressure *full* ≥ 50% | 10 min |
| a container's io pressure *some* ≥ 40% | 15 min |
| a container's memory pressure *some* ≥ 20% | 10 min |
| a disk ≥ 80% busy and its requests slow (≥ 300 ms spinning, ≥ 30 ms solid state) | 10 min |
| ZFS arc_prune ≥ 100 calls/s | 5 min |
| a ZFS pool not ONLINE | at once |
| a ZFS pool ≥ 85% full | at once |
| a filesystem ≥ 90% full (*new*: host-watch watched only pools) | 10 min |
| memory available < 8% | 10 min |
| swap free < 15% (of a box with swap) | 10 min |
| SMART: failing, reallocated or pending sectors, media errors, ≥ 80% worn, too hot (≥ 70 °C NVMe, ≥ 55 °C other) | at once |
| **the box is dark** (*new*): no poll for 10 minutes | at once |

The dark rule can't wait for a sample, so the control plane checks it on its
own: each time loom reads the runtime's manifest (each minute, for push) and
on every poll, a box whose last poll is over 10 minutes old is dark, and its
next poll ends it. A box the owner revoked is never dark.

Each condition alerting is an Inbox alert on the Boxes tab ("wunder: ZFS's
cache is thrashing"), and the alert command with source `box-health`,
severity `warn` (`bad` for a pool, SMART or a dark box), and facts `box`,
`key` (the condition: `arc-prune`, `pool-rpool`, `fs-/`), `minutes`.

The control plane keeps per box, in the runtime's data directory and never in
its state file: the last sample and the conditions now (when each began, when
it last alerted) in `health/<box>.json`, and every sample in
`health/<box>-<YYYY-MM>.jsonl`, three months kept, as host-watch keeps
wunder's. `loom runtime health [<box>]` prints the last sample in words and
what's wrong now (host-watch's `status`). host-watch's `--dry-run` is
dropped: the rules are pinned by tests instead.

### The box's page

The box's page gets a **Health** section: the last sample in words (load,
memory, swap, the fullest filesystem, the busiest disk, pools), each
condition now and since when, and the failed units with their journal
lines.

### The hypervisor

host-watch reaches wunder over root ssh from CT 103, so CT 103 owns wunder.
Three ways to cover the host without that:

| | What runs on wunder | Root on wunder | Trade-off |
|---|---|---|---|
| **A. A report-only box** (chosen) | loom-box as an unprivileged user, `loom runtime join … --report-only`, no podman | once, to install node 22 and make the user | One sampler for every box, upgraded by the runtime as any box is. The box credential can only report and poll; a report-only box is never given a house or a secret. Node on the hypervisor is new. |
| B. A stdlib Python reporter | a ~200-line script on a timer, posting to `/api/box/health` | once, to install it | No node, but a second sampler to keep in step, and upgrades by hand. |
| C. Keep root ssh | nothing | none | The problem this replaces. |

Chosen: **A**. What needs root (SMART, which CT is which) comes from an
optional root timer on the host, shipped as `contrib/root-health` in
loom-box: it writes `/run/loom-box/root-health.json` (0644) each 10 minutes
and reads nothing else. The box only reads that file; nothing on the box can
ask root for anything.

**Report-only** is a flag on the box (`reportOnly: true`), set when it joins
with `--report-only` or by the owner. The box's poll (loom-box
`src/control.mjs`, `poll`) answers it no houses to start (`start`), no body
hosts to check (`bodyHosts`), no box sessions (`remotes`) and no sign-ins
(`logins`), and taking a house (`claim`) refuses it, whatever the box's
`mayHost` (which agents it may host) says.

Until wunder has its box *and* that box reports pools and SMART (the root
timer is in), host-watch keeps watching it.

## What moves where

| Old | New | Replaced when |
|---|---|---|
| `art-loom-bundle`, `art-loom-bundle.timer` | `loom backup` (core) | two good runs, drilled |
| `scripts/loom-backup.py`, `art-loom-backup.timer` | the same | the same |
| `art-boot-notify`, `art-boot.service` | box boot reports | live, and an alert seen end to end |
| `art-unit-alert`, `art-alert@.service` | box unit reports | the same |
| `host-watch`, `host-watch-sample.py`, `art-host-watch.timer` | box health, and a report-only box on wunder | the same, and wunder's box is in and reads pools and SMART |

Nothing old is turned off by this work. Each line is reported ready, and
Jonathan turns the old one off.

## Order

1. The backup (core).
2. Boots and failed units (runtime).
3. Health (runtime), then wunder's report-only box (needs Jonathan: node on
   the host).

## What the tests must pin

**Backup**

- `loom backup set` writes the settings to `household.json`, makes
  `backup/drill.key` 0600 once, and refuses a recipient that isn't an age or
  ssh public key, a target that isn't `git:` or `path:`, a path inside
  `$LOOM_HOME`, an `at` that isn't `HH:MM` and a zone that isn't one.
- A household with settings and no `setAt` (restored) never runs or pushes,
  and has no Inbox alert.
- A run against a path target writes a bundle that `loom restore` with the
  owner's key opens, and that the drill key opens too; a bundle never holds
  a `drill.key`.
- A drill that mismatches once and then passes pushes; one that mismatches
  twice pushes nothing, and the state says why.
- A piece part in the last good bundle and missing now: the bundle is
  written, and the run is failed, naming the piece; the night after, a run
  still without it fails again.
- A git target: a bundle over the split size is pushed as parts that rejoin
  to the drilled file; the branch is one commit after every run; `keep`
  nights plus each month's first are kept.
- A target holding files and no `.loom-backup` is refused before export, a
  git repo with branches but no `main` too, and a path that doesn't exist.
- Due: not before `at` in `tz`, once a day, and only one of two schedulers
  racing for the lock runs.
- The Inbox has one backup alert after a failed run, one after 26 hours with
  none, one (the failure) when both hold, and none after a good run. Setup's
  Health shows the last run and drill.
- The alert command hears a failed run once, a miss once and again 6 hours
  on (not on each tick between), and "OK again" with `cleared=1` at the next
  good run.
- `LOOM_ALERT_COMMAND` hears a failure with source `loom-backup`; a
  `backup.alertCommand` in household.json is never run.

**Boots and units**

- A poll with a new `boot.id` leaves one FYI with the up and dark times and
  one alert command call; the same `id` again leaves none; a box's first
  boot leaves none. A changed `kernel` says the host restarted too.
- A unit reported failed is an Inbox alert and one alert command call with
  source `unit-art-slack` for `art-slack.service`; still failed on the next
  poll, no second call; 6 hours on, one "(still)"; gone, an FYI and a
  `cleared=1` call. A looping unit clears only after 15 minutes without a
  restart. A unit matching `LOOM_RUNTIME_UNITS_IGNORE` is none of these.
- Journal lines reach loom with a webhook URL, a bearer token and
  `token=…` redacted.

**Health**

- Each rule above: samples holding the condition for less than its *for*
  don't alert; for longer, it does once; 6 hours on, once more; cleared, an
  FYI. A run of samples with one gap in it (condition, none, condition) for
  longer than *for* doesn't alert. A reading the box couldn't take never
  alerts.
- A box silent for 10 minutes is a dark alert from a manifest read alone (no
  poll); its next poll clears it.
- A container box (the fake root says lxc) reports its cgroup's pressure, not
  `/proc/pressure`'s, and no disks or ZFS.
- A report-only box gets no houses, logins or sessions from poll, and
  `claim` refuses it.
- The sampler reads a fake root (loom-box `test/fixtures/`: a Proxmox host's
  `/proc`, `/sys` and a `root-health.json`, and an LXC container's) into the
  sample the rules expect, SMART and container names included; a
  `root-health.json` over 30 minutes old is ignored.

## Open questions

- **A warm standby** (household.md's open question): out of scope. The
  nightly bundle and the owner's key are the USB stick.
- **The monthly bundles in the one commit grow by ~100 MB a month.** At a
  year that's ~1.3 GB on GitHub. `keep_months` can cap it when it matters.
