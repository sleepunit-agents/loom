#!/usr/bin/env node
import { runApiClient } from './cli/api-client.js';
import { realStreams } from './cli/io.js';
import { taskCommands } from './pieces/tasks/commands.js';
process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e; });
process.exitCode = await runApiClient('tasks', taskCommands, process.argv.slice(2), realStreams());
