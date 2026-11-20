# Secrets grant asks

`secretGrantAttention(sources, operations)` connects the secrets piece to the
attention installer’s returned `AttentionSources` role. Compose it once, pass
it to both `installSecrets(..., attention)` and
`installSecretValues(..., holder, attention)`. This is an in-process capability,
not a registry operation or a substitute member token. The production next-mode
installer remains unwired until the authenticated holder and runtime are ready.

An agent’s request and its household ask commit together. The ask has no agent,
project or member scope; only a household owner can answer it. The first answer
calls `secrets.answer` as that actual member inside the same transaction. Yes
allows; No, Done and Dismiss deny. Always remains an explicit `secrets.answer`
action; a generic Yes never creates standing permission. A direct answer resolves
the ask. Removal cancels pending requests and resolves their asks in its metadata
transaction. Failure rolls back the request, ask, grants and retry receipts.

The source owns its asks: public raise and resolve cannot forge, overwrite or
detach them. A persisted `sourceManaged` marker makes answers fail closed after a
restart without the source installed. Requests also persist `attentionManaged`,
so direct grant answers and removal require synchronous resolution acknowledgment
even if secrets is later installed without the connector. The source callback must run synchronously
and throw if it cannot apply the answer. An asynchronous callback is rejected.
Source writers require the enclosing transaction on the same database and cannot
widen an ask to agent, project or private scope.

Affected tests are `src/pieces/secrets/attention.test.ts` and
`src/pieces/attention/source.test.ts`, alongside the existing piece suites. They
use `startLoom`, a fake clock and fake holder, with no subprocesses or real values.

This slice replaces the old secrets request card's answer/cancellation path only.
The complete old-to-new command ledger, persistent holder, authenticated runtime
adapter, importer, generated CLI, Settings app and final staging composition are
still tracked by t-2208. No live-home import, activation or deployment is part of
this change.
