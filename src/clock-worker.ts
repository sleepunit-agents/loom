#!/usr/bin/env node
/** Dedicated worker executable. The owner supplies a private config on stdin;
 * no config/token/model discovery, daemon launch, automatic retry or stdout. */
import { runClockWorker } from './runtime-runner/clock-worker-entry.js';
process.exitCode=await runClockWorker({input:process.stdin,args:process.argv.slice(2),signals:process,
  stderr:text=>process.stderr.write(text)});
