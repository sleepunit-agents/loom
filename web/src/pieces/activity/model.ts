/** Pure Activity vocabulary and derivation. No old store or UI imports. */
export type ActivityWhat = 'conversation' | 'work' | 'system';
export interface ActivityLink {label:string;href?:string}
export interface ActivityEntry {[key:string]:unknown;id:string;agent:string;at:string;day:string;hour:number;title:string;line?:string;venue:string;where:string;what:ActivityWhat;owner?:true;expires?:number}
export interface ActivityOpen extends ActivityEntry {asked:string[];decided:string[];story?:string;tasks:ActivityLink[];prs:ActivityLink[];links:ActivityLink[];needs?:string;steps?:Array<{label:string;state:string;tool:string}>;more:Array<{id:string;at:string;title:string}>}
export interface ActivityWindow {[key:string]:unknown;id:string;to:string;days:string[];earlier?:string;entries:ActivityEntry[];conversations:'available'|'unavailable'|'error';episodes:'available'|'unavailable'|'error';truncated:boolean;expires:number}
export const WINDOW_DAYS=3,MAX_BACK=30,MAX_ENTRIES=600;
export const VENUES:Record<string,string>={comms:'Comms',discord:'Discord',slack:'Slack',terminal:'Terminal',wakes:'Wakes',relay:'Relay',web:'Web',mcp:'MCP',voice:'Voice'};

export interface Filters {who:string[];where:string[];what:string[]}
export const passes=(e:ActivityEntry,f:Filters)=>(!f.who.length||f.who.includes(e.agent)||(!!e.owner&&f.who.includes('owner')))&&(!f.where.length||f.where.includes(e.venue))&&(!f.what.length||f.what.includes(e.what));
export const safeHref=(href?:string)=>href&&((href.startsWith('/')&&!href.startsWith('//')&&!/[\\\x00-\x20]/.test(href))||/^https:\/\//.test(href))?href:undefined;
export function address(f:Filters,id:string|undefined,day:string|undefined){const q=new URLSearchParams();for(const k of ['who','where','what'] as const)if(f[k].length)q.set(k,f[k].join(','));if(id)q.set('e',id);if(day)q.set('day',day);return '/p/activity-preview/'+(q.size?'?'+q.toString():'');}
export const filtersOf=(q:URLSearchParams):Filters=>Object.fromEntries(['who','where','what'].map(k=>[k,[...new Set((q.get(k)??'').split(',').filter(Boolean))].slice(0,20)])) as unknown as Filters;
