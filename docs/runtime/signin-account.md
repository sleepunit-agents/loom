# Shared browser administration

The shared root installs three commands through its existing JSON command door:

- `POST /api/signin/endSession`
- `POST /api/signin/removeDevice`
- `POST /api/signin/revokeToken`

Each accepts `{input:{id},id?:requestId}`. The input id is a SHA256 fingerprint
or device reference, never a cookie, raw token or push endpoint. Success is
`{ok:true,value:{id}}`.

A current member can end their own browser or remove their own device. Current
household owners can end any browser, remove devices and revoke household tokens.
Agent and runner callers cannot use these commands. Authority is checked again
before receipt replay. Missing browser/device ids are authenticated idempotent
no-ops; replay returns only the supplied id, never removed metadata.

Ending a browser deletes its associated notification devices before deleting
the session. It preserves other browsers and devices, including those using the
same token. Removing a device preserves the browser session. Token revocation
marks the token revoked and immediately withdraws its bearer and session access.
It retains the token and related metadata for administration.

If a command ends its own credential, the shared door's final authentication
check returns 403 even though the removal committed. The client should refresh
`/auth/session` and show signed out; it must not retry a committed write through
a different identity.

`root.services.signin` is a trusted typed service. Its metadata readers select
explicit columns; device references hash push endpoints, and push keys are never
selected. Sessions/devices can be filtered by member. The token reader is for
household-owner administration. A canonical query adapter and actual Account
consumer are separate remaining work; no credential table was added to the
generated schema and no alternative read transport was installed.
