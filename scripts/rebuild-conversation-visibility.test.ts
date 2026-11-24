import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {visibleTo,visibilityFailure,ObservedVisibilityFailure,restoreAndClose,redactSignin,inspectVisibility,applyCleanup,browserRead} from './rebuild-conversation-visibility.mjs';
import {evaluate} from './rebuild-report.mjs';
it('uses the approved private-member override before project or owned-agent access',()=>{
 const robin={id:'robin',role:'member',projects:['garden'],agents:['moss']};
 expect(visibleTo(robin,{member:'alex',project:'garden',agent:'moss'})).toBe(false);
 expect(visibleTo(robin,{member:'robin',project:null,agent:'fern'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'garden',agent:'fern'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'other',agent:'moss'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'other',agent:'fern'})).toBe(false);
 expect(visibleTo({...robin,projects:[],agents:[]},{member:null,project:'garden',agent:'moss'})).toBe(false);
 expect(visibleTo({...robin,role:'owner'},{member:'alex',project:'other',agent:'fern'})).toBe(false);
 expect(visibleTo({...robin,role:'owner'},{member:null,project:'garden',agent:'fern',direct:true})).toBe(false);
 expect(visibleTo(robin,{member:null,project:null,agent:'moss',direct:true})).toBe(true);
});
it('binds the actual conversation and Inbox promises to visibility and mailbox evidence',()=>{
 for(const [page,mapping] of [['conversations',{'conversations-022':'conversationLabels','conversations-023':'conversationLabels','conversations-024':'conversationVisibility'}],['inbox',{'inbox-006':'inboxRecipients','inbox-018':'inboxRecipients'}]]){
  const checklist=JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+page+'.json',import.meta.url),'utf8'));
  for(const [id,action] of Object.entries(mapping)){
   const promise=checklist.promises.find(row=>row.id===id);expect(promise.probe).toEqual({kind:'action',action});
   for(const [result,status] of [[{ok:true},'met'],[{ok:false,error:'Hidden row was received'},'not met'],[{inconclusive:true},'not checkable yet']])expect(evaluate(promise,{actions:{[action]:result}}).status).toBe(status);
  }
 }
});

it.each([['conversations','conversations-025','commsPrivacy'],['inbox','inbox-019','inboxVisibility']])('requires both private mail and approval evidence for %s', (page,id,privacy)=>{
 const checklist=JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+page+'.json',import.meta.url),'utf8'));
 const row=checklist.promises.find(promise=>promise.id===id);
 expect(row.probe).toEqual({kind:'all',probes:[privacy,'workVisibility'].map(action=>({kind:'action',action}))});
 for(const action of [privacy,'workVisibility']){
  const other=action===privacy?'workVisibility':privacy;
  for(const [result,status] of [[{ok:true},'met'],[{ok:false,error:'Unexpected access'},'not met'],[{inconclusive:true},'not checkable yet']])
   expect(evaluate(row,{actions:{[other]:{ok:true},[action]:result}}).status).toBe(status);
 }
});

it('attributes an observed failure only to its measured promise family',()=>{
 const outcome=visibilityFailure(new ObservedVisibilityFailure('Wrong Inbox recipient','inboxRecipients'));
 expect(outcome.inboxRecipients).toMatchObject({ok:false});for(const name of ['conversationLabels','conversationVisibility','commsPrivacy','inboxVisibility'])expect(outcome[name]).toMatchObject({inconclusive:true});
 expect(Object.values(visibilityFailure(new Error('measurement failed'))).every(row=>row.inconclusive&&!row.ok)).toBe(true);
});
it('closes the second context even when restoration fails and redacts sign-in failures',async()=>{
 let closed=false;await expect(restoreAndClose(()=>{throw Error('restore failed');},async()=>{closed=true;})).rejects.toThrow('restore failed');expect(closed).toBe(true);
 const path='/login/'+ 'ab'.repeat(32),error='Navigation failed http://127.0.0.1'+path+' Bearer fictitious-token loom_ui=fictitious-cookie;';const retained=redactSignin(error);
 for(const secret of [path,'fictitious-token','fictitious-cookie'])expect(retained).not.toContain(secret);
});

it('rejects actual missing and leaked projections instead of accepting their recorded fixture IDs',()=>{
 const member={id:'robin',role:'member',projects:['garden'],agents:['moss']};
 const rows=[{id:'public',agent:'fern',project:'garden',member:null},{id:'own',agent:'fern',project:null,member:'robin'},{id:'hidden',agent:'moss',project:'garden',member:'alex'},{id:'agent',agent:'moss',project:'other',member:null}];
 const threads=[{id:'hidden-thread',conversation:'hidden',agent:'moss',project:'garden',member:'alex'},{id:'own-thread',conversation:'own',agent:'fern',project:null,member:'robin'}];
 const inbox=[{id:'q',toKind:'person',to:'robin',agent:'fern',project:null,member:'robin',state:'waiting',volume:'full',waitsOnKind:null,waitsOnId:null},{id:'other',toKind:'person',to:'alex',agent:'moss',project:'garden',member:'alex',state:'waiting',volume:'full',waitsOnKind:null,waitsOnId:null},{id:'agent-mail',toKind:'agent',to:'fern',agent:'fern',project:'garden',member:null,state:'waiting',volume:'full',waitsOnKind:null,waitsOnId:null}];
 const truth={conversations:rows,threads,turns:rows.map(row=>({conversation:row.id,seq:1})),digests:rows.map(row=>({id:'dg-'+row.id,conversation:row.id})),digestItems:rows.map(row=>({digest:'dg-'+row.id})),inbox,items:inbox.map(row=>row.id),threadIDs:threads.map(row=>row.id),members:[{id:'alex'},{id:'robin'}],agents:[{id:'fern'},{id:'moss'}],task:()=>undefined,approval:()=>undefined};
 // Deliberately untyped: these GraphQL projections are corrupted into invalid shapes below.
 const reading:any={conversations:rows.filter(row=>visibleTo(member,row)),commsThreads:[threads[1]],turns:truth.turns.filter(row=>row.conversation!=='hidden'),digests:truth.digests.filter(row=>row.conversation!=='hidden'),digestItems:truth.digestItems.filter(row=>row.digest!=='dg-hidden'),inboxItems:[{id:'q',toKind:'person',to:'robin',state:'waiting',volume:'full'}],t0:null,t1:threads[1]};
 const project=row=>Object.fromEntries(['id','toKind','to','agent','project','member'].map(key=>[key,row[key]]));Object.assign(reading,{i0:project(inbox[0]),i1:null,i2:project(inbox[2])});
 expect(inspectVisibility(member,reading,truth)).toEqual({conversations:3,threads:1,mailbox:1});
 // Each mutator intentionally violates the response shape to exercise rejection.
 const wrong:[string,(row:any)=>void][]=[['conversationVisibility',row=>row.conversations.push(rows[2])],['conversationVisibility',row=>row.conversations.shift()],['conversationLabels',row=>row.conversations[0].agent='moss'],['commsPrivacy',row=>row.t0=threads[0]],['commsPrivacy',row=>row.t1=null],['conversationVisibility',row=>row.digestItems=[]],['inboxVisibility',row=>row.i1=project(inbox[1])],['inboxVisibility',row=>row.i0.member='alex'],['inboxRecipients',row=>row.inboxItems=[]],['inboxRecipients',row=>row.inboxItems[0].state='answered']];
 for(const [domain,mutate] of wrong){const corrupted=structuredClone(reading);mutate(corrupted);let outcome;try{inspectVisibility(member,corrupted,truth);}catch(error){outcome=visibilityFailure(error);}expect(outcome?.[domain],domain).toMatchObject({ok:false});}
});
it('retains observed violations if cleanup fails, and treats a failed browser read as unknown',async()=>{
 const failure=visibilityFailure(new ObservedVisibilityFailure('Hidden Inbox item','inboxVisibility'));applyCleanup(failure,{restored:false,contextClosed:false,credentialAbsent:true});expect(failure.inboxVisibility).toMatchObject({ok:false,cleanupError:expect.any(String)});expect(evaluate({probe:{kind:'action',action:'inboxVisibility'}},{actions:failure}).status).toBe('not met');
 let unknown;try{await browserRead({evaluate:async()=>({status:503,body:{}})},'{}');}catch(error){unknown=visibilityFailure(error);}expect(Object.values(unknown).every(row=>row.inconclusive&&row.ok!==true)).toBe(true);
});

it('keeps fixture authentication on the real operator client and rejects direct auth-store access',()=>{
 const source=readFileSync(new URL('./rebuild-conversation-visibility.mjs',import.meta.url),'utf8');
 // This is an architecture guard: fixtures may inspect app rows, but auth rows
 // must be produced by the ordinary operator listener and sign-in flow.
 const accepted=(text:string)=>/await requestLocalLink\(home,/.test(text)&&!/(?:services|s)\.signin\b|\bdb\.(?:exec|insert|update|delete)\s*\(|\b(?:from|join|into)\s+["`]?\b(?:tokens|sessions|signin_links)\b/i.test(text);
 expect(accepted(source)).toBe(true);
 expect(accepted(source.replace('await requestLocalLink(home,','await app.services.signin.issue(home,'))).toBe(false);
 expect(accepted(source+'\ndb.prepare("INSERT INTO tokens VALUES (?)").run();')).toBe(false);
 expect(accepted(source+'\ndb.prepare("SELECT * FROM sessions").all();')).toBe(false);
});
