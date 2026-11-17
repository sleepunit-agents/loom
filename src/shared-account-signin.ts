/** Signing a model account in on a worker machine, with nobody at that machine and no model running.
 *
 * Someone asks (runtime.accountSignIn). The worker on that machine picks the request up and runs the
 * provider's own sign-in there. Loom carries two things and nothing else: the page to open, which goes to the
 * account's owner as an inbox item, and, where the provider shows one, the code the owner answers with, which
 * goes back to the worker of that machine while the sign-in is open and is blanked when it ends, however it
 * ends. The code is read, never returned by a write: a write's result is kept as a retry receipt. Loom records the account as signed in on that machine
 * only when the worker reports that the provider's own program says so. No credential passes through here.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { accountSignins, boxes, inbox, memberAgents, members, modelAccountBoxes, modelAccounts, operationResults } from './core/data/schema.js';
import { Conversations } from './core/conversations/index.js';
import { inboxContentChanged } from './core/tempo/volume.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { accountObservationCommitted } from './runtime/account-completion.js';

/** A request nobody finished is over after this long: the provider's own page and code have lapsed by then. */
export const SIGNIN_MS = 20 * 60_000;
const name = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\0\r\n]/.test(value));
const id = z.object({ id: name }).strict();
const saved = z.object({ saved: z.literal(true) }).strict();
const open = ['asked', 'started', 'waiting'] as const;
/** What a pasted sign-in code may look like; anything else is not handed to the worker. */
export const signInCode = /^[A-Za-z0-9#_.\-/]{8,2048}$/;

export function registerSharedAccountSignIn(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{ box: string }> | undefined) {
  const account = (key: string) => db.select().from(modelAccounts).where(eq(modelAccounts.id, key)).get();
  const request = (key: string) => db.select().from(accountSignins).where(eq(accountSignins.id, key)).get();
  // A member may ask for an account they may act on, on a machine they may act on: the rule for recording a
  // sign-in. An agent may ask on behalf of a member who owns it and could ask. Asking finishes nothing: the
  // account's owner still has to open the page and sign in themselves.
  const memberMay = (member: string, input: { account: string; box: string }) => {
    const row = account(input.account), viewer: Viewer = { kind: 'member', id: member };
    if (!row || !mayAct(viewer, { type: 'runtime.model-account', member: row.owner }, sharedSharing(db))) return false;
    const box = db.select().from(boxes).where(and(eq(boxes.id, input.box), isNull(boxes.revokedAt))).get();
    return !!box && mayAct(viewer, { type: 'runtime.box', member: box.owner }, sharedSharing(db));
  };
  // Who an agent may ask for: the members who own it, and every full owner, who owns every agent.
  const owners = (agent: string) => [...new Set([...db.select().from(memberAgents).where(eq(memberAgents.agent, agent)).all().map(row => row.member),
    ...db.select({ id: members.id }).from(members).where(and(eq(members.fullOwner, true), isNull(members.removedAt))).all().map(row => row.id)])];
  const mayAsk = (viewer: Viewer, input: { account: string; box: string }) => viewer.kind === 'member' ? memberMay(viewer.id, input)
    : viewer.kind === 'agent' && owners(viewer.id).some(member => memberMay(member, input));
  const machine = (viewer: Viewer) => {
    if (viewer.kind !== 'runner' || runner(viewer)?.box !== viewer.id) return false;
    const row = db.select({ revokedAt: boxes.revokedAt }).from(boxes).where(eq(boxes.id, viewer.id)).get();
    return !!row && row.revokedAt === null;
  };
  const mine = (viewer: Viewer, key: string) => machine(viewer) && request(key)?.box === viewer.id;
  const lapsed = (row: typeof accountSignins.$inferSelect, at: string) => Date.parse(at) - Date.parse(row.askedAt) > SIGNIN_MS;
  const resolveItem = (item: string | null, resolution: string, at: string) => {
    if (!item) return;
    const done = db.update(inbox).set({ state: 'resolved', resolution, changedAt: at }).where(and(eq(inbox.id, item), eq(inbox.state, 'waiting'))).returning().all();
    for (const row of done) inboxContentChanged(db, { kind: row.toKind, id: row.to }, row.id);
  };
  /** The pasted code the owner answered with, while the request still waits for it. */
  const pasted = (row: typeof accountSignins.$inferSelect) => {
    const answer = row.item ? db.select().from(inbox).where(eq(inbox.id, row.item)).get() : undefined;
    return answer?.state === 'answered' && answer.answer === 'words' && answer.answerText && answer.answerText !== USED ? answer.answerText.trim() : undefined;
  };
  const end = (row: typeof accountSignins.$inferSelect, state: 'done' | 'failed', why: string | null, at: string) => {
    db.update(accountSignins).set({ state, why, changedAt: at }).where(eq(accountSignins.id, row.id)).run();
    // The pasted code has no use once the sign-in is over, whether or not the worker ever collected it.
    if (row.item) db.update(inbox).set({ answerText: USED, changedAt: at }).where(and(eq(inbox.id, row.item), isNotNull(inbox.answerText), ne(inbox.answerText, USED))).run();
    resolveItem(row.item, state === 'done' ? 'Signed in' : why ?? 'The sign-in did not finish', at);
  };
  /** Close every open request that has run out of time. Called at start and before a worker or a person
   * is given one; nothing here runs on a timer, so a request is closed at the next of those. */
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
  // A read, so no retry receipt holds the code. Asking again while the sign-in waits gives the same answer:
  // a worker that lost the reply is not left holding a page open for a code that is gone.
  operations.register({ doors: [...workers.doors], name: 'runtime.signInCode', input: id,
    output: z.object({ code: z.string().nullable(), stop: z.boolean() }).strict(),
    may: (viewer, input) => mine(viewer, input.id),
    run(_ctx, input) {
      const row = request(input.id)!;
      if (row.state !== 'waiting' || lapsed(row, now())) return { code: null, stop: true };
      const code = pasted(row);
      if (code === undefined) return { code: null, stop: false };
      // Anything that does not look like a code is not handed over; the worker stops and reports.
      return signInCode.test(code) ? { code, stop: false } : { code: null, stop: true };
    } });
  operations.register({ ...workers, doors: [...workers.doors], name: 'runtime.signInDone',
    input: z.object({ id: name, signedIn: z.boolean(), why: z.string().max(300).refine(value => !/[\0\r\n]/.test(value)).optional() }).strict(), output: saved,
    may: (viewer, input) => mine(viewer, input.id),
    run(ctx, input) {
      const row = request(input.id)!, at = now();
      if (!open.includes(row.state as never)) return { saved: true as const };
      if (input.signedIn) { db.insert(modelAccountBoxes).values({ account: row.account, box: row.box }).onConflictDoNothing().run(); signedIn.add(input); ctx.changed('modelAccount', row.account); }
      const answer = pasted(row);
      end(row, input.signedIn ? 'done' : 'failed', input.signedIn ? null
        : answer !== undefined && !signInCode.test(answer) ? 'That did not look like a sign-in code' : input.why ?? 'The sign-in did not finish', at);
      ctx.changed('accountSignin', row.id); return { saved: true as const };
    },
    after(input) { if (signedIn.delete(input)) { const row = request(input.id); if (row) accountObservationCommitted(db, row.account); } } });
}
const USED = '(used)';
