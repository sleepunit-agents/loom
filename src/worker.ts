#!/usr/bin/env node
/** Standalone work-plane executable. Never imported by loom's server. */
import { readFile } from 'node:fs/promises';
import { workerProgram } from './runtime/worker-program.js';
/** How long the process is given to end by itself once the worker program has returned. */
const WORKER_EXIT_GRACE_MS = 2_000;
const code = await workerProgram({ args: process.argv.slice(2),
  read: path => readFile(path, 'utf8'),
  on: (name, stop) => { process.on(name, stop); },
  off: (name, stop) => { process.off(name, stop); },
  error: text => { process.stderr.write(text); },
  output: text => { process.stdout.write(text); },
});
process.exitCode = code;
// The worker program has ended every body, joined every loop it started and given up its state directory
// by the time it returns, so nothing of its own is left to do. One thing can still hold the process open:
// a call to a filesystem that never answers (a watched mount whose server is gone, machine-check.ts) stays
// out for as long as the kernel keeps it, and a process with such a call does not end by itself. The
// process is given a moment to end in the ordinary way, which lets what was written to its output drain,
// and is then ended. The timer does not itself keep the process open.
setTimeout(() => process.exit(code), WORKER_EXIT_GRACE_MS).unref();
