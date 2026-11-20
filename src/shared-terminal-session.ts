import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import type { WordsKey } from './core/conversations/words.js';
import { TerminalSessions } from './core/conversations/terminal-sessions.js';
import { OperationError, type Operations } from './core/operations/index.js';
import type { Viewer } from './policy.js';
import { terminalEvent } from './shared-terminal-input.js';

type Scope = { agent: string; member: string; machine: string };
export function registerTerminalSession(operations: Operations, db: DataDatabase, key: WordsKey,
  scope: (viewer: Viewer) => Scope | undefined, now: () => string) {
  const sessions = new TerminalSessions(db, key, now);
  operations.register({
    name: 'terminal.session', write: true, doors: ['http'], recheckPolicy: true, input: terminalEvent,
    output: z.object({ conversation: z.string(), thread: z.string(), job: z.string() }).strict(),
    may: (viewer, input) => scope(viewer)?.machine === input.machine,
    inputHash: (canonical, { actor }) => key.hash(JSON.stringify(['terminal.session',scope(actor),canonical])),
    async prepare(input, {viewer}) {
      const identity = scope(viewer);
      if (!identity || identity.machine !== input.machine) throw new OperationError('denied', 'Machine terminal required');
      return { identity, commit: await sessions.prepare(identity, input) };
    },
    run(ctx, input, prepared) {
      const current = scope(ctx.viewer);
      const { identity, commit } = prepared as { identity: Scope; commit: Awaited<ReturnType<TerminalSessions['prepare']>> };
      if (!current || current.machine !== input.machine || current.member !== identity.member || current.agent !== identity.agent)
        throw new OperationError('denied', 'Machine terminal changed');
      let stampOnly = false;
      const result = commit(() => { stampOnly = true; });
      if (stampOnly) {
        ctx.stampOnly?.();
        return result;
      }
      ctx.changed('conversations', result.conversation);
      ctx.changed('threads', result.thread);
      ctx.changed('job', result.job);
      return result;
    },
  });
}
