import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runApprovalsClient } from './approvals-client.js';
const dirs:string[]=[];
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
function setup(env:Record<string,string>={}){
  const path=mkdtempSync(join(tmpdir(),'approvals-client-'));dirs.push(path);const token=join(path,'token');writeFileSync(token,'test-bearer\n');
  let stdout='',stderr='';const request=vi.fn<typeof fetch>(),retry=vi.fn(async(_ms:number)=>{});
  const io={env:{LOOM_TOKEN_FILE:token,...env},stdin:Readable.from([]),stdinIsTTY:false,stdout:(s:string)=>{stdout+=s;},stderr:(s:string)=>{stderr+=s;}};
  return {io,request,retry,output:()=>({stdout,stderr}),run:(argv=['list'])=>runApprovalsClient(argv,io,{request,retry})};
}
it('shows help without reading a token or contacting the daemon',async()=>{
  const a=setup({LOOM_TOKEN_FILE:'/missing'});expect(await a.run(['--help'])).toBe(0);expect(a.request).not.toHaveBeenCalled();expect(a.output().stdout).toContain('usage: approvals');
});
it.each(['file:///tmp/loom','ftp://example.com','https://user:password@example.com','https://example.com/?token=private','https://example.com/#private'])('rejects unsafe daemon URL %s before transport',async url=>{
  const a=setup({LOOM_URL:url});expect(await a.run()).toBe(1);expect(a.request).not.toHaveBeenCalled();expect(a.output().stderr).not.toContain('password');expect(a.output().stderr).not.toContain('private');
});
it('sends only to the configured endpoint, refuses redirects and preserves bounded retry ids',async()=>{
  const a=setup({LOOM_URL:'https://loom.example/'});
  a.request.mockResolvedValue(new Response(JSON.stringify({ok:false,message:'busy'}),{status:503}));
  expect(await a.run()).toBe(1);expect(a.request).toHaveBeenCalledTimes(4);expect(a.retry.mock.calls.map(c=>c[0])).toEqual([100,200,300]);
  const bodies=a.request.mock.calls.map(([url,options])=>{expect(String(url)).toBe('https://loom.example/api/approvals/command');expect(options?.redirect).toBe('error');expect(options?.headers).toMatchObject({authorization:'Bearer test-bearer'});return options?.body;});
  expect(new Set(bodies).size).toBe(1);expect(a.output().stderr).not.toContain('test-bearer');
});
it.each([null,{}, {ok:true,value:{}},{ok:true,value:{stdout:'ok',stderr:'',exit:'0'}},{ok:true,value:{stdout:'ok',stderr:'',exit:400}}])('fails closed on malformed daemon response %j',async answer=>{
  const a=setup();a.request.mockResolvedValue(new Response(JSON.stringify(answer)));
  expect(await a.run()).toBe(1);expect(a.output().stdout).toBe('');expect(a.output().stderr).toContain('Invalid daemon response');expect(a.request).toHaveBeenCalledTimes(1);
});
it('preserves a valid daemon stdout, stderr and exit without retrying a refusal',async()=>{
  const a=setup();a.request.mockResolvedValue(new Response(JSON.stringify({ok:true,value:{stdout:'denied\n',stderr:'reason\n',exit:3}})));
  expect(await a.run()).toBe(3);expect(a.output()).toEqual({stdout:'denied\n',stderr:'reason\n'});expect(a.request).toHaveBeenCalledTimes(1);
});
it('keeps bearer text out of refusal and transport errors',async()=>{
  const a=setup();a.request.mockResolvedValue(new Response(JSON.stringify({ok:false,message:'bad token test-bearer'}),{status:401}));
  expect(await a.run()).toBe(1);expect(a.output().stderr).toContain('[redacted]');expect(a.output().stderr).not.toContain('test-bearer');
  const b=setup();b.request.mockRejectedValue(Error('test-bearer'));expect(await b.run()).toBe(1);expect(b.request).toHaveBeenCalledTimes(4);expect(b.output().stderr).not.toContain('test-bearer');
});
it.each(['','/missing'])('does not contact daemon when token is unavailable: %s',value=>{
  const a=setup({LOOM_TOKEN_FILE:value});return a.run().then(exit=>{expect(exit).toBe(1);expect(a.request).not.toHaveBeenCalled();});
});
it('does not contact daemon with an empty token',async()=>{
  const a=setup();writeFileSync(a.io.env.LOOM_TOKEN_FILE,'\n');expect(await a.run()).toBe(1);expect(a.request).not.toHaveBeenCalled();
});
it('retries a response body interrupted after headers using the same committed operation',async()=>{
  const a=setup();
  const broken=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"ok":'));controller.error(Error('connection reset'));}}));
  a.request.mockResolvedValueOnce(broken()).mockResolvedValueOnce(new Response(JSON.stringify({ok:true,value:{stdout:'done\n',stderr:'',exit:0}})));
  expect(await a.run()).toBe(0);expect(a.output().stdout).toBe('done\n');expect(a.request).toHaveBeenCalledTimes(2);
  expect(a.request.mock.calls[0][1]?.body).toBe(a.request.mock.calls[1][1]?.body);expect(a.retry.mock.calls).toEqual([[100]]);
});
it('bounds body transport retries and does not retry malformed JSON',async()=>{
  const a=setup();a.request.mockImplementation(async()=>new Response(new ReadableStream({start(controller){controller.error(Error('connection reset'));}})));
  expect(await a.run()).toBe(1);expect(a.request).toHaveBeenCalledTimes(4);expect(new Set(a.request.mock.calls.map(c=>c[1]?.body)).size).toBe(1);
  const b=setup();b.request.mockResolvedValue(new Response('{"ok":'));
  expect(await b.run()).toBe(1);expect(b.request).toHaveBeenCalledTimes(1);expect(b.output().stderr).toContain('Invalid daemon response');
});
it('retries a 503 even when its response body has already failed',async()=>{
  const a=setup();a.request.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.error(Error('reset'));}}),{status:503})).mockResolvedValueOnce(new Response(JSON.stringify({ok:true,value:{stdout:'done',stderr:'',exit:0}})));
  expect(await a.run()).toBe(0);expect(a.request).toHaveBeenCalledTimes(2);
});
