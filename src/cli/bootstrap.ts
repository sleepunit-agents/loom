/**
 * loom bootstrap — initialize a fresh agent.
 *
 * Param sources (precedence):
 *   1. flags (--user, --name, --purpose, --voice, --preferences, --clients)
 *   2. piped JSON on stdin
 *   3. interactive readline prompts (only when stdin is a TTY)
 */
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { lstat, symlink } from 'node:fs/promises';
import { bootstrap } from '../tools/bootstrap.js';
import { assertStackVersionCompatible, resolveDefaultContextPath } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readStdin, renderJson, stderrWritable } from './io.js';
import type { IOStreams } from './io.js';
import type { BootstrapParams } from '../tools/bootstrap.js';
import { validateAgentName } from '../install/names.js';

const USAGE = `Usage: loom bootstrap [options]

Initializes IDENTITY.md, preferences.md, and self-model.md
in the context directory.

Param sources (first match wins):
  1. Flags (--name / --purpose / --voice)
  2. Piped JSON on stdin: {"name","purpose","voice","user"?,"clients"?}
  3. Interactive prompts when stdin is a TTY and nothing else is set

Options:
  --user <str>           The human this agent works with (their name)
  --name <str>           Agent name (required)
  --purpose <str>        One-line purpose
  --voice <str>          Short voice descriptor
  --preferences <str>    Optional preferences preamble
  --clients <csv>        Comma-separated client adapters (e.g. claude-code)
  --force                Overwrite an existing IDENTITY.md
  --json                 Emit {contextDir, wrote: string[]}
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

function checkName(name: string, io: IOStreams): number | null {
  const r = validateAgentName(name);
  if (r.ok) return null;
  io.stderr(`Invalid --name: ${r.reason}\n`);
  return 2;
}

async function promptInteractive(io: IOStreams): Promise<BootstrapParams | null> {
  const rl = createInterface({ input: io.stdin, output: stderrWritable(io) });

  // Race each question against the readline 'close' event (fires when stdin
  // ends before the user answers — e.g. piped /dev/null or empty test streams).
  let closed = false;
  const closedPromise = new Promise<null>((resolve) => {
    rl.once('close', () => { closed = true; resolve(null); });
  });

  const ask = (q: string): Promise<string | null> =>
    Promise.race([
      rl.question(q).then((s) => s),
      closedPromise,
    ]);

  try {
    if (closed) return null;
    const user = ((await ask('Your name (the human): ')) ?? '').trim();
    if (closed) return null;
    const name = ((await ask('Agent name: ')) ?? '').trim();
    if (!name) return null;
    const purpose = ((await ask('Purpose (one line): ')) ?? '').trim();
    if (!purpose) return null;
    const voice = ((await ask('Voice (short descriptor): ')) ?? '').trim();
    if (!voice) return null;
    const clientsRaw = ((await ask('Clients (comma-separated, e.g. claude-code): ')) ?? '').trim();
    const clients = clientsRaw ? clientsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return { user: user || undefined, name, purpose, voice, clients };
  } finally {
    rl.close();
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        user:        { type: 'string' },
        name:        { type: 'string' },
        purpose:     { type: 'string' },
        voice:       { type: 'string' },
        preferences: { type: 'string' },
        clients:     { type: 'string' },
        force:       { type: 'boolean' },
        help:        { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  let params: BootstrapParams | null = null;

  if (parsed.values.name || parsed.values.purpose || parsed.values.voice || parsed.values.user) {
    if (!parsed.values.name || !parsed.values.purpose || !parsed.values.voice) {
      io.stderr(`When using flags, --name, --purpose, and --voice are all required.\n`);
      return 2;
    }
    const clientsCsv = parsed.values.clients;
    params = {
      user:        parsed.values.user,
      name:        parsed.values.name,
      purpose:     parsed.values.purpose,
      voice:       parsed.values.voice,
      preferences: parsed.values.preferences,
      clients:     clientsCsv ? clientsCsv.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      force:       Boolean(parsed.values.force),
    };
  } else if (!io.stdinIsTTY) {
    const raw = await readStdin(io.stdin);
    const trimmed = raw.trim();
    if (!trimmed) {
      io.stderr(`No bootstrap params supplied (no flags, no stdin, no TTY).\n${USAGE}`);
      return 2;
    }
    try {
      const body = JSON.parse(trimmed) as Partial<BootstrapParams>;
      if (!body.name || !body.purpose || !body.voice) {
        io.stderr(`Piped JSON must include name, purpose, and voice.\n`);
        return 2;
      }
      params = {
        user: body.user,
        name: body.name, purpose: body.purpose, voice: body.voice,
        preferences: body.preferences, clients: body.clients,
        force: Boolean(parsed.values.force),
      };
    } catch (err) {
      io.stderr(`Could not parse stdin as JSON: ${(err as Error).message}\n`);
      return 2;
    }
  } else {
    const prompted = await promptInteractive(io);
    if (!prompted || !prompted.name || !prompted.purpose || !prompted.voice) {
      io.stderr(`name, purpose, and voice are all required.\n`);
      return 2;
    }
    params = { ...prompted, force: Boolean(parsed.values.force) };
  }

  const nameCode = checkName(params!.name, io);
  if (nameCode !== null) return nameCode;

  try {
    // params is always set by this point — all null paths return early above.
    const text = await bootstrap(env.contextDir, params!);

    // Provision the default symlink if the new agent dir is directly under
    // the loom config root and no default pointer exists yet.
    const home = io.env.HOME ?? process.env.HOME;
    const defaultLink = resolveDefaultContextPath(home);
    if (dirname(env.contextDir) === dirname(defaultLink) && env.contextDir !== defaultLink) {
      try {
        await lstat(defaultLink); // throws if default doesn't exist at all
      } catch {
        // default doesn't exist — create symlink
        try {
          await symlink(env.contextDir, defaultLink);
          if (!env.json) {
            io.stdout(`Created default pointer: ${defaultLink} -> ${env.contextDir}\n`);
          }
        } catch {
          // Non-fatal: symlink creation may fail in sandboxed or read-only environments
        }
      }
    }

    if (env.json) {
      renderJson(io, {
        contextDir: env.contextDir,
        wrote: [
          join(env.contextDir, 'IDENTITY.md'),
          join(env.contextDir, 'preferences.md'),
          join(env.contextDir, 'self-model.md'),
        ],
      });
    } else {
      io.stdout(text.endsWith('\n') ? text : text + '\n');
    }
    return 0;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}
