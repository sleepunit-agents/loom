/** Tempo authority at the outside door. Services themselves remain trusted.
 * Every decision here is a rule from policy.ts, read for one trigger, recipient or record. */
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import { eq } from 'drizzle-orm';
import { holds, inHousehold, isHouseholdOwner, rules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { triggers, approvals, changes, inbox, jobs, secretRequests } from './core/data/schema.js';
import type { TempoAccess } from './core/tempo/operations.js';

export function tempoCommandAllowed(db: DataDatabase, viewer: Viewer, access: TempoAccess): boolean {
  const sharing = sharedSharing(db);
  if (!inHousehold(viewer, sharing)) return false;
  const owner = isHouseholdOwner(viewer, sharing);
  const recipient = (kind: 'person' | 'agent', id: string) => holds(rules.recipient, viewer, { toKind: kind, to: id }, sharing);
  // Directing an agent takes the agent on the member's own list, or being that agent. The owner role alone
  // does not: a full owner has every agent on their list.
  const directs = (id: string) => recipient('agent', id);
  const sharedProject = (id: string) => Object.hasOwn(sharing.projects, id) && holds(rules.project, viewer, { id }, sharing);
  const visibleItem = (id:string) => conversationQuestionPolicy(db).sourceAllowsItem(viewer,id);
  const sourceAllowed = (kind: string, watch: string | null | undefined) => {
    if (kind === 'time' || owner && !(kind==='answer' && watch?.startsWith('question:'))) return true;
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
    // What is watched must be a record the caller sees, by the labels it carries.
    return !!row && holds(rules.labelled, viewer, { member: 'member' in row ? row.member : null, project: 'project' in row ? row.project : null, agent: row.agent }, sharing);
  };
  // Whoever could set this trigger for this recipient may also change its words and times.
  const maySet = (t: Extract<TempoAccess, { action: 'set' | 'edit' }>['trigger']) => {
    const authored = owner || (t.ownerKind === 'agent' ? !!t.owner && directs(t.owner) :
      t.ownerKind === 'member' && viewer.kind === 'member' && t.owner === viewer.id);
    if (!authored || t.project && !sharedProject(t.project)) return false;
    // Creating work for another recipient needs authority over that recipient, not
    // merely a shared project. Reading and stopping shared triggers follows the
    // trigger rule; starting new work binds its target too.
    return t.toKind && t.to ? recipient(t.toKind, t.to) : owner || (t.ownerKind === 'agent' && !!t.owner && directs(t.owner));
  };
  switch (access.action) {
    case 'volume': return holds(rules.inboxVolume, viewer, access.item, sharing) && visibleItem(access.item.id);
    case 'pause': case 'resume': return directs(access.agent);
    case 'edit': return maySet(access.trigger);
    case 'stop': case 'start': case 'runNow': {
      const stored = db.select().from(triggers).where(eq(triggers.id, access.trigger.id)).get();
      return !!stored && holds(rules.trigger, viewer, stored, sharing);
    }
    case 'set': return sourceAllowed(access.trigger.sourceKind, access.trigger.watches) && maySet(access.trigger);
  }
}
