# Measuring module

The product goal is the approved Measuring page in `docs/how-it-works/`.
`src/core/measuring/index.ts` implements its instrumentation lifecycle. It is
an internal module, not another endpoint or a settings authority. The root installs it when the household uses the approved shared schema. It creates no tables and never upgrades an existing home.

The integration supplies owner-approved settings, a fixed inventory of names
from code, and optionally a `TimingStore` backed by the shared Drizzle model.
Never pass request paths, arguments, query text, conversation ids or results
as names. Both sync and async wrappers preserve the application's result or
error; use `runAsync` for promises. Instrument requests at their dispatch,
operations at their dispatch, and background jobs at their execution boundary,
regardless of the implementation inside them. Do not wrap a whole async job
with the synchronous wrapper.

Off returns immediately without loading the OpenTelemetry SDK, reading a
clock, accessing storage, starting timers or creating an exporter. Enabled
instances use an isolated OpenTelemetry tracer provider: local daily rows and
optional OTLP HTTP/protobuf export consume the same spans, with no sampling.
No process-global provider is installed. This avoids changing another host
application's instrumentation. These wrappers currently produce individual
spans; they do not install automatic HTTP/SQLite instrumentation or propagate
parent tracing context.

`src/core/measuring/store.ts` supplies the shared model adapter. It implements
`TimingStore.add` atomically: add `count`
and `total_ms`, take the maximum `slowest_ms`, and set `typical_ms` to the
arithmetic mean (`total_ms/count`). Its key is `(day, kind, name)`. These are
the page's real columns, not a JSON document or a separate monitoring database.
Kinds are request, operation and job. A span is assigned to its completion
day in UTC. `prune` deletes days before the supplied cutoff; today counts as
one of `keep_days`. Retention runs at startup and each UTC midnight, even while idle,
and also before the first completed span of a new UTC day. Closing cancels
the timer. Disabled and outside-only instances schedule no retention work. Storage failures are reported through a payload-free callback and do
not change the outcome of application work.

Choices where the page is silent: 90 days by default, configurable from 1 to
3650; at most 2048 registered code names; arithmetic mean for typical;
HTTP/protobuf for outside export. The configured address is the full OTLP
traces URL (usually ending in `/v1/traces`). No outside exporter is created
unless explicitly enabled with an address. Export batches and queue are
bounded (64 and 512 spans), with a 3-second transport timeout. Local storage
can run alone, outside export can run alone, or both can run together.

Call `close` before replacing an instance when settings change. It immediately
fences local recording, including unfinished async work, then shuts down the
SDK and drains spans already queued for export. Repeated close calls share
one promise. Call `flush` when a lifecycle boundary needs already-ended spans
exported. Turning off must replace the instance with the off instance; an
unapproved request must never be allowed to call the internal factory with
enabled settings.

`measuringSettingsService(db)` reads the shared singleton without creating a
row for an unconfigured household. `prepare(settings)` returns the setting
request fields for the shared Approvals service: target `measuring`, operation
`measuring.settings`, persisted before/after details and their exact displayed
summary. It makes no changes. Register `service.apply` under that operation in
Approvals' operation map. Allow then applies the validated change in the same
database transaction as the answer and audit; stale proposals fail and require
a fresh card. Pending proposals survive process restart without closures or a
second payload store. The authenticated outside door restricts Allow to a
household owner. Reload the Measuring instance only after that transaction
commits; the handler performs no SDK, timer or outside work. The root mounts `measuring.propose` and `measuring.answer`; agents propose, and only a current shared-model household owner can answer. An optional validated conversation ties the question to its thread.

`installMeasuring` owns startup, settings reload and shutdown. Successful answers schedule a committed-settings refresh after the synchronous outer transaction has returned. Failed transactions do not refresh; unchanged settings and receipt replays do not replace the SDK. Shutdown fences the runtime before closing SQLite. The root instruments HTTP request completion, all registered operation dispatches, and the Changes daemon's background GitHub reads. Names are code-defined and exclude URL paths and payloads. The shared Approvals tile and inline card render before/after and bind Measuring Allow/Deny to the authenticated API. There is no standalone Measuring settings screen: changes originate in chat through the proposal operation.

`src/core/measuring/visibility.ts` supplies the read policy for that endpoint:
include `timingDays` and `measuringSettings` in its selected tables and merge
`measuringVisibility(authenticatedViewer)` into its visibility map. Registered
agents and current household owners can read daily rows; settings are visible
only to current owners. The predicates check membership in SQL on every read,
including for a retained generated schema. They snapshot the supplied identity;
the outside door must still authenticate it and check token/session validity.
This module creates no endpoint and grants no settings writes. The root mounts both tables and this policy on the same HTTP and websocket query schema.

OpenTelemetry references: [JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
and [exporters](https://opentelemetry.io/docs/languages/js/exporters/).
