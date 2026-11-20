/** A worker's readings of its own machine enter here, and the household's lines for them are set here. */
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { liveWorker } from './shared-worker.js';
import { householdOwner } from './shared-sharing.js';
import { boxReadings } from './core/data/schema.js';
import { SIZE_BYTES_MAX, WATCHED_PATHS_MAX, watchedPath } from './runtime/machine-check.js';
import { MachineConditions, alertLines, setAlertLines } from './runtime/machine-conditions.js';

// loom keeps a size in whole mebibytes and the read API serves an integer column as a GraphQL `Int`, which
// ends at 2^31 - 1 (drizzle-graphql maps SQLiteInteger to GraphQLInt). A larger size is refused here and
// not cut down to fit: a number that is not the disk's would be held to the lines and shown as its size.
// A worker names a filesystem that large as unknown (machine-check.ts), so the rest of its report is taken.
const bytes = z.number().int().min(0).max(SIZE_BYTES_MAX);
/** What a worker read about one thing on its own machine: numbers, an HTTP status, and for a disk the path
 * watched, held to a short length and a plain alphabet (`watchedPath`, which says what that does and does
 * not protect). No judgement: whether a number is a fault is decided here (MachineConditions), and every
 * word of a notice but the path is loom's. `unknown` names a thing the worker watches and could not read. */
export const machineReading = z.object({ kind: z.enum(boxReadings.kind.enumValues), thing: z.string().refine(watchedPath).optional(), unknown: z.literal(true).optional(), reason: z.literal('state-path').optional(),
  sizeBytes: bytes.optional(), freeBytes: bytes.optional(), engineStatus: z.union([z.literal(200), z.number().int().min(300).max(599)]).optional() }).strict().superRefine((reading, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (reading.reason === 'state-path') {
    if (reading.kind !== 'disk' || reading.thing !== undefined || !reading.unknown) issue('Only an unknown state directory can have no path');
  } else if ((reading.kind === 'disk') !== (reading.thing !== undefined)) issue('A disk is named by its path, and nothing else is named');
  const numbers = reading.sizeBytes !== undefined || reading.freeBytes !== undefined;
  if (reading.unknown) {
    if (numbers || reading.engineStatus !== undefined) issue('An unknown reading carries no values');
    return;
  }
  if (reading.kind === 'containers') {
    if (numbers || reading.engineStatus === undefined) issue('Say only how the container runtime answered');
    return;
  }
  if (reading.engineStatus !== undefined || !reading.sizeBytes || reading.freeBytes === undefined || reading.freeBytes > reading.sizeBytes) issue('Say how much there is and how much of it is free');
});
// A line clears a few points under itself, so the lowest is one that can; the same bounds as the columns' checks.
const percent = z.number().int().min(10).max(99), urgentPercent = z.number().int().min(11).max(100), mib = z.number().int().min(0).max(1_000_000_000);
export function registerSharedMachineReadings(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{ box: string }> | undefined) {
  const conditions = new MachineConditions(db, now);
  // Each report updates the machine's latest observations, including omissions.
  // Which machine it speaks for comes from its credential alone.
  operations.register({ name: 'runtime.machineReadings', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ readings: z.array(machineReading).max(WATCHED_PATHS_MAX + 2)
      .refine(readings => readings.filter(row => row.kind === 'disk').length <= WATCHED_PATHS_MAX &&
        new Set(readings.map(row => JSON.stringify([row.kind, row.thing]))).size === readings.length, 'Report each watched thing once') }).strict(), output: z.object({ ok: z.literal(true) }).strict(),
    may: viewer => !!liveWorker(db, viewer, runner(viewer)),
    run(ctx, input) {
      const box = liveWorker(db, ctx.viewer, runner(ctx.viewer));
      if (!box) throw new OperationError('denied', 'Worker required');
      const { changed } = conditions.read(box, input.readings);
      // The numbers move with every reading. A state a person is shown (a condition raised or cleared, the
      // container runtime answering or not, a thing unknown, readable again, stale, added or dropped) is an
      // ordinary change, told at once. Numbers alone are a stamp and reach an open window as a last-seen
      // time does (docs/accepted-tradeoffs.md): MachineConditions.read says which this was.
      if (changed) ctx.changed('box', box); else ctx.stampOnly?.();
      return { ok: true as const };
    },
  });
  operations.register({ name: 'machine.setAlertLines', write: true, recheckPolicy: true,
    input: z.object({ diskPercent: percent, diskUrgentPercent: urgentPercent, diskFreeMib: mib, memoryFreeMib: mib }).partial().strict()
      .refine(input => Object.values(input).some(value => value !== undefined), 'Choose a line'),
    output: z.object({ diskPercent: percent, diskUrgentPercent: urgentPercent, diskFreeMib: mib, memoryFreeMib: mib }).strict(),
    may: viewer => householdOwner(db, viewer),
    run(ctx, patch) {
      const lines = { ...alertLines(db), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      if (lines.diskUrgentPercent <= lines.diskPercent) throw new OperationError('invalid', 'The urgent line must be over the alert line');
      const set = setAlertLines(db, lines);
      // A machine is held to the new lines by its next reading.
      ctx.changed('boxAlertSettings', '1');
      return set;
    },
  });
}
