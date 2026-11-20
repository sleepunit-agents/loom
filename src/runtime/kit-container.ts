import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { secretValueSize } from '../pieces/secrets/input.js';
import { canonicalKitImage, KIT_IMAGE, programPath, programSecretAlias } from './pinned-program.js';
import { looksLikeCredential, programDeadline, PROGRAM_OUTPUT_BYTES } from './fixed-program.js';
import { DockerResponseError } from './docker-engine.js';
import type { DockerEngine } from './docker-engine.js';
import { HOUSE_NODE, HOUSE_REPOSITORY } from './house-layout.js';

type Invocation = {
  runtime?:string;
  podmanHelperSubid?:number;
  job:string;
  box:string;
  image:string;
  entrypoint:string;
  argv:readonly string[];
  secrets:Readonly<Record<string,Buffer>>;
  signal:AbortSignal;
  onStarted?:()=>void;
};
// A fixed bootstrap, never assembled from tool arguments. Docker sees neither the envelope nor its values
// in container config. The pinned image supplies node, the program and all of the program's dependencies.
const bootstrap = `
const {spawn} = require('node:child_process');
// If the worker disappears before or during execution, PID 1 still ends the container.
const awaitingInput = setTimeout(() => process.exit(1), 30_000).unref();
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const {bindings,argv,input,timeoutMs} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  clearTimeout(awaitingInput);
  setTimeout(() => process.exit(1), timeoutMs).unref();
  const env = {PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8'};
  for (const [name, value] of Object.entries(bindings)) env[name] = Buffer.from(value,'base64').toString('utf8');
  const child = spawn(process.argv[1], argv, {env, stdio:[input === undefined ? 'ignore' : 'pipe','inherit','ignore']});
  if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input)+'\\n'); }
  child.once('error', () => process.exitCode = 1);
  child.once('exit', code => process.exitCode = code ?? 1);
})().catch(() => process.exitCode = 1);`;

/** Docker may frame each byte separately. Keep only stdout and a partial frame header. */
async function stdout(socket: Duplex): Promise<Buffer> {
  const header = Buffer.alloc(8);
  const output = Buffer.alloc(PROGRAM_OUTPUT_BYTES);
  let headerSize = 0, remaining = 0, stream = 0, written = 0;
  for await (const chunk of socket) {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining === 0) {
        const count = Math.min(header.length - headerSize, chunk.length - offset);
        chunk.copy(header, headerSize, offset, offset + count);
        offset += count;
        headerSize += count;
        if (headerSize < header.length) continue;
        headerSize = 0;
        stream = header[0];
        if ((stream !== 1 && stream !== 2) || header.readUIntBE(1, 3) !== 0)
          throw new Error('Kit output unavailable');
        remaining = header.readUInt32BE(4);
        if (stream === 1 && remaining > PROGRAM_OUTPUT_BYTES - written)
          throw new Error('Kit output exceeded its limit');
      }
      const count = Math.min(remaining, chunk.length - offset);
      if (stream === 1) {
        chunk.copy(output, written, offset, offset + count);
        written += count;
      }
      offset += count;
      remaining -= count;
    }
  }
  if (remaining || headerSize) throw new Error('Incomplete kit output');
  return output.subarray(0, written);
}

type ContainerPlan = Pick<Invocation,'job'|'box'|'image'|'entrypoint'|'signal'|'podmanHelperSubid'> & {
  runtime?:string;
  setupTimeoutMs?:number;
  cleanupTimeoutMs?:number;
};
type PrivateInput = Pick<Invocation,'argv'|'secrets'|'onStarted'> & {input?:object;timeoutMs:number};

const ranges = z.array(z.object({ container_id:z.number().int(), host_id:z.number().int(), size:z.number().int() }));
const rootlessInfo = z.object({ host:z.object({ security:z.object({ rootless:z.literal(true) }),
  idMappings:z.object({ uidmap:ranges, gidmap:ranges }) }) });

/** Both callers prepare a pinned, mount-free container, release private input once and reap it. */
export function isolatedContainer(engine:DockerEngine,plan:ContainerPlan) {
  const abort = new AbortController();
  const signal = AbortSignal.any([plan.signal,abort.signal]);
  const name = 'loom-kit-'+randomUUID();
  let id:string|undefined, remove=false, socket:Duplex|undefined, released=false;
  const prepared = (async()=>{
    const setup = AbortSignal.any([signal,AbortSignal.timeout(plan.setupTimeoutMs ?? 30_000)]);
    if (!KIT_IMAGE.test(plan.image)) throw new Error('Kit needs an immutable house image');
    const path = plan.entrypoint;
    if (!path.startsWith(HOUSE_REPOSITORY + '/') || !programPath.safeParse(path.slice(HOUSE_REPOSITORY.length + 1)).success)
      throw new Error('Kit program must be inside its house');
    const inspect = await engine.json('GET','/images/'+plan.image+'/json',undefined,setup) as {Id?:string;Config?:{Volumes?:object|null}};
    if (canonicalKitImage(inspect?.Id) !== plan.image || !inspect.Config || Object.keys(inspect.Config.Volumes ?? {}).length)
      throw new Error('Kit needs an immutable house image without volumes');
    remove=true;
    let created:unknown;
    try {
      const spec = {
        Image:plan.image, User:'65534:65534', WorkingDir:HOUSE_REPOSITORY,
        Entrypoint:[HOUSE_NODE,'-e',bootstrap,'--'], Cmd:[path], Labels:{'loom.job':plan.job,'loom.box':plan.box},
        Healthcheck:{Test:['NONE']}, OpenStdin:true, AttachStdin:true, StdinOnce:true,
        AttachStdout:true, AttachStderr:true, Tty:false,
        HostConfig:{ReadonlyRootfs:true, Privileged:false, Mounts:[], CapDrop:['ALL'],
          SecurityOpt:['no-new-privileges'], LogConfig:{Type:'none'}, PidsLimit:32, Memory:128*1024*1024,
          Runtime:plan.runtime, NanoCpus:500_000_000, PublishAllPorts:false, NetworkMode:'bridge'},
      };
      if (plan.podmanHelperSubid === undefined) {
        created = await engine.json('POST','/containers/create?name='+name,spec,setup);
      } else {
        const subid = plan.podmanHelperSubid;
        const info = rootlessInfo.parse(await engine.json('GET', '/v5.0.0/libpod/info', undefined, setup));
        const { uidmap, gidmap } = info.host.idMappings;
        if (!Number.isSafeInteger(subid) || subid < 1 || subid >= 65534 ||
            ![uidmap,gidmap].every(ranges => ranges.some(r => r.container_id === 1 && r.host_id > 0 && r.size >= subid)))
          throw new Error('Helper subordinate ID is unavailable');
        // Keep low image IDs in place. Only the helper's nobody ID uses the selected subordinate ID.
        const maps = [{ container_id: 0, host_id: 0, size: subid }, { container_id: 65534, host_id: subid, size: 1 }];
        const h = spec.HostConfig;
        created = await engine.json('POST','/v5.0.0/libpod/containers/create',{
          name, image:spec.Image, entrypoint:spec.Entrypoint, command:spec.Cmd, work_dir:spec.WorkingDir,
          labels:spec.Labels, user:spec.User, stdin:spec.OpenStdin, terminal:spec.Tty, oci_runtime:h.Runtime,
          env_host:false, httpproxy:false, systemd:'false', healthconfig:spec.Healthcheck, log_configuration:{ driver:h.LogConfig.Type },
          privileged:h.Privileged, cap_drop:h.CapDrop, no_new_privileges:true, read_only_filesystem:h.ReadonlyRootfs,
          read_write_tmpfs:false, netns:{ nsmode:h.NetworkMode }, publish_image_ports:h.PublishAllPorts,
          userns:{ nsmode:'private' }, idmappings:{ HostUIDMapping:false, HostGIDMapping:false, UIDMap:maps, GIDMap:maps },
          resource_limits:{ memory:{ limit:h.Memory }, pids:{ limit:h.PidsLimit }, cpu:{ period:100000, quota:h.NanoCpus / 10000 } },
        },setup);
      }
    } catch(error) {
      if(error instanceof DockerResponseError && error.status>=400 && error.status<500)remove=false;
      throw error;
    }
    const identity=(created as {Id?:unknown})?.Id;
    if(typeof identity!=='string'||!/^[a-f0-9]{12,64}$/.test(identity))throw new Error('Invalid container identity');
    id=identity;
    const actual=await engine.json('GET','/containers/'+id+'/json',undefined,setup) as {Mounts?:unknown[]};
    if(!Array.isArray(actual?.Mounts)||actual.Mounts.length)throw new Error('Unexpected container storage');
    socket=await engine.attach(id,setup);
    setup.throwIfAborted();
  })();
  let stopping:Promise<void>|undefined;
  async function run(input:PrivateInput){
    await prepared;
    if(!socket||signal.aborted||released)throw new Error('Kit input unavailable');
    released=true;
    const bindings=Object.create(null) as Record<string,string>;
    for(const [alias,value] of Object.entries(input.secrets)){
      if(!programSecretAlias.safeParse(alias).success||!secretValueSize(value.length)||value.includes(0)||!Buffer.from(value.toString('utf8')).equals(value))
        throw new Error('Kit secret unavailable');
      bindings[alias]=value.toString('base64');
    }
    const execution = programDeadline(input.timeoutMs, signal);
    const cancel=()=>socket?.destroy(new Error('Kit execution cancelled'));
    execution.addEventListener('abort',cancel,{once:true});
    const result=stdout(socket);
    void result.catch(()=>{});
    try {
      await engine.json('POST','/containers/'+id+'/start',undefined,execution);
      input.onStarted?.();
      socket.end(JSON.stringify({bindings,argv:input.argv,input:input.input,timeoutMs:input.timeoutMs}));
      const [status,bytes]=await Promise.all([engine.json('POST','/containers/'+id+'/wait?condition=not-running',undefined,execution),result]);
      execution.throwIfAborted();
      const exit=(status as {StatusCode?:unknown})?.StatusCode;
      if(typeof exit!=='number'||!Number.isSafeInteger(exit)||(status as {Error?:unknown}).Error)throw new Error('Invalid container exit');
      if(exit===0){
        try {
          const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
          if (looksLikeCredential(text, Object.values(input.secrets).map(value => value.toString()))) throw new Error();
        }
        catch { bytes.fill(0);throw new Error('Kit result withheld'); }
      }else bytes.fill(0);
      return {exit,bytes};
    } finally {execution.removeEventListener('abort',cancel);}
  }
  function stop(){
    return stopping??=(async()=>{
      abort.abort();
      await prepared.catch(()=>{});
      socket?.destroy();
      if(remove)await engine.json('DELETE','/containers/'+(id??name)+'?force=1&v=1',undefined,AbortSignal.timeout(plan.cleanupTimeoutMs??10_000));
    })();
  }
  return {prepared,run,stop};
}

export async function runKitContainer(engine:DockerEngine,input:Invocation):Promise<Buffer> {
  const container=isolatedContainer(engine,input);
  try{
    const {exit,bytes}=await container.run({...input,timeoutMs:30_000});
    if(exit!==0)throw new Error('Kit helper failed');
    return bytes;
  }finally{await container.stop();}
}
