/** Observe a genuine scheduled expiry; never call the eraser or write its rows. */
import {join} from 'node:path';
import {Decrypter,generateX25519Identity} from 'age-encryption';
import {readKey} from '../dist/pieces/comms/crypto.js';
import {exampleRetentionWords} from '../dist/example-home.js';
export class ObservedRetentionFailure extends Error {}
export function retentionFailure(error){return error instanceof ObservedRetentionFailure?{ok:false,error:String(error)}:{inconclusive:true,reason:'Retention measurement could not complete; no browser retention verdict was observed.'};}
export async function encryptedStorage(blob,identity,words){
 try{
  if(!Buffer.isBuffer(blob)||!blob.subarray(0,22).equals(Buffer.from('age-encryption.org/v1\n')))return false;
  const correct=new Decrypter();correct.addIdentity(identity);if(await correct.decrypt(blob,'text')!==words)return false;
  const wrong=new Decrypter();wrong.addIdentity(await generateX25519Identity());
  try{await wrong.decrypt(blob,'text');return false;}catch{}
  const altered=Buffer.from(blob);altered[altered.length-1]^=1;
  try{await correct.decrypt(altered,'text');return false;}catch{}
  return true;
 }catch{return false;}
}
export async function prepareRetention({app,example,home}){
 const db=app.services.comms.db.$client,sample=example.retention;
 const row=()=>db.prepare('SELECT * FROM messages WHERE thread=? AND seq=?').get(sample.thread,sample.seq);
 const initial=row(),days=db.prepare('SELECT comms_days FROM household').get()?.comms_days??14;
 const before={encrypted:await encryptedStorage(initial.words,readKey(join(home,'comms.key')),exampleRetentionWords),readable:await app.services.comms.words(sample.thread,sample.seq)===exampleRetentionWords,days,until:initial.keep_until};
 return async({page,clock,out})=>{
  const screenshot='action-conversationRetention.png';
  try{
   const check=(yes,message)=>{if(!yes)throw new ObservedRetentionFailure(message);};
   check(before.encrypted&&before.readable&&days>=1&&days<=14,'Words were not initially encrypted/readable under a valid keep time');
   check(Date.parse(sample.until)-Date.parse(sample.at)===days*86400000,'Stored deadline differed from household keep time');
   const query='query RetainedExampleWords { commsMessages(thread: '+JSON.stringify(sample.thread)+') { seq words } }';
   const read=async()=>{const result=await page.evaluate(async query=>{const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});return{status:response.status,body:await response.json()};},query);if(result.status!==200||result.body.errors)throw Error('The browser words measurement was unavailable');return result.body.data.commsMessages.find(message=>message.seq===sample.seq);};
   if(clock.now()>=Date.parse(sample.until))throw Error('The measurement started after its sample deadline');
   before.browserReadable=(await read())?.words===exampleRetentionWords;check(before.browserReadable,'The browser could not read retained words before the deadline');
   clock.advance(Math.max(0,Date.parse(sample.until)-clock.now()-1));
   before.readableUntilDeadline=Buffer.isBuffer(row()?.words)&&await app.services.comms.words(sample.thread,sample.seq)===exampleRetentionWords&&(await read())?.words===exampleRetentionWords;
   check(before.readableUntilDeadline,'Words disappeared before their stored deadline');
   clock.advance(2);
   check(row()?.words===null,'The program’s deadline timer did not erase the stored ciphertext');
   check(await app.services.comms.words(sample.thread,sample.seq)===null,'The service still returned expired private words');
   const message=await read();
   check(message&&message.words===null,'The browser still received expired private words or lost the message metadata');
   await page.screenshot({path:join(out,screenshot),fullPage:true});
   return{ok:true,reason:'An encrypted, readable reply reached its household deadline; the program timer erased its ciphertext and both service/browser returned no words while retaining metadata.',before,after:{ciphertextErased:true,words:null,metadataRetained:true},thread:sample.thread,seq:sample.seq,screenshot};
  }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{...retentionFailure(error),before,screenshot};}
 };
}
