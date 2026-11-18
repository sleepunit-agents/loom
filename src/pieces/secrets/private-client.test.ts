import {expect,it,vi} from 'vitest';
import {FakeClock} from '../../core/clock.js';
import {privateSecretClient} from './private-client.js';
const use='use-input-'+'a'.repeat(64);
const value=()=>new Response('SYNTHETIC_PRIVATE',{headers:{'content-type':'application/octet-stream','x-loom-secret-use':use}});
const options=(fetch:typeof globalThis.fetch)=>({url:'https://loom.test',token:'synthetic',signal:new AbortController().signal,clock:new FakeClock(),fetch});
it.each(['http://remote.test','https://u:p@loom.test','https://loom.test/path','https://loom.test/?secret=x','bad-url'])('rejects unsafe origins before transport: %s',url=>{
 const fetch=vi.fn<typeof globalThis.fetch>();expect(()=>privateSecretClient({...options(fetch),url})).toThrow(/^Private secret input unavailable$/);expect(fetch).not.toHaveBeenCalled();
});
it('refuses a timeout beyond the absolute 15 second bound',()=>{
 const fetch=vi.fn<typeof globalThis.fetch>();expect(()=>privateSecretClient({...options(fetch),timeoutMs:15001})).toThrow(/^Private secret input unavailable$/);
});
it.each(['redirect','declared','stream','bad-type'])('rejects an invalid private response without confirmation: %s',async kind=>{
 const response=kind==='redirect'?new Response(null,{status:302,headers:{location:'https://elsewhere.test'}}):kind==='declared'?new Response('x',{headers:{'content-length':'65537'}}):kind==='stream'?new Response(new Uint8Array(65537),{headers:{'content-type':'application/octet-stream','x-loom-secret-use':use}}):new Response('x');
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>response),client=privateSecretClient(options(fetch));
 try{await expect(client.granted('TOKEN')).rejects.toThrow(/^Private secret input unavailable$/);expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][1]?.redirect).toBe('error');}finally{client.close();}
});
it.each(['malformed','false','extra','oversize','rejected'])('erases bytes and never retries an uncertain confirmation: %s',async kind=>{
 const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(value()).mockResolvedValueOnce(new Response(kind==='malformed'?'{':kind==='oversize'?'x'.repeat(4097):JSON.stringify({confirmed:kind!=='false',...(kind==='extra'?{extra:true}:{})}),{status:kind==='rejected'?503:200}));
 const client=privateSecretClient(options(fetch));try{await expect(client.granted('TOKEN')).rejects.toThrow(/^Private secret input unavailable$/);expect(fetch).toHaveBeenCalledTimes(2);}finally{client.close();}
});
it('cancels a pending confirmation on the absolute deadline and disposes late response bodies',async()=>{
 const clock=new FakeClock();let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const cancel=vi.fn();
 const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(value()).mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});const client=privateSecretClient({...options(fetch),clock});
 try{const pending=client.granted('TOKEN'),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);await started;clock.advance(15000);await refused;release(new Response(new ReadableStream({cancel})));await fetch.mock.results[1].value;await Promise.resolve();expect(cancel).toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(2);}finally{client.close();}
});
it('rejects an oversized startup plan without reading any value',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({aliases:Array.from({length:129},(_,i)=>({alias:'A'+i}))}));const client=privateSecretClient(options(fetch));try{await expect(client.startup()).rejects.toThrow(/^Private secret input unavailable$/);expect(fetch).toHaveBeenCalledOnce();}finally{client.close();}
});
it('bounds startup plan bytes independently of alias count',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(' '.repeat(131073)));const client=privateSecretClient(options(fetch));try{await expect(client.startup()).rejects.toThrow(/^Private secret input unavailable$/);expect(fetch).toHaveBeenCalledOnce();}finally{client.close();}
});
it('erases every startup value when their aggregate exceeds one MiB',async()=>{
 const values:Buffer[]=[],concat=Buffer.concat,spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.length===65536)values.push(bytes);return bytes;});
 const fetch=vi.fn<typeof globalThis.fetch>(async url=>String(url).endsWith('/startup')?Response.json({aliases:Array.from({length:17},(_,i)=>({alias:'A'+i}))}):String(url).endsWith('/confirm')?Response.json({confirmed:true}):new Response(new Uint8Array(65536).fill(42),{headers:{'content-type':'application/octet-stream','x-loom-secret-use':use}}));const client=privateSecretClient(options(fetch));
 try{await expect(client.startup()).rejects.toThrow(/^Private secret input unavailable$/);expect(values).toHaveLength(17);expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);}finally{client.close();spy.mockRestore();}
});
it.each(['close','abort'] as const)('synchronously erases an already confirmed startup batch on %s',async kind=>{
 const abort=new AbortController(),values:Buffer[]=[],concat=Buffer.concat;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let reads=0;
 const spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.toString()==='SYNTHETIC_PRIVATE')values.push(bytes);return bytes;});
 const fetch=vi.fn<typeof globalThis.fetch>(async url=>{
  if(String(url).endsWith('/startup'))return Response.json({aliases:[{alias:'A'},{alias:'B'}]});
  if(String(url).endsWith('/confirm'))return Response.json({confirmed:true});
  if(++reads===1)return value();entered();return new Promise<Response>(()=>{});
 });const client=privateSecretClient({...options(fetch),signal:abort.signal});
 try{const pending=client.startup(),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);await started;expect(values.some(bytes=>bytes.some(byte=>byte!==0))).toBe(true);if(kind==='close')client.close();else abort.abort();expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);await refused;}finally{client.close();spy.mockRestore();}
});
it('keeps a one second consent poll interval even with a short network timeout',async()=>{
 const clock=new FakeClock(),fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({pending:true},{status:423})).mockResolvedValueOnce(new Response(null,{status:204}));const client=privateSecretClient({...options(fetch),clock,timeoutMs:100});
 try{const pending=client.repository('job');for(let i=0;i<32;i++)await Promise.resolve();clock.advance(999);for(let i=0;i<8;i++)await Promise.resolve();expect(fetch).toHaveBeenCalledOnce();clock.advance(1);expect(await pending).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(2);}finally{client.close();}
});
it.each(['close','abort'] as const)('cancels consent polling on %s without another read',async kind=>{
 const clock=new FakeClock(),abort=new AbortController(),fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({pending:true},{status:423}));const client=privateSecretClient({...options(fetch),clock,signal:abort.signal});
 try{const pending=client.repository('job'),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);for(let i=0;i<32;i++)await Promise.resolve();if(kind==='close')client.close();else abort.abort();await refused;clock.advance(10000);for(let i=0;i<8;i++)await Promise.resolve();expect(fetch).toHaveBeenCalledOnce();}finally{client.close();}
});
it.each(['abort','close'] as const)('cancels pending startup consent on %s without reading a value',async kind=>{
 const clock=new FakeClock(),abort=new AbortController(),fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({aliases:[{alias:'GRANTED'}],pending:true}));const client=privateSecretClient({...options(fetch),signal:abort.signal,clock,timeoutMs:100});
 try{const pending=client.startup(),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);for(let i=0;i<32;i++)await Promise.resolve();clock.advance(999);expect(fetch).toHaveBeenCalledOnce();if(kind==='abort')abort.abort();else client.close();await refused;clock.advance(10000);for(let i=0;i<8;i++)await Promise.resolve();expect(fetch).toHaveBeenCalledOnce();}finally{client.close();}
});
it('retries the startup alias listing after a connection failure before reading any private value',async()=>{
 const fetcher=vi.fn<typeof fetch>().mockRejectedValueOnce(Error('lost metadata')).mockResolvedValueOnce(Response.json({aliases:[]}));
 const config=options(fetcher),scheduled=vi.spyOn(config.clock,'at'),client=privateSecretClient(config);
 const result=client.startup();void result.catch(()=>{});
 try{
  await vi.waitFor(()=>expect(scheduled).toHaveBeenCalledWith(config.clock.now()+1000,expect.any(Function)));
  config.clock.advance(1000);expect(await result).toEqual(new Map());
  expect(fetcher.mock.calls.map(([url])=>new URL(String(url)).pathname)).toEqual(['/api/secrets/private/startup','/api/secrets/private/startup']);
 }finally{client.close();}
});

const refusedConnection=()=>new TypeError('fetch failed',{cause:Object.assign(Error(),{code:'ECONNREFUSED'})});
it.each(['repository','startup','granted'] as const)('recovers a %s value read at 120 seconds from the first refusal',async kind=>{
 vi.useFakeTimers();
 const start=Date.now(),firstRefusal=start+137000;
 let reads=0,confirmations=0;
 const fetcher=vi.fn<typeof fetch>(async url=>{
  if(String(url).endsWith('/startup'))return Response.json({aliases:[{alias:'A'}]});
  if(String(url).endsWith('/confirm')){confirmations++;return Response.json({confirmed:true});}
  reads++;
  if(kind==='repository'&&Date.now()<firstRefusal-7000)return Response.json({pending:true},{status:423});
  if(Date.now()<firstRefusal)await new Promise(resolve=>setTimeout(resolve,firstRefusal-Date.now()));
  if(Date.now()<firstRefusal+120000)throw refusedConnection();
  return value();
 });
 // The first value request spends seven seconds connecting before being refused.
 if(kind!=='repository')vi.setSystemTime(firstRefusal-7000);
 const client=privateSecretClient({...options(fetcher),clock:undefined});
 try{
  const result=kind==='repository'?client.repository('job'):kind==='startup'?client.startup():client.granted('TOKEN');
  const resolved=expect(result.then(data=>data instanceof Map?data.get('A')?.toString():data?.toString())).resolves.toBe('SYNTHETIC_PRIVATE');
  await vi.advanceTimersByTimeAsync(firstRefusal+120000-Date.now());
  await resolved;expect(reads).toBeGreaterThan(1);expect(confirmations).toBe(1);
 }finally{client.close();vi.useRealTimers();}
});
it('never repeats a value read after its response body fails with a connection error',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(controller){controller.error(refusedConnection());}})));
 const client=privateSecretClient(options(fetcher));
 try{await expect(client.granted('TOKEN')).rejects.toThrow(/^Private secret input unavailable$/);expect(fetcher).toHaveBeenCalledOnce();}
 finally{client.close();}
});
it.each(['abort','close'] as const)('clears the private connection retry timer on %s',async kind=>{
 vi.useFakeTimers();
 const abort=new AbortController(),fetcher=vi.fn<typeof fetch>().mockRejectedValue(refusedConnection());
 const client=privateSecretClient({...options(fetcher),clock:undefined,signal:abort.signal});
 try{
  const result=expect(client.granted('TOKEN')).rejects.toThrow(/^Private secret input unavailable$/);
  await vi.advanceTimersByTimeAsync(100);expect(vi.getTimerCount()).toBe(1);
  if(kind==='abort')abort.abort();else client.close();
  await result;expect(vi.getTimerCount()).toBe(0);expect(fetcher).toHaveBeenCalledOnce();
 }finally{client.close();vi.useRealTimers();}
});
it('ends a sustained refusal at the final probe with a redacted contact error',async()=>{
 vi.useFakeTimers();
 const start=Date.now(),attempts:number[]=[];
 const fetcher=vi.fn<typeof fetch>(async()=>{attempts.push(Date.now()-start);throw refusedConnection();});
 const client=privateSecretClient({...options(fetcher),clock:undefined});
 try{
  const result=expect(client.granted('TOKEN')).rejects.toThrow(/^Loom is still unavailable after 120 seconds\./);
  await vi.advanceTimersByTimeAsync(120000);await result;
  expect(attempts.at(-1)).toBe(120000);expect(vi.getTimerCount()).toBe(0);
 }finally{client.close();vi.useRealTimers();}
});
it('stops when a multi-address failure includes a connection reset',async()=>{
 const mixed=new AggregateError([refusedConnection(),Object.assign(Error(),{code:'ECONNRESET'})]);
 const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed',{cause:mixed}));
 const client=privateSecretClient(options(fetcher));
 try{await expect(client.granted('TOKEN')).rejects.toThrow(/^Private secret input unavailable$/);expect(fetcher).toHaveBeenCalledOnce();}
 finally{client.close();}
});
