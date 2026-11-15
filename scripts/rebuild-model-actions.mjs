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
  check(account?.__typename==='RuntimeAccountDetail','The account owner did not receive account details');
  check(account.owner==='alex'&&account.provider==='example-provider','The observed account identity differs from the fixture');
  check(account.signedInOn.length===1&&account.signedInOn[0].id===example.runtime.box,'The actual account-to-worker binding differs');
  check(account.usage===0.25&&account.hasRoom===true&&Date.parse(account.resetsAt)>Date.parse(account.usageReadAt),'The real worker usage report was missing or different');
  const section=tile.getByRole('region',{name:'Models and accounts',exact:true});
  const card=section.getByRole('article').filter({has:page.getByRole('heading',{name:account.label,exact:true})});
  await card.waitFor();const text=await card.innerText();
  for(const value of ['Owner: alex','Provider: example-provider','25%',account.signedInOn[0].name,'America/Chicago'])check(text.includes(value),'The visible account omitted '+value);
  const screenshot='action-modelsMachines.png';await card.screenshot({path:join(out,screenshot)});
  return{modelsMachines:{ok:true,reason:'The authenticated account selection and visible Models section show the actual worker registered by the example and signed into this subscription.',account:account.id,box:example.runtime.box,screenshot},modelsOwnerInformation:{inconclusive:true,reason:'Alex’s own account details and worker-reported usage are visible. Separate non-owner and household-owner access to another member’s account are not measured here.'}};
 }catch(error){return{modelsMachines:error instanceof ObservedModelFailure?{ok:false,error:String(error)}:{inconclusive:true,reason:'The Models observation could not complete.'}};}
}
