/** Owner controls on the disposable built home; no Secret value is created. */
import {join} from 'node:path';
export async function secretDefaultAction({page,tile,out,deferReload=false}){
 let phase='open';
 try{
  await tile.getByText('Piece settings',{exact:true}).first().click();
  await tile.getByText('Secret default',{exact:true}).first().click();
  const answer=tile.getByRole('combobox',{name:/^For a secret with no rule/});
  await answer.waitFor();
  if(await answer.inputValue()!=='ask')throw Error('The example household did not start with Ask');
  phase='save';await answer.selectOption('never');
  const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/secrets/command'&&value.request().method()==='POST',{timeout:4000});
  void response.catch(()=>{});
  await tile.getByRole('button',{name:'Save household default',exact:true}).click();
  const result=await response,body=await result.json();
  if(result.status()!==200||body.ok!==true||body.value?.saved!==true)throw Error('The household default change was refused');
  // The live default update remounts this form and retires its local status.
  // The server acknowledgment plus persisted selection are the outcome proof.
  if(deferReload)return {ok:true,before:'ask',after:'never',persistedAfterReload:false};
  phase='reload';await page.reload();await page.locator('.next-shell').waitFor();
  return await verifySecretDefaultAfterReload({page,out});
 }catch(error){
  const screenshot='action-secret-default-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot};
 }
}
/** The value-write sequence can supply the reload for both observations. */
export async function verifySecretDefaultAfterReload({page,out,navigate=false}){
 try{
  const tile=page.getByRole('region',{name:'Settings tile',exact:true});
  if(navigate){
   const back=tile.getByRole('button',{name:'Back to Settings',exact:true});
   if(await back.isVisible())await back.click();
   await tile.getByText('Piece settings',{exact:true}).first().click();
   await tile.getByText('Secret default',{exact:true}).first().click();
  }
  const persisted=tile.getByRole('combobox',{name:/^For a secret with no rule/});await persisted.waitFor();
  if(await persisted.inputValue()!=='never')throw Error('The household default did not persist after reload');
  const screenshot='action-secret-default.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return {ok:true,before:'ask',after:'never',persistedAfterReload:true,screenshot};
 }catch(error){
  const screenshot='action-secret-default-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase:'verify-reload',error:String(error),screenshot};
 }
}
