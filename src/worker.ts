#!/usr/bin/env node
/** Standalone work-plane executable. Never imported by loom's server. */
// Before anything that reads a file or looks up a name: the pool those calls share is made at the first of
// them, at the size this says. Node's four would leave little once a watched filesystem stops answering
// and its calls stay out (machine-check.ts, UNANSWERED_MAX). Eight, unless whoever starts the worker set
// their own. This is the worker's process only; loom's server never loads this file.
process.env.UV_THREADPOOL_SIZE ??= '8';
const { readFile } = await import('node:fs/promises');
const { workerProgram } = await import('./runtime/worker-program.js');
const { endWorker } = await import('./runtime/worker-exit.js');
let unanswered = 0;
const code = await workerProgram({ args: process.argv.slice(2),
  read: path => readFile(path, 'utf8'),
  on: (name, stop) => { process.on(name, stop); },
  off: (name, stop) => { process.off(name, stop); },
  error: text => { process.stderr.write(text); },
  output: text => { process.stdout.write(text); },
  unanswered: count => { unanswered = count; },
});
// Ends by itself with this code, unless a call to a dead filesystem is still out (worker-exit.ts).
endWorker(code, unanswered);
