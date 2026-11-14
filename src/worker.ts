#!/usr/bin/env node
/** Standalone work-plane executable. Never imported by loom's server. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { commandWorkerExecutor } from './runtime/worker-process.js';
import { httpWorkerControl } from './runtime/worker-http.js';
import { runWorker } from './runtime/worker-loop.js';
const command = z.object({ command: z.string().min(1), args: z.array(z.string()), cwd: z.string().min(1), env: z.record(z.string(), z.string()) }).strict();
const configSchema = z.object({
  url: z.string(), box: z.string().min(1), tokenFile: z.string().min(1),
  build: command, runners: z.record(z.string(), command),
}).strict();
const abort = new AbortController();
const stop = () => abort.abort();
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  if (process.argv.length !== 3) throw new Error('Expected worker configuration path');
  const config = configSchema.parse(JSON.parse(await readFile(process.argv[2], 'utf8')));
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  await runWorker({ box: config.box, signal: abort.signal,
    control: httpWorkerControl({ url: config.url, token, signal: abort.signal }),
    executor: commandWorkerExecutor(config),
  });
} catch {
  process.stderr.write('Worker stopped: invalid configuration or unavailable execution\n');
  process.exitCode = 1;
} finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
