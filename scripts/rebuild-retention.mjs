/** Observe a genuine scheduled expiry; never call the eraser or write its rows. */
import {join} from 'node:path';
import {Decrypter,generateX25519Identity} from 'age-encryption';
import {readKey} from '../dist/pieces/comms/crypto.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {exampleHome,exampleRetentionWords} from '../dist/example-home.js';
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
export async function prepareRetention({app,example,home,expectedDays=14,screenshot='action-conversationRetention.png'}){
 const db=app.services.comms.db.$client,sample=example.retention;
 const row=()=>db.prepare('SELECT * FROM messages WHERE thread=? AND seq=?').get(sample.thread,sample.seq);
 const metadata=({words,...rest})=>rest;
 const initial=row(),storedMetadata=metadata(initial),days=db.prepare('SELECT comms_days FROM household').get()?.comms_days??14;
 const before={encrypted:await encryptedStorage(initial.words,readKey(join(home,'comms.key')),exampleRetentionWords),readable:await app.services.comms.words(sample.thread,sample.seq)===exampleRetentionWords,days,until:initial.keep_until};
 return async({page,clock,out})=>{
  try{
   const check=(yes,message)=>{if(!yes)throw new ObservedRetentionFailure(message);};
   check(before.encrypted&&before.readable&&days===expectedDays,'Words were not initially encrypted/readable under the expected household keep time');
   check(Date.parse(sample.until)-Date.parse(sample.at)===days*86400000,'Stored deadline differed from household keep time');
   const query='query RetainedExampleWords { commsMessages(thread: '+JSON.stringify(sample.thread)+') { thread seq kind sender at keepUntil delivery inboxItem verdict run tool cardState clientId words } }';
   const read=async()=>{const result=await page.evaluate(async query=>{const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});return{status:response.status,body:await response.json()};},query);if(result.status!==200||result.body.errors)throw Error('The browser words measurement was unavailable');return result.body.data.commsMessages.find(message=>message.seq===sample.seq);};
   if(clock.now()>=Date.parse(sample.until))throw Error('The measurement started after its sample deadline');
   const firstBrowser=await read(),browserMetadata=firstBrowser?metadata(firstBrowser):null;
   before.browserReadable=firstBrowser?.words===exampleRetentionWords;check(before.browserReadable,'The browser could not read retained words before the deadline');
   clock.advance(Math.max(0,Date.parse(sample.until)-clock.now()-1));
   before.readableUntilDeadline=Buffer.isBuffer(row()?.words)&&await app.services.comms.words(sample.thread,sample.seq)===exampleRetentionWords&&(await read())?.words===exampleRetentionWords;
   check(before.readableUntilDeadline,'Words disappeared before their stored deadline');
   clock.advance(2);
   check(row()?.words===null,'The program’s deadline timer did not erase the stored ciphertext');
   check(JSON.stringify(metadata(row()))===JSON.stringify(storedMetadata),'The eraser changed stored message metadata');
   check(await app.services.comms.words(sample.thread,sample.seq)===null,'The service still returned expired private words');
   const message=await read();
   check(message&&message.words===null,'The browser still received expired private words or lost the message metadata');
   check(JSON.stringify(metadata(message))===JSON.stringify(browserMetadata),'The browser metadata changed across expiry');
   await page.screenshot({path:join(out,screenshot),fullPage:true});
   return{ok:true,observed:'An encrypted, readable reply reached its household deadline; the program timer erased its ciphertext and both service/browser returned no words while retaining metadata.',before,after:{ciphertextErased:true,words:null,metadataRetained:true,metadataCompared:Object.keys(storedMetadata)},thread:sample.thread,seq:sample.seq,screenshot};
  }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{...retentionFailure(error),before,screenshot};}
 };
}

/** Isolate the shorter policy and restart just before the stored deadline. */
export async function shortRetention({browser,home,out}){
 const example=await exampleHome(home);
 let clock=new FakeClock(Date.parse(example.createdAt)),app,context;
 const start=()=>startSharedHome({home,port:0,clock,stdout(){}});
 try{
  app=await start();
  app.writes.run(()=>app.services.household.setSettings({commsDays:3}));
  const reply=await app.services.comms.send({thread:example.thread,sender:'fern',kind:'reply',words:exampleRetentionWords});
  const retention={thread:example.thread,seq:reply.seq,at:reply.at,until:reply.keepUntil};
  await app.close();app=undefined;
  clock=new FakeClock(Date.parse(retention.until)-1000);
  app=await start();
  context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const measure=await prepareRetention({app,example:{retention},home,expectedDays:3,screenshot:'action-conversationShortRetention.png'});
  return await measure({page,clock,out});
 }finally{try{await context?.close();}finally{await app?.close();}}
}
