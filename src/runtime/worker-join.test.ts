import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {requestWorkerJoin} from './worker-join.js';

it('reuses one private identity across concurrent requests and a lost response',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'loom-worker-join-'));
  const requests:Record<string,string>[]=[];
  const server=createServer(async(req,res)=>{
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/worker-join/request');
    expect(req.headers.authorization).toBeUndefined();
    const chunks:Buffer[]=[];
    for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if(requests.length===1){res.destroy();return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({state:'pending',code:'ABCD-EFGH'}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  try{
    const address=server.address();
    if(!address||typeof address==='string')throw Error('Missing fixture port');
    const origin='http://127.0.0.1:'+address.port;
    const request=()=>requestWorkerJoin(origin,'Workshop',dir);
    const together=await Promise.allSettled([request(),request()]);
    expect(together.map(r=>r.status).sort()).toEqual(['fulfilled','rejected']);
    expect(await request()).toEqual({state:'pending',code:'ABCD-EFGH'});
    expect(await readdir(dir)).toEqual(['worker-join.json']);
    const path=join(dir,'worker-join.json');
    const saved=JSON.parse(await readFile(path,'utf8'));
    expect((await stat(path)).mode&0o777).toBe(0o600);
    const envelope={request:saved.request,name:'Workshop',fingerprint:createHash('sha256').update(saved.token).digest('hex')};
    expect(requests).toEqual([envelope,envelope,envelope]);
    await expect(requestWorkerJoin(origin,'Other machine',dir)).rejects.toThrow();
    await expect(requestWorkerJoin(origin.replace('127.0.0.1','localhost'),'Workshop',dir)).rejects.toThrow();
    expect(requests).toHaveLength(3);
  }finally{
    server.closeAllConnections();
    await new Promise<void>(done=>server.close(()=>done()));
    await rm(dir,{recursive:true,force:true});
  }
});
