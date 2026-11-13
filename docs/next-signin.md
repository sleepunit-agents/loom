# Next-mode sign-in

Next mode resolves requests and socket upgrades from loom.db. It does not activate the old file backend. The existing SessionDatabase and TokenDatabase row stores are shared with the household importer.

| Existing behavior | Next mode |
| --- | --- |
| Browser cookie, token binding, expiry | nextSessionResolver, keyed session/token lookup |
| POST /logout | same-origin, session CSRF, delete row, close socket |
| loom token link | loom token link --next --member PERSON; signin.link operation |
| GET /login/CODE | confirmation button only, no spending or reflected code |
| POST /login/CODE | atomic spend and session creation |
| POST /passkeys/options, /passkeys | fresh session, CSRF, one discoverable WebAuthn user per member |
| POST /login/passkey/options, /login/passkey | expiring challenge, signature, user verification and counter checks |
| Agent bearer | agent:name[/service][@house] maps to agent name |
| Runner/service bearer | runner:id and service:id map to their respective viewer kinds |
| Token revoke | signin.revokeToken operation emits core.access and closes affected sockets |

Cookies retain the loom_ui name and imported sessions retain their original token binding. The old source is untouched. No importer change is needed. Passkey user ids retain the old first-owner seed and per-member seeds. Each newly added passkey has its own member token, independent of the registering session's token.

LOOM_PUBLIC_URL sets the passkey RP and the trusted public origin behind TLS termination. Its host must match the request Host. Forwarded headers are not trusted. Cookie sockets require an Origin; bearer sockets may omit it. The live transport accepts an optional origin predicate so next mode uses this same rule without changing the old transport's default.

signin.link is intentionally ephemeral: it mutates credential rows in a transaction but is not entered in the operation retry journal, which must never retain a returned sign-in URL. The CLI does not retry. A lost response can leave a short-lived unused link. Its HTTP door accepts bearer credentials only; browser sessions cannot mint links that refresh a stale sign-in. Link creation is restricted to household owners. This narrow sign-in delivery does not replace the old Account administration or notifications apps.

For the final move, import the old household into a separate stopped next home, serve it with --next and LOOM_PUBLIC_URL, and verify existing browser cookies and agent tokens there. No live-home import or rollout is part of this change.

Machine principals are explicit and fail closed: a household owner enables or disables a runner/service id through signin.setPrincipal, backed by credential principal settings rows. Unknown or disabled ids cannot use even an otherwise live token. Disabling emits core.access and closes existing sockets. Runtime/service setup should call this operation when adding or removing its principal; tokens alone do not register a machine. This keeps credential validation independent of unfinished runtime execution integration.
