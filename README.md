# loom

[![CI](https://github.com/sleepunit-agents/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/sleepunit-agents/loom/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jbarket/loomai.svg)](https://www.npmjs.com/package/@jbarket/loomai)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-orange.svg)](https://modelcontextprotocol.io)

**One program a household runs for itself: a few people and a few AI agents, sharing a desk, with memory that outlives any one session.**

## The goal

[`docs/how-it-works/`](docs/how-it-works/README.md) describes the finished program, page by page. Read it at <https://sleepunit-agents.github.io/loom/> or open `docs/how-it-works/site/index.html`. That site is the goal, and the only one: work here is done when the running program does what those pages say.

## What is in this repository

- **The program** (`src/`). `loom serve` runs it for one household from one data folder. People use the web app (`web/`); agents and other programs use the API with a token.
- **The door for agents.** An agent reaches loom through MCP at `/mcp` on the running program: named tools for what it does often, and three general tools (`loom_commands`, `loom_command`, `loom_query`) for everything else. The [Tools for agents](docs/how-it-works/site/tools.html) page lists what an agent can do.
- **The worker** (`loom-worker`, `loom-body`). Agents' bodies run on a worker, on the same machine as loom or on another. Nothing runs inside loom itself.

## Running it

Build the checkout, then start the coordinator with a new or empty private data directory. The coordinator serves the desktop and API on `127.0.0.1:8787` by default. Use `--host` and `--port` to change the listener. Workers can join later.

```sh
npm ci && npm run build
node dist/index.js serve --home ~/loom-household
```

On first start, Loom creates the household database, its keys and a default agent named `assistant`. The first owner is named after the local OS user, or `owner` if that name is invalid. In a second terminal on the same machine, run the following command as that OS user and open the one-time link it prints.

```sh
node dist/index.js signin --home ~/loom-household
```

For a server reached over SSH, forward its loopback port to your computer with `ssh -L 8787:127.0.0.1:8787 user@server` and open the link in your local browser. Once Loom is installed as a command, `loom serve` and `loom signin` accept the same arguments.

Use the same home on subsequent starts to reopen the household. You can also set the data directory with `LOOM_HOME` or select an existing configuration file with `--program`. If a nonempty directory contains an older installation, follow the [migration plan](docs/migration-plan.md).

A stdio MCP client connects through the running program. It never opens the household's stores itself:

```
loom mcp --url http://127.0.0.1:8787 --token-file <file>
```

The other installed commands (`loom-household`, `loom-token`, `loom-account`, `loom-sessions`, `loom-taskstore`) are thin clients of the same API.

### Run a local preview in a container

Build from a clean checkout of the revision you want to preview. Each preview needs its own volume. These commands create a fictional household on first use and make the preview available on this machine’s port 8787.

```sh
podman build -f Containerfile -t localhost/loom-preview .
podman volume create loom-preview-data
podman run --rm -v loom-preview-data:/var/lib/loom localhost/loom-preview \
  node scripts/example-home.mjs /var/lib/loom/household
podman run -d --name loom-preview -v loom-preview-data:/var/lib/loom \
  -e LOOM_PUBLIC_URL=http://localhost:8787 -p 127.0.0.1:8787:8787 localhost/loom-preview
podman exec loom-preview node dist/index.js signin --member alex
```

On subsequent starts, run `podman start loom-preview`. The shared image includes the compiled app, its tests and Chromium. Run `scripts/check-container-image.sh localhost/loom-preview` to save and reopen an example task in a separate temporary volume.

## The older program

Until November 2026 this repository also held loom's first form: a stdio MCP server over one agent's memory files, with its own command line and web pages. It was removed once the rebuilt program covered it. It is in git history; the last commit that has it is the parent of the one that added this section.

## Development

```
npm test                      # everything
npx vitest run --project unit # without the browser tests
npx tsc --noEmit              # typecheck
```

Tests sit beside their source as `*.test.ts`. Browser tests are `src/ui/*.integration.test.ts`. After changing a page of the site, run `python3 site_build.py` in `docs/how-it-works/` and `python3 scripts/rebuild-checklists.py`. Commits need a DCO sign-off (`git commit -s`).

## Authorship

loom was created by Jonathan Barket and Art E Fish. The project exists as both
infrastructure and experiment: a persistent identity layer that an AI agent
(Art) helped design and runs on. The
[rebirth letter](docs/archive/rebirth-letter-2026-04-19.md) is the origin
story if you want it.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2026 Jonathan Barket.

loom is free software: you can redistribute it and modify it under the
terms of the GNU Affero General Public License (version 3 or any later
version). If you run a modified loom and let others interact with it
over a network, you must offer them the corresponding source. Bundle
loom into a larger product freely; fork it and go proprietary, no.
