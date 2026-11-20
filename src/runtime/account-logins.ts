/** What loom last learned about each sign-in of a model account (`model_account_logins`), and the one
 * inbox item its owner gets when a sign-in is gone or about to end. No model takes part, and no credential
 * is read or kept here: a worker says what its own machine's files say, and a job that got a model reply
 * says the sign-in it ran under still works.
 *
 * A sign-in is one account, on one machine, for one harness, in one place. The place is where the token
 * lives on that machine (`containers`: the directory houses mount; `host`: the machine user's own). Tokens
 * are not copied between places, so two places are two sign-ins that end separately.
 *
 * This is the one writer of the table. Usage stays on the account (`model_accounts`); nothing here changes it.
 *
 * A machine that has stopped reporting raises nothing here. Its sign-ins keep what was last learned, and
 * the machine being away is its own notice (Machines.sweep) for the machines marked always on. */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxes, inbox, modelAccountBoxes, modelAccountLogins, modelAccounts } from '../core/data/schema.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import { SILENCE_MS } from './silence.js';
import { DAY_MS } from '../core/day.js';
import type { LoginReason } from './account-login-check.js';

type Login = typeof modelAccountLogins.$inferSelect;
export const LOGIN_PLACES = ['containers', 'host'] as const satisfies readonly Login['place'][];
/** How long before a sign-in ends its owner is told. */
export const LOGIN_ENDING_MS = 3 * DAY_MS;
/** What a worker read on its own machine about one sign-in. `unknown` is a sign-in it watches and could not
 * read this time: what was last learned about it stays as it is. */
export interface LoginCheck { account: string; harness: string; place: Login['place']; state: Login['state'] | 'unknown'; expiresAt?: string | null; why?: LoginReason | null }
/** The only reasons a sign-in is recorded as gone, as the sentence its owner reads. A worker sends the word, never the sentence. */
const REASONS: Record<LoginReason, string> = { 'no-file': 'There is no sign-in file.', 'no-sign-in': 'The sign-in file holds no sign-in.', ended: 'The sign-in has ended.' };

/** The last instant of the year 9999: the latest time the household database keeps. */
const LAST_MS = 253_402_300_799_999;
export function loginMachineReporting(lastSeenAt:string|null,now:number,silenceMs=SILENCE_MS){
  const silence=now-Date.parse(lastSeenAt??'');
  return Number.isFinite(silence)&&silence>=0&&silence<=silenceMs;
}
type Key = Pick<Login, 'account' | 'box' | 'harness' | 'place'>;
// One notice per time a sign-in is found gone, and one per end date: a notice already closed under an id is
// never sent again (Conversations.send), so each id names the occasion and not only the sign-in.
const goneId = (row: Login) => `login-gone:${JSON.stringify([row.account, row.box, row.harness, row.place, row.since])}`;
// The end date alone would not do for the second: a sign-in found gone and then back with the same end has
// had that notice closed, and its owner is owed it again.
const endingId = (row: Login) => `login-ending:${JSON.stringify([row.account, row.box, row.harness, row.place, row.expiresAt, row.since])}`;
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
    if (before.expiresAt !== null && (!after || after.expiresAt !== before.expiresAt || after.state !== 'signed-in' || after.since !== before.since))
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

  /** Everything a worker watches on its machine, whole: a sign-in it no longer names is no longer watched,
   * and one it names as unknown is left as it was. A sign-in of an account that is not enabled on that machine is not recorded. Returns
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
        if (check.state === 'unknown') continue;
        const key = { account: check.account, box, harness: check.harness, place: check.place };
        const before = this.db.select().from(modelAccountLogins).where(where(key)).get();
        // A time written with an offset can land outside the years the database keeps: then there is no known end.
        const ends = check.state === 'signed-in' && check.expiresAt != null ? Date.parse(check.expiresAt) : NaN;
        const expiresAt = Number.isFinite(ends) && ends >= 0 && ends <= LAST_MS ? new Date(ends).toISOString() : null;
        const after = this.write(key, { state: check.state, expiresAt, learnedFrom: 'check', why: check.state === 'signed-out' && check.why ? REASONS[check.why] : null }, at);
        if (!before || before.state !== after.state || before.expiresAt !== after.expiresAt || before.why !== after.why) changed.add(check.account);
      }
      for (const row of this.db.select().from(modelAccountLogins).where(eq(modelAccountLogins.box, box)).all()) {
        if (seen.has(name(row))) continue;
        this.drop([row], at); changed.add(row.account);
      }
      return [...changed];
    }, { behavior: 'immediate' });
  }

  /** A job that ran in a house under this account got a reply from the model, so that sign-in worked then:
   * the one evidence that a provider still honours it, which the files cannot give. It refreshes a sign-in
   * the machine's worker watches and adds none of its own, so that what the worker names stays the whole
   * record of its machine. It says nothing about when the sign-in ends: what a check read stays. */
  replied(job: { account: string | null; box: string | null; harness: string | null }): boolean {
    if (!job.account || !job.box || !job.harness) return false;
    const key = { account: job.account, box: job.box, harness: job.harness, place: 'containers' as const }, at = this.at();
    return this.db.transaction(() => {
      const before = this.db.select().from(modelAccountLogins).where(where(key)).get();
      // A check after the job started may already have read the files as signed out; the reply is older than that.
      if (!before || before.state === 'signed-out') return false;
      this.write(key, { state: 'signed-in', expiresAt: before.expiresAt, learnedFrom: 'job', why: null }, at);
      return true;
    }, { behavior: 'immediate' });
  }

  private drop(rows: readonly Login[], at: string): boolean {
    for (const row of rows) { this.db.delete(modelAccountLogins).where(where(row)).run(); this.settle(row, undefined, at); }
    return rows.length > 0;
  }

  /** The account is no longer enabled on the machine: its sign-ins there are no longer watched. Says whether there were any. */
  forget(account: string, box: string): boolean {
    const at = this.at();
    return this.db.transaction(() => this.drop(this.db.select().from(modelAccountLogins).where(and(eq(modelAccountLogins.account, account), eq(modelAccountLogins.box, box))).all(), at),
      { behavior: 'immediate' });
  }

  /** One private notice to the account's owner per sign-in found gone, and one per end date coming up, on
   * machines that are reporting. They close when the sign-in is good again (write, above). */
  sweep(silenceMs = SILENCE_MS, endingMs = LOGIN_ENDING_MS): typeof inbox.$inferSelect[] {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new Error('Invalid silence interval');
    const at = this.at(), now = Date.parse(at);
    return this.db.transaction(() => {
      const notices = new Conversations(this.db, () => at, lateMailWaits);
      // A machine taken out of the household reports no more, so nothing else would close what was said about it.
      this.drop(this.db.select({ login: modelAccountLogins }).from(modelAccountLogins).innerJoin(boxes, eq(boxes.id, modelAccountLogins.box))
        .where(isNotNull(boxes.revokedAt)).all().map(row => row.login), at);
      const rows = this.db.select({ login: modelAccountLogins, box: boxes, account: modelAccounts }).from(modelAccountLogins)
        .innerJoin(boxes, eq(boxes.id, modelAccountLogins.box)).innerJoin(modelAccounts, eq(modelAccounts.id, modelAccountLogins.account))
        .where(isNull(boxes.revokedAt)).all()
        .filter(({ box }) => loginMachineReporting(box.lastSeenAt,now,silenceMs));
      const send = (row: typeof rows[number], sourceId: string, words: string) => notices.send({ toKind: 'person', to: row.account.owner, member: row.account.owner,
        source: 'notice', sourceId, fromKind: 'unknown', words, refs: [row.box.id] });
      return rows.flatMap(row => {
        const { login, box, account } = row;
        if (login.state === 'signed-out')
          return [send(row, goneId(login), `${account.label} is signed out on ${box.name} (${placeWords(login)}).${login.why ? ` ${login.why}` : ''}`)];
        const left = login.expiresAt === null ? Infinity : Date.parse(login.expiresAt) - now;
        if (left > endingMs) return [];
        const days = Math.floor(left / DAY_MS);
        const when = left <= 0 ? 'has ended' : days < 1 ? 'ends within a day' : `ends in ${days} day${days === 1 ? '' : 's'}`;
        return [send(row, endingId(login), `The ${account.label} sign-in on ${box.name} (${placeWords(login)}) ${when}, on ${login.expiresAt!.slice(0, 10)}.`)];
      });
    }, { behavior: 'immediate' });
  }
}
