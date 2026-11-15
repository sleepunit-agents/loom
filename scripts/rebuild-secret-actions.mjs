/** Owner controls on the disposable built home; no Secret value is created. */
import {join} from 'node:path';
export async function secretDefaultAction({page,tile,out}){
 let phase='open';
 try{
  await tile.getByText('Piece settings',{exact:true}).first().click();
  await tile.getByText('Secret default',{exact:true}).first().click();
  const answer=tile.getByLabel('For a secret with no rule',{exact:true});
  await answer.waitFor();
  if(await answer.inputValue()!=='ask')throw Error('The example household did not start with Ask');
  phase='save';await answer.selectOption('never');
  const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/secrets/command'&&value.request().method()==='POST',{timeout:4000});
  void response.catch(()=>{});
  await tile.getByRole('button',{name:'Save household default',exact:true}).click();
  const result=await response,body=await result.json();
  if(result.status()!==200||body.ok!==true||body.value?.saved!==true)throw Error('The household default change was refused');
  await tile.getByRole('status').filter({hasText:'Saved.'}).waitFor();
  phase='reload';await page.reload();await page.locator('.next-shell').waitFor();
  const persisted=page.getByRole('region',{name:'Settings tile',exact:true}).getByLabel('For a secret with no rule',{exact:true});
  await persisted.waitFor();
  if(await persisted.inputValue()!=='never')throw Error('The household default did not persist after reload');
  const screenshot='action-secret-default.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return {ok:true,before:'ask',after:'never',persistedAfterReload:true,screenshot};
 }catch(error){
  const screenshot='action-secret-default-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot};
 }
}
