# Passkeys: signing in to loom's page

**Status:** built, 2026-10-26.

A passkey replaces pasting a token or fetching a sign-in link on every new
browser. You sign in once with a link, add a passkey from the page, and after
that, on that device, *Sign in with a passkey* is one tap and Face ID or a
fingerprint. A link (`loom token link`) is still the way in when there's no
passkey, and the way back if a device is lost.

## What a passkey is to loom

A WebAuthn credential that's discoverable (`residentKey: required`), so signing
in needs no name, and that's verified by the person (`userVerification:
required`). loom keeps, in `ui-sessions.json` beside the browser sessions (0600,
under the same lock):

- the credential id, its public key (SPKI, as the browser gives it) and algorithm
  (ES256, EdDSA or RS256);
- its signature counter;
- a label, when it was added, and when it was last used;
- **the digest of the token whose session added it.** A passkey signs in as that
  token, and only while that token is live: rotate or revoke the token, and its
  passkeys stop with its sessions. A passkey never gets more than the link that
  set it up.

Up to 20 passkeys. Each one can be removed on the Passkeys page.

## Where it works

Only at loom's public HTTPS address, `LOOM_PUBLIC_URL` (for example
`https://loom.example.com`). That's the passkeys' origin, and its host is their
RP ID. WebAuthn needs a secure context and a domain, so a plain-HTTP or IP
address can't use passkeys (`http://localhost` is the one exception, for development). Without `LOOM_PUBLIC_URL`, the page says passkeys
aren't set up, and the token and link sign-ins work as before.

## The flows

Every passkey route is same-origin only, the same as every other form. A
challenge is 32 random bytes, kept by hash, used once, and good for 5 minutes.

**Adding one** needs a signed-in session, and the form token for it:

```
GET  /passkeys                           the page: the passkeys, Remove, and "Add a passkey"
POST /passkeys/options   {_csrf}         → creation options (challenge, rp, user, algorithms, excludeCredentials)
POST /passkeys           {_csrf, label, id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm}
```

loom checks:
- `clientDataJSON`: type `webauthn.create`, this challenge, this origin;
- `authenticatorData`: the RP ID's hash, the user-present and user-verified
  flags, and attested credential data whose id is the credential's id;
- the public key: it parses as SPKI, and its type fits the algorithm.

The browser hands over the public key with `getPublicKey()`, so loom needs no
CBOR or COSE decoding and no dependencies.

**Signing in** needs nothing but the passkey:

```
POST /login/passkey/options              → request options (challenge, rpId, no allowCredentials)
POST /login/passkey      {id, clientDataJSON, authenticatorData, signature}
```

loom checks:
- it knows the credential;
- `clientDataJSON`: type `webauthn.get`, this challenge, this origin;
- the RP ID hash, user present and user verified;
- the signature over `authenticatorData ‖ sha256(clientDataJSON)` with the
  stored key;
- the counter: a counter that doesn't go up, when either side has one, means a
  copied key, and is refused;
- the token behind it is still live.

Then it opens a session exactly as the token or a link does.

## The script

loom's page runs no script, and its CSP forbids it. Passkeys need one: the
WebAuthn calls are JavaScript. loom serves its own, `/login/passkey.js`, and
only two pages allow it (`script-src 'self'; connect-src 'self'`): the sign-in
page and the Passkeys page. Everything else keeps `default-src 'none'`, and
pieces still can't put script on the page at all.
