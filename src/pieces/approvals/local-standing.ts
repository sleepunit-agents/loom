import { localOwner, sameLocalCaller } from './local-authority.js';
/** Exact standing-local authority for trusted Clock composition. No public
 * Caller, original words or standing record is exposed through this seam.
 */
import { z } from 'zod';
import { operation, OperationError, mayAct, mayCreate, type Db, type Operations, type Sharing } from '../../core/index.js';
import { callerSchema } from './validation.js';
import { serviceOf, iso, type Caller } from './model.js';
import { load, persist } from './store.js';
import { log } from './domain.js';
export const localStandingInput = z.object({
  caller:callerSchema.strict(), approval:z.string().regex(/^a-[0-9a-f]{8}$/),
  mode:z.enum(['use','check']),
  expected:z.object({target:z.string(),digest:z.string().regex(/^[0-9a-f]{64}$/),details:z.string(),caller:callerSchema.strict()}).strict(),
}).strict();
export type LocalStandingInput = z.infer<typeof localStandingInput>;
const deny = (): never => {throw new OperationError('denied','No current standing authority for this exact local filing and caller');};
export function installLocalStanding(db:Db, operations:Operations, sharing:()=>Sharing) {
  for(const mode of ['use','check'] as const) {
    const name=mode==='use'?'approvals.piece-standing-local':'approvals.piece-standing-local-check';
    operations.register(operation({name,input:localStandingInput.extend({mode:z.literal(mode)}),output:z.unknown(),write:mode==='use',recheckPolicy:true,doors:['direct'],
      may(v,i) {
        return v.kind==='service' && v.id==='clock'
          && mayAct(v,{type:'approval',agent:i.caller.who.agent,project:i.caller.project},sharing(),'act',name)
          && mayCreate({kind:'agent',id:i.caller.who.agent},{type:'approval',agent:i.caller.who.agent,project:i.caller.project},sharing());
      },
      run(ctx,i) {
        // Standing jobs can outlive core's 30-day retry window. Keep the
        // exact committed use result privately for the lifetime of its authority.
        const receipt=ctx.receipt;
        const useKey=receipt ? 'local-standing-use:'+JSON.stringify([receipt.viewer,receipt.id]) : undefined;
        if(useKey) {
          const old=db.prepare('SELECT value FROM approvals_meta WHERE key=?').get(useKey) as {value:string}|undefined;
          if(old) {
            const saved=JSON.parse(old.value);
            if(saved.name!==receipt!.name || saved.inputHash!==receipt!.inputHash)
              throw new OperationError('conflict','Standing use receipt already covers different input');
            return saved.result;
          }
        }
        const s=load(db), a=s.approvals.find(a=>a.id===i.approval), e=i.expected;
        if(!a || !localOwner(i.caller,sharing()) || !localOwner(e.caller,sharing()) || !sameLocalCaller(i.caller,e.caller) || !sameLocalCaller({who:a.who,for:a.for,people:a.people,project:a.project,member:a.member,conversation:a.conversation},e.caller)
          || a.kind!=='local-wake' || a.target!==e.target || a.digest!==e.digest || a.details!==e.details
          || e.target!==`${i.caller.who.agent}:${e.digest.slice(0,16)}` || !['allowed','used'].includes(a.state)) return deny();
        const j=s.standing.find(j=>j.from===a.id && !j.off && j.kind==='local-wake' && j.agent===a.who.agent
          && j.target===e.target && j.digest===e.digest && j.details===e.details && j.by===a.by
          && sameLocalCaller({who:j.who,for:j.for,people:j.people,project:j.project,member:j.member,conversation:a.conversation},e.caller));
        if(!j || s.approvals.some(b=>b.kind==='local-wake' && b.target===a.target && b.who.agent===a.who.agent
          && b.member===a.member && b.state==='denied' && Date.parse(b.decided??'')>=Date.parse(j.at))) return deny();
        const result={id:j.id,state:'on',uses:j.uses+(i.mode==='use'?1:0)};
        if(i.mode==='use') {
          j.uses++; j.used=iso(ctx.now); log(s,'standing-use',j,ctx.now,{asked_from:i.caller.who});
          for(const change of persist(db,s,ctx.now))ctx.changed(change.type,change.id);
          db.prepare('INSERT INTO approvals_meta(key,value) VALUES (?,?)').run(useKey,JSON.stringify({name:receipt!.name,inputHash:receipt!.inputHash,result}));
        }
        return result;
      },
    }));
  }
}
