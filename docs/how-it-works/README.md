# How loom works: the goal

`site/` is the description of the finished product, page by page: what each
part is, what a person sees, how the parts connect, who can see what, and the
data model under it. Jonathan read every page and approved it on 2026-11-14.
Read it at <https://sleepunit-agents.github.io/loom/> (published from `site/` on
every merge to main), open `site/index.html` locally, or read `model.py` for
the tables.

## This is where we are going

The site is the goal, and the only one. Work on loom's web side is done when
the running program does what these pages say.

Nothing else in this repository is a requirement. The code, tests, tables,
specs and documents that exist today, on the old side and on the side built
since 2026-11-12, are what we happened to make while working out how to get
here. Use any of it that already does what a page says. Delete or replace the
rest. You do not need to keep it working, port its tests, match its commands
or explain its removal with an old-to-new table.

Where a spec, a document or existing behaviour disagrees with the site, the
site wins. Where the site is silent, choose the simplest thing that fits its
ground rules (front page) and say what you chose in the pull request.

Two things are not leftovers:

- The household's real data, and agents' memories above all. The site calls
  memories the one precious thing. Building never touches the real home.
- The site itself. Changing what a page says is the owner's decision, not a
  builder's. If a page is wrong or contradicts another, say so and carry on
  with the rest.

## Files

- `model.py`: every table, column and relation, with the plain-language
  meaning of each. The Drizzle schema is written from this.
- `site_build.py`, `pages2.py`: generate `site/*.html` and `site/site.js`
  from `model.py`. Run `python3 site_build.py` after a change.
- `shoot.js`: screenshots of every page with Playwright
  (`node shoot.js <outdir> [full]`).
- `site/`: the generated pages, `site.css` and fonts. Static; no server needed.
