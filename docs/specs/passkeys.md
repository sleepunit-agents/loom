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
  token of its own (t-1969, 2026-11-07; `src/ui/passkey-tokens.ts`), minted for
  the signed-in member when the passkey is added and kept by digest alone, so
  nobody ever holds it and only the passkey can use it. It's an owner token
  naming that member, so a passkey reaches exactly what its person does, never
  more. Its record says what it is: labeled `Passkey: <the passkey's name> ·
  <person> · <12 hex>`, with `passkey` (the sha256 of the credential id) and
  `from` / `from_sha256` (the token the adding browser was signed in with). The
  token list (`loom token list`, an agent's Setup) shows that label and what it
  was made from; Profile's Passkeys row says what it was added from; a session
  it opened shows in the signed-in list as that label.

  Revoking another token never stops a passkey on its own: revoking the page
  sign-in links on 2026-11-07 stopped Jonathan's only one, which is why this
  changed. Revoking a token offers to take the passkeys made from it too
  (`loom token revoke <label> --with-passkeys`; on Setup, "Revoke a token with
  its passkeys"): each one's token is revoked and the passkey removed. Plain
  revoke leaves them working, so routine link cleanup never kills a passkey.
  Taking them follows the line down: a passkey added from a browser that a
  passkey made from that token signed in goes too. Removing a passkey works the
  same way: plain Remove leaves the passkeys added from its sessions working;
  "Remove a passkey with the ones added from it" (Profile) takes them too.
  Each offer counts every passkey it would take, down the line.
  What stops a passkey: removing it (its token is revoked with it, so the
  sessions it opened end too), removing its person from the household, or
  revoking its own token (it then shows as stopped, and can be removed, by an
  agent owner too).

  Outside a household (a single bearer token), a passkey still signs in as the
  adding session's token, and only while that one is live.

  Passkeys made before this signed in as the adding session's token. When
  loom-http starts, each one whose token is still live, or is the env owner
  token, moves onto a token of its own for that token's person, made from it
  (once: a second start mints and moves nothing; one that fails is said on
  stderr and doesn't stop the others). One whose token was revoked, expired or
  is gone from `tokens.json`, or whose person has left, stays as it is: it
  doesn't sign in, its row says it stopped working, and a new one is added in
  its place. Nothing revives a passkey whose token was revoked. One whose
  person left is like that person's tokens: removing a member revokes nothing,
  so adding the same person back brings their tokens and passkeys back with
  them (remove the passkey, or revoke its token, to end it for good).

Up to 20 passkeys. Each one can be removed on the Passkeys page.

## Signed-in sessions, each ended alone

(t-1871, 2026-11-07.) Account's **Signed in** lists every browser session this
person may see (a household owner, all of them; an agent owner, their own),
this device first. Each row says what it is (the browser and system its
User-Agent named when it signed in), the label its sign-in link carried, when it
signed in and was last used (noted at most every five minutes), and the token it
signed in as. **Sign out** on a row ends that session alone: its cookie stops
working at once, and every other session, those of the same "page sign-in
links" token too, stays signed in. A device's notifications aren't a session's
(see "Notifications" below), so they stay. A row names its
session by a ref, the first 16 hex of the hash of its id, which is no use as a
cookie.

On loom's machine, `loom sessions list` and `loom sessions revoke <ref>` do the
same. An agent that signs in for screenshots makes its link with
`loom token link --agent --label "<what for>"` and ends its own session when
done with `POST /logout` from that browser, or
`loom sessions revoke --label "<what for>"`; never `loom token revoke` on the
links token, which signs out every browser a link opened (t-1936). An agent's
session (one made with `--agent`, or any from a headless browser) is listed as
`(agent)`, ends six hours after it signed in, and goes first at the 50-session
cap: past the cap, sessions already ended (past their time, or their token
revoked) go first, then agents', then the oldest of the rest. So agents'
screenshots never push a person's own session out.

## Notifications

(t-1978, 2026-11-08.) A device's notifications are its person's and the
device's, never a session's. They used to be kept under the session they were
turned on in and dropped when it went; agents' screenshot sign-ins (about 20 a
day) pushed the oldest sessions past the 50-session cap within days, and every
device's subscription went with them, while the device itself still said On.

Now a device stays on whatever happens to sessions: others evicted or signed
out, its own signed out, or the device signing in again. The app sends the
device's subscription again on each load, so loom's record of it can't quietly
go missing. It goes only when:

- its person turns notifications off on that device;
- its person removes it on Profile (**Remove a device**); the device sending it
  again by itself is then refused, and it's back only when turned on there;
- the push service says it's gone (404 or 410);
- its person leaves the household.

Profile's Notifications lists every device of yours that gets them, this
device marked, each with **Send a test notification**, which sends one to that
device only.

## Where it works

Only at loom's public HTTPS address, `LOOM_PUBLIC_URL` (for example
`https://loom.example.com`). That's the passkeys' origin, and its host is their
RP ID. WebAuthn needs a secure context and a domain, so a plain-HTTP or IP
address can't use passkeys (`http://localhost` is the one exception, for development). Without `LOOM_PUBLIC_URL`, the page says passkeys
aren't set up, and the token and link sign-ins work as before.

## The flows

Every passkey route is same-origin only, the same as every other form. A
challenge is 32 random bytes, kept by hash, used once, and good for 5 minutes.

**Adding one** needs a signed-in session that signed in within the last 10
minutes (one left signed in on a desk can't quietly add a lasting way in;
the page says to sign in again), and the form token for it. Signing in is a
token, a passkey, or a link made on loom's machine (`loom token link`); a link
the page makes ("Make a one-time sign-in link", or a Members link, for
anyone) opens a session that signed in when the one that made it did, so it
can't freshen a stale one. Asked for options, a member is told only their
own credentials to exclude. This holds outside a household
too:

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
