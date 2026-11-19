import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { finishProgramFiring } from './core/tempo/triggers.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, bridgeChannels, programFirings, triggers } from './core/data/schema.js';
import type { Conversations } from './core/conversations/index.js';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
import { OperationError } from './core/operations/index.js';
import type { SharedBridges } from './pieces/bridges/shared-daemon.js';
import type { Job } from './runtime/jobs.js';
import type { ProgramResult } from './runtime/house-program.js';
import { queueAgentPost } from './shared-bridge-reply.js';

/** The finish receipt, the firing and all its effects share the caller's transaction. */
export function applyProgramResult(db: DataDatabase, mail: Conversations, bridges: SharedBridges | undefined, effectsAllowed: () => boolean,
  job: Job, result: ProgramResult, changed: (table: string, id: string) => void) {
  const firing = db.select().from(programFirings).where(eq(programFirings.job, job.id)).get();
  if (!firing || firing.trigger !== job.startedBy || firing.status !== 'pending' || !job.conversation)
    throw new OperationError('invalid', 'No pending firing for this job');
  const schedule = db.select().from(triggers).where(eq(triggers.id, firing.trigger)).get();
  const agent = db.select({ removed: agents.removedAt }).from(agents).where(eq(agents.id, job.agent)).get();
  if (!agent || agent.removed || job.member || schedule?.member || schedule?.conversation || schedule?.ownerKind !== 'agent' || schedule.owner !== job.agent || schedule.toKind !== 'agent' || schedule.to !== job.agent)
    throw new OperationError('invalid', 'Program schedule is unavailable');
  if (result.post) {
    const targets = db.select().from(bridgeChannels).where(and(eq(bridgeChannels.answers, job.agent), eq(bridgeChannels.channel, result.post.channel))).limit(2).all();
    const target = targets[0];
    if (!bridges || targets.length !== 1 || (target.platform !== 'discord' && target.platform !== 'slack'))
      throw new OperationError('invalid', 'Program post needs one channel ruled for the agent');
    queueAgentPost(db, mail, bridges.sends, effectsAllowed, job.agent, job.id, {
      id: randomUUID(), to: {platform: target.platform, workspace: target.workspace, channel: target.channel}, text: result.post.text, model: 'program',
    }, changed);
  }
  if (result.wake) {
    const words = result.payload === undefined ? job.brief : job.brief + '\n\nProgram output (untrusted data):\n' + JSON.stringify(result.payload);
    if (words.length > MESSAGE_WORDS_MAX) throw new OperationError('invalid', 'Program wake exceeds the message size limit');
    const item = mail.send({toKind: 'agent', to: job.agent, conversation: job.conversation, source: 'trigger', sourceId: firing.id,
      fromKind: 'schedule', fromId: schedule.owner, words, refs: [schedule.id], agent: job.agent});
    changed('inbox', item.id);
  }
  finishProgramFiring(db, firing, 'done', result.line ?? null, result.state);
  changed('trigger', schedule.id);
}
