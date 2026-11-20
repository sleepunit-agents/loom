// Replays three occupied worker slots sharing one account. The worker, turn queue,
// body status client, enrollment and finish clients are real; the door and bodies are stand-ins.
import {setImmediate as nextTurn} from 'node:timers/promises';
import {expect, it, vi} from 'vitest';
import {bodyConversationClient} from './conversation-client.js';
import {httpWorkerControl} from './worker-http.js';
import {workerTurns} from './worker-turns.js';
import {workOnce, type WorkerExecutor} from './worker.js';

it('keeps one running body and two jobs waiting for its account turn through a missed status report', async () => {
  vi.useFakeTimers({toFake:['Date','performance','setTimeout','clearTimeout','setInterval','clearInterval']});
  const abort = new AbortController(), turns = workerTurns({accounts:1});
  const jobs = ['one','two','three'], queue = [...jobs], starts: string[] = [], builds: string[] = [];
  const finished: {job:string;exitCode:number}[] = [], offline: string[] = [];
  const firstReady = Promise.withResolvers<void>();
  let up = true, waiting = 0;
  const door: typeof fetch = async (url, init) => {
    const op = new URL(String(url)).pathname.split('/').at(-1)!;
    const {input} = JSON.parse(String(init?.body));
    if (!up) {
      offline.push(op + (input.job ? ' '+input.job : ''));
      throw new TypeError('fetch failed',{cause:Object.assign(Error(),{code:'ECONNREFUSED'})});
    }
    switch (op) {
      case 'next': {
        const id = queue.shift();
        return Response.json({ok:true,value:id ? {id,box:'box',agent:'art',conversation:'cv-'+id,
          model:'fixture',account:'shared',harness:'codex',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'}} : null});
      }
      case 'enrollBody': return Response.json({ok:true,value:{registered:true}});
      case 'started': return Response.json({ok:true,value:{ok:true}});
      case 'heartbeat': return Response.json({ok:true,value:{active:true}});
      case 'status': return Response.json({ok:true,value:{saved:true,stopRequested:false}});
      case 'finish':
        finished.push({job:input.job,exitCode:input.exitCode});
        return Response.json({ok:true,value:{ok:true}});
      default: throw Error('Unexpected operation '+op);
    }
  };
  const http = httpWorkerControl({url:'http://127.0.0.1:1',token:'fixture',signal:abort.signal,fetch:door,
    pause:ms => new Promise(resolve => setTimeout(resolve,ms))});
  const executor: WorkerExecutor = {
    async build(job) { builds.push(job.id); return 'fixture-image'; },
    start(job,_build,signal) {
      starts.push(job.id);
      const exit = Promise.withResolvers<{exitCode:number;logTail:string}>();
      signal.addEventListener('abort',() => exit.resolve({exitCode:1,logTail:''}),{once:true});
      return {acceptsBootstrap:true,spawned:Promise.resolve(),exited:exit.promise,stop:async () => {},
        async release(bootstrap) {
          const client = bodyConversationClient({url:bootstrap!.origin,token:Buffer.from(bootstrap!.token).toString(),
            job:job.id,conversation:job.conversation!,signal,fetch:door});
          const status = () => client.status({state:'working',work:'Fixture'});
          // A real body ends for loss of contact when its periodic status fails.
          async function finishOnStatus() {
            try { await status(); exit.resolve({exitCode:0,logTail:''}); }
            catch { exit.resolve({exitCode:1,logTail:''}); }
            finally { client.close(); }
          }
          if (starts.length === 1) {
            await status();
            setTimeout(() => {void finishOnStatus();},15_000);
            firstReady.resolve();
          } else await finishOnStatus();
        }};
    },
  };
  const all = Promise.all(jobs.map(() => workOnce({box:'box',control:{...http,repositoryInput:undefined},
    executor,signal:abort.signal,turns:{take(keys,signal){waiting++; return turns.take(keys,signal);}}})));
  try {
    await firstReady.promise;
    expect(waiting).toBe(3);
    expect(builds.toSorted()).toEqual(jobs.toSorted());
    const first = starts[0];
    up = false;
    // The running body's next status is due 15 s after the last good one.
    // Before the fix that status ended the body, both waiters tried to enroll,
    // and all three bounded finish sequences failed before the door reopened.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(offline).toContain('status');
    const during = {starts:[...starts],enrolls:offline.filter(op => op.startsWith('enrollBody')),finishes:offline.filter(op => op.startsWith('finish'))};
    up = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await nextTurn();
    const outcomes = await all;
    expect({during,outcomes}).toEqual({during:{starts:[first],enrolls:[],finishes:[]},outcomes:['finished','finished','finished']});
    expect(starts.toSorted()).toEqual(jobs.toSorted());
    expect(finished.toSorted((a,b) => a.job.localeCompare(b.job))).toEqual(jobs.toSorted().map(job => ({job,exitCode:0})));
  } finally { abort.abort(); vi.useRealTimers(); }
});
