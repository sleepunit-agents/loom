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
- **the digest of the owner token it signs in as.** In a household that's a
  token of its own (t-1969, 2026-11-07), minted for the signed-in member when
  the passkey is added, labeled `passkey · <person> · <12 hex of the credential
  id's hash>`, and kept by digest alone, so nobody ever holds it. Revoking the
  page sign-in links token, or whichever token the adding browser used, never
  stops a passkey (revoking the links on 2026-11-07 stopped Jonathan's only
  one, which is why). What stops it: removing the passkey (its token is revoked
  with it, so the sessions it opened end too), removing the person from the
  household, or revoking its own token. A passkey gets exactly what its person
  has, never more. Outside a household (a single bearer token), a passkey still
  signs in as the adding session's token, and only while that one is live.

  Passkeys made before this signed in as the adding session's token. loom-http
  moves each onto a token of its own when it starts (once; a second start does
  nothing): one whose token is live, or is the env owner token, and one whose
  token is a revoked page sign-in links token. A passkey whose token was any
  other revoked one stays stopped, as does one whose person has left.

Up to 20 passkeys. Each one can be removed on the Passkeys page.

## Signed-in sessions, each ended alone

(t-1871, 2026-11-07.) Account's **Signed in** lists every browser session this
person may see (a household owner, all of them; an agent owner, their own),
this device first. Each row says what it is (the browser and system its
User-Agent named when it signed in), the label its sign-in link carried, when it
signed in and was last used (noted at most every five minutes), and the token it
signed in as. **Sign out** on a row ends that session alone: its cookie stops
working at once and its notifications stop, and every other session, those of
the same "page sign-in links" token too, stays signed in. A row names its
session by a ref, the first 16 hex of the hash of its id, which is no use as a
cookie.

On loom's machine, `loom sessions list` and `loom sessions revoke <ref>` do the
same. A script that signs in for screenshots makes its link with
`loom token link --label "<what for>"` and ends its own session with
`POST /logout` before it closes; `loom sessions revoke` is for one that didn't.

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
GET  /passkeys                           the page (also /account, the Profile app): the passkeys, Remove, and "Add a passkey"
POST /passkeys/options   {_csrf}         → creation options (challenge, rp, user, algorithms, excludeCredentials)
POST /passkeys           {_csrf, label, id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm}
```

The page is the Profile app (web/src/account.tsx, t-1925): in a big window two columns, the left your name card (your
name as People has it; "Owner of the household", or "Owns <agents>" for an agent owner, then "· member since" the month
of your oldest owner token) then the Passkeys panel with a normal-size "Add a passkey" in its header, which opens a name
field in the panel; the right the agents you own (an agent owner: only theirs), each with its state in the words its
own page uses (Working, Available, Unavailable, Broken), notifications on this device, another device and Sign out. In
a narrow tile or on a phone, one column, name first. It keeps no signed-in-device list: a session holds only when it
was issued and its token, no device or last-seen (src/ui/sessions.ts).

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
- the token behind it is still live (in a household, its own token, and its
  person still a member).

Then it opens a session exactly as the token or a link does.

## The script

loom's page runs no script, and its CSP forbids it. Passkeys need one: the
WebAuthn calls are JavaScript. loom serves its own, `/login/passkey.js`, and
only two pages allow it (`script-src 'self'; connect-src 'self'`): the sign-in
page and the Passkeys page. Everything else keeps `default-src 'none'`, and
pieces still can't put script on the page at all.
