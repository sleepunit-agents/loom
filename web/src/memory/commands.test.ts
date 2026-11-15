import {expect,it,vi} from 'vitest';
import {memoryCall} from './commands';
it('sends one shared HTTP command and retains identical input/id for explicit uncertain retries',async()=>{
 let release!:(response:Response)=>void;
 const send=vi.fn().mockResolvedValueOnce(Response.json({ok:false,code:'unavailable',message:'PRIVATE SQL'},{status:503})).mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;}));
 const input={slug:'fictional-pump'},request=memoryCall('mind.knowledgeVerify',input,send),changed=vi.fn(),stop=request.subscribe(changed);
 expect(await request.result).toEqual({ok:false,code:'unavailable',message:'Memory could not save this change'});
 expect(send).toHaveBeenCalledTimes(1);await Promise.resolve();expect(send).toHaveBeenCalledTimes(1);
 input.slug='another-page';request.retry?.();request.retry?.();expect(send).toHaveBeenCalledTimes(2);expect(request.getSnapshot().pending).toBe(true);
 const [url,init]=send.mock.calls[0];expect(url).toBe('/api/mind/knowledgeVerify');expect(init).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'}});
 expect(JSON.parse(init.body)).toEqual({id:request.id,input:{slug:'fictional-pump'}});expect(send.mock.calls[1][1].body).toBe(init.body);
 release(Response.json({ok:true,value:{slugs:['fictional-pump']}}));await expect.poll(()=>request.getSnapshot().result?.ok).toBe(true);request.retry?.();expect(send).toHaveBeenCalledTimes(2);expect(changed).toHaveBeenCalled();stop();
});
it('does not retry a denied or conclusive command refusal',async()=>{
 for(const [status,body,code] of [[401,{},'denied'],[403,{},'denied'],[409,{ok:false,code:'conflict',message:'Already exists'},'conflict']] as const){
  const send=vi.fn(async()=>Response.json(body,{status})),request=memoryCall('mind.personAdd',{name:'Fictional friend'},send);
  expect(await request.result).toMatchObject({ok:false,code});request.retry?.();expect(send).toHaveBeenCalledTimes(1);
 }
});
it('keeps malformed, partial and network failures generic without automatic replay',async()=>{
 const sends=[async()=>Response.json({ok:true}),async()=>Response.json({ok:true,value:'PRIVATE'},{status:500}),async()=>new Response('PRIVATE HTML',{status:500}),async()=>{throw Error('PRIVATE URL');}];
 for(const send of sends){const fetcher=vi.fn(send),request=memoryCall('mind.knowledgeAdd',{},fetcher);expect(await request.result).toEqual({ok:false,code:'unavailable',message:'Memory could not save this change'});expect(fetcher).toHaveBeenCalledTimes(1);}
});
