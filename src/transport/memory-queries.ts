/** File-backed Memory joins the generated schema; no copied tables or second door. */
import type { DataDatabase } from '../core/data/database.js';
import type { Sharing } from '../core/index.js';
import type { MindSources } from '../pieces/mind/sources.js';
import type { Mind } from '../pieces/mind/role.js';
import type { installMindActivity } from '../pieces/mind/activity.js';
import { knowledgeQueryFields } from '../pieces/mind/knowledge-query.js';
import { peopleQueryFields } from '../pieces/mind/people-query.js';
import { projectsQueryFields } from '../pieces/mind/projects-query.js';
import { activityQueryFields } from '../pieces/mind/activity-query.js';
import { sharedPeopleConversations } from '../pieces/mind/people-conversations.js';

export function memoryQueryFields(db: DataDatabase, options: {
  sources?: MindSources; sharing(): Sharing; now(): number;
  mind: Mind; activity: Pick<ReturnType<typeof installMindActivity>, 'window' | 'read'>;
  conversationHref(id: string): string; projectHref(agent: string, slug: string): string;
}) {
  const knowledge = knowledgeQueryFields({path: options.sources?.commons.knowledge, sharing: options.sharing, now: options.now});
  try {
    const people = peopleQueryFields({directory: options.sources?.commons.people, agents: options.sources?.agents ?? [],
      sharing: options.sharing, now: options.now, projectHref: options.projectHref,
      conversations: db.$client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get()
        ? sharedPeopleConversations(db, options.sharing, options.conversationHref) : undefined});
    return {fields: {...knowledge.fields, ...people.fields, ...projectsQueryFields(options.mind), ...activityQueryFields(options.activity)},
      close() { people.close(); knowledge.close(); }};
  } catch (error) { knowledge.close(); throw error; }
}
