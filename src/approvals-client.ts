#!/usr/bin/env node
import { runApprovalsClient } from './pieces/approvals/client.js';
import { realStreams } from './cli/io.js';
process.stdout.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='EPIPE')throw e;});
process.exitCode=await runApprovalsClient(process.argv.slice(2),realStreams());
