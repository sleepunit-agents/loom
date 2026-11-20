/** Dedicated fd3 consumer, selected by a local owner file. No model or operation
 * supplies this file. No inherited environment, value output or result log. */
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {holderTls,certificateFingerprint} from '../pieces/secrets/holder-authority.js';
import {secretInputBindingSchema} from '../runtime-runner/secret-input.js';
import {secretName} from '../pieces/secrets/input.js';
import {startRuntimeSecretWorker} from '../runtime-runner/runtime-secret-worker.js';
import type {WorkerControlRuntime} from '../runtime-runner/control.js';
import type {IOStreams} from './io.js';
const absolute=z.string().refine(path=>isAbsolute(path)&&!path.includes('\0'));
const client=holderTls.extend({servername:z.string().min(1)});
const grant=z.object({binding:secretInputBindingSchema,name:secretName,expiresAt:z.number().finite()}).strict();
const command=z.object({command:absolute,args:z.array(z.string()),cwd:absolute,env:z.record(z.string(),z.string()),
 input:holderTls,holderFingerprint:certificateFingerprint,authority:client,daemonFingerprint:certificateFingerprint,admission:client}).strict();
const schema=z.object({url:z.string(),tokenFile:absolute,job:z.string().min(1).max(200),
 selection:z.object({policy:z.array(secretName),grants:z.array(grant),jobs:z.array(grant.extend({config:command}))}).strict()}).strict();
export async function runSecretWorker(argv:string[],io:IOStreams,runtime?:WorkerControlRuntime):Promise<number> {
 if(argv.length!==1||argv[0]==='--help') {
  io.stderr('usage: loom-secret-worker <owner-config.json>\n');return argv[0]==='--help'?0:2;
 }
 let worker:Awaited<ReturnType<typeof startRuntimeSecretWorker>>|undefined;
 const stop=()=>{void worker?.close().catch(()=>{});};
 // Install before startup IO too: a stop received before ownership is returned
 // must not allow the late listener/process to escape the shutdown fence.
 let stopping=false;
 const onStop=()=>{stopping=true;stop();};
 process.once('SIGTERM',onStop);process.once('SIGINT',onStop);
 try {
  const config=schema.parse(JSON.parse(await readFile(argv[0],'utf8'))),token=(await readFile(config.tokenFile,'utf8')).trim();
  if(stopping)throw Error();
  worker=await startRuntimeSecretWorker({url:config.url,token,job:config.job},config.selection,runtime);
  if(stopping)await worker.close();
  const [delivered,completed]=await Promise.all([worker.delivery,worker.completed]);
  if(!delivered||!completed||stopping)throw Error();
  return 0;
 }catch {io.stderr('Secret worker stopped; reconcile the job before retrying.\n');return 1;}
 finally {process.removeListener('SIGTERM',onStop);process.removeListener('SIGINT',onStop);await worker?.close();}
}
