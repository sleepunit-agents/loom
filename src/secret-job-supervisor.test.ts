import {afterEach,expect,it,vi} from 'vitest';
import {startSecretJobSupervisor} from './secret-job-supervisor.js';
import {startSecretWorkers} from './secret-worker-startup.js';
import {startHolderProcess} from './secret-holder-process.js';
import {secretJobAssignment} from './secret-job-assignment.js';
import {runRuntimeSecretJob} from './runtime-runner/secret-job.js';
vi.mock('./secret-worker-startup.js',()=>({startSecretWorkers:vi.fn(),snapshotSecretWorkers:(v:unknown)=>structuredClone(v)}));
vi.mock('./secret-holder-process.js',()=>({startHolderProcess:vi.fn()}));
vi.mock('./secret-job-assignment.js',()=>({secretJobAssignment:vi.fn()}));
vi.mock('./runtime-runner/secret-job.js',()=>({runRuntimeSecretJob:vi.fn()}));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(){
 const events:string[]=[],stopped=new AbortController();
 const daemon={replaceWorkers:vi.fn(),close:vi.fn(async()=>{events.push('daemon');})};
 const holder={ready:Promise.resolve(),signal:stopped.signal,replaceWorkers:vi.fn(),close:vi.fn(async()=>{events.push('holder');})};
 const source={signal:new AbortController().signal,claimed:vi.fn(),own:vi.fn(),close:vi.fn(async()=>{events.push('source');})};
 vi.mocked(startSecretWorkers).mockResolvedValue(daemon);vi.mocked(startHolderProcess).mockReturnValue(holder);
 vi.mocked(secretJobAssignment).mockReturnValue(source);vi.mocked(runRuntimeSecretJob).mockResolvedValue();
 const config={daemon:{authority:{socket:'/authority'},admission:{socket:'/admission'},holder:{config:{socket:'/holder'},fingerprint:'holder'}},
  holderFile:'/private/holder.json',assignment:{job:'job',agent:'art',command:{command:'/fixed'}},control:{job:'job',url:'https://daemon',token:'synthetic-token'},selected:{agent:'art',house:{repo:'repo',houseFile:'house'},receipts:'/receipts'}} as unknown as Parameters<typeof startSecretJobSupervisor>[3];
 const app={} as Parameters<typeof startSecretJobSupervisor>[0],sharing=vi.fn(),effects={} as Parameters<typeof startSecretJobSupervisor>[2];
 return {events,stopped,daemon,holder,source,config,app,sharing,effects,start:()=>startSecretJobSupervisor(app,sharing,effects,config)};
}
afterEach(()=>vi.resetAllMocks());
it('composes the original capabilities with an empty preclaim daemon and snapshots before IO',async()=>{
 const f=setup(),owner=f.start();f.config.assignment.command.command='/mutated';f.config.control.url='https://mutated';f.config.holderFile='/mutated';
 await owner.ready;expect(startSecretWorkers).toHaveBeenCalledWith(f.app,f.sharing,f.effects,expect.objectContaining({workers:[]}));
 expect(startHolderProcess).toHaveBeenCalledExactlyOnceWith('/private/holder.json');
 expect(secretJobAssignment).toHaveBeenCalledWith(f.app,f.sharing,expect.objectContaining({command:{command:'/fixed'}}),{daemon:f.daemon,holder:f.holder});
 await owner.run();expect(runRuntimeSecretJob).toHaveBeenCalledWith(expect.objectContaining({url:'https://daemon'}),expect.anything(),f.source,undefined);
 expect(f.events).toEqual(['source','holder','daemon']);expect(owner.signal.aborted).toBe(true);
 await expect(owner.run()).rejects.toThrow('Secret job supervisor unavailable');expect(runRuntimeSecretJob).toHaveBeenCalledOnce();
});
it('joins route retirement, original attempt and holder close before daemon shutdown',async()=>{
 const f=setup(),attempt=gate(),routes=gate(),child=gate();
 vi.mocked(runRuntimeSecretJob).mockReturnValue(attempt.promise);f.source.close.mockImplementation(async()=>{await routes.promise;f.events.push('source');});
 f.holder.close.mockImplementation(async()=>{await child.promise;f.events.push('holder');});
 const owner=f.start();await owner.ready;const running=owner.run();await turn();let done=false;
 const closing=owner.close().then(()=>{done=true;});expect(owner.signal.aborted).toBe(true);expect(f.source.close).toHaveBeenCalledOnce();
 await turn();expect(f.holder.close).not.toHaveBeenCalled();routes.resolve();await turn();expect(f.holder.close).not.toHaveBeenCalled();
 attempt.resolve();await turn();expect(f.holder.close).toHaveBeenCalledOnce();expect(f.daemon.close).not.toHaveBeenCalled();expect(done).toBe(false);
 child.resolve();await closing;await running;expect(f.events).toEqual(['source','holder','daemon']);
});
it('holder loss fences the source immediately and joins every owner on failure',async()=>{
 const f=setup(),attempt=gate(),child=gate();vi.mocked(runRuntimeSecretJob).mockReturnValue(attempt.promise);
 f.holder.close.mockImplementation(async()=>{await child.promise;throw Error('private-value');});
 const owner=f.start();await owner.ready;const running=owner.run();void running.catch(()=>{});await turn();f.stopped.abort();
 expect(owner.signal.aborted).toBe(true);expect(f.source.close).toHaveBeenCalledOnce();
 attempt.resolve();await turn();expect(f.daemon.close).not.toHaveBeenCalled();child.resolve();
 await expect(running).rejects.toThrow(/^Secret job supervisor unavailable$/);await expect(owner.close()).rejects.toThrow(/^Secret job supervisor unavailable$/);
 expect(f.daemon.close).toHaveBeenCalledOnce();
});
it('joins startup failure without a ready/run/close promise cycle',async()=>{
 const f=setup(),late=gate();f.holder.ready=late.promise.then(()=>{throw Error('private-value');});const owner=f.start(),running=owner.run();
 const ready=expect(owner.ready).rejects.toThrow(/^Secret job supervisor unavailable$/),run=expect(running).rejects.toThrow(/^Secret job supervisor unavailable$/);
 await turn();late.resolve();await ready;await run;expect(f.holder.close).toHaveBeenCalledOnce();expect(f.daemon.close).toHaveBeenCalledOnce();expect(runRuntimeSecretJob).not.toHaveBeenCalled();
});
it('installs the shared close promise before synchronous abort reentrancy',async()=>{
 const f=setup(),owner=f.start();await owner.ready;let nested:Promise<void>|undefined;owner.signal.addEventListener('abort',()=>{nested=owner.close();});
 const closing=owner.close();expect(nested).toBe(closing);expect(owner.close()).toBe(closing);await closing;
 expect(f.source.close).toHaveBeenCalledOnce();expect(f.holder.close).toHaveBeenCalledOnce();expect(f.daemon.close).toHaveBeenCalledOnce();
});
it('close during daemon startup joins the late owner without launching a holder',async()=>{
 const f=setup(),late=gate();vi.mocked(startSecretWorkers).mockImplementation(async()=>{await late.promise;return f.daemon;});
 const owner=f.start();await turn();const closing=owner.close();late.resolve();await expect(closing).rejects.toThrow();await expect(owner.ready).rejects.toThrow();
 expect(f.daemon.close).toHaveBeenCalledOnce();expect(startHolderProcess).not.toHaveBeenCalled();
});
it('mismatched local job selection refuses all startup IO',async()=>{
 const f=setup();f.config.control.job='other';const owner=f.start();await expect(owner.ready).rejects.toThrow();expect(startSecretWorkers).not.toHaveBeenCalled();
});
it('failed route retirement still joins the held attempt and holder before releasing daemon authority',async()=>{
 const f=setup(),attempt=gate(),child=gate();
 vi.mocked(runRuntimeSecretJob).mockReturnValue(attempt.promise);
 f.source.close.mockRejectedValue(Error('private-retirement-detail'));
 f.holder.close.mockImplementation(async()=>{await child.promise;f.events.push('holder');});
 const owner=f.start();await owner.ready;const running=owner.run();void running.catch(()=>{});await turn();
 let settled=false;const closing=owner.close();void closing.catch(()=>{settled=true;});await turn();
 expect(f.source.close).toHaveBeenCalledOnce();expect(settled).toBe(false);expect(f.holder.close).not.toHaveBeenCalled();expect(f.daemon.close).not.toHaveBeenCalled();
 attempt.resolve();await turn();expect(f.holder.close).toHaveBeenCalledOnce();expect(f.daemon.close).not.toHaveBeenCalled();expect(settled).toBe(false);
 child.resolve();await expect(closing).rejects.toThrow(/^Secret job supervisor unavailable$/);await expect(running).rejects.toThrow(/^Secret job supervisor unavailable$/);
 expect(f.daemon.close).toHaveBeenCalledOnce();expect(f.events).toEqual(['holder','daemon']);
});
