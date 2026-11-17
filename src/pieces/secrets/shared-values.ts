/** Trusted shared-model value writes. Outside doors authenticate an owner before
 * calling this service. The holder owns values; the journal owns retry identity.
 * A positive holder receipt finishes metadata after a crash. A negative receipt
 * never proves that a write is undone, and never releases the reservation.
 */
import { createHash, createHmac, createSecretKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { members, secrets, secretChanges, secretWriteJournal, secretGrants, secretRequests, secretRules, secretRuleAgents } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import type { HolderWrite } from './holder-store.js';
import { secretName, secretDescription } from './input.js';
import { secretHasValue } from './presence.js';

const identity = z.object({ id: z.uuid(), member: z.string().min(1).max(256), name: secretName }).strict();
const setInput = identity.extend({ mode: z.enum(['add', 'replace']), description: secretDescription.optional(),
  value: z.string().refine(value => Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 65536) }).strict();
type Journal = typeof secretWriteJournal.$inferSelect;
const unavailable = () => new Error('Secret write awaits reconciliation');
const conflict = () => new Error('Secret write identity already reserved');

/** The holder's side of a value write. Each call names the write it belongs to, so a retry can be told from a new one. */
export interface RecoverableSecretMutations {
  /** Production transports drain or cancel active IO before daemon shutdown. */
  close?(): void | Promise<void>;
  set(who: HolderWrite, name: string, value: Uint8Array, mode: 'add'|'replace'): Promise<void>;
  remove(who: HolderWrite, name: string): Promise<void>;
  hasReceipt(who: HolderWrite): Promise<boolean>;
  recover(who: HolderWrite): Promise<'committed' | 'undone'>;
}

export class SecretValues {
  private readonly key;
  private closed = false;
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly db: DataDatabase, private readonly now: () => string,
    private readonly holder: RecoverableSecretMutations, fingerprintKey: Uint8Array,
    /** The root supplies its shared write boundary to publish committed changes. */
    private readonly commit: (write: () => void) => void) {
    if (!(fingerprintKey instanceof Uint8Array) || fingerprintKey.byteLength !== 32) throw Error('Invalid secret retry key');
    this.key = createSecretKey(fingerprintKey);
  }

  async set(raw: z.input<typeof setInput>): Promise<{ saved: true }> {
    const input = setInput.parse(raw);
    const hash = this.hash(JSON.stringify([input.member, input.id, input.name, input.mode, input.description ?? null, input.value]));
    const row = this.reserve(input, input.mode, hash, input.description);
    await this.perform(row, input.value);
    return { saved: true };
  }

  async remove(raw: z.input<typeof identity>): Promise<{ removed: true }> {
    const input = identity.parse(raw);
    const hash = this.hash(JSON.stringify([input.member, input.id, input.name, 'remove']));
    const row = this.reserve(input, 'remove', hash);
    await this.perform(row);
    return { removed: true };
  }

  private hash(text: string): string {
    return createHmac('sha256', this.key).update('loom-shared-secret-write-v1\0').update(text).digest('hex');
  }
  private holderIdentity(row: Journal) {
    // Never forward a caller-chosen UUID: it could name an unrelated receipt
    // already held by the key holder. Domain-separate a stable UUID from the
    // daemon-keyed full-input binding. No secret digest is sent unkeyed.
    const bytes = createHash('sha256').update('loom-shared-holder-write-v1\0').update(row.inputHash).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return { member: row.member, writeId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
  }
  private available(): void {
    if (this.closed || this.db.$client.inTransaction) throw unavailable();
  }
  private reserve(input: z.infer<typeof identity>, operation: Journal['operation'], inputHash: string, description?: string): Journal {
    this.available();
    let row!: Journal;
    this.commit(() => {
      const old = this.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id, input.id)).get();
      if (old) {
        if (old.member !== input.member || old.secret !== input.name || old.operation !== operation || old.inputHash !== inputHash) throw conflict();
        row = old; return;
      }
      if (!this.db.select().from(members).where(eq(members.id, input.member)).get()) throw Error('Unknown secret writer');
      if (this.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.state, 'prepared')).get()) throw unavailable();
      const metadata = this.db.select().from(secrets).where(eq(secrets.name, input.name)).get();
      const active = secretHasValue(this.db, input.name);
      if (operation === 'add' && active) throw Error('Secret value already exists');
      if (operation !== 'add' && (!metadata || !active)) throw Error('Unknown secret value');
      row = this.db.insert(secretWriteJournal).values({ id: input.id, member: input.member, secret: input.name,
        operation, inputHash, description: description ?? metadata?.description ?? '', state: 'prepared', startedAt: this.now() }).returning().get();
    });
    return row;
  }

  private perform(row: Journal, value?: string): Promise<void> {
    this.available();
    if (row.state === 'committed') return Promise.resolve();
    if (row.state !== 'prepared') return Promise.reject(new Error('Secret write was undone; start a new write'));
    const current = this.running.get(row.id);
    if (current) return current;
    // Publish the promise before trusted transports can synchronously reenter.
    const work = Promise.resolve().then(async () => {
      this.available();
      const who = this.holderIdentity(row);
      const found: unknown = await this.holder.hasReceipt(who);
      this.available();
      if (typeof found !== 'boolean') throw unavailable();
      if (!found) {
        let bytes: Buffer | undefined;
        try {
          const result: unknown = row.operation === 'remove' ? await this.holder.remove(who, row.secret)
            : await this.holder.set(who, row.secret, bytes = Buffer.from(value!), row.operation);
          if (result !== undefined) throw unavailable();
        } finally { bytes?.fill(0); }
      }
      this.finish(row);
    }).catch(() => { throw unavailable(); }).finally(() => { this.running.delete(row.id); });
    this.running.set(row.id, work);
    return work;
  }

  private finish(row: Journal): void {
    this.available();
    this.commit(() => {
      const current = this.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id, row.id)).get();
      if (current?.state === 'committed') return;
      if (current?.state !== 'prepared' || current.inputHash !== row.inputHash) throw conflict();
      const at = this.now();
      // Retain the named metadata row: historical changes/uses/requests refer to
      // it. The holder, not metadata presence, decides add/replace availability.
      this.db.insert(secrets).values({ name: row.secret, description: row.description, changedAt: at, changedBy: row.member })
        .onConflictDoUpdate({ target: secrets.name, set: { description: row.description, changedAt: at, changedBy: row.member } }).run();
      if (row.operation === 'remove') {
        this.db.delete(secretGrants).where(eq(secretGrants.secret, row.secret)).run();
        const requests = this.db.select().from(secretRequests).where(eq(secretRequests.secret, row.secret)).all();
        for (const request of requests) {
          if (request.state !== 'pending' && request.state !== 'allowed') continue;
          const state = request.state === 'pending' ? 'cancelled' : 'revoked';
          this.db.update(secretRequests).set({ state, answeredAt: at }).where(eq(secretRequests.id, request.id)).run();
          new Conversations(this.db, () => at).resolveSource('secret-request', request.id, state);
        }
        this.db.delete(secretRuleAgents).where(eq(secretRuleAgents.secret, row.secret)).run();
        this.db.insert(secretRules).values({ secret: row.secret, answer: 'ask', minutes: 30 })
          .onConflictDoUpdate({ target: secretRules.secret, set: { answer: 'ask' } }).run();
      }
      this.db.insert(secretChanges).values({ id: row.id, secret: row.secret,
        action: row.operation === 'remove' ? 'removed' : row.operation, by: row.member, at }).run();
      this.db.update(secretWriteJournal).set({ state: 'committed', completedAt: at }).where(eq(secretWriteJournal.id, row.id)).run();
    });
  }

  /** Positive commit evidence finishes metadata. A definitive undone result
   * first fences all delayed holder calls, so no value or retained caller input
   * is needed to release an abandoned reservation. Absence alone never does. */
  async reconcilePending(): Promise<void> {
    this.available();
    const row = this.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.state, 'prepared')).get();
    if (!row || this.running.has(row.id)) return;
    let outcome: unknown;
    try { outcome = await this.holder.recover(this.holderIdentity(row)); }
    catch { return; }
    if (this.closed) return;
    if (outcome === 'committed') { this.finish(row); return; }
    if (outcome !== 'undone') return;
    this.available();
    this.commit(() => {
      const current = this.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id, row.id)).get();
      if (current?.state !== 'prepared' || current.inputHash !== row.inputHash) return;
      this.db.update(secretWriteJournal).set({ state: 'undone', completedAt: this.now() }).where(eq(secretWriteJournal.id, row.id)).run();
    });
  }
  /** Root closes/cancels the transport before closing the shared database. */
  close(): void { this.closed = true; }
}

/** Change what a named secret is for, and nothing else about it. False when no secret has that name. */
export function describeSecret(db: DataDatabase, input: { secret: string; description: string; by: string; at: string }): boolean {
  const description = secretDescription.parse(input.description);
  return db.update(secrets).set({ description, changedAt: input.at, changedBy: input.by }).where(eq(secrets.name, input.secret)).run().changes > 0;
}
