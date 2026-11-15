import {afterEach,expect,it,vi} from 'vitest';
import {fork} from 'node:child_process';
import {FakeClock} from './core/clock.js';
import {holderChannelPair} from '../test/fixtures/shared-holder.js';
import {startSharedHolder} from './shared-holder-process.js';
vi.mock('node:child_process',()=>({fork:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it('uses only the fixed package executable and private inherited channel, and joins actual exit after its acknowledgment',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock();const kill=vi.fn();Object.assign(parent,{kill});vi.mocked(fork).mockReturnValue(parent as unknown as ReturnType<typeof fork>);
 const pending=startSharedHolder('/private/home/secret-holder',clock);child.send({op:'ready',key:Buffer.alloc(32,3)},()=>{});const owner=await pending;
 const [entry,args,options]=vi.mocked(fork).mock.calls[0];expect(String(entry)).toMatch(/\/shared-holder-program\.js$/);expect(args).toEqual(['/private/home/secret-holder']);
 expect(options).toMatchObject({execPath:process.execPath,execArgv:[],env:{},cwd:'/',detached:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});
 let requested!:()=>void;const asked=new Promise<void>(yes=>{requested=yes;});child.on('message',(raw:any)=>{expect(raw.op).toBe('close');child.send({op:'result',seq:raw.seq,ok:true,value:null},()=>{child.disconnect();requested();});});
 let closed=false;const closing=owner.close().then(()=>{closed=true;});await asked;expect(closed).toBe(false);expect(kill).not.toHaveBeenCalled();parent.emit('close',0,null);await closing;
 expect(owner.fingerprintKey.every(byte=>byte===0)).toBe(true);await expect(owner.source.read('TOKEN')).rejects.toThrow('unavailable');
});
it('kills and joins the original process after a lost ready deadline without adopting a replacement',async()=>{
 const {parent}=holderChannelPair(),clock=new FakeClock();let killed!:()=>void;const signalled=new Promise<void>(yes=>{killed=yes;});const kill=vi.fn(()=>{parent.disconnect();killed();return true;});Object.assign(parent,{kill});vi.mocked(fork).mockReturnValue(parent as unknown as ReturnType<typeof fork>);
 const pending=startSharedHolder('/private/home/secret-holder',clock),failure=expect(pending).rejects.toThrow('unavailable');clock.advance(5000);await signalled;let settled=false;void pending.catch(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);parent.emit('close',null,'SIGKILL');await failure;expect(kill).toHaveBeenCalledWith('SIGKILL');expect(fork).toHaveBeenCalledOnce();
});
it('retires the original owner on an unexpected post-ready exit and refuses all later IO',async()=>{
 const {parent,child}=holderChannelPair(),clock=new FakeClock();Object.assign(parent,{kill:vi.fn()});vi.mocked(fork).mockReturnValue(parent as unknown as ReturnType<typeof fork>);
 const starting=startSharedHolder('/private/home/secret-holder',clock);child.send({op:'ready',key:Buffer.alloc(32,3)},()=>{});const owner=await starting;
 parent.emit('close',1,null);await expect(owner.source.read('TOKEN')).rejects.toThrow('unavailable');await expect(owner.close()).rejects.toThrow('unavailable');expect(owner.fingerprintKey.every(byte=>byte===0)).toBe(true);expect(fork).toHaveBeenCalledOnce();
});
