/** File-backed Memory joins the generated schema; no copied tables or second door. */
import type { DataDatabase } from '../core/data/database.js';
import type { Sharing } from '../core/index.js';
import type { MindSources } from '../pieces/mind/sources.js';
import type { createActivityReader } from '../pieces/mind/activity.js';
import { knowledgeQueryFields } from '../pieces/mind/knowledge-query.js';
import { peopleQueryFields } from '../pieces/mind/people-query.js';
import {QueryDeadlines} from '../pieces/mind/query-deadlines.js';
import { projectsQueryFields, type ProjectQueryReader } from '../pieces/mind/projects-query.js';
import { activityQueryFields } from '../pieces/mind/activity-query.js';
import { sharedPeopleConversations } from '../pieces/mind/people-conversations.js';
import {memoryIdentityFields} from '../pieces/mind/identity-query.js';

export function memoryQueryFields(db: DataDatabase, options: {
  sources?: MindSources; sharing(): Sharing; now(): number;timezone?():string;
  projects: ProjectQueryReader; activity: Pick<ReturnType<typeof createActivityReader>, 'window' | 'read'> & Partial<Pick<ReturnType<typeof createActivityReader>,'access'>> & {nextDeadline?():number|undefined};
  conversationHref(id: string): string; projectHref(agent: string, slug: string): string;
}) {
  const deadlines=new QueryDeadlines(options.now);
  const knowledge = knowledgeQueryFields({path: options.sources?.commons.knowledge, sharing: options.sharing, now: options.now});
  try {
    const people = peopleQueryFields({directory: options.sources?.commons.people, agents: options.sources?.agents ?? [],
      sharing: options.sharing, now: options.now, projectHref: options.projectHref,
      conversations: db.$client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get()
        ? sharedPeopleConversations(db, options.sharing, options.conversationHref) : undefined});
    try{
      const context=memoryIdentityFields({...options,timezone:options.timezone??(()=>'UTC')},deadlines);
      return {sweep:knowledge.sweep,nextDeadline(){const times=[knowledge.nextDeadline(),deadlines.nextDeadline(),people.nextDeadline(),options.activity.nextDeadline?.()].filter((at):at is number=>at!==undefined);return times.length?Math.min(...times):undefined;},observeDeadlines:(fn:()=>void)=>deadlines.observe(fn),fields: {...knowledge.fields, ...people.fields, ...projectsQueryFields(options.projects,deadlines,options.now), ...activityQueryFields(options.activity,deadlines),...context.fields},
        // Query readers own their complete cleanup even when the enclosing service also closes.
        close() {const errors:unknown[]=[];for(const close of [()=>deadlines.close(),context.close,people.close,knowledge.close])try{close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory queries failed to close');}};
    }catch(error){people.close();throw error;}
  } catch (error) { deadlines.close(); knowledge.close(); throw error; }
}
