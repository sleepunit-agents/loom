/** Observe a genuine scheduled expiry; never call the eraser or write its rows. */
import {join} from 'node:path';
import {exampleRetentionWords} from '../dist/example-home.js';
export async function prepareRetention({app,example}){
 const db=app.services.comms.db.$client,sample=example.retention;
 const row=()=>db.prepare('SELECT * FROM messages WHERE thread=? AND seq=?').get(sample.thread,sample.seq);
 const initial=row(),days=db.prepare('SELECT comms_days FROM household').get()?.comms_days??14;
 const before={encrypted:Buffer.isBuffer(initial.words)&&!initial.words.includes(Buffer.from(exampleRetentionWords)),readable:await app.services.comms.words(sample.thread,sample.seq)===exampleRetentionWords,days,until:initial.keep_until};
 return async({page,clock,out})=>{
  const screenshot='action-conversationRetention.png';
  try{
   const check=(yes,message)=>{if(!yes)throw Error(message);};
   check(before.encrypted&&before.readable&&days>=1&&days<=14,'Words were not initially encrypted/readable under a valid keep time');
   check(Date.parse(sample.until)-Date.parse(sample.at)===days*86400000,'Stored deadline differed from household keep time');
   clock.advance(Math.max(0,Date.parse(sample.until)-clock.now()+1));
   check(row()?.words===null,'The program’s deadline timer did not erase the stored ciphertext');
   check(await app.services.comms.words(sample.thread,sample.seq)===null,'The service still returned expired private words');
   const query='query ExpiredExampleWords { commsMessages(thread: '+JSON.stringify(sample.thread)+') { seq words } }';
   const answer=await page.evaluate(async query=>{const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});return{status:response.status,body:await response.json()};},query);
   check(answer.status===200&&!answer.body.errors,'The signed-in browser could not read the retained message metadata');
   const message=answer.body.data.commsMessages.find(message=>message.seq===sample.seq);
   check(message&&message.words===null,'The browser still received expired private words or lost the message metadata');
   await page.screenshot({path:join(out,screenshot),fullPage:true});
   return{ok:true,reason:'An encrypted, readable reply reached its household deadline; the program timer erased its ciphertext and both service/browser returned no words while retaining metadata.',before,after:{ciphertextErased:true,words:null,metadataRetained:true},thread:sample.thread,seq:sample.seq,screenshot};
  }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{ok:false,error:String(error),before,screenshot};}
 };
}
