# Accepted trade-offs

Things in this program that are real costs and were chosen anyway. Each entry says what it is, where it
lives, why it was accepted, and what would change the answer. A reviewer who finds one of these has found
a decision, not an oversight; the site has a comment pointing here.

## Credentials

### A sign-in link carries its one-time code in the URL
- Where: `src/core/signin/shared-links.ts` (`makeLink`, `GET`/`POST /login/:code`); printed by `loom signin`
  and `loom-token link`.
- What: the code is the last part of the link's path, so a reverse proxy's access log, a browser's history
  or a terminal's scrollback can hold it.
- Why accepted: a link a person can be handed and open is the whole mechanism. The code is good once, for
  five minutes at most (`LINK_MS`); opening the page spends nothing, redeeming is a POST from that page, and
  the page sends only its origin as referrer. Putting the code in the fragment would need script on a page
  whose policy is `default-src 'none'`.
- What would change it: links that last longer or can be used more than once, or a deployment whose proxy
  logs are read by people who must not be able to sign in.

### The sign-in routes are not registered operations
- Where: `src/core/signin/shared-links.ts` (`sharedSigninLinkRoutes`): `/api/signin/token`,
  `/api/signin/program`, `/api/signin/link`, `/passkeys`, `/logout`, `/login/*`.
- What: these writes do not go through the operation dispatcher, so they have no `may` function and no
  receipt. Each route carries its own gate.
- Why accepted: every one of them answers with a credential (a token, a link, a cookie), and a registered
  write's answer is kept as a retry receipt for thirty days. The gates use the same authentication as every
  other door, refuse program tokens, and are checked before, inside and after the write.
- What would change it: a dispatcher that can run a write without keeping its answer. Then these become
  operations and the gates become `may`.

### A device sign-in's user code stays in the inbox item
- Where: `src/shared-account-signin.ts` (`runtime.signInPage`).
- What: for a provider's device flow, the short code the person types on the provider's page is part of the
  item's words and is not removed when the sign-in ends.
- Why accepted: it is meant to be read by that person, it grants nothing without the half the provider's
  program keeps on the worker, and it is dead when the flow ends. Rewriting an item's words afterwards
  would change what the person's own history says.
- What would change it: a provider whose user code is enough by itself, or stays valid after the flow.

### A pasted sign-in code is in clear for a moment, in two places
- Where: `inbox.answer_text` between the owner's answer and the worker's take
  (`src/shared-account-signin.ts`, `runtime.signInTake`); the `code` file in the relay's private directory
  on the worker (`src/runtime/account-signin-relay.ts`).
- What: the owner hands the code to loom by answering an inbox item, so it is an ordinary answer until the
  worker takes it (one poll, about two seconds), and the owner can read their own answer back in that time.
  After the take it exists only in loom's memory, then in a file only the worker's OS user can read, until
  the provider's program deletes it or the sign-in ends.
- Why accepted: an inbox answer is how a person gives loom words, and a file is how the provider's program
  is given them. The code is a provider's one-time code and is useless without the half that program holds.
- What would change it: an answer kind that never touches the database, or a provider program that reads
  the code from a pipe.

### A taken sign-in code does not survive a restart of loom
- Where: `src/shared-account-signin.ts` (`held`).
- What: once taken, the code is kept in memory for the one worker that took it. If loom restarts before
  that worker has read it, the sign-in fails and has to be asked for again.
- Why accepted: keeping it anywhere durable is what "handed over once" is meant to prevent, and the window
  is one request.
- What would change it: sign-ins failing this way in practice.

### An automated browser is recognised by its own name when nobody said it was one
- Where: `isAgentBrowser` in `src/core/data/authentication.ts`; `startBrowser` in
  `src/core/signin/shared-browser.ts`.
- What: a browser that calls itself HeadlessChrome gets the short session and may not make links or add
  passkeys. One that sends another User-Agent is treated as a person's unless its link was made with
  `loom signin --agent`.
- Why accepted: a link is a member's credential, and whoever is handed one is that member. The limit that
  can be relied on is the one the link's maker sets; the User-Agent check only catches the automation that
  does not hide.
- What would change it: agents being able to ask for links themselves.

### Root keys are readable on disk by their own process
- Where: `push-vapid.json` in the home (`src/core/signin/notification-key.ts`).
- What: the push-signing private key is stored in clear.
- Why accepted: the program has to read it unattended. The file is created exclusively with mode 0600 and
  read through `privateBytes`, which refuses a file that is not this OS user's, has another mode, or has a
  second link. Whoever can read the home as that user already holds the database.
- What would change it: running loom where an OS keyring or a hardware key is available to an unattended
  service.

### Passkey challenges are kept in memory and can be pushed out by a sustained flood
- Where: `src/core/signin/shared-passkeys.ts`.
- What: sign-in challenges live in a set of 1024 that drops its oldest when full. Somebody sending more
  than a thousand requests in the seconds a person's sign-in takes can still make that sign-in fail; a
  restart forgets outstanding challenges.
- Why accepted: the route has to answer strangers, and loom has no rate limiter of its own; a household's
  loom sits behind a proxy or on a private network. Sign-in by link is unaffected.
- What would change it: loom being served to the open internet with nothing in front of it.
