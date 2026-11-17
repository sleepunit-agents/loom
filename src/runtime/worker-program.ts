/** Injectable executable entry: no process is spawned or home opened on import. */
import { z } from 'zod';
import { machineFacts } from './machine-facts.js';
import { setTimeout as delay } from 'node:timers/promises';
import { signInAccount } from './account-signin.js';
import { relaySignIn } from './account-signin-relay.js';
import { commandUsageProvider, commandWorkerExecutor } from './worker-process.js';
import { httpWorkerControl, workerSignIn, reportWorkerAccountUsage, readWorkerAccountBasis, reportWorkerAccountUnavailable, reportWorkerHealth } from './worker-http.js';
import { runWorker } from './worker-loop.js';
import { containerWorkerExecutor } from './worker-container.js';
const commandString = z.string().refine(value => !value.includes('\0'));
const command = z.object({ command: commandString.min(1), args: z.array(commandString), cwd: commandString.min(1), env: z.record(commandString, commandString) }).strict();
const runnerCommand = command.extend({ bodyBootstrap: z.boolean().optional() });
const containerCommand = runnerCommand.extend({ cwd: commandString.startsWith('/'), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), commandString) });
const containerDeadline = z.number().int().min(1).max(300_000);
const accountCommand = z.object({
  command,
  account: z.object({ account: z.string().trim().min(1), owner: z.string().trim().min(1), provider: z.string().trim().min(1) }).strict(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
}).strict();
const usageCommand = accountCommand.extend({ report: z.object({ url: z.string(), tokenFile: z.string().min(1) }).strict().optional() });
const signInCommand = accountCommand.extend({ box: z.string().trim().min(1) });
const configSchema = z.object({
  facts: machineFacts.optional(),
  url: z.string(), box: z.string().min(1), tokenFile: z.string().min(1),
  build: command, buildTimeoutMs: z.number().int().min(1).max(3_600_000).optional(), runners: z.record(z.string(), runnerCommand),
  accountRunners: z.record(z.string().min(1), z.record(z.string().min(1), runnerCommand)).optional(),
  accountUsage: z.object({ readers: z.array(accountCommand).min(1).max(32), intervalMs: z.number().int().min(1_000).max(3_600_000).optional() }).strict().optional(),
  /** Sign-ins asked for through loom: one program per provider, run on this machine with a private directory
   * as its last argument (see account-signin-relay.ts). Without this the worker takes no sign-in requests. */
  accountSignIn: z.object({ programs: z.array(z.object({ provider: z.string().trim().min(1), command }).strict()).min(1).max(32),
    intervalMs: z.number().int().min(1_000).max(600_000).optional(), timeoutMs: z.number().int().min(10_000).max(900_000).optional() }).strict().optional(),
  container: z.object({ socket: z.string().startsWith('/'), nestedSocket: z.string().startsWith('/').optional(),
    setupTimeoutMs: containerDeadline.optional(),
    cleanupTimeoutMs: containerDeadline.optional() }).strict().optional(),
}).strict().superRefine((config, context) => {
  const accounts = config.accountUsage?.readers.map(reader => reader.account.account) ?? [];
  if (new Set(accounts).size !== accounts.length) context.addIssue({ code: 'custom', message: 'Duplicate account quota reader' });
  if (!config.container) return;
  const plans = [...Object.values(config.runners), ...Object.values(config.accountRunners ?? {}).flatMap(values => Object.values(values))];
  if (plans.some(plan => !containerCommand.safeParse(plan).success)) context.addIssue({ code: 'custom', message: 'Invalid container runner command' });
});
export async function workerProgram(input: {
  args: readonly string[];
  read: (path: string) => Promise<string>;
  on: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  off: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  error: (text: string) => void;
  /** Local structured observations only; never private command diagnostics. */
  output?: (text: string) => void;
  signIn?: typeof signInAccount;
  relaySignIn?: typeof relaySignIn;
  signInRemote?: typeof workerSignIn;
  usage?: typeof commandUsageProvider;
  reportUsage?: typeof reportWorkerAccountUsage;
  usageBasis?: typeof readWorkerAccountBasis;
  usageUnavailable?: typeof reportWorkerAccountUnavailable;
  health?: typeof reportWorkerHealth;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  run?: typeof runWorker; control?: typeof httpWorkerControl; executor?: typeof commandWorkerExecutor;
  containerExecutor?: typeof containerWorkerExecutor;
}): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  input.on('SIGINT', stop); input.on('SIGTERM', stop);
  async function observe(config: z.infer<typeof accountCommand>, remote?: { url: string; token: string; signal: AbortSignal }) {
    if (abort.signal.aborted) throw new Error('Cancelled');
    const provider = (input.usage ?? commandUsageProvider)(config.command, { signal: abort.signal, timeoutMs: config.timeoutMs });
    const basis = remote ? await (input.usageBasis ?? readWorkerAccountBasis)(remote, config.account) : undefined;
    if (abort.signal.aborted) throw new Error('Cancelled');
    let windows: Awaited<ReturnType<typeof provider>>;
    try { windows = await provider(Object.freeze({ ...config.account })); }
    catch {
      if (remote && basis && !abort.signal.aborted) await (input.usageUnavailable ?? reportWorkerAccountUnavailable)(remote, { ...config.account, basis: basis.basis });
      throw new Error('Quota reader unavailable');
    }
    if (abort.signal.aborted) throw new Error('Cancelled');
    if (remote) {
      if (!basis) throw new Error('Missing quota observation witness');
      await (input.reportUsage ?? reportWorkerAccountUsage)(remote, { ...config.account, windows, basis: basis.basis });
      if (abort.signal.aborted) throw new Error('Cancelled');
    }
    return windows;
  }
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
        const remote = config.report ? { url: config.report.url, token: (await input.read(config.report.tokenFile)).trim(), signal: abort.signal } : undefined;
        const windows = await observe(config, remote);
        input.output(JSON.stringify({ ...config.account, windows }) + '\n');
      }
      return 0;
    }
    if (input.args.length !== 1) throw new Error('Expected worker configuration path');
    const config = configSchema.parse(JSON.parse(await input.read(input.args[0])));
    const token = (await input.read(config.tokenFile)).trim();
    const remote = { url: config.url, token, signal: abort.signal };
    const control = (input.control ?? httpWorkerControl)(config.facts === undefined ? remote : { ...remote, facts: config.facts });
    const executor = config.container
      ? (input.containerExecutor ?? containerWorkerExecutor)({ ...config, container: config.container })
      : (input.executor ?? commandWorkerExecutor)(config);
    // Refresh before admitting jobs, then alongside the worker slot. Each scan
    // and each private reader settles before another starts. Shutdown joins it.
    const scan = async () => {
      for (const reader of config.accountUsage?.readers ?? []) {
        if (abort.signal.aborted) return;
        try { await observe(reader, remote); }
        catch { if (!abort.signal.aborted) input.error('Worker quota refresh unavailable\n'); }
      }
    };
    if (config.accountUsage) {
      const health = async () => { await (input.health ?? reportWorkerHealth)(config.facts === undefined ? remote : { ...remote, facts: config.facts }); };
      if (abort.signal.aborted) return 0;
      await health();
      let heartbeat: Promise<void> | undefined, failed = false;
      const timer = setInterval(() => {
        if (heartbeat || abort.signal.aborted) return;
        heartbeat = health().then(() => {}, () => {
          if (!abort.signal.aborted) { failed = true; abort.abort(); }
        }).finally(() => { heartbeat = undefined; });
      }, 15_000);
      try { await scan(); }
      finally { clearInterval(timer); await heartbeat; }
      if (failed) throw new Error('Startup health unavailable');
    } else await scan();
    const refresh = config.accountUsage ? (async () => {
      while (!abort.signal.aborted) {
        try { await (input.pause ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(config.accountUsage!.intervalMs ?? 60_000, abort.signal); }
        catch (error) { if (abort.signal.aborted) return; throw error; }
        if (!abort.signal.aborted) await scan();
      }
    })() : undefined;
    // Attach a handler immediately; an unexpected timer failure stops the slot.
    const settled = refresh?.catch(() => { abort.abort(); throw new Error('Quota refresh stopped'); });
    settled?.catch(() => {});
    // Sign-ins asked for through loom run beside the job slot, one at a time. A failed poll is tried again
    // at the next interval; it never stops the worker.
    const wait = input.pause ?? (async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); });
    const signIns = config.accountSignIn ? (async () => {
      const remoteSignIn = (input.signInRemote ?? workerSignIn)(remote);
      while (!abort.signal.aborted) {
        try {
          const request = await remoteSignIn.next();
          if (request) {
            const program = config.accountSignIn!.programs.find(entry => entry.provider === request.provider);
            if (!program) await remoteSignIn.done({ id: request.id, signedIn: false, why: 'no-program' });
            else await (input.relaySignIn ?? relaySignIn)(program.command, request, remoteSignIn, { signal: abort.signal, timeoutMs: config.accountSignIn!.timeoutMs });
          }
        } catch { if (!abort.signal.aborted) input.error('Worker sign-in check unavailable\n'); }
        try { await wait(config.accountSignIn!.intervalMs ?? 10_000, abort.signal); } catch { return; }
      }
    })().catch(() => {}) : undefined;
    try { if (!abort.signal.aborted) await (input.run ?? runWorker)({ box: config.box, signal: abort.signal, control, executor }); }
    finally { abort.abort(); await settled; await signIns; }
    return 0;
  } catch {
    input.error('Worker stopped: invalid configuration or unavailable execution\n');
    return 1;
  } finally { input.off('SIGINT', stop); input.off('SIGTERM', stop); }
}
