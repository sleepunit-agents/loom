/** Worker-only Claude execution. No daemon registration or old-store access. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prepareRunnerBrief } from './brief.js';

const bindingSchema=z.object({agent:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  conversation:z.string().min(1).max(200),venue:z.string().min(1).max(200),place:z.string().min(1).max(200)}).strict();
export type RunnerBinding=z.infer<typeof bindingSchema>;
export interface WorkerTurn {
  /** Owning ingestion's ORIGINAL binding, never a body/adapter resume claim. */
  binding:RunnerBinding;
  rules:unknown;
  message:string;
  checkout?:string;
  /** Synchronous owning check, including policy revision, binding and job control.
   * Throws/false revokes this turn and all retained native history. */
  current:()=>boolean;
}
export interface TurnResult {text:string;session:string;resumed:boolean}
export class WorkerSessionError extends Error {}
export type SpawnClaude=(command:string,args:readonly string[],options:{cwd?:string;env:NodeJS.ProcessEnv;shell:false;stdio:['pipe','pipe','pipe']})=>ChildProcessWithoutNullStreams;
const MAX_OUTPUT=1_048_576;
const same=(a:RunnerBinding,b:RunnerBinding)=>JSON.stringify(a)===JSON.stringify(b);
/** One object owns one original conversation and its private history. Never
 * deserialize history keys or accept a caller-supplied native session id.
 * Destroying this object discards reuse authority; restart begins fresh.
 */
export class ClaudeWorkerSession {
  #binding?:RunnerBinding;
  #history?:{session:string;key:string;checkout?:string};
  #active?:ChildProcessWithoutNullStreams;
  #busy=false;
  #closed=false;
  readonly #spawn:SpawnClaude;
  readonly #env:NodeJS.ProcessEnv;
  constructor(private readonly command:string,env:NodeJS.ProcessEnv,launch:SpawnClaude=spawn) {
    if(!command||command.includes('\0'))throw new WorkerSessionError('Invalid Claude executable');
    this.#env={...env};this.#spawn=launch;
  }
  /** Revocation is sticky. Kill the owned foreground child and never reuse its
   * history, even when it exits successfully after the stop request. */
  close():void {this.#closed=true;this.#history=undefined;this.#active?.kill('SIGKILL');}
  async turn(raw:WorkerTurn):Promise<TurnResult> {
    if(this.#closed||this.#busy)throw new WorkerSessionError('Worker session is closed or busy');
    this.#busy=true;
    try {
      const binding=Object.freeze(bindingSchema.parse(raw.binding));
      if(this.#binding&&!same(this.#binding,binding)) {
        this.close();throw new WorkerSessionError('Original worker binding changed');
      }
      this.#binding??=binding;
      const current=raw.current;
      const check=()=>{
        let valid=false;try {valid=current()===true;}catch { /* failure is a revocation */ }
        if(!valid||this.#closed){this.close();throw new WorkerSessionError('Worker policy or binding is no longer current');}
      };
      check();
      const prepared=prepareRunnerBrief(raw.rules,raw.checkout);
      if(typeof raw.message!=='string'||!raw.message.trim()||raw.message.includes('\0')||Buffer.byteLength(raw.message)>MAX_OUTPUT)
        throw new WorkerSessionError('Invalid worker message');
      const message=raw.message,checkout=raw.checkout;
      const retained=this.#history?.key===prepared.key&&this.#history.checkout===checkout?this.#history:undefined;
      // An attempted turn consumes the history lease. Any uncertain failure
      // leaves no resumable authority, including a lost/invalid harness result.
      this.#history=undefined;
      const session=retained?.session??randomUUID(),resumed=!!retained;
      const args=['-p','--output-format','json',...(resumed?['--resume',session]:['--session-id',session]),
        ...(prepared.deny.length?['--disallowedTools',...prepared.deny]:[])];
      // No caller args, shell, arbitrary resume id or message words in argv.
      check();
      const child=this.#spawn(this.command,args,{cwd:checkout,env:{...this.#env},shell:false,stdio:['pipe','pipe','pipe']});
      this.#active=child;
      const result=await new Promise<string>((resolve,reject)=>{
        const chunks:Buffer[]=[];let bytes=0,settled=false;
        const fail=(message:string)=>{
          if(settled)return;settled=true;child.kill('SIGKILL');reject(new WorkerSessionError(message));
        };
        child.on('error',()=>fail('Claude launch failed'));
        child.stdout.on('error',()=>fail('Claude output failed'));
        child.stderr.on('error',()=>fail('Claude diagnostics failed'));
        child.stdin.on('error',()=>fail('Claude input failed'));
        child.stdout.on('data',(data:Buffer)=>{
          if(settled)return;
          bytes+=data.length;
          if(bytes>MAX_OUTPUT){fail('Claude output exceeded its limit');return;}
          chunks.push(Buffer.from(data));
        });
        // Drain diagnostics without retaining potentially sensitive words.
        child.stderr.on('data',(data:Buffer)=>{
          if(settled)return;
          bytes+=data.length;
          if(bytes>MAX_OUTPUT)fail('Claude output exceeded its limit');
        });
        child.on('close',(code:number|null)=>{
          if(settled)return;settled=true;
          if(code!==0){reject(new WorkerSessionError('Claude turn failed'));return;}
          try {
            const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
            if(output.type!=='result'||output.is_error!==false||output.session_id!==session||typeof output.result!=='string')
              throw new Error('invalid result');
            resolve(output.result);
          }catch {reject(new WorkerSessionError('Claude result is invalid'));}
        });
        try {
          // The injected spawn boundary may itself revoke before stdin exists.
          check();
          child.stdin.end(`${prepared.brief}\n${message}`);
        }catch {fail('Worker revoked before input release');}
      });
      check();
      this.#history={session,key:prepared.key,checkout};
      return {text:result,session,resumed};
    }catch(error) {
      this.#history=undefined;
      // A failed child may still be exiting. Fence the whole session rather
      // than permit another process to overlap or reuse uncertain history.
      if(this.#active)this.close();
      throw error;
    }finally {this.#active=undefined;this.#busy=false;}
  }
}
