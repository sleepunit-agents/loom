/** One declaration drives registry metadata and the opt-in setup client. */
import { operation as defineOperation, type Operation, type CliCommand } from '../../core/index.js';
import type { z } from 'zod';
import type { venueSchema, routeSchema, linkSchema } from './model.js';
export interface BridgesInputs {
  status: { platform: 'discord' | 'slack' };
  putVenues: z.input<typeof venueSchema>;
  putRoutes: z.input<typeof routeSchema>;
  putLinks: z.input<typeof linkSchema>;
  removeVenues: { id: string };
  removeRoutes: { id: string };
  removeLinks: { id: string };
  dismissSend: { id: string; state: 'held' | 'uncertain' };
}
export const bridgeCommands: readonly CliCommand[] = [
  'putVenues', 'removeVenues', 'putRoutes', 'removeRoutes', 'putLinks', 'removeLinks', 'dismissSend',
].map(name => ({ name, write: true, positional: ['json'] })).concat([{ name: 'status', write: false, positional: ['json'] }]);
export function operation<I>(op: Operation<I>): Operation<I> {
  const cli = bridgeCommands.find(command => `bridges.${command.name}` === op.name);
  if (!cli || !!cli.write !== !!op.write) throw new Error('Bridges CLI metadata does not match operation');
  return defineOperation({ ...op, cli });
}
