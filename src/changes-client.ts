#!/usr/bin/env node
import { runChangesClient } from './cli/changes-client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='EPIPE') throw e;});
process.exitCode=await runChangesClient(process.argv.slice(2),realStreams());
