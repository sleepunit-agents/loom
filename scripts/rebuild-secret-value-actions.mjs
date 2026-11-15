/** Value writes through the real UI/Root and production encrypted holder store. */
import {join} from 'node:path';
import {assertSecretAudit} from './rebuild-secret-audit.mjs';
import {holderValueEquals,holderValueAbsent} from './rebuild-secret-holder.mjs';
export async function secretValueAction({page,tile,out,home}){
 const name='example-browser-token',initial='fictional-value-initial-6bd2',replacement='fictional-value-replacement-35af';
 let phase='add';const writeIds=[];
 try{
  const submit=async(form,label,operation)=>{
   const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/secrets/'+operation&&value.request().method()==='POST',{timeout:4000});void response.catch(()=>{});
   await form.getByRole('button',{name:label,exact:true}).click();
   const result=await response,body=await result.json();
   writeIds.push(result.request().postDataJSON().input.id);
   if(result.status()!==200||body.ok!==true||body.value?.saved!==true)throw Error('Secret value change was refused');
   if(operation==='set')await form.getByRole('status').filter({hasText:/^Saved\.$/}).waitFor();
  };
  const expectRecords=actions=>assertSecretAudit({home,name,member:'alex',writeIds,actions,values:[initial,replacement]});
  const reload=async()=>{await page.reload();await page.locator('.next-shell').waitFor();return page.getByRole('region',{name:'Settings tile',exact:true});};
  const back=tile.getByRole('button',{name:'Back to Settings',exact:true});
  if(await back.isVisible())await back.click();
  await tile.getByRole('button',{name:/^Secrets/}).click();
  await tile.getByText('Add a secret',{exact:true}).click();
  let form=tile.locator('form').filter({has:page.getByRole('button',{name:'Add secret',exact:true})});
  await form.getByLabel('Name',{exact:true}).fill(name);await form.getByLabel('Description',{exact:true}).fill('Fictional browser credential');
  await form.getByLabel('Value',{exact:true}).fill(initial);await submit(form,'Add secret','set');
  if(await form.getByLabel('Value',{exact:true}).inputValue()!=='')throw Error('The added value remained in the form');
  await tile.getByRole('button',{name:'Back to Settings',exact:true}).click();
  await tile.getByText(name,{exact:true}).click();await tile.getByText('The value is write-only. It cannot be read back here.',{exact:true}).waitFor();
  if((await tile.innerText()).includes(initial))throw Error('A value was displayed');
  if(!await holderValueEquals(home,name,initial))throw Error('The encrypted holder did not retain the added value');
  expectRecords(['add']);
  phase='replace';form=tile.locator('form').filter({has:page.getByRole('button',{name:'Save replacement',exact:true})});
  await form.getByLabel('Value',{exact:true}).fill(replacement);await submit(form,'Save replacement','set');
  if(await form.getByLabel('Value',{exact:true}).inputValue()!=='')throw Error('The replacement remained in the form');
  form=tile.locator('form').filter({has:page.getByRole('button',{name:'Save replacement',exact:true})});
  if(await form.getByLabel('Value',{exact:true}).inputValue()!=='')throw Error('A value survived in the input');
  if((await tile.innerText()).includes(replacement))throw Error('A replacement value was displayed');
  if(!await holderValueEquals(home,name,replacement))throw Error('The encrypted holder did not retain the replacement');
  expectRecords(['add','replace']);
  phase='remove';await submit(form,'Remove value and revoke access','remove');
  tile=await reload();
  // Named metadata/history remains after value removal; inspect its record.
  await tile.getByText(/ · removed · alex$/).waitFor();
  const cleared=tile.locator('form').filter({has:page.getByRole('button',{name:'Save replacement',exact:true})});
  if(await cleared.getByLabel('Value',{exact:true}).inputValue()!=='')throw Error('A value remained after removal');
  if(!await holderValueAbsent(home,name))throw Error('The holder still retained the removed value');
  expectRecords(['add','replace','removed']);
  const screenshot='action-secret-removed.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return {ok:true,added:true,replaced:true,removed:true,persistedAfterReload:true,writeOnly:true,recorded:true,holder:'Production openHolderStore code in an in-process test fixture; separate-process isolation is not exercised.',screenshot};
 }catch(error){
  const screenshot='action-secret-value-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error).replaceAll(initial,'[value redacted]').replaceAll(replacement,'[value redacted]'),screenshot};
 }
}
