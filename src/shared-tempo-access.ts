/** Tempo authority at the outside door. Services themselves remain trusted.
 * Every decision here is a rule from policy.ts, read for one trigger, recipient or record. */
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import { parkedSource, parkedDestination } from './core/tempo/parked.js';
import { eq } from 'drizzle-orm';
import { addressee, holds, inHousehold, maySetTrigger, mayStartTrigger, rules, tableRules, triggerAsSet, triggerWorksFor, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { triggers, approvals, changes, conversations, inbox, jobs, secretRequests } from './core/data/schema.js';
import type { TempoAccess } from './core/tempo/operations.js';
import type { NewTrigger } from './core/tempo/triggers.js';

/** `chatMember` is the door's proof that the caller is the current body of a member's chat, and names that
 * member. Only the volume command uses it: a body sets its member's volume on that member's word. */
export function tempoCommandAllowed(db: DataDatabase, viewer: Viewer, access: TempoAccess, chatMember?: (viewer: Viewer) => string | undefined): boolean {
  const sharing = sharedSharing(db);
  if (!inHousehold(viewer, sharing)) return false;
  const recipient = (kind: 'person' | 'agent', id: string) => holds(rules.recipient, viewer, { toKind: kind, to: id }, sharing);
  // Directing an agent takes the agent on the member's own list, or being that agent. The owner role alone
  // does not: a full owner has every agent on their list.
  const directs = (id: string) => recipient('agent', id);
  const visibleItem = (id:string, who: Viewer = viewer) => conversationQuestionPolicy(db).sourceAllowsItem(who,id);
  // What is watched must be a record the caller reads. Nobody is let past that: a household owner reads
  // every change, approval card and secret request by those records' own rules, and does not read a job
  // of another member's private thread, so cannot watch one to learn when it ends.
  const sourceAllowed = (kind: string, watch: string | null | undefined) => {
    if (kind === 'time') return true;
    if (!watch) return false;
    const colon = watch.indexOf(':'), prefix = watch.slice(0, colon), id = watch.slice(colon + 1);
    if (kind === 'answer' && prefix === 'question') {
      const row = db.select().from(inbox).where(eq(inbox.id, id)).get();
      return !!row && recipient(row.toKind, row.to) && visibleItem(id);
    }
    const row = kind === 'pull-request' && prefix === 'change' ? db.select().from(changes).where(eq(changes.id, id)).get()
      : kind === 'job' && prefix === 'job' ? db.select().from(jobs).where(eq(jobs.id, id)).get()
      : kind === 'answer' && prefix === 'approval' ? db.select().from(approvals).where(eq(approvals.id, id)).get()
      : kind === 'answer' && prefix === 'secret-request' ? db.select().from(secretRequests).where(eq(secretRequests.id, id)).get() : undefined;
    // A job is read by the rule of its conversation; the others by the labels they carry.
    if (!row) return false;
    if (kind === 'job') return holds(tableRules.jobs, viewer, row, sharing, (_table, parent) => db.select().from(conversations).where(eq(conversations.id, parent)).get());
    return holds(rules.labelled, viewer, { member: 'member' in row ? row.member : null, project: 'project' in row ? row.project : null, agent: row.agent }, sharing);
  };
  switch (access.action) {
    case 'volume': {
      // In the caller's own right: they may address the recipient, and the item is one they read.
      if (holds(rules.addressesRecipient, viewer, access.item, sharing) && visibleItem(access.item.id)) return true;
      // On its member's word: the volume rule says when. The member is the one on the body's credential,
      // the door must hold proof of that member's current chat, and the item must be one that member reads.
      const member = viewer.kind === 'agent' ? viewer.workingFor : undefined;
      return member !== undefined && chatMember?.(viewer) === member && holds(rules.inboxVolume, viewer, access.item, sharing)
        && visibleItem(access.item.id, addressee(member));
    }
    case 'pause': case 'resume': return directs(access.agent);
    // Setting, rewording and starting are policy.ts's ("Scheduled work"). Stopping is the read rule: whoever sees a trigger may stop it.
    case 'edit': return maySetTrigger(viewer, access.trigger, sharing);
    case 'stop': case 'start': case 'runNow': {
      const stored = db.select().from(triggers).where(eq(triggers.id, access.trigger.id)).get();
      return !!stored && holds(rules.trigger, viewer, stored, sharing) && (access.action === 'stop' || mayStartTrigger(viewer, stored, sharing));
    }
    // Judged as it will be recorded: see recordedTrigger.
    case 'set': {
      const t = triggerAsSet(viewer, access.trigger, sharing);
      const park = parkedSource(t);
      if (park) return t.sourceKind === 'answer' && t.toKind === 'agent' && !!t.to
        && sourceAllowed('answer', (park.approval ? 'approval:' : 'secret-request:') + park.id)
        && maySetTrigger(viewer, t, sharing)
        && parkedDestination(db, park, {agent:t.to, member:triggerWorksFor(t, sharing), project:t.project, conversation:t.conversation});
      return sourceAllowed(t.sourceKind, t.watches) && maySetTrigger(viewer, t, sharing);
    }
  }
}

/** A new trigger as `tempo.set` records it for this caller (policy.ts, triggerAsSet): work a member who is
 * not a household owner schedules for an agent, themselves or through their body, is recorded as theirs. */
export function recordedTrigger<T extends NewTrigger>(db: DataDatabase, viewer: Viewer, trigger: T): { trigger: T; member?: string } {
  const recorded = triggerAsSet(viewer, trigger, sharedSharing(db));
  // The member its work is for (`triggers.member`): a trigger a member owns that puts an agent to work is
  // that member's direction, whoever typed it. Stored once here; a firing reads it (shared-tempo.ts).
  return recorded.toKind === 'agent' && recorded.ownerKind === 'member' && recorded.owner ? { trigger: recorded, member: recorded.owner } : { trigger: recorded };
}
