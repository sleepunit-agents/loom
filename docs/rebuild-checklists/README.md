# The approved site's checklist

One JSON file per approved site page, including the front page. The site's
promises are copied verbatim from its behavior lists, explanations, connections
and visibility rules. Narrow visible criteria have explicit browser probes;
others stay **not checkable yet** until the walkthrough actually exercises them.
Tables from `model.py` are listed as model references, not counted as user actions.
The source page's SHA detects drift rather than silently measuring older words.

Regenerate these copies with `python3 scripts/rebuild-checklists.py`. This never
edits the approved site. Add behavioral probes in the generator as the walkthrough
grows. Do not turn a button's presence into proof of the action behind it.

The walkthrough writes `report.md` and `report.json` beside its screenshots and
raw `walkthrough.json`. Read all three counts: met, not met, and not checkable yet.
A successful evidence job does not mean loom meets the site. To regenerate the
report from an existing run: `node scripts/rebuild-report.mjs <artifact-directory>`.

Start with **Page summary** in `report.md`: each of the 18 guided pages and the
front page has met, not met and not checkable yet counts, an overall result,
an owning task, and a link to its promise list. A page is **not met** if any
promise failed; otherwise it is **not checkable yet** while any promise is
untested. Only a page with every promise checked and met is **met**. There
is no completion percentage that counts untested behavior as passing.

For a failure, follow the page link, read its reason, then open the evidence
beside the report. `walkthrough.json` contains captured screen text, errors,
subscription frames and action results; PNGs show the actual browser. Report
observed gaps to the listed owning task. Unchecked promises describe missing
measurement coverage, not demonstrated product defects. `report.json` exposes
the same page summary in `summary`, with individual results under `pages`.

CI publishes these files in the **Rebuild walkthrough** workflow's
`rebuild-walkthrough-<head SHA>` artifact. The SHA identifies the tested branch
head; compare it with `next` before treating a run as evidence for current
code. Download the whole artifact so relative screenshot links work. A green
workflow means evidence collection completed; the page summary is the product
measurement. The run can succeed while promises are not met.

For a fresh example home, run `node scripts/example-home.mjs <new-home>`
after building. `node scripts/rebuild-walkthrough.mjs <artifact-directory>`
creates its own disposable home, starts the built program, signs in, visits
every launcher app and writes the report. Set `LOOM_TEST_CHROME` to the browser
executable when needed. Run browser measurement on a worker or in CI, never on
loom's machine. No installed home or household data is used.

The browser job also writes the per-page table into the Actions run summary,
so the coordinator can see failures and missing coverage before downloading the
artifact. Keep the artifact for promise-level reasons, screenshots and raw facts.
