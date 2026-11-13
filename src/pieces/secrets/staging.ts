/** Durable per-admission staging hold. A holder id is globally unique and bound
 * to full input in the journal. Once released, its receipt probes and exact
 * retries share that one effect; absence never cancels an uncertain write. */
import type {OutsideEffects} from '../../core/effects.js';
import type {AsyncSecretMutations} from './async-values.js';
import type {HolderWrite} from './holder-store.js';
export function heldSecretMutations(source: AsyncSecretMutations, effects: OutsideEffects) {
  let closed = false;
  const id = (who: HolderWrite) => `secrets:write:${who.writeId}`;
  function before(who: HolderWrite) {
    if (closed) throw new Error('Secret mutation unavailable');
    const state = effects.status(id(who));
    if (state !== 'started' && state !== 'done' && state !== 'uncertain' && !effects.beforeOutside({id:id(who),kind:'secret-write',title:'Write secret through key holder'}))
      throw new Error('Secret mutation held');
  }
  async function mutate(who:HolderWrite, run:()=>Promise<void>) {
    before(who);await run();
    if (closed) throw new Error('Secret mutation unavailable');
    effects.finish(id(who));
  }
  return {
    async close() {closed=true;await source.close?.();},
    set:(who:HolderWrite,name:string,value:Uint8Array,mode:'add'|'replace') => mutate(who,()=>source.set(who,name,value,mode)),
    remove:(who:HolderWrite,name:string) => mutate(who,()=>source.remove(who,name)),
    async hasReceipt(who:HolderWrite) {
      before(who);const found=await source.hasReceipt(who);
      if (closed) throw new Error('Secret mutation unavailable');
      if (found === true) effects.finish(id(who));
      return found;
    },
  };
}
