/** Pure worker preparation. This does not authorize a read, native launch,
 * source receipt, acknowledgement or resume. The owning runner must separately
 * validate the exact Clock source and original binding at execution time. */
import { z } from 'zod';
import { prepareScheduledFile, MAX_BRIEF_BYTES } from './brief.js';
const item=z.object({seq:z.number().int().positive(),id:z.string().startsWith('clock:'),kind:z.literal('wake'),acknowledged:z.literal(true).optional()});
const input=z.object({conversation:z.string().min(1),messages:z.array(z.union([
  item.extend({text:z.string().min(1)}).strict(),item.extend({file:z.string().min(1)}).strict(),
])).max(100)}).strict();
/** A caller-provided batch is data, never owning Runtime authority. Resolve all
 * files before returning any words. The caller must not start/ACK stale sources
 * merely because preparation succeeded, or retry an uncertain execution. */
export function prepareClockInput(raw:unknown,conversation:string,checkout:string):
  {message:string;through:number}|undefined {
  const batch=input.parse(raw);
  if(batch.conversation!==conversation||batch.messages.some((m,i)=>i>0&&m.seq<=batch.messages[i-1].seq))
    throw new Error('Scheduled conversation or sequence changed');
  const pending=batch.messages.filter(m=>!m.acknowledged);
  if(!pending.length)return;
  const words=pending.map(m=>'text' in m?m.text:prepareScheduledFile(m.file,checkout));
  if(words.some(text=>!text.trim()||text.includes('\0')||text.includes('<!-- house: local -->')))
    throw new Error('Scheduled input requires a different execution boundary');
  const message=words.join('\n');
  if(Buffer.byteLength(message)>MAX_BRIEF_BYTES)throw new Error('Scheduled input exceeds its limit');
  return {message,through:pending.at(-1)!.seq};
}
