import {keepReadUntil} from '../../core/data/read-lease.js';
/** Typed fields over the installed Projects reader; no second store or endpoint. */
import { GraphQLBoolean, GraphQLError, GraphQLFloat, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../core/index.js';
import type {ProjectsReader} from './projects.js';
export type ProjectQueryReader=Pick<ProjectsReader,'list'|'read'|'memoryRead'|'access'>;
import {projectDeadline} from './project-deadlines.js';
import type {QueryDeadlines} from './query-deadlines.js';
import type { ProjectRecord, ProjectMemory, ProjectCard, ProjectSection } from './projects-model.js';

const text = { type: GraphQLString }, requiredText = { type: new GraphQLNonNull(GraphQLString) };
const strings = { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) };
const list = (type: GraphQLObjectType) => new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)));
const item = new GraphQLObjectType({ name: 'MemoryProjectItem', fields: {
 title: requiredText, ref: text, when: text, changed: text, status: text, body: text, href: text,
 who: strings, waiting: { type: GraphQLBoolean }, new: { type: GraphQLBoolean },
} });
const group = new GraphQLObjectType({ name: 'MemoryProjectGroup', fields: {
 title: requiredText, waiting: { type: GraphQLBoolean }, items: { type: list(item) },
} });
const count = new GraphQLObjectType({ name: 'MemoryProjectCount', fields: { category: requiredText, total: { type: new GraphQLNonNull(GraphQLInt) } } });
const section = new GraphQLObjectType<ProjectSection>({ name: 'MemoryProjectSection', fields: {
 key: requiredText, label: requiredText, available: { type: new GraphQLNonNull(GraphQLBoolean) }, error: text,
 items: { type: list(item), resolve: s => s.items ?? [] }, groups: { type: list(group), resolve: s => s.groups ?? [] },
 total: { type: GraphQLInt }, counts: { type: list(count), resolve: s => Object.entries(s.counts ?? {}).map(([category, total]) => ({ category, total })) },
 activity: text, expires: { type: GraphQLFloat }, conversationIds: strings,
} });
const cardField = new GraphQLObjectType({ name: 'MemoryProjectCardField', fields: {
 key: requiredText, value: requiredText, verified_at: text, stale_after_days: { type: GraphQLInt }, source: text,
} });
const links = new GraphQLObjectType({ name: 'MemoryProjectLinks', fields: {
 aliases: strings, notes: strings, epic: text, repos: strings, venues: strings,
} });
const card = new GraphQLObjectType<ProjectCard>({ name: 'MemoryProjectCard', fields: {
 slug: requiredText, name: requiredText, status: requiredText, summary: text, goal: text,
 where: { type: list(cardField), resolve: c => Object.entries(c.where).map(([key, value]) => ({ key, ...value })) },
 links: { type: new GraphQLNonNull(links) },
} });
const field = new GraphQLObjectType({ name: 'MemoryProjectField', fields: { key: requiredText, value: requiredText, state: requiredText } });
const changes = new GraphQLObjectType({ name: 'MemoryProjectChanges', fields: { open: { type: GraphQLInt }, failing: { type: GraphQLInt }, running: { type: GraphQLInt } } });
const project = new GraphQLObjectType({ name: 'MemoryProject', fields: {
 id: requiredText, agent: requiredText, agents: strings, now: { type: GraphQLFloat }, slug: requiredText, name: requiredText,
 card: { type: new GraphQLNonNull(card) }, updated: requiredText, activity: requiredText, archived: { type: GraphQLBoolean },
 sections: { type: list(section) }, waiting: { type: list(item) }, unknown: { type: GraphQLBoolean }, lately: { type: list(item) },
 people: strings, spark: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) }, changes: { type: changes }, fields: { type: list(field) },
} });
// A quiet index omits hub roles. Distinct projection identity prevents a
// normalized list refresh from overwriting the selected hub's richer fields.
const projectDetail = new GraphQLObjectType({...project.toConfig(),name:'MemoryProjectDetail'});
const memory = new GraphQLObjectType({ name: 'MemoryProjectMemory', fields: {
 id: requiredText, agent: requiredText, ref: requiredText, title: requiredText, content: requiredText,
 category: requiredText, created: requiredText, updated: requiredText, expires: { type: GraphQLFloat },
} });

const access=new GraphQLObjectType({name:'MemoryProjectsAccess',fields:{allowed:{type:new GraphQLNonNull(GraphQLBoolean)},agents:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)))}}});
export function projectsQueryFields(source: ProjectQueryReader, deadlines?:QueryDeadlines, now:()=>number=Date.now): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
 const read = (context: { viewer: Viewer }, verb: string, input: Record<string, unknown>, absent: unknown) => {
  if (!context?.viewer) return absent;
  try {
   if(verb!=='projectsList'&&(typeof input.id!=='string'||input.id.length<3||input.id.length>(verb==='projectMemoryRead'?300:200)))return absent;
   const readAt=now();
   const value=verb==='projectsList'?source.list(context.viewer):verb==='projectRead'?source.read(input.id as string,context.viewer):source.memoryRead(input.id as string,context.viewer);
   if(value===undefined||value===null)return absent;
   const key=JSON.stringify([context.viewer.kind,context.viewer.id,verb,input]);
   const rows=verb==='projectsList'?value as ProjectRecord[]:[value as ProjectRecord|ProjectMemory];
   const times=rows.map(row=>verb==='projectMemoryRead'?(row as ProjectMemory).expires:projectDeadline(row as ProjectRecord,readAt)).filter((at):at is number=>at!==undefined);
   const until=times.length?Math.min(...times):undefined;
   if(until!==undefined)keepReadUntil(context,until);
   deadlines?.set(key,until);
   return value;
  } catch { /* Never expose source paths or SQL through GraphQL errors. */ }
  throw new GraphQLError('Projects are unavailable');
 };
 const id = { type: new GraphQLNonNull(GraphQLString) };
 return {
  memoryProjectsAccess:{type:access,resolve:(_source,_args,context)=>context?.viewer?source.access(context.viewer):null},
  memoryProjects: { type: new GraphQLList(new GraphQLNonNull(project)), resolve: (_source, _args, context) => read(context, 'projectsList', {}, []) },
  memoryProject: { type: projectDetail, args: { id }, resolve: (_source, args, context) => read(context, 'projectRead', { id: args.id }, null) },
  memoryProjectMemory: { type: memory, args: { id }, resolve: (_source, args, context) => read(context, 'projectMemoryRead', { id: args.id }, null) },
 };
}
