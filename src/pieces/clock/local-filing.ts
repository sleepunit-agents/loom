/** Trusted in-process filing only. Runtime must supply the authenticated Caller;
 * no HTTP, MCP or generated-client input may claim that provenance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayAct, mayCreate, type Db, type Operations, type Sharing } from '../../core/index.js';
import { approvalsRole } from '../approvals/role.js';
import { callerSchema } from '../approvals/validation.js';
import type { Caller } from '../approvals/model.js';
export const localMarker = '<!-- house: local -->';
const invalid = (message: string): never => { throw new OperationError('invalid', message); };
const denied = (message: string): never => { throw new OperationError('denied', message); };
export function localWords(prompt: string, note: string) {
  if (!prompt.includes(localMarker)) invalid('A local wake needs its explicit local marker');
  const raw = prompt.replaceAll(localMarker, '');
  if (raw.normalize('NFKC') !== raw || /[^\P{C}\n]|\p{Default_Ignorable_Code_Point}/u.test(raw)) invalid('Local words must read exactly as they run, without compatibility or control characters');
  const body = raw.trim();
  if (!body || [...body].length > 270) invalid('A local wake needs 1 to 270 characters shown in full');
  const said = note.normalize('NFKC').replace(/\s+/gu, ' ').replace(/[^\P{C}]/gu, '').trim();
  const shownNote = [...said].length > 160 ? [...said].slice(0,157).join('') + '...' : said;
  const digest = createHash('sha256').update(prompt).digest('hex');
  return {body, digest, details: (shownNote ? `Agent's note (its own words): ${shownNote}\n\n` : '') + `Runs on loom's machine, exactly as written, everything from here to the end:\n${body}`};
}
export interface LocalFiling { id: string; target: string; digest: string; prompt: string; note: string; caller: Caller }
const key = (id: string) => `local-filing:${id}`;
/** Private persistence, never published as a live record. Owning recovery must
 * recheck the original Caller, current policy and the live approval before use.
 */
export function filedLocal(db: Db, id: string): LocalFiling | undefined {
  const row = db.prepare('SELECT value FROM clock_meta WHERE key=?').get(key(id)) as {value:string} | undefined;
  return row ? JSON.parse(row.value) : undefined;
}
export function installLocalFiling(db: Db, operations: Operations, sharing: () => Sharing) {
  const input = z.object({caller:callerSchema.strict(),prompt:z.string().min(1).max(100_000),note:z.string().max(100_000)}).strict();
  const role = approvalsRole(operations, 'clock');
  operations.register(operation({name:'clock.localRequest',input,output:z.unknown(),write:true,doors:['direct'],
    may(viewer, i) {
      if (viewer.kind !== 'service' || viewer.id !== 'clock' || !mayAct(viewer,{type:'clock'},sharing(),'act','clock.localRequest')) return false;
      const agent = {kind:'agent' as const,id:i.caller.who.agent};
      return mayCreate(agent,{type:'wake',agent:agent.id,project:i.caller.project},sharing());
    },
    run(_ctx,i) {
      // Private/principal-scoped cards need an owning private-scope contract.
      // Do not let this first owner-only slice expose someone else's words.
      if (i.caller.for !== 'owner' || i.caller.people?.length) denied('Local filing currently requires authenticated owner work without private people');
      const words = localWords(i.prompt,i.note), target = `${i.caller.who.agent}:${words.digest.slice(0,16)}`;
      const result = role.call('request',i.caller,{kind:'local-wake',target,digest:words.digest,
        ask:'Run the job below on loom’s machine itself?',
        why:'This job needs loom’s machine and runs there only with your yes.',
        if_yes:'It runs once on loom’s machine, exactly as written in the details.',
        if_no:'Nothing runs on loom’s machine; the work stays in its container.',details:words.details,
        ...(i.caller.conversation ? {conversation:i.caller.conversation} : {}),
      },randomUUID());
      if (!result.ok) throw new OperationError(result.code,result.message);
      const card = result.value as {id:string;state:string;digest?:string;project?:string;details?:string};
      // Approvals may deduplicate an exact short target. Never overwrite the
      // words/note/principal behind an existing card, even on a hash collision.
      if (card.digest !== words.digest || card.project !== i.caller.project || card.details !== words.details) denied('An existing local decision covers different words or scope');
      const filing: LocalFiling = {id:card.id,target,digest:words.digest,prompt:i.prompt,note:i.note,caller:i.caller};
      const old = filedLocal(db,card.id);
      if (old) {
        if (old.prompt !== filing.prompt || old.note !== filing.note || old.target !== target || old.digest !== words.digest
          || old.caller.project !== i.caller.project || old.caller.for !== i.caller.for || JSON.stringify(old.caller.people ?? []) !== JSON.stringify(i.caller.people ?? []))
          denied('The existing local card keeps its original exact words and note');
      } else db.prepare('INSERT INTO clock_meta(key,value) VALUES (?,?)').run(key(card.id),JSON.stringify(filing));
      return {id:card.id,state:card.state,target};
    },
  }));
}
/** Only a trusted runtime composition may pass Caller to this role. Filing
 * creates no wake and spends no approval; it never dispatches host work.
 */
export function clockLocalFiling(operations: Pick<Operations,'call'>) {
  return {request(caller: Caller, prompt: string, note: string, receipt = randomUUID()) {
    return operations.call('direct',{kind:'service',id:'clock'},'clock.localRequest',{caller,prompt,note},receipt);
  }};
}
