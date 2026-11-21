/** Read-time usage projections. All reads enter through the job's current SQL visibility. */
import { and, desc, eq, getTableColumns, isNull, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { GraphQLFloat, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { conversations, inbox, inboxRefs, jobs, jobUsage, programFirings, terminalRuns, triggers } from '../core/data/schema.js';
import { jobUnended } from '../core/data/job-states.js';
import type { JobSummaries } from './job-summary.js';

const additive = ['tokensIn','tokensOut','cacheRead','cacheWritten','modelCalls','toolCalls','wallMs'] as const;
const counter = {type: GraphQLFloat};
const text = {type: GraphQLString};
const requiredText = {type: new GraphQLNonNull(GraphQLString)};
const counters = Object.fromEntries(additive.map(name => [name, counter]));
const toolType = new GraphQLObjectType({name:'JobToolCount',fields:{name:requiredText,count:counter}});
const usageType = new GraphQLObjectType({name:'JobUsageMetrics',fields:{
  ...counters, firstContext:counter, largestContext:counter, totalTokens:counter, source:requiredText, harness:text, model:text,
  tools:{type:new GraphQLList(new GraphQLNonNull(toolType))},
}});
const recordType = new GraphQLObjectType({name:'JobUsageRecord',fields:{
  id:requiredText, title:requiredText, runKind:text, state:requiredText, queuedAt:requiredText, retryOf:text, conversation:text, firingId:text, linkedWakeJob:text,
  usage:{type:usageType}, observations:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)))},
}});
const groupType = new GraphQLObjectType({name:'JobUsageGroup',fields:{
  key:text,title:text,jobCount:counter,retryCount:counter,totalTokens:counter,...counters,largestContext:counter,
}});

type Range = {from?:string|null;to?:string|null;conversation?:string|null};
function instant(value:string|null|undefined) {
  if (value == null) return undefined;
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Expected a timestamp with a time zone');
  return new Date(value).toISOString();
}
function windowFilter(args:Range, conversation:SQL<string|null>) {
  const from = instant(args.from), to = instant(args.to);
  if (from && to && from >= to) throw new Error('from must precede to');
  return and(from ? sql`julianday(${jobs.queuedAt}) >= julianday(${from})` : undefined,
    to ? sql`julianday(${jobs.queuedAt}) < julianday(${to})` : undefined,
    args.conversation === null ? isNull(conversation) : args.conversation !== undefined ? eq(conversation,args.conversation) : undefined);
}

// Tempo writes the trigger id as a reference and the unique firing id as the source of its mail.
const firing = sql<string|null>`(select json_array(${inboxRefs.ref}, ${inbox.sourceId})
  from ${inbox} join ${inboxRefs} on ${inboxRefs.item} = ${inbox.id}
  where ${inbox.conversation} = ${jobs.conversation} and ${inbox.job} = ${jobs.id} and ${inbox.source} = 'trigger'
    and substr(${inbox.sourceId},1,length(${inboxRefs.ref})+1) = ${inboxRefs.ref} || ':'
  order by ${inbox.at}, ${inbox.id}, length(${inboxRefs.ref}) desc limit 1)`;

function rows(s:JobSummaries, filter?:SQL | ((conversation:SQL<string|null>)=>SQL|undefined)) {
  // A terminal's simultaneous child jobs point at the parent run. Its conversation and words
  // are visible only when the caller can read both the run and that parent.
  const parent = s.db.select({id:jobs.id,conversation:jobs.conversation}).from(jobs).where(s.allowed()).as('terminal_parent');
  const conversation = sql<string|null>`coalesce(${jobs.conversation}, ${parent.conversation})`;
  const runKind = sql<string|null>`case when ${programFirings.id} is not null then 'program' when ${terminalRuns.job} is null then null
    when ${terminalRuns.job} = ${terminalRuns.parent} then 'main' else 'subagent' end`;
  return s.db.select({id:jobs.id,jobAgent:jobs.agent,title:jobs.title,conversation,runKind,label:conversations.label,
    state:jobs.state,queuedAt:jobs.queuedAt,retryOf:jobs.retryOf,firing,programFiring:programFirings.id,programTrigger:programFirings.trigger,venue:conversations.venue,place:conversations.place,agent:conversations.agent,member:conversations.member,usage:jobUsage})
    .from(jobs).leftJoin(programFirings,eq(programFirings.job,jobs.id)).leftJoin(terminalRuns,eq(terminalRuns.job,jobs.id)).leftJoin(parent,eq(parent.id,terminalRuns.parent))
    .leftJoin(conversations,eq(conversations.id,conversation)).leftJoin(jobUsage,eq(jobUsage.job,jobs.id))
    .where(and(s.allowed(),or(isNull(terminalRuns.job),isNotNull(parent.id)),typeof filter === 'function' ? filter(conversation) : filter)).orderBy(desc(sql`julianday(${jobs.queuedAt})`),desc(jobs.id)).all();
}
type Row = ReturnType<typeof rows>[number];
function plus(a:number|null,b:number|null) {
  if (a === null) return b;
  return b === null ? a : a + b;
}
function total(row:Row) {return plus(row.usage?.tokensIn ?? null,row.usage?.tokensOut ?? null);}

type Run = {trigger:string; id:string};
function assignRuns(history:Row[]) {
  const byId = new Map(history.map(row=>[row.id,row]));
  const families = new Map<string,Row[]>();
  for (const row of history) {
    let first = row;
    const seen = new Set([row.id]);
    while (first.retryOf) {
      const parent = byId.get(first.retryOf);
      if (!parent || parent.conversation !== row.conversation || seen.has(parent.id)) break;
      seen.add(parent.id);
      first = parent;
    }
    const family = families.get(first.id) ?? [];
    family.push(row);
    families.set(first.id,family);
  }
  const runs = new Map<string,Run>(), lastWake = new Map<string,Run>();
  // A firing can move to the retry that took its mail. Assign the entire attempt family together.
  for (const row of [...history].reverse()) {
    const family = families.get(row.id);
    if (!family) continue;
    const delivery = family.find(attempt=>attempt.firing)?.firing;
    let run:Run|undefined;
    if (row.programFiring && row.programTrigger) {
      run = {trigger:row.programTrigger,id:row.programFiring};
    } else if (delivery) {
      const [trigger,id] = JSON.parse(delivery) as [string,string];
      run = {trigger,id};
    } else if (row.venue === 'wake' && row.conversation && row.place && row.place !== 'sweep:' + row.agent) {
      const suffix = ':for:' + row.member;
      const trigger = row.member && row.place.endsWith(suffix) ? row.place.slice(0,-suffix.length) : row.place;
      run = lastWake.get(row.conversation) ?? {trigger,id:row.conversation};
    }
    if (!run) continue;
    if (!row.programFiring && row.venue === 'wake' && row.conversation) lastWake.set(row.conversation,run);
    for (const attempt of family) runs.set(attempt.id,run);
  }
  return runs;
}
function expensiveRuns(history:Row[],runs:Map<string,Run>) {
  type Cost = {latest:string; total:number; complete:boolean};
  const triggers = new Map<string,Map<string,Cost>>();
  for (const row of [...history].reverse()) {
    const run = runs.get(row.id);
    if (!run) continue;
    const costs = triggers.get(run.trigger) ?? new Map<string,Cost>();
    const cost = costs.get(run.id) ?? {latest:row.id,total:0,complete:true};
    cost.latest = row.id;
    cost.total += total(row) ?? 0;
    if (jobUnended(row.state) || row.usage?.tokensIn == null || row.usage.tokensOut == null) cost.complete = false;
    costs.set(run.id,cost);
    triggers.set(run.trigger,costs);
  }
  const expensive = new Set<string>();
  for (const costs of triggers.values()) {
    const [latest,...prior] = [...costs.values()].reverse();
    const earlier = prior.filter(run=>run.complete).map(run=>run.total).sort((a,b)=>a-b);
    if (!latest.complete || !earlier.length) continue;
    const mid = Math.floor(earlier.length/2);
    const median = earlier.length % 2 ? earlier[mid] : (earlier[mid-1]+earlier[mid])/2;
    if (latest.total > 0 && latest.total >= 2*median) expensive.add(latest.latest);
  }
  return expensive;
}
// One SQLite parameter regardless of how many conversations the viewer can read.
function among(value:SQL | typeof jobs.conversation, ids:Iterable<string>) {
  return sql`${value} in (select value from json_each(${JSON.stringify([...ids])}))`;
}
function conversationHistory(s:JobSummaries,selected:Row[]) {
  const ids = [...new Set(selected.flatMap(row=>row.conversation ? [row.conversation] : []))];
  return ids.length ? rows(s,among(jobs.conversation,ids)) : [];
}
/** Group an account's internal usage weights under the viewer's current job, conversation,
 * parent-run and trigger rules. Only these grouped values may leave the projection. */
export function visibleWeeklyGroups(s:JobSummaries, estimate:{shares:Map<string,number>;unattributed:number}) {
  if (!estimate.shares.size) return {agents:[],conversations:[],triggers:[],unattributed:estimate.unattributed};
  const selected = rows(s,among(sql`${jobs.id}`,estimate.shares.keys()));
  const seenConversations = s.db.select({id:conversations.id}).from(conversations)
    .where(and(among(sql`${conversations.id}`,selected.flatMap(row=>row.conversation ?? [])),
      s.rule('conversations')!(getTableColumns(conversations)))).all();
  const readable = new Set(seenConversations.map(row=>row.id));
  const visible = selected.filter(row=>row.conversation === null || readable.has(row.conversation));
  const runs = assignRuns([...new Map([...conversationHistory(s,visible),...visible].map(row=>[row.id,row])).values()]
    .sort((a,b)=>Date.parse(b.queuedAt)-Date.parse(a.queuedAt) || b.id.localeCompare(a.id)));
  const notes = new Map(s.db.select({id:triggers.id,note:triggers.note}).from(triggers)
    .where(and(among(sql`${triggers.id}`,[...runs.values()].map(run=>run.trigger)),
      s.rule('triggers')!(getTableColumns(triggers)))).all().map(row=>[row.id,row.note]));
  type Group = {key:string|null;title:string;share:number;href:string|null};
  const agents = new Map<string|null,Group>(), conversationsById = new Map<string|null,Group>(), triggersById = new Map<string|null,Group>();
  function add(groups:Map<string|null,Group>,key:string|null,title:string,share:number,href:string|null=null) {
    const group = groups.get(key);
    if (group) group.share += share;
    else groups.set(key,{key,title,share,href});
  }
  let visibleShare = 0;
  for (const row of visible) {
    const share = estimate.shares.get(row.id)!;
    visibleShare += share;
    add(agents,row.jobAgent,row.jobAgent,share);
    const id = row.conversation;
    const href = id && (row.venue === 'terminal' || row.venue === 'loom') && row.place
      ? '/p/comms-preview/thread/'+encodeURIComponent(row.place.replace(/^th:/,'')) : id && '/p/comms-preview/conversation/'+encodeURIComponent(id);
    add(conversationsById,id,row.label ?? id ?? 'No conversation',share,href);
    const trigger = runs.get(row.id)?.trigger;
    if (trigger && notes.has(trigger)) add(triggersById,trigger,notes.get(trigger) || trigger,share,'/p/tempo/trigger/'+encodeURIComponent(trigger));
    else add(triggersById,null,'No visible trigger',share);
  }
  const sorted = (groups:Map<string|null,Group>)=>[...groups.values()].sort((a,b)=>b.share-a.share || a.title.localeCompare(b.title));
  const total = [...estimate.shares.values()].reduce((a,b)=>a+b,0);
  return {agents:sorted(agents),conversations:sorted(conversationsById),triggers:sorted(triggersById),
    unattributed:estimate.unattributed + Math.max(0,total-visibleShare)};
}
/** Only the actual receiving job counts as a wake. Both jobs must pass the viewer's current SQL
 * policy. Look up mail through its unique (to_kind,to,source,source_id) index, including when one
 * body took several firings. Keep the comparison out of admission and scheduling. */
function programUsage(s:JobSummaries, selected:Row[]) {
  const triggers = new Set(selected.flatMap(row => row.programTrigger ?? []));
  const linked = new Map<string,string>(), observations = new Map<string,string>();
  if (!triggers.size) return {linked, observations};
  const visibleWake = s.db.select({id:jobs.id,conversation:jobs.conversation}).from(jobs)
    .where(and(s.allowed(),ne(jobs.startedByKind,'terminal'))).as('visible_wake');
  const firings = s.db.select({trigger:programFirings.trigger, job:programFirings.job, wake:visibleWake.id})
    .from(programFirings).innerJoin(jobs,eq(jobs.id,programFirings.job))
    .leftJoin(inbox,and(eq(inbox.toKind,'agent'),eq(inbox.to,jobs.agent),eq(inbox.source,'trigger'),eq(inbox.sourceId,programFirings.id)))
    .leftJoin(visibleWake,and(eq(visibleWake.id,inbox.job),eq(visibleWake.conversation,jobs.conversation)))
    .where(and(s.allowed(),eq(programFirings.status,'done'),among(sql`${programFirings.trigger}`,triggers)))
    .orderBy(desc(sql`julianday(${programFirings.at})`),desc(programFirings.id)).all();
  const rates = new Map<string,{latest:string; count:number; recent:number; earlier:number}>();
  for (const firing of firings) {
    if (firing.wake) linked.set(firing.job,firing.wake);
    const rate = rates.get(firing.trigger) ?? {latest:firing.job,count:0,recent:0,earlier:0};
    if (firing.wake) {
      if (rate.count < 4) rate.recent++;
      else rate.earlier++;
    }
    rate.count++;
    rates.set(firing.trigger,rate);
  }
  for (const {latest,count,recent,earlier} of rates.values()) {
    const prior = count - 4;
    if (prior < 4) continue;
    const before = earlier / prior, now = recent / 4;
    if (now >= 2 * before && now - before >= 0.5)
      observations.set(latest,`This trigger woke a body on ${recent} of its last 4 completed program runs, up from ${earlier} of ${prior} earlier runs.`);
  }
  return {linked, observations};
}
function records(s:JobSummaries, selected:Row[]) {
  const program = programUsage(s,selected);
  const local = conversationHistory(s,selected);
  const localRuns = assignRuns(local);
  const wanted = new Set(selected.flatMap(row=>localRuns.get(row.id)?.trigger ?? []));
  // The same trigger can open a different wake place after its member changes, or deliver into
  // another named conversation. Only trigger-bearing conversations can contribute to its baseline.
  let expensive = new Set<string>();
  if (wanted.size) {
    const peers = s.db.selectDistinct({id:jobs.conversation}).from(jobs)
      .leftJoin(programFirings,eq(programFirings.job,jobs.id)).leftJoin(conversations,eq(conversations.id,jobs.conversation))
      .where(and(s.allowed(),sql`(
        (${conversations.venue} = 'wake' and (
          ${among(sql`${conversations.place}`,wanted)} or exists (
            select 1 from json_each(${JSON.stringify([...wanted])}) where
            ${conversations.place} = value || ':for:' || ${conversations.member})))
        or ${among(sql`${programFirings.trigger}`,wanted)}
        or ${among(sql`json_extract(${firing}, '$[0]')`,wanted)})`)).all();
    const ids = peers.flatMap(row=>row.id ? [row.id] : []);
    const history = ids.length ? rows(s,among(jobs.conversation,ids)) : [];
    expensive = expensiveRuns(history,assignRuns(history));
  }
  return selected.map(row=>{
    const usage = row.usage;
    const observations:string[] = [];
    if ((usage?.largestContext ?? 0) >= 32768 && usage?.toolCalls === 0) observations.push('This job used a large context and made no tool calls.');
    if (row.retryOf) observations.push('This job was a retry.');
    if (expensive.has(row.id)) observations.push('This trigger’s latest run used at least twice its earlier median tokens.');
    const rate = program.observations.get(row.id);
    if (rate) observations.push(rate);
    const firingId = row.programFiring ?? (row.firing ? (JSON.parse(row.firing) as [string,string])[1] : null);
    return {...row, firingId, linkedWakeJob:program.linked.get(row.id) ?? null, observations, usage:usage ? {...usage,totalTokens:total(row),
      tools:usage.tools && Object.entries(usage.tools).map(([name,count])=>({name,count})),
    } : jobUnended(row.state) ? null : {source:'none'}};
  });
}
function rollup(s:JobSummaries,args:Range & {groupBy:string}) {
  if (!['day','model','conversation','trigger','firing'].includes(args.groupBy)) throw new Error('Expected conversation, trigger, firing, day or model');
  const groups = new Map<string|null,Row[]>();
  const selected = rows(s,cv=>windowFilter(args,cv));
  const runs = args.groupBy === 'trigger' || args.groupBy === 'firing' ? assignRuns(conversationHistory(s,selected)) : undefined;
  for (const row of selected) {
    const key = args.groupBy === 'day' ? row.queuedAt.slice(0,10) : args.groupBy === 'model' ? row.usage?.model ?? null
      : args.groupBy === 'trigger' ? runs?.get(row.id)?.trigger ?? null
      : args.groupBy === 'firing' ? runs?.get(row.id)?.id ?? null : row.conversation;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key,group);
  }
  return [...groups].map(([key,group])=>{
    const sums = Object.fromEntries(additive.map(name=>[name,group.reduce<number|null>((sum,row)=>plus(sum,row.usage?.[name] ?? null),null)]));
    const largestContext = group.reduce<number|null>((max,row)=>{
      const value = row.usage?.largestContext;
      return value == null ? max : Math.max(max ?? 0,value);
    },null);
    return {key,title:args.groupBy === 'conversation' ? group[0].label ?? key : key,
      jobCount:group.length,retryCount:group.filter(row=>row.retryOf !== null).length,...sums,largestContext,
      totalTokens:plus(sums.tokensIn,sums.tokensOut)};
  });
}
export function jobUsageFields(s:JobSummaries, canRead:()=>boolean) {
  const range = {from:text,to:text};
  return {
    jobUsage:{type:recordType,args:{id:requiredText},resolve:(_:unknown,{id}:{id:string})=>canRead() ? records(s,rows(s,eq(jobs.id,id)))[0] ?? null : null},
    conversationJobUsage:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(recordType))),args:{conversation:text,...range},
      resolve:(_:unknown,args:Range)=>canRead() ? records(s,rows(s,cv=>windowFilter({...args,conversation:args.conversation ?? null},cv))) : []},
    jobUsageRollup:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupType))),args:{from:requiredText,to:requiredText,groupBy:requiredText,conversation:text},
      resolve:(_:unknown,args:Range & {groupBy:string})=>canRead() ? rollup(s,args) : []},
  };
}
