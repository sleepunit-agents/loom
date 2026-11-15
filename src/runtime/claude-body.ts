/** Worker-child native adapter. No Root credential enters argv, environment or
 * model input. The outer worker owns the process group, including this child. */
import { z } from 'zod';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkerAssignment } from './worker.js';

export type ClaudeSpawn = (command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: false; stdio: 'pipe';
}) => ChildProcessWithoutNullStreams;
export interface ClaudeReply { text: string; model: string; actions: { model: string }[] }
const limit = 1_048_576;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const unavailable = () => new Error('Native Claude execution unavailable');
export function claudeBody(input: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; spawn?: ClaudeSpawn;
}) {
  const env = { ...input.env };
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(env), ...Object.values(env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw unavailable();
  return async (job: WorkerAssignment, words: string, signal: AbortSignal): Promise<ClaudeReply> => {
    if (signal.aborted || job.harness !== 'claude' || !modelPattern.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > limit) throw unavailable();
    const guest = job.run?.policy?.people.some(person => person.kind !== 'person' && person.tier !== 3) ?? false;
    const denied = [...new Set((job.run?.policy?.deniedTools ?? []).filter(rule => !rule.guestsOnly || guest).map(rule => rule.pattern))];
    if (denied.some(pattern => !pattern.trim() || pattern.trim().startsWith('-') || /[\0\r\n]/.test(pattern))) throw unavailable();
    const session = randomUUID();
    const args = ['-p', '--model', job.model, '--session-id', session,
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      ...(denied.length ? ['--disallowedTools', ...denied] : [])];
    let child: ChildProcessWithoutNullStreams;
    try { child = (input.spawn ?? spawn)(input.command, args, { cwd: input.cwd, env: { ...env }, shell: false, detached: false, stdio: 'pipe' }); }
    catch { throw unavailable(); }
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { failed = true; for (const chunk of chunks) chunk.fill(0); chunks.length = 0; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => { stop(); reject(unavailable()); });
        // A native leader may leave a descendant holding inherited pipes. End
        // this child so the outer worker can reap its entire owned group.
        child.once('exit', () => { drain = setTimeout(stop, 1_000); });
        child.once('close', code => code === 0 && !failed && !signal.aborted ? resolve() : reject(unavailable()));
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', stop);
        child.stdout.on('data', (data: Buffer | string) => {
          const chunk = Buffer.from(data);
          if (Buffer.isBuffer(data)) data.fill(0);
          if (failed) { chunk.fill(0); return; }
          bytes += chunk.length;
          if (bytes > limit) { chunk.fill(0); stop(); } else chunks.push(chunk);
        });
        // Drain diagnostics; never retain or forward private native output.
        child.stderr.on('data', (data: Buffer | string) => { bytes += Buffer.byteLength(data); if (Buffer.isBuffer(data)) data.fill(0); if (bytes > limit && !failed) stop(); });
        if (!failed) child.stdin.end(words);
      });
      if (signal.aborted) throw unavailable();
      const joined = Buffer.concat(chunks);
      try {
        const rows: unknown[] = new TextDecoder('utf-8', { fatal: true }).decode(joined).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        let result: string | undefined, last: { text: string; model: string } | undefined;
        const actions: { model: string }[] = [];
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object') throw unavailable();
          const row = z.object({type:z.string(),session_id:z.string()}).passthrough().parse(raw);
          if (row.session_id !== session) throw unavailable();
          if (row.type === 'assistant' && row.parent_tool_use_id === null && !row.error && !row.aborted && !row.agent_id) {
            const message = z.object({model:z.string().regex(modelPattern),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough())}).parse(row.message);
            const text = message.content.filter(part => part.type === 'text').map(part => {
              if (typeof part.text !== 'string') throw unavailable(); return part.text;
            }).join('');
            if (message.content.some(part => part.type === 'tool_use')) actions.push({ model: message.model });
            if (text) last = { text, model: message.model };
          }
          if (row.type === 'result') {
            if (result !== undefined) throw unavailable();
            result = z.object({is_error:z.literal(false),subtype:z.literal('success'),result:z.string()}).parse(row).result;
          }
        }
        // A configured/requested/init model is never evidence of a response.
        if (!last || result !== last.text) throw unavailable();
        return { ...last, actions };
      } finally { joined.fill(0); }
    } catch { throw unavailable(); }
    finally { if (drain) clearTimeout(drain); signal.removeEventListener('abort', stop); for (const chunk of chunks) chunk.fill(0); }
  };
}
