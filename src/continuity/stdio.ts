/** Explicit next-side stdio composition. Never selected by file discovery. */
import { parseArgs } from 'node:util';
import type { LoomServerConfig } from '../server.js';
import { continuityTarget } from './household.js';

export function isNextStdioInvocation(args: string[]): boolean {
  return args[0] === '--next' || (args[0] === 'mcp' && args.includes('--next'));
}

/** Flags select the target; legacy process-wide backend/identity overrides do not. */
export function nextStdioConfig(args: string[]): LoomServerConfig {
  const { values } = parseArgs({
    args: args[0] === 'mcp' ? args.slice(1) : args,
    options: {
      next: { type: 'boolean' }, home: { type: 'string' },
      agent: { type: 'string' }, 'context-dir': { type: 'string' },
    },
    strict: true, allowPositionals: false,
  });
  if (!values.next) throw new Error('next stdio requires --next');
  const { contextDir, metadata } = continuityTarget({
    home: values.home, agent: values.agent, contextDir: values['context-dir'],
  });
  return {
    contextDir,
    memorySelection: metadata === null ? null : { agent: metadata.agent },
    peopleSelection: metadata,
    knowledgeSelection: metadata,
    conversationSelection: metadata,
  };
}
