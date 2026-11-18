/** Work command installation. A current household owner answers permission cards
 * (workAnswersAllowed); there is no narrower rule per card or per change, because an
 * owner already sees every change. What is checked beyond that is that the card and
 * the change it names still exist; the exact head is checked when the answer runs. */
import { evidenceCandidates, ownerWord, type EvidenceSources } from './approval-owner-word.js';
import { alwaysAsks } from './shared-household-proposals.js';
import { COMMIT, parseMergeTarget } from './apps/merge-target.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { workAnswersAllowed } from './shared-work-access.js';
import type { DataDatabase } from './core/data/database.js';
import { approvals, changes } from './core/data/schema.js';
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
  const answerMerge = (ctx: Context, member: string, input: { id: string; head: string; approval: string; allow: boolean; basis?: string }) => {
    // A no is always possible. When the pull request has moved on, closed or gone,
    // there is nothing left to compare the card with: deny the card itself.
    const row = change(input.id);
    if (!input.allow && (!row || row.state !== 'open' || row.headCommit !== input.head)) {
      try { service.deny(input.approval, member, input.basis); }
      catch (error) { if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message)) throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.'); throw error; }
      ctx.changed('approvals', input.approval); if (row) ctx.changed('changes', input.id);
      return;
    }
    currentHead(input);
    try { answers.answer({ change: input.id, head: input.head, approval: input.approval, member, allow: input.allow, basis: input.basis }); }
    catch (error) {
      if (error instanceof Error && ['Change is no longer open', 'Change head has changed', 'Approval does not match this change', 'Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
        throw new OperationError('conflict', 'The merge request changed. Open it again.');
      throw error;
    }
    // DataWrites publishes all audit/Inbox effects in this same transaction.
    ctx.changed('approvals', input.approval); ctx.changed('changes', input.id);
  };
  function resolveEvidence(viewer: Context['viewer'], word: z.infer<typeof ownerWord> | undefined, prepared: unknown) {
    const matches = evidenceCandidates(db, sources, viewer, word).filter(candidate => {
      if (!candidate.sealed) return true;
      const opened = prepared instanceof Map && prepared.get(candidate.item);
      if (!opened || opened.thread !== candidate.thread || opened.seq !== candidate.seq || !candidate.sealed.equals(opened.sealed)) throw new OperationError('conflict','The message changed. Read it again.');
      return opened.matches;
    });
    if (!matches.length) throw new OperationError('denied','Those words do not appear in that message.');
    if (matches.length > 1) throw new OperationError('denied','Those words appear in more than one message. Quote a longer passage.');
    return matches[0];
  }
  const decisionBasis = (answer: 'allow' | 'deny', basis: string | undefined) =>
    basis && (answer === 'allow' ? 'Allowed by ' : 'Denied by ') + basis;
  operations.register({ name: 'approvals.answer', write: true, recheckPolicy: true,
    input: z.object({ id, answer: z.enum(['allow', 'deny']), confirm: z.literal(true).optional(), onWord: ownerWord.optional() }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) {
      const row = approval(input.id);
      if (!workAnswersAllowed(db, viewer) && !sources.bodyJob(viewer)) return false;
      evidenceCandidates(db, sources, viewer, input.onWord);
      if (!row) return false;
      const merge = mergeTarget(row);
      // A yes to a merge needs its change to still be here; a no is always possible.
      return !merge || input.answer === 'deny' || !!change(merge.id);
    },
    async prepare(input, {viewer}) {
      const opened = new Map<string, { sealed: Buffer; thread: string; seq: number; matches: boolean }>();
      for (const proof of evidenceCandidates(db, sources, viewer, input.onWord)) {
        if (!proof.sealed) continue;
        const words = await sources.words?.(proof.thread, proof.seq);
        if (words == null) throw new OperationError('denied','Those words do not appear in that message.');
        opened.set(proof.item, { sealed: proof.sealed, thread: proof.thread, seq: proof.seq, matches: !!input.onWord && words.includes(input.onWord.quote) });
      }
      return opened;
    },
    prepareReplay: input => !!input.onWord && !('venue' in input.onWord) && input.onWord.item === undefined,
    validateReplay(viewer, input, prepared) {
      if (prepared instanceof Map && input.onWord && !('venue' in input.onWord) && input.onWord.item === undefined) {
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
      if (row.kind === 'dangerous' && input.answer === 'allow' && input.confirm !== true && !basis)
        throw new OperationError('invalid', 'This cannot be undone. To allow it, answer again with confirm set to true.');
      const merge = mergeTarget(row);
      if (merge) answerMerge(ctx, proof.member, { basis, ...merge, approval: row.id, allow: input.answer === 'allow' });
      else {
        try { input.answer === 'allow' ? service.allow(input.id, proof.member, basis) : service.deny(input.id, proof.member, basis); }
        catch (error) {
          if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
            throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.');
          throw error;
        }
        ctx.changed('approvals', input.id);
      }
      if (basis && proof.through) {
        const loud = row.kind === 'dangerous' || (row.operation === 'household.change' && alwaysAsks.has(JSON.parse(row.details).change));
        service.tellAnswer(row, proof.member, proof.through, input.answer, basis, loud);
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
