/** The harnesses a body can run on. One entry per harness; the body program picks by the job's harness name.
 *
 * To add a harness, write one file that exports a Harness and add it to `harnesses` in body-harnesses.ts.
 * Besides stating what it can run (HarnessTraits), it has three jobs and nothing else:
 *   1. turn (model, cwd, reach, the tools endpoint, denied tools) into a command line and environment;
 *   2. give the model its words on stdin (use `runHarnessChild`);
 *   3. read what the harness printed into a HarnessReply, refusing anything it cannot vouch for.
 * Mail, identity, secrets, replies, digests and status are the body program's and are the same for all.
 *
 * Every failure is the one plain `Native execution unavailable`: a harness's diagnostics may hold private
 * words and never leave the body as its error. An adapter that can tell why a run failed says so apart from
 * that line (HarnessFailed): a fixed reason with no words, which the body hands on with its exit code, and
 * the harness's own last words, which the body shows only to the conversation's own readers.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { OmittedWakeTools } from './wake-tool-profiles.js';
import type { WorkerAssignment } from './worker.js';
import type { HarnessTraits } from './harness-traits.js';
import { BODY_EXTENSION_TOOLS_MAX, TOOL_NAME } from './body-model-tools.js';

import type { UsageReport } from './usage-report.js';
import type { JobFailure } from './job-failure.js';

export interface HarnessReply { usage?: UsageReport; text: string; model: string; actions: { model: string }[];
  /** The id of the session the harness kept for this run, when it was asked to keep one and did. */
  session?: string }
/** Asks a harness that can keep its own record of a run to keep it, and to continue an earlier one when
 * `resume` names it. Left out, the harness keeps nothing, as before. */
export interface HarnessSession { resume?: string }
/** The harness could not continue the session it was given, and neither said nor did anything: the caller
 * may run the same work afresh. Any other failure is the plain `harnessUnavailable`. */
export class HarnessResumeUnavailable extends Error { constructor() { super('Native execution unavailable'); } }
export type HarnessSpawn = (command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: false; stdio: 'pipe' | ['pipe', 'pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;
export interface HarnessInput {
  pairOutput?: (chunk:Buffer)=>void;
  failedUsage?: (usage:UsageReport)=>void;
  /** The harness's own program, from the machine's body file. */
  command: string; cwd: string; env: NodeJS.ProcessEnv; spawn?: HarnessSpawn;
  /** Where loom's tools for this body are served: {"mcpServers":{"loom":{type:"http",url,headers:{Authorization}}}}.
   * The caller erases its copy as soon as the harness is made, so take what is needed at once. */
  mcpConfig?: Uint8Array;
  /** The tool names the body may use, each written mcp__loom__<name>. */
  mcpTools?: readonly string[];
  /** 'loom': loom's tools only. 'all': the harness's own tools too (files, shell, the web). */
  reach?: 'loom' | 'all';
  omitClaudeTools?: Readonly<OmittedWakeTools>;
}
export type HarnessRun = (job: WorkerAssignment, words: string, signal: AbortSignal, session?: HarnessSession) => Promise<HarnessReply>;
export type BodyHarness = (input: HarnessInput) => HarnessRun;
/** One harness, whole: what it can run and how it is run. This is the only thing body-harnesses.ts lists,
 * so there is no listing an adapter without its traits. */
export interface Harness extends HarnessTraits {
  run: BodyHarness;
  /** For a harness that can keep a session and continue it: everything about where it keeps one, said
   * once, by the adapter. Absent: it keeps none. body-session.ts packs and restores by these and knows no
   * harness's layout itself. */
  sessions?: {
    /** The harness's own directory, under which every session file is. */
    root(env: Readonly<Record<string, string | undefined>>): string;
    /** Whether a path under that directory is one of this session's files. A pack holds nothing else. */
    owns(relative: string, session: string): boolean;
    /** This session's files as they are now, as paths under `root`, found without following a link at any
     * step (unfollowed.ts). `root` here is the directory's real path. */
    files(root: string, session: string): string[];
  };
  /** Remove what the harness leaves outside the body's scratch directory (see harnessLeftovers). */
  leftovers?(scratch: string, env: Readonly<Record<string, string | undefined>>): void;
}

export const harnessUnavailable = () => new Error('Native execution unavailable');
/** A run that failed, with what the adapter could tell of it (harness-failure.ts). Its message is the same one
 * plain line as every other failure. `why` is one of the fixed reasons and holds no words: the body may hand it
 * on with its exit code. `said` is the harness's own last error text, which may hold the conversation's words:
 * it stays in the body, which shows it only to the conversation's own readers (body-program.ts). */
export class HarnessFailed extends Error { constructor(readonly why: JobFailure, readonly said?: string) { super('Native execution unavailable'); } }
/** How a harness's process ended, when it did not end well. For the adapter that started it, and no further. */
export interface HarnessEnd {
  exitCode: number | null; signal: string | null;
  /** The body ended it: it printed more than `outputLimit`, or it had ended and its output stayed open. */
  cut?: 'output' | 'pipes';
  /** The body was told to stop: no failure of the harness's. */
  aborted: boolean;
  /** The end of what it wrote as diagnostics, bounded. May hold the conversation's words. */
  stderr: string;
}
/** What runHarnessChild rejects with once the process was started: the one plain line, and how it ended. */
export class HarnessExit extends Error { constructor(readonly end: HarnessEnd) { super('Native execution unavailable'); } }
/** How much of a harness's diagnostics is held, from their end, while it runs. */
const STDERR_TAIL = 4_096;
export const harnessModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
/** The most a harness may print in one job before the body ends it. Everything the harness streams counts: each
 * tool's result as well as its words. It was 1 MiB while a job was a chat reply; a session that reads source
 * files and test output passes that in about ten minutes (2026-11-27: every build job longer than that died
 * here, with no reason kept). 64 MiB is a bound on a runaway, not on a working session. */
export const HARNESS_OUTPUT_BYTES = 64 * 1_048_576;
const outputLimit = HARNESS_OUTPUT_BYTES;
/** Names the body's scratch directory in its environment; set by the worker, removed by it after the body. */
export const BODY_SCRATCH = 'LOOM_BODY_SCRATCH';
/** The name every harness is given a body's tools server under. A terminal session registers loom's own
 * door under the same name (docs/runtime/terminal.md), so a tool has one name in both places. */
export const BODY_TOOLS_SERVER = 'loom';
/** Always set in a body's environment by a container worker, so that an image's own value never stands:
 * to `1` only when the place the body's harness keeps its
 * sessions is this body's alone for this one job: the body runs in a house's container, whose home goes
 * with it, and no mount is, holds, or is inside that place (house-layout.ts, houseSessions); to `0`
 * otherwise. The account's sign-in is mounted elsewhere and does not count. A body run as a plain process
 * is never told `1`, and the worker takes the variable out of a configured environment: its
 * harness's directory is the machine's, shared with every other body and left behind. Nothing private to
 * one conversation may be left in a shared place, so a harness session is kept only where this is set
 * (body-session.ts). */
export const BODY_OWN_HARNESS = 'LOOM_BODY_OWN_HARNESS';
/** Every tool loom serves a body is named with this prefix, then the tool's own name. */
export const harnessToolPrefix = `mcp__${BODY_TOOLS_SERVER}__`;
const toolName = TOOL_NAME;
/** The two secret tools and the rest. */
const toolLimit = BODY_EXTENSION_TOOLS_MAX + 2;

/** The tools a body may use, as their own names without the prefix. Refuses a list that is too long,
 * repeats a name, or holds a name that is not one of loom's. */
export function harnessToolNames(tools: readonly string[]): string[] {
  const names = tools.map(tool => typeof tool === 'string' && tool.startsWith(harnessToolPrefix) ? tool.slice(harnessToolPrefix.length) : '');
  if (names.length > toolLimit || new Set(names).size !== names.length || names.some(name => !toolName.test(name))) throw harnessUnavailable();
  return names;
}

/** Read the tools endpoint out of the shared tools file. */
export function harnessTools(config: Uint8Array | undefined): { url: string; authorization: string } | undefined {
  if (!config) return undefined;
  try {
    const server = (JSON.parse(Buffer.from(config).toString('utf8')) as { mcpServers?: Record<string, { url?: unknown; headers?: { Authorization?: unknown } } | undefined> }).mcpServers?.[BODY_TOOLS_SERVER];
    const url = server?.url, authorization = server?.headers?.Authorization;
    if (typeof url !== 'string' || typeof authorization !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url) || !/^Bearer [A-Za-z0-9._~+/=-]{16,512}$/.test(authorization)) throw harnessUnavailable();
    return { url, authorization };
  } catch { throw harnessUnavailable(); }
}

/** Run one harness process: words in on stdin, everything it printed back as bytes. Output is capped, the
 * process is killed on abort, and a non-zero exit is a failure. The caller erases the returned bytes.
 *
 * `control` is for a harness that can read its tools file from a path: the bytes reach it as /dev/fd/3 and
 * are in no argument, variable or file. Node's extra pipes are Unix sockets, which cannot be reopened by
 * that path, so bash first turns the socket into an anonymous kernel pipe and then becomes the harness.
 * (-p ignores BASH_ENV and imported shell functions; the absolute cat avoids a PATH lookup.) The bytes are
 * erased as soon as they are written, and on every failure. */
export async function runHarnessChild(input: {
  command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; words: string; signal: AbortSignal; spawn?: HarnessSpawn;
  control?: Buffer;
  /** Sees each piece of output as it arrives, for a harness that must note something before the process ends. */
  onOutput?: (chunk: Buffer) => void;
  onFailedOutput?: (output: Buffer) => void;
}): Promise<Buffer> {
  const control = input.control;
  const command = control ? '/bin/bash' : input.command;
  const args = control ? ['--noprofile', '--norc', '-p', '-c', 'exec 3< <(/bin/cat <&3); exec "$@"', 'loom-native', input.command, ...input.args] : input.args;
  let child: ChildProcessWithoutNullStreams;
  try { child = (input.spawn ?? spawn)(command, args, { cwd: input.cwd, env: { ...input.env }, shell: false, detached: false, stdio: control ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe' }); }
  catch { control?.fill(0); throw harnessUnavailable(); }
  const pipe = control ? child.stdio?.[3] as Writable | undefined : undefined;
  const chunks: Buffer[] = [];
  let bytes = 0, failed = false, drain: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number | null = null, exitSignal: string | null = null, cut: HarnessEnd['cut'], diagnostics: Buffer = Buffer.alloc(0);
  const reportFailure = () => {
    if (!input.onFailedOutput || !chunks.length || bytes > outputLimit) return;
    const output = Buffer.concat(chunks);
    try { input.onFailedOutput(output); } catch { /* Measurement is best effort. */ }
    finally { output.fill(0); }
  };
  const stop = () => {
    if (failed) return;
    failed = true;
    control?.fill(0);
    pipe?.destroy();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill('SIGKILL');
    reportFailure();
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
  };
  input.signal.addEventListener('abort', stop, { once: true });
  if (input.signal.aborted) stop();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => { stop(); reject(harnessUnavailable()); });
      // A leader may leave a descendant holding the pipes; end it so the worker can reap the group.
      child.once('exit', (code: number | null, signal: string | null) => {
        if (typeof code === 'number') exitCode = code; if (typeof signal === 'string') exitSignal = signal;
        drain = setTimeout(() => { if (!failed && code === 0) cut = 'pipes'; stop(); }, 1_000);
      });
      child.once('close', (code: number | null, signal: string | null) => {
        if (exitCode === null && typeof code === 'number') exitCode = code; if (exitSignal === null && typeof signal === 'string') exitSignal = signal;
        if (code === 0 && !failed && !input.signal.aborted) resolve();
        else reject(harnessUnavailable());
      });
      for (const stream of [child.stdin, child.stdout, child.stderr, ...(pipe ? [pipe] : [])]) stream.on('error', stop);
      child.stdout.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        if (Buffer.isBuffer(data)) data.fill(0);
        if (failed) { chunk.fill(0); return; }
        bytes += chunk.length;
        if (bytes > outputLimit) { chunk.fill(0); cut = 'output'; stop(); } else { chunks.push(chunk); try { input.onOutput?.(chunk); } catch { stop(); } }
      });
      // Drain diagnostics; never forward them. Their end is held, bounded, for the adapter to read if the run
      // fails (HarnessEnd.stderr), and erased either way.
      child.stderr.on('data', (data: Buffer | string) => {
        bytes += Buffer.byteLength(data);
        if (!failed) { const kept = Buffer.concat([diagnostics, Buffer.from(data)]); diagnostics.fill(0); diagnostics = Buffer.from(kept.subarray(-STDERR_TAIL)); kept.fill(0); }
        if (Buffer.isBuffer(data)) data.fill(0);
        if (bytes > outputLimit && !failed) { cut = 'output'; stop(); }
      });
      if (control) { if (!pipe || typeof pipe.end !== 'function') { stop(); reject(harnessUnavailable()); return; } pipe.end(control, () => control.fill(0)); }
      if (!failed) child.stdin.end(input.words);
    });
    if (input.signal.aborted || failed) throw harnessUnavailable();
    return Buffer.concat(chunks);
  } catch {
    if (!failed) reportFailure();
    throw new HarnessExit({ exitCode, signal: exitSignal, ...(cut ? { cut } : {}), aborted: input.signal.aborted, stderr: diagnostics.toString('utf8') });
  }
  finally { diagnostics.fill(0); control?.fill(0); pipe?.destroy(); if (drain) clearTimeout(drain); input.signal.removeEventListener('abort', stop); for (const chunk of chunks) chunk.fill(0); }
}
