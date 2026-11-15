/** Tempo authority at the outside door. Services themselves remain trusted. */
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, members, memberAgents, projects, triggers, approvals, changes, inbox, jobs, secretRequests } from './core/data/schema.js';
import { taskVisibility } from './core/data/visibility.js';
import { tempoVisibility } from './core/tempo/visibility.js';
import type { TempoAccess } from './core/tempo/operations.js';

export function tempoCommandAllowed(db: DataDatabase, viewer: Viewer, access: TempoAccess): boolean {
  if (viewer.kind !== 'member' && viewer.kind !== 'agent') return false;
  const actor = viewer.kind === 'member'
    ? db.select().from(members).where(eq(members.id, viewer.id)).get()
    : db.select().from(agents).where(eq(agents.id, viewer.id)).get();
  if (!actor) return false;
  const owner = viewer.kind === 'member' && 'role' in actor && actor.role === 'owner';
  const ownsAgent = (id: string) => !!db.select().from(agents).where(eq(agents.id, id)).get() &&
    (owner || (viewer.kind === 'agent' ? viewer.id === id : !!db.select().from(memberAgents)
      .where(and(eq(memberAgents.member, viewer.id), eq(memberAgents.agent, id))).get()));
  const recipient = (kind: 'person' | 'agent', id: string) => kind === 'agent' ? ownsAgent(id) :
    !!db.select().from(members).where(eq(members.id, id)).get() && (owner || viewer.kind === 'member' && viewer.id === id);
  const sharedProject = (id: string) => !!db.select().from(projects).where(and(eq(projects.id, id), taskVisibility(viewer).projects!(getTableColumns(projects)))).get();
  const visibleItem = (id:string) => conversationQuestionPolicy(db).canReadItem(viewer,id);
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
    if (!row) return false;
    if ('member' in row && row.member) return viewer.kind === 'member' && row.member === viewer.id;
    return 'project' in row && !!row.project && sharedProject(row.project) || !!row.agent && ownsAgent(row.agent);
  };
  switch (access.action) {
    case 'volume': return recipient(access.item.toKind, access.item.to) && visibleItem(access.item.id);
    case 'settings': return recipient(access.who.kind, access.who.id) ||
      (viewer.kind === 'agent' && access.who.kind === 'person' && !!db.select().from(memberAgents)
        .where(and(eq(memberAgents.agent, viewer.id), eq(memberAgents.member, access.who.id))).get());
    case 'pause': case 'resume': return ownsAgent(access.agent);
    case 'stop': case 'runNow':
      if (access.trigger.targetKind === 'operation' && !access.trigger.toKind && access.trigger.ownerKind === 'agent' && access.trigger.owner && ownsAgent(access.trigger.owner)) return true;
      return !!db.select({ id: triggers.id }).from(triggers)
      .where(and(eq(triggers.id, access.trigger.id), tempoVisibility(viewer).triggers!(getTableColumns(triggers)))).get();
    case 'set': {
      const t = access.trigger;
      const authored = owner || (t.ownerKind === 'agent' ? !!t.owner && ownsAgent(t.owner) :
        t.ownerKind === 'member' && viewer.kind === 'member' && t.owner === viewer.id);
      if (!authored || !sourceAllowed(t.sourceKind, t.watches)) return false;
      if (t.project && !sharedProject(t.project)) return false;
      // Creating work for another recipient needs that recipient's owner, not
      // merely a shared project. Reading/stopping shared triggers follows the
      // site's project-sharing rule; starting new work binds its target too.
      return t.toKind && t.to ? recipient(t.toKind, t.to) : owner || (t.ownerKind === 'agent' && !!t.owner && ownsAgent(t.owner));
    }
  }
}
