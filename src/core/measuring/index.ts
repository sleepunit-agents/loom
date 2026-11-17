import type { Span, Tracer } from '@opentelemetry/api';
import { clock as realClock, type Clock } from '../clock.js';

export type TimingKind = 'request' | 'operation' | 'job';
export interface TimingTarget { kind: TimingKind; name: string }
export interface MeasuringSettings {
  on: boolean;
  send_outside: boolean;
  outside_address: string;
  keep_days: number;
}
export interface TimingDay extends TimingTarget {
  day: string;
  count: number;
  total_ms: number;
  slowest_ms: number;
  typical_ms: number;
}
/** Implemented by the shared concrete model, never by a second monitoring DB.
 * add atomically increments count/total, takes max(slowest), and sets
 * typical_ms = total_ms/count. prune removes days strictly before its argument.
 * Neither method may call instrumented application work. */
export interface TimingStore {
  add(row: TimingDay): void;
  prune(beforeDay: string): void;
}
export interface Measuring {
  run<T>(kind: TimingKind, name: string, work: () => T): T;
  runAsync<T>(kind: TimingKind, name: string, work: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
/** The most days of local history that can be asked for. Zero means none is kept here, which is allowed
 * only when measurements are sent outside. The column's check in schema.ts states the same range. */
export const KEEP_DAYS_MAX = 3650;
/** Whole days from 0 to the most allowed. */
export const validKeepDays = (days: number): boolean => Number.isInteger(days) && days >= 0 && days <= KEEP_DAYS_MAX;
export const DEFAULT_MEASURING: Readonly<MeasuringSettings> = Object.freeze({
  on: false, send_outside: false, outside_address: '', keep_days: 90,
});
const off: Measuring = Object.freeze({
  run: <T>(_kind: TimingKind, _name: string, work: () => T) => work(),
  runAsync: <T>(_kind: TimingKind, _name: string, work: () => Promise<T>) => work(),
  flush: async () => {}, close: async () => {},
});

/** Internal lifecycle hook. The caller supplies owner-approved settings and
 * a fixed inventory of names from code (never a URL, query, id or user input).
 * No SDK, exporter, timer, clock read or store access exists in the off path.
 * Deliberately does not install a process-global tracer provider. */
export async function createMeasuring(
  settings: Readonly<MeasuringSettings>, targets: readonly TimingTarget[], store?: TimingStore,
  reportError: () => void = () => {},
  clock: Clock = realClock,
): Promise<Measuring> {
  if (!settings.on) return off;
  const keepDays = settings.keep_days;
  if (!validKeepDays(keepDays) || (keepDays === 0 && (!settings.send_outside || store))) throw new Error(`keep_days must be 0–${KEEP_DAYS_MAX}, with at least one day for local history`);
  if (targets.length > 2048 || targets.some(t =>
    !['request', 'operation', 'job'].includes(t.kind) || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(t.name)))
    throw new Error('Measuring needs a bounded inventory of code-defined names');
  let address: string | undefined;
  if (settings.send_outside) {
    const url = new URL(settings.outside_address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Outside address must be an HTTP(S) OTLP traces endpoint without credentials, query or fragment');
    address = url.href;
  }
  if (!store && !address) throw new Error('Measuring needs a destination');
  const inventory = new Set(targets.map(t => `${t.kind}:${t.name}`));
  const sdk = await import('@opentelemetry/sdk-trace');
  const processors: import('@opentelemetry/sdk-trace').SpanProcessor[] = [];
  let active = true;
  let writing = false;
  let prunedDay = '';
  const report = () => { try { reportError(); } catch { /* diagnostics cannot break application work */ } };
  const prune = (day: string) => {
    if (!store || day <= prunedDay) return;
    store.prune(new Date(Date.parse(day) - (keepDays - 1) * 86400_000).toISOString().slice(0, 10));
    prunedDay = day;
  };
  if (store) processors.push({
    onStart() {},
    onEnd(span) {
      if (!active || writing) return;
      const kind = span.attributes['loom.kind'] as TimingKind;
      const name = span.name;
      if (!inventory.has(`${kind}:${name}`)) return;
      const ms = span.duration[0] * 1000 + span.duration[1] / 1e6;
      if (!Number.isFinite(ms) || ms < 0) return;
      writing = true;
      try {
        // Use the same calendar as retention, including under an injected clock.
        // OpenTelemetry still supplies the monotonic elapsed duration.
        const day = new Date(clock.now()).toISOString().slice(0, 10);
        // UTC calendar days, including today. Retention recovers after a long
        // idle interval or restart without issuing a DELETE for every span.
        prune(day);
        store.add({ day, kind, name, count: 1, total_ms: ms, slowest_ms: ms, typical_ms: ms });
      } catch { report(); }
      finally { writing = false; }
    },
    async forceFlush() {}, async shutdown() {},
  });
  if (address) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    processors.push(new sdk.BatchSpanProcessor({
      exporter: new OTLPTraceExporter({ url: address, timeoutMillis: 3000, headers: {} }),
      maxQueueSize: 512, maxExportBatchSize: 64, exportTimeoutMillis: 4000,
    }));
  }
  const provider = new sdk.TracerProvider({ spanProcessors: processors, sampler: new sdk.AlwaysOnSampler() });
  let cancelRetention: (() => void) | undefined;
  const retain = () => {
    if (!active || !store) return;
    const now = clock.now();
    writing = true;
    try { prune(new Date(now).toISOString().slice(0, 10)); }
    catch { report(); }
    finally { writing = false; }
    // Expire idle stores too, without a polling interval or a process keepalive.
    if (active) cancelRetention = clock.at((Math.floor(now / 86400_000) + 1) * 86400_000, retain);
  };
  retain();
  const tracer: Tracer = provider.getTracer('loom.measuring');
  const begin = (kind: TimingKind, name: string): Span | undefined =>
    active && !writing && inventory.has(`${kind}:${name}`)
      ? tracer.startSpan(name, { attributes: { 'loom.kind': kind } }) : undefined;
  let closing: Promise<void> | undefined;
  return {
    run(kind, name, work) {
      const span = begin(kind, name);
      try { return work(); }
      catch (error) { span?.setStatus({code: 2}); throw error; }
      finally { span?.end(); }
    },
    async runAsync(kind, name, work) {
      const span = begin(kind, name);
      try { return await work(); }
      catch (error) { span?.setStatus({code: 2}); throw error; }
      finally { span?.end(); }
    },
    flush: () => provider.forceFlush({ timeoutMillis: 5000 }),
    close() {
      active = false; // Fence unfinished async work before yielding to SDK shutdown.
      cancelRetention?.();
      return closing ??= provider.shutdown();
    },
  };
}
