import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { DockerEngine } from './docker-engine.js';
import { PROGRAM_OUTPUT_BYTES } from './house-program.js';
import { runKitContainer } from './kit-container.js';

const image = 'sha256:' + 'e'.repeat(64);
const input = { job:'test-job', box:'test-box', image, entrypoint:'/home/agent/repo/bin/status', argv:['a b'], secrets:{ KIT_POND:Buffer.from('fixture-secret') }, signal:new AbortController().signal };
function fixture(output:string, inspectedImage=image, frameSize=Infinity) {
  const writes: string[] = [];
  const calls: {method:string; path:string; body:unknown}[] = [];
  const socket = new Duplex({read(){},write(chunk, _encoding, done){writes.push(chunk.toString());done();}});
  const engine: DockerEngine = {
    build:vi.fn(), attach:async()=>socket,
    async json(method,path,body) {
      calls.push({method,path,body});
      if (path.startsWith('/images/')) return {Id:inspectedImage,Config:{Volumes:null}};
      if (path.startsWith('/containers/') && path.endsWith('/json')) return {Mounts:[]};
      if (path.includes('/create')) return {Id:'a'.repeat(64)};
      if (path.endsWith('/start')) {
        const data = Buffer.from(output);
        for (let offset = 0; offset < data.length; offset += frameSize) {
          const part = data.subarray(offset, offset + frameSize);
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(part.length, 4);
          socket.push(Buffer.concat([header, part]));
        }
        socket.push(null);
      }
      if (path.includes('/wait')) return {StatusCode:0};
    },
  };
  return {engine,calls,writes};
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
it.each(['loom_' + 'A'.repeat(43), 'github_pat_' + 'a'.repeat(40), 'fixture-secret', '{"text":"fixture-\\u0073ecret"}', Buffer.from('fixture-secret').toString('base64')])('withholds a secret-bearing result', async(output)=>{
  const {engine,calls}=fixture(output);
  await expect(runKitContainer(engine,input)).rejects.toThrow('Kit result withheld');
  expect(calls.at(-1)?.method).toBe('DELETE');
});
it('rejects mutable image references before contacting the engine',async()=>{
  const {engine,calls}=fixture('');
  await expect(runKitContainer(engine,{...input,image:'house:latest'})).rejects.toThrow('immutable');
  expect(calls).toHaveLength(0);
});

it('accepts a bare inspect digest only when it identifies the approved image',async()=>{
  const same=fixture('online',image.slice(7));
  expect((await runKitContainer(same.engine,input)).toString()).toBe('online');
  const other=fixture('private','1'.repeat(64));
  await expect(runKitContainer(other.engine,input)).rejects.toThrow('immutable');
  expect(other.calls.some(call=>call.path.includes('/create'))).toBe(false);
});

it('applies the same stdout budget and credential checks without any bound secrets', async()=>{
  for (const [output,reason] of [['x'.repeat(PROGRAM_OUTPUT_BYTES + 1),'limit'],['Bearer example-token','withheld']]) {
    const {engine}=fixture(output);
    await expect(runKitContainer(engine,{...input,secrets:{}})).rejects.toThrow(reason);
  }
});

it('accepts the full stdout allowance even when Docker frames each byte separately', async () => {
  const text = 'x'.repeat(PROGRAM_OUTPUT_BYTES);
  const {engine} = fixture(text, image, 1);
  expect((await runKitContainer(engine, input)).toString()).toBe(text);
});

it.each(['rootless','rootful','short mapping','gap','missing zero','old API','lost start'] as const)('checks the %s engine before creating a mapped helper', async mode => {
  const {engine,calls,writes} = fixture('online');
  const base = {container_id:0,host_id:1000,size:1};
  const rest = {container_id:1,host_id:20000,size:32767};
  const uidmap = mode === 'missing zero' ? [rest] : [rest,base];
  const gidmap = mode === 'short mapping' ? [base] : mode === 'gap' ? [base,{...rest,container_id:2}] : uidmap;
  const control = {...engine, json: async (...args:Parameters<DockerEngine['json']>) => {
    if (args[1].endsWith('/libpod/info')) return {version:{ APIVersion:mode === 'old API' ? '4.9.0' : '5.4.2' },
      host:{security:{rootless:mode !== 'rootful'},idMappings:{uidmap,gidmap}}};
    const response = await engine.json(...args);
    if (mode === 'lost start' && args[1].endsWith('/start')) throw new Error('Start reply lost');
    return response;
  }};
  const run = runKitContainer(control,{...input,runtime:'crun',podmanHelperSubid:32767});
  if (mode === 'lost start') {
    await expect(run).rejects.toThrow('Start reply lost');
    expect(calls.filter(c=>c.path.endsWith('/start'))).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(calls.at(-1)?.method).toBe('DELETE');
    return;
  }
  if (mode !== 'rootless') {
    await expect(run).rejects.toThrow();
    expect(calls.some(c=>c.path.includes('/create'))).toBe(false);
    return;
  }
  expect((await run).toString()).toBe('online');
  expect(writes.map(text=>JSON.parse(text))).toEqual([{argv:input.argv,timeoutMs:30000,bindings:{KIT_POND:input.secrets.KIT_POND.toString('base64')}}]);
  expect(calls.filter(c=>c.path.endsWith('/start'))).toHaveLength(1);
  const maps = [{container_id:0,host_id:0,size:32767},{container_id:65534,host_id:32767,size:1}];
  expect(calls.find(c=>c.path.includes('/create'))).toMatchObject({path:'/v5.0.0/libpod/containers/create',body:{
    image,image_volume_mode:'ignore',user:'65534:65534',oci_runtime:'crun',
    idmappings:{HostUIDMapping:false,HostGIDMapping:false,UIDMap:maps,GIDMap:maps},userns:{nsmode:'private'},
    privileged:false,netns:{nsmode:'bridge'},cap_drop:['ALL'],no_new_privileges:true,read_only_filesystem:true,
    log_configuration:{driver:'none'},healthconfig:{Test:['NONE']},publish_image_ports:false,
    resource_limits:{memory:{limit:134217728},pids:{limit:32},cpu:{period:100000,quota:50000}},
  }});
  expect(JSON.stringify(calls)).not.toContain('fixture-secret');
  expect(JSON.stringify(calls)).not.toContain(input.argv[0]);
  expect(calls.at(-1)?.method).toBe('DELETE');
});
