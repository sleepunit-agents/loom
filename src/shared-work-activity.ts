import { and, eq, getTableColumns, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { agentPostEdit, prepareAgentPost } from './core/conversations/agent-posts.js';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { WordsKey } from './core/conversations/words.js';
import type { DataDatabase } from './core/data/database.js';
import { inbox, inboxRefs, projects, tasks, triggerAcceptances, triggers } from './core/data/schema.js';
import { taskVisibility } from './core/data/visibility.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import type { Viewer } from './policy.js';
import { TASK_ID } from './slug.js';
import { jobWord } from './shared-place-mail.js';

const canonicalTicket = new RegExp('^' + TASK_ID + '$');

export function registerWorkActivity(operations: Operations, db: DataDatabase,
  current: ReturnType<typeof conversationBodyScope>, key: WordsKey) {
  function claim(viewer: Viewer, task: string) {
    const scope = current(viewer);
    if (!scope || viewer.kind !== 'agent' || viewer.workingFor) return;
    const { job, cv } = scope;
    if (cv.venue !== 'wake' || cv.member || !cv.project || job.agent !== viewer.id || jobWord(db, job).woke !== 'own') return;
    const receipt = db.select({id: inbox.id}).from(inbox)
      .innerJoin(triggerAcceptances, eq(triggerAcceptances.item, inbox.id))
      .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id))
      .innerJoin(triggers, eq(triggers.id, inboxRefs.ref))
      .where(and(eq(triggers.id, cv.place), eq(triggers.project, cv.project), eq(triggers.to, job.agent),
        eq(triggers.ownerKind,'agent'), eq(triggers.owner,job.agent), eq(triggerAcceptances.job, job.id),
        eq(inbox.job, job.id), eq(inbox.conversation, cv.id), inArray(inbox.state, ['taken','done']),
        eq(inbox.source,'trigger'), eq(inbox.fromKind,'schedule'), eq(inbox.fromId,job.agent),
        eq(inbox.toKind,'agent'), eq(inbox.to,job.agent), eq(inbox.takenVolume,'full'),
        isNull(inbox.onWordKind), isNull(inbox.member))).get();
    if (!receipt) return;
    const assigned = db.select({id:tasks.id}).from(tasks).innerJoin(projects,eq(projects.id,tasks.project))
      .where(and(eq(tasks.id,task), eq(tasks.project,cv.project), eq(tasks.status,'in_progress'),
        eq(tasks.assigneeKind,'agent'), eq(tasks.assignee,viewer.id), isNull(projects.retiredAt),
        isNull(projects.removedAt), taskVisibility(viewer).projects!(getTableColumns(projects)),
        taskVisibility(viewer).tasks!(getTableColumns(tasks)))).get();
    if (assigned) return {project:cv.project, agent:viewer.id, task, job:job.id};
  }

  operations.register(operation({
    ...bodyOperationDefaults(current, text => key.hash(text), 'work.postUpdate'),
    name:'work.postUpdate', refuses:true,
    input:z.object({task:z.string().min(1), post:agentPostEdit.refine(post => !('refs' in post), 'The claimed ticket is linked automatically')}).strict(),
    output:z.object({thread:z.string()}).strict(),
    may:(viewer,input) => !!claim(viewer,input.task),
    inputHash:(canonical,{actor,input}) => key.hash(JSON.stringify(['work.postUpdate',actor.id,claim(actor,input.task)?.project,canonical])),
    async prepare({task,post},{viewer}) {
      const before = claim(viewer,task);
      if (!before) throw new OperationError('denied','Current ticket claim required');
      const {project,agent} = before;
      const source = 'work-source:'+key.hash(JSON.stringify([project,task,agent]));
      const save = await prepareAgentPost(db,key,source,post.action === 'rename' || !canonicalTicket.test(task) ? post : {...post,refs:[task]}, {project,task,agent});
      return (at:string) => {
        const live = claim(viewer,task);
        if (live?.job !== before.job || live.project !== project) throw new OperationError('denied','Ticket claim changed');
        return save(at);
      };
    },
    run(ctx,{task},prepared) {
      const thread = (prepared as (at:string)=>string)(new Date(ctx.now).toISOString());
      ctx.changed('tasks',task);
      return {thread};
    },
  }));
}
