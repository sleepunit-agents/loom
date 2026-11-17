/** Signing a model account in on a worker machine, with nobody at that machine and no model running.
 *
 * Someone asks (runtime.accountSignIn). The worker on that machine picks the request up and runs the
 * provider's own sign-in there. Loom carries two things and nothing else: the page to open, which goes to the
 * account's owner as an inbox item, and, where the provider shows one, the code the owner answers with, which
 * goes back to the worker of that machine. Loom records the account as signed in on that machine only when
 * the worker reports that the provider's own program says so. No credential passes through here.
 *
 * The code is handed over once, and the rule is kept here, not by the worker. One take gets it: a write
 * (runtime.signInTake) whose answer says only that the code was taken. Taking blanks the code in the
 * database and keeps it in this program's memory under that write's operation id. Only a caller that names
 * that id can read it (runtime.signInCode), as often as it needs to, because a reply can be lost; no other
 * take and no other reader ever gets it. A write's answer is kept as a retry receipt, which is why the code
 * itself is read and never returned by a write. Memory does not outlive the program: after a restart a
 * taken code is gone, the worker is told to stop, and the person asks again. The code is forgotten when
 * the sign-in ends, however it ends.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { liveWorker } from './shared-worker.js';
import type { DataDatabase } from './core/data/database.js';
import { accountSignins, boxes, inbox, jobs, modelAccountBoxes, modelAccounts, operationResults } from './core/data/schema.js';
import { Conversations } from './core/conversations/index.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { accountObservationCommitted } from './runtime/account-completion.js';
import { signInReason } from './runtime/account-signin-reasons.js';

/** A request nobody finished is over after this long: the provider's own page and code have lapsed by then. */
export const SIGNIN_MS = 20 * 60_000;
const name = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\0\r\n]/.test(value));
const id = z.object({ id: name }).strict();
const saved = z.object({ saved: z.literal(true) }).strict();
const open = ['asked', 'started', 'waiting'] as const;
/** What a pasted sign-in code may look like; anything else is not handed to the worker. */
export const signInCode = /^[A-Za-z0-9#_.\-/]{8,2048}$/;

/** `acting` is the door's proof that an agent's credential is bound to one piece of current work
 * (sharedCredentials.body). Without it no agent may ask. */
export function registerSharedAccountSignIn(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{ box: string }> | undefined,
  acting: (viewer: Viewer) => Readonly<{ job: string }> | undefined = () => undefined) {
  const account = (key: string) => db.select().from(modelAccounts).where(eq(modelAccounts.id, key)).get();
  const request = (key: string) => db.select().from(accountSignins).where(eq(accountSignins.id, key)).get();
  // A member may ask for an account they may act on, on a machine they may act on: the rule for recording a
  // sign-in. Asking finishes nothing: the account's owner still has to open the page and sign in themselves.
  const memberMay = (member: string, input: { account: string; box: string }) => {
    const row = account(input.account), viewer: Viewer = { kind: 'member', id: member };
    if (!row || !mayAct(viewer, { type: 'runtime.model-account', member: row.owner }, sharedSharing(db))) return false;
    const box = db.select().from(boxes).where(and(eq(boxes.id, input.box), isNull(boxes.revokedAt))).get();
    return !!box && mayAct(viewer, { type: 'runtime.box', member: box.owner }, sharedSharing(db));
  };
  // An agent asks with the authority of the one member its current work is for, and of nobody else: not of
  // its other owners, and not of the household's owners. Work that is for no member can ask for nothing.
  const workingFor = (viewer: Viewer) => {
    const work = acting(viewer);
    return work && db.select({ member: jobs.member }).from(jobs).where(and(eq(jobs.id, work.job), eq(jobs.agent, viewer.id))).get()?.member || undefined;
  };
  const mayAsk = (viewer: Viewer, input: { account: string; box: string }) => {
    if (viewer.kind === 'member') return memberMay(viewer.id, input);
    const member = viewer.kind === 'agent' ? workingFor(viewer) : undefined;
    return !!member && memberMay(member, input);
  };
  const machine = (viewer: Viewer) => !!liveWorker(db, viewer, runner(viewer));
  const mine = (viewer: Viewer, key: string) => machine(viewer) && request(key)?.box === viewer.id;
  const lapsed = (row: typeof accountSignins.$inferSelect, at: string) => Date.parse(at) - Date.parse(row.askedAt) > SIGNIN_MS;
  /** What the owner answered with: nothing yet, words still in the database, or words already taken. */
  const answered = (row: typeof accountSignins.$inferSelect): { words: string } | 'taken' | undefined => {
    const answer = row.item ? db.select().from(inbox).where(eq(inbox.id, row.item)).get() : undefined;
    if (answer?.state !== 'answered' || answer.answer !== 'words' || !answer.answerText) return undefined;
    return answer.answerText === USED ? 'taken' : { words: answer.answerText.trim() };
  };
  /** The pasted words while nobody has taken them. */
  const pasted = (row: typeof accountSignins.$inferSelect) => { const answer = answered(row); return answer && answer !== 'taken' ? answer.words : undefined; };
  /** A taken code, by request: the code and the operation id of the one write that took it. In memory only. */
  const held = new Map<string, Readonly<{ take: string; code: string }>>();
  const end = (row: typeof accountSignins.$inferSelect, state: 'done' | 'failed', why: string | null, at: string) => {
    held.delete(row.id);
    db.update(accountSignins).set({ state, why, changedAt: at }).where(eq(accountSignins.id, row.id)).run();
    // The pasted code has no use once the sign-in is over, whether or not the worker ever collected it.
    if (!row.item) return;
    const mail = new Conversations(db, () => at);
    mail.redactAnswer(row.item, USED);
    mail.resolveItem(row.item, state === 'done' ? 'Signed in' : why ?? 'The sign-in did not finish');
  };
  /** Close every open request that has run out of time. Called at start, before a worker or a person is
   * given one, and by the program's periodic sweep (the returned `expire`), so an answered code is
   * blanked within one sweep of its request running out even when no worker polls and nobody asks. */
  const sweep = (at: string) => { for (const row of db.select().from(accountSignins).where(inArray(accountSignins.state, [...open])).all()) if (lapsed(row, at)) end(row, 'failed', 'It ran out of time', at); };
  // runtime.signInCode was once a write, so its results, code included, were kept as retry receipts.
  db.transaction(() => { db.delete(operationResults).where(eq(operationResults.operation, 'runtime.signInCode')).run(); sweep(now()); });
  const signedIn = new WeakSet<object>();
  const people = { write: true, recheckPolicy: true, refuses: true, doors: ['http', 'socket'] as const };
  const workers = { write: true, recheckPolicy: true, doors: ['http'] as const };

  operations.register({ ...people, doors: [...people.doors], name: 'runtime.accountSignIn', input: z.object({ account: name, box: name }).strict(), output: z.object({ id: z.string() }).strict(),
    may: mayAsk,
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new OperationError('denied', 'A person or an agent asks for a sign-in');
      const at = now(); sweep(at);
      const current = db.select().from(accountSignins).where(and(eq(accountSignins.account, input.account), eq(accountSignins.box, input.box), inArray(accountSignins.state, [...open]))).get();
      if (current) return { id: current.id };
      const key = 'signin-' + randomUUID();
      db.insert(accountSignins).values({ id: key, account: input.account, box: input.box, askedByKind: ctx.viewer.kind, askedBy: ctx.viewer.id, state: 'asked', askedAt: at, changedAt: at }).run();
      ctx.changed('accountSignin', key); return { id: key };
    } });
  operations.register({ doors: [...people.doors], name: 'runtime.accountSignInStatus', input: id,
    output: z.object({ state: z.enum(['asked', 'started', 'waiting', 'done', 'failed']), why: z.string().nullable(), item: z.string().nullable() }).strict(),
    may: (viewer, input) => { const row = request(input.id); return !!row && mayAsk(viewer, row); },
    run(_ctx, input) { const row = request(input.id)!, at = now(); return { state: open.includes(row.state as never) && lapsed(row, at) ? 'failed' as const : row.state, why: row.why, item: row.item }; } });

  // The worker's side. Every one is the worker of the machine the request names.
  operations.register({ ...workers, doors: [...workers.doors], name: 'runtime.signInNext', input: z.object({}).strict(),
    output: z.object({ id: z.string(), account: z.string(), owner: z.string(), provider: z.string() }).strict().nullable(),
    may: machine,
    run(ctx) {
      const at = now(); sweep(at);
      const next = db.select().from(accountSignins).where(and(eq(accountSignins.box, ctx.viewer.id), eq(accountSignins.state, 'asked'))).orderBy(asc(accountSignins.askedAt), asc(accountSignins.id)).get();
      const row = next && account(next.account);
      if (!next || !row) return null;
      db.update(accountSignins).set({ state: 'started', changedAt: at }).where(eq(accountSignins.id, next.id)).run();
      ctx.changed('accountSignin', next.id); return { id: next.id, account: row.id, owner: row.owner, provider: row.provider };
    } });
  operations.register({ ...workers, doors: [...workers.doors], name: 'runtime.signInPage',
    input: z.object({ id: name, link: z.string().max(4000).regex(/^https:\/\/[^\s]+$/), userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/).optional() }).strict(), output: saved,
    may: (viewer, input) => mine(viewer, input.id),
    run(ctx, input) {
      const row = request(input.id)!, at = now();
      if (row.state !== 'started' || lapsed(row, at)) throw new OperationError('conflict', 'This sign-in is not waiting for its page');
      const of = account(row.account)!, box = db.select({ name: boxes.name }).from(boxes).where(eq(boxes.id, row.box)).get()!;
      // A device code is for the person to read and grants nothing without the half the provider's program
      // keeps on the worker, so it stays in the item's words after the sign-in ends.
      const words = input.userCode
        ? `Sign ${of.label} in on ${box.name}. Open the page and enter the code ${input.userCode}. There is nothing to answer: this clears when the sign-in finishes.`
        : `Sign ${of.label} in on ${box.name}. Open the page, sign in, then answer with the code it shows.`;
      const item = new Conversations(db, () => at).send({ toKind: 'person', to: of.owner, member: of.owner, source: 'notice', sourceId: 'signin:' + row.id, fromKind: 'unknown',
        words, link: input.link, ...(input.userCode ? {} : { answers: 'words' as const }), refs: [row.account, row.box] });
      db.update(accountSignins).set({ state: 'waiting', item: item.id, changedAt: at }).where(eq(accountSignins.id, row.id)).run();
      ctx.changed('accountSignin', row.id); ctx.changed('inbox', item.id); return { saved: true as const };
    } });
  // The one take. Its answer says only whether this write took the code, so its receipt holds nothing, and a
  // worker that lost the reply sends the same write again and is told the same.
  operations.register({ ...workers, doors: [...workers.doors], name: 'runtime.signInTake', input: id, output: z.object({ taken: z.boolean() }).strict(),
    may: (viewer, input) => mine(viewer, input.id),
    run(ctx, input) {
      const row = request(input.id)!, prior = held.get(row.id), code = pasted(row);
      // A second write under the same id is the same take (its first try did not commit); any other is refused.
      if (row.state !== 'waiting' || lapsed(row, now()) || (prior && prior.take !== ctx.receipt!.id) || code === undefined || !signInCode.test(code)) return { taken: false };
      new Conversations(db, now).redactAnswer(row.item!, USED);
      held.set(row.id, Object.freeze({ take: ctx.receipt!.id, code }));
      ctx.changed('inbox', row.item!); return { taken: true };
    } });
  // A read, so no retry receipt holds the code. `take` is the operation id of the caller's own
  // runtime.signInTake. `answered` with no code means there is something to take.
  const stop = { code: null, stop: true, answered: false }, wait = { code: null, stop: false, answered: false };
  operations.register({ doors: [...workers.doors], name: 'runtime.signInCode', input: z.object({ id: name, take: name }).strict(),
    output: z.object({ code: z.string().nullable(), stop: z.boolean(), answered: z.boolean() }).strict(),
    may: (viewer, input) => mine(viewer, input.id),
    run(_ctx, input) {
      const row = request(input.id)!;
      if (row.state !== 'waiting' || lapsed(row, now())) return stop;
      const taken = held.get(row.id);
      if (taken) return taken.take === input.take ? { code: taken.code, stop: false, answered: true } : stop;
      const answer = answered(row);
      if (answer === undefined) return wait;
      // Taken before a restart, so gone; or not something that looks like a code, which is never handed
      // over. Either way the worker stops and reports.
      if (answer === 'taken' || !signInCode.test(answer.words)) return stop;
      return { code: null, stop: false, answered: true };
    } });
  // `why` is one of the words in SIGNIN_REASONS and loom stores its own sentence for it. Any other text, from
  // an older worker or a changed one, is taken in and dropped: it is never stored or shown.
  operations.register({ ...workers, doors: [...workers.doors], name: 'runtime.signInDone',
    input: z.object({ id: name, signedIn: z.boolean(), why: z.string().max(300).optional() }).strict(), output: saved,
    may: (viewer, input) => mine(viewer, input.id),
    run(ctx, input) {
      const row = request(input.id)!, at = now();
      if (!open.includes(row.state as never)) return { saved: true as const };
      if (input.signedIn) { db.insert(modelAccountBoxes).values({ account: row.account, box: row.box }).onConflictDoNothing().run(); signedIn.add(input); ctx.changed('modelAccount', row.account); }
      const answer = pasted(row);
      end(row, input.signedIn ? 'done' : 'failed', input.signedIn ? null
        : answer !== undefined && !signInCode.test(answer) ? 'That did not look like a sign-in code' : signInReason(input.why), at);
      ctx.changed('accountSignin', row.id); return { saved: true as const };
    },
    after(input) { if (signedIn.delete(input)) { const row = request(input.id); if (row) accountObservationCommitted(db, row.account); } } });
  return { /** For the program's periodic sweep. */ expire() { db.transaction(() => sweep(now())); } };
}
const USED = '(used)';
