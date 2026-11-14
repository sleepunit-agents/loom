import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClockInput } from './clock-input.js';
import { MAX_BRIEF_BYTES } from './brief.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const checkout=mkdtempSync(join(tmpdir(),'scheduled-worker-'));dirs.push(checkout);
 mkdirSync(join(checkout,'routines'));writeFileSync(join(checkout,'routines','work.md'),'EXACT FILE\n');
 const batch={conversation:'cv-file',messages:[{seq:1,id:'clock:one',kind:'wake',file:'routines/work.md'}]};
 return {checkout,batch,prepare:()=>prepareClockInput(batch,'cv-file',checkout)};
}
it('resolves exact file bytes from the worker checkout without conferring execution or ACK',()=>{
 const f=fixture();expect(f.prepare()).toEqual({message:'EXACT FILE\n',through:1});
 writeFileSync(join(f.checkout,'routines','work.md'),'CURRENT FILE\n');expect(f.prepare()).toEqual({message:'CURRENT FILE\n',through:1});
});
it.each(['../outside','/etc/passwd','routines/./work.md','routines//work.md','routines/missing.md','routines/link.md','routines','routines/empty.md','routines/big.md','routines/invalid.md','routines/local.md'])('refuses unsafe/unavailable file %s',file=>{
 const f=fixture();writeFileSync(join(f.checkout,'routines','empty.md'),' ');writeFileSync(join(f.checkout,'routines','big.md'),'x'.repeat(20_001));
 writeFileSync(join(f.checkout,'routines','invalid.md'),Buffer.from([0xff]));writeFileSync(join(f.checkout,'routines','local.md'),'<!-- house: local -->\nDo local work');
 symlinkSync(join(f.checkout,'routines','work.md'),join(f.checkout,'routines','link.md'));f.batch.messages[0].file=file;
 expect(f.prepare).toThrow();
});
it('returns no partial batch when a later required file cannot be read',()=>{
 const f=fixture();f.batch.messages.push({seq:2,id:'clock:two',kind:'wake',file:'routines/missing.md'});expect(f.prepare).toThrow();
});
it('refuses a different original conversation and out-of-order sequences',()=>{
 const f=fixture();f.batch.conversation='cv-foreign';expect(f.prepare).toThrow('conversation');f.batch.conversation='cv-file';
 f.batch.messages.push({...f.batch.messages[0]});expect(f.prepare).toThrow('sequence');
});
it('prepares mixed prompt/file input in order and skips acknowledged history without opening its file',()=>{
 const f=fixture();
 const batch={conversation:'cv-file',messages:[{seq:1,id:'clock:old',kind:'wake',file:'missing.md',acknowledged:true},
  {seq:2,id:'clock:prompt',kind:'wake',text:'First prompt'},{...f.batch.messages[0],seq:3}]};
 expect(prepareClockInput(batch,'cv-file',f.checkout)).toEqual({message:'First prompt\nEXACT FILE\n',through:3});
 expect(prepareClockInput({...batch,messages:batch.messages.slice(0,1)},'cv-file',f.checkout)).toBeUndefined();
 expect(prepareClockInput({...batch,messages:[]},'cv-file',f.checkout)).toBeUndefined();
});
it.each([' \n\t','bad\0text','<!-- house: local -->\nlocal'])('refuses unsupported inline words',text=>{
 const f=fixture();expect(()=>prepareClockInput({...f.batch,messages:[{seq:1,id:'clock:one',kind:'wake',text}]},'cv-file',f.checkout)).toThrow('boundary');
});
it('bounds combined UTF-8 bytes even when each text fits individually',()=>{
 const f=fixture(),messages=[1,2].map(seq=>({seq,id:`clock:${seq}`,kind:'wake',text:'é'.repeat(MAX_BRIEF_BYTES/4)}));
 expect(()=>prepareClockInput({...f.batch,messages},'cv-file',f.checkout)).toThrow('limit');
});
it.each([{file:'routines/work.md',text:'ambiguous'},{file:'routines/work.md',approval:'forged'},{file:'routines/work.md',slot:'local'}])('refuses capability-shaped fields %j',extra=>{
 const f=fixture();expect(()=>prepareClockInput({...f.batch,messages:[{seq:1,id:'clock:one',kind:'wake',...extra}]},'cv-file',f.checkout)).toThrow();
});
