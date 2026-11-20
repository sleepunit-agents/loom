import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,statSync,linkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {notificationKey} from './notification-key.js';
it('publishes one private persistent key and refuses an existing invalid key without replacing it',()=>{
 const home=mkdtempSync(join(tmpdir(),'fictional-push-key-'));
 try{const first=notificationKey(home),file=join(home,'push-vapid.json');expect(notificationKey(home)).toEqual(first);expect(statSync(file).mode&0o777).toBe(0o600);writeFileSync(file,'invalid');expect(()=>notificationKey(home)).toThrow();expect(readFileSync(file,'utf8')).toBe('invalid');}finally{rmSync(home,{recursive:true,force:true});}
});
it('starts after a program was killed while publishing the key, whichever step it had reached',()=>{
 const home=mkdtempSync(join(tmpdir(),'fictional-push-key-')),file=join(home,'push-vapid.json'),scratch=join(home,'.push-6f1c0f0e-8f5d-4c56-9d0f-3b1f6f0c2a11');
 try{
  // Killed after linking and before removing the scratch name: the key has two names.
  const first=notificationKey(home);linkSync(file,scratch);expect(statSync(file).nlink).toBe(2);
  expect(notificationKey(home)).toEqual(first);expect(statSync(file).nlink).toBe(1);
  // Killed before linking: the scratch file is all there is, and it is not left lying about.
  rmSync(file);writeFileSync(scratch,'{"half":',{mode:0o600});
  expect(notificationKey(home)).not.toEqual(first);expect(readdirSync(home)).toEqual(['push-vapid.json']);
 }finally{rmSync(home,{recursive:true,force:true});}
});
