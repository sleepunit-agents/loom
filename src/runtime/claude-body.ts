/** Claude Code as a body's harness: `claude -p` with stream-json out.
 *
 * What differs from the others, and why:
 * - Claude Code reads its tools file from a path, so the file goes in on file descriptor 3 (see
 *   runHarnessChild): the tools endpoint's bearer is in no argument, environment variable or file.
 * - It can be held to loom's tools only, and it honours the tools a body is not given, so it runs on any
 *   machine and for any job.
 * - Its events name the model that answered. The reply carries that model, never the one asked for.
 * No Root credential enters argv, environment or model input. The outer worker owns the process group,
 * including this child. */
import {BODY_INPUT_BYTES} from './body-input-limit.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HarnessResumeUnavailable, harnessModel, harnessToolNames, harnessToolPrefix, harnessUnavailable, runHarnessChild, type BodyHarness, type Harness, type HarnessSpawn } from './body-harness.js';
import { SESSION_ID } from '../core/conversations/session-limit.js';
import { deniedTools } from './harness-traits.js';

/** The spawn seam a test supplies; the same one every harness takes. */
export type ClaudeSpawn = HarnessSpawn;
/** What the adapter sets in the child's environment when the body has tools, unless the machine's body file
 * already set it. The one list: `claude.reservesEnv` reserves every name here, so a startup secret can
 * take none of them, whatever its prefix. */
export const claudeToolSettings: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0', MAX_MCP_OUTPUT_TOKENS: '100000', MCP_TOOL_TIMEOUT: '86400000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '86400000',
});
export const claudeBody: BodyHarness = input => {
  const env = { ...input.env };
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(env), ...Object.values(env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw harnessUnavailable();
  const control=input.mcpConfig?Buffer.from(input.mcpConfig):undefined;let used=false;
  if(control&&(control.byteLength<1||control.byteLength>65536)){control.fill(0);throw harnessUnavailable();}
  const allowed=[...(input.mcpTools??['request_secret','use_secret'].map(name=>harnessToolPrefix+name))];
  try{if(input.mcpTools&&!control)throw harnessUnavailable();harnessToolNames(allowed);}catch(error){control?.fill(0);throw error;}
  if(control)for(const [name,value] of Object.entries(claudeToolSettings))env[name]??=value;
  return async (job, words, signal, keep) => {
    if(control&&used)throw harnessUnavailable();used=true;
    if (signal.aborted || !harnessModel.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES){control?.fill(0);throw harnessUnavailable();}
    const denied = deniedTools(job.run?.policy);
    if (denied.some(pattern => !pattern.trim() || pattern.trim().startsWith('-') || /[\0\r\n]/.test(pattern))){control?.fill(0);throw harnessUnavailable();}
    // Asked to keep a session, Claude Code writes its transcript under its own directory (sessionFiles below)
    // and can continue one by id. Otherwise nothing is written, as before. A continued session keeps its id
    // unless the program gives it another; either way the id every event carries is the one reported.
    const resume = keep?.resume;
    if (resume !== undefined && !SESSION_ID.test(resume)) { control?.fill(0); throw harnessUnavailable(); }
    let session: string | undefined = resume ? undefined : randomUUID(), spoke = false;
    const args = ['-p', '--model', job.model, ...(resume ? ['--resume', resume] : ['--session-id', session!]),
      '--output-format', 'stream-json', '--verbose', ...(keep ? [] : ['--no-session-persistence']),
      // With full reach nothing asks and nothing is listed: everything is allowed except what is denied below.
      '--permission-mode', input.reach==='all'?'bypassPermissions':'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', control?'/dev/fd/3':'{"mcpServers":{}}',
      ...(control&&input.reach!=='all'?['--allowedTools',...allowed]:[]),
      ...(denied.length ? ['--disallowedTools', ...denied] : [])];
    let output: Buffer;
    try { output = await runHarnessChild({ command: input.command, args, cwd: input.cwd, env, words, signal, spawn: input.spawn, control,
      onOutput: chunk => { if (chunk.includes('"type":"assistant"')) spoke = true; } }); }
    // A session that cannot be continued ends the program before the model is asked anything.
    catch { throw resume && !spoke && !signal.aborted ? new HarnessResumeUnavailable() : harnessUnavailable(); }
    try {
      const rows: unknown[] = new TextDecoder('utf-8', { fatal: true }).decode(output).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      let result: string | undefined, last: { text: string; model: string } | undefined;
      const actions: { model: string }[] = [];
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') throw harnessUnavailable();
        const row = z.object({type:z.string(),session_id:z.string()}).passthrough().parse(raw);
        session ??= row.session_id;
        if (row.session_id !== session || !SESSION_ID.test(session)) throw harnessUnavailable();
        if (row.type === 'assistant' && row.parent_tool_use_id === null && !row.error && !row.aborted && !row.agent_id) {
          const message = z.object({model:z.string().regex(harnessModel),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough())}).parse(row.message);
          const text = message.content.filter(part => part.type === 'text').map(part => {
            if (typeof part.text !== 'string') throw harnessUnavailable(); return part.text;
          }).join('');
          if (message.content.some(part => part.type === 'tool_use')) actions.push({ model: message.model });
          if (text) last = { text, model: message.model };
        }
        if (row.type === 'result') {
          if (result !== undefined) throw harnessUnavailable();
          result = z.object({is_error:z.literal(false),subtype:z.literal('success'),result:z.string()}).parse(row).result;
        }
      }
      // A configured/requested/init model is never evidence of a response.
      if (!last || result !== last.text) throw harnessUnavailable();
      return { ...last, actions, ...(keep && session ? { session } : {}) };
    } catch { throw harnessUnavailable(); }
    finally { output.fill(0); }
  };
};
/** Claude Code keeps a session as `projects/<the working directory, slugged>/<session>.jsonl` under its own
 * directory, with the larger tool results in a directory of the same name beside it. */
function claudeSessionFiles(env: Readonly<Record<string, string | undefined>>, session: string): { root: string; files: string[] } {
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), files: string[] = [];
  if (!SESSION_ID.test(session)) return { root, files };
  const walk = (rel: string) => {
    // A link is never followed: only the harness's own files and directories are a session's.
    let stat; try { stat = lstatSync(join(root, rel)); } catch { return; }
    if (stat.isFile()) files.push(rel);
    else if (stat.isDirectory()) for (const name of readdirSync(join(root, rel)).sort()) walk(join(rel, name));
  };
  let projects: string[] = []; try { projects = readdirSync(join(root, 'projects')).sort(); } catch { /* none kept */ }
  for (const project of projects) for (const name of [`${session}.jsonl`, session]) walk(join('projects', project, name));
  return { root, files };
}
export const claude: Harness = { needsFullReach: false, honoursDeniedTools: true, run: claudeBody, sessionFiles: claudeSessionFiles,
  // Claude Code on a cloud provider signs in with that provider's own variables.
  reservesEnv: (name, env) => /^(?:CLAUDE_|ANTHROPIC_)/.test(name) || Object.hasOwn(claudeToolSettings, name)
    || !!env.CLAUDE_CODE_USE_BEDROCK && /^AWS_/.test(name)
    || !!env.CLAUDE_CODE_USE_VERTEX && /^(?:GOOGLE_|GCLOUD_)/.test(name)
    || !!env.CLAUDE_CODE_USE_FOUNDRY && /^AZURE_/.test(name) };
