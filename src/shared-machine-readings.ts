/** A worker's readings of its own machine enter here, and the household's lines for them are set here. */
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { liveWorker } from './shared-worker.js';
import { householdOwner } from './shared-sharing.js';
import { boxReadings } from './core/data/schema.js';
import { WATCHED_PATHS_MAX, watchedPath } from './runtime/machine-check.js';
import { MachineConditions, alertLines, setAlertLines } from './runtime/machine-conditions.js';

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** What a worker read about one thing on its own machine: numbers, a yes or no, and for a disk the path
 * watched, in the letters loom will write into a notice. No words of the worker's own, and no judgement:
 * whether a number is a fault is decided here (MachineConditions). `unknown` names a thing the worker
 * watches and could not read. */
export const machineReading = z.object({ kind: z.enum(boxReadings.kind.enumValues), thing: z.string().refine(watchedPath).optional(), unknown: z.literal(true).optional(),
  sizeBytes: bytes.optional(), freeBytes: bytes.optional(), answers: z.boolean().optional() }).strict().superRefine((reading, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if ((reading.kind === 'disk') !== (reading.thing !== undefined)) issue('A disk is named by its path, and nothing else is named');
  if (reading.unknown) return;
  if (reading.kind === 'containers') { if (reading.answers === undefined) issue('Say whether the container runtime answers'); return; }
  if (!reading.sizeBytes || reading.freeBytes === undefined || reading.freeBytes > reading.sizeBytes) issue('Say how much there is and how much of it is free');
});
const percent = z.number().int().min(1).max(100), mib = z.number().int().min(0).max(1_000_000_000);
export function registerSharedMachineReadings(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{ box: string }> | undefined) {
  const conditions = new MachineConditions(db, now);
  // The worker names every thing it watches each time, so the record of its machine is replaced whole.
  // Which machine it speaks for comes from its credential alone.
  operations.register({ name: 'runtime.machineReadings', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ readings: z.array(machineReading).max(WATCHED_PATHS_MAX + 2) }).strict(), output: z.object({ changed: z.boolean() }).strict(),
    may: viewer => !!liveWorker(db, viewer, runner(viewer)),
    run(ctx, input) {
      const box = liveWorker(db, ctx.viewer, runner(ctx.viewer));
      if (!box) throw new OperationError('denied', 'Worker required');
      const { changed } = conditions.read(box, input.readings);
      // The numbers move with every reading. Open windows are told at once only when a condition was raised
      // or cleared, or the things watched changed; the numbers alone reach them as a last-seen time does.
      if (changed) ctx.changed('box', box); else ctx.stampOnly?.();
      return { changed };
    },
  });
  operations.register({ name: 'machine.setAlertLines', write: true, recheckPolicy: true,
    input: z.object({ diskPercent: percent, diskUrgentPercent: percent, diskFreeMib: mib, memoryFreeMib: mib }).partial().strict()
      .refine(input => Object.values(input).some(value => value !== undefined), 'Choose a line'),
    output: z.object({ diskPercent: percent, diskUrgentPercent: percent, diskFreeMib: mib, memoryFreeMib: mib }).strict(),
    may: viewer => householdOwner(db, viewer),
    run(ctx, patch) {
      const lines = { ...alertLines(db), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      if (lines.diskUrgentPercent < lines.diskPercent) throw new OperationError('invalid', 'The urgent line cannot be under the alert line');
      const set = setAlertLines(db, lines);
      // A machine is held to the new lines by its next reading.
      ctx.changed('boxAlertSettings', '1');
      return set;
    },
  });
}
