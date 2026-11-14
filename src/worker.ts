#!/usr/bin/env node
/** Standalone work-plane executable. Never imported by loom's server. */
import { readFile } from 'node:fs/promises';
import { workerProgram } from './runtime/worker-program.js';
process.exitCode = await workerProgram({ args: process.argv.slice(2),
  read: path => readFile(path, 'utf8'),
  on: (name, stop) => { process.on(name, stop); },
  off: (name, stop) => { process.off(name, stop); },
  error: text => { process.stderr.write(text); },
});
