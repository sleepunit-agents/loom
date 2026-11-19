/** What loom last learned about each sign-in of a model account (`model_account_logins`), and the one
 * inbox item its owner gets when a sign-in is gone or about to end. No model takes part, and no credential
 * is read or kept here: a worker says what its own machine's files say, and a job that got a model reply
 * says the sign-in it ran under worked.
 *
 * A sign-in is one account, on one machine, for one harness, in one place. The place is where the token
 * lives on that machine (`containers`: the directory houses mount; `host`: the machine user's own). Tokens
 * are not copied between places, so two places are two sign-ins that end separately.
 *
 * This is the one writer of the table. Usage stays on the account (`model_accounts`); nothing here changes it.
 *
 * A machine that has stopped reporting raises nothing here. Its sign-ins keep what was last learned, and
 * the machine being away is its own notice (Machines.sweep) for the machines marked always on. */
import { and, eq, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxes, inbox, modelAccountBoxes, modelAccountLogins, modelAccounts } from '../core/data/schema.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import { SILENCE_MS } from './silence.js';

type Login = typeof modelAccountLogins.$inferSelect;
export const LOGIN_PLACES = ['containers', 'host'] as const satisfies readonly Login['place'][];
/** How long before a sign-in ends its owner is told. */
export const LOGIN_ENDING_MS = 3 * 24 * 60 * 60 * 1000;
/** What a worker read on its own machine about one sign-in. */
export interface LoginCheck { account: string; harness: string; place: Login['place']; state: Login['state']; expiresAt?: string | null; why?: string | null }

type Key = Pick<Login, 'account' | 'box' | 'harness' | 'place'>;
// One notice per time a sign-in is found gone, and one per end date: a notice already closed under an id is
// never sent again (Conversations.send), so each id names the occasion and not only the sign-in.
const goneId = (row: Login) => `login-gone:${JSON.stringify([row.account, row.box, row.harness, row.place, row.since])}`;
const endingId = (row: Login) => `login-ending:${JSON.stringify([row.account, row.box, row.harness, row.place, row.expiresAt])}`;
const where = (key: Key) => and(eq(modelAccountLogins.account, key.account), eq(modelAccountLogins.box, key.box),
  eq(modelAccountLogins.harness, key.harness), eq(modelAccountLogins.place, key.place));
const placeWords = (row: Key) => row.place === 'containers' ? `${row.harness} in houses` : `${row.harness} on the machine itself`;

export class AccountLogins {
  constructor(readonly db: DataDatabase, readonly now: () => string) {}

  private at(): string {
    const at = this.now();
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid sign-in time');
    return at;
  }

  /** Close what was said about a sign-in as it was, when what is now known makes it untrue. */
  private settle(before: Login, after: Login | undefined, at: string): void {
    const notices = new Conversations(this.db, () => at, lateMailWaits);
    if (before.state === 'signed-out' && (!after || after.state === 'signed-in' || after.since !== before.since))
      notices.resolveSource('notice', goneId(before), after ? 'Signed in again' : 'No longer watched');
    if (before.expiresAt !== null && (!after || after.expiresAt !== before.expiresAt || after.state !== 'signed-in'))
      notices.resolveSource('notice', endingId(before), !after ? 'No longer watched' : after.state === 'signed-in' ? 'Signed in again' : 'Signed out');
  }

  private write(key: Key, next: Pick<Login, 'state' | 'expiresAt' | 'learnedFrom' | 'why'>, at: string): Login {
    const before = this.db.select().from(modelAccountLogins).where(where(key)).get();
    const since = before && before.state === next.state ? before.since : at;
    const values = { ...next, checkedAt: at, since };
    const after = before
      ? this.db.update(modelAccountLogins).set(values).where(where(key)).returning().get()!
      : this.db.insert(modelAccountLogins).values({ ...key, ...values }).returning().get();
    if (before) this.settle(before, after, at);
    return after;
  }

  /** Everything a worker read about the sign-ins on its machine, whole: a sign-in it no longer names is no
   * longer watched. A sign-in of an account that is not enabled on that machine is not recorded. Returns
   * the accounts whose record changed in a way a reader would see. */
  checked(box: string, checks: readonly LoginCheck[]): string[] {
    const at = this.at();
    return this.db.transaction(() => {
      const enabled = new Set(this.db.select({ account: modelAccountBoxes.account }).from(modelAccountBoxes).where(eq(modelAccountBoxes.box, box)).all().map(row => row.account));
      const seen = new Set<string>(), changed = new Set<string>();
      const name = (key: Omit<Key, 'box'>) => JSON.stringify([key.account, key.harness, key.place]);
      for (const check of checks) {
        if (!enabled.has(check.account) || seen.has(name(check))) continue;
        seen.add(name(check));
        const key = { account: check.account, box, harness: check.harness, place: check.place };
        const before = this.db.select().from(modelAccountLogins).where(where(key)).get();
        const expiresAt = check.state === 'signed-in' && check.expiresAt != null ? new Date(check.expiresAt).toISOString() : null;
        const after = this.write(key, { state: check.state, expiresAt, learnedFrom: 'check', why: check.state === 'signed-out' ? check.why ?? null : null }, at);
        if (!before || before.state !== after.state || before.expiresAt !== after.expiresAt || before.why !== after.why) changed.add(check.account);
      }
      for (const row of this.db.select().from(modelAccountLogins).where(eq(modelAccountLogins.box, box)).all()) {
        if (seen.has(name(row))) continue;
        this.db.delete(modelAccountLogins).where(where(row)).run();
        this.settle(row, undefined, at); changed.add(row.account);
      }
      return [...changed];
    }, { behavior: 'immediate' });
  }

  /** A job that ran in a house under this account got a reply from the model, so that sign-in worked then.
   * It says nothing about when the sign-in ends: what a check read stays. */
  replied(job: { account: string | null; box: string | null; harness: string | null }): boolean {
    if (!job.account || !job.box || !job.harness) return false;
    const key = { account: job.account, box: job.box, harness: job.harness, place: 'containers' as const }, at = this.at();
    return this.db.transaction(() => {
      if (!this.db.select().from(modelAccountBoxes).where(and(eq(modelAccountBoxes.account, key.account), eq(modelAccountBoxes.box, key.box))).get()) return false;
      const before = this.db.select().from(modelAccountLogins).where(where(key)).get();
      // A check after the job started may already have read the files as signed out; the reply is older than that.
      if (before && before.state === 'signed-out' && before.learnedFrom === 'check') return false;
      this.write(key, { state: 'signed-in', expiresAt: before?.expiresAt ?? null, learnedFrom: 'job', why: null }, at);
      return !before || before.state !== 'signed-in';
    }, { behavior: 'immediate' });
  }

  /** The account is no longer enabled on the machine: its sign-ins there are no longer watched. */
  forget(account: string, box: string): void {
    const at = this.at();
    for (const row of this.db.select().from(modelAccountLogins).where(and(eq(modelAccountLogins.account, account), eq(modelAccountLogins.box, box))).all()) {
      this.db.delete(modelAccountLogins).where(where(row)).run();
      this.settle(row, undefined, at);
    }
  }

  /** Whether houses on this machine cannot use the account now: placement passes such a machine over. */
  gone(account: string, box: string, harness: string): boolean {
    return this.db.select({ state: modelAccountLogins.state }).from(modelAccountLogins)
      .where(where({ account, box, harness, place: 'containers' })).get()?.state === 'signed-out';
  }

  /** One private notice to the account's owner per sign-in found gone, and one per end date coming up, on
   * machines that are reporting. They close when the sign-in is good again (write, above). */
  sweep(silenceMs = SILENCE_MS, endingMs = LOGIN_ENDING_MS): typeof inbox.$inferSelect[] {
    const at = this.at(), now = Date.parse(at);
    return this.db.transaction(() => {
      const notices = new Conversations(this.db, () => at, lateMailWaits);
      const rows = this.db.select({ login: modelAccountLogins, box: boxes, account: modelAccounts }).from(modelAccountLogins)
        .innerJoin(boxes, eq(boxes.id, modelAccountLogins.box)).innerJoin(modelAccounts, eq(modelAccounts.id, modelAccountLogins.account))
        .where(isNull(boxes.revokedAt)).all()
        .filter(({ box }) => { const silence = now - Date.parse(box.lastSeenAt ?? ''); return Number.isFinite(silence) && silence >= 0 && silence <= silenceMs; });
      const send = (row: typeof rows[number], sourceId: string, words: string) => notices.send({ toKind: 'person', to: row.account.owner, member: row.account.owner,
        source: 'notice', sourceId, fromKind: 'unknown', words, refs: [row.box.id] });
      return rows.flatMap(row => {
        const { login, box, account } = row;
        if (login.state === 'signed-out')
          return [send(row, goneId(login), `${account.label} is signed out on ${box.name} (${placeWords(login)}).${login.why ? ` ${login.why}` : ''}`)];
        const left = login.expiresAt === null ? Infinity : Date.parse(login.expiresAt) - now;
        if (left > endingMs) return [];
        const days = Math.floor(left / 86_400_000);
        const when = left <= 0 ? 'has ended' : days < 1 ? 'ends within a day' : `ends in ${days} day${days === 1 ? '' : 's'}`;
        return [send(row, endingId(login), `The ${account.label} sign-in on ${box.name} (${placeWords(login)}) ${when}, on ${login.expiresAt!.slice(0, 10)}.`)];
      });
    }, { behavior: 'immediate' });
  }
}
