/** Read the actual Models section inside the existing Your account visit. */
import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';
class ObservedModelFailure extends Error {}
const check=(yes,message)=>{if(!yes)throw new ObservedModelFailure(message);};
export async function modelAccountActions({page,tile,example,subscriptions,out}){
 try{
  if(!example.runtime)return{modelsMachines:{inconclusive:true,reason:'The example has no normally registered worker and model-account binding.'}};
  await tile.getByRole('region',{name:'Models and accounts',exact:true}).getByRole('heading',{name:'Example model subscription',exact:true}).waitFor();
  const query=subscriptions.find(row=>/query\s+RuntimeModelAccounts\b/.test(row.query))?.query;
  if(!query)throw Error('The actual Models selection was not observed');
  const reading=await browserRead(page,query),account=reading.modelAccounts.find(row=>row.id===example.account.id);
  if(account?.__typename!=='RuntimeAccountDetail')throw Error('The signed-in account projection was unavailable');
  check(account.signedInOn.length===1&&account.signedInOn[0].id===example.runtime.box,'The actual account-to-worker binding differs');
  const section=tile.getByRole('region',{name:'Models and accounts',exact:true});
  const card=section.getByRole('article').filter({has:page.getByRole('heading',{name:account.label,exact:true})});
  await card.waitFor();const text=await card.innerText();
  check(text.includes(account.signedInOn[0].name),'The visible subscription omitted its signed-in worker');
  const screenshot='action-modelsMachines.png';await card.screenshot({path:join(out,screenshot)});
  return{modelsMachines:{ok:true,reason:'The authenticated account selection and visible Models section show the actual worker registered by the example and signed into this subscription.',account:account.id,box:example.runtime.box,screenshot},modelsOwnerInformation:{inconclusive:true,reason:'Only the subscription’s worker binding was checked. Usage, preference order and distinct account-owner access rules are not measured here.'}};
 }catch(error){return{modelsMachines:error instanceof ObservedModelFailure?{ok:false,error:String(error)}:{inconclusive:true,reason:'The Models observation could not complete.'}};}
}
