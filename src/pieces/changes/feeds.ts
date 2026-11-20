/** Compact legacy feed shapes; authorization and task derivation precede presentation. */
import { groups, short, type Change } from './model.js';
export type Decorated = Change & { group: typeof groups[number]; words: string; status: string; conversation?: string };
const titles = {you:'Waiting on you',agent:'Ready to merge',ci:'Waiting on CI',reviewer:'Waiting on a reviewer',author:'Waiting on its author',done:'Lately'};
function title(c:Change) {
 const text=`${short(c)} ${c.title}`;
 if(text.length<=200) return text;
 const prefix=text.slice(0,199),space=prefix.lastIndexOf(' ');
 return (space<0?prefix:prefix.slice(0,space))+'…';
}
const item=(c:Decorated,now:number)=>({title:title(c),when:new Date(Number.isFinite(Date.parse(c.updated??''))?Date.parse(c.updated!):now).toISOString().replace('.000Z','Z'),status:c.status.slice(0,24),ref:c.id.slice(0,200),page:c.page});
export function projectFeed(changes:Decorated[],now:number) {
 let remaining=50;
 return {groups:groups.flatMap(group=>{
  const items=changes.filter(c=>c.group===group).slice(0,remaining).map(c=>({...item(c,now),who:[(c.author.name||c.author.login||'someone').slice(0,80)]}));
  remaining-=items.length;
  return items.length?[{title:titles[group],...(group==='you'?{waiting:true}:{}),items}]:[];
 })};
}
export function threadFeed(changes:Decorated[],conversation:string,references:string[],now:number,hidden:Set<string>) {
 const out:Record<string,unknown>[]=[],seen=new Set<string>();
 const add=(c:Decorated,made:boolean)=>{
  const tone=['CI red','Conflicts','Changes asked for',"Can't be merged"].includes(c.status)?'bad':c.group==='you'?'warn':c.state==='merged'?'ok':undefined;
  out.push({...item(c,now),...(tone?{tone}:{}),...(made?{made:true}:{})});seen.add(c.id);
 };
 for(const c of changes.filter(c=>c.conversation===conversation).sort((a,b)=>Date.parse(b.updated??'')-Date.parse(a.updated??''))) add(c,true);
 for(const raw of references) {
  if(!/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]{0,9}$/.test(raw)) continue;
  const id=raw.toLowerCase();if(seen.has(id)||hidden.has(id)) continue;
  seen.add(id);const c=changes.find(c=>c.id===id);
  if(c) add(c,false);
  else {const [repo,n]=id.slice(7).split('#');out.push({title:`${repo}#${n}`.slice(0,200),ref:id.slice(0,200),status:'Not tracked',href:`https://github.com/${repo}/issues/${n}`});}
 }
 return {items:out.slice(0,50)};
}
