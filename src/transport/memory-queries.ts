/** File-backed Memory joins the generated schema; no copied tables or second door. */
import type { DataDatabase } from '../core/data/database.js';
import { householdTimezone } from '../core/data/household-settings.js';
import type { Sharing } from '../core/index.js';
import type { MindSources } from '../pieces/mind/sources.js';
import type { createActivityReader } from '../pieces/mind/activity.js';
import { knowledgeQueryFields } from '../pieces/mind/knowledge-query.js';
import { peopleQueryFields } from '../pieces/mind/people-query.js';
import {QueryDeadlines} from '../pieces/mind/query-deadlines.js';
import { projectsQueryFields, type ProjectQueryReader } from '../pieces/mind/projects-query.js';
import { activityQueryFields } from '../pieces/mind/activity-query.js';
import { sharedPeopleConversations } from '../pieces/mind/people-conversations.js';
import {memoryIdentityFields,type TapeDigestReader} from '../pieces/mind/identity-query.js';
import {readActivityWindow} from '../core/data/activity-read.js';

export function memoryQueryFields(db: DataDatabase, options: {
  sources?: MindSources; sharing(): Sharing; now(): number;
  projects: ProjectQueryReader; activity: Pick<ReturnType<typeof createActivityReader>, 'window' | 'read'> & Partial<Pick<ReturnType<typeof createActivityReader>,'access'|'episodePage'>> & {nextDeadline?():number|undefined};
  conversationHref(id: string): string; projectHref(agent: string, slug: string): string;
}) {
  const deadlines=new QueryDeadlines(options.now);
  const hasConversations=!!db.$client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get();
  const knowledge = knowledgeQueryFields({timezone:()=>householdTimezone(db),path: options.sources?.commons.knowledge, sharing: options.sharing, now: options.now});
  try {
    // The list of agents is read through each time: it follows the household (pieces/mind/sources.ts).
    const sources = options.sources;
    const people = peopleQueryFields({directory: sources?.commons.people, get agents() { return sources?.agents ?? []; },
      sharing: options.sharing, now: options.now, projectHref: options.projectHref,
      conversations: hasConversations ? sharedPeopleConversations(db, options.sharing, options.conversationHref) : undefined});
    try{
      // The newest 200 digests in the window: far more than the tape's budget keeps, which drops the oldest first.
      const digests:TapeDigestReader=(viewer,agent,window)=>readActivityWindow(db,viewer,{agent,from:window.from,until:window.until+1,limit:200}).digestRows
        .map(row=>({at:row.at,venue:row.conversationRow.venue,label:row.conversationRow.label,place:row.conversationRow.place,summary:row.summary}));
      const context=memoryIdentityFields({...options,timezone:()=>householdTimezone(db),digests:hasConversations?digests:undefined},deadlines);
      return {sweep:knowledge.sweep,nextDeadline(){const times=[knowledge.nextDeadline(),deadlines.nextDeadline(),people.nextDeadline(),options.activity.nextDeadline?.()].filter((at):at is number=>at!==undefined);return times.length?Math.min(...times):undefined;},observeDeadlines:(fn:()=>void)=>deadlines.observe(fn),fields: {...knowledge.fields, ...people.fields, ...projectsQueryFields(options.projects,deadlines,options.now), ...activityQueryFields(options.activity,deadlines),...context.fields},
        // Query readers own their complete cleanup even when the enclosing service also closes.
        close() {const errors:unknown[]=[];for(const close of [()=>deadlines.close(),context.close,people.close,knowledge.close])try{close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory queries failed to close');}};
    }catch(error){people.close();throw error;}
  } catch (error) { deadlines.close(); knowledge.close(); throw error; }
}
