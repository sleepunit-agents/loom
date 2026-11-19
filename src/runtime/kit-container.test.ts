import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { DockerEngine } from './docker-engine.js';
import { runKitContainer } from './kit-container.js';

const image = 'sha256:' + 'e'.repeat(64);
const input = { job:'test-job', box:'test-box', image, entrypoint:'/home/agent/repo/bin/status', argv:['a b'], secrets:{ POND_TOKEN:Buffer.from('fixture-secret') }, signal:new AbortController().signal };
function fixture(output:string) {
  const calls: {method:string; path:string; body:unknown}[] = [];
  const socket = new Duplex({read(){},write(_chunk, _encoding, done){done();}});
  const engine: DockerEngine = {
    build:vi.fn(), attach:async()=>socket,
    async json(method,path,body) {
      calls.push({method,path,body});
      if (path.startsWith('/images/')) return {Id:image,Config:{Volumes:null}};
      if (path.includes('/create')) return {Id:'a'.repeat(64)};
      if (path.endsWith('/start')) {
        const data = Buffer.from(output), header = Buffer.alloc(8);
        header[0] = 1; header.writeUInt32BE(data.length,4);
        socket.push(Buffer.concat([header,data])); socket.push(null);
      }
      if (path.includes('/wait')) return {StatusCode:0};
    },
  };
  return {engine,calls};
}
it('uses the approved image without body mounts, host privileges or credentials in Docker metadata', async()=>{
  const {engine,calls} = fixture('online');
  expect((await runKitContainer(engine,input)).toString()).toBe('online');
  expect(JSON.stringify(calls)).not.toContain('fixture-secret');
  expect(JSON.stringify(calls)).not.toContain(input.argv[0]);
  expect(calls.find(c=>c.path.includes('/create'))?.body).toMatchObject({
    Image:image, Labels:{'loom.job':'test-job','loom.box':'test-box'}, HostConfig:{ReadonlyRootfs:true, LogConfig:{Type:'none'}, CapDrop:['ALL'], Mounts:[]},
  });
  expect(calls.at(-1)?.method).toBe('DELETE');
});
it.each(['fixture-secret', Buffer.from('fixture-secret').toString('base64')])('withholds a secret-bearing result', async(output)=>{
  const {engine,calls}=fixture(output);
  await expect(runKitContainer(engine,input)).rejects.toThrow('Kit result withheld');
  expect(calls.at(-1)?.method).toBe('DELETE');
});
it('rejects mutable image references before contacting the engine',async()=>{
  const {engine,calls}=fixture('');
  await expect(runKitContainer(engine,{...input,image:'house:latest'})).rejects.toThrow('immutable');
  expect(calls).toHaveLength(0);
});
