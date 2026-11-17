/** A replaceable push-signing key in the single home, published atomically.
 * This never reads or rewrites memories or an existing key.
 * The key is kept in clear, in a file only this OS user can read (privateBytes refuses any other mode):
 * the program has to be able to read it unattended, so whoever can read the home holds it.
 */
import {randomUUID,createECDH} from 'node:crypto';
import {existsSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import webpush from 'web-push';
import {privateBytes} from '../../pieces/secrets/local-holder.js';
export function notificationKey(home:string){
 const file=join(home,'push-vapid.json');
 if(!existsSync(file)){
  const scratch=join(home,`.push-${randomUUID()}`),fd=openSync(scratch,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(webpush.generateVAPIDKeys()));fsyncSync(fd);}finally{closeSync(fd);}
  try{linkSync(scratch,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{unlinkSync(scratch);}
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
