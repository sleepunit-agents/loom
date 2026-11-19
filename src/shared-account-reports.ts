/** Worker observations enter through the same receipt and shared-write boundary. */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { modelAccountBoxes, modelAccounts } from './core/data/schema.js';
import { liveWorker } from './shared-worker.js';
import type { Operations, Context } from './core/operations/index.js';
import { accountCompletion, accountObservationCommitted } from './runtime/account-completion.js';
import { quotaWindows } from './runtime/account-observation.js';
import { accountUsageUnavailable } from './runtime/account-usage.js';
import { recordAccountWindows, readAccountWindows } from './runtime/account-windows.js';
import { AccountLogins, LOGIN_PLACES } from './runtime/account-logins.js';
import { LOGIN_HARNESSES, LOGIN_REASONS } from './runtime/account-login-check.js';

/** What a worker read about one sign-in on its own machine. Never a credential, and no words of the worker's
 * own: a state, an end time, a reason from a fixed list, and a harness from the list of those whose
 * sign-in a worker can read, because the harness is written into the notice its owner reads. `unknown` names a sign-in the worker watches and could not read. */
export const loginCheck = z.object({ account: z.string().min(1).max(200), harness: z.enum(LOGIN_HARNESSES), place: z.enum(LOGIN_PLACES),
  state: z.enum(['signed-in', 'signed-out', 'unknown']), expiresAt: z.iso.datetime({ offset: true }).nullish(), why: z.enum(LOGIN_REASONS).nullish() }).strict();
export function registerSharedAccountReports(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{box: string}> | undefined) {
  const identity = z.object({ account: z.string().min(1), owner: z.string().min(1), provider: z.string().min(1) }).strict();
  // Concurrency witnesses, never credentials or authority. Keep only a random
  // nonce and a digest; current machine/account permission is checked separately.
  const applied = new WeakSet<object>();
  const bases = new Map<string, { basis: string; snapshot: string; completion: object | undefined }>();
  const snapshot = (account: string) => createHash('sha256').update(JSON.stringify({
    account: db.select({ owner: modelAccounts.owner, provider: modelAccounts.provider, usage: modelAccounts.usage, usageReadAt: modelAccounts.usageReadAt, resetsAt: modelAccounts.resetsAt, hasRoom: modelAccounts.hasRoom }).from(modelAccounts).where(eq(modelAccounts.id, account)).get(),
    windows: readAccountWindows(db, account).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  })).digest('hex');
  const canReport = (viewer: Viewer, input: z.infer<typeof identity>) => {
    if (!liveWorker(db, viewer, runner(viewer))) return false;
    const account = db.select().from(modelAccounts).where(eq(modelAccounts.id, input.account)).get();
    const membership = db.select().from(modelAccountBoxes).where(and(eq(modelAccountBoxes.account, input.account), eq(modelAccountBoxes.box, viewer.id))).get();
    return !!membership && account?.owner === input.owner && account?.provider === input.provider;
  };
  const matches = (input: z.infer<typeof identity> & { basis: string }) => {
    const basis = bases.get(input.account);
    return !!basis && basis.basis === input.basis && basis.snapshot === snapshot(input.account) && basis.completion === accountCompletion(db, input.account);
  };
  const outcome = (ctx: Context, input: z.infer<typeof identity>, recorded: boolean) => {
    if (recorded) { applied.add(input); ctx.changed('modelAccount', input.account); }
    return { recorded };
  };
  const committed = (input: z.infer<typeof identity>) => {
    if (applied.delete(input)) { accountObservationCommitted(db, input.account); bases.delete(input.account); }
  };
  operations.register({ name: 'runtime.accountUsageBasis', doors: ['http'],
    input: identity, output: z.object({ basis: z.uuid() }).strict(), may: (viewer, input) => canReport(viewer, input),
    run(_ctx, input) {
      const current = snapshot(input.account), old = bases.get(input.account);
      const completion = accountCompletion(db, input.account);
      const value = old?.snapshot === current && old.completion === completion ? old : { basis: randomUUID(), snapshot: current, completion };
      bases.set(input.account, value); return { basis: value.basis };
    },
  });
  operations.register({ name: 'runtime.accountUnavailable', write: true, recheckPolicy: true, doors: ['http'],
    input: identity.extend({ basis: z.uuid() }).strict(), output: z.object({ recorded: z.boolean() }).strict(), may: (viewer, input) => canReport(viewer, input),
    run(ctx, input) {
      if (!matches(input)) return { recorded: false };
      return outcome(ctx, input, accountUsageUnavailable(db, input));
    },
    // Only after the latch and its receipt commit; rollback retains the witness.
    after(input) { committed(input); },
  });
  operations.register({ name: 'runtime.accountUsage', write: true, recheckPolicy: true, doors: ['http'],
    input: identity.extend({ windows: quotaWindows, basis: z.uuid() }).strict(),
    output: z.object({ recorded: z.boolean() }).strict(),
    may: (viewer, input) => canReport(viewer, input),
    run(ctx, input) {
      if (!matches(input)) return { recorded: false };
      return outcome(ctx, input, recordAccountWindows(db, input, input.windows, now()));
    },
    // This exact parsed input reached run and committed. Cached receipt replay
    // has a new input object and must not invalidate a newer read witness.
    // A fresh identical provider success still invalidates older failures.
    after(input) { committed(input); },
  });
  // The worker names every sign-in it watches each time, so the record of its machine is replaced whole.
  // Which machine it speaks for comes from its credential alone, and a sign-in of an account that is not
  // enabled there is left out (AccountLogins.checked), so a worker cannot write about another machine or
  // an account it was never given.
  const logins = new AccountLogins(db, now);
  operations.register({ name: 'runtime.signInState', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ logins: z.array(loginCheck).max(64) }).strict(), output: z.object({ changed: z.number().int().nonnegative() }).strict(),
    may: viewer => !!liveWorker(db, viewer, runner(viewer)),
    run(ctx, input) {
      const changed = logins.checked(liveWorker(db, ctx.viewer, runner(ctx.viewer))!, input.logins);
      for (const account of changed) ctx.changed('modelAccount', account);
      return { changed: changed.length };
    },
  });
  return { close() { bases.clear(); } };
}
