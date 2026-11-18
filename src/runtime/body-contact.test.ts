import {afterEach,expect,it,vi} from 'vitest';
import {bodyConversationClient} from './conversation-client.js';
import {bodyProgramTools} from './body-program-tools.js';
import {bodyNamedTools} from './body-named-tools.js';
import {bodyCommandClient} from './body-command-client.js';
afterEach(()=>vi.useRealTimers());
const options=()=>({url:'https://loom.invalid',token:'test-credential',signal:new AbortController().signal});
it('recovers a timed-out report using the exact receipt and payload after backoff',async()=>{
 vi.useFakeTimers();
 const fetcher=vi.fn<typeof fetch>().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValueOnce(Response.json({ok:true,value:{saved:true,stopRequested:false}}));
 const client=bodyConversationClient({...options(),job:'job',conversation:'room',fetch:fetcher});
 const result=client.status({state:'working',work:'Reading'});void result.catch(()=>{});
 await vi.advanceTimersByTimeAsync(15000);
 expect(fetcher).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(10000);
 expect(await result).toMatchObject({saved:true});expect(fetcher.mock.calls[0][1]?.body).toEqual(fetcher.mock.calls[1][1]?.body);
 client.close();
});
it.each(['loom_query','task_ready'])('tells the model when %s cannot reach Loom for two minutes',async name=>{
 vi.useFakeTimers();
 const fetcher=vi.fn<typeof fetch>().mockRejectedValue(Error('private diagnostic'));
 const tools=bodyProgramTools({...options(),fetch:fetcher,onStatus(){},onStop(){}});
 const named=bodyNamedTools({agent:'art',generic:tools.extensions});
 const result=name==='loom_query'?tools.call(name,{query:'{agents{id}}'}):named.find(tool=>tool.name===name)!.execute({},options().signal);
 let done=false;void result.then(()=>{done=true;});
 await vi.advanceTimersByTimeAsync(119999);
 expect(done).toBe(false);expect(fetcher.mock.calls.length).toBeGreaterThan(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(await result).toMatchObject({isError:true,content:[{text:expect.stringMatching(/Loom.*120 seconds/i)}]});tools.close();
});
it('does not warm memories twice after a lost recall response',async()=>{
 const fetcher=vi.fn<typeof fetch>().mockRejectedValue(Error('lost reply'));
 const client=bodyCommandClient({...options(),fetch:fetcher});
 await expect(client.command('memory.recall',{query:'earlier work'},'same')).rejects.toThrow('outcome may be uncertain');
 expect(fetcher).toHaveBeenCalledTimes(1);client.close();
});
it('retries a command when Loom answers that it is still starting',async()=>{
 vi.useFakeTimers();
 const fetcher=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(Response.json({ok:false,code:'unavailable',message:'Loom is starting'},{status:503}))
  .mockResolvedValueOnce(Response.json({ok:true,value:'ready'}));
 const client=bodyCommandClient({...options(),fetch:fetcher});
 const pending=client.command('fixture.read',{},'stable');
 await vi.advanceTimersByTimeAsync(1000);
 expect(await pending).toEqual({ok:true,value:'ready'});client.close();
});

it.each([116000,119999])('saves the required status with its original receipt after Loom returns at %i ms',async recovery=>{
 vi.useFakeTimers();
 const start=Date.now(), fetcher=vi.fn<typeof fetch>(async()=>{
  if(Date.now()-start<recovery)throw Error('offline');
  return Response.json({ok:true,value:{saved:true,stopRequested:false}});
 });
 const client=bodyConversationClient({...options(),job:'job',conversation:'room',fetch:fetcher});
 const pending=client.status({state:'working',work:'Reading'});void pending.catch(()=>{});
 await vi.advanceTimersByTimeAsync(120000);
 expect(await pending).toMatchObject({saved:true});
 expect(new Set(fetcher.mock.calls.map(([,init])=>init?.body)).size).toBe(1);
 client.close();
});

it('aborts an unanswered final status probe after one second',async()=>{
 vi.useFakeTimers();
 const start=Date.now();
 let probe:AbortSignal|undefined;
 const fetcher:typeof fetch=async (_url,init)=>{
  if(Date.now()-start<120000)throw Error('offline');
  probe=init!.signal!;return new Promise(()=>{});
 };
 const client=bodyConversationClient({...options(),job:'job',conversation:'room',fetch:fetcher});
 const refused=expect(client.status({state:'working',work:'Reading'})).rejects.toThrow(/120 seconds/);
 await vi.advanceTimersByTimeAsync(120999);expect(probe?.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await refused;expect(probe?.aborted).toBe(true);
 client.close();
});
