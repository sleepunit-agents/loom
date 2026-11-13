/** Standing dispatch provenance is private and immutable; public wake fields
 * cannot supply Caller or substitute the executable words behind an Allow. */
import { randomUUID } from 'node:crypto';
import { OperationError, type Db, type Operations } from '../../core/index.js';
import { approvalsRole, type Caller } from '../approvals/role.js';
import { localWords, type LocalFiling } from './local-filing.js';
import type { Wake } from './store.js';
interface Binding { filing: LocalFiling; caller: Caller; work: string }
const key=(id:string)=>`local-standing-wake:${id}`;
// Include all executable and scope inputs, including fields absent at filing.
const work=(w:Wake)=>JSON.stringify([w.agent,w.project,w.member,w.prompt,w.note,w.file,w.model,
  w.continuation,w.slot,w.approval,w.place,w.laneVersion,w.scheduleRevision,w.schedule,w.by]);
export function standingBinding(db:Db,id:string):Binding|undefined {
  const row=db.prepare('SELECT value FROM clock_meta WHERE key=?').get(key(id)) as {value:string}|undefined;
  return row ? JSON.parse(row.value) : undefined;
}
export function bindStandingWake(db:Db,w:Wake,filing:LocalFiling,caller:Caller) {
  db.prepare('INSERT INTO clock_meta(key,value) VALUES (?,?)').run(key(w.id),JSON.stringify({filing,caller,work:work(w)}));
}
export function checkStandingWake(db:Db,operations:Operations,w:Wake) {
  const binding=standingBinding(db,w.id);
  if(!binding) return;
  if(binding.work!==work(w)) throw new OperationError('denied','Standing wake differs from its immutable filing');
  const {filing,caller}=binding,words=localWords(filing.prompt,filing.note);
  if(words.digest!==filing.digest || filing.target!==`${filing.caller.who.agent}:${words.digest.slice(0,16)}`)
    throw new OperationError('denied','Standing filing digest differs');
  const result=approvalsRole(operations,'clock').localStanding(caller,{approval:filing.id,mode:'check',
    expected:{target:filing.target,digest:words.digest,details:words.details,caller:{...filing.caller,who:{...filing.caller.who}}}},randomUUID());
  if(!result.ok) throw new OperationError(result.code,result.message);
}
