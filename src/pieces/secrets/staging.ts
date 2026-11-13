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
  return {
    close() {closed=true;},
    async set(who: HolderWrite,name:string,value:Uint8Array,mode:'add'|'replace') {
      before(who);await source.set(who,name,value,mode);
      if (closed) throw new Error('Secret mutation unavailable');
      effects.finish(id(who));
    },
    async remove(who:HolderWrite,name:string) {
      before(who);await source.remove(who,name);
      if (closed) throw new Error('Secret mutation unavailable');
      effects.finish(id(who));
    },
    async hasReceipt(who:HolderWrite) {
      before(who);const found=await source.hasReceipt(who);
      if (closed) throw new Error('Secret mutation unavailable');
      if (found === true) effects.finish(id(who));
      return found;
    },
  };
}
