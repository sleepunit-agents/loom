# Next-mode existing-credential sign-in review

## Assessment

High: data/irreversible effects (session deletion and one-time consumption),
security (sign-in and CSRF), consumed contracts (auth routes and window identity),
concurrency (challenge/counter/link transactions), delivery/environment (public
origin and TLS termination). The sixth trigger does not apply: targeted transport
fixtures and CI recheck the behavior. Three rounds maximum under the project brief.

Claim: next mode can authenticate existing row-backed credentials without old-file
discovery. This unblocks next-mode integration while preserving imported sign-ins.

Review inputs: frozen repository trees plus REVIEW.patch and a contract only.
No prior findings or author reasoning entered the prompts. The contract requires
row-only auth; preserved imported browser cookies/CSRF and tokens; correct token,
link and existing-passkey sign-in, expiry, replay, revocation, member removal,
caller binding, window attribution, CSRF and origin checks. New registration,
owner management and the sign-in UI remain follow-up work.

## Rounds and reconciliation

1. BLOCKING, tree `c6a978b2dcde791e4cef3706bba671277bbdcd42bd199952de4a1f51da3c09d8`.
   - CRITICAL, actionable: expired bearer subscriptions could receive outbound
     updates. Every outbound socket send now rechecks authentication; a fake-clock
     subscription test expires a token then emits an update and proves closure
     without delivery.
   - CRITICAL, actionable: cookie socket mutations lacked CSRF proof. Authentication
     supplies a session-bound call proof validator; socket calls carry `csrf`.
     Tests cover denial without proof and successful calls with it.
   - MAJOR, actionable: rejection coverage incomplete. Added expired/revoked-token
     browser checks and removed-member token/link/passkey/session/logout checks.
   - NIT, actionable: extracted successful sign-in response helper.
2. BLOCKING, tree `4baeaba71ca138fdd5d2763e2f1507f58554e3ae863ab322fb0440f7ed599414`.
   - CRITICAL, actionable: replacing the first owner could reassign an unnamed
     token on a fresh request. Startup persists original owner-token member
     bindings, including inactive tokens; later resolution rejects member
     removal or explicit reassignment. Tests cover fresh HTTP requests and restart.
   - CRITICAL, actionable: cookie-bearing sign-in routes bypassed CSRF. All auth
     POSTs with an existing valid browser session now require its proof. Tests
     cover token/link/options/assertion routes and a valid-proof options request.
   - MAJOR, actionable: MCP post-admission recheck untested. Added an authenticator
     that becomes invalid after admission; the tool returns denied.
   - NIT, initially accepted small duplication: HTTP/socket origin checks repeated.
     Subsequently folded with round 3's origin fix into one core helper.
3. BLOCKING, tree `66b2d0bc6f2534b75aff4263acf2717dc17d987fa7e135492f98d8fafdfbf9f7`.
   - CRITICAL, actionable: sensitive GETs with no Origin could ignore browser
     fetch metadata. A shared trustedRequestOrigin policy now rejects same-site
     and cross-site metadata on sensitive HTTP routes and live upgrades. Tests
     exercise cookie session GETs without Origin, same-origin success, and live
     upgrade rejection without Origin.
   - NIT, actionable: shared the HTTP/socket origin policy in the same helper.

Round 3 convergence: all CRITICAL/MAJOR folded; one CRITICAL versus two in round 2;
no finding repeated an earlier claimed fix. Stop at the project's three-round
bound. The review is explicitly **unconverged**, not CLEAR. No fourth round was
run. Author judgment after the final folds: no known remaining hole in this slice.
The review is evidence and does not authorize merging.

## Validation

- Importer-to-startLoom test fails unchanged main `37be682a8ccc9e1d718974592f92d194c76cf867`
  with 401 instead of 200. Changed code accepts the original browser cookie/CSRF
  and original bearer token after the stopped source directory is removed.
- Final affected run: 83 tests pass across 8 files in 921ms; one optional built-shell
  test skipped because the checkout has no built web shell. TypeScript passes.
- A broader legacy run: 104 pass, two HTML-root 503 failures. Both failures
  reproduce on unchanged main in the corresponding two tests; no new failure.
- No browser suites, real imports, running-home changes, installation or deployment.
