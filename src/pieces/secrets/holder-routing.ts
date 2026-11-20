/** Owner-wired holder routing. No operation, endpoint discovery or activation. */
import type { HolderHandoffAuthority } from './holder-handoff.js';
import type { RemoteTicketClaim } from './ticket-authority.js';
import { secretInputBindingSchema, type SecretInputBinding } from './worker-binding.js';

const failed = () => new Error('Secret handoff unavailable');
export interface HolderWorkerRoute {
  readonly binding: SecretInputBinding;
  /** An already configured, authenticated workerSecretTransport capability. */
  readonly transport: {
    deliver(id: string, binding: SecretInputBinding, bytes: Uint8Array): Promise<void>;
  };
}
const identity = (binding: SecretInputBinding) => JSON.stringify(secretInputBindingSchema.parse(binding));

/** Each original remote claim is acquired once. A routing failure burns it as
 * uncertain. Successful worker delivery deliberately leaves it claimed: the
 * owning daemon completion protocol must settle the original ticket after its
 * holder acknowledgement, or uncertain on a missing acknowledgement. */
export function routedHolderAuthority(
  tickets: {claim(id: string): Promise<RemoteTicketClaim | null>},
  configured: readonly HolderWorkerRoute[],
): HolderHandoffAuthority {
  return managedHolderAuthority(tickets, configured).authority;
}

/** Private owner controller. Replacement validates the entire selection before
 * retiring the old generation, including equal routes. No discovery or public API. */
export function managedHolderAuthority(
  tickets: {claim(id: string): Promise<RemoteTicketClaim | null>},
  configured: readonly HolderWorkerRoute[],
  options:{owned?:boolean}={},
) {
  const owned=options.owned===true;
  const snapshot = (configured: readonly HolderWorkerRoute[]) => {
    try {
      if (configured.length > 1024) throw failed();
      const routes = new Map<string, HolderWorkerRoute['transport']['deliver']>();
      for (const route of Array.from(configured)) {
        const key = identity(route.binding);
        if (routes.has(key)) throw failed();
        routes.set(key, route.transport.deliver.bind(route.transport));
      }
      return routes;
    } catch { throw failed(); }
  };
  let routes = snapshot(configured), generation = 0, closed = false;
  let closing: Promise<void> | undefined;
  let uncertain=false;
  const retained = new Set<() => Promise<void>>();
  const draining = new Set<Promise<void>>();
  const acquiring = new Set<Promise<unknown>>();
  const poison=()=>{uncertain=true;closed=true;generation++;routes.clear();};
  const retire = async () => {
    const abandoned = [...retained];
    retained.clear();
    const pending = abandoned.map(abandon => abandon());
    const outcomes=await Promise.allSettled([...pending, ...draining, ...acquiring]);
    if(uncertain||outcomes.some(result=>result.status==='rejected'))throw failed();
  };
  const acquire: HolderHandoffAuthority = async id => {
    if (closed) return null;
    const original = generation;
    let claim: RemoteTicketClaim | null;
    try { claim = await tickets.claim(id); } catch { if(owned)poison();return null; }
    // The production client deliberately hides transport/denial diagnostics as
    // null. That cannot prove no claim was consumed before its ack was lost.
    // Fail closed for both outcomes rather than adopting an equal generation.
    if (!claim) {if(owned)poison();return null;}
    let invalid = false, attempted = false, abandoned = false;
    const abandon = async () => {
      invalid = true;
      if (abandoned) return;
      abandoned = true; // Consume before IO, even when settlement loses its ack.
      retained.delete(abandon);
      const pending = (async () => {
        try { await claim.finish(false); } catch {
          // Lost settlement is sticky. A new equal route cannot repair the
          // original receipt or make this controller safe to transfer again.
          poison();throw failed();
        }
      })();
      draining.add(pending);
      void pending.then(() => draining.delete(pending), () => draining.delete(pending));
      await pending;
    };
    try {
      if (closed || original !== generation) throw failed();
      const binding = Object.freeze(secretInputBindingSchema.parse(claim.destination));
      const deliver = routes.get(identity(binding));
      if (!claim.pendingId || !deliver) throw failed();
      const pendingId = claim.pendingId;
      retained.add(abandon);
      const live = () => !invalid && !closed && original === generation;
      return Object.freeze({name: claim.name, abandon,
        async current() {
          if (!live()) return false;
          try { if (await claim.current() !== true) invalid = true; }
          catch { invalid = true; }
          if (!live()) {
            try { await abandon(); } catch { /* failed proof remains retired */ }
            return false;
          }
          return true;
        },
        async handTo(bytes: Uint8Array) {
          if (!live() || attempted) throw failed();
          attempted = true;
          try {
            if (await claim.current() !== true || !live()) throw failed();
            await deliver(pendingId, binding, bytes);
            if (!live()) throw failed();
            // The owning completion protocol now holds settlement. Do not
            // retain completed deliveries for the lifetime of this controller.
            retained.delete(abandon);
          } catch {
            try { await abandon(); } catch { /* original settlement already consumed */ }
            throw failed();
          }
        },
      });
    } catch {
      try { await abandon(); } catch { /* never reconstruct or retry */ }
      return null;
    }
  };
  const authority:HolderHandoffAuthority=id=>{
    // Register before returning to the event loop. Retirement must also join
    // claims not yet acquired, whose original generation will be abandoned.
    const pending=acquire(id);acquiring.add(pending);
    void pending.then(()=>acquiring.delete(pending),()=>acquiring.delete(pending));
    return pending;
  };
  return Object.freeze({authority,
    async replace(configured: readonly HolderWorkerRoute[]) {
      if (closed) throw failed();
      const next = snapshot(configured);
      routes = next; generation++;
      await retire();
    },
    close() {
      if (closing) return closing;
      closed = true; generation++; routes.clear();
      return closing = retire();
    },
  });
}
