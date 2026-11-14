#!/usr/bin/env node
/** External worker entry. Run only on a worker with an owner-prepared checkout.
 * This executable is never started by loom serve. */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { buildIdentity } from './pieces/runtime/records.js';
import { runClaudeJob } from './runtime-runner/once.js';
const absolute=z.string().refine(p=>isAbsolute(p)&&!p.includes('\0'));
const configSchema=z.object({url:z.string(),tokenFile:absolute,job:z.string().min(1).max(200),agent:z.string(),
  command:absolute,checkout:absolute,house:buildIdentity,env:z.record(z.string(),z.string()),rules:z.unknown()}).strict();
if(process.argv.length!==3||process.argv[2]==='--help') {
  process.stderr.write('usage: loom-claude-worker <owner-config.json>\n');
  process.exitCode=process.argv[2]==='--help'?0:2;
}else {
  try {
    const config=configSchema.parse(JSON.parse(await readFile(process.argv[2],'utf8')));
    const token=(await readFile(config.tokenFile,'utf8')).trim();
    await runClaudeJob({url:config.url,token,job:config.job},{command:config.command,checkout:config.checkout,
      house:config.house,env:config.env,rules:config.rules,
      binding:{agent:config.agent,conversation:config.job,venue:'worker',place:config.job}});
  }catch {
    process.stderr.write('Worker stopped; reconcile the job before retrying.\n');process.exitCode=1;
  }
}
