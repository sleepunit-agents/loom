/** The default life of an episode. What a memory write must hold is the `remember` shape's to say
 * (pieces/mind/semantic-commands.ts), which every write door parses before it comes here. */
import type { MemoryInput } from '../backends/types.js';
import { EPISODE_CATEGORY, EPISODE_DEFAULT_TTL } from '../categories.js';

/** An episode is short-term by definition: without an explicit ttl it gets the
 * tier default, so a body can never accidentally leave a permanent episode. */
export function prepareMemoryInput(input:MemoryInput):MemoryInput {
  return input.category === EPISODE_CATEGORY && !input.ttl ? {...input,ttl:EPISODE_DEFAULT_TTL} : input;
}
