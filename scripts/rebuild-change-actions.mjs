import {responseForAction} from './rebuild-response-capture.mjs';
/** Fictitious source facts travel through the actual Changes sync/cache and UI.
 * There is no network call to GitHub and no merge of an external pull request. */
import {join} from 'node:path';
export async function changeActions({page,tile,app,example,out}){
 const screenshot='action-changeWorkflow.png',s=app.services.changes,a=app.services.approvals;
 const check=(v,m)=>{if(!v)throw Error(m);},write=fn=>app.writes.run(fn).value;
 try{
  const at=new Date().toISOString();
  const base={id:example.change,repo:'github:example-house/garden',number:12,page:'',title:`Plan the pump repair (${example.tasks[0]})`,body:`The order references ${example.tasks[1]}.`,url:'https://github.com/example-house/garden/pull/12',state:'open',draft:false,author:{login:'example-fern'},created:at,updated:at,closed:null,head:{ref:`pump-${example.tasks[2]}`,id:'a'.repeat(40)},base:{ref:'next'},checks:{state:'passing',failing:[],running:[],total:1},review:{state:'approved',by:[]},mergeable:'yes',conflicts:false,people:[{login:'example-reviewer',role:'reviewer'},{login:'example-requested',role:'requested'},{login:'example-assignee',role:'assignee'},{login:'example-commenter',role:'commenter'}]};
  const make=(number,title,patch={})=>({...base,id:`github:example-house/garden#${number}`,number,title,url:`https://github.com/example-house/garden/pull/${number}`,...patch});
  const facts=[base,make(13,'Fictitious CI work',{checks:{state:'running',running:['pump-ci'],failing:[],total:1}}),make(14,'Fictitious review work',{review:{state:'required',by:[]}}),make(15,'Fictitious author work',{checks:{state:'failing',failing:['hose-test'],running:[],total:1}}),make(16,'Fictitious finished work',{state:'merged',closed:at}),make(17,'Fictitious owner decision')];
  let reads=0;await s.sync(async repository=>{check(repository==='example-house/garden','Sync read an unexpected repository');reads++;return facts;},new Date(Date.now()+60000).toISOString());
  check(reads===1&&s.syncStatus().failed===false&&!!s.syncStatus().readAt,'Changes did not keep source sync status');
  const current=s.get(example.change);check(current.project==='garden'&&current.agent==='fern','Repository/login attribution missing');
  check(current.tasks.map(t=>t.id).sort().join(',')===[...example.tasks.slice(0,3)].sort().join(','),'Title/body/branch task links missing');
  const request=write(()=>a.request({kind:'merge',target:`${current.id}@${current.headCommit}`,what:'Merge the fictitious cached change',why:'The fictitious checks pass.',agent:'fern',askedFrom:example.conversation,actingFor:'alex',project:'garden',conversation:example.conversation,ask:'Merge the exact fictitious head?',ifYes:'Fern merges this commit.',ifNo:'Fern leaves the pull request open.'}));
  const select=async title=>{const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();await tile.locator('.loom-split__rows [data-split-row]').filter({has:page.getByText(title,{exact:true})}).click();};
  await select(base.title);
  const reader=tile.getByRole('article',{name:'Change',exact:true});
  const fact=async(section,label,value)=>{
   const group=reader.getByRole('region',{name:section,exact:true});
   const field=group.getByText(label,{exact:true}).locator('xpath=following-sibling::dd[1]');
   await field.filter({hasText:value}).waitFor();
   check(await field.innerText()===value,'Incorrect '+label+' in '+section);
  };
  for(const [label,login] of [['Reviewed it','example-reviewer'],['Author','example-fern'],['Asked to review','example-requested'],['Assigned','example-assignee'],['Commented','example-commenter']]){
   await fact('People on it',label,login);
  }
  for(const [index,title] of ['Compare garden pumps','Order the selected pump','Measure the hose'].entries()){
   await reader.getByRole('button',{name:`Open ${title}, ${example.tasks[index]}`,exact:true}).waitFor();
  }
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/changes/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await reader.getByRole('button',{name:'Yes, merge it',exact:true}).click();
  const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Merge answer was refused');
  check(a.get(request.id).state==='allowed'&&a.get(request.id).decidedBy==='alex'&&s.get(current.id).waitingOn==='agent'&&s.get(current.id).state==='open','Merge answer did not return the exact open head to its agent');
  check(!write(()=>a.use(request.id,'fern','merge',`${current.id}@${'b'.repeat(40)}`)).ok,'Merge allowance could be spent on another head');
  check(a.get(request.id).state==='allowed','Wrong-head refusal consumed the correct allowance');
  check(write(()=>a.use(request.id,'fern','merge',request.target)).ok,'Agent could not spend the exact merge allowance');
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.locator('.loom-split__rows [data-split-row]').filter({hasText:'Fictitious owner decision'}).waitFor();
  const order=await tile.locator('.loom-split__rows [data-split-row]').allTextContents();
  const expected=['Fictitious owner decision',base.title,'Fictitious CI work','Fictitious review work','Fictitious author work','Fictitious finished work'];
  check(order.length===expected.length&&order.every((text,index)=>text.includes(expected[index])),'Changes are not ordered you/agent/ci/reviewer/author/done');
  await select('Fictitious CI work');await fact('Checks','Running','pump-ci');
  await select('Fictitious author work');await fact('Checks','Failing','hose-test');
  check(reads===1,'Rendering read the source again');
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {changeWorkflow:{ok:true,screenshot,sourceReads:reads,groups:['you','agent','ci','reviewer','author','done']}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {changeWorkflow:{ok:false,error:String(error),screenshot}};}
}

/** The real composer creates a PR reference; the card opens the current tile. */
export async function changeInline({page,tile,app,example,out}){
 const screenshot='action-changeInline.png';
 try{
  const words=`Review this fictitious pull request: ${example.change}.`;
  const editor=tile.getByRole('textbox',{name:'Message Fern',exact:true});await editor.fill(words);
  const send=tile.getByRole('button',{name:'Send',exact:true}).and(page.locator(':enabled'));await send.waitFor({state:'visible'});await send.focus();
  if(await editor.inputValue()!==words)throw Error('Reference draft changed before Send');
  const response=await responseForAction(page,r=>new URL(r.url()).pathname==='/api/comms/send'&&r.method()==='POST',()=>send.press('Enter'));
  const body=await response.json();if(!response.ok()||body.ok!==true)throw Error('Reference message refused');
  const title=app.services.changes.get(example.change).title;
  const card=tile.getByRole('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await card.getByRole('heading',{name:title,exact:true}).waitFor({timeout:4000});
  if(await card.getByRole('button',{name:'Yes, merge it',exact:true}).count())throw Error('Inline PR reference offers a merge action');
  await card.getByRole('button',{name:'Open',exact:true}).click();
  const change=page.getByRole('region',{name:'Changes tile',exact:true});
  await change.getByRole('heading',{name:title,exact:true}).waitFor({timeout:4000});
  const reader=change.getByRole('article',{name:'Change',exact:true});
  await reader.getByRole('button',{name:/^Open Compare garden pumps, /}).click();
  const tasks=page.getByRole('region',{name:'Tasks tile',exact:true});
  await tasks.getByRole('heading',{name:'Compare garden pumps',exact:true}).waitFor({timeout:4000});
  await tasks.getByText('Pull requests',{exact:true}).waitFor();
  await tasks.getByRole('link',{name:'example-house/garden#12',exact:true}).waitFor();
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {changeInline:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {changeInline:{ok:false,error:String(error),screenshot}};}
}
