/** Injectable executable entry: no process is spawned or home opened on import. */
import { doorTokenIn } from '../cli/connection.js';
import { ACCOUNT_SLOTS_BY_HARNESS, ACCOUNT_SLOTS_DEFAULT, BUILD_DEADLINE_MAX_MS, HOUSE_SLOTS_DEFAULT, SLOTS_MAX, STEP_DEADLINE_MAX_MS } from './worker-limits.js';
import { workerTurns } from './worker-turns.js';
import { keyPart } from './worker-mounts.js';
import { z } from 'zod';
import { journalUnit, machineReadKinds, offeredMachineReads, runMachineRead } from './machine-read-catalog.js';
import { machineFacts } from './machine-facts.js';
import { setTimeout as delay } from 'node:timers/promises';
import { relaySignIn } from './account-signin-relay.js';
import { RELAY_MS } from './account-signin-time.js';
import { commandUsageProvider } from './worker-process.js';
import { workerMachineReads, httpWorkerControl, workerSignIn, reportWorkerAccountUsage, readWorkerAccountBasis, reportWorkerAccountUnavailable, reportWorkerHealth, reportWorkerAccountLogins, reportWorkerMachineReadings, WorkerWatchedThingLimit, type WorkerLoginCheck } from './worker-http.js';
import { readLogin, watchesLogin } from './account-login-check.js';
import { MACHINE_CHECK_MS } from './machine-reading-time.js';
import { WATCHED_PATHS_MAX, WATCHED_THING_LIMIT_ERROR, machineReader, watchedPath } from './machine-check.js';
import { DockerResponseError, dockerEngine } from './docker-engine.js';
import { runWorker } from './worker-loop.js';
import { CONTAINER_RUNTIMES, containerWorkerExecutor } from './worker-container.js';
import { REPORT_MS } from './silence.js';
import { defaultWorkerState } from './worker-left.js';
import type { WorkerExecutor } from './worker.js';
import { WORKER_STOP, WorkerStop, workerStopLine, type WorkerStopStage } from './worker-stop.js';
const commandString = z.string().refine(value => !value.includes('\0'));
const command = z.object({ command: commandString.min(1), args: z.array(commandString), cwd: commandString.min(1), env: z.record(commandString, commandString) }).strict();
const runnerCommand = command.extend({ bodyBootstrap: z.boolean().optional(), selectsAccount: z.boolean().optional() });
/** How many bodies on one account at once. */
const accountSlot = z.number().int().min(1).max(SLOTS_MAX);
/** A directory of this machine an agent's bodies are given, and where under the tenant's home it lands. Only the shape is read here: every rule
 * about these paths, and about the two engine sockets below, is in worker-mounts.ts, which stops the worker
 * with a line of its own (exit 52). A path written wrongly is that exit too, never this file's 41. */
const hostDirectory = z.object({ source: z.string(), target: z.string() }).strict();
const stepDeadline = z.number().int().min(1).max(STEP_DEADLINE_MAX_MS);
const accountCommand = z.object({
  command,
  account: z.object({ account: z.string().trim().min(1), owner: z.string().trim().min(1), provider: z.string().trim().min(1) }).strict(),
  timeoutMs: stepDeadline.optional(),
}).strict();
const usageCommand = accountCommand.extend({ report: z.object({ url: z.string(), tokenFile: z.string().min(1) }).strict().optional() });
const configSchema = z.object({
  reportOnly: z.literal(true).optional(),
  journalUnits:z.array(journalUnit).max(128).optional(),
  reads: z.array(z.enum(machineReadKinds)).max(machineReadKinds.length).optional(),
  facts: machineFacts.optional(),
  url: z.string(), box: z.string().min(1), tokenFile: z.string().min(1),
  /** A directory of this worker's own, where it records the builds and bodies it starts and keeps each
   * body's scratch directory, so that the worker after it can end them if this one is killed
   * (worker-left.ts). Left out, it is a directory under the temporary directory named for this user and machine. */
  state: commandString.startsWith('/').optional(),
  /** Former process worker keys, parsed so a valid legacy configuration gets a migration diagnostic. */
  build: command.optional(), runners: z.record(z.string(), runnerCommand).optional(),
  /** How many jobs the worker runs side by side. Defaults to HOUSE_SLOTS_DEFAULT. */
  slots: z.number().int().min(1).max(SLOTS_MAX).optional(),
  /** How many of those may be bodies on one account at once, for one harness: one number for every
   * harness, or a number for each harness named. A harness not said has its default: ACCOUNT_SLOTS_BY_HARNESS,
   * or ACCOUNT_SLOTS_DEFAULT, or `slots` when that is fewer. One runs an account's bodies one after the
   * other. Never more than `slots`. */
  accountSlots: z.union([accountSlot, z.record(z.string().min(1), accountSlot)]).optional(),
  /** The longest a build may take. Left out: each kind of build's own default (worker-limits.ts). */
  buildTimeoutMs: z.number().int().min(1).max(BUILD_DEADLINE_MAX_MS).optional(),
  accountRunners: z.record(z.string().min(1), z.record(z.string().min(1), runnerCommand)).optional(),
  /** A sign-in directory for each account id, then harness, mounted into that job's container and no
   * other. Container bodies only. When present, every job needs an exact entry. */
  // An entry is the machine's directory and nothing else. A `target` is what an entry used to carry: read
  // here so that the worker can stop on it with its own line (WorkerStop 'retired').
  accountLogins: z.record(z.string().min(1), z.record(z.string().min(1), z.object({ source: z.string(), target: z.unknown().optional() }).strict())).optional(),
  /** The machine user's own sign-ins, by account and harness: the directory each harness keeps its sign-in in,
   * as a whole path (for example `/home/art/.claude`; nothing in it is expanded). They are only watched, so their owner hears when one is gone or ending; no body
   * is given them. The sign-ins houses mount (accountLogins) are watched without being named here. */
  hostLogins: z.record(z.string().min(1).max(200), z.record(z.string().min(1), z.object({ source: z.string().startsWith('/') }).strict())).optional(),
  /** How often the worker reads the sign-in files on its machine. */
  loginCheckMs: z.number().int().min(1_000).max(3_600_000).optional(),
  /** How often the worker reads its own machine: the room on its disks, the memory available, and whether the
   * container runtime answers (machine-check.ts). Left out, every five minutes. */
  machineCheckMs: z.number().int().min(10_000).max(3_600_000).optional(),
  /** More paths whose filesystem is watched, beside the ones every worker watches: `/`, its state directory
   * when it takes jobs. Include the container runtime’s directory if it is on a separate filesystem. */
  watchPaths: z.array(z.string().refine(watchedPath)).max(WATCHED_PATHS_MAX - 2).optional(),
  accountUsage: z.object({ readers: z.array(accountCommand).min(1).max(32), intervalMs: z.number().int().min(1_000).max(3_600_000).optional() }).strict().optional(),
  /** Sign-ins asked for through loom: one program per provider, run on this machine with a private directory
   * as its last argument (see account-signin-relay.ts). Without this the worker takes no sign-in requests.
   * This is the one way a worker signs an account in. */
  accountSignIn: z.object({ programs: z.array(z.object({ provider: z.string().trim().min(1), command }).strict()).min(1).max(32),
    intervalMs: z.number().int().min(1_000).max(600_000).optional(), timeoutMs: z.number().int().min(10_000).max(RELAY_MS).optional() }).strict().optional(),
  container: z.object({ socket: z.string(), nestedSocket: z.string().optional(), protectedPaths: z.array(z.string()).optional(),
    runtime: z.enum(CONTAINER_RUNTIMES).optional(), podmanHelperSubid:z.number().int().min(1).max(65533).optional(),
    // By agent id. One list for every body is what this key used to be: read here so that the worker
    // can stop on it with its own line (WorkerStop 'retired') and not as a file that is not valid.
    mounts: z.union([z.array(z.unknown()), z.record(z.string().min(1), z.array(hostDirectory.extend({ readOnly: z.boolean().optional() }).strict()))]).optional(),
    setupTimeoutMs: stepDeadline.optional(),
    cleanupTimeoutMs: stepDeadline.optional() }).strict().optional(),
}).strict().superRefine((config, context) => {
  const accounts = config.accountUsage?.readers.map(reader => reader.account.account) ?? [];
  if (new Set(accounts).size !== accounts.length) context.addIssue({ code: 'custom', message: 'Duplicate account quota reader' });
  // Account sign-in directories are container mounts.
  if (config.accountLogins && !config.container) context.addIssue({ code: 'custom', message: 'Account sign-in directories need container bodies' });
  const most = config.slots ?? HOUSE_SLOTS_DEFAULT;
  if ((typeof config.accountSlots === 'number' ? [config.accountSlots] : Object.values(config.accountSlots ?? {})).some(count => count > most)) context.addIssue({ code: 'custom', message: 'accountSlots is more than slots' });
});
/** How long the worker lets an unchanged answer about its sign-ins stand before saying it again. */
const LOGIN_REPORT_MS = 5 * 60_000;
export async function workerProgram(input: {
  args: readonly string[];
  read: (path: string) => Promise<string>;
  on: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  off: (name: 'SIGINT' | 'SIGTERM', stop: () => void) => void;
  error: (text: string) => void;
  /** Local structured observations only; never private command diagnostics. */
  output?: (text: string) => void;
  readRemote?: typeof workerMachineReads;
  relaySignIn?: typeof relaySignIn;
  readLogin?: typeof readLogin;
  reportLogins?: typeof reportWorkerAccountLogins;
  /** What reads this machine, given the paths and the container runtime the configuration names. */
  machineReader?: typeof machineReader;
  reportReadings?: typeof reportWorkerMachineReadings;
  /** The wait between two reads of the machine. */
  machinePause?: (ms: number, signal: AbortSignal) => Promise<void>;
  signInRemote?: typeof workerSignIn;
  usage?: typeof commandUsageProvider;
  reportUsage?: typeof reportWorkerAccountUsage;
  usageBasis?: typeof readWorkerAccountBasis;
  usageUnavailable?: typeof reportWorkerAccountUnavailable;
  health?: typeof reportWorkerHealth;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wait between two reads of the sign-in files. */
  loginPause?: (ms: number, signal: AbortSignal) => Promise<void>;
  run?: typeof runWorker; control?: typeof httpWorkerControl;
  containerExecutor?: typeof containerWorkerExecutor;
}): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  let executor: WorkerExecutor | undefined;
  let diagnostics: Promise<void> | undefined, loginChecks: Promise<void> | undefined, machineChecks: Promise<void> | undefined;
  // The stage the worker is in: what a failure there is reported as (worker-stop.ts).
  let stage: WorkerStopStage = 'usage';
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
    // The one-shot sign-in command is gone: it ran a program of another protocol than the one loom asks
    // for, and told loom nothing. Refused before its file is read, with the line that says what to use.
    if (mode === '--account-signin') throw new WorkerStop('signin');
    if (mode === '--account-usage') {
      if (input.args.length !== 2 || !input.output) throw new Error('Expected account command configuration');
      stage = 'config';
      // This one-shot worker command receives only local owner configuration. It reads no Loom token
      // unless reporting is configured, and neither claims jobs nor changes membership.
      const config = usageCommand.parse(JSON.parse(await input.read(input.args[1])));
      stage = 'token';
      const remote = config.report ? { url: config.report.url, token: doorTokenIn(await input.read(config.report.tokenFile)), signal: abort.signal } : undefined;
      stage = 'account';
      const windows = await observe(config, remote);
      input.output(JSON.stringify({ ...config.account, windows }) + '\n');
      return 0;
    }
    if (input.args.length !== 1) throw new Error('Expected worker configuration path');
    stage = 'config';
    const config = configSchema.parse(JSON.parse(await input.read(input.args[0])));
    if (!config.reportOnly && !config.container) throw new WorkerStop('containerRequired');
    if (config.container?.nestedSocket !== undefined) throw new WorkerStop('mounts', 'container.nestedSocket');
    // Keys a worker with container bodies used to take. It does not go on without them as if they were
    // not there: whoever wrote one expects it to do something.
    if (config.container) for (const [key, present] of [['build', config.build], ['runners', config.runners], ['accountRunners', config.accountRunners],
      ['container.mounts', Array.isArray(config.container.mounts) ? true : undefined]] as const) if (present !== undefined) throw new WorkerStop('retired', key);
    // Where a sign-in appears in a house is loom's to say now (house-layout.ts), the same on every machine.
    for (const [account, harnesses] of Object.entries(config.accountLogins ?? {})) for (const [harness, login] of Object.entries(harnesses))
      if (login.target !== undefined) throw new WorkerStop('retired', `accountLogins.${keyPart(account)}.${keyPart(harness)}.target`);
    stage = 'token';
    const token = doorTokenIn(await input.read(config.tokenFile));
    stage = 'setup';
    const slots = config.slots ?? HOUSE_SLOTS_DEFAULT;
    const remote = { url: config.url, token, signal: abort.signal };
    const wait = input.pause ?? (async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, {signal}); });
    const reportHealth = async () => (input.health ?? reportWorkerHealth)({
      ...remote, facts: config.facts, slots: config.reportOnly ? 0 : slots,
    });
    async function poll(intervalMs: number, failure: string, check: () => Promise<void>, pause = wait) {
      while (!abort.signal.aborted) {
        try { await check(); }
        catch { if (!abort.signal.aborted) input.error(failure); }
        if (abort.signal.aborted) return;
        try { await pause(intervalMs, abort.signal); } catch { return; }
      }
    }
    // What the sign-in files on this machine say, for every sign-in houses mount and every one of the machine's
    // own that is named. Loom is told when that changes, and again every so often so that it knows the answer
    // is still current and so that a record loom dropped meanwhile comes back. The list is everything this
    // worker watches, also when that is nothing and also from a worker that only reports: loom stops watching
    // what is no longer named. A file that cannot be read is named as unknown, so that it alone keeps what
    // loom last learned and the others are told. A sign-in is said to be gone only when two reads in a row
    // found it gone: a harness that replaces its file leaves a moment with none, and that is not signed out.
    const watched = [['containers', config.accountLogins], ['host', config.hostLogins]] as const;
    let lastLogins: string | undefined, lastLoginsAt = -Infinity, foundGone = new Set<string>();
    // Started once the worker is otherwise ready (below), on its own clock so that it shares no timing with the usage refresh.
    const loginPause = input.loginPause ?? (async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); });
    const watchLogins = () => poll(config.loginCheckMs ?? 60_000, 'Worker sign-in state unavailable\n', async () => {
      const logins: WorkerLoginCheck[] = [], gone = new Set<string>();
      for (const [place, accounts] of watched) for (const [account, harnesses] of Object.entries(accounts ?? {})) for (const [harness, login] of Object.entries(harnesses)) {
        if (!watchesLogin(harness)) continue;
        let read: Awaited<ReturnType<typeof readLogin>> | { state: 'unknown' };
        try { read = await (input.readLogin ?? readLogin)(harness, login.source); } catch { read = { state: 'unknown' }; }
        const name = JSON.stringify([account, harness, place]);
        if (read.state === 'signed-out') { gone.add(name); if (!foundGone.has(name)) read = { state: 'unknown' }; }
        logins.push({ account, harness, place, ...read });
      }
      foundGone = gone;
      const said = JSON.stringify(logins);
      if (abort.signal.aborted || (said === lastLogins && performance.now() - lastLoginsAt < LOGIN_REPORT_MS)) return;
      await (input.reportLogins ?? reportWorkerAccountLogins)(remote, logins);
      lastLogins = said; lastLoginsAt = performance.now();
    }, loginPause);
    // What this machine says about itself, on a clock of its own, slower than any other and apart from the
    // poll for work. Everything watched is said each time: loom keeps the latest reading, decides what is a
    // condition and tells the machine's owner. A worker that only reports watches its machine as well; that
    // is how the machine loom itself is on is watched when it hosts no bodies. A failed report is tried
    // again at the next interval and never stops the worker. A container runtime is asked about only by a
    // worker that has one configured (`container.socket`), whether or not it also only reports.
    const watchMachine = (statePath?: string) => {
      const socket = config.container?.socket, everyMs = config.machineCheckMs ?? MACHINE_CHECK_MS;
      let saidLimit = false;
      const read = (input.machineReader ?? machineReader)({ paths: ['/', ...(config.watchPaths ?? [])],
        ...(statePath === undefined ? {} : { statePath }), signal: abort.signal,
        say: line => input.error(line),
        ...(socket === undefined ? {} : { engine: async (signal: AbortSignal) => {
          try {
            await dockerEngine(socket).json('GET', '/version', undefined, signal);
            return 200;
          } catch (error) {
            if (error instanceof DockerResponseError && error.status >= 300 && error.status <= 599) return error.status;
            throw error;
          }
        } }) });
      return poll(everyMs, 'Worker machine readings unavailable\n', async () => {
        const readings = await read();
        if (abort.signal.aborted) return;
        try { await (input.reportReadings ?? reportWorkerMachineReadings)(remote, readings); }
        catch (error) {
          if (!(error instanceof WorkerWatchedThingLimit)) throw error;
          if (!saidLimit) {
            saidLimit = true;
            if (!abort.signal.aborted) input.error(`Worker machine check: ${WATCHED_THING_LIMIT_ERROR}\n`);
          }
        }
      // A clock of its own: it shares no timing with the usage refresh or the sign-in check.
      }, input.machinePause ?? (async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); }));
    };
    if (config.reads?.length || config.reportOnly) {
      const reads = offeredMachineReads(config.reads ?? []);
      const reader = (input.readRemote ?? workerMachineReads)(remote);
      let heartbeat = 0;
      diagnostics = poll(3000, 'Machine read check unavailable\n', async () => {
        if (config.reportOnly && Date.now() >= heartbeat) {
          await reportHealth();
          heartbeat = Date.now() + REPORT_MS;
        }
        const request = await reader.next(reads);
        if (!request || abort.signal.aborted) return;
        const kind = reads.find(kind => kind === request.read);
        const result = kind
          ? await runMachineRead({...request.args, kind}, token, undefined, config.journalUnits, abort.signal)
          : {ok: false, output: 'Machine read unavailable'};
        await reader.done({id: request.id, ...result});
      });
      if (config.reportOnly) { loginChecks = watchLogins(); machineChecks = watchMachine(config.state); await diagnostics; return 0; }
    }
    const silenceExpired = (ms: number) => input.error(`Worker abandoned a job after Loom was unreachable for ${ms} ms\n`);
    const control = (input.control ?? httpWorkerControl)({ ...remote, slots, ...(config.container && { programs: true }), silenceExpired, ...(config.facts === undefined ? {} : { facts: config.facts }) });
    // The executor holds the state directory from here, and refuses it when another worker is alive on it.
    const state = config.state ?? defaultWorkerState(config.box);
    const container = config.container!; // Required before token read for every worker taking jobs.
    // A list of mounts stopped the worker above. The remaining mounts are keyed by agent.
    executor = (input.containerExecutor ?? containerWorkerExecutor)({ ...config, configFile: input.args[0], container: { ...container, mounts: container.mounts as Exclude<typeof container.mounts, unknown[]> }, state },
      { say: text => input.error(text), kitAccess:{url:config.url,runner:token} });
    // Before any report or claim: end what a worker killed before this one left running, or the work loom
    // has queued again would run beside it. If that cannot be done, this worker does not start.
    stage = 'left';
    const found = await executor.endLeft?.(abort.signal);
    if (found?.unverified) input.error(`Worker left ${found.unverified} process group(s) running that it could not show to be a previous worker's\n`);
    // Refresh before admitting jobs, then alongside the worker slot. Each scan
    // and each private reader settles before another starts. Shutdown joins it.
    const scan = async () => {
      for (const reader of config.accountUsage?.readers ?? []) {
        if (abort.signal.aborted) return;
        try { await observe(reader, remote); }
        catch { if (!abort.signal.aborted) input.error('Worker quota refresh unavailable\n'); }
      }
    };
    stage = 'health';
    if (config.accountUsage) {
      if (abort.signal.aborted) return 0;
      await reportHealth();
      let heartbeat: Promise<void> | undefined, failed = false;
      const timer = setInterval(() => {
        if (heartbeat || abort.signal.aborted) return;
        heartbeat = reportHealth().then(() => {}, () => {
          if (!abort.signal.aborted) { failed = true; abort.abort(); }
        }).finally(() => { heartbeat = undefined; });
      }, REPORT_MS);
      try { await scan(); }
      finally { clearInterval(timer); await heartbeat; }
      if (failed) throw new Error('Startup health unavailable');
    } else await scan();
    const refresh = config.accountUsage ? (async () => {
      while (!abort.signal.aborted) {
        try { await wait(config.accountUsage!.intervalMs ?? 60_000, abort.signal); }
        catch (error) { if (abort.signal.aborted) return; throw error; }
        if (!abort.signal.aborted) await scan();
      }
    })() : undefined;
    // Attach a handler immediately; an unexpected timer failure stops the slot.
    const settled = refresh?.catch(() => { abort.abort(); throw new WorkerStop('refresh'); });
    settled?.catch(() => {});
    // Sign-ins asked for through loom run beside the job slot, one at a time. A failed poll is tried again
    // at the next interval; it never stops the worker.
    const signIn = config.accountSignIn;
    const remoteSignIn = signIn && (input.signInRemote ?? workerSignIn)(remote);
    const signIns = signIn && remoteSignIn && poll(signIn.intervalMs ?? 10_000, 'Worker sign-in check unavailable\n', async () => {
      const request = await remoteSignIn.next();
      if (!request || abort.signal.aborted) return;
      const program = signIn.programs.find(entry => entry.provider === request.provider);
      if (!program) await remoteSignIn.done({ id: request.id, signedIn: false, why: 'no-program' });
      else await (input.relaySignIn ?? relaySignIn)(program.command, request, remoteSignIn, { signal: abort.signal, timeoutMs: signIn.timeoutMs });
    });
    loginChecks = watchLogins(); machineChecks = watchMachine(state);
    stage = 'slot';
    // Several jobs side by side: each slot is the one loop there always was, and they share the control,
    // the executor, the stop and whose turn it is for what two bodies cannot have at once (worker-turns.ts).
    // A slot that fails (a body it could not end) stops the others; each ends its own body before the
    // worker goes on to exit, and the first failure is the one reported.
    // One number is every harness's. Otherwise each harness has what the configuration says for it, or its default.
    const said = config.accountSlots, own = (map: Readonly<Record<string, number>>, harness: string) => Object.hasOwn(map, harness) ? map[harness] : undefined;
    const turns = workerTurns({ accounts: typeof said === 'number' ? said
      : harness => own(said ?? {}, harness) ?? Math.min(own(ACCOUNT_SLOTS_BY_HARNESS, harness) ?? ACCOUNT_SLOTS_DEFAULT, slots) });
    try {
      if (!abort.signal.aborted) {
        const running = Array.from({ length: slots }, () => (input.run ?? runWorker)({ box: config.box, signal: abort.signal, control, executor: executor!, turns, silenceExpired })
          .catch((error: unknown) => { abort.abort(); throw error; }));
        const failed = (await Promise.allSettled(running)).find(slot => slot.status === 'rejected');
        if (failed) throw failed.reason;
      }
    }
    finally { abort.abort(); await settled; await signIns; }
    return 0;
  } catch (error) {
    // One fixed line and code for the stage; never the error's own words.
    const at = error instanceof WorkerStop ? error.stage : stage;
    input.error(workerStopLine(at, error instanceof WorkerStop ? error.key : undefined));
    return WORKER_STOP[at][0];
  } finally { abort.abort(); await diagnostics; await loginChecks; await machineChecks; executor?.close?.(); input.off('SIGINT', stop); input.off('SIGTERM', stop); }
}
