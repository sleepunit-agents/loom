/** Injectable executable entry: no process is spawned or home opened on import. */
import { z } from 'zod';
import { signInAccount } from './account-signin.js';
import { commandUsageProvider, commandWorkerExecutor } from './worker-process.js';
import { httpWorkerControl, reportWorkerAccountUsage } from './worker-http.js';
import { runWorker } from './worker-loop.js';
import { containerWorkerExecutor } from './worker-container.js';
const command = z.object({ command: z.string().min(1), args: z.array(z.string()), cwd: z.string().min(1), env: z.record(z.string(), z.string()) }).strict();
const containerDeadline = z.number().int().min(1).max(300_000);
const configSchema = z.object({
  url: z.string(), box: z.string().min(1), tokenFile: z.string().min(1),
  build: command, buildTimeoutMs: z.number().int().min(1).max(3_600_000).optional(), runners: z.record(z.string(), command),
  container: z.object({ socket: z.string().startsWith('/'), nestedSocket: z.string().startsWith('/').optional(),
    setupTimeoutMs: containerDeadline.optional(),
    cleanupTimeoutMs: containerDeadline.optional() }).strict().optional(),
}).strict();
const accountCommand = z.object({
  command,
  account: z.object({ account: z.string().trim().min(1), owner: z.string().trim().min(1), provider: z.string().trim().min(1) }).strict(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
}).strict();
const usageCommand = accountCommand.extend({ report: z.object({ url: z.string(), tokenFile: z.string().min(1) }).strict().optional() });
const signInCommand = accountCommand.extend({ box: z.string().trim().min(1) });
export async function workerProgram(input: {
  args: readonly string[];
  read: (path: string) => Promise<string>;
  on: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  off: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  error: (text: string) => void;
  /** Local structured observations only; never private command diagnostics. */
  output?: (text: string) => void;
  signIn?: typeof signInAccount;
  usage?: typeof commandUsageProvider;
  reportUsage?: typeof reportWorkerAccountUsage;
  run?: typeof runWorker; control?: typeof httpWorkerControl; executor?: typeof commandWorkerExecutor;
  containerExecutor?: typeof containerWorkerExecutor;
}): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  input.on('SIGINT', stop); input.on('SIGTERM', stop);
  try {
    const mode = input.args[0];
    if (mode === '--account-signin' || mode === '--account-usage') {
      if (input.args.length !== 2 || !input.output) throw new Error('Expected account command configuration');
      const raw: unknown = JSON.parse(await input.read(input.args[1]));
      // These one-shot worker commands receive only local owner configuration.
      // Local-only commands read no Loom token. Optional usage reporting reads
      // its configured machine credential; neither mode claims jobs or changes membership.
      if (mode === '--account-signin') {
        const config = signInCommand.parse(raw);
        await (input.signIn ?? signInAccount)(config.command, { ...config.account, box: config.box },
          { signal: abort.signal, timeoutMs: config.timeoutMs });
        if (abort.signal.aborted) throw new Error('Cancelled');
        input.output(JSON.stringify({ ...config.account, box: config.box, signedIn: true }) + '\n');
      } else {
        const config = usageCommand.parse(raw);
        const provider = (input.usage ?? commandUsageProvider)(config.command,
          { signal: abort.signal, timeoutMs: config.timeoutMs });
        const windows = await provider(Object.freeze({ ...config.account }));
        if (abort.signal.aborted) throw new Error('Cancelled');
        if (config.report) {
          const token = (await input.read(config.report.tokenFile)).trim();
          await (input.reportUsage ?? reportWorkerAccountUsage)({ url: config.report.url, token, signal: abort.signal }, { ...config.account, windows });
          if (abort.signal.aborted) throw new Error('Cancelled');
        }
        input.output(JSON.stringify({ ...config.account, windows }) + '\n');
      }
      return 0;
    }
    if (input.args.length !== 1) throw new Error('Expected worker configuration path');
    const config = configSchema.parse(JSON.parse(await input.read(input.args[0])));
    const token = (await input.read(config.tokenFile)).trim();
    await (input.run ?? runWorker)({ box: config.box, signal: abort.signal,
      control: (input.control ?? httpWorkerControl)({ url: config.url, token, signal: abort.signal }),
      executor: config.container
        ? (input.containerExecutor ?? containerWorkerExecutor)({ ...config, container: config.container })
        : (input.executor ?? commandWorkerExecutor)(config),
    });
    return 0;
  } catch {
    input.error('Worker stopped: invalid configuration or unavailable execution\n');
    return 1;
  } finally { input.off('SIGINT', stop); input.off('SIGTERM', stop); }
}
