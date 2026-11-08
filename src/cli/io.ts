/**
 * CLI I/O — stream writers, body reader (stdin → $EDITOR fallback),
 * and the --json vs human render dispatcher.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';

export interface IOStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function realStreams(): IOStreams {
  return {
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env,
  };
}

export async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function openEditor(
  env: NodeJS.ProcessEnv,
  subcommand: string,
  initial: string = '',
): Promise<string> {
  // Spec §"Body input for write commands": $VISUAL ?? $EDITOR ?? 'vi'.
  const editor = env.VISUAL ?? env.EDITOR ?? 'vi';
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const tempPath = join(tmpdir(), `loom-${subcommand}-${process.pid}-${randomSuffix}.md`);
  await writeFile(tempPath, initial, 'utf-8');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [tempPath], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`editor exited with code ${code}; temp file at ${tempPath}`));
    });
    child.on('error', reject);
  });
  const body = await readFile(tempPath, 'utf-8');
  await unlink(tempPath).catch(() => { /* best effort */ });
  return body;
}

export async function readBody(
  io: IOStreams,
  subcommand: string,
): Promise<string> {
  if (!io.stdinIsTTY) {
    return (await readStdin(io.stdin)).trimEnd();
  }
  const body = await openEditor(io.env, subcommand);
  return body.trimEnd();
}

export function renderJson(io: IOStreams, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2) + '\n');
}

export function stderrWritable(io: IOStreams): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void) {
      io.stderr(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      callback();
    },
  });
}
