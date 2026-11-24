/** Work command installation. A current household owner answers permission cards
 * (workAnswersAllowed); there is no narrower rule per card or per change, because an
 * owner already sees every change. What is checked beyond that is that the card and
 * the change it names still exist; the exact head is checked when the answer runs. */
import { SHA256_HEX } from './core/sha256-hex.js';
import { evidenceCandidates, ownerWord, type EvidenceSources } from './approval-owner-word.js';
import { alwaysAsks } from './shared-household-proposals.js';
import { COMMIT, parseMergeTarget } from './apps/merge-target.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { workAnswersAllowed } from './shared-work-access.js';
import type { DataDatabase } from './core/data/database.js';
import { approvals, changes, conversations } from './core/data/schema.js';
import { type Operations, type Context, OperationError } from './core/operations/index.js';
import type { approvalService, Approval } from './apps/approvals.js';
import { changeAnswers } from './apps/changes-answers.js';
import { readsRepository, type ChangeRow } from './apps/changes.js';

const id = z.string().trim().min(1);
export function registerSharedWorkCommands(operations: Operations, db: DataDatabase,
  service: ReturnType<typeof approvalService>, sources: EvidenceSources) {
  const approval = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).get();
  const change = (id: string) => db.select().from(changes).where(eq(changes.id, id)).get();
  const answers = changeAnswers(db, service);
  const mergeTarget = (row: Approval) => {
    if (row.kind !== 'merge') return;
    const target = parseMergeTarget(row.target);
    if (!target) throw new OperationError('conflict', 'The merge request changed. Open it again.');
    // For a repository loom does not read there is no change to hold the card to: it is answered on its words.
    return readsRepository(db, target.repository) ? { id: target.change, head: target.head } : undefined;
  };
  const currentHead = (input: { id: string; head: string }) => {
    if (change(input.id)?.headCommit !== input.head) throw new OperationError('conflict', 'The change head moved. Open it again.');
  };
  const answerMerge = (ctx: Context, member: string, input: { id: string; head: string; approval: string; allow: boolean; basis?: string; reason?: string }) => {
    // A no is always possible. When the pull request has moved on, closed or gone,
    // there is nothing left to compare the card with: deny the card itself.
    const row = change(input.id);
    if (!input.allow && (!row || row.state !== 'open' || row.headCommit !== input.head)) {
      try { service.deny(input.approval, member, input.basis, input.reason); }
      catch (error) { if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message)) throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.'); throw error; }
      ctx.changed('approvals', input.approval); if (row) ctx.changed('changes', input.id);
      return;
    }
    currentHead(input);
    try { answers.answer({ change: input.id, head: input.head, approval: input.approval, member, allow: input.allow, basis: input.basis, reason: input.reason }); }
    catch (error) {
      if (error instanceof Error && ['Change is no longer open', 'Change head has changed', 'Approval does not match this change', 'Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
        throw new OperationError('conflict', 'The merge request changed. Open it again.');
      throw error;
    }
    // DataWrites publishes all audit/Inbox effects in this same transaction.
    ctx.changed('approvals', input.approval); ctx.changed('changes', input.id);
  };
  function resolveEvidence(viewer: Context['viewer'], word: z.infer<typeof ownerWord> | undefined, prepared: unknown) {
    const candidates = evidenceCandidates(db, sources, viewer, word);
    const terminal = word && 'venue' in word;
    let unreadable = false;
    const matches = candidates.filter(candidate => {
      if (!candidate.sealed) return !terminal;
      const opened = prepared instanceof Map && prepared.get(candidate.item);
      if (!opened || opened.thread !== candidate.thread || opened.seq !== candidate.seq || !candidate.sealed.equals(opened.sealed)) {
        if (!terminal) throw new OperationError('conflict','The message changed. Read it again.');
        unreadable = true;
        return false;
      }
      if (opened.matches === null) unreadable = true;
      return opened.matches;
    });
    // The agent answering at the owner's terminal has no unverified form: the words are there, readable, or
    // the answer is refused. Where they appear more than once, the newest message is the one (candidates
    // come newest first).
    if (terminal && candidates.every(candidate => candidate.verifiedOnly)) {
      if (!matches.length) throw new OperationError('denied', unreadable ? 'What the owner said at this terminal cannot be read now.' : 'Those words do not appear in what the owner said at this terminal.');
      return matches[0];
    }
    if (terminal && (unreadable || matches.length !== 1)) return candidates.find(candidate => !candidate.sealed)!;
    if (!matches.length) throw new OperationError('denied','Those words do not appear in that message.');
    if (matches.length > 1) throw new OperationError('denied','Those words appear in more than one message. Quote a longer passage.');
    return matches[0];
  }
  const decisionBasis = (answer: 'allow' | 'deny', basis: string | undefined) =>
    basis && (answer === 'allow' ? 'Allowed by ' : 'Denied by ') + basis;
  operations.register({ name: 'approvals.answer', write: true, recheckPolicy: true,
    input: z.object({ id, answer: z.enum(['allow', 'deny']), reason: z.string().refine(value => value.trim().length > 0 && value.trim().length <= 2000).optional(), confirm: z.literal(true).optional(), review: z.string().regex(SHA256_HEX).optional(), onWord: ownerWord.optional() }).strict()
      .transform(input => input.reason && !(input.onWord && 'item' in input.onWord)
        ? { ...input, reason: input.reason.trim() } : input), output: z.object({ id }).strict(),
    may(viewer, input) {
      const row = approval(input.id);
      if (!workAnswersAllowed(db, viewer) && !sources.bodyJob(viewer) && !(viewer.kind === 'agent' && viewer.atTerminalOf !== undefined && sources.terminal?.(viewer))) return false;
      const proofs = evidenceCandidates(db, sources, viewer, input.onWord);
      if (!row) return false;
      if (input.reason) {
        if (input.answer !== 'deny') return false;
        const word = input.onWord;
        if (!word) {
          if (viewer.kind !== 'member' || sources.isProgram(viewer)) return false;
        } else {
          if ('venue' in word) {
            if (viewer.kind !== 'agent' || word.quote !== input.reason) return false;
          } else {
            // Only return the owner's quoted reason to the private Comms thread that supplied it.
            const job = sources.bodyJob(viewer)?.job, proof = proofs[0];
            if (word.quote !== input.reason || !word.item || !proof?.sealed || !job?.conversation || row.conversation !== job.conversation ||
                row.agent !== job.agent || row.member !== proof.member) return false;
            const cv = db.select().from(conversations).where(eq(conversations.id, job.conversation)).get();
            if (cv?.venue !== 'loom' || cv.place !== proof.thread || cv.agent !== job.agent || cv.member !== proof.member) return false;
          }
        }
      }
      if (input.review && (viewer.kind !== 'member' || sources.isProgram(viewer) || input.onWord || input.answer !== 'allow' || row.operation !== 'household.change' || !workAnswersAllowed(db, viewer))) return false;
      const merge = mergeTarget(row);
      // A yes to a merge needs its change to still be here; a no is always possible.
      return !merge || input.answer === 'deny' || !!change(merge.id);
    },
    async prepare(input, {viewer}) {
      const opened = new Map<string, { sealed: Buffer; thread: string; seq: number; matches: boolean | null }>();
      for (const proof of evidenceCandidates(db, sources, viewer, input.onWord)) {
        if (!proof.sealed) continue;
        const terminal = input.onWord && 'venue' in input.onWord;
        const read = sources.words?.(proof.thread, proof.seq);
        const words = await (terminal ? read?.catch(() => null) : read);
        if (words == null && !terminal) throw new OperationError('denied','Those words do not appear in that message.');
        if (input.reason && !terminal && words) {
          // Check the whole message: the quoted reason may omit the card ID the owner named.
          const namedCards = words.match(/\ba-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi) ?? [];
          if (namedCards.some(card => card.toLowerCase() !== input.id))
            throw new OperationError('denied', 'That message names a different approval card.');
        }
        opened.set(proof.item, { sealed: proof.sealed, thread: proof.thread, seq: proof.seq, matches: words == null ? null : !!input.onWord && words.includes(input.onWord.quote) });
      }
      return opened;
    },
    prepareReplay: input => !!input.onWord && ('venue' in input.onWord || input.onWord.item === undefined),
    validateReplay(viewer, input, prepared) {
      if (prepared instanceof Map && input.onWord && ('venue' in input.onWord || input.onWord.item === undefined)) {
        const proof = resolveEvidence(viewer, input.onWord, prepared);
        const basis = decisionBasis(input.answer, proof.basis);
        if (!service.record(input.id).some(event => event.event === input.answer && event.note === basis))
          throw new OperationError('conflict','The message changed. Read it again.');
      }
      const row = approval(input.id);
      if (!row) throw new OperationError('conflict', 'The approval changed. Open it again.');
      const merge = mergeTarget(row); if (merge && input.answer !== 'deny') currentHead(merge);
    },
    run(ctx, input, prepared) {
      const proof = resolveEvidence(ctx.viewer, input.onWord, prepared);
      const basis = decisionBasis(input.answer, proof.basis);
      const row = approval(input.id);
      if (!row) throw new OperationError('conflict', 'The approval changed. Open it again.');
      // A dangerous action cannot be put back, so allowing one takes a second, explicit yes.
      // The agent at the owner's terminal does not allow what cannot be put back: that yes is the owner's own hand.
      if (row.kind === 'dangerous' && input.answer === 'allow' && proof.verifiedOnly)
        throw new OperationError('denied', 'This cannot be undone. Its owner allows it themselves.');
      if (row.kind === 'dangerous' && input.answer === 'allow' && input.confirm !== true && !basis)
        throw new OperationError('invalid', 'This cannot be undone. To allow it, answer again with confirm set to true.');
      const merge = mergeTarget(row);
      if (merge) answerMerge(ctx, proof.member, { basis, reason: input.reason, ...merge, approval: row.id, allow: input.answer === 'allow' });
      else {
        try { input.answer === 'allow' ? service.allow(input.id, proof.member, basis, input.review) : service.deny(input.id, proof.member, basis, input.reason); }
        catch (error) {
          if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
            throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.');
          throw error;
        }
        ctx.changed('approvals', input.id);
      }
      if (basis && proof.through) {
        const loud = row.kind === 'dangerous' || (row.operation === 'household.change' && alwaysAsks.has(JSON.parse(row.details).change));
        // An answer the agent gave at the owner's terminal is always told in full: the owner sees, at once,
        // everything answered in their name there.
        service.tellAnswer(row, proof.member, proof.through, input.answer, basis, loud || !!proof.verifiedOnly);
      }
      return { id: input.id };
    },
  });
  operations.register({ name: 'changes.answer', write: true, recheckPolicy: true,
    input: z.object({ id, head: z.string().regex(COMMIT), approval: id, answer: z.enum(['yes', 'no']) }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) {
      const request = approval(input.approval);
      return workAnswersAllowed(db, viewer) && !!request && !!change(input.id);
    },
    validateReplay(_viewer, input) { currentHead(input); },
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
      answerMerge(ctx, ctx.viewer.id, { ...input, allow: input.answer === 'yes' });
      return { id: input.id };
    },
  });
}
