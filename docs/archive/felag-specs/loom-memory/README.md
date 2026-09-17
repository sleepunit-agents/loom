# loom-spec

felag specs for [loom](https://github.com/jbarket/loom), Art's identity + memory substrate.

## `spec/loom-memory` — `c-loom-memory`

The **excavated** contract of loom's episodic-memory model — produced by felag
**ceremony 4** (art-ubo, the first brownfield/`excavate` ceremony). Unlike the
greenfield ceremonies (watchdog, taskstore), nothing here was *authored*: every
criterion was **read out of the loom codebase** and carries `source: discovered`
provenance pointing at the file/line it came from.

### What it records

- **Categories** — the six-value write vocabulary `{user, project, self,
  feedback, reference, pursuit}`, *closed on write* (enum-enforced) and
  *open on read* (legacy reachability), plus the six meanings as a judgment.
- **remember is insert-only** — the store never dedups; "dedup-before-save" is
  the *writer's* discipline, served by the `find_similar` / `audit` affordances,
  not enforced by `remember`. (The archaeology-vs-invention line of the dig.)
- **recall & find_similar** — the *deterministic* filter/projection over a cosine
  vector search (category `all`-sentinel, project filter, `limit`, self-exclusion,
  `minRelevance`, `relevance = 1 − distance`), isolated from the
  *non-deterministic* embedding ranking (recorded as a descriptive judgment).
- **TTL & prune** — expiry arithmetic and the hard-expire / soft-stale split.
- **Two boundaries** — memory-vs-knowledge ("true independent of Jonathan →
  knowledge") and memory-vs-work-store (loom owns memory/knowledge/identity and
  offers *no* work-tracking surface — loom's side of taskstore's
  `ac-ts-loom-boundary`).

### Status

Emitted as `felag/excavate-output@0` — `validateExcavateOutput` accepts, `lint`
clean. Excavate output **gates no one**: every criterion ships `proposed`. The
normative subset is then activated via the felag **promotion** protocol (the
`source:discovered → active` path); genuinely-descriptive criteria (ranking
quality, the soft category meanings) are left `proposed` on purpose.

```
felag lint spec/loom-memory
```
