import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {visibleTo} from './rebuild-conversation-visibility.mjs';
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
 for(const [page,mapping] of [['conversations',{'conversations-022':'conversationVisibility','conversations-023':'conversationVisibility','conversations-024':'conversationVisibility','conversations-025':'conversationVisibility'}],['inbox',{'inbox-006':'inboxRecipients','inbox-018':'inboxRecipients','inbox-019':'inboxVisibility'}]]){
  const checklist=JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+page+'.json',import.meta.url),'utf8'));
  for(const [id,action] of Object.entries(mapping)){
   const promise=checklist.promises.find(row=>row.id===id);expect(promise.probe).toEqual({kind:'action',action});
   for(const [result,status] of [[{ok:true},'met'],[{ok:false,error:'Hidden row was received'},'not met'],[{inconclusive:true},'not checkable yet']])expect(evaluate(promise,{actions:{[action]:result}}).status).toBe(status);
  }
 }
});
