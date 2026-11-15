import {it,expect} from 'vitest';
import {Encrypter,generateX25519Identity,identityToRecipient} from 'age-encryption';
import {encryptedStorage,retentionFailure,ObservedRetentionFailure} from './rebuild-retention.mjs';
it('requires authenticated ciphertext readable with the right key and rejected with another key or altered bytes',async()=>{
 const key=await generateX25519Identity(),words='Fictitious retained words',encrypt=new Encrypter();encrypt.addRecipient(await identityToRecipient(key));const blob=Buffer.from(await encrypt.encrypt(words));
 expect(await encryptedStorage(blob,key,words)).toBe(true);
 for(const wrong of [Buffer.from(words),Buffer.from(Buffer.from(words).toString('base64')),Buffer.from('age-encryption.org/v1\n'+Buffer.from(words).toString('base64'))])expect(await encryptedStorage(wrong,key,words)).toBe(false);
 expect(await encryptedStorage(blob,await generateX25519Identity(),words)).toBe(false);expect(await encryptedStorage(blob,key,'Other words')).toBe(false);
});
it('distinguishes observed retention failures from incomplete measurement',()=>{
 expect(retentionFailure(new ObservedRetentionFailure('Stored ciphertext survived its deadline'))).toEqual({ok:false,error:expect.stringContaining('survived')});
 expect(retentionFailure(new Error('fetch or browser evaluation failed'))).toMatchObject({inconclusive:true});
});
