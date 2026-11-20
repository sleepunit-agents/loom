#!/usr/bin/env node
import { runWakeClient } from './cli/wake-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='EPIPE')throw e;});
process.exitCode=await runWakeClient(process.argv.slice(2),realStreams());
