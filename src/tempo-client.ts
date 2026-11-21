#!/usr/bin/env node
import { runTempoClient } from './cli/tempo-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runTempoClient(process.argv.slice(2), realStreams());
