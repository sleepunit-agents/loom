/** Trusted metadata-only admission. Unregistered until a real holder/runner
 * composition exists. An opaque ticket is neither a grant nor a destination. */
import { secretInputBindingSchema, type SecretInputBinding } from '../../runtime-runner/secret-input.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isClosing, type Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';
import type { Sharing, Viewer } from '../../core/index.js';
import { runtimeHouseDestination, type HouseDestination } from '../runtime/role.js';
import { grantId } from './grant-id.js';
import { secretName } from './input.js';
import { readSecretPolicy, requestDecision } from './policy.js';
import type { Grant } from './role.js';

interface Ticket {
  id: string; name: string; grant_id: string; grant_record: string; policy: string;
  destination: string; expires_at: number;
  state: 'admitted' | 'claimed' | 'released' | 'uncertain' | 'revoked';
}
const failed = () => new Error('Secret handoff unavailable');
const identity = (d: SecretInputBinding) => JSON.stringify({agent:d.agent, job:d.job, runner:d.runner,
  box:d.box, claimedAt:d.claimedAt, ...(d.service === undefined ? {} : {service:d.service})});
const effect = (id: string) => `secrets:handoff:${id}`;

/** One role owns the original proof closures. Restart loses those closures and
 * therefore cannot resume admitted or claimed tickets. Durable rows prevent
 * replay; no pending sink or caller-selected transport is reconstructed from DB.
 * Invoke claim only from the authenticated holder authority, never a public door.
 */
export function secretTickets(app: Foundation, sharing: () => Sharing, effects: OutsideEffects) {
  const proofs = new Map<string, HouseDestination>();
  const pending = new Map<string, string>();
  // Bounded non-expiring tombstones: this unactivated role fails closed after
  // 1024 bound admissions in one lifetime rather than permitting request reuse.
  const usedPending = new Set<string>();
  const read = (id: string) => app.db.prepare('SELECT * FROM secrets_tickets WHERE id=?').get(id) as Ticket | undefined;
  const policy = () => (app.db.prepare("SELECT value FROM secrets_meta WHERE key='policy'").get() as {value:string}|undefined)?.value ?? '';
  function valid(t: Ticket, d: HouseDestination, state: Ticket['state']) {
    if (isClosing(app) || t.state !== state || app.operations.clock.now() >= t.expires_at
      || identity(d) !== t.destination || !d.current() || policy() !== t.policy
      || requestDecision(readSecretPolicy(app.db), d.agent, t.name).level === 'never'
      || !app.db.prepare('SELECT id FROM secrets_names WHERE id=?').get(t.name)) return false;
    const row = app.db.prepare('SELECT record FROM secrets_grants WHERE id=?').get(t.grant_id) as {record:string}|undefined;
    return row?.record === t.grant_record;
  }
  return {
    /** No operation input may supply agent, grant, job, runner, box or service. */
    admit(viewer: Viewer, name: string, request?: Readonly<{id:string; binding:SecretInputBinding}>): {id:string; expiresAt:number} {
      try {
        if (app.db.inTransaction || isClosing(app) || !secretName.safeParse(name).success) throw failed();
        for (const [id, d] of proofs) {
          const t = read(id);
          if (!t || !['admitted','claimed'].includes(t.state) || !valid(t,d,t.state)) proofs.delete(id);
        }
        if (proofs.size >= 1024 || usedPending.size >= 1024) throw failed();
        const d = runtimeHouseDestination(app,sharing,viewer);
        if (!d) throw failed();
        // Trusted composition only: this is not operation input. Snapshot the
        // original worker identity before admission; never rebind a ticket.
        const pendingId = request === undefined ? undefined : z.uuid().parse(request.id);
        if (request && (usedPending.has(pendingId!) || identity(d) !== identity(secretInputBindingSchema.parse(request.binding)))) throw failed();
        const now = app.operations.clock.now(), scope = {house:d.job, ...(d.service === undefined ? {} : {service:d.service})};
        const resource = {kind:'secret' as const,target:name};
        const candidates = [grantId(d.agent,resource),grantId(d.agent,resource,scope)];
        const chosen = candidates.flatMap(id => {
          const row = app.db.prepare('SELECT record FROM secrets_grants WHERE id=?').get(id) as {record:string}|undefined;
          if (!row) return [];
          const g = JSON.parse(row.record) as Grant;
          return g.id === id && g.agent === d.agent && g.kind === 'secret' && g.target === name && !g.movedTo
            && (g.expiresAt === undefined || g.expiresAt > now)
            && (!g.scope || g.scope.house === scope.house && g.scope.service === scope.service) ? [{id,record:row.record,grant:g}] : [];
        })[0];
        if (!chosen) throw failed();
        const t: Ticket = {id:randomUUID(),name,grant_id:chosen.id,grant_record:chosen.record,policy:policy(),destination:identity(d),
          expires_at:Math.min(now+30_000,chosen.grant.expiresAt ?? Infinity),state:'admitted'};
        app.db.transaction(() => {
          if (!valid(t,d,'admitted')) throw failed();
          app.db.prepare('INSERT INTO secrets_tickets VALUES (?,?,?,?,?,?,?,?)')
            .run(t.id,t.name,t.grant_id,t.grant_record,t.policy,t.destination,t.expires_at,t.state);
        })();
        proofs.set(t.id,d);
        if (pendingId) {pending.set(t.id,pendingId);usedPending.add(pendingId);}
        return {id:t.id,expiresAt:t.expires_at};
      } catch { throw failed(); }
    },
    claim(id: string) {
      try {
        if (app.db.inTransaction || !z.uuid().safeParse(id).success) return null;
        const d = proofs.get(id), t = read(id);
        if (!d || !t || !valid(t,d,'admitted')) return null;
        // Gate outside IO first. A crash between this gate and the durable claim
        // burns the effect; it cannot make the ticket reusable.
        if (!effects.beforeOutside({id:effect(id),kind:'secret-read',title:'Deliver secret through key holder'})) return null;
        app.db.transaction(() => {
          const fresh = read(id);
          if (!fresh || !valid(fresh,d,'admitted') || app.db.prepare("UPDATE secrets_tickets SET state='claimed' WHERE id=? AND state='admitted'").run(id).changes !== 1) throw failed();
        })();
        let settled = false;
        return Object.freeze({name:t.name, destination:d, ...(pending.has(id)?{pendingId:pending.get(id)!}:{}),
          current() {
            try {
              const fresh = read(id);
              return !settled && !!fresh && valid(fresh,d,'claimed') && effects.status(effect(id)) === 'started';
            } catch { return false; }
          },
          /** Invoke only after authenticated worker acknowledgement. Missing or
           * failed acknowledgement is uncertain, never permission to retry. */
          finish(acknowledged: boolean) {
            if (app.db.inTransaction) throw failed();
            if (settled) return;
            settled = true; proofs.delete(id); pending.delete(id);
            try {
              const fresh = read(id);
              const certain = acknowledged === true && !!fresh && valid(fresh,d,'claimed')
                && effects.status(effect(id)) === 'started';
              app.db.prepare("UPDATE secrets_tickets SET state=? WHERE id=? AND state='claimed'")
                .run(certain ? 'released' : 'uncertain',id);
              effects.finish(effect(id),certain);
            } catch { throw failed(); }
          },
        });
      } catch { return null; }
    },
  };
}
