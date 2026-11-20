#!/usr/bin/env node
/** External worker only. Never started by loom serve. */
import { runClaudeWorker } from './cli/claude-worker.js';
import { realStreams } from './cli/io.js';
process.exitCode=await runClaudeWorker(process.argv.slice(2),realStreams());
