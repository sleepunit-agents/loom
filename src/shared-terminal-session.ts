import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import type { WordsKey } from './core/conversations/words.js';
import { TerminalSessions } from './core/conversations/terminal-sessions.js';
import { OperationError, type Operations } from './core/operations/index.js';
import type { Viewer } from './policy.js';
import { terminalEvent } from './shared-terminal-input.js';

type Scope = { agent: string; member: string; machine: string };
export function registerTerminalSession(operations: Operations, db: DataDatabase, key: WordsKey,
  scope: (viewer: Viewer) => Scope | undefined, now: () => string,
  /** The wakes waiting for this session, closed as taken by it (shared-wake.ts, takeTerminalWakes). */
  wakes?: (conversation: string, job: string) => { id: string; at: string; words: string }[]) {
  const sessions = new TerminalSessions(db, key, now);
  operations.register({
    name: 'terminal.session', write: true, doors: ['http'], recheckPolicy: true, input: terminalEvent,
    /** `wakes`: what loom has to tell this session, oldest first, for the hook to show its agent at this turn
     * boundary. Present only on a report that asked (`wakes: true`) for a session still open, and each is handed
     * once: a retry of the same report is answered from its receipt with the same ones. */
    output: z.object({ conversation: z.string(), thread: z.string(), job: z.string(),
      wakes: z.array(z.object({ id: z.string(), at: z.string(), words: z.string() }).strict()).optional() }).strict(),
    may: (viewer, input) => scope(viewer)?.machine === input.machine,
    inputHash: (canonical, { actor }) => key.hash(JSON.stringify(['terminal.session',scope(actor),canonical])),
    async prepare(input, {viewer}) {
      const identity = scope(viewer);
      if (!identity || identity.machine !== input.machine) throw new OperationError('denied', 'Machine terminal required');
      return { identity, commit: await sessions.prepare(identity, input) };
    },
    run(ctx, input, prepared) {
      const current = scope(ctx.viewer);
      const { identity, commit } = prepared as { identity: Scope; commit: () => {conversation:string;thread:string;job:string;accepted?:true} };
      if (!current || current.machine !== input.machine || current.member !== identity.member || current.agent !== identity.agent)
        throw new OperationError('denied', 'Machine terminal changed');
      const { accepted, ...result } = commit();
      ctx.changed('conversations', result.conversation);
      ctx.changed('threads', result.thread);
      ctx.changed('job', result.job);
      // The return path to a live terminal session: a report the session took as its current instance's (it opened
      // it, carried a new turn or was its heartbeat, and moved its last-heard time) is answered with the wakes
      // waiting for it. A report from an instance that has been superseded, a repeated turn, a usage report and
      // one that ends the session are handed none and close none: `accepted` is the session's own word on that.
      const handed = wakes && input.wakes && accepted ? wakes(result.conversation, result.job) : [];
      for (const item of handed) ctx.changed('inbox', item.id);
      return handed.length ? { ...result, wakes: handed } : result;
    },
  });
}
