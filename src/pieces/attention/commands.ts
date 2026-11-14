/** The same declarations drive operation CLI metadata and the opt-in client. */
import { operation as defineOperation, type Operation, type CliCommand } from '../../core/index.js';
export const attentionCommands: CliCommand[] = [
  ...['readOutcome', 'markRead', 'checkWait', 'raise', 'answer', 'resolve', 'reportStatus', 'recordTurn', 'writeDigest', 'fold', 'retain', 'writeFinding'].map(name => ({ name, write: true, positional: ['json'] })),
  ...['outcomes', 'pendingWaits', 'get', 'conversation', 'conversations', 'turns', 'digests', 'days', 'stats', 'findings'].map(name => ({ name, positional: ['json'] })),
];
export function operation<I>(op: Operation<I>): Operation<I> {
  const cli = attentionCommands.find(command => `attention.${command.name}` === op.name);
  if (!cli || !!cli.write !== !!op.write) throw new Error('Attention CLI metadata does not match operation');
  return defineOperation({ ...op, cli });
}
