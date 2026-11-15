import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {visibleTo,visibilityFailure,ObservedVisibilityFailure,restoreAndClose,redactSignin} from './rebuild-conversation-visibility.mjs';
import {evaluate} from './rebuild-report.mjs';
it('uses the approved private-member override before project or owned-agent access',()=>{
 const robin={id:'robin',role:'member',projects:['garden'],agents:['moss']};
 expect(visibleTo(robin,{member:'alex',project:'garden',agent:'moss'})).toBe(false);
 expect(visibleTo(robin,{member:'robin',project:null,agent:'fern'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'garden',agent:'fern'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'other',agent:'moss'})).toBe(true);
 expect(visibleTo(robin,{member:null,project:'other',agent:'fern'})).toBe(false);
 expect(visibleTo({...robin,projects:[],agents:[]},{member:null,project:'garden',agent:'moss'})).toBe(false);
 expect(visibleTo({...robin,role:'owner'},{member:'alex',project:'other',agent:'fern'})).toBe(true);
});
it('binds the actual conversation and Inbox promises to visibility and mailbox evidence',()=>{
 for(const [page,mapping] of [['conversations',{'conversations-022':'conversationLabels','conversations-023':'conversationLabels','conversations-024':'conversationVisibility','conversations-025':'commsPrivacy'}],['inbox',{'inbox-006':'inboxRecipients','inbox-018':'inboxRecipients','inbox-019':'inboxVisibility'}]]){
  const checklist=JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+page+'.json',import.meta.url),'utf8'));
  for(const [id,action] of Object.entries(mapping)){
   const promise=checklist.promises.find(row=>row.id===id);expect(promise.probe).toEqual({kind:'action',action});
   for(const [result,status] of [[{ok:true},'met'],[{ok:false,error:'Hidden row was received'},'not met'],[{inconclusive:true},'not checkable yet']])expect(evaluate(promise,{actions:{[action]:result}}).status).toBe(status);
  }
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
