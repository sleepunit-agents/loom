import type { NewTrigger } from '../../../../src/core/tempo/triggers.js';
/** A firing failure already committed by Tempo and safe to show to its caller. */
export class TempoFiringFailure extends Error {}
/** Root supplies authenticated callbacks; the tile supplies only intent. */
export interface MachinePreview { summary: string; review: string; problem: string | null }
export interface TempoActions {
  create?(input: NewTrigger): Promise<void>;
  previewMachine?(id: string, machine: string): Promise<MachinePreview>;
  requestMachine?(id: string, machine: string, reviewed?: string): Promise<string>;
  withdrawMachine?(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  pause(agent: string): Promise<void>;
  resume(agent: string): Promise<void>;
}
