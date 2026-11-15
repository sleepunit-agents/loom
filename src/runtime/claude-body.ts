/** Worker-child native adapter. No Root credential enters argv, environment or
 * model input. The outer worker owns the process group, including this child. */
import {BODY_INPUT_BYTES} from './body-input-limit.js';
import { z } from 'zod';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { WorkerAssignment } from './worker.js';

export type ClaudeSpawn = (command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: false; stdio: 'pipe' | ['pipe','pipe','pipe','pipe'];
}) => ChildProcessWithoutNullStreams;
export interface ClaudeReply { text: string; model: string; actions: { model: string }[] }
const limit = 1_048_576;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const unavailable = () => new Error('Native Claude execution unavailable');
export function claudeBody(input: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; spawn?: ClaudeSpawn; mcpConfig?: Uint8Array; mcpTools?:readonly string[];
}) {
  const env = { ...input.env };
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(env), ...Object.values(env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw unavailable();
  const control=input.mcpConfig?Buffer.from(input.mcpConfig):undefined;let used=false;
  if(control&&(control.byteLength<1||control.byteLength>65536)){control.fill(0);throw unavailable();}
  const allowed=[...(input.mcpTools??['mcp__loom_secrets__request_secret','mcp__loom_secrets__use_secret'])];
  if(input.mcpTools&&!control||allowed.length>34||new Set(allowed).size!==allowed.length||allowed.some(name=>typeof name!=='string'||!/^mcp__loom_secrets__[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))){control?.fill(0);throw unavailable();}
  if(control){env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS??='0';env.MAX_MCP_OUTPUT_TOKENS??='100000';env.MCP_TOOL_TIMEOUT??='86400000';env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT??='86400000';}
  return async (job: WorkerAssignment, words: string, signal: AbortSignal): Promise<ClaudeReply> => {
    if(control&&used)throw unavailable();used=true;
    if (signal.aborted || job.harness !== 'claude' || !modelPattern.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES){control?.fill(0);throw unavailable();}
    const guest = job.run?.policy?.people.some(person => person.kind !== 'person' && person.tier !== 3) ?? false;
    const denied = [...new Set((job.run?.policy?.deniedTools ?? []).filter(rule => !rule.guestsOnly || guest).map(rule => rule.pattern))];
    if (denied.some(pattern => !pattern.trim() || pattern.trim().startsWith('-') || /[\0\r\n]/.test(pattern))){control?.fill(0);throw unavailable();}
    const session = randomUUID();
    const args = ['-p', '--model', job.model, '--session-id', session,
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', control?'/dev/fd/3':'{"mcpServers":{}}',
      ...(control?['--allowedTools',...allowed]:[]),
      ...(denied.length ? ['--disallowedTools', ...denied] : [])];
    let child: ChildProcessWithoutNullStreams;
    // Node extra pipes are Unix sockets, which cannot be reopened as /dev/fd/3.
    // Bash converts that socket to an anonymous kernel pipe before exec; no
    // credential is put in argv, environment or a filesystem entry. -p ignores
    // BASH_ENV and imported shell functions; absolute cat avoids PATH lookup.
    const executable=control?'/bin/bash':input.command;
    const launchArgs=control?['--noprofile','--norc','-p','-c','exec 3< <(/bin/cat <&3); exec "$@"','loom-native',input.command,...args]:args;
    try { child = (input.spawn ?? spawn)(executable, launchArgs, { cwd: input.cwd, env: { ...env }, shell: false, detached: false, stdio: control?['pipe','pipe','pipe','pipe']:'pipe' }); }
    catch { control?.fill(0);throw unavailable(); }
    const pipe=control?child.stdio?.[3] as Writable|undefined:undefined;
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { failed = true;control?.fill(0);pipe?.destroy(); for (const chunk of chunks) chunk.fill(0); chunks.length = 0; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => { stop(); reject(unavailable()); });
        // A native leader may leave a descendant holding inherited pipes. End
        // this child so the outer worker can reap its entire owned group.
        child.once('exit', () => { drain = setTimeout(stop, 1_000); });
        child.once('close', code => code === 0 && !failed && !signal.aborted ? resolve() : reject(unavailable()));
        for (const stream of [child.stdin, child.stdout, child.stderr,...(pipe?[pipe]:[])]) stream.on('error', stop);
        child.stdout.on('data', (data: Buffer | string) => {
          const chunk = Buffer.from(data);
          if (Buffer.isBuffer(data)) data.fill(0);
          if (failed) { chunk.fill(0); return; }
          bytes += chunk.length;
          if (bytes > limit) { chunk.fill(0); stop(); } else chunks.push(chunk);
        });
        // Drain diagnostics; never retain or forward private native output.
        child.stderr.on('data', (data: Buffer | string) => { bytes += Buffer.byteLength(data); if (Buffer.isBuffer(data)) data.fill(0); if (bytes > limit && !failed) stop(); });
        if(control){if(!pipe||typeof pipe.end!=='function'){stop();reject(unavailable());return;}pipe.end(control,()=>control.fill(0));}
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
    finally { control?.fill(0);pipe?.destroy();if (drain) clearTimeout(drain); signal.removeEventListener('abort', stop); for (const chunk of chunks) chunk.fill(0); }
  };
}
