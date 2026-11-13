import { localOwner, sameLocalCaller } from './local-authority.js';
import { groupVouch } from './group-vouch.js';
import { installLocalStanding } from './local-standing.js';
import { registerBuiltinService } from '../../core/services.js';
import { z } from 'zod';
import { migrate, operation, maySee, mayAct, mayCreate, OperationError, type Viewer, type Sharing, type Db, type Operations, type Live, type LiveRecord } from '../../core/index.js';
import { schema } from './schema/001.js';
import { load, persist, readApproval, ruleId, installPrivateExport } from './store.js';
import { approvalScope as scope, type Caller, type Approval, type State, stateOf, ownerAnswered, iso, serviceOf, maySpend, forOf, type Rule, type Standing } from './model.js';
import { request, use, withdraw, answer, grant, find, allowEveryTime, standingMatch, always, alwaysScope, everyTimeOk, recordNotice, type DomainContext } from './domain.js';
import { rulesFor, setRule, type Project } from './rules.js';
import { denied, invalid, person } from './targets.js';
import { plain, headline, cardWords } from './words.js';
import { approvalCommands } from './commands.js';
import { command } from './binding.js';
import { callerSchema } from './validation.js';
import { auditRefusedUse } from './refusal.js';
import { answerAndApply, type ApprovalApplications } from './apply.js';
const week = 7 * 86400_000;
/** Implemented by the in-repo runtime, never by shelling out or reading the old stores. */
export interface ApprovalOptions {
  applications?: ApprovalApplications;
  caller?(viewer: Viewer, proof?: string): Caller | undefined;
  projects?(): Project[] | undefined;
  localAgent?: string;
}
export function installApprovals(db: Db, operations: Operations, live: Live, sharing: () => Sharing, options: ApprovalOptions = {}) {
  registerBuiltinService(operations, 'approvals', ['approval', 'approval-rule']);
  migrate(db,'approvals',schema);
  installPrivateExport(db);
  installLocalStanding(db,operations,sharing);
  const context = (viewer: Viewer, input: Record<string,unknown>, now: number, piece = false, window = false): DomainContext => {
    const resolved = piece ? input.caller as Caller : options.caller?.(viewer,typeof input.principal === 'string' ? input.principal : undefined);
    const caller: Caller = resolved ?? { who:{agent:viewer.id,where:'a body'},for:'?' };
    if (!callerSchema.safeParse(caller).success) denied('Invalid authenticated caller context');
    // A resolver cannot authenticate another agent under this viewer.
    if (viewer.kind === 'agent' && caller.who.agent !== viewer.id) denied('Caller agent does not match viewer');
    return { caller,now,piece,window,localAgent:options.localAgent ?? 'agent',projects:options.projects?.(),canRead:a=>(piece || !a.member || window) && visible(piece && caller.member ? {kind:'member',id:caller.member} : viewer,a) };
  };
  const visible = (viewer: Viewer, a: Approval) => maySee(viewer,scope(a),sharing());
  const owner = (v: Viewer, name: string) => mayAct(v,{type:'approval-rule'},sharing(),'household',name);
  const flush = (s: State, ctx: {now:number;changed(type:string,id:string):void}) => { for (const change of persist(db,s,ctx.now)) ctx.changed(change.type,change.id); };
  const register = (verb: string, write: boolean, run: (s:State,input:Record<string,unknown>,c:DomainContext,viewer:Viewer)=>unknown, config: { owner?:boolean; answer?:boolean; piece?:boolean; read?:boolean } = {}) => {
    const name = `approvals.${verb}`;
    const approvalId = ['check','use','use-local','withdraw','answer','open','always','every-time'].includes(verb.replace(/^piece-/,''));
    const payloadSchema = approvalId ? z.object({id:z.string().regex(/^a-[0-9a-f]{8}$/)}).catchall(z.unknown())
      : verb === 'standing-off' ? z.object({id:z.string().regex(/^s-[0-9a-f]{8}$/)}).catchall(z.unknown())
      : z.record(z.string(),z.unknown());
    const inputSchema = config.piece ? payloadSchema.and(z.object({caller:callerSchema}).catchall(z.unknown())) : payloadSchema;
    operations.register(operation({ name,write,recheckPolicy:!!config.piece||!!config.owner||approvalId,input:inputSchema,output:z.unknown(),cli:approvalCommands.find(c=>c.name===verb),...(config.piece ? {doors:['direct'] as ['direct']} : {}),
      requiresWindow: !config.piece && approvalId ? i=>!!readApproval(db,String(i.id))?.member : !config.piece && verb==='standing-off' ? i=>!!load(db).standing.find(j=>j.id===i.id)?.member : undefined,
      ...(['use','piece-use'].includes(verb) ? { rejected(viewer:Viewer,input:Record<string,unknown>,_failure:unknown,now:number) {
        if(config.piece && (viewer.kind!=='service'||!mayAct(viewer,{type:'approval'},sharing(),'act',name))) return;
        auditRefusedUse(db,input,context(viewer,input,now,!!config.piece).caller,now,!!config.piece);
      } } : {}),
      may(viewer,input) {
        if (config.owner) {
          if (!owner(viewer,name)) return false;
          if (verb === 'standing-off') {
            const j=load(db).standing.find(j=>j.id===input.id);
            return !!j && maySee(viewer,{type:'approval-rule',member:j.member,agent:j.agent,project:j.project},sharing());
          }
          if (verb === 'always' || verb === 'every-time') {
            const approval = readApproval(db,String(input.id));
            return !!approval && visible(viewer,approval);
          }
          return true;
        }
        if (config.piece) {
          if(viewer.kind!=='service'||!mayAct(viewer,{type:'approval'},sharing(),'act',name)) return false;
          if(verb === 'piece-request' || verb === 'piece-group-vouch') {
            const caller=context(viewer,input,operations.clock.now(),true).caller;
            // The service may file for its authenticated agent, whose attached
            // project must also pass the central creation rule.
            return mayCreate({kind:'agent',id:caller.who.agent},{type:'approval',agent:caller.who.agent,...(caller.project?{project:caller.project}:{})},sharing(),name);
          }
          if(!approvalId) return true;
          const approval=readApproval(db,String(input.id));
          if(verb==='piece-use-local' && approval?.member) {
            const caller=context(viewer,input,operations.clock.now(),true).caller;
            return viewer.id==='clock' && caller.member===approval.member && localOwner(caller,sharing());
          }
          return !approval||mayAct(viewer,scope(approval),sharing(),'act',name);
        }
        if (approvalId) {
          const a = readApproval(db,String(input.id)); if (!a) return maySee(viewer,{type:'approval',agent:viewer.id},sharing());
          if (config.answer) return mayAct(viewer,scope(a),sharing(),ownerAnswered.has(a.kind) ? 'household' : 'answer-person',name);
          return config.read ? visible(viewer,a) : mayAct(viewer,scope(a),sharing(),'act',name);
        }
        if (verb === 'request') {
          const c = context(viewer,input,operations.clock.now());
          return viewer.kind === 'agent' && mayCreate(viewer,{type:'approval',agent:viewer.id,...(c.caller.project ? {project:c.caller.project}:{})},sharing(),name);
        }
        if (verb === 'rules' || verb === 'history' || verb === 'notices') return viewer.kind === 'member' || viewer.kind === 'agent';
        return viewer.kind === 'agent' || owner(viewer,name);
      },
      run(ctx,input) {
        const s = load(db), c = context(ctx.viewer,input,ctx.now,!!config.piece,ctx.window);
        if((verb==='request'||verb==='piece-request') && c.caller.member) c.canRead=a=>maySee({kind:'member',id:c.caller.member!},scope(a),sharing());
        const result = run(s,input,c,ctx.viewer); if (write) flush(s,ctx); return result;
      },
    }));
  };
  register('request',true,(s,i,c)=>{const a=request(s,i,c);return a.member?{id:a.id,state:stateOf(a,c.now)}:a;});
  register('check',false,(s,i,c,v)=>{ const a=find(s,String(i.id)); if (i.json) { if (!maySpend(a.who,c.caller.who)) denied(`${a.id} isn't ${c.caller.who.agent}'s to read here; check ${a.id} gives its state`); return {id:a.id,agent:a.who.agent,for:forOf(a),state:stateOf(a,c.now),kind:a.kind,target:a.target,expires:stateOf(a,c.now)==='allowed'?a.expires:null}; } return {state:stateOf(a,c.now)}; },{read:true});
  register('use',true,(s,i,c)=>use(s,String(i.id),String(i.kind),String(i.target),c));
  register('withdraw',true,(s,i,c)=>withdraw(s,String(i.id),c));
  register('answer',true,(s,i,c,v)=>answerAndApply(s,String(i.id),String(i.action),v.id,c,options.applications ?? {}),{answer:true});
  register('open',false,(s,i,c,v)=>{const a=find(s,String(i.id)); return {open:stateOf(a,c.now)==='pending',mayAnswer:mayAct(v,scope(a),sharing(),ownerAnswered.has(a.kind)?'household':'answer-person','approvals.answer'),mayEveryTime:owner(v,'approvals.every-time')&&everyTimeOk(a,c),mayAlways:owner(v,'approvals.always')&&stateOf(a,c.now)==='pending'&&a.kind==='merge'&&forOf(a)!=='?',alwaysScope:alwaysScope(a,c.projects)};},{read:true});
  register('list',false,(s,i,c,v)=>({approvals:s.approvals.filter(a=>!!c.canRead?.(a)).map(a=>({...a,...cardWords(a),state:stateOf(a,c.now)})).sort((a,b)=>b.at.localeCompare(a.at))}));
  register('history',false,(s,i,c,v)=>({approvals:s.approvals.filter(a=>!!c.canRead?.(a)&&stateOf(a,c.now)!=='pending').map(a=>({...a,...cardWords(a),state:stateOf(a,c.now)})).sort((a,b)=>b.at.localeCompare(a.at))}));
  register('rules',false,(s,i,c,v)=>({rules:owner(v,'approvals.rules')?[...s.rules,...s.grants,...s.standing.filter(j=>(!j.member||c.window)&&maySee(v,{type:'approval-rule',agent:j.agent,project:j.project,member:j.member},sharing()))]:[],mayEdit:owner(v,'approvals.set-rule')}));
  const readRules = (s:State,i:Record<string,unknown>,c:DomainContext,v:Viewer) => {
    const approvals = s.approvals.filter(a=>!!c.canRead?.(a));
    let caller = c.caller;
    if (i.for !== undefined) {
      if (v.kind !== 'member' || !owner(v,'approvals.rules')) denied('--for is the owner’s view of an agent’s changes');
      const parsed = callerSchema.shape.who.shape.agent.safeParse(i.for);
      if (!parsed.success) throw new OperationError('invalid','--for is the agent whose change it is');
      caller = {who:{agent:parsed.data,where:'owner view'},for:'owner'};
    }
    const result = rulesFor({...s,approvals},caller,String(i.kind),Array.isArray(i.targets)?i.targets.map(String):[],c.projects,c.now);
    if (i.for !== undefined) {
      const pending = approvals.filter(a=>a.kind===i.kind&&a.who.agent===caller.who.agent&&Object.hasOwn(result,a.target)
        && ['pending','allowed'].includes(stateOf(a,c.now))&&!['owner','?'].includes(forOf(a)))
        .sort((a,b)=>Number(stateOf(b,c.now)==='pending')-Number(stateOf(a,c.now)==='pending')||b.at.localeCompare(a.at));
      for (const a of pending) {
        const row = result[a.target] as typeof result[string] & {asked_for?:{for:string;name:string;id:string;state:string}[]};
        const asked = row.asked_for ??= [];
        if (!asked.some(p=>p.for===forOf(a))) asked.push({for:forOf(a),name:forOf(a).split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ').slice(0,40),id:a.id,state:stateOf(a,c.now)});
      }
    }
    return result;
  };
  register('rule',false,readRules);
  register('set-rule',true,(s,i,c,v)=>setRule(s,String(i.kind),String(i.scope),String(i.tier),v.id,c.now,typeof i.person==='string'?i.person:undefined),{owner:true});
  register('always',true,(s,i,c,v)=>always(s,String(i.id),v.id,c,typeof i.scope==='string'?i.scope:undefined),{owner:true});
  register('every-time',true,(s,i,c,v)=>allowEveryTime(s,String(i.id),v.id,c),{owner:true});
  register('standing-off',true,(s,i,c,v)=>{ const j=s.standing.find(j=>j.id===i.id); if(!j) throw new OperationError('not-found','no such standing job'); j.off ??= {at:iso(c.now),by:v.id}; return j; },{owner:true});
  register('grant',true,(s,i,c,v)=>{const principal=typeof i.person==='string'?i.person:'owner'; if(i.person==='owner'||!person.test(principal)) invalid('--person is the slug of whom it is for; leave it out for owner');return grant(s,String(i.kind),String(i.target),String(i.for),v.id,!!i.deny,principal,c.now);},{owner:true});
  register('tell',true,recordNotice);
  register('notices',false,(s,i,c,v)=>({notices:s.notices.filter(n=>maySee(v,{type:'approval',agent:n.agent},sharing()))}));
  register('state',false,(s,i,c,v)=>({approvals:Object.fromEntries(s.approvals.filter(a=>Array.isArray(i.ids)&&i.ids.includes(a.id)&&c.canRead?.(a)).map(a=>[a.id,{state:stateOf(a,c.now),agent:a.who.agent,kind:a.kind,conversation:a.conversation??null,...(ownerAnswered.has(a.kind)?{target:a.target}:{})}]))}));
  // Services share the same registration, validation and scope checks as body operations.
  register('piece-request',true,(s,i,c)=>{
    if(i.kind==='local-wake' && c.caller.member!==undefined && !localOwner(c.caller,sharing())) denied('Local work requires a household owner’s authenticated conversation');
    return request(s,i,c);
  },{piece:true});
  register('piece-group-vouch',true,(s,i,c)=>groupVouch(s,i,c),{piece:true});
  register('piece-use',true,(s,i,c)=>use(s,String(i.id),String(i.kind),String(i.target),c),{piece:true});
  // Clock supplies the immutable filing, and this owning boundary compares the
  // live receipt before use mutates it. The outer Clock transaction owns both.
  register('piece-use-local',true,(s,i,c)=>{
    const expected = z.object({target:z.string(),digest:z.string().regex(/^[0-9a-f]{64}$/),details:z.string(),caller:callerSchema.strict()}).strict().parse(i.expected);
    const a=find(s,String(i.id));
    if (a.kind!=='local-wake' || a.target!==expected.target || a.digest!==expected.digest || a.details!==expected.details
      || !localOwner(c.caller,sharing()) || !localOwner(expected.caller,sharing())
      || !sameLocalCaller({...a,who:a.who},expected.caller) || !sameLocalCaller(c.caller,expected.caller)
      || a.who.agent!==expected.caller.who.agent || serviceOf(a.who)!==serviceOf(expected.caller.who)
      || c.caller.project!==a.project
      || c.caller.who.agent!==a.who.agent || serviceOf(c.caller.who)!==serviceOf(a.who))
      denied('The current local receipt differs from its exact filing or caller');
    return use(s,a.id,'local-wake',expected.target,c);
  },{piece:true});

  register('piece-withdraw',true,(s,i,c)=>withdraw(s,String(i.id),c),{piece:true});
  register('piece-rule',false,readRules,{piece:true});
  register('piece-tell',true,recordNotice,{piece:true});
  register('standing',true,(s,i,c)=>{
    if(c.caller.member || s.standing.some(j=>j.member && (j.id===i.check || j.agent===c.caller.who.agent&&j.target===i.target&&j.digest===i.digest)))denied('Private local authority uses the exact trusted Clock role');
    if(i.check) {const j=s.standing.find(j=>j.id===i.check&&j.agent===c.caller.who.agent);return {state:j?j.off?'off':'on':'none'};}
    const j=standingMatch(s,String(i.kind),String(i.target),String(i.digest),c);if(!j)throw new OperationError('not-found',`no standing job for ${i.kind} ${i.target}: it asks`);return j;
  },{piece:true});
  operations.register(operation({name:'approvals.command',write:true,input:z.object({argv:z.array(z.string()).max(100)}),output:z.object({exit:z.number(),stdout:z.string(),stderr:z.string()}),may:v=>v.kind==='agent'||v.kind==='member',run:(ctx,input)=>command(operations,ctx.viewer,input.argv)}));
  live.register({name:'approval',privateWindowOnly:true,ids:()=>load(db).approvals.map(a=>a.id),read(id,viewer){const a=readApproval(db,id);if(!a||!visible(viewer,a))return;const row=db.prepare('SELECT changed_at FROM approvals_approvals WHERE id=?').get(id) as {changed_at:number};return {...a,...cardWords(a),state:stateOf(a,operations.clock.now()),changedAt:row.changed_at} as unknown as LiveRecord;},inScope:(r,parent,now)=>parent===undefined&&(r.state==='pending'||Number(r.changedAt)+week>now),expires:r=>r.state==='pending'?undefined:r.state==='allowed'&&typeof r.expires==='string'?Math.min(Date.parse(r.expires),Number(r.changedAt)+week):Number(r.changedAt)+week});
  live.register({name:'approval-rule',privateWindowOnly:true,ids:()=>[...load(db).rules,...load(db).grants,...load(db).standing].map(ruleId),read(id,v){if(!owner(v,'approvals.rules'))return;const row=db.prepare('SELECT record FROM approvals_rules WHERE id=?').get(id) as {record:string}|undefined;if(!row)return;const record=JSON.parse(row.record);return maySee(v,{type:'approval-rule',agent:record.agent,member:record.member,project:record.project},sharing())?{...record,id}:undefined;},inScope:()=>true});
}
