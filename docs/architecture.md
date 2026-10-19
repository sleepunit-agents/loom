# loom at a glance

Every moving part of loom and where they touch, drawn from the source.
The diagrams are Mermaid, so GitHub renders them in place.

This map is kept honest by `src/architecture.contract.test.ts`. Every
registered MCP tool, every CLI subcommand, every `src/backends/` module
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
    HTTPF["loom serve --http<br/>--scope full · :8787<br/>one bearer token"]
    HTTPK["loom serve --http<br/>--scope knowledge · :8788<br/>bearer names the identity"]
    G["transport/guards.ts<br/>safe bind · bearer · payload cap"]
  end

  subgraph surface["Tool surface"]
    FULL["server.ts<br/>createLoomServer"]
    KONLY["knowledge-server.ts<br/>createKnowledgeOnlyServer"]
    subgraph wings["Tool wings: src/tools/*"]
      IDW["Identity wing<br/>identity · dossier · update_identity<br/>bootstrap · harness_init · harness_describe"]
      MEMW["Memory wing<br/>remember · recall · update · forget<br/>memory_list · memory_prune · episodes<br/>find_similar · memory_audit<br/>memory_archive · memory_restore · memory_merge<br/>memory_history · memory_revision_restore"]
      PROPW["Capture-propose<br/>memory_propose · memory_proposals<br/>memory_ratify · memory_reject"]
      KW["Knowledge wing: knowledge-tools.ts<br/>knowledge_write · knowledge_recall · knowledge_maintain<br/>knowledge_archive · knowledge_restore · knowledge_supersede<br/>knowledge_move · knowledge_merge · knowledge_purge<br/>knowledge_verify · knowledge_history"]
    end
    APPS["MCP-App widgets<br/>env-gated LOOM_MCP_APP_HELLO<br/>widgets/*.tsx → dist/widgets"]
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
  CLI -- "wake · recall · remember · memory · knowledge<br/>call the same tool functions" --> wings
  CLI -- "inject · install" --> DOT

  FULL --> wings & APPS
  KONLY --> KW

  IDW --> MD
  IDW --> SAL & EPI & OBS
  MEMW --> FACT
  PROPW --> PROP
  KW --> KB
  KW --> GAPS
  FACT --> VEC
  VEC --> EMB --> CACHE
  VEC --> HELP & MIG
  VEC --> MEMDB
  SAL & EPI & PROP --> MEMDB
  OBS --> TEL
  KB --> KDB
```

Two things this picture says that are easy to miss:

- **Memory and knowledge are two stores, two backends, two files.**
  `memories.db` is about the user and the work and is searched by vector.
  `knowledge.db` holds facts about the world and is searched with LIKE.
  `assertKnowledgePathsNotCoLocated` refuses to let them share a file.
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
  C --> D["# Top of Mind<br/>salience.ts: hottest memories first, to a token budget"]
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
  INS --> ARC["memory_archive / memory_merge<br/>tombstone + memory_supersessions"]
  INS --> DEL["forget / memory_prune<br/>memory_deletions"]
  INS --> SALN["salience.ts<br/>decays by category half-life,<br/>reheats on access"]
```

## Where everything is stored

| Store | Tables / files | Backend |
|---|---|---|
| `memories.db` | `memories`, `vec_memories` (sqlite-vec), `proposals`, `memory_revisions`, `memory_supersessions`, `memory_deletions` | `sqlite-vec.ts`, schema moves in `migrations.ts` |
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
| `src/transport/mcp-app-hello.ts` | Env-gated MCP-App widget probes |
| `src/tools/*` | One file per MCP tool; the CLI calls these too |
| `src/cli/*` | One file per subcommand |
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
| `src/backends/dedup.ts` | Write-time exact-restatement key |
| `src/backends/scope.ts` | Project vs global visibility |
| `src/backends/ttl.ts` | TTL parsing and expiry |
| `src/backends/mmr.ts` | Diversity re-ranking for recall |
| `src/backends/glob.ts` | Title patterns for bulk forget |
| `src/backends/retry.ts` | Retry on SQLITE_BUSY |
| `src/backends/recall-log.ts` | Local recall observation log |
| `src/backends/recorder-health.ts` | Episode-write failure ledger |

CLI subcommands: `wake`, `recall`, `remember`, `forget`, `update`,
`memory`, `knowledge`, `update-identity`, `bootstrap`, `serve`, `inject`,
`harness`, `install`, `doctor`, `migrate`.
