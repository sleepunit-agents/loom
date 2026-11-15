/** Work visibility through real authenticated GraphQL, in the running disposable
 * home. Credentials are issued/revoked by Sign-in; no seeded token/session rows. */
import {join} from 'node:path';
export async function workVisibility({page,app,example,out}){
 const screenshot='action-workVisibility.png',s=app.services,write=fn=>app.writes.run(fn).value,tokens=[];
 const check=(v,m)=>{if(!v)throw Error(m);};let machine,outcome;
 const errorText=error=>tokens.reduce((text,issued)=>text.replaceAll(issued.token,'[fictitious credential redacted]'),String(error));
 const token=input=>{const issued=write(()=>s.signin.issue(input));tokens.push(issued);return issued.token;};
 const request=async(path,input,credential,id)=>{
  const response=await app.http.request(app.url+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify({input,id})});
  const result=await response.json();check(response.ok&&result.ok===true,`Disposable operation refused: ${path}`);return result.value;
 };
 const query=async (credential,deniedMachine=false)=>{
  const response=await app.http.request(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify({query:'{ tasks { id ownerKind owner project } approvals { id member project agent } approvalRecord { approval } changes { id project agent } }'})});
  const result=await response.json();if(deniedMachine&&response.status===403){check(result.data===undefined,'Denied machine received data');return {tasks:[],approvals:[],approvalRecord:[],changes:[]};}check(response.ok&&!result.errors,`Work GraphQL read failed (${response.status}): ${JSON.stringify(result.errors??result.code)}`);return result.data;
 };
 const has=(rows,id)=>rows.some(row=>row.id===id);
 try{
  const alex=token({kind:'owner',member:'alex',label:'Fictitious work proof Alex'}),robin=token({kind:'owner',member:'robin',label:'Fictitious work proof Robin'}),fern=token({kind:'agent',agent:'fern',label:'Fictitious work proof Fern'});
  machine=await request('/api/runtime/boxCreate',{name:'Fictitious work visibility machine',sameMachineAsLoom:false},alex,'work-visibility-machine');
  const runner=token({kind:'runner',box:machine.id,label:'Fictitious work proof machine'});
  const actor={kind:'member',id:'alex'};
  const task=owner=>write(()=>s.tasks.create({title:`Fictitious private ${owner.kind} work`,goal:'Prove visibility.',why:'Exercise outside work reads.',owner},actor));
  const memberTask=task({kind:'member',id:'robin'}),agentTask=task({kind:'agent',id:'moss'}),directTask=task({kind:'agent',id:'fern'}),houseTask=task({kind:'household'});
  const projectTask=write(()=>s.tasks.create({title:'Fictitious project precedence',goal:'Project overrides owner.',why:'Prove labelled task scope.',owner:{kind:'member',id:'robin'},project:'garden'},actor));
  const card=extra=>write(()=>s.approvals.request({kind:'command',target:'fictitious:visibility',what:'Fictitious visibility request',why:'Prove work labels.',agent:'fern',askedFrom:'fictitious-proof',actingFor:'alex',ask:'Allow the fictitious visibility action?',ifYes:'Proceed.',ifNo:'Wait.',...extra}));
  const privateCard=card({project:'garden',member:'robin'}),projectCard=card({project:'garden'}),agentCard=card({agent:'moss'}),sharedAgentCard=card({agent:'moss',project:'garden'}),directCard=card({});
  write(()=>s.household.setProject({id:'shed',name:'Example shed',members:['alex'],agents:['moss'],repositories:['example-house/shed']}));
  write(()=>s.household.setGithubAccounts({agent:'moss',logins:['example-moss']}));
  const at=new Date().toISOString(),privateChange=s.changes.put({id:'github:example-house/shed#99',repo:'github:example-house/shed',number:99,page:'',title:'Fictitious private shed change',body:'Visibility proof.',url:'https://github.com/example-house/shed/pull/99',state:'closed',draft:false,author:{login:'example-moss'},created:at,updated:at,closed:at,head:{ref:'visibility',id:'c'.repeat(40)},base:{ref:'next'},checks:{state:'none',failing:[],running:[],total:0},review:{state:'not_required',by:[]},mergeable:'yes',conflicts:false,people:[]});
  const sharedAgentChange=s.changes.put({id:'github:example-house/garden#98',repo:'github:example-house/garden',number:98,page:'',title:'Fictitious shared owned-agent change',body:'Visibility proof.',url:'https://github.com/example-house/garden/pull/98',state:'closed',draft:false,author:{login:'example-moss'},created:at,updated:at,closed:at,head:{ref:'visibility',id:'d'.repeat(40)},base:{ref:'next'},checks:{state:'none',failing:[],running:[],total:0},review:{state:'not_required',by:[]},mergeable:'yes',conflicts:false,people:[]});
  const directChange=s.changes.put({id:'github:example-house/fern#97',repo:'github:example-house/fern',number:97,page:'',title:'Fictitious direct agent change',body:'Visibility proof.',url:'https://github.com/example-house/fern/pull/97',state:'closed',draft:false,author:{login:'example-fern'},created:at,updated:at,closed:at,head:{ref:'visibility',id:'e'.repeat(40)},base:{ref:'next'},checks:{state:'none',failing:[],running:[],total:0},review:{state:'not_required',by:[]},mergeable:'yes',conflicts:false,people:[]});
  write(()=>s.tasks.claim(agentTask.id,{kind:'agent',id:'moss'}));
  const trusted={tasks:s.tasks.list(),approvals:s.approvals.list(),changes:s.changes.list()};
  const owner=await query(alex),member=await query(robin),agent=await query(fern),box=await query(runner,true);
  for(const key of ['tasks','approvals','changes'])check(owner[key].map(row=>row.id).sort().join(',')===trusted[key].map(row=>row.id).sort().join(','),'Household owner did not see all trusted work');
  check(owner.approvalRecord.some(event=>event.approval===example.approval)&&owner.approvalRecord.some(event=>event.approval===privateCard.id),'Fixture audit events were not present for privacy checks');
  check(privateChange.project==='shed'&&s.changes.get(example.change).project==='garden','Household changes did not span its projects');
  const columns=await app.http.request(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+alex},body:JSON.stringify({query:'{ readyTasks { id } garden:tasks(where:{project:{eq:"garden"}}){id status priority ownerKind owner project assigneeKind assignee} assigned:tasks(where:{assignee:{eq:"moss"},status:{eq:in_progress}}){id} }'})});
  const selections=await columns.json();check(columns.ok&&!selections.errors,'Column-based work queries failed');
  const ids=rows=>rows.map(row=>row.id).sort().join(',');
  check(ids(selections.data.readyTasks)===ids(s.tasks.ready())&&ids(selections.data.garden)===ids(trusted.tasks.filter(row=>row.project==='garden'))&&ids(selections.data.assigned)===ids(trusted.tasks.filter(row=>row.assignee==='moss'&&row.status==='in_progress')),'Ready/project/assignment did not each use a generated column query');
  const expectedMember={tasks:trusted.tasks.filter(row=>row.project==='garden'||row.project===null&&(row.ownerKind==='member'&&row.owner==='robin'||row.ownerKind==='agent'&&row.owner==='moss')),approvals:trusted.approvals.filter(row=>row.member==='robin'||!row.member&&(row.project==='garden'||row.agent==='moss')),changes:trusted.changes.filter(row=>row.project==='garden'||row.agent==='moss')};
  const expectedAgent={tasks:trusted.tasks.filter(row=>row.project==='garden'||row.project===null&&row.ownerKind==='agent'&&row.owner==='fern'),approvals:trusted.approvals.filter(row=>!row.member&&(row.project==='garden'||row.agent==='fern')),changes:trusted.changes.filter(row=>row.project==='garden'||row.agent==='fern')};
  for(const key of ['tasks','approvals','changes']){check(ids(member[key])===ids(expectedMember[key]),'Member received an unexpected work ID');check(ids(agent[key])===ids(expectedAgent[key]),'Agent received an unexpected work ID');}
  check(has(agent.approvals,directCard.id)&&has(agent.changes,directChange.id),'Agent own unlabelled approval/change missing');
  check(has(member.tasks,memberTask.id)&&has(member.tasks,agentTask.id)&&!has(member.tasks,houseTask.id)&&has(member.tasks,example.tasks[0]),'Member/project/agent task ownership was not applied');
  check(!has(agent.tasks,memberTask.id)&&!has(agent.tasks,agentTask.id)&&!has(agent.tasks,houseTask.id)&&has(agent.tasks,directTask.id)&&has(agent.tasks,example.tasks[0]),'Agent task scope was not applied');
  check(has(member.approvals,privateCard.id)&&has(member.approvals,projectCard.id)&&has(member.approvals,agentCard.id)&&!has(member.approvals,example.approval),'Member private/project/owned-agent approvals were not scoped');
  check(!has(agent.approvals,privateCard.id)&&has(agent.approvals,projectCard.id)&&!has(agent.approvals,agentCard.id)&&!has(agent.approvals,example.approval),'Agent/private approval scope was not applied');
  check(has(member.changes,privateChange.id)&&has(member.changes,example.change)&&!has(agent.changes,privateChange.id)&&has(agent.changes,example.change),'Change project/owned-agent scope was not applied');
  for(const result of [member,agent,box])check(result.approvalRecord.every(event=>has(result.approvals,event.approval)),'Audit record leaked a hidden approval');
  check(box.tasks.length===0&&box.approvals.length===0&&box.changes.length===0,'Machine credential read household work');
  const anonymous=await app.http.request(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id } approvals { id } approvalRecord { approval } changes { id } }'})});const anonymousBody=await anonymous.json();
  if(anonymous.status===401||anonymous.status===403)check(anonymousBody.data===undefined,'Denied anonymous caller received work');
  else check(anonymous.status===200&&['tasks','approvals','approvalRecord','changes'].every(key=>Array.isArray(anonymousBody.data?.[key])&&anonymousBody.data[key].length===0),'Anonymous outside caller received work');
  write(()=>s.household.setProject({id:'garden',name:'Example garden',members:['alex'],agents:['fern','moss'],repositories:['example-house/garden']}));
  const withdrawn=await query(robin);
  const expectedWithdrawn={tasks:trusted.tasks.filter(row=>row.project===null&&(row.ownerKind==='member'&&row.owner==='robin'||row.ownerKind==='agent'&&row.owner==='moss')),approvals:trusted.approvals.filter(row=>row.member==='robin'||!row.member&&row.agent==='moss'),changes:trusted.changes.filter(row=>row.agent==='moss')};
  for(const key of ['tasks','approvals','changes'])check(ids(withdrawn[key])===ids(expectedWithdrawn[key]),'Withdrawal leaked or removed unexpected work');
  check(!has(withdrawn.tasks,example.tasks[0])&&!has(withdrawn.changes,example.change)&&!has(withdrawn.approvals,projectCard.id)&&has(withdrawn.approvals,privateCard.id)&&has(withdrawn.approvals,agentCard.id)&&has(withdrawn.approvals,sharedAgentCard.id)&&has(withdrawn.changes,sharedAgentChange.id)&&has(withdrawn.changes,privateChange.id)&&has(withdrawn.tasks,memberTask.id)&&has(withdrawn.tasks,agentTask.id)&&!has(withdrawn.tasks,projectTask.id)&&withdrawn.approvalRecord.every(event=>has(withdrawn.approvals,event.approval)),'Project withdrawal did not remove only the project-based visibility');
  write(()=>{
   s.household.setProject({id:'garden',name:'Example garden',members:['alex','robin'],agents:['fern','moss'],repositories:['example-house/garden']});
   for(const row of [memberTask,agentTask,directTask,houseTask,projectTask])s.tasks.close(row.id,'Visibility evidence complete.');
   for(const row of [privateCard,projectCard,agentCard,sharedAgentCard,directCard])s.approvals.withdraw(row.id,row.agent);
  });
  await page.screenshot({path:join(out,screenshot),fullPage:true});return outcome={taskQueries:{ok:true,screenshot},workVisibility:{ok:true,screenshot,callers:['owner','member','agent','machine','anonymous'],projectWithdrawal:true}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return outcome={workVisibility:{ok:false,error:errorText(error),screenshot}};}
 finally{
  let failures=0;
  if(machine){const owner=tokens[0];if(owner)try{await request('/api/runtime/boxRevoke',{box:machine.id},owner.token,'work-visibility-machine-revoke');}catch{failures++;}}
  for(const issued of tokens)try{write(()=>s.signin.revoke(issued.fingerprint));}catch{failures++;}
  if(failures&&outcome){outcome.workVisibility.ok=false;outcome.workVisibility.error='Disposable credential cleanup failed';outcome.workVisibility.cleanupFailures=failures;}
 }
}
