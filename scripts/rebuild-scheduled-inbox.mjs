import assert from 'node:assert/strict';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';

/** Restart a separate fictional home so the main walkthrough keeps its open desk. */
export async function scheduledInbox({browser,home,out}){
 const example=await exampleHome(home);
 const clock=new FakeClock(Date.parse(example.createdAt));
 const start=port=>startSharedHome({home,port,clock,stdout(){}});
 const contexts=[];
 let app;
 try{
  app=await start(0);
  const origin=app.url, port=Number(new URL(origin).port);
  const people=example.members;
  assert.equal(people.length,2);
  const words=people.map(member=>'Reminder for the '+member+' garden bed');
  const pages=[];
  for(const member of people){
   const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
   contexts.push(context);
   await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await context.routeWebSocket(url=>url.origin!==origin.replace(/^http/,'ws'),route=>route.close());
   const page=await context.newPage();
   pages.push(page);
   await page.goto(app.signinLink(member));
   await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.locator('.next-shell').waitFor();
   await page.goto(origin+'/p/inbox-preview');
   await page.getByRole('button',{name:/All items/}).click();
  }
  const times=new Date(clock.now()+60_000).toISOString();
  for(const [i,member] of people.entries()){
   const response=await pages[0].request.post(origin+'/api/tempo/set',{headers:{origin},maxRedirects:0,data:{
    id:'schedule-'+member,input:{id:'remind-'+member,ownerKind:'household',sourceKind:'time',times,
     lifespan:'once',targetKind:'inbox',toKind:'person',to:member,instructions:words[i],note:words[i]}
   }});
   assert.equal(response.status(),200);assert.equal((await response.json()).ok,true);
  }
  const rows=()=>app.services.comms.db.$client.prepare("SELECT id,member,words FROM inbox WHERE source='trigger' AND words IN (?,?) ORDER BY member").all(...words);
  clock.advance(59_999);assert.deepEqual(rows(),[]);
  clock.advance(1);
  const checkInboxes=async()=>{
   for(const [i,page] of pages.entries()){
    const tile=page.getByRole('region',{name:'Inbox tile',exact:true});
    await tile.getByText(words[i],{exact:true}).waitFor();
    assert.equal(await tile.getByText(words[1-i],{exact:true}).count(),0);
   }
  };
  await checkInboxes();
  const delivered=rows();
  assert.deepEqual(delivered.map(row=>[row.member,row.words]),people.map((member,i)=>[member,words[i]]).sort());
  await app.close();app=undefined;
  app=await start(port);
  for(const page of pages){
   await page.reload();
   await page.getByRole('button',{name:/All items/}).click();
  }
  await checkInboxes();
  assert.deepEqual(rows(),delivered);
  const screenshot='action-scheduled-inbox.png';
  await pages[1].getByRole('region',{name:'Inbox tile',exact:true}).screenshot({path:join(out,screenshot)});
  return {ok:true,screenshot,recipients:people.length,delivered:delivered.length,unchangedAfterRestart:true};
 }catch(error){return {ok:false,error:String(error)};}
 finally{
  await Promise.allSettled(contexts.map(context=>context.close()));
  await app?.close();
 }
}
