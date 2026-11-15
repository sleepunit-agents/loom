/** Work visibility through real authenticated GraphQL, in the running disposable
 * home. Credentials are issued/revoked by Sign-in; no seeded token/session rows. */
import {join} from 'node:path';
export async function workVisibility({page,app,example,out}){
 const screenshot='action-workVisibility.png',s=app.services,write=fn=>app.writes.run(fn).value,tokens=[];
 const check=(v,m)=>{if(!v)throw Error(m);};let machine;
 const token=input=>{const issued=write(()=>s.signin.issue(input));tokens.push(issued);return issued.token;};
 const request=async(path,input,credential,id)=>{
  const response=await app.http.request(app.url+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify({input,id})});
  const result=await response.json();check(response.ok&&result.ok===true,`Disposable operation refused: ${path}`);return result.value;
 };
 const query=async credential=>{
  const response=await app.http.request(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify({query:'{ tasks { id ownerKind owner project } approvals { id member project agent } approvalRecord { approval } changes { id project agent } }'})});
  const result=await response.json();check(response.ok&&!result.errors,'Work GraphQL read failed');return result.data;
 };
 const has=(rows,id)=>rows.some(row=>row.id===id);
 try{
  const alex=token({kind:'owner',member:'alex',label:'Fictitious work proof Alex'}),robin=token({kind:'owner',member:'robin',label:'Fictitious work proof Robin'}),fern=token({kind:'agent',agent:'fern',label:'Fictitious work proof Fern'});
  machine=await request('/api/runtime/boxCreate',{name:'Fictitious work visibility machine',sameMachineAsLoom:false},alex,'work-visibility-machine');
  const runner=token({kind:'runner',box:machine.id,label:'Fictitious work proof machine'});
  const actor={kind:'member',id:'alex'};
  const task=owner=>write(()=>s.tasks.create({title:`Fictitious private ${owner.kind} work`,goal:'Prove visibility.',why:'Exercise outside work reads.',owner},actor));
  const memberTask=task({kind:'member',id:'robin'}),agentTask=task({kind:'agent',id:'moss'}),houseTask=task({kind:'household'});
  const card=extra=>write(()=>s.approvals.request({kind:'command',target:'fictitious:visibility',what:'Fictitious visibility request',why:'Prove work labels.',agent:'fern',askedFrom:'fictitious-proof',actingFor:'alex',ask:'Allow the fictitious visibility action?',ifYes:'Proceed.',ifNo:'Wait.',...extra}));
  const privateCard=card({project:'garden',member:'robin'}),projectCard=card({project:'garden'}),agentCard=card({agent:'moss'});
  write(()=>s.household.setGithubAccounts({agent:'moss',logins:['example-moss']}));
  const at=new Date().toISOString(),privateChange=s.changes.put({id:'github:example-house/shed#99',repo:'github:example-house/shed',number:99,page:'',title:'Fictitious private shed change',body:'Visibility proof.',url:'https://github.com/example-house/shed/pull/99',state:'closed',draft:false,author:{login:'example-moss'},created:at,updated:at,closed:at,head:{ref:'visibility',id:'c'.repeat(40)},base:{ref:'next'},checks:{state:'none',failing:[],running:[],total:0},review:{state:'not_required',by:[]},mergeable:'yes',conflicts:false,people:[]});
  const trusted={tasks:s.tasks.list(),approvals:s.approvals.list(),changes:s.changes.list()};
  const owner=await query(alex),member=await query(robin),agent=await query(fern),box=await query(runner);
  for(const key of ['tasks','approvals','changes'])check(owner[key].length===trusted[key].length,'Household owner did not see all trusted work');
  check(has(member.tasks,memberTask.id)&&has(member.tasks,agentTask.id)&&!has(member.tasks,houseTask.id)&&has(member.tasks,example.tasks[0]),'Member/project/agent task ownership was not applied');
  check(!has(agent.tasks,memberTask.id)&&!has(agent.tasks,agentTask.id)&&!has(agent.tasks,houseTask.id)&&has(agent.tasks,example.tasks[0]),'Agent task scope was not applied');
  check(has(member.approvals,privateCard.id)&&has(member.approvals,projectCard.id)&&has(member.approvals,agentCard.id)&&!has(member.approvals,example.approval),'Member private/project/owned-agent approvals were not scoped');
  check(!has(agent.approvals,privateCard.id)&&has(agent.approvals,projectCard.id)&&!has(agent.approvals,agentCard.id)&&!has(agent.approvals,example.approval),'Agent/private approval scope was not applied');
  check(has(member.changes,privateChange.id)&&has(member.changes,example.change)&&!has(agent.changes,privateChange.id)&&has(agent.changes,example.change),'Change project/owned-agent scope was not applied');
  for(const result of [member,agent,box])check(result.approvalRecord.every(event=>has(result.approvals,event.approval)),'Audit record leaked a hidden approval');
  check(box.tasks.length===0&&box.approvals.length===0&&box.changes.length===0,'Machine credential read household work');
  const anonymous=await app.http.request(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id } }'})});check(anonymous.status===401,'Anonymous outside read was accepted');
  write(()=>s.household.setProject({id:'garden',name:'Example garden',members:['alex'],agents:['fern','moss'],repositories:['example-house/garden']}));
  const withdrawn=await query(robin);
  check(!has(withdrawn.tasks,example.tasks[0])&&!has(withdrawn.changes,example.change)&&!has(withdrawn.approvals,projectCard.id)&&has(withdrawn.approvals,privateCard.id)&&has(withdrawn.approvals,agentCard.id),'Project withdrawal did not remove only the project-based visibility');
  write(()=>{
   s.household.setProject({id:'garden',name:'Example garden',members:['alex','robin'],agents:['fern','moss'],repositories:['example-house/garden']});
   for(const row of [memberTask,agentTask,houseTask])s.tasks.close(row.id,'Visibility evidence complete.');
   for(const row of [privateCard,projectCard,agentCard])s.approvals.withdraw(row.id,row.agent);
  });
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {workVisibility:{ok:true,screenshot,callers:['owner','member','agent','machine','anonymous'],projectWithdrawal:true}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {workVisibility:{ok:false,error:String(error),screenshot}};}
 finally{
  if(machine){const owner=tokens.find(row=>row.token);if(owner)await request('/api/runtime/boxRevoke',{box:machine.id},owner.token,'work-visibility-machine-revoke').catch(()=>{});}
  write(()=>{for(const issued of tokens)s.signin.revoke(issued.fingerprint);});
 }
}
