/** Injectable executable IO; native execution still uses the production owner.
 * Tests replace only the existing clock/spawn seam, never admission authority. */
import { startClockWorker, type ClockWorkerConfig } from './clock-worker.js';
type Signal='SIGTERM'|'SIGINT';
interface Signals {once(event:Signal,listener:()=>void):unknown;removeListener(event:Signal,listener:()=>void):unknown}
export async function runClockWorker(io:{input:AsyncIterable<Uint8Array>&{destroy?():unknown};args:readonly string[];
  signals:Signals;stderr:(text:string)=>unknown},host:Parameters<typeof startClockWorker>[1]={}):Promise<0|1> {
  let worker:ReturnType<typeof startClockWorker>|undefined,stopped=false;
  const chunks:Buffer[]=[];let bytes:Buffer|undefined;
  const clear=()=>{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);};
  const stop=()=>{stopped=true;io.input.destroy?.();void worker?.close();};
  io.signals.once('SIGTERM',stop);io.signals.once('SIGINT',stop);
  try {
    if(io.args.length)throw new Error();
    let size=0;
    for await(const chunk of io.input){
      if(!(chunk instanceof Uint8Array)||(size+=chunk.byteLength)>1_048_576)throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    bytes=Buffer.concat(chunks);
    const config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as ClockWorkerConfig;
    clear();if(stopped)throw new Error();
    worker=startClockWorker(config,host);
    const ok=await worker.completed;return ok&&!stopped?0:1;
  }catch {io.stderr('Scheduled worker unavailable\n');return 1;}
  finally {clear();await worker?.close();io.signals.removeListener('SIGTERM',stop);io.signals.removeListener('SIGINT',stop);}
}
