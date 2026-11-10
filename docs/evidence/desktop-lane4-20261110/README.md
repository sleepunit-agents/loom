# Desktop lane 4 verification

Source: main adff0eb1223d1a1701c3b4c26882f924bbcbd68f. No product change.

Fresh production build passed; serial focused tests passed 38/38:

```
LOOM_TEST_CHROME=/usr/local/bin/chrome-headless-shell LOOM_DESK_SHOTS=/tmp/lane4-evidence nice -n 19 npx vitest run src/ui/home-live.integration.test.ts src/ui/agent-desk-ticker.integration.test.ts src/ui/agents-live-ticker.test.ts src/ui/ticker-activity.test.ts src/collections/agent-status.integration.test.ts src/ui/web-app.test.ts --maxWorkers=1
```

JS 224289 B gzip (budget 230000); CSS 72890 (budget 120000).

Home captures: 1440/390, neon/lowlight/daylight, reduced motion. Before: no observed activity, honest Activity unavailable. After: fixture emits a fresh safe action, Reading a file / a wake, reaching the open page through live cards. These are before/after a data update, not a claim that the old implementation was changed here. screenshots-proof.json records displayed words and overflow. ticker-* captures additionally check long agent/page names at 1024/1280/1440/1920. No real private messages, credentials or host sessions appear in these synthetic fixtures.

Reproduce Home screenshots by copying capture.mts to the repository root, then running nice -n 19 npx tsx capture.mts after npm ci / npm run build.

Remaining: t-2010 waits on runtime manifest latency t-2064 and installed/live proof; t-1925 waits on stored task project membership and project chips t-2107. Morph performance t-1927 is already closed with installed proof. No host installation or live performance proof in this run.
