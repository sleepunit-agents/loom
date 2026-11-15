/** Knowledge writes use visible controls on the disposable, running example home. */
import {join} from 'node:path';
export async function knowledgeActions({page,tile,out,connections}){
 let phase='add';
 const screenshot='action-knowledge-verified.png';
 try{
  const initialConnections=[...connections];
  const title='Example pump hose width',words='The fictional garden pump takes a 25 mm hose.';
  const submit=async(verb,click)=>{
   const response=page.waitForResponse(value=>new URL(value.url()).pathname===`/api/mind/${verb}`&&value.request().method()==='POST',{timeout:4000});
   void response.catch(()=>{});await click();const result=await response,body=await result.json();
   if(result.status()!==200||body.ok!==true)throw Error(`Knowledge ${verb} was not accepted`);
   return body.value;
  };
  await tile.getByRole('button',{name:'Add a fact',exact:true}).click();
  const form=tile.getByRole('form',{name:'Add a fact',exact:true});
  await form.getByLabel('Title',{exact:true}).fill(title);
  await form.getByLabel('Topic',{exact:true}).fill('household/garden');
  await form.getByLabel('What it says',{exact:true}).fill(words);
  const added=await submit('knowledgeAdd',()=>form.getByRole('button',{name:'Add',exact:true}).click());
  await form.getByRole('button',{name:'Open fact',exact:true}).click();
  const reader=tile.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await reader.getByText(words,{exact:true}).waitFor();
  await reader.getByText('Sourcing: provisional.',{exact:false}).waitFor();
  phase='recheck';await submit('knowledgeRecheck',()=>reader.getByRole('button',{name:'Check again',exact:true}).click());
  await reader.locator('header p').filter({hasText:/^Due a check ·/}).waitFor();
  await page.screenshot({path:join(out,'action-knowledge-due.png'),fullPage:true});
  phase='verify';await submit('knowledgeVerify',()=>reader.getByRole('button',{name:'Still true',exact:true}).click());
  await reader.locator('header p').filter({hasText:/^Fresh · verified /}).waitFor();
  if(initialConnections.length!==1||connections.size!==1||!connections.has(initialConnections[0])||new URL(initialConnections[0].url()).pathname!=='/graphql')throw Error('Knowledge did not use the existing single GraphQL connection: '+JSON.stringify({before:initialConnections.map(socket=>new URL(socket.url()).pathname),after:[...connections].map(socket=>new URL(socket.url()).pathname)}));
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  phase='persisted';await page.reload();await page.locator('.next-shell').waitFor();
  const persisted=page.getByRole('region',{name:'Knowledge tile',exact:true}).locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await persisted.getByText(words,{exact:true}).waitFor();
  await persisted.locator('header p').filter({hasText:/^Fresh · verified /}).waitFor();
  return {ok:true,slug:added.slug,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql',screenshot};
 }catch(error){
  const failed='action-knowledge-failed.png';await page.screenshot({path:join(out,failed),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot:failed};
 }
}
