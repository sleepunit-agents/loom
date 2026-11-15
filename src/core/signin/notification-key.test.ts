import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {notificationKey} from './notification-key.js';
it('publishes one private persistent key and refuses an existing invalid key without replacing it',()=>{
 const home=mkdtempSync(join(tmpdir(),'fictional-push-key-'));
 try{const first=notificationKey(home),file=join(home,'push-vapid.json');expect(notificationKey(home)).toEqual(first);expect(statSync(file).mode&0o777).toBe(0o600);writeFileSync(file,'invalid');expect(()=>notificationKey(home)).toThrow();expect(readFileSync(file,'utf8')).toBe('invalid');}finally{rmSync(home,{recursive:true,force:true});}
});
