/** Read the configured worker in the Subscriptions app. */
import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';
class ObservedModelFailure extends Error {}
const check=(yes,message)=>{if(!yes)throw new ObservedModelFailure(message);};
export async function modelAccountActions({page,tile,example,subscriptions,out}){
 const actions={};
 try{
  if(!example.runtime)throw Error('The example has no normally registered worker and model-account binding.');
  const section=tile.getByRole('region',{name:'Subscriptions',exact:true});
  const summary=section.locator('summary').filter({hasText:'Example model subscription'});
  await summary.click();
  const query=subscriptions.find(row=>/query\s+RuntimeModelAccounts\b/.test(row.query))?.query;
  if(!query)throw Error('The actual Models selection was not observed');
  const reading=await browserRead(page,query),account=reading.modelAccounts.find(row=>row.id===example.account.id);
  if(account?.__typename!=='RuntimeAccountDetail')throw Error('The signed-in account projection was unavailable');
  check(account.signedInOn.length===1&&account.signedInOn[0].id===example.runtime.box,'The actual account-to-worker binding differs');
  const card=summary.locator('..');
  const configured=card.getByRole('region',{name:'Settings',exact:true});
  await configured.getByText(account.signedInOn[0].name,{exact:true}).waitFor().catch(()=>{throw new ObservedModelFailure('The visible subscription omitted its configured worker');});
  actions.modelsMachines={ok:true,reason:'The authenticated account selection and visible Subscriptions reader show the configured worker registered by the example.',account:account.id,box:example.runtime.box};
  const usage=card.getByRole('region',{name:'Usage',exact:true});
  const week=account.windows.find(w=>w.window==='week');
  check(week?.usage!=null && week.reserve!=null,'The example needs a reported weekly window and reserve');
  check(Number(await usage.getByRole('meter',{name:'Week',exact:true}).getAttribute('value'))===week.usage,'The weekly meter differs from the worker reading');
  await card.getByRole('region',{name:'Sign-ins',exact:true}).getByText('No sign-ins reported.',{exact:true}).waitFor();
  for(const [key,value] of [['Label',account.label],['Owner',account.owner],['Service',account.provider],['Week reserve',Math.round(week.reserve*100)+'%']]){
   const field=configured.getByText(key,{exact:true}).locator('xpath=following-sibling::dd[1]');
   check(await field.textContent()===value,'The subscription setting differs: '+key);
  }
  const screenshot='action-modelsMachines.png';await card.screenshot({path:join(out,screenshot)});
  actions.modelsMachines.screenshot=screenshot;
  actions.modelsAccountDetail={ok:true,reason:'The expanded example subscription showed the reported weekly usage meter, sign-in state, and its own label, owner, service, configured machine and weekly reserve under Settings.',screenshot};
  actions.modelsOwnerInformation={inconclusive:true,reason:'Distinct account-owner access rules and model preference order were not exercised here.'};
 }catch(error){
  const failure=error instanceof ObservedModelFailure?{ok:false,error:String(error)}:{inconclusive:true,reason:'The Models observation could not complete.'};
  actions.modelsMachines??=failure;
  actions.modelsAccountDetail=failure;
 }
 return actions;
}
