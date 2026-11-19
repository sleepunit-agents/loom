import { and, desc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { terminalSilenceMs } from './core/conversations/terminal-sessions.js';
import { ageLimit, wordsKept } from './core/conversations/retention.js';
import { commsKeepDays } from './core/data/comms-days.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, boxes, jobs, threads, terminalSessions, conversations, inbox, messages } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { linkedBridgeReceipt } from './linked-bridge-receipt.js';
import type { Viewer } from './policy.js';
import { jobWord } from './shared-place-mail.js';
import { workAnswersAllowed } from './shared-work-access.js';

// A lone surrogate could otherwise match just half of a character in the source message.
const quote = z.string().min(1).refine(value =>
  value.length <= 1000 && !/\p{Surrogate}/u.test(value) && Array.from(value).length <= 500,
  'Quote between 1 and 500 complete Unicode characters.');
export const ownerWord = z.union([
  z.object({ item: z.string().min(1).optional(), quote }).strict(),
  z.object({ venue: z.literal('terminal'), through: z.string().min(1), quote }).strict(),
]);
type Word = z.infer<typeof ownerWord>;
type Job = { id: string; agent: string; conversation: string | null };
export type EvidenceSources = {
  now(): string;
  isProgram(viewer: Viewer): boolean;
  bodyJob(viewer: Viewer): { job: Job } | undefined;
  /** The agent's session at a member's own terminal: a machine-bound terminal credential (sharedCredentials.terminalMachine). */
  terminal?(viewer: Viewer): { agent: string; member: string; machine: string } | undefined;
  words?(thread: string, seq: number): Promise<string | null>;
};
/** The fewest letters and digits a passage an agent quotes to answer for the owner may have: enough that a
 * word in passing is not an answer. */
export const terminalQuoteMin = 12;
/** How long after the owner said something the agent may still answer on it. A session can stay open for
 * days and be opened again after it ended; what was said in it does not stay an answer for as long. */
export const terminalAnswerMs = 12 * 60 * 60 * 1000;
type Evidence = { member: string; basis?: string; through?: string; verifiedOnly?: true } & (
  | { item: string; sealed: Buffer; thread: string; seq: number }
  | { sealed?: undefined }
);

function refused(message: string): never {
  throw new OperationError('denied', message);
}

/** Read again in the write transaction. For Comms, the sealed words also bind
 * the asynchronously opened text to the message still retained at commit. */
export function evidenceCandidates(db: DataDatabase, sources: EvidenceSources, viewer: Viewer, word?: Word): Evidence[] {
  if (workAnswersAllowed(db, viewer)) {
    if (!word) return [{ member: viewer.id }];
    if (sources.isProgram(viewer)) refused('Use the owner’s own credential for a terminal answer.');
    if (!('venue' in word)) refused('A terminal answer names the agent and quotes the owner.');
    const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, word.through)).get();
    if (!agent) refused('Name an agent in this household.');
    const now = sources.now();
    const retained = word.quote.trim() ? terminalWords(db, now, { member: viewer.id, agent: agent.id }) : [];
    const candidates: Evidence[] = retained.flatMap(({row,conversation,machine}) =>
      [{
        member:viewer.id, through:agent.id, item:JSON.stringify([row.thread,row.seq]), sealed:row.words!, thread:row.thread, seq:row.seq,
        basis:`${viewer.id} as told to ${agent.id} at the terminal: “${word.quote}” (conversation ${conversation}, turn ${row.seq}, machine ${machine})`,
      }]);
    return [...candidates, {
      member: viewer.id, through: agent.id,
      basis: `${viewer.id} as told to ${agent.id} at the terminal (unverified): “${word.quote}”`,
    }];
  }

  // The agent itself, in a session at a household owner's own terminal, answers for that owner when asked
  // to there. The answer stands only on words loom has on record from that owner in a terminal session with
  // this agent on that machine that is still running, said in the last twelve hours, and there is no
  // unverified form of it. The newest message that carries the quote is the one answered on.
  //
  // This is a record, not proof that a person spoke. Those words reach loom from the hook on that machine,
  // on this same credential, so the agent could write them itself. What the rule buys is that an honest
  // agent cannot answer by mistake on words that were never said, that every such answer names the words
  // it stands on, and that the owner is told of each one at once (shared-work-commands.ts). An action
  // that cannot be undone is not answered this way at all.
  const terminal = sources.terminal?.(viewer);
  if (terminal && viewer.kind === 'agent' && viewer.id === terminal.agent) {
    const owner = { kind: 'member' as const, id: terminal.member };
    if (!workAnswersAllowed(db, owner)) refused('The person at this terminal is not a household owner.');
    if (!word || !('venue' in word) || word.through !== terminal.agent) refused('Quote what the owner said to you at this terminal.');
    if (word.quote !== word.quote.trim() || (word.quote.match(/[\p{L}\p{N}]/gu) ?? []).length < terminalQuoteMin) refused('Quote a longer passage of what the owner said.');
    const now = sources.now(), since = Date.parse(now) - terminalAnswerMs;
    const found = terminalWords(db, now, { member: terminal.member, agent: terminal.agent, machine: terminal.machine })
      .filter(({ row }) => Date.parse(row.at) > since);
    if (!found.length) refused('Those words do not appear in what the owner said at this terminal.');
    return found.map(({ row, conversation, machine }) => ({
      member: terminal.member, through: terminal.agent, verifiedOnly: true as const, item: JSON.stringify([row.thread, row.seq]), sealed: row.words!, thread: row.thread, seq: row.seq,
      basis: `${terminal.member} as told to ${terminal.agent} at the terminal: “${word.quote}” (conversation ${conversation}, turn ${row.seq}, machine ${machine})`,
    }));
  }

  const job = sources.bodyJob(viewer)?.job;
  if (!job) refused('A household owner or a job on their word is required.');
  if (jobWord(db, job).woke !== 'owners') refused('This job is not working on the owners’ word.');
  if (!word || 'venue' in word) refused('Name the owner’s message and quote their words.');
  if (word.item !== undefined) {
    const item = db.select().from(inbox).where(eq(inbox.id, word.item)).get();
    if (!item) refused('That message is outside this job.');
    return [mailEvidence(db, sources, job, item, word.quote)];
  }
  const candidates: Evidence[] = [];
  for (const item of db.select().from(inbox).where(eq(inbox.job, job.id)).all()) {
    try { candidates.push(mailEvidence(db, sources, job, item, word.quote)); }
    catch (error) { if (!(error instanceof OperationError && error.code === 'denied')) throw error; }
  }
  if (!candidates.length) refused('Those words do not appear in that message.');
  return candidates;
}

/** What a member said to an agent in terminal sessions that are still running, on their own machines (one
 * machine when named), whose words are still kept: newest first. */
function terminalWords(db: DataDatabase, now: string, who: { member: string; agent: string; machine?: string }) {
  const cutoff = new Date(Date.parse(now) - terminalSilenceMs).toISOString(), days = commsKeepDays(db);
  return db.select({row:messages, conversation:threads.conversation, machine:terminalSessions.machine})
    .from(terminalSessions).innerJoin(jobs,eq(jobs.id,terminalSessions.job))
    .innerJoin(boxes,eq(boxes.id,terminalSessions.machine))
    .innerJoin(threads,eq(threads.id,terminalSessions.thread))
    .innerJoin(conversations,eq(conversations.id,threads.conversation))
    .innerJoin(messages,and(eq(messages.thread,threads.id),eq(messages.run,terminalSessions.job)))
    .where(and(eq(jobs.conversation,threads.conversation),eq(jobs.box,terminalSessions.machine),
      eq(jobs.agent,terminalSessions.agent),eq(jobs.member,terminalSessions.member),eq(jobs.startedByKind,'terminal'),
      eq(terminalSessions.member,who.member),eq(terminalSessions.agent,who.agent),eq(boxes.owner,who.member),isNull(boxes.revokedAt),
      who.machine === undefined ? undefined : eq(terminalSessions.machine,who.machine),
      eq(conversations.member,who.member),eq(conversations.agent,who.agent),eq(conversations.venue,'terminal'),
      eq(jobs.state,'running'),sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`,
      eq(messages.sender,who.member),eq(messages.kind,'message'),isNotNull(messages.words)))
    .orderBy(sql`julianday(${messages.at}) desc`, desc(messages.seq)).all()
    .filter(({row}) => !!row.words && wordsKept(row,days,now));
}

function mailEvidence(db: DataDatabase, sources: EvidenceSources, job: Job, item: typeof inbox.$inferSelect, quote: string): Evidence {
  if (item.job !== job.id || item.toKind !== 'agent' || item.to !== job.agent ||
      !job.conversation || item.conversation !== job.conversation) {
    refused('That message is outside this job.');
  }
  const personRequired = 'Choose a message written by a person.';
  if (item.fromKind !== 'person' || !item.fromId) refused(personRequired);
  const member = item.fromId;
  if (!workAnswersAllowed(db, { kind: 'member', id: member })) refused('The writer is not a household owner.');
  const basis = `${member} through ${job.agent}, on their words: “${quote}” (conversation ${job.conversation}, message ${item.sourceId}, item ${item.id})`;
  const proof = { member, through: job.agent, basis };
  if (item.source === 'thread') {
    if (!item.thread || item.messageSeq === null || item.sourceId !== `${item.thread}:${item.messageSeq}`) refused(personRequired);
    const row = db.select().from(messages).where(and(
      eq(messages.thread, item.thread), eq(messages.seq, item.messageSeq), eq(messages.inboxItem, item.id),
    )).get();
    if (!row || row.kind !== 'message' || row.sender !== member) refused(personRequired);
    if (!row.words || !wordsKept(row, commsKeepDays(db), sources.now())) refused('The message’s words are no longer kept.');
    return { ...proof, item: item.id, sealed: row.words, thread: row.thread, seq: row.seq };
  }

  if (item.source !== 'slack' && item.source !== 'discord') refused(personRequired);
  const receipt=linkedBridgeReceipt(db,job,item);
  if (!receipt) refused(personRequired);
  if (receipt.direct || receipt.privateMember !== null) {
    const deadline = ageLimit(Date.parse(receipt.event.receivedAt), commsKeepDays(db));
    if (!(deadline > Date.parse(sources.now()))) refused('The message’s words are no longer kept.');
  }
  if (!receipt.event.text.includes(quote)) refused('Those words do not appear in that message.');
  return proof;
}
