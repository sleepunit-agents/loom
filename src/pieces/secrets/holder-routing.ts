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
  if (configured.length > 1024) throw failed();
  const routes = new Map<string, HolderWorkerRoute['transport']['deliver']>();
  for (const route of configured) {
    const key = identity(route.binding);
    if (routes.has(key)) throw failed();
    routes.set(key, route.transport.deliver.bind(route.transport));
  }
  return async id => {
    const claim = await tickets.claim(id);
    if (!claim) return null;
    let invalid = false, attempted = false, abandoned = false;
    const abandon = async () => {
      invalid = true;
      if (abandoned) return;
      abandoned = true; // Consume before IO, even when settlement loses its ack.
      await claim.finish(false);
    };
    try {
      const binding = Object.freeze(secretInputBindingSchema.parse(claim.destination));
      const deliver = routes.get(identity(binding));
      if (!claim.pendingId || !deliver) throw failed();
      const pendingId = claim.pendingId;
      return Object.freeze({name: claim.name, abandon,
        async current() {
          if (invalid) return false;
          try { if (await claim.current() !== true) invalid = true; }
          catch { invalid = true; }
          return !invalid;
        },
        async handTo(bytes: Uint8Array) {
          if (invalid || attempted) throw failed();
          attempted = true;
          try {
            if (await claim.current() !== true || invalid) throw failed();
            await deliver(pendingId, binding, bytes);
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
}
