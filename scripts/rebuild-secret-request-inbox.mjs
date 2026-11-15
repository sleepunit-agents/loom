/** Disposable request via the trusted producer; actual Owner Inbox/Settings UI. */
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {responseForAction} from './rebuild-response-capture.mjs';

export async function secretRequestInbox({page,app,example,out}){
 const id=randomUUID(),name='example-inbox-'+id,words=`Allow fern to use ${name} for 5 minutes?`;
 const screenshot='action-secretRequestInbox.png';let created=false;
 const command=async(operation,input)=>{
  const response=await page.request.post(app.url+'/api/secrets/'+operation,{headers:{origin:app.url},data:{id:randomUUID(),input}});
  if(response.status()!==200||(await response.json()).ok!==true)throw Error('Fictitious Secret setup was refused');
 };
 const inbox=async(reload=false)=>{
  if(reload)await page.reload();else await page.goto(app.url+'/p/inbox-preview');await page.locator('.next-shell').waitFor();
  const tile=page.getByRole('region',{name:'Inbox tile',exact:true});await tile.waitFor();
  const back=tile.getByRole('button',{name:'Back to Inbox',exact:true});if(await back.isVisible())await back.click();
  return tile;
 };
 try{
  await command('set',{id:randomUUID(),name,value:'FICTITIOUS_INBOX_REQUEST_VALUE',mode:'add'});created=true;
  await command('command',{action:'rule',secret:name,answer:'ask',minutes:5,agents:[{agent:'fern',when:'on_request'}]});
  const request=app.writes.run(()=>app.services.secrets.requests.request({id,secret:name,agent:'fern',conversation:example.conversation,why:'Verify a pending Secret request in the owner Inbox.',minutes:5})).value;
  if(request.state!=='pending')throw Error('The producer did not leave a pending request');
  let tile=await inbox();await tile.getByRole('button',{name:/^Needs you/}).click();
  await tile.getByText(words,{exact:true}).first().waitFor();
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  await tile.getByRole('button').filter({hasText:words}).first().click();
  await tile.getByRole('button',{name:'Open secret-request',exact:true}).click();
  const settings=page.getByRole('region',{name:'Settings tile',exact:true});
  await settings.getByText(name,{exact:true}).first().waitFor();
  await settings.getByText('Verify a pending Secret request in the owner Inbox.',{exact:true}).waitFor();
  const answer=await responseForAction(page,value=>new URL(value.url()).pathname==='/api/secrets/command'&&value.method()==='POST'&&value.postDataJSON()?.input?.id===id,
   ()=>settings.getByRole('button',{name:'Allow',exact:true}).click());
  if(answer.status()!==200||(await answer.json()).ok!==true)throw Error('The linked Secret answer was refused');
  const response=await page.request.post(app.url+'/graphql',{data:{query:'{secretRequests{id state} inboxItems(source:"secret-request",folder:"answered"){id sourceId state}}'}});
  const result=await response.json();
  if(result.errors||!result.data?.secretRequests.some(row=>row.id===id&&row.state==='allowed')||!result.data?.inboxItems.some(row=>row.sourceId===id&&row.state==='resolved'))throw Error('The source answer did not settle its Inbox item');
  tile=await inbox();await tile.getByRole('button',{name:/^Answered/}).click();await tile.getByText(words,{exact:true}).first().waitFor();
  tile=await inbox(true);
  await tile.getByRole('button',{name:/^Answered/}).click();await tile.getByText(words,{exact:true}).first().waitFor();
  return{ok:true,pending:true,sourceNavigated:true,settled:true,persistedAfterReload:true,screenshot};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return{ok:false,error:String(error),screenshot};}
 finally{if(created)await command('remove',{id:randomUUID(),name}).catch(()=>{});}
}
