import type { Clock } from '../../core/clock.js';
import type { HolderGeneration } from '../secrets/role.js';

/** Public holder metadata only. Polling stays independent of serialized venue IO.
 * A failure invalidates the lifetime, including recovery to the same holder UUID.
 */
export function bridgeCredentials(source: HolderGeneration, clock: Clock) {
  let closed=false, current: string | undefined;
  let cancelPoll: (()=>void) | undefined, cancelRead: (()=>void) | undefined;
  let abandon: (()=>void) | undefined;
  const listeners=new Set<()=>void>();
  function publish(value: string | undefined) {
    if (current === value) return;
    current=value;
    for (const listener of listeners) listener();
  }
  async function poll() {
    let expired=false;
    const timeout=new Promise<undefined>(resolve=>{
      abandon=()=>{expired=true;resolve(undefined);};
      cancelRead=clock.at(clock.now()+5000,()=>abandon?.());
    });
    // Promise.resolve also contains a synchronous provider exception. The losing
    // provider Promise has a rejection handler and can never publish a late value.
    const read=Promise.resolve().then(()=>source.generation()).catch(()=>undefined);
    const value=await Promise.race([read,timeout]);
    cancelRead?.();cancelRead=undefined;abandon=undefined;
    if (closed) return;
    const valid=!expired && typeof value === 'string' && value.length === 36
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    publish(valid ? value : undefined);
    cancelPoll=clock.at(clock.now()+5000,()=>{cancelPoll=undefined;void poll();});
  }
  void poll();
  return {
    current:()=>current,
    observe(changed:()=>void) { listeners.add(changed);return ()=>{listeners.delete(changed);}; },
    close() {
      if (closed) return;
      closed=true;cancelPoll?.();cancelRead?.();abandon?.();publish(undefined);listeners.clear();
    },
  };
}
