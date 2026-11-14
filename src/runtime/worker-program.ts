/** Injectable executable entry: no process is spawned or home opened on import. */
import { z } from 'zod';
import { commandWorkerExecutor } from './worker-process.js';
import { httpWorkerControl } from './worker-http.js';
import { runWorker } from './worker-loop.js';
const command = z.object({ command: z.string().min(1), args: z.array(z.string()), cwd: z.string().min(1), env: z.record(z.string(), z.string()) }).strict();
const configSchema = z.object({
  url: z.string(), box: z.string().min(1), tokenFile: z.string().min(1),
  build: command, runners: z.record(z.string(), command),
}).strict();
export async function workerProgram(input: {
  args: readonly string[];
  read: (path: string) => Promise<string>;
  on: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  off: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  error: (text: string) => void;
  run?: typeof runWorker; control?: typeof httpWorkerControl; executor?: typeof commandWorkerExecutor;
}): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  input.on('SIGINT', stop); input.on('SIGTERM', stop);
  try {
    if (input.args.length !== 1) throw new Error('Expected worker configuration path');
    const config = configSchema.parse(JSON.parse(await input.read(input.args[0])));
    const token = (await input.read(config.tokenFile)).trim();
    await (input.run ?? runWorker)({ box: config.box, signal: abort.signal,
      control: (input.control ?? httpWorkerControl)({ url: config.url, token, signal: abort.signal }),
      executor: (input.executor ?? commandWorkerExecutor)(config),
    });
    return 0;
  } catch {
    input.error('Worker stopped: invalid configuration or unavailable execution\n');
    return 1;
  } finally { input.off('SIGINT', stop); input.off('SIGTERM', stop); }
}
