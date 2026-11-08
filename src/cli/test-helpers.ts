/**
 * Test helpers — run `runCli` in-process with captured streams.
 */
import type { IOStreams } from './io.js';
import { Readable } from 'node:stream';
import { runCli } from './index.js';

export interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCliCaptured(
  argv: string[],
  opts?: { stdin?: string; env?: Record<string, string>; contextDir?: string },
): Promise<CaptureResult> {
  let stdout = '';
  let stderr = '';
  const stdin = Readable.from([opts?.stdin ?? '']);
  // Merge: opts.contextDir seeds LOOM_CONTEXT_DIR, but an explicit value in
  // opts.env wins so callers can still exercise the env-var path directly.
  const env: Record<string, string> = {};
  if (opts?.contextDir !== undefined) env.LOOM_CONTEXT_DIR = opts.contextDir;
  if (opts?.env) Object.assign(env, opts.env);
  const io: IOStreams = {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    stdin,
    stdinIsTTY: opts?.stdin === undefined,
    env,
  };
  const code = await runCli(argv, io);
  return { stdout, stderr, code };
}
