/** Local owner configuration entry; no operation accepts these selections. */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { buildIdentity } from '../pieces/runtime/records.js';
import { runClaudeJob } from '../runtime-runner/once.js';
import type { WorkerControlRuntime } from '../runtime-runner/lifecycle.js';
import type { SpawnClaude } from '../runtime-runner/session.js';
import type { IOStreams } from './io.js';
import { inspectWorkerReceipts } from '../runtime-runner/receipts.js';
const absolute=z.string().refine(p=>isAbsolute(p)&&!p.includes('\0'));
const schema=z.object({url:z.string(),tokenFile:absolute,job:z.string().min(1).max(200),agent:z.string(),
 command:absolute,checkout:absolute,receipts:absolute,house:buildIdentity,env:z.record(z.string(),z.string()),rules:z.unknown()}).strict();
export async function runClaudeWorker(argv:string[],io:IOStreams,runtime?:WorkerControlRuntime&{spawn?:SpawnClaude}):Promise<number> {
 if(argv.length===2&&argv[0]==='--inspect') {
  try {io.stdout(JSON.stringify(inspectWorkerReceipts(argv[1]))+'\n');return 0;}
  catch {io.stderr('Worker receipts unavailable; reconcile before retrying.\n');return 1;}
 }
 if(argv.length!==1||argv[0]==='--help') {
  io.stderr('usage: loom-claude-worker <owner-config.json> | --inspect <receipts-directory>\n');return argv[0]==='--help'?0:2;
 }
 try {
  const config=schema.parse(JSON.parse(await readFile(argv[0],'utf8'))),token=(await readFile(config.tokenFile,'utf8')).trim();
  await runClaudeJob({url:config.url,token,job:config.job},{command:config.command,checkout:config.checkout,receipts:config.receipts,
   house:config.house,env:config.env,rules:config.rules,spawn:runtime?.spawn,
   binding:{agent:config.agent,conversation:config.job,venue:'worker',place:config.job}},runtime);
  return 0;
 }catch {io.stderr('Worker stopped; reconcile the job before retrying.\n');return 1;}
}
