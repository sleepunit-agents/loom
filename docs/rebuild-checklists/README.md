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
