import type {ProjectRecord} from '../../../../src/pieces/mind/projects-model';
export type {ProjectRecord,ProjectItem,ProjectSection,ProjectMemory} from '../../../../src/pieces/mind/projects-model';
export function projects(rows:readonly ProjectRecord[],folder:string,query:string,agent:string){
 const words=query.toLowerCase().trim().split(/\s+/);
 const rank=(p:ProjectRecord)=>p.waiting.length?0:p.unknown?1:2;
 return rows.filter(p=>!p.archived&&(folder==='quiet'?p.card.status!=='active':p.card.status==='active')&&(!agent||p.agent===agent)&&words.every(w=>[p.name,p.slug,p.agent,p.card.summary,p.card.goal,...(p.card.links.repos??[])].join(' ').toLowerCase().includes(w))).sort((a,b)=>rank(a)-rank(b)||Date.parse(b.activity)-Date.parse(a.activity)||a.id.localeCompare(b.id));
}
export const whatOf=(summary?:string)=>{const text=(summary??'').trim().split(/\n\s*\n/)[0].replace(/\s+/g,' ');return (/^.+?[.!?](?=\s|$)/.exec(text)?.[0]??text).slice(0,200);};
export function safeHref(href?:string){return href&&(/^\/p\/[a-z][a-z0-9-]*(?:\/[^\s<>"\\]*)?$/.test(href)||/^https:\/\/[^\s<>"\\]+$/.test(href))?href:undefined;}

export function age(when:string,now=Date.now()) {const ms=now-Date.parse(when);if(!Number.isFinite(ms))return when;const minutes=Math.max(0,Math.floor(ms/60000));return minutes<1?'just now':minutes<60?`${minutes}m ago`:minutes<1440?`${Math.floor(minutes/60)}h ago`:`${Math.floor(minutes/1440)}d ago`;}
