import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { isHouseSecretAlias, secretValueSize } from '../pieces/secrets/input.js';
import { KIT_IMAGE } from './kit-manifest.js';
import { saysNoSecret } from './body-secrets.js';
import type { DockerEngine } from './docker-engine.js';
import { HOUSE_NODE, HOUSE_REPOSITORY } from './house-layout.js';

type Invocation = {
  job:string;
  box:string;
  image:string;
  entrypoint:string;
  argv:readonly string[];
  secrets:Readonly<Record<string,Buffer>>;
  signal:AbortSignal;
  onStarted?:()=>void;
};
const MAX_OUTPUT = 65_536;
// A fixed bootstrap, never assembled from tool arguments. Docker sees neither the envelope nor its values
// in container config. The pinned image supplies node, the program and all of the program's dependencies.
const bootstrap = `
const {spawn} = require('node:child_process');
setTimeout(() => process.exit(1), 30_000).unref();
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const {bindings,argv} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const env = {PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8'};
  for (const [name, value] of Object.entries(bindings)) env[name] = Buffer.from(value,'base64').toString('utf8');
  const child = spawn(process.argv[1], argv, {env, stdio:['ignore','inherit','ignore']});
  child.once('error', () => process.exitCode = 1);
  child.once('exit', code => process.exitCode = code ?? 1);
})().catch(() => process.exitCode = 1);`;

async function stdout(socket:Duplex):Promise<Buffer> {
  const chunks:Buffer[] = [];
  let size = 0;
  for await (const chunk of socket) {
    size += chunk.length;
    if (size > MAX_OUTPUT) throw new Error('Kit output exceeded its limit');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks), output:Buffer[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 8 || ![1,2].includes(bytes[offset]) || bytes.readUIntBE(offset+1,3) !== 0)
      throw new Error('Kit output unavailable');
    const end = offset + 8 + bytes.readUInt32BE(offset+4);
    if (end > bytes.length) throw new Error('Kit output unavailable');
    if (bytes[offset] === 1) output.push(bytes.subarray(offset+8,end));
    offset = end;
  }
  return Buffer.concat(output);
}

export async function runKitContainer(engine:DockerEngine,input:Invocation):Promise<Buffer> {
  if (!KIT_IMAGE.test(input.image)) throw new Error('Kit needs an immutable house image');
  const path = input.entrypoint;
  if (!path.startsWith(HOUSE_REPOSITORY + '/') || path.slice(1).split('/').some(part=>!part || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)))
    throw new Error('Kit program must be inside its house');
  const envelope = Object.create(null) as Record<string,string>;
  for (const [alias,value] of Object.entries(input.secrets)) {
    if (!isHouseSecretAlias(alias) || !secretValueSize(value.length) || value.includes(0) || !Buffer.from(value.toString('utf8')).equals(value))
      throw new Error('Kit secret unavailable');
    envelope[alias] = value.toString('base64');
  }
  const signal = AbortSignal.any([input.signal,AbortSignal.timeout(30_000)]);
  const inspect = await engine.json('GET','/images/'+input.image+'/json',undefined,signal) as {Id?:string;Config?:{Volumes?:object|null}};
  if (inspect?.Id !== input.image || !inspect.Config || Object.keys(inspect.Config.Volumes ?? {}).length)
    throw new Error('Kit needs an immutable house image without volumes');
  const name = 'loom-kit-'+randomUUID(), container = '/containers/'+name;
  let socket:Duplex|undefined;
  const stop = () => socket?.destroy(new Error('Kit execution cancelled'));
  try {
    await engine.json('POST','/containers/create?name='+name,{
      Image:input.image, User:'65534:65534', WorkingDir:HOUSE_REPOSITORY,
      Entrypoint:[HOUSE_NODE,'-e',bootstrap,'--'], Cmd:[path], Labels:{'loom.job':input.job,'loom.box':input.box},
      Healthcheck:{Test:['NONE']}, OpenStdin:true, AttachStdin:true, StdinOnce:true,
      AttachStdout:true, AttachStderr:true, Tty:false,
      HostConfig:{ReadonlyRootfs:true, Privileged:false, Mounts:[], CapDrop:['ALL'],
        SecurityOpt:['no-new-privileges'], LogConfig:{Type:'none'}, PidsLimit:32, Memory:128*1024*1024,
        NanoCpus:500_000_000, PublishAllPorts:false, NetworkMode:'bridge'},
    },signal);
    socket = await engine.attach(name,signal);
    signal.addEventListener('abort',stop,{once:true});
    const result = stdout(socket);
    void result.catch(()=>{});
    signal.throwIfAborted();
    await engine.json('POST',container+'/start',undefined,signal);
    input.onStarted?.();
    socket.end(JSON.stringify({bindings:envelope,argv:input.argv}));
    const [status,bytes] = await Promise.all([engine.json('POST',container+'/wait',undefined,signal),result]);
    if ((status as {StatusCode?:number})?.StatusCode !== 0) throw new Error('Kit helper failed');
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const secrets = [...Object.values(input.secrets), ...Object.values(envelope).map(encoded=>Buffer.from(encoded))];
    if (!saysNoSecret(text,secrets) || secrets.some(value=>bytes.includes(value))) throw new Error('Kit result withheld');
    return bytes;
  } finally {
    signal.removeEventListener('abort',stop);
    socket?.destroy();
    await engine.json('DELETE',container+'?force=1&v=1',undefined,AbortSignal.timeout(10_000));
  }
}
