# Batched morph mounts

A commit used to attach each host, capture its paint and measure it before
starting the next host. Each host therefore forced the styles/layout dirtied
by its neighbour. Mount jobs now share a microtask after React's layout effects:

1. Capture old authored values for every host.
2. Remove old decoration and restore overrides.
3. Read eligibility, radius, position and settings.
4. Mount decoration and suspend paint rules/transitions.
5. Sample authored paint for every host.
6. Restore paint and transitions.
7. Read visual signatures and geometry for every host.
8. Commit SVG sizes and first frames.

Cleanup cancels queued jobs and releases mounted resources. Hidden hosts stay
undecorated until shown. Reduced motion uses the person's root preference;
explicit bodies remain static when automatic motion is disabled. Resize work
also measures all bodies before writing any SVG size in the frame pass.
Comms' list/log stopgap is removed so these paths use the normal motion policy.
Theme/pointer repaint events still have their existing synchronous behavior;
this change addresses attachment and frame geometry, not every paint trigger.

## Reproduce

Build/install dependencies as usual. Set `LOOM_TEST_CHROME` if Chrome is not
in `/usr/bin/google-chrome` or `/usr/bin/chromium`.

- `npx tsx scripts/morph-bench.ts --out after.json` mounts 10/40/80 real React
  hosts, three runs each, capturing CDP counters and layout/style trace events.
- To compare the same fixture with the original hook, save
  `git show f5a1c383:web/src/lib/cojeev-motion/use-morph.ts` to a temporary file
  and set `MORPH_SOURCE` to that file for the benchmark. No production code is
  replaced by the benchmark.
- `scripts/nav-bench.ts --serve` provides the existing disposable household
  with 40-message threads. `scripts/morph-nav-profile.ts --server-log LOG
  --out result.json` profiles two initial thread opens and a reopen, saving full
  CDP traces and CPU profiles beside the summary. On the old checkout, remove
  Comms' two `data-motion="off"` stopgaps **for the comparison build only**.
  The driver refuses a thread with fewer than 20 decorated paths. Use only the
  disposable server's log; never a real household token.
- `npx vitest run src/ui/morph-mount.integration.test.ts` checks bounded CDP
  costs, decoration ready before paint, queued cleanup/StrictMode, restoration
  of authored styles, hidden/show, resize, paint, reduced motion, and press.

## Measured on Chromium, November 9, 2026

Initial three-run fixture measurements, with reduced motion and every path drawn:

| Hosts | Before style/layout passes | After style/layout passes |
| --- | --- | --- |
| 10 | 42 / 11 | 4 / 2 |
| 40 | 162 / 41 | 4 / 2 |
| 80 | 322 / 81 | 4 / 2 |

The bounded-cost browser regression fails against the original source:
`expected 322 to be less than 12`.

Real nav-bench 40-message thread reopen, with all 40 morph paths enabled on
both builds: before 200 style recalculations / 180 layouts, 1504 ms style work,
2319 ms main-thread tasks; after 43 / 19, 252 ms style work, 1092 ms tasks.
These are whole-page totals, including navigation, Markdown and other controls.
They are not counts for morph alone, and timings on shared hardware vary.
The repeatable result is that morph attachment costs stay bounded as host count
grows; no timing threshold is asserted in the regression.
