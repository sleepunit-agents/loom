import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runClockTurn } from './clock-turn.js';
import { ClaudeWorkerSession, type SpawnClaude } from './session.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const checkout=mkdtempSync(join(tmpdir(),'scheduled-worker-'));dirs.push(checkout);
 mkdirSync(join(checkout,'routines'));writeFileSync(join(checkout,'routines','work.md'),'EXACT FILE\n');
 const calls:Array<{args:readonly string[];input:string;child:EventEmitter & {stdout:PassThrough;stdin:PassThrough;kill:ReturnType<typeof vi.fn>}}>=[];
 const launch:SpawnClaude=(_cmd,args)=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>true)});
  const call={args,input:'',child};child.stdin.on('data',b=>call.input+=b.toString());calls.push(call);
  return child as ReturnType<SpawnClaude>;
 };
 const session=new ClaudeWorkerSession('/worker/claude',{},launch);
 let current=true;
 const turn={binding:{agent:'art',conversation:'cv-file',venue:'wake',place:'wake:one'},checkout,
  rules:{key:'a'.repeat(64),deny:['mcp__secrets'],sections:[{text:'RULES'}]},current:()=>current};
 const batch={conversation:'cv-file',messages:[{seq:1,id:'clock:one',kind:'wake',file:'routines/work.md'}]};
 const inbox={read:vi.fn(async()=>batch),acknowledge:vi.fn(async(_through:number)=>{})};
 const finish=(ok=true)=>{const c=calls.at(-1)!;c.child.stdout.write(JSON.stringify({type:'result',is_error:!ok,session_id:c.args[c.args.indexOf('--session-id')+1],result:'done'}));c.child.emit('close',0);};
 return {checkout,session,turn,batch,inbox,calls,finish,revoke(){current=false;}};
}
it('passes exact file bytes to stdin with the compiled policy and acknowledges only after success',async()=>{
 const f=fixture(),p=runClockTurn(f.session,f.turn,f.inbox);await Promise.resolve();
 expect(f.calls[0].input).toBe('RULES\nEXACT FILE\n');expect(f.calls[0].args).toContain('mcp__secrets');
 expect(f.calls[0].args.join(' ')).not.toContain('EXACT FILE');expect(f.inbox.acknowledge).not.toHaveBeenCalled();
 f.finish();await p;expect(f.inbox.acknowledge).toHaveBeenCalledExactlyOnceWith(1);
});
it.each(['../outside','/etc/passwd','routines/./work.md','routines//work.md','routines/missing.md','routines/link.md','routines','routines/empty.md','routines/big.md','routines/invalid.md','routines/local.md'])('refuses unsafe/unavailable file %s without execution or ACK',async file=>{
 const f=fixture();writeFileSync(join(f.checkout,'routines','empty.md'),' ');writeFileSync(join(f.checkout,'routines','big.md'),'x'.repeat(20_001));
 writeFileSync(join(f.checkout,'routines','invalid.md'),Buffer.from([0xff]));writeFileSync(join(f.checkout,'routines','local.md'),'<!-- house: local -->\nDo local work');
 symlinkSync(join(f.checkout,'routines','work.md'),join(f.checkout,'routines','link.md'));
 f.batch.messages[0].file=file;
 await expect(runClockTurn(f.session,f.turn,f.inbox)).rejects.toThrow();expect(f.calls).toHaveLength(0);expect(f.inbox.acknowledge).not.toHaveBeenCalled();
});
it('resolves every required file before launching any input in the batch',async()=>{
 const f=fixture();f.batch.messages.push({seq:2,id:'clock:two',kind:'wake',file:'routines/missing.md'});
 await expect(runClockTurn(f.session,f.turn,f.inbox)).rejects.toThrow();expect(f.calls).toHaveLength(0);expect(f.inbox.acknowledge).not.toHaveBeenCalled();
});
it.each(['before-read','after-read','during-execution'])('rechecks owning authority %s and never acknowledges revoked work',async when=>{
 const f=fixture();if(when==='before-read')f.revoke();
 if(when==='after-read')f.inbox.read.mockImplementation(async()=>{f.revoke();return f.batch;});
 const p=runClockTurn(f.session,f.turn,f.inbox);
 if(when==='during-execution'){await Promise.resolve();f.revoke();f.finish();}
 await expect(p).rejects.toThrow();expect(f.inbox.acknowledge).not.toHaveBeenCalled();
 if(when!=='during-execution')expect(f.calls).toHaveLength(0);
});
it('rejects a different conversation before resolving or launching a file',async()=>{
 const f=fixture();f.batch.conversation='cv-foreign';
 await expect(runClockTurn(f.session,f.turn,f.inbox)).rejects.toThrow('conversation');expect(f.calls).toHaveLength(0);expect(f.inbox.acknowledge).not.toHaveBeenCalled();
});
it('withholds acknowledgement after uncertain native execution',async()=>{
 const f=fixture(),p=runClockTurn(f.session,f.turn,f.inbox);await Promise.resolve();f.finish(false);
 await expect(p).rejects.toThrow();expect(f.inbox.acknowledge).not.toHaveBeenCalled();expect(f.calls).toHaveLength(1);
});
it('does not repeat execution when acknowledgement is lost',async()=>{
 const f=fixture();f.inbox.acknowledge.mockRejectedValue(Error('lost ACK'));
 const p=runClockTurn(f.session,f.turn,f.inbox);await Promise.resolve();f.finish();
 await expect(p).rejects.toThrow('lost ACK');expect(f.calls).toHaveLength(1);expect(f.inbox.acknowledge).toHaveBeenCalledTimes(1);
});
