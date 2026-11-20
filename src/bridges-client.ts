#!/usr/bin/env node
import { runBridgesClient } from './cli/bridges-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runBridgesClient(process.argv.slice(2), realStreams());
