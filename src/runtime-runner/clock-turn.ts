/** Worker-side consumption of the existing authenticated Runtime inbox.
 * The owning runner supplies its body client and current binding check. This
 * adapter issues no credential and adds no execution or file-read daemon role. */
import { z } from 'zod';
import { prepareScheduledFile, MAX_BRIEF_BYTES } from './brief.js';
import { ClaudeWorkerSession, WorkerSessionError, type WorkerTurn } from './session.js';
const item=z.object({seq:z.number().int().positive(),id:z.string().startsWith('clock:'),kind:z.literal('wake'),acknowledged:z.literal(true).optional()});
const input=z.object({conversation:z.string(),messages:z.array(z.union([
  item.extend({text:z.string().min(1)}).strict(),item.extend({file:z.string().min(1)}).strict(),
])).min(1).max(100)}).strict();
const active=new WeakSet<ClaudeWorkerSession>();
export interface ClockInbox {
  /** An authenticated body client; rejected registry results must throw. */
  read():Promise<unknown>;
  acknowledge(through:number):Promise<void>;
}
/** One cooperative turn, no interrupt or caller-selected native session handle.
 * Read/staging/source authority and ACK are enforced by the existing Runtime
 * operations; the worker additionally fences its original conversation across
 * awaits. Lost execution or ACK is uncertain and is never retried here. */
export async function runClockTurn(session:ClaudeWorkerSession,
  turn:Omit<WorkerTurn,'message'> & {checkout:string},inbox:ClockInbox) {
  if(active.has(session))throw new WorkerSessionError('Scheduled worker is busy');
  active.add(session);
  try {
    const binding={...turn.binding},current=turn.current,checkout=turn.checkout,rules=turn.rules;
    const check=()=>{let valid=false;try {valid=current()===true;}catch { /* fail closed */ }
      if(!valid){session.close();throw new WorkerSessionError('Scheduled worker binding ended');}};
    check();
    const parsed=input.parse(await inbox.read());
    const batch={...parsed,messages:parsed.messages.filter(m=>!m.acknowledged)};
    check();
    if(batch.conversation!==binding.conversation||batch.messages.some((m,i)=>i>0&&m.seq<=batch.messages[i-1].seq)) {
      session.close();throw new WorkerSessionError('Scheduled conversation changed');
    }
    if(!batch.messages.length)return;
    // Resolve the entire batch before starting the first turn. No partial launch
    // when a later required file is absent, unsafe or marked local.
    const words=batch.messages.map(m=>'text' in m?m.text:prepareScheduledFile(m.file,checkout));
    const message=words.join('\n');
    if(Buffer.byteLength(message)>MAX_BRIEF_BYTES)throw new WorkerSessionError('Scheduled input exceeds its limit');
    check();
    const result=await session.turn({binding,checkout,rules,message,current});
    check();
    await inbox.acknowledge(batch.messages.at(-1)!.seq);
    check();
    return result;
  } catch(error) {session.close();throw error;}
  finally {active.delete(session);}
}
