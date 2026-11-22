import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';

export async function deskWaiting({page,tile,app,example,out}) {
 const screenshot='action-deskWaiting.png';
 const counts=async()=> (await browserRead(page,'{inboxFolders { needs fyi }}')).inboxFolders;
 const rail=page.getByRole('complementary',{name:'Your agents',exact:true});
 async function shown(needs) {
  await page.getByRole('link',{name:needs+' need'+(needs===1?'s':'')+' you',exact:true}).waitFor();
  const band=rail.locator('.desk-rail-needs');
  if(needs===0)await band.waitFor({state:'hidden'});
  else{
   await band.getByText('Needs you · '+needs,{exact:true}).waitFor();
   await band.getByRole('button',{name:needs>1?(needs-1)+' more · Inbox ›':'Inbox ›',exact:true}).waitFor();
  }
 }
 try{
  const before=await counts();await shown(before.needs);
  app.writes.run(()=>app.services.conversations.send({toKind:'person',to:'alex',source:'notice',sourceId:'desk-waiting-info',fromKind:'agent',fromId:'fern',words:'The spare hose was delivered.'}));
  const info=await counts();
  if(info.fyi!==before.fyi+1||info.needs!==before.needs)throw Error('The informational delivery changed the wrong Inbox folder');
  await shown(info.needs);
  const words='Should Fern unpack the spare hose?';
  const commit=await app.services.comms.prepareAsk(example.thread,'fern','desk-waiting-question',{words,answers:'yes-no',why:'The spare hose arrived.',ifYes:'Unpack it.',ifNo:'Leave it packed.'});
  app.writes.run(commit);
  const question=await counts();
  if(question.needs!==before.needs+1||question.fyi!==info.fyi)throw Error('The question changed the wrong Inbox folder');
  await shown(question.needs);
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.getByRole('button',{name:/^Needs you/}).first().click();
  await tile.locator('[data-split-row]:visible').filter({hasText:words}).click();
  await tile.getByRole('button',{name:'Yes',exact:true}).click();
  await tile.getByRole('heading',{name:'Answer',exact:true}).waitFor();
  const answered=await counts();
  if(answered.needs!==before.needs||answered.fyi!==info.fyi)throw Error('Answer did not remove exactly one waiting question');
  await shown(answered.needs);
  return{ok:true,reason:'The rail and top bar counted the new question, excluded the FYI and decreased by one when Alex answered.',before,info,question,answered,screenshot};
 }catch(error){return{ok:false,error:String(error)};}
}
