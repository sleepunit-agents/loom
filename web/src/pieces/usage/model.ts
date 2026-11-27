/** What the Job usage app reads and says, with no component: its two selections, the order of its conversations,
 * the names of a job's measurements and the range of local days it asks for. The desktop's app (./index.tsx) and
 * the boards page's `usage` brick share them. */
export const conversationsQuery = `query UsageConversations($from:String!, $to:String!) {
  jobUsageRollup(from:$from,to:$to,groupBy:"conversation"){key title totalTokens jobCount retryCount largestContext jobsWithLargestContext}
}`;
export const jobsQuery = `query UsageJobs($from:String!, $to:String!, $conversation:String) {
  conversationJobUsage(from:$from,to:$to,conversation:$conversation){id title runKind linkedWakeJob state observations usage{
    harness model source tokensIn tokensOut cacheRead cacheWritten modelCalls toolCalls tools{name count} firstContext largestContext wallMs
  }}
}`;
export interface UsageGroup {key:string|null; title:string|null; totalTokens:number|null; jobCount:number; retryCount:number; largestContext:number|null; jobsWithLargestContext:number}
export const metrics = {
  tokensIn:'Input tokens',tokensOut:'Output tokens',cacheRead:'Cache read',cacheWritten:'Cache written',
  modelCalls:'Model calls',toolCalls:'Tool calls',firstContext:'First-call context',largestContext:'Largest context',wallMs:'Wall time (ms)',
} as const;
export type Measurement = Record<keyof typeof metrics,number|null> & {
  harness:string|null; model:string|null; source:string; tools:{name:string;count:number}[]|null;
};
export interface UsageJob {id:string;title:string;runKind:string|null;linkedWakeJob:string|null;state:string;observations:string[];usage:Measurement|null}
export interface UsageRange {from:string;to:string}
export const format=(value:number|null|undefined)=>value==null?'Unknown':value.toLocaleString();

/** Conversations by reported tokens, most first; one with none reported last, then by its key. */
export const byTokens=(rows:readonly UsageGroup[])=>[...rows].sort((a,b)=>(b.totalTokens??-1)-(a.totalTokens??-1)||(a.key??'').localeCompare(b.key??''));
export const groupTitle=(g:UsageGroup)=>g.title||g.key||'Jobs without a conversation';
export const runKindWord=(runKind:string|null)=>runKind && (runKind==='program'?'Program':runKind==='main'?'Main session':'Subagent');
export const toolsLine=(usage:Measurement|null)=>usage?.tools ? usage.tools.map(tool=>tool.name+' × '+format(tool.count)).join(', ')||'None' : 'Unknown';
export function localDay(offset:number) {
  const date=new Date();
  date.setDate(date.getDate()+offset);
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
export function midnight(day:string,offset=0) {
  const date=new Date(day+'T00:00:00');
  date.setDate(date.getDate()+offset);
  return date;
}
/** The range the app asks for: from the first local day's midnight to the midnight after the last. */
export const dayRange=(first:string,last:string):UsageRange=>({from:midnight(first).toISOString(),to:midnight(last,1).toISOString()});
