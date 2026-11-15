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
