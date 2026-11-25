import { asc, desc, eq, isNull } from 'drizzle-orm';
import { GraphQLNonNull, GraphQLString } from 'graphql/index.js';
import { z } from 'zod';
import { holds, mayAct, mayCreate, rules, type Viewer } from '../../policy.js';
import { sharedSharing } from '../../shared-sharing.js';
import type { DataDatabase } from '../data/database.js';
import { commsKeepDays } from '../data/comms-days.js';
import { householdSettings } from '../data/household-settings.js';
import { agents, deletedThreads, messages, projects, tasks, threads } from '../data/schema.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import type { CommsMessages } from './messages.js';
import { keepUntilFor } from './retention.js';

type Subject = {kind:'ticket'|'project';id:string};
const subject = z.object({kind:z.enum(['ticket','project']),id:z.string().min(1).max(100)});

function readWorkSubject(db:DataDatabase,input:Subject) {
  const row=input.kind==='ticket'
    ? db.select().from(tasks).where(eq(tasks.id,input.id)).get()
    : db.select().from(projects).where(eq(projects.id,input.id)).get();
  if (!row || ('removedAt' in row && row.removedAt)) return;
  const sharing=sharedSharing(db);
  const rule=input.kind==='ticket' ? rules.task : rules.project;
  return {sharing,visible:(viewer:Viewer)=>holds(rule,viewer,row,sharing)};
}

export function workNotice(row:Pick<typeof messages.$inferSelect,'kind'|'sender'|'seq'|'clientId'>) {
  return row.kind==='notice' && row.sender==='loom' && row.seq===1 && row.clientId==='work.subject';
}

export function readableWorkNotice(db:DataDatabase,viewer:Viewer,words:string) {
  const match=/^(Ticket|Project) ([^\n]+)$/.exec(words);
  return !!match && !!readWorkSubject(db,{kind:match[1]==='Ticket' ? 'ticket' : 'project',id:match[2]})?.visible(viewer);
}

export function workDiscussions(service:CommsMessages) {
  const db = service.db;
  function audience(viewer:Viewer, input:Subject) {
    if (viewer.kind!=='member') return;
    const record = readWorkSubject(db,input);
    if (!record || !record.visible(viewer) || !holds(rules.currentMember,viewer,{},record.sharing)) return;
    const {sharing,visible} = record;
    const preferred = householdSettings(db).defaultAgent ?? '';
    const available = db.select({id:agents.id}).from(agents).where(isNull(agents.removedAt))
      .orderBy(desc(eq(agents.id,preferred)),asc(agents.id)).all();
    return available.find(agent=>{
      const scope = {type:'conversation' as const,member:viewer.id,agent:agent.id};
      return visible({kind:'agent',id:agent.id,workingFor:viewer.id})
        && mayCreate(viewer,scope,sharing) && mayAct(viewer,scope,sharing,'give-work');
    })?.id;
  }

  // A deleted conversation stays deleted. A later deliberate open creates its successor.
  function threadId(member:string,agent:string,input:Subject) {
    let generation=0;
    for (;;) {
      const id='th:work-'+service.key.hash(JSON.stringify(['work-discussion',member,agent,input.kind,input.id,generation]));
      if (!db.select({id:deletedThreads.id}).from(deletedThreads).where(eq(deletedThreads.id,id)).get()) return id;
      generation++;
    }
  }

  const text=new GraphQLNonNull(GraphQLString);
  return {
    fields:{workDiscussionAgent:{type:GraphQLString,args:{kind:{type:text},id:{type:text}},
      resolve:(_row:unknown,args:unknown,{viewer}:{viewer:Viewer})=>{
        const result=subject.safeParse(args);
        return result.success ? audience(viewer,result.data) ?? null : null;
      }}},
    install(operations:Operations) {
      operations.register(operation({
        name:'work.discuss',doors:['http'],write:true,refuses:true,recheckPolicy:true,
        input:subject.extend({agent:z.string().min(1)}).strict(),
        output:z.object({thread:z.string()}).strict(),
        inputHash:value=>service.key.hash('work.discuss\0'+value),
        may:(viewer,input)=>audience(viewer,input)===input.agent,
        validateReplay(viewer,input,_prior,result) {
          if (viewer.kind!=='member' || !result?.ok || threadId(viewer.id,input.agent,input)!==(result.value as {thread:string}).thread)
            throw new OperationError('conflict','The discussion has changed');
        },
        async prepare(input) {
          // Preserve only the reference. Ticket words remain governed by the ticket reader.
          return service.key.seal((input.kind==='ticket' ? 'Ticket ' : 'Project ')+input.id);
        },
        run(ctx,input,prepared) {
          if (ctx.viewer.kind!=='member' || audience(ctx.viewer,input)!==input.agent)
            throw new OperationError('denied','This discussion is unavailable');
          const id=threadId(ctx.viewer.id,input.agent,input);
          const existing=db.select({id:threads.id}).from(threads).where(eq(threads.id,id)).get();
          const thread=service.threads.open({id,member:ctx.viewer.id,agent:input.agent,
            title:input.kind==='ticket' ? 'Ticket discussion' : 'Project discussion',titledBy:'agent'});
          if (!existing) {
            db.insert(messages).values({thread:id,seq:1,kind:'notice',sender:'loom',clientId:'work.subject',at:thread.openedAt,
              keepUntil:keepUntilFor(thread.openedAt,commsKeepDays(db)),words:prepared as Buffer}).run();
            ctx.changed('threads',id); ctx.changed('conversations',thread.conversation);
            ctx.changed('messages',id);
          }
          return {thread:id};
        },
      }));
    },
  };
}
