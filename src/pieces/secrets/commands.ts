/** Shared declarative CLI binding. No client-side policy or store access. */
import type { CliCommand } from '../../core/index.js';
export interface SecretCommand extends CliCommand { operation: string; booleanFlags?: string[] }
export const secretCommands: SecretCommand[] = [
  { name: 'list', operation: 'command', flags: { json: 'json' }, booleanFlags: ['json'] },
  { name: 'may', operation: 'command', positional: ['agent', 'name'], flags: { json: 'json' }, booleanFlags: ['json'] },
  { name: 'state', operation: 'command', positional: ['id'] },
  { name: 'policy', operation: 'startup', write: true, positional: ['action', 'name', 'agent'], flags: { off: 'off' }, booleanFlags: ['off'] },
  { name: 'add', operation: 'set', write: true, positional: ['name'] },
  { name: 'replace', operation: 'set', write: true, positional: ['name'] },
  { name: 'rm', operation: 'remove', write: true, positional: ['name'] },
];
