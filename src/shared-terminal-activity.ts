import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { agentPostEdit, prepareAgentPost } from './core/conversations/agent-posts.js';
import { terminalSilenceMs, type TerminalScope } from './core/conversations/terminal-sessions.js';
import type { WordsKey } from './core/conversations/words.js';
import type { DataDatabase } from './core/data/database.js';
import { conversations, jobs, terminalSessions, threads } from './core/data/schema.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import { mayRunPrivateWork, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';

const sessionSchema = z.object({
  harness: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
}).strict();
const inputSchema = sessionSchema.extend({ binding: z.string().min(1), post: agentPostEdit }).strict();

export function registerTerminalActivity(operations: Operations, db: DataDatabase, key: WordsKey,
  machine: (viewer: Viewer) => TerminalScope | undefined, now: () => string) {
  const source = (viewer: Viewer, input: z.infer<typeof sessionSchema>) => {
    const scope = machine(viewer);
    if (!scope) return;
    const cutoff = new Date(Date.parse(now()) - terminalSilenceMs).toISOString();
    const row = db.select({thread: threads.id, job: jobs.id, instance: terminalSessions.instanceId,
      project: conversations.project, jobProject: jobs.project})
      .from(terminalSessions).innerJoin(jobs,eq(jobs.id,terminalSessions.job))
      .innerJoin(threads,eq(threads.id,terminalSessions.thread))
      .innerJoin(conversations,eq(conversations.id,threads.conversation))
      .where(and(eq(terminalSessions.machine,scope.machine),eq(terminalSessions.member,scope.member),
        eq(terminalSessions.agent,scope.agent),eq(terminalSessions.harness,input.harness),eq(terminalSessions.sessionId,input.sessionId),
        eq(jobs.state,'running'),gt(jobs.heardAt,cutoff),eq(jobs.startedByKind,'terminal'),eq(jobs.box,scope.machine),
        eq(jobs.conversation,conversations.id),eq(jobs.member,scope.member),eq(jobs.agent,scope.agent),eq(jobs.harness,input.harness),
        eq(conversations.place,threads.id),eq(conversations.venue,'terminal'),eq(conversations.member,scope.member),eq(conversations.agent,scope.agent))).get();
    if (row?.instance && row.project === row.jobProject && mayRunPrivateWork({...scope,project:row.project ?? undefined},sharedSharing(db))) return row;
  };
  const binding = (row: NonNullable<ReturnType<typeof source>>) =>
    key.hash(JSON.stringify(['terminal activity session',row.job,row.thread,row.instance,row.project]));
  operations.register(operation({
    name:'terminal.activityContext', write:false, doors:['http'],input:sessionSchema,
    output:z.object({binding:z.string()}).strict(), may:(viewer,input)=>!!source(viewer,input),
    run(ctx,input) {
      const row=source(ctx.viewer,input);
      if (!row) throw new OperationError('denied','Current terminal session required');
      return {binding:binding(row)};
    },
  }));
  operations.register(operation({
    name:'terminal.activityPost', write:true, doors:['http'], input:inputSchema,
    output:z.object({thread:z.string()}).strict(),
    may:(viewer,input)=>{const row=source(viewer,input);return !!row && binding(row)===input.binding;},
    inputHash:(canonical,{actor,input})=>key.hash(JSON.stringify(['terminal.activityPost',source(actor,input),canonical])),
    async prepare(input,{viewer}) {
      const before=source(viewer,input);
      if (!before) throw new OperationError('denied','Current terminal session required');
      const save=await prepareAgentPost(db,key,before.thread,input.post);
      return () => {
        const live=source(viewer,input);
        if (!live || live.thread!==before.thread || live.job!==before.job || live.instance!==before.instance || live.project!==before.project)
          throw new OperationError('denied','Terminal session changed');
        return {thread:save(now()),source:live.thread};
      };
    },
    run(ctx,_input,prepared) {
      const result=(prepared as ()=>{thread:string;source:string})();
      ctx.changed('threads',result.source);
      return {thread:result.thread};
    },
  }));
}
