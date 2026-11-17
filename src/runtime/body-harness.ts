/** The harnesses a body can run on. One entry per harness; the body program picks by the job's harness name.
 *
 * To add a harness, write one file that exports a BodyHarness and add it to `bodyHarnesses` in body-harnesses.ts. It has
 * three jobs and nothing else:
 *   1. turn (model, cwd, reach, the tools endpoint, denied tools) into a command line and environment;
 *   2. give the model its words on stdin (use `runHarnessChild`);
 *   3. read what the harness printed into a HarnessReply, refusing anything it cannot vouch for.
 * Mail, identity, secrets, replies, digests and status are the body program's and are the same for all.
 *
 * Every failure is the one plain `Native execution unavailable`: a harness's diagnostics may hold private
 * words and never leave the body.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { WorkerAssignment } from './worker.js';

export interface HarnessReply { text: string; model: string; actions: { model: string }[] }
export type HarnessSpawn = (command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: false; stdio: 'pipe' | ['pipe', 'pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;
export interface HarnessInput {
  /** The harness's own program, from the machine's body file. */
  command: string; cwd: string; env: NodeJS.ProcessEnv; spawn?: HarnessSpawn;
  /** Where loom's tools for this body are served: {"mcpServers":{"loom_secrets":{type:"http",url,headers:{Authorization}}}}.
   * The caller erases its copy as soon as the harness is made, so take what is needed at once. */
  mcpConfig?: Uint8Array;
  /** The tool names the body may use, each written mcp__loom_secrets__<name>. */
  mcpTools?: readonly string[];
  /** 'loom': loom's tools only. 'all': the harness's own tools too (files, shell, the web). */
  reach?: 'loom' | 'all';
}
export type HarnessRun = (job: WorkerAssignment, words: string, signal: AbortSignal) => Promise<HarnessReply>;
export type BodyHarness = (input: HarnessInput) => HarnessRun;

export const harnessUnavailable = () => new Error('Native execution unavailable');
export const harnessModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const outputLimit = 1_048_576;
/** Names the body's scratch directory in its environment; set by the worker, removed by it after the body. */
export const BODY_SCRATCH = 'LOOM_BODY_SCRATCH';
/** Every tool loom serves a body is named with this prefix, then the tool's own name. */
export const harnessToolPrefix = 'mcp__loom_secrets__';
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const toolLimit = 34;

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
    const server = (JSON.parse(Buffer.from(config).toString('utf8')) as { mcpServers?: { loom_secrets?: { url?: unknown; headers?: { Authorization?: unknown } } } }).mcpServers?.loom_secrets;
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
  const stop = () => { failed = true; control?.fill(0); pipe?.destroy(); for (const chunk of chunks) chunk.fill(0); chunks.length = 0; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL'); };
  input.signal.addEventListener('abort', stop, { once: true });
  if (input.signal.aborted) stop();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => { stop(); reject(harnessUnavailable()); });
      // A leader may leave a descendant holding the pipes; end it so the worker can reap the group.
      child.once('exit', () => { drain = setTimeout(stop, 1_000); });
      child.once('close', code => code === 0 && !failed && !input.signal.aborted ? resolve() : reject(harnessUnavailable()));
      for (const stream of [child.stdin, child.stdout, child.stderr, ...(pipe ? [pipe] : [])]) stream.on('error', stop);
      child.stdout.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        if (Buffer.isBuffer(data)) data.fill(0);
        if (failed) { chunk.fill(0); return; }
        bytes += chunk.length;
        if (bytes > outputLimit) { chunk.fill(0); stop(); } else { chunks.push(chunk); try { input.onOutput?.(chunk); } catch { stop(); } }
      });
      // Drain diagnostics; never keep or forward them.
      child.stderr.on('data', (data: Buffer | string) => { bytes += Buffer.byteLength(data); if (Buffer.isBuffer(data)) data.fill(0); if (bytes > outputLimit && !failed) stop(); });
      if (control) { if (!pipe || typeof pipe.end !== 'function') { stop(); reject(harnessUnavailable()); return; } pipe.end(control, () => control.fill(0)); }
      if (!failed) child.stdin.end(input.words);
    });
    if (input.signal.aborted || failed) throw harnessUnavailable();
    return Buffer.concat(chunks);
  } catch { throw harnessUnavailable(); }
  finally { control?.fill(0); pipe?.destroy(); if (drain) clearTimeout(drain); input.signal.removeEventListener('abort', stop); for (const chunk of chunks) chunk.fill(0); }
}
