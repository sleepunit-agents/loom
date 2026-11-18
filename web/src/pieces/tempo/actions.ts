import type { NewTrigger } from '../../../../src/core/tempo/triggers.js';
/** Root supplies authenticated callbacks; the tile supplies only intent. */
export interface TempoActions {
  create?(input: NewTrigger): Promise<void>;
  withdrawMachine?(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  pause(agent: string): Promise<void>;
  resume(agent: string): Promise<void>;
}
