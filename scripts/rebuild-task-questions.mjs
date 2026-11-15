/** Named task decisions must be answerable through their real Inbox cards. */
import {join} from 'node:path';
export async function taskQuestions({page,tile,app,example,out}){
 const screenshot='action-taskQuestions.png';
 try{
  const s=app.services.tasks,actor={kind:'agent',id:'fern'},db=app.services.comms.db.$client;
  for(const answer of ['yes','no','words']){
   const ask=`Fictitious task decision ${answer}?`;
   const task=app.writes.run(()=>{
    const task=s.create({title:`Decide the ${answer} example`,goal:'Record the person’s choice.',why:'Prove the task question path.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:example.conversation}},actor);
    s.ask(task.id,{to:{kind:'member',id:'alex'},ask,ifYes:'Fern proceeds.',ifNo:'Fern waits.',answers:answer==='words'?'words':'yes-no'},actor);return task;
   }).value;
   const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
   await tile.getByText(ask,{exact:true}).first().click();
   const card=tile.getByRole('article',{name:'Inbox item',exact:true});
   await card.getByText('Fern proceeds.',{exact:true}).waitFor();await card.getByText('Fern waits.',{exact:true}).waitFor();
   const controls=card.getByRole('region',{name:'Answer task question',exact:true});
   if(answer==='words')await controls.getByRole('textbox',{name:'Answer task in your own words',exact:true}).fill('Choose the smaller fictitious pump.');
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks/command'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await controls.getByRole('button',{name:answer==='yes'?'Yes':answer==='no'?'No':'Record task answer',exact:true}).click();
   const response=await pending,body=await response.json();if(!response.ok()||body.ok!==true)throw Error('Task answer was refused');
   const persisted=s.get(task.id),questions=db.prepare("SELECT id,state FROM inbox WHERE source='task' AND waits_on_id=?").all(task.id);
   const comment=answer==='words'?'Choose the smaller fictitious pump.':`${answer==='yes'?'Yes':'No'}, to: ${ask}\n${answer==='yes'?'Fern proceeds.':'Fern waits.'}`;
   if(persisted.ask!==null||persisted.assignee!=='fern'||persisted.comments.length!==1||persisted.comments[0].text!==comment||persisted.comments[0].actor!=='alex'||questions.length!==1||questions[0].state!=='resolved')throw Error('Task answer did not settle its question and return work to Fern');
   const replies=db.prepare("SELECT id FROM inbox WHERE source='answer' AND source_id=? AND to_kind='agent' AND \"to\"='fern'").all(questions[0].id);
   if(replies.length!==1)throw Error('Task answer was not delivered once to Fern');
   app.writes.run(()=>s.close(task.id,'Walkthrough choice recorded.'));
  }
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {taskQuestions:{ok:true,screenshot,answers:['yes','no','words']}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {taskQuestions:{ok:false,error:String(error),screenshot}};}
}

export async function taskInlineQuestion({page,tile,app,example,out}){
 const screenshot='action-taskInlineQuestion.png';
 try{
  const s=app.services.tasks,ask='Choose the fictitious inline task pump?';
  const task=app.writes.run(()=>{
   const task=s.create({title:'Decide inline pump',goal:'Choose once in chat.',why:'Prove task cards.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:example.conversation}},{kind:'agent',id:'fern'});
   s.ask(task.id,{to:{kind:'member',id:'alex'},ask,ifYes:'Fern proceeds inline.',ifNo:'Fern waits inline.'},{kind:'agent',id:'fern'});return task;
  }).value;
  const card=tile.getByRole('article',{name:'Inbox item',exact:true}).filter({has:page.getByRole('heading',{name:ask,exact:true})});
  await card.getByRole('heading',{name:ask,exact:true}).waitFor({timeout:4000});
  const yes=card.getByRole('button',{name:'Yes',exact:true});await yes.waitFor({state:'visible'});await card.screenshot({path:join(out,screenshot)});
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks/command'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await yes.focus();await yes.press('Enter');
  const response=await pending,body=await response.json();if(!response.ok()||body.ok!==true)throw Error('Inline task answer refused');
  const saved=s.get(task.id);
  if(saved.ask!==null||saved.comments.length!==1||saved.comments[0].actor!=='alex'||!saved.comments[0].at)throw Error('Inline task answer not recorded');
  app.writes.run(()=>s.close(task.id,'Inline choice recorded.'));
  return {taskInlineQuestion:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {taskInlineQuestion:{ok:false,error:String(error),screenshot}};}
}
