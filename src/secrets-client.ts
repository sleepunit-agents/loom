#!/usr/bin/env node
import { runSecretsClient } from './cli/secrets-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error; });
process.exitCode = await runSecretsClient(process.argv.slice(2), realStreams());
