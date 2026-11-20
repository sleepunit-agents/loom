/** A replaceable push-signing key in the single home, published atomically.
 * This never reads or rewrites memories or an existing key.
 * The key is kept in clear, in a file only this OS user can read (privateBytes refuses any other mode):
 * the program has to be able to read it unattended, so whoever can read the home holds it
 * (docs/accepted-tradeoffs.md).
 */
import {randomUUID,createECDH} from 'node:crypto';
import {existsSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import webpush from 'web-push';
import {privateBytes} from '../../pieces/secrets/local-holder.js';
const scratchName=/^\.push-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function notificationKey(home:string){
 const file=join(home,'push-vapid.json');
 // A program killed while publishing left its scratch file: unpublished key material, or, if it had
 // already linked it, a second name for the key, which privateBytes refuses on every later start. One
 // program owns a home (ownHome, shared-startup.ts), so any scratch file found here is a dead one.
 for(const name of readdirSync(home))if(scratchName.test(name))rmSync(join(home,name),{force:true});
 if(!existsSync(file)){
  const scratch=join(home,`.push-${randomUUID()}`),fd=openSync(scratch,'wx',0o600);
  try{
   try{writeFileSync(fd,JSON.stringify(webpush.generateVAPIDKeys()));fsyncSync(fd);}finally{closeSync(fd);}
   try{linkSync(scratch,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }finally{rmSync(scratch,{force:true});}
 }
 const bytes=privateBytes(file);
 try{
  const value=JSON.parse(bytes.toString('utf8'));
  if(!value||typeof value.publicKey!=='string'||typeof value.privateKey!=='string')throw Error('Invalid push key');
  const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(Buffer.from(value.privateKey,'base64url'));
  if(ecdh.getPublicKey().toString('base64url')!==value.publicKey)throw Error('Invalid push key pair');
  return {publicKey:value.publicKey as string,privateKey:value.privateKey as string};
 }finally{bytes.fill(0);}
}
