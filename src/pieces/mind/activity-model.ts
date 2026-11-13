/** Pure Activity vocabulary and derivation. No old store or UI imports. */
export type ActivityWhat = 'conversation' | 'work' | 'system';
export interface ActivityLink {label:string;href?:string}
export interface ActivityEntry {[key:string]:unknown;id:string;agent:string;at:string;day:string;hour:number;title:string;line?:string;venue:string;where:string;what:ActivityWhat;owner?:true;expires?:number}
export interface ActivityOpen extends ActivityEntry {asked:string[];decided:string[];story?:string;tasks:ActivityLink[];prs:ActivityLink[];links:ActivityLink[];needs?:string;steps?:Array<{label:string;state:string;tool:string}>;more:Array<{id:string;at:string;title:string}>}
export interface ActivityWindow {[key:string]:unknown;id:string;to:string;days:string[];earlier?:string;entries:ActivityEntry[];conversations:'available'|'unavailable'|'error';episodes:'available'|'unavailable'|'error';truncated:boolean;expires:number}
export const WINDOW_DAYS=3,MAX_BACK=30,MAX_ENTRIES=600;
export const VENUES:Record<string,string>={comms:'Comms',discord:'Discord',slack:'Slack',terminal:'Terminal',wakes:'Wakes',relay:'Relay',web:'Web',mcp:'MCP',voice:'Voice'};
/** A venue or an episode's surface as the Where filter's key. */
export function venueKey(surface: string): string {
  const s = surface.toLowerCase();
  if (s === 'loom' || s === 'comms') return 'comms';
  if (s === 'wake' || s === 'lane' || s === 'local-lane' || s === 'alert' || s === 'schedule') return 'wakes';
  if (s === 'cli' || s === 'terminal' || s === 'session' || s === '?' || !s) return 'terminal';
  return s;
}

/** What an entry is about: the system's own upkeep, work that landed, or else a conversation. */
export function whatOf(e: { place?: string; title: string; line?: string; tasks?: string[] }): ActivityWhat {
  const text = `${e.title} ${e.line ?? ''}`;
  if (/^alert:/.test(e.place ?? '') || /\b(backups?|alerts?|disk|nearly full|box[- ]health|boxes|offsite|restic|service failed|unit [\w-]+ failed)\b/i.test(e.title)) return 'system';
  if (/\b(merged|deployed|shipped|released|closed t-\d+|PR (?:#?\d+ )?(?:is )?merged)\b/i.test(text)) return 'work';
  return 'conversation';
}

export const isoDay = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export const hourOf = (ms: number, tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))) % 24;
/** The day `n` days before YYYY-MM-DD (calendar arithmetic, zone-free). */
export function dayBefore(day: string, n = 1): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first sentence (or the first 200 characters) of a summary: an entry's one line. */
export function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,200}?[.!?])(?:\s|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > 200 ? `${out.slice(0, 199).trimEnd()}…` : out;
}

/** Refs a summary names: tasks (t-123) and pull requests (owner/repo#12, repo#12, a GitHub URL). */
export function refsIn(text: string, github?: string): { tasks: string[]; prs: ActivityLink[] } {
  const tasks = [...new Set([...text.matchAll(/\bt-\d{1,6}\b/g)].map((m) => m[0]))];
  const prs = new Map<string, ActivityLink>();
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) prs.set(`${m[1]}/${m[2]}#${m[3]}`, { label: `${m[2]}#${m[3]}`, href: m[0] });
  for (const m of text.matchAll(/(?<![\w/.-])(?:([\w.-]+)\/)?([a-z][\w.-]*)#(\d{1,6})\b/g)) {
    const owner = m[1] ?? github;
    if (!owner) continue;
    const key = `${owner}/${m[2]}#${m[3]}`;
    if (!prs.has(key)) prs.set(key, { label: `${m[2]}#${m[3]}`, href: `https://github.com/${owner}/${m[2]}/pull/${m[3]}` });
  }
  return { tasks, prs: [...prs.values()] };
}


export function splitTitle(t:string):{title:string;line?:string}{const m=/^(.{6,90}?):\s+(.{4,})$/.exec(t);return m&&!/^t-\d+$/.test(m[1])?{title:m[1],line:m[2]}:{title:t};}
/** Find the first instant of a local day, including half-hour zones and DST. */
export function startOf(day:string,tz:string):number {
 let lo=Date.parse(`${day}T00:00:00Z`)-36*3600000,hi=lo+72*3600000;
 while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(isoDay(mid,tz)<day)lo=mid;else hi=mid;}
 return hi;
}
export function windowDays(to:string,today:string):string[]{return Array.from({length:3},(_,i)=>dayBefore(to,i)).filter(d=>d>=dayBefore(today,MAX_BACK));}
export function validDay(day:string):boolean{return DAY.test(day)&&Number.isFinite(Date.parse(day))&&new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day;}

/** Contextual location words, without a store lookup or raw Comms thread id. */
export function whereLabel(where:string):string{
 if(!where||where==='?')return '';
 const [surface,...rest]=where.split(':'),names:Record<string,string>={slack:'Slack',discord:'Discord',wake:'Wake',web:'Web',cli:'Terminal',mcp:'MCP'};
 const name=names[surface]??(surface?surface[0].toUpperCase()+surface.slice(1):where);
 if(surface==='wake')return name;if(surface==='loom'||surface==='comms')return 'Comms';
 if(rest[0]==='dm'&&rest[1])return `${name} DM · ${rest.slice(1).join(':').split('-').map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(' ')}`;
 return rest.length?`${name} ${rest.join(':')}`:name;
}
