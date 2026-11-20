/** Owner controls on the disposable built home; no Secret value is created. */
import {join} from 'node:path';
import {approveRequestedChange} from './rebuild-access-actions.mjs';
export async function secretDefaultAction({page,tile,out,app,deferReload=false}){
 let phase='open';
 try{
  await tile.getByText('Piece settings',{exact:true}).first().click();
  await tile.getByText('Secret default',{exact:true}).first().click();
  const answer=tile.getByRole('combobox',{name:/^For a secret with no rule/});
  await answer.waitFor();
  if(await answer.inputValue()!=='ask')throw Error('The example household did not start with Ask');
  phase='save';await answer.selectOption('never');
  const originalUrl=page.url();
  await tile.getByRole('button',{name:'Review household default',exact:true}).click();
  await approveRequestedChange({page,app,composer:tile.getByRole('region',{name:'Secret default request'}),change:'secretDefault',input:{answer:'never'},
   expectedWords:words=>words.endsWith(JSON.stringify({answer:'never'},null,2)),
   exists:()=>app.services.comms.db.$client.prepare('SELECT secrets_default FROM household').get()?.secrets_default==='never'});
  await page.goto(originalUrl);await answer.waitFor();
  if(await answer.inputValue()!=='never')throw Error('The approved household default was not stored');
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
