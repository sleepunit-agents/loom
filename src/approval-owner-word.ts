import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { terminalSilenceMs } from './core/conversations/terminal-sessions.js';
import { ageLimit, wordsKept } from './core/conversations/retention.js';
import { commsKeepDays } from './core/data/comms-days.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, boxes, jobs, threads, terminalSessions, bridgeConnections, bridgeIncoming, bridgePeople, conversations, inbox, inboxRefs, messages } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { incomingId, parseInboxSourceId } from './pieces/bridges/keys.js';
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
  words?(thread: string, seq: number): Promise<string | null>;
};
type Evidence = { member: string; basis?: string; through?: string } & (
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
    const cutoff = new Date(Date.parse(now) - terminalSilenceMs).toISOString();
    const retained = word.quote.trim() ? db.select({row:messages, conversation:threads.conversation, machine:terminalSessions.machine})
      .from(terminalSessions).innerJoin(jobs,eq(jobs.id,terminalSessions.job))
      .innerJoin(boxes,eq(boxes.id,terminalSessions.machine))
      .innerJoin(threads,eq(threads.id,terminalSessions.thread))
      .innerJoin(conversations,eq(conversations.id,threads.conversation))
      .innerJoin(messages,and(eq(messages.thread,threads.id),eq(messages.run,terminalSessions.job)))
      .where(and(eq(terminalSessions.member,viewer.id),eq(terminalSessions.agent,agent.id),eq(boxes.owner,viewer.id),isNull(boxes.revokedAt),
        eq(conversations.member,viewer.id),eq(conversations.agent,agent.id),eq(conversations.venue,'terminal'),
        eq(jobs.state,'running'),sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`,isNull(threads.archivedAt),
        eq(messages.sender,viewer.id),eq(messages.kind,'message'),isNotNull(messages.words))).all() : [];
    const days = commsKeepDays(db);
    const candidates: Evidence[] = retained.flatMap(({row,conversation,machine}) =>
      row.words && wordsKept(row,days,now) ? [{
        member:viewer.id, through:agent.id, item:JSON.stringify([row.thread,row.seq]), sealed:row.words, thread:row.thread, seq:row.seq,
        basis:`${viewer.id} as told to ${agent.id} at the terminal: “${word.quote}” (conversation ${conversation}, turn ${row.seq}, machine ${machine})`,
      }] : []);
    return [...candidates, {
      member: viewer.id, through: agent.id,
      basis: `${viewer.id} as told to ${agent.id} at the terminal (unverified): “${word.quote}”`,
    }];
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
  const source = parseInboxSourceId(item.sourceId);
  if (!source) refused(personRequired);
  const receipts = db.select({
    event: bridgeIncoming, linkedMember: bridgePeople.member, direct: conversations.direct, privateMember: conversations.member,
  }).from(inboxRefs)
    .innerJoin(bridgeIncoming, eq(inboxRefs.ref, bridgeIncoming.id))
    .innerJoin(bridgeConnections, and(eq(bridgeConnections.id, bridgeIncoming.connection),
      eq(bridgeConnections.agent, job.agent), eq(bridgeConnections.platform, item.source), eq(bridgeConnections.workspace, source.workspace)))
    .innerJoin(bridgePeople, and(eq(bridgePeople.platform, bridgeConnections.platform),
      eq(bridgePeople.workspace, bridgeConnections.workspace), eq(bridgePeople.user, bridgeIncoming.user)))
    .innerJoin(conversations, eq(conversations.id, bridgeIncoming.conversation))
    .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, job.conversation), eq(bridgeIncoming.channel, source.channel)))
    .all().filter(({ event }) => event.id === incomingId(event.connection, source.message));
  const receipt = receipts.length === 1 && receipts[0];
  if (!receipt || receipt.linkedMember !== member || receipt.event.member !== member ||
      receipt.event.bot || receipt.event.webhook || receipt.event.state !== 'delivered') refused(personRequired);
  if (receipt.direct || receipt.privateMember !== null) {
    const deadline = ageLimit(Date.parse(receipt.event.receivedAt), commsKeepDays(db));
    if (!(deadline > Date.parse(sources.now()))) refused('The message’s words are no longer kept.');
  }
  if (!receipt.event.text.includes(quote)) refused('Those words do not appear in that message.');
  return proof;
}
