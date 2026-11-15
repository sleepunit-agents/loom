/** Disposable walkthrough adapter. Reuse production encrypted storage, but keep
 * the holder in-process: this does NOT prove separate-process isolation. */
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {generateIdentity} from 'age-encryption';
import {openHolderStore} from '../dist/pieces/secrets/holder-store.js';
const stores=new Map();
/** Test oracle inside the adapter, never a Root route or app read endpoint. */
const holderDirectory=home=>join(home,'walkthrough-holder');
export async function holderValueEquals(home,name,expected){
 const store=stores.get(home);if(!store)throw Error('Walkthrough holder is not active');
 let bytes,comparison;
 try{
  bytes=await store.read(name);comparison=Buffer.from(expected);
  return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).equals(comparison);
 }finally{bytes?.fill(0);comparison?.fill(0);}
}
export function holderValueAbsent(home,name){
 if(!stores.has(home))throw Error('Walkthrough holder is not active');
 const db=new Database(join(holderDirectory(home),'holder.db'),{readonly:true,fileMustExist:true});
 try{return !db.prepare('SELECT 1 FROM holder_values WHERE name=?').get(name);}finally{db.close();}
}
export default async function secretHolder({home}){
 const directory=holderDirectory(home);mkdirSync(directory,{mode:0o700});
 const identity=join(directory,'identity'),holderReceiptKeyFile=join(directory,'holder.key');
 writeFileSync(identity,await generateIdentity(),{mode:0o600,flag:'wx'});
 const key=randomBytes(32);try{writeFileSync(holderReceiptKeyFile,key,{mode:0o600,flag:'wx'});}finally{key.fill(0);}
 const fingerprintKey=randomBytes(32);
 let store;
 try{
  store=await openHolderStore(directory,identity,holderReceiptKeyFile);
  stores.set(home,store);
  return {
   secretWrites:{fingerprintKey,holder:{
    set:(...args)=>store.set(...args),
    async remove(...args){store.remove(...args);},
    async hasReceipt(...args){return store.hasReceipt(...args);},
    async recover(...args){return store.recover(...args);},
   }},
   close(){stores.delete(home);try{store.close();}finally{fingerprintKey.fill(0);}},
  };
 }catch(error){stores.delete(home);try{store?.close();}finally{fingerprintKey.fill(0);}throw error;}
}
