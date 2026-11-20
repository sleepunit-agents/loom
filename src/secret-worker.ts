#!/usr/bin/env node
/** External dedicated command owner. Never started by loom serve. */
import {runSecretWorker} from './cli/secret-worker.js';
import {realStreams} from './cli/io.js';
process.exitCode=await runSecretWorker(process.argv.slice(2),realStreams());
