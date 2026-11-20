/** Knowledge writes use visible controls on the disposable, running example home. */
import {join} from 'node:path';
export async function knowledgeActions({page,tile,out,connections}){
 let phase='add';
 const screenshot='action-knowledge-verified.png';
 try{
  const initialConnections=[...connections];
  const graphQL=initialConnections.filter(socket=>new URL(socket.url()).pathname==='/graphql');
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
  await reader.locator('dt').filter({hasText:/^Sourcing$/}).locator('+ dd').filter({hasText:/^provisional$/}).waitFor();
  phase='recheck';await submit('knowledgeRecheck',()=>reader.getByRole('button',{name:'Check again',exact:true}).click());
  await reader.locator('header p').filter({hasText:/^Due a check ·/}).waitFor();
  await page.screenshot({path:join(out,'action-knowledge-due.png'),fullPage:true});
  phase='verify';await submit('knowledgeVerify',()=>reader.getByRole('button',{name:'Still true',exact:true}).click());
  await reader.locator('header p').filter({hasText:/^Fresh · verified /}).waitFor();
  // Earlier launcher visits may still own a legacy socket. Record that gap;
  // this Memory probe requires one shared GraphQL socket and opens no new one.
  const paths=sockets=>sockets.map(socket=>new URL(socket.url()).pathname);
  if(graphQL.length!==1||!connections.has(graphQL[0])||[...connections].filter(socket=>new URL(socket.url()).pathname==='/graphql').length!==1||[...connections].some(socket=>!initialConnections.includes(socket)))throw Error('Knowledge did not reuse the existing GraphQL connection: '+JSON.stringify({before:paths(initialConnections),after:paths([...connections])}));
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  phase='persisted';await page.reload();await page.locator('.next-shell').waitFor();
  const persisted=page.getByRole('region',{name:'Knowledge tile',exact:true}).locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await persisted.getByText(words,{exact:true}).waitFor({timeout:20_000});
  await persisted.locator('header p').filter({hasText:/^Fresh · verified /}).waitFor();
  return {ok:true,slug:added.slug,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql',preexistingOtherSockets:paths(initialConnections.filter(socket=>socket!==graphQL[0])),screenshot};
 }catch(error){
  const failed='action-knowledge-failed.png';await page.screenshot({path:join(out,failed),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot:failed};
 }
}

/** Exercise source attribution and an actual subsequent check on the same page. */
export async function knowledgeSourceCheck({page,tile,out}) {
 const title='Example pump pressure', claim='The fictional pump operates at 20 psi.';
 const source='https://example.invalid/manual/pump-pressure';
 const screenshot='action-knowledge-source-check.png';
 try {
  await tile.getByRole('button',{name:'Add a fact',exact:true}).click();
  const form=tile.getByRole('form',{name:'Add a fact',exact:true});
  for(const [label,value] of [['Title',title],['Topic','household/garden'],['What it says',claim],['Where it came from',source]])
   await form.getByLabel(label,{exact:true}).fill(value);
  await form.getByRole('button',{name:'Add',exact:true}).click();
  await form.getByRole('button',{name:'Open fact',exact:true}).click();
  const reader=tile.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await reader.getByText(claim,{exact:true}).waitFor();
  await reader.getByRole('button',{name:'Check again',exact:true}).click();
  await reader.getByText(/Asked to be checked again/).waitFor();
  await reader.getByRole('button',{name:'Still true',exact:true}).click();
  await reader.locator('header p').filter({hasText:/^Fresh · verified /}).waitFor();
  await page.reload();
  await reader.getByText(claim,{exact:true}).waitFor();
  const citation=reader.getByRole('region',{name:'Sources'}).getByRole('link',{name:source,exact:true});
  if(await citation.getAttribute('href')!==source)throw Error('The saved citation points elsewhere');
  const checks=reader.getByRole('region',{name:'Recent checks'}).getByRole('listitem');
  await checks.first().filter({hasText:/Still true/}).waitFor();
  await checks.nth(1).filter({hasText:/Asked to check again/}).waitFor();
  await reader.screenshot({path:join(out,screenshot)});
  return {ok:true,screenshot,reason:'After reload the saved fact retained its source link and its check history showed the confirmation after the recheck request.'};
 }catch(error){
  return {ok:false,error:String(error)};
 }
}
