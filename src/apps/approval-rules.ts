/** Standing answers over the approved table. The caller supplies trusted actingFor
 * context; query text or a merely readable record cannot supply that identity. */
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { OperationError } from '../core/operations/index.js';
import { approvalRules, members, projects } from '../core/data/schema.js';
const kind=z.enum(['merge','command','setting','dangerous']);
const scope=z.string().trim().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Invalid scope');
export const approvalRuleInput=z.object({kind,scope,person:z.string().max(100).default(''),tier:z.enum(['ask','tell','do']).nullable()}).strict();
export type RuleInput=z.input<typeof approvalRuleInput>;
type Rule=typeof approvalRules.$inferSelect;
/** Linear-space wildcard matching; a pattern cannot introduce a regular expression. */
function matches(pattern:string,text:string){
  let previous=Array<boolean>(text.length+1).fill(false);previous[0]=true;
  for(const character of pattern){
    const next=Array<boolean>(text.length+1).fill(false);next[0]=character==='*'&&previous[0];
    for(let i=1;i<=text.length;i++)next[i]=character==='*' ? previous[i]||next[i-1] : previous[i-1]&&character===text[i-1];
    previous=next;
  }
  return previous[text.length];
}
export function approvalRulesService(db:DataDatabase,now:()=>string){
  const owner=(id:string)=>db.select().from(members).where(and(eq(members.id,id),eq(members.role,'owner'))).get();
  const canonical=(input:RuleInput)=>{
    const value=approvalRuleInput.parse(input);
    if(value.scope.startsWith('project:')){
      if(value.tier!==null&&!db.select().from(projects).where(eq(projects.id,value.scope.slice(8))).get())throw new OperationError('invalid','Unknown project scope');
    }else if(value.kind==='merge'){
      if(value.scope!=='*'&&!/^github:[A-Za-z0-9._*-]+\/[A-Za-z0-9._*-]+$/.test(value.scope))throw new OperationError('invalid','Use a repository pattern or project scope');
      value.scope=value.scope.toLowerCase();
    }
    if(value.tier!==null&&value.person&&!db.select().from(members).where(eq(members.id,value.person)).get())throw new OperationError('invalid','Unknown person');
    return value;
  };
  return {
    set(input:RuleInput,by:string){
      return db.transaction(()=>{
        if(!owner(by))throw new OperationError('denied','A household owner is required');
        const value=canonical(input),key={kind:value.kind,scope:value.scope,person:value.person};
        if(value.tier===null)db.delete(approvalRules).where(and(eq(approvalRules.kind,key.kind),eq(approvalRules.scope,key.scope),eq(approvalRules.person,key.person))).run();
        else db.insert(approvalRules).values({...key,tier:value.tier,setBy:by,setAt:now()}).onConflictDoUpdate({target:[approvalRules.kind,approvalRules.scope,approvalRules.person],set:{tier:value.tier,setBy:by,setAt:now()}}).run();
        return key;
      });
    },
    list(){return db.select().from(approvalRules).orderBy(asc(approvalRules.kind),asc(approvalRules.scope),asc(approvalRules.person)).all();},
    /** No executor: a trusted caller consumes this answer in its own current
     * command/approval checks. Unknown principals always ask. Named-person
     * grants never become household rules and stale setters grant nothing. */
    resolve(input:{kind:Rule['kind'];target:string;project?:string|null;actingFor:string}):Pick<Rule,'tier'|'scope'|'person'|'setBy'>|undefined{
      if(!input.actingFor||['unknown','?'].includes(input.actingFor)||input.target.length>8192)return;
      const principal=input.actingFor==='owner'?undefined:db.select().from(members).where(eq(members.id,input.actingFor)).get();
      if(input.actingFor!=='owner'&&!principal)return;
      const person=input.actingFor==='owner'||principal?.role==='owner'?'':input.actingFor;
      const target=input.kind==='merge'?/^github:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#[1-9][0-9]*@[a-f0-9]{40}$/.exec(input.target)?.[1]:input.target;
      if(!target)return;
      const lookup=input.kind==='merge'?`github:${target.toLowerCase()}`:target;
      const hits=db.select().from(approvalRules).where(and(eq(approvalRules.kind,input.kind),eq(approvalRules.person,person))).all().flatMap(rule=>{
        if(!owner(rule.setBy))return [];
        const project=rule.scope.startsWith('project:');
        if(project&&!db.select().from(projects).where(eq(projects.id,rule.scope.slice(8))).get())return [];
        if(project?rule.scope!==`project:${input.project}`:!matches(rule.scope,lookup))return [];
        return [{rule,rank:project?1:rule.scope==='*'?3:rule.scope.includes('*')?2:0,stars:rule.scope.split('*').length-1}];
      });
      const strict={ask:0,tell:1,do:2};hits.sort((a,b)=>a.rank-b.rank||a.stars-b.stars||strict[a.rule.tier]-strict[b.rule.tier]||a.rule.scope.localeCompare(b.rule.scope));
      const row=hits[0]?.rule;return row&&{tier:row.tier,scope:row.scope,person:row.person,setBy:row.setBy};
    },
  };
}
