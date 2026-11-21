import { afterEach, expect, it, vi } from 'vitest';
import { memberOperation } from './operation';
afterEach(()=>vi.unstubAllGlobals());
it('returns the acknowledged value through the shared cookie HTTP envelope without a live store',async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{thread:'th:draft'}}));vi.stubGlobal('fetch',fetch);
 expect(await memberOperation<{thread:string}>('comms.open',{thread:'th:draft',agent:'art',title:'New conversation'})).toEqual({thread:'th:draft'});
 expect(fetch).toHaveBeenCalledTimes(1);
 const [path,request]=fetch.mock.calls[0];expect(path).toBe('/api/comms/open');expect(request.credentials).toBe('same-origin');
 const body=JSON.parse(request.body);expect(body).toEqual({id:expect.any(String),input:{thread:'th:draft',agent:'art',title:'New conversation'}});
});
it.each([{ok:false,code:'denied'},null,{}, {ok:'true',value:{thread:'wrong'}}])('rejects an unconfirmed result without retrying',async result=>{
 const fetch=vi.fn().mockResolvedValue(Response.json(result));vi.stubGlobal('fetch',fetch);
 await expect(memberOperation('comms.send',{thread:'th:draft',clientId:'draft',words:'Fixture message'})).rejects.toThrow('Could not save');expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects an HTTP denial even when its body claims success',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({ok:true,value:{}},{status:403})));
 await expect(memberOperation('household.setPreferences',{look:'daylight'})).rejects.toThrow('Could not save');
});
it('submits an Inbox answer on plain HTTP when only getRandomValues is available',async()=>{
 const source=crypto;
 vi.stubGlobal('crypto',{getRandomValues:source.getRandomValues.bind(source)});
 const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{}}));vi.stubGlobal('fetch',fetch);
 await memberOperation('inbox.answer',{item:'fixture',answer:'yes'});
 const [path,request]=fetch.mock.calls[0];
 expect(path).toBe('/api/inbox/answer');
 expect(JSON.parse(request.body).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
