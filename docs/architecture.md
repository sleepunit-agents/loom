# loom at a glance

Every moving part of loom and where they touch, drawn from the source.
The diagrams are Mermaid, so GitHub renders them in place.

This map is kept honest by `src/architecture.contract.test.ts`. Every
registered MCP tool (including the MCP-App widget tools), every CLI subcommand, every `src/backends/` module
and every SQLite table must be named on this page, or CI fails. When you
add one of those, draw it here in the same PR.

## The whole machine

```mermaid
flowchart LR
  subgraph callers["Who calls loom"]
    H["Harness agent<br/>Claude Code · Codex · Gemini CLI · Desktop"]
    P["Peer identity over the mesh<br/>e.g. Mark, knowledge only"]
    S["Shell · lanes · cron<br/>the loom CLI"]
  end

  subgraph entry["Entry: src/index.ts"]
    R{"first non-global token<br/>is a subcommand?"}
    STDIO["stdio MCP<br/>default"]
    CLI["CLI<br/>src/cli/*"]
    HTTPF["loom serve --http<br/>--scope full · :8787<br/>bearer token optional"]
    HTTPK["loom serve --http<br/>--scope knowledge · :8788<br/>bearer tokens required,<br/>each names the identity"]
    G["transport/guards.ts<br/>safe bind · bearer · payload cap"]
  end

  subgraph surface["Tool surface"]
    FULL["server.ts<br/>createLoomServer"]
    KONLY["knowledge-server.ts<br/>createKnowledgeOnlyServer"]
    subgraph wings["Tool wings: src/tools/*"]
      IDW["Identity wing<br/>identity · dossier · update_identity<br/>bootstrap · harness_init · harness_describe"]
      MEMW["Memory wing<br/>remember · recall · update · forget<br/>memory_list · memory_prune · episodes<br/>find_similar · memory_audit · memory_recompute_salience<br/>memory_archive · memory_restore · memory_merge<br/>memory_history · memory_revision_restore"]
      PROPW["Capture-propose<br/>memory_propose · memory_proposals<br/>memory_ratify · memory_reject"]
      PEOW["People wing: tools/person.ts<br/>person_write · person_verify · person_archive<br/>person_restore · person · person_list<br/>person_history · person_revision_restore"]
      KW["Knowledge wing: knowledge-tools.ts<br/>knowledge_write · knowledge_recall · knowledge_maintain<br/>knowledge_archive · knowledge_restore · knowledge_supersede<br/>knowledge_move · knowledge_merge · knowledge_purge<br/>knowledge_verify · knowledge_history"]
    end
    APPS["MCP-App widgets: mcp-app-hello.ts<br/>env-gated LOOM_MCP_APP_HELLO<br/>loom_hello · loom_display_modes<br/>loom_top_of_mind · loom_proposals<br/>widgets/*.tsx → dist/widgets"]
  end

  subgraph engine["Engine: src/backends"]
    FACT["index.ts<br/>cached backend per db path"]
    VEC["sqlite-vec.ts<br/>SqliteVecBackend"]
    EMB["fastembed.ts + embedding-runtime.ts<br/>BGE-small 384-d ONNX, CPU"]
    KB["sqlite-knowledge.ts<br/>SqliteKnowledgeBackend"]
    HELP["write/read helpers<br/>dedup · scope · ttl · mmr · glob · retry"]
    SAL["salience.ts<br/>temperature + boot digest"]
    EPI["episodes.ts<br/>the 24h tape"]
    PROP["proposals.ts"]
    PPL["people.ts<br/>PeopleStore · renderCard · roomBlock"]
    OBS["recall-log.ts · recorder-health.ts"]
    MIG["migrations.ts"]
  end

  subgraph disk["On disk: $LOOM_CONTEXT_DIR"]
    MD["IDENTITY.md · preferences.md · self-model.md<br/>projects/ · roles/ · harnesses/ · models/"]
    MEMDB[("memories.db")]
    KDB[("knowledge.db")]
    TEL["telemetry/recall.jsonl<br/>recorder-health.json"]
    GAPS["gaps dir<br/>recall-miss.jsonl"]
  end
  CACHE["~/.cache/loom/fastembed<br/>model fetched once"]
  DOT["Harness dotfiles + skills<br/>~/.claude/CLAUDE.md · ~/.codex/AGENTS.md<br/>~/.claude/skills · ~/.agents/skills"]

  H --> R
  S --> R
  R -- no --> STDIO --> FULL
  R -- yes --> CLI
  CLI -- serve --> HTTPF & HTTPK
  H -. mesh .-> G
  P -. mesh .-> G
  G --> HTTPF --> FULL
  G --> HTTPK --> KONLY
  CLI -- "wake · recall · remember · memory · knowledge · person<br/>call the same tool functions" --> wings
  CLI -- "inject · install" --> DOT
  CLI -. "--url / LOOM_URL: the store verbs<br/>ship argv to POST /cli" .-> G
  HTTPF -- "POST /cli · cli-endpoint.ts<br/>the same CLI, the server's stack" --> CLI

  FULL --> wings & APPS
  KONLY --> KW

  IDW --> MD
  IDW --> SAL & EPI & OBS
  IDW -- "people param:<br/># In the room" --> PPL
  MEMW --> FACT
  PROPW --> PROP
  PEOW --> PPL
  KW --> KB
  KW --> GAPS
  FACT --> VEC
  VEC --> EMB --> CACHE
  VEC --> HELP & MIG
  VEC --> MEMDB
  SAL & EPI & PROP & PPL --> MEMDB
  PPL --> MIG
  OBS --> TEL
  KB --> KDB
```

Two things this picture says that are easy to miss:

- **Memory and knowledge are two stores, two backends, two files.**
  `memories.db` is about the user and the work and is searched by vector.
  `knowledge.db` holds facts about the world and is searched with LIKE.
  `assertKnowledgePathsNotCoLocated` refuses to let them share a file.
- **Person cards live on memory's side of the line.** `people` and
  `person_revisions` are in `memories.db`, next to the `user` memories they
  condense, never in `knowledge.db`. A card is current state (one value
  per field, overwritten; the past only in revisions) and is descriptive,
  never a gate: the harness keeps tiers and scopes in its own file.
- **The knowledge-only server is smaller, not just locked down.** A peer
  on `--scope knowledge` never sees identity or memory tools in its tool
  list, and the knowledge wing pins `created_by` to the identity its
  bearer token resolves to.

## What a body wakes up with

`identity` (`src/tools/identity.ts`) assembles one document from these
parts, in this order. `loom wake` prints the same thing without MCP.

```mermaid
flowchart TB
  A["# Identity<br/>IDENTITY.md, the terminal creed"] --> B["# Preferences<br/>preferences.md"]
  B --> C["# Last 24h across bodies<br/>episodes.ts: the tape, time-ordered, never ranked"]
  C --> R2["# In the room<br/>people.ts roomBlock: person cards for the people param<br/>only when people is passed; best-effort, ≤ 4 cards, 6,500 chars"]
  R2 --> D["# Top of Mind<br/>salience.ts: hottest memories first, to a token budget"]
  D --> E["# Self-Model<br/>self-model.md"]
  E --> F["# Mode: role<br/>roles/&lt;role&gt;.md, if a role was passed"]
  F --> G["# Project<br/>projects/&lt;project&gt;.md"]
  G --> H2["# Harness · # Model<br/>blocks/harness.ts · blocks/model.ts<br/>client from param › MCP peer › LOOM_CLIENT"]
  H2 --> I["# Memories<br/>memories/INDEX.md summary, legacy"]
  I --> J["Runtime adapter<br/>clients.ts"]
  J --> K["Recorder warning, last<br/>recorder-health.ts, only when episode writes keep failing"]
```

`dossier` is the worker-body version. It returns preferences and
self-model in the third person with a push-back mandate, and leaves the
creed out.

## A memory's life

```mermaid
flowchart LR
  W["remember / memory_ratify"] --> DD{"dedup.ts<br/>exact restatement?"}
  DD -- yes --> HEAT["reheat the existing row"]
  DD -- no --> INS["insert: memories + vec_memories<br/>scope.ts sets project or global<br/>ttl.ts sets expires_at<br/>episode defaults to 48h"]
  PQ["memory_propose"] --> PT[("proposals")] --> W
  PT -. memory_reject .-> X["dropped"]
  INS --> RC["recall<br/>embed query → cosine → mmr.ts<br/>stamps last_accessed"]
  RC --> LOG["recall-log.ts → telemetry/recall.jsonl"]
  INS --> UPD["update → memory_revisions snapshot"]
  INS --> ARC["memory_archive · memory_merge<br/>tombstone, embedding dropped<br/>merge adds memory_supersessions"]
  INS --> PRN["memory_prune<br/>archives expired rows, TTL elapsed tombstone<br/>stale rows only reported"]
  INS --> DEL["forget · memory_merge hard_delete_losers<br/>journal to memory_deletions, then delete"]
  INS --> SALN["salience.ts<br/>decays by category half-life,<br/>reheats on access"]
```

## A person card's life

```mermaid
flowchart LR
  PW["person_write<br/>merge one level deep, null removes a field"] --> TX{"BEGIN IMMEDIATE<br/>read · merge · validate · snapshot · write · prune"}
  PV["person_verify<br/>stamps where.*.verified_at"] --> TX
  PA["person_archive · person_restore"] --> TX
  PR["person_revision_restore"] --> TX
  TX --> PT[("people")]
  TX -- "previous row, newest 10 kept" --> RV[("person_revisions")]
  PT --> RD["person · person_list · loom person show|list<br/>rendered: [ok] · [unverified] · [STALE nd]"]
  PT --> ROOM["identity people: [...]<br/># In the room"]
  MEM[("memories: category user,<br/>metadata.person = slug")] -. "memories_since_synthesis" .-> RD
```

The tagged memories stay the evidence; the card condenses them and does not
own them. loom never generates a summary: the agent writes it, and
`person_list`'s `memories_since_synthesis` is how a lane finds the ones that
have fallen behind.

## Where everything is stored

| Store | Tables / files | Backend |
|---|---|---|
| `memories.db` | `memories`, `vec_memories` (sqlite-vec), `proposals`, `memory_revisions`, `memory_supersessions`, `memory_deletions` | `sqlite-vec.ts`, schema moves in `migrations.ts` |
| `memories.db` (people) | `people`, `person_revisions` | `people.ts`, created by the `people_cards` migration |
| `knowledge.db` | `pages`, `citations`, `supersessions`, `page_revisions`, `verifications`, `knowledge_access` | `sqlite-knowledge.ts` |
| Context-dir markdown | `IDENTITY.md`, `preferences.md`, `self-model.md`, `projects/`, `roles/`, `harnesses/`, `models/` | read by `identity`; `update_identity` edits preferences and self-model only |
| Telemetry | `telemetry/recall.jsonl`, `recorder-health.json` | `recall-log.ts`, `recorder-health.ts` |
| Gaps dir (optional) | `recall-miss.jsonl` | knowledge recall misses, input for the expansion lane |

## The pieces, by file

| Module | Job |
|---|---|
| `src/index.ts` | Routes argv to the CLI or the stdio MCP server |
| `src/server.ts` | Full MCP server: registers every wing |
| `src/transport/knowledge-tools.ts` | The knowledge wing, shared by both servers |
| `src/transport/knowledge-server.ts` | Knowledge-only MCP server |
| `src/transport/http-server.ts` | StreamableHTTP front, one server per MCP session |
| `src/transport/guards.ts` | Safe bind, bearer check, payload cap |
| `src/ui/*` | loom's page, at the daemon's root. `core.ts` (loom's own pages and actions), `data.ts` (their queries), `pieces.ts` (running `loom-<piece> ui …`), `vocab.ts` (the page vocabulary and its validation), `render.ts`, `handler.ts` (routes, sessions, the guards on actions) |
| `src/transport/cli-endpoint.ts` | `POST /cli`: runs a store verb's argv through `runCliLocal` (no remote mode on its path) on the server's stack (full scope only) |
| `src/transport/mcp-app-hello.ts` | Env-gated MCP-App widget probes |
| `src/tools/*` | One file per MCP tool (the eight person tools share `person.ts`); the CLI calls these too |
| `src/cli/*` | One file per subcommand |
| `src/cli/pieces.ts` | `loom <piece>`: git-style dispatch to `loom-<piece>` on PATH; `loom pieces` lists them |
| `src/ui/household-pages.ts` | The owner's household page: Home across every agent, the commons' knowledge, People with every agent's relationship, each agent's Setup (identity, tokens, health), adding an agent |
| `src/bundle.ts`, `src/cli/bundle.ts` | The bundle (docs/specs/household.md, "Export and restore"): `loom export` / `loom restore` / `--drill`, age-encrypted, with each piece's own part from `loom-<piece> bundle export` / `bundle import` |
| `src/household.ts`, `src/cli/household.ts` | The household (docs/specs/household.md): `household.json`, `tokens.json` (roles `agent:`, `owner`, `peer:`; only sha256 stored), the resolver the daemon uses per request, `loom household` and `loom token` |
| `src/cli/remote.ts` | Remote mode: with `--url`/`LOOM_URL`, the store verbs run on a loom-http via `POST /cli` |
| `src/blocks/*` | Harness and model manifest blocks for the identity payload |
| `src/injection/*` | `loom inject`: managed `loom:start`/`loom:end` block in harness dotfiles |
| `src/install/*` | `loom install`: copies the setup skill into the harness skills dir |
| `src/backends/index.ts` | Factory: cached backend per db path, one embedder per model |
| `src/backends/types.ts` | `MemoryBackend`, `EmbeddingProvider`, `KnowledgeBackend` interfaces |
| `src/backends/sqlite-vec.ts` | Memory store: SQLite + sqlite-vec cosine search |
| `src/backends/fastembed.ts` | `EmbeddingProvider` adapter |
| `src/backends/embedding-runtime.ts` | Vendored ONNX + tokenizer runtime |
| `src/backends/sqlite-knowledge.ts` | Knowledge store |
| `src/backends/migrations.ts` | Versioned schema migrations for `memories.db` |
| `src/backends/salience.ts` | Temperature and the Top of Mind digest |
| `src/backends/episodes.ts` | The episode tape |
| `src/backends/proposals.ts` | Capture-propose queue |
| `src/backends/people.ts` | Person cards: validation, render, store, the identity room block |
| `src/backends/people-household.ts` | Person cards in a household: the commons directory (name, handles, facts) plus each agent's relationship (summary, how it talks to them, may), merged on read, split on write, and the one-time split of an existing agent's cards |
| `src/backends/dedup.ts` | Write-time exact-restatement key |
| `src/backends/scope.ts` | Project vs global visibility |
| `src/backends/ttl.ts` | TTL parsing and expiry |
| `src/backends/mmr.ts` | Diversity re-ranking for recall |
| `src/backends/glob.ts` | Title patterns for bulk forget |
| `src/backends/retry.ts` | Retry on SQLITE_BUSY |
| `src/backends/recall-log.ts` | Local recall observation log |
| `src/backends/recorder-health.ts` | Episode-write failure ledger |

CLI subcommands: `wake`, `recall`, `remember`, `forget`, `update`,
`memory`, `knowledge`, `person`, `update-identity`, `bootstrap`, `serve`, `inject`,
`harness`, `install`, `doctor`, `migrate`, `pieces`, `household`, `token`, `export`, `restore`. Any other name runs an
installed piece, `loom-<name>` on PATH (`src/cli/pieces.ts`, docs/extensions.md).
