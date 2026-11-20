#!/usr/bin/env node
/** Private work-plane receiver, launched only by an opted-in worker runner. */
import { fileURLToPath } from 'node:url';
import { bodyCommandEnvironment } from './runtime/worker-mounts.js';
import { readFile } from 'node:fs/promises';
import { readBodyStdin } from './runtime/body-stdin.js';
import { bodyProgram } from './runtime/body-program.js';
const abort = new AbortController();
const stop = () => { abort.abort(); process.stdin.destroy(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  process.exitCode = await bodyProgram({
    args: process.argv.slice(2), env: bodyCommandEnvironment(fileURLToPath(import.meta.url), process.env), signal: abort.signal,
    read: path => readFile(path, 'utf8'),
    stdin: () => readBodyStdin(process.stdin, abort.signal),
    error: text => { process.stderr.write(text); },
  });
} finally { abort.abort(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
