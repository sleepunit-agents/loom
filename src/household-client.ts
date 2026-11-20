#!/usr/bin/env node
import { runHouseholdClient } from './cli/household-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runHouseholdClient(process.argv.slice(2), realStreams());
