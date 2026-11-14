#!/usr/bin/env node
/** Dedicated worker executable. The owner supplies a private config on stdin;
 * no config/token/model discovery, daemon launch, automatic retry or stdout. */
import { startClockWorker, type ClockWorkerConfig } from './runtime-runner/clock-worker.js';

let worker:ReturnType<typeof startClockWorker>|undefined;
let stopped=false;
const stop=()=>{stopped=true;void worker?.close();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try {
  if(process.argv.length!==2)throw new Error();
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1_048_576)throw new Error();chunks.push(Buffer.from(chunk));}
  if(stopped)throw new Error();
  worker=startClockWorker(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as ClockWorkerConfig);
  process.exitCode=await worker.completed?0:1;
}catch {process.stderr.write('Scheduled worker unavailable\n');process.exitCode=1;}
finally {await worker?.close();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
