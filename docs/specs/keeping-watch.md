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

1. **An Inbox alert** while the condition lasts: an ask with `kind: 'alert'`
   (core's own for the backup, the runtime's manifest for boxes). Its text
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

A condition that lasts gets the alert command again every 6 hours ("still"),
and once more when it clears ("OK again"), with `--fact cleared=1`, so the
triage conversation hears that it's over.

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
- **`at`** and **`tz`**: when it runs each day. Defaults `03:00` and the
  page's time zone.
- **`keep`**: nights kept besides each month's first. Default 7.
- **Nothing in the settings is secret.** A bundle carries `household.json`,
  so a restored household keeps its backup settings.

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
   must be in this one. One missing is still pushed (the rest is worth
   having offsite), and the run fails, naming it. (2026-10-26 and -27: the
   box piece's part dropped out on ENOBUFS and the drill passed silently.)
4. **Write it to the target:**
   - **path:** `<dir>/loom-household-<YYYYMMDD-HHMM>.bundle`, written to a
     temp name and renamed;
   - **git:** loom keeps its own clone at `$LOOM_HOME/backup/repo`. A bundle
     over 90 MB is split into `.part-00`, `.part-01`, … (GitHub refuses a
     file over 100 MB), and the parts must rejoin, byte for byte, to the
     drilled file before anything is committed.
5. **Prune** to `keep` nights plus the first bundle of each month.
6. **Push (git).** The branch is always **one commit**: the kept bundles,
   `RESTORE.md` and `.loom-backup`, committed with no parent and pushed with
   `--force-with-lease` against the commit loom last pushed. Bundles are
   ~100 MB a night; a history of them would grow without end (art-vault is
   822 MB today), and every bundle that's kept is in the one commit.
   Blobs the remote already has aren't sent again.
7. **Record** the run in `$LOOM_HOME/backup/state.json`: when, ok or not and
   why, bytes, the bundle's name, the pushed commit, and the drill's result.

**loom only writes to a target that's its own.** A git target must be empty
or hold `.loom-backup` at its root (written on the first push); a path target
the same. Anything else is refused before export, so a force-push can't wipe
a repo that isn't the backup's (art-vault holds other things).

`RESTORE.md` in the target says, in plain words, how to bring the household
back: install loom, join the parts with `cat`, `loom restore <bundle>
--identity <key> --to <dir>`.

### The schedule

Each of loom's listeners checks every 10 minutes whether a run is due
(`at` has passed today, in `tz`, and no run has started since). One of them
takes `$LOOM_HOME/backup/run.lock` (a lock file naming its pid; one whose pid
is gone is stale) and runs `loom backup run` as a child process, so a crash
in a run never takes a listener down, and three listeners never run three
backups.

### What the owner sees

- **Setup's Health** (the default agent's): a **Backup** row, "6 h ago ·
  drill passed · 104 MB to loom-household-backup", tone ok; or what's wrong.
  No settings: "not set up", tone warn, with the form.
- **An Inbox alert** from core when:
  - **a run failed** ("The nightly backup failed: the drill didn't match
    twice"), until the next good run;
  - **it's missed**: no good run in 26 hours while `backup` is set ("No
    backup since Tuesday 02:55"), until the next good run.
- **The alert command** (source `loom-backup`, severity `bad`) for each.

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
- **The alert command** when it starts: source `unit-<unit>` (lowercase,
  `[a-z0-9-]`, 40 characters at most, as `art-unit-alert` names them: one
  triage conversation per unit), severity `bad`, facts `box`, `unit`,
  `scope`, `last_line`.
- **When it's no longer failed:** the alert goes, an FYI says so, and the
  alert command hears `cleared=1`.
- **What's ignored:** `LOOM_RUNTIME_UNITS_IGNORE`, a regex on unit names, set
  on the box. Default: none.

A unit that fails and is restarted by its timer before the next sample is
missed; `OnFailure=` caught it. Accepted: a minute's sampling misses a
oneshot that fails and succeeds again within the minute, and a unit that's
still failing is caught on the next sample.

## 3. Box health (runtime)

### What a box reports

Each box samples once a minute and sends the sample with its next poll as
**`health`**. Everything is read without root; what can't be read is left
out, never guessed:

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
| SMART, container names | `/run/loom-box/root-health.json`, only if a root job writes it (below) |
| failed units | section 2 |

### When it alerts

The control plane checks each sample against these rules, the same ones
host-watch has used since 2026-10-30. A rule alerts only once it has held for
its *for*; it says "still" every 6 hours while it lasts, and "OK again" when
it's over:

| Condition | For |
|---|---|
| io pressure *full* ≥ 50% | 10 min |
| a container's io pressure *some* ≥ 40% | 15 min |
| a container's memory pressure *some* ≥ 20% | 10 min |
| a disk ≥ 80% busy and its requests slow (≥ 300 ms spinning, ≥ 30 ms solid state) | 10 min |
| ZFS arc_prune ≥ 100 calls/s | 5 min |
| a ZFS pool not ONLINE | at once |
| a ZFS pool ≥ 85% full | at once |
| a filesystem ≥ 90% full | 10 min |
| memory available < 8% | 10 min |
| swap free < 15% (of a box with swap) | 10 min |
| SMART: failing, reallocated or pending sectors, media errors, ≥ 80% worn, too hot (≥ 70 °C NVMe, ≥ 55 °C other) | at once |
| **the box is dark**: no poll for 10 minutes | 10 min |

Each condition alerting is an Inbox alert on the Boxes tab ("wunder: ZFS's
cache is thrashing"), and the alert command with source `box-health`,
severity `warn` (`bad` for a pool, SMART or a dark box), and facts `box`,
`key` (the condition: `arc-prune`, `pool-rpool`, `fs-/`), `minutes`.

The control plane keeps per box: the last sample, the conditions now (when
each began, when it last alerted), and a history of one sample in ten for 30
days, in the runtime's data directory (`health/<box>.json`), never in its
state file.

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
with `--report-only` or by the owner. A report-only box's poll answers no
`start`, `bodyHosts`, `remotes` or `logins`, and `claim` refuses it, whatever
its `mayHost` says.

Until wunder has its box, host-watch keeps watching it.

## What moves where

| Old | New | Replaced when |
|---|---|---|
| `art-loom-bundle`, `art-loom-bundle.timer` | `loom backup` (core) | two good runs, drilled |
| `scripts/loom-backup.py`, `art-loom-backup.timer` | the same | the same |
| `art-boot-notify`, `art-boot.service` | box boot reports | live, and an alert seen end to end |
| `art-unit-alert`, `art-alert@.service` | box unit reports | the same |
| `host-watch`, `host-watch-sample.py`, `art-host-watch.timer` | box health, and a report-only box on wunder | the same, and wunder's box is in |

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
  ssh public key, a target that isn't `git:` or `path:`, and an `at` that
  isn't `HH:MM`.
- A run against a path target writes a bundle that `loom restore` with the
  owner's key opens, and that the drill key opens too; a bundle never holds
  a `drill.key`.
- A drill that mismatches once and then passes pushes; one that mismatches
  twice pushes nothing, and the state says why.
- A piece part in the last good bundle and missing now: the bundle is
  written, and the run is failed, naming the piece.
- A git target: a bundle over the split size is pushed as parts that rejoin
  to the drilled file; the branch is one commit after every run; `keep`
  nights plus each month's first are kept.
- A target holding files and no `.loom-backup` is refused before export.
- Due: not before `at` in `tz`, once a day, and only one of two schedulers
  racing for the lock runs.
- The Inbox has a backup alert after a failed run and after 26 hours with
  none, and none after a good run. Setup's Health shows the last run and
  drill.
- `LOOM_ALERT_COMMAND` hears a failure with source `loom-backup`; a
  `backup.alertCommand` in household.json is never run.

**Boots and units**

- A poll with a new `boot.id` leaves one FYI with the up and dark times and
  one alert command call; the same `id` again leaves none; a box's first
  boot leaves none. A changed `kernel` says the host restarted too.
- A unit reported failed is an Inbox alert and one alert command call with
  source `unit-<unit>`; still failed on the next poll, no second call; gone,
  an FYI and a `cleared=1` call. A unit matching `LOOM_RUNTIME_UNITS_IGNORE`
  is none of these.
- Journal lines reach loom with a webhook URL, a bearer token and
  `token=…` redacted.

**Health**

- Each rule above: a sample holding the condition for less than its *for*
  doesn't alert; for longer, it does once; 6 hours on, once more; cleared,
  an FYI. A reading the box couldn't take never alerts.
- A box silent for 10 minutes is a dark alert; its next poll clears it.
- A report-only box gets no houses, logins or sessions from poll, and
  `claim` refuses it.
- The sampler reads the fixtures of a Proxmox host's `/proc` and `/sys`
  (a fake root) into the sample the rules expect.

## Open questions

- **A warm standby** (household.md's open question): out of scope. The
  nightly bundle and the owner's key are the USB stick.
- **The monthly bundles in the one commit grow by ~100 MB a month.** At a
  year that's ~1.3 GB on GitHub. `keep_months` can cap it when it matters.
