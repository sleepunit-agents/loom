#!/usr/bin/env node
import { runAttentionClient } from './pieces/attention/client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runAttentionClient(process.argv.slice(2), realStreams());
