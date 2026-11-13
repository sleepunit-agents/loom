#!/usr/bin/env node
import { runAccessClient } from './cli/access-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runAccessClient('sessions', process.argv.slice(2), realStreams());
