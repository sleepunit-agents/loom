import { describe,it,expect,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileBodyRules } from '../pieces/runtime/body-policy.js';
import { ClaudeWorkerSession,type SpawnClaude,type WorkerTurn } from './session.js';
const binding={agent:'art',conversation:'cv-one',venue:'slack',place:'dm:one'};
const rules={key:'a'.repeat(64),deny:['mcp__secrets','Bash(rm *)'],sections:[{text:'OWNER RULES'}]};
function fixture() {
  const calls:Array<{args:readonly string[];input:string;child:EventEmitter & {stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;killed:boolean;kill:()=>boolean};options:unknown}>=[];
  const launch:SpawnClaude=(_command,args,options)=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,
      kill(){this.killed=true;return true;}});
    const call={args,input:'',child,options};child.stdin.on('data',d=>call.input+=d.toString());calls.push(call);
    return child as ReturnType<SpawnClaude>;
  };
  const session=new ClaudeWorkerSession('/worker/claude',{WORKER:'yes'},launch);
  const turn:WorkerTurn={binding,rules,message:'private message',current:()=>true};
  const finish=(data:Record<string,unknown>={},code=0)=>{
    const call=calls.at(-1)!;const args=call.args;const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
    call.child.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:id,result:'reply',...data}));call.child.emit('close',code);
  };
  return {session,turn,calls,finish};
}
describe('worker-owned Claude session',()=>{
  it('enforces exact denies and brief on actual spawn arguments/stdin, then resumes its own session',async()=>{
    const f=fixture(),p=f.session.turn(f.turn);expect(f.calls[0].args).toEqual(['-p','--output-format','json','--session-id',expect.any(String),'--disallowedTools',...rules.deny]);
    expect(f.calls[0].input).toBe('OWNER RULES\nprivate message');expect(f.calls[0].args.join(' ')).not.toContain('private message');
    expect(f.calls[0].options).toMatchObject({shell:false,env:{WORKER:'yes'},stdio:['pipe','pipe','pipe']});
    f.finish();const first=await p;const q=f.session.turn(f.turn);expect(f.calls[1].args).toContain('--resume');f.finish();expect(await q).toEqual({...first,resumed:true});
  });
  it.each(['agent','conversation','venue','place'] as const)('refuses a changed original %s even with identical rules',async key=>{
    const f=fixture(),p=f.session.turn(f.turn);f.finish();await p;
    await expect(f.session.turn({...f.turn,binding:{...binding,[key]:'other'}})).rejects.toThrow('Original');expect(f.calls).toHaveLength(1);
    await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });
  it('starts fresh after effective rules change',async()=>{
    const f=fixture(),p=f.session.turn(f.turn);f.finish();const first=await p;
    const q=f.session.turn({...f.turn,rules:{...rules,deny:['mcp__other']}});expect(f.calls[1].args).not.toContain('--resume');f.finish();expect((await q).session).not.toBe(first.session);
  });
  it('rejects concurrent turns without invalidating the active one',async()=>{
    const f=fixture(),p=f.session.turn(f.turn);await expect(f.session.turn(f.turn)).rejects.toThrow('busy');f.finish();await expect(p).resolves.toMatchObject({text:'reply'});
  });
  it.each([false,'throws'])('refuses stale owning authority before spawning (%s)',async state=>{
    const f=fixture();await expect(f.session.turn({...f.turn,current:()=>{if(state==='throws')throw Error();return false;}})).rejects.toThrow('current');expect(f.calls).toHaveLength(0);
  });
  it('checks again before releasing input and kills revoked child',async()=>{
    const f=fixture();let n=0;const p=f.session.turn({...f.turn,current:()=>++n<3});await expect(p).rejects.toThrow('revoked');expect(f.calls[0].input).toBe('');expect(f.calls[0].child.killed).toBe(true);
  });
  it('withholds late replies and history after revocation',async()=>{
    const f=fixture();let current=true;const p=f.session.turn({...f.turn,current:()=>current});current=false;f.finish();await expect(p).rejects.toThrow('current');await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });
  it('close kills active execution and permanently withholds its late success',async()=>{
    const f=fixture(),p=f.session.turn(f.turn);f.session.close();expect(f.calls[0].child.killed).toBe(true);f.finish();await expect(p).rejects.toThrow('current');
  });
  it.each([{session_id:'foreign'},{is_error:true},{type:'other'},{result:7}])('discards history after invalid harness result %j',async data=>{
    const f=fixture(),p=f.session.turn(f.turn);f.finish(data);await expect(p).rejects.toThrow('invalid');await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });
  it('fails bounded output and does not reuse its uncertain native history',async()=>{
    const f=fixture(),p=f.session.turn(f.turn);f.calls[0].child.stdout.write(Buffer.alloc(1_048_577));await expect(p).rejects.toThrow('limit');
    await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });
  it('does not start when required policy files are missing',async()=>{
    const f=fixture();await expect(f.session.turn({...f.turn,rules:{...rules,sections:[{file:'missing.md',what:'floor'}]}})).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
  it('compiles real guest policy and starts fresh when required floor bytes change',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'worker-floor-'));
    try {
      writeFileSync(join(dir,'floor.md'),'FIRST FLOOR');
      const compiled=await compileBodyRules({conversation:binding,messages:[{from:{kind:'person',slug:'guest'}}],
        platform:true,about:{kind:'dm',venue:'slack',members:['guest']},gates:{people:{guest:{tier:1}}},
        policy:{guest_deny:['mcp__secrets'],briefs:{guest:'floor.md'}}},async()=> 'Guest card');
      const f=fixture(),turn={...f.turn,rules:compiled,checkout:dir},p=f.session.turn(turn);
      expect(f.calls[0].args).toContain('mcp__secrets');expect(f.calls[0].input).toContain('FIRST FLOOR');
      f.finish();const first=await p;writeFileSync(join(dir,'floor.md'),'SECOND FLOOR');
      const q=f.session.turn(turn);expect(f.calls[1].args).not.toContain('--resume');expect(f.calls[1].input).toContain('SECOND FLOOR');
      f.finish();expect((await q).session).not.toBe(first.session);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('never resumes the same rules in a different checkout',async()=>{
    const f=fixture(),p=f.session.turn({...f.turn,checkout:'/worker/one'});f.finish();await p;
    const q=f.session.turn({...f.turn,checkout:'/worker/two'});expect(f.calls[1].args).not.toContain('--resume');f.finish();await q;
  });
  it.each(['error','input','output','diagnostics','exit'])('fences failed execution (%s)',async kind=>{
    const f=fixture(),p=f.session.turn(f.turn),child=f.calls[0].child;
    if(kind==='exit')f.finish({},1);
    else if(kind==='error')child.emit('error',new Error('sensitive'));
    else ({input:child.stdin,output:child.stdout,diagnostics:child.stderr}[kind]!).emit('error',new Error('sensitive'));
    await expect(p).rejects.toThrow();expect(child.killed).toBe(true);
    await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });

  it.each(['diagnostics','combined'])('bounds all harness output (%s)',async kind=>{
    const f=fixture(),p=f.session.turn(f.turn),child=f.calls[0].child;
    if(kind==='combined')child.stdout.write(Buffer.alloc(524288));
    child.stderr.write(Buffer.alloc(kind==='combined'?524289:1048577));
    await expect(p).rejects.toThrow('limit');expect(child.killed).toBe(true);
    await expect(f.session.turn(f.turn)).rejects.toThrow('closed');
  });
  it('never reflects sensitive diagnostics or child error messages',async()=>{
    const f=fixture(),p=f.session.turn(f.turn),child=f.calls[0].child;
    child.stderr.write('PRIVATE DIAGNOSTIC');child.stdout.write('PRIVATE OUTPUT');
    child.emit('error',new Error('PRIVATE ERROR'));
    const error=await p.catch(e=>e as Error);
    expect(error.message).toBe('Claude launch failed');expect(error.stack).not.toContain('PRIVATE');
  });

  it.each(['--resume','--permission-mode',' -p','   '])('refuses deny values parsed as harness options (%j)',async deny=>{
    const f=fixture();await expect(f.session.turn({...f.turn,rules:{...rules,deny:[deny]}})).rejects.toThrow('deny');expect(f.calls).toHaveLength(0);
  });

  it('captures the effective checkout even when the caller omits it',async()=>{
    const cwd=vi.spyOn(process,'cwd').mockReturnValue('/worker/first');
    try {
      const f=fixture(),p=f.session.turn(f.turn);expect(f.calls[0].options).toMatchObject({cwd:'/worker/first'});f.finish();await p;
      cwd.mockReturnValue('/worker/second');const q=f.session.turn(f.turn);
      expect(f.calls[1].args).not.toContain('--resume');expect(f.calls[1].options).toMatchObject({cwd:'/worker/second'});f.finish();await q;
    } finally {cwd.mockRestore();}
  });
  it.each(['relative','',String.fromCharCode(47,0)])('refuses unsafe checkout %j before spawning',async checkout=>{
    const f=fixture();await expect(f.session.turn({...f.turn,checkout})).rejects.toThrow('absolute');expect(f.calls).toHaveLength(0);
  });
  it('sanitizes synchronous launch failures and permanently fences the session',async()=>{
    const session=new ClaudeWorkerSession('/worker/claude',{},()=>{throw Error('PRIVATE ENVIRONMENT');});
    const f=fixture(),error=await session.turn(f.turn).catch(e=>e as Error);
    expect(error.message).toBe('Claude launch failed');expect(error.stack).not.toContain('PRIVATE');
    await expect(session.turn(f.turn)).rejects.toThrow('closed');
  });

});
