/** Browser selections for the generated /graphql door. These documents and
 * decoders feed the canonical client; this module owns no connection/cache. */
import type { KnowledgeOpen, KnowledgeRow } from '../../../src/pieces/mind/knowledge';
import type { PersonRecord, PersonCard, CardValue } from '../../../src/pieces/mind/people-model';
import type { ProjectRecord, ProjectMemory } from '../../../src/pieces/mind/projects-model';
import type { ActivityWindow, ActivityOpen } from '../pieces/activity/model';

export interface MemorySelection<T> {
  query: string;
  variables: Record<string, string>;
  decode(data: Record<string, unknown>): T;
}
/** GraphQL emits null for absent optional fields; the portable screen models
 * use omitted keys. Build new objects, including for untrusted card keys. */
function optional(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(optional);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== null).map(([k,v]) => [k,optional(v)]));
  return value;
}
const selection = <T>(field: string, query: string, variables: Record<string,string>, decode: (value: any) => T): MemorySelection<T> => ({
  query, variables, decode(data) {
    if (!Object.hasOwn(data,field)) throw new Error('Missing Memory result');
    return decode(data[field]);
  },
});
const nullable = <T>(decode: (value: any) => T) => (value: any): T | null => value === null ? null : decode(value);
const portable = <T>(value: unknown): T => optional(value) as T;
export interface KnowledgeAccess {allowed:boolean;canAdd:boolean;canVerify:boolean;canRecheck:boolean}
export interface PeopleAccess {allowed:boolean;directory:boolean;canAdd:boolean;agents:string[]}
export interface ProjectsAccess {allowed:boolean;agents:string[]}
export interface ActivityAccess {allowed:boolean;agents:string[];owner:string;timezone:string;today:string;windows:string[];expires:number}
export interface KnowledgeIndex { total:number;checkDays:number;recentDays:number;pages:KnowledgeRow[] }
export interface KnowledgePage extends KnowledgeOpen { history:Array<{id:number;slug:string;body:string;op:string;replacedAt:string;actor?:string}> }
const knowledgeRow = 'slug title domain updated verified_at fresh by recent';
const knowledgePage = `${knowledgeRow} body sourcing sources { claim kind locator href excerpt retrievedAt createdAt } citedBy { slug title } checked { at outcome by } history { id slug body op replacedAt actor }`;
const cardValue = 'text number boolean strings';
const personCard = `slug name summary where { key value { ${cardValue} } label source verified_at stale_after_days } how { key value { ${cardValue} } } may { text source }`;
const personFields = `id slug agent name updated synthesizedAt kind newer mergedFrom
  card { ${personCard} } evidence { created category title content }
  fields { key value label source verifiedAt state } projects { agent slug name status href } ownership { owner agents }`;
export interface PersonOpen extends PersonRecord { history: Array<{id:number;op:string;replacedAt:string;actor?:string;card:PersonCard}>; conversations: { available: boolean; rows: { id: string; title: string; href: string }[] } }
function decodeValue(value: { text: string | null; number: number | null; boolean: boolean | null; strings: string[] | null }): CardValue {
  const result = value.text ?? value.number ?? value.boolean ?? value.strings;
  if (result === null) throw new Error('Missing card value');
  return result;
}
function decodeCard(card: any): PersonCard {
  return { ...portable<PersonCard>(card),
    where: Object.fromEntries(card.where.map(({key,value,...rest}: any) => [key,{...optional(rest) as object,value:decodeValue(value)}])),
    how: Object.fromEntries(card.how.map(({key,value}: any) => [key,decodeValue(value)])),
  };
}
function person<T extends PersonRecord>(raw: any): T {
  const value = portable<T>(raw);
  value.synthesizedAt = raw.synthesizedAt;
  value.card = decodeCard(raw.card);
  if (Array.isArray(raw.history)) (value as PersonRecord).history = raw.history.map((revision: any) => ({...portable<object>(revision),card:decodeCard(revision.card)}));
  return value;
}
const projectItem = 'title ref when changed status body href who waiting new';
const projectFields = `id agent agents now slug name updated activity archived unknown
  card { slug name status summary goal where { key value verified_at stale_after_days source } links { aliases notes epic repos venues } }
  sections { key label available error total counts { category total } activity expires conversationIds
    items { ${projectItem} } groups { title waiting items { ${projectItem} } } }
  waiting { ${projectItem} } lately { ${projectItem} } people spark changes { open failing running } fields { key value state }`;
function project(raw: any): ProjectRecord {
  const value = portable<ProjectRecord>(raw);
  value.card.where = Object.fromEntries(raw.card.where.map(({key,...field}: any) => [key,optional(field)]));
  value.sections = value.sections.map((section,i) => ({ ...section, counts: Object.fromEntries(raw.sections[i].counts.map(({category,total}: any) => [category,total])) }));
  return value;
}
const entryFields = 'id agent at day hour title line venue where what owner expires';
const activityOpen = `${entryFields} asked decided story needs steps { label state tool } more { id at title } tasks { label href } prs { label href } links { label href }`;

export const memoryQueries = {
  peopleAccess:()=>selection<PeopleAccess|null>('memoryPeopleAccess','query MemoryPeopleAccess { memoryPeopleAccess { allowed directory canAdd agents } }',{},nullable(portable<PeopleAccess>)),
  projectsAccess:()=>selection<ProjectsAccess|null>('memoryProjectsAccess','query MemoryProjectsAccess { memoryProjectsAccess { allowed agents } }',{},nullable(portable<ProjectsAccess>)),
  activityAccess:()=>selection<ActivityAccess|null>('memoryActivityAccess','query MemoryActivityAccess { memoryActivityAccess { allowed agents owner timezone today windows expires } }',{},nullable(portable<ActivityAccess>)),
  householdTimezone: () => selection<string|null>('tempoTimezone', 'query HouseholdTimezone { tempoTimezone }', {}, nullable(portable<string>)),
  knowledgeAccess:()=>selection<KnowledgeAccess|null>('memoryKnowledgeAccess','query MemoryKnowledgeAccess { memoryKnowledgeAccess { allowed canAdd canVerify canRecheck } }',{},nullable(portable<KnowledgeAccess>)),
  knowledge: () => selection<KnowledgeIndex | null>('memoryKnowledge', `query MemoryKnowledge { memoryKnowledge { total checkDays recentDays pages { ${knowledgeRow} } } }`, {}, nullable(portable<KnowledgeIndex>)),
  page: (slug:string) => selection<KnowledgePage | null>('memoryKnowledgePage', `query MemoryKnowledgePage($slug:String!) { memoryKnowledgePage(slug:$slug) { ${knowledgePage} } }`, {slug}, nullable(portable<KnowledgePage>)),
  people: () => selection<PersonRecord[]>('memoryPeople', `query MemoryPeople { memoryPeople(includeRemovedAgents:false) { ${personFields} } }`, {}, raw => raw.map(person)),
  person: (id:string) => selection<PersonOpen | null>('memoryPerson', `query MemoryPerson($id:String!) { memoryPerson(id:$id) { ${personFields} conversations { available rows { id title href } } history { id op replacedAt actor card { ${personCard} } } } }`, {id}, nullable(person<PersonOpen>)),
  projects: () => selection<ProjectRecord[]>('memoryProjects', `query MemoryProjects { memoryProjects { ${projectFields} } }`, {}, raw => raw.map(project)),
  project: (id:string) => selection<ProjectRecord | null>('memoryProject', `query MemoryProject($id:String!) { memoryProject(id:$id) { ${projectFields} } }`, {id}, nullable(project)),
  projectMemory: (id:string) => selection<ProjectMemory | null>('memoryProjectMemory', 'query MemoryProjectMemory($id:String!) { memoryProjectMemory(id:$id) { id agent ref title content category created updated expires } }', {id}, nullable(portable<ProjectMemory>)),
  activity: (to = 'recent') => selection<ActivityWindow | null>('memoryActivity', `query MemoryActivity($to:String!) { memoryActivity(to:$to) { id to days earlier entries { ${entryFields} } conversations episodes truncated expires } }`, {to}, nullable(portable<ActivityWindow>)),
  activityEntry: (id:string) => selection<ActivityOpen | null>('memoryActivityEntry', `query MemoryActivityEntry($id:String!) { memoryActivityEntry(id:$id) { ${activityOpen} } }`, {id}, nullable(portable<ActivityOpen>)),
};
