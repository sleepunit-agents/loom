# Next mode

`loom serve --next --home <new-home> --port 8788 --staging` runs only the new side. Without `--next`, serve keeps
its existing behavior. Repeat `--host` to listen on several addresses in the same process. Next mode claims its
home with an OS socket; it never opens the old HTTP lock database. Linux uses the abstract socket namespace.

`src/next.ts` is the composition root: household tables and database sharing, in-repo piece registration, the
HTTP API, MCP operation tools and `/live`, plus the built `dist/web/next.html` shell at the root. It mounts no old
handler, collections, events or piece program. The default `nextSessionResolver(app)` denies every authenticated
call until the sign-in house connects it to loom.db (t-2203). `startLoom({ next:true, home, clock, install,
authenticate, sharing })` supplies the fixture sessions in tests. Neither next startup nor a missing import
selects an old store. The example screen is offered only when the fixture installed the example piece.

## Registering an app

A piece exports `{ id, title, path, icon, fit, Screen }`, following `web/src/pieces/tasks/registration.ts`.
`Screen` is a lazy React component taking `{ path, go }`; `fit` declares `min:[width,height]`, `ideal`, nullable
`max`, `big` and `why`. Add its registration to `web/src/apps.ts`; add its backend installation to `installNext`
in `src/next.ts`. The shell names no app. Home's piece can provide record-driven `Home` and `Rail` components
through `shellSurfaces` in the same registry. Those components take `go(path)`; the shell fetches nothing.

The shell selects desk or phone once, on load, at 1024 px. Desktop layout imports the existing pure tiling rule,
including admission by fit, promotion, caps and least recently used docking. Phone renders the focused app only.
The dock lists registrations. Tile back, forward and trail all read the router. Each app's path, minimized state,
order, focus and pin is carried in the address (`t`, `m`, `paths`); browser history retains per-tile trails. Reload
restores every app's own path. Open tiles are device state; no new mutable state file or server store is needed.
The existing look boot script, reduced-motion choice and sound synthesis are reused without fetching old settings.
Settings' piece can apply member preferences to the document's state; sound reads `data-sound=on`.

## Holding outside work

`startLoom` returns `effects`. A daemon job calls `effects.beforeOutside({ id, kind, title })` immediately before
IO, outside a database transaction. `id` is stable for that job attempt, and kind is `wake`, `bridge-send`,
`body-start` or `push`. If it returns false, the job stays due and must not reach outside. The piece still owns its
persistent job payload and rescheduling; this gate stores no credentials, message words or job payloads.

In staging, new effects are due. The owner calls `core.releaseEffect({ id })` (also exposed in the Held work app),
which releases only that id. The piece resumes the due job when it observes that release, and asks the same gate
again. The claim can succeed once. The piece calls `effects.finish(id)` after a known success, or
`effects.finish(id,false)` after an uncertain result. Restart turns an interrupted claim into `uncertain`; it is
never automatically released or repeated. New pieces must route every outside effect through this function.
Outside work is allowed immediately in normal next mode, with the same once-only claim and uncertainty record.

The table is `core_effects`, record type `core.effect`, household-owner visible through central policy. No old
command or route is replaced here: the old server remains behind the absent flag. The core operation and shell are
new surfaces. Existing Tasks commands and its importer retain their own contract and old-to-new table.

## The preview instance

The companion Art PR adds `units/loom-next.service`, optional deploy restart/health/rollback participation, and
`docs/loom-next.md` with coordinator steps. The unit is not enabled or started by this work. It uses the shared
immutable main release but its own home `~/.config/loom-next`, port 8788, and always `--next --staging`. The
coordinator waits for next sign-in before opening it; real-data refreshes use verified offline importers into a
fresh separate home, on demand. No import or deployment runs as part of this implementation.
