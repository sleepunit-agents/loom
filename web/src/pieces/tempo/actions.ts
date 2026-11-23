import { FILE_READER_UNAVAILABLE } from '../../../../src/core/tempo/lane-file.js';
import type { NewTrigger } from '../../../../src/core/tempo/triggers.js';
/** Root supplies authenticated callbacks; the tile supplies only intent. */
export interface TempoActions {
  create?(input: NewTrigger): Promise<void>;
  runNow(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  pause(agent: string): Promise<void>;
  resume(agent: string): Promise<void>;
}

export function tempoFailureMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message === FILE_READER_UNAVAILABLE ? FILE_READER_UNAVAILABLE : fallback;
}
