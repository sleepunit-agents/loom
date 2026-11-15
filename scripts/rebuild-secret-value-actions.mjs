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
  // Removal retains the named metadata; its new standing rule shares this
  // case's final reload with value/history/default persistence checks.
  phase='rule';await tile.getByText(/ · removed · alex$/).waitFor();const rule=tile.locator('form').filter({has:page.getByRole('button',{name:'Save rule',exact:true})});
  await rule.getByRole('combobox',{name:/^Answer/}).selectOption('never');
  await rule.getByLabel('Automatic grant, minutes',{exact:true}).fill('17');
  await rule.getByLabel('When asked: agent names, separated by commas',{exact:true}).fill('fern');
  await rule.getByLabel('At startup: agent names, separated by commas',{exact:true}).fill('fern');
  const saved=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/secrets/command'&&value.request().method()==='POST',{timeout:4000});void saved.catch(()=>{});
  await rule.getByRole('button',{name:'Save rule',exact:true}).click();
  const result=await saved,body=await result.json();
  if(result.status()!==200||body.ok!==true||body.value?.saved!==true)throw Error('The standing rule was refused');
  tile=await reload();
  const persistedRule=tile.locator('form').filter({has:page.getByRole('button',{name:'Save rule',exact:true})});
  if(await persistedRule.getByRole('combobox',{name:/^Answer/}).inputValue()!=='never'
   ||await persistedRule.getByLabel('Automatic grant, minutes',{exact:true}).inputValue()!=='17'
   ||await persistedRule.getByLabel('When asked: agent names, separated by commas',{exact:true}).inputValue()!=='fern'
   ||await persistedRule.getByLabel('At startup: agent names, separated by commas',{exact:true}).inputValue()!=='fern')throw Error('The standing rule did not persist after reload');
  // Named metadata/history remains after value removal; inspect its record.
  await tile.getByText(/ · removed · alex$/).waitFor();
  const cleared=tile.locator('form').filter({has:page.getByRole('button',{name:'Save replacement',exact:true})});
  if(await cleared.getByLabel('Value',{exact:true}).inputValue()!=='')throw Error('A value remained after removal');
  if(!await holderValueAbsent(home,name))throw Error('The holder still retained the removed value');
  expectRecords(['add','replace','removed']);
  const screenshot='action-secret-removed.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return {ok:true,added:true,replaced:true,removed:true,persistedAfterReload:true,writeOnly:true,recorded:true,ruleSaved:true,holder:'Production openHolderStore code in an in-process test fixture; separate-process isolation is not exercised.',screenshot};
 }catch(error){
  const screenshot='action-secret-value-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error).replaceAll(initial,'[value redacted]').replaceAll(replacement,'[value redacted]'),screenshot};
 }
}
