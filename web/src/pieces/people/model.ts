import type { PersonRecord } from '../../../../src/pieces/mind/people-model';
export type Person = PersonRecord;
export function contacts(records:readonly Person[],folder:string,query:string,agent:string) {
  const groups=new Map<string,{person:Person;relationships:Person[]}>();
  for(const p of records) if(!p.agent) groups.set(p.slug,{person:p,relationships:[]});
  for(const p of records) if(p.agent) {
    const group=groups.get(p.slug);
    if(group) group.relationships.push(p);else groups.set(p.slug,{person:p,relationships:[p]});
  }
  const needle=query.trim().toLocaleLowerCase();
  return [...groups.values()].filter(g=>(folder==='all'||g.person.kind===folder)&&(!agent||g.relationships.some(p=>p.agent===agent))&&`${g.person.name} ${g.person.slug} ${g.person.card.summary??''} ${g.relationships.map(p=>`${p.agent} ${records.find(r=>!r.agent&&r.slug===p.agent)?.name??''}`).join(' ')}`.toLocaleLowerCase().includes(needle)).sort((a,b)=>a.person.name.localeCompare(b.person.name));
}
export function contactLink(channel:string,value:unknown):string|undefined {
  if(typeof value!=='string') return;
  if(channel==='email') return `mailto:${encodeURIComponent(value)}`;
  if(channel==='phone') return `tel:${value.replace(/[^+\d]/g,'')}`;
  if(channel==='github' && /^[\w-]+$/.test(value.replace(/^@/,''))) return `https://github.com/${value.replace(/^@/,'')}`;
  if(channel==='discord' && /^\d+$/.test(value)) return `https://discord.com/users/${value}`;
  if(/^https?:\/\//.test(value)) return value;
}
