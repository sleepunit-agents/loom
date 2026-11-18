/** Claude Code as a body's harness: `claude -p` with stream-json out.
 *
 * What differs from the others, and why:
 * - Claude Code reads its tools file from a path, so the file goes in on file descriptor 3 (see
 *   runHarnessChild): the tools endpoint's bearer is in no argument, environment variable or file.
 * - It can be held to loom's tools only, and it honours the tools a body is not given, so it runs on any
 *   machine and for any job. A job on anybody else's word is held so on every machine (harness-traits.ts,
 *   bodyReach): no built-in tool (`--tools ""`, and each denied by name), permission mode `dontAsk` with
 *   loom's tools listed, where a job for owners on a machine of full reach runs with `bypassPermissions`.
 * - Its events name the model that answered. The reply carries that model, never the one asked for.
 * No Root credential enters argv, environment or model input. The outer worker owns the process group,
 * including this child. */
import {BODY_INPUT_BYTES} from './body-input-limit.js';
import { claudeUsage } from './harness-usage.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { filesUnfollowed, listUnfollowed } from './unfollowed.js';
import { HarnessResumeUnavailable, harnessModel, harnessToolNames, harnessToolPrefix, harnessUnavailable, runHarnessChild, type BodyHarness, type Harness, type HarnessSpawn } from './body-harness.js';
import { SESSION_ID } from '../core/conversations/session-limit.js';
import { bodyReach, deniedTools } from './harness-traits.js';
import { bodyDeniedTools } from './body-named-tools.js';

/** What marks an event of the model's own in the harness's output. */
const SPOKE = '"type":"assistant"';
/** The spawn seam a test supplies; the same one every harness takes. */
export type ClaudeSpawn = HarnessSpawn;
/** What the adapter sets in the child's environment when the body has tools, unless the machine's body file
 * already set it. The one list: `claude.reservesEnv` reserves every name here, so a startup secret can
 * take none of them, whatever its prefix. */
export const claudeToolSettings: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0', MAX_MCP_OUTPUT_TOKENS: '100000', MCP_TOOL_TIMEOUT: '86400000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '86400000',
});
/** Every built-in tool of Claude Code, by the name it is denied by: what a body held to loom's tools is
 * refused one by one, beside being given none at all (`--tools ""`). The second layer, in case a later
 * version changes what `--tools` means. Read from what 2.1.326 lists at start, with the names its documents
 * and earlier versions use for the same things; a name a version does not know denies nothing. The two
 * tools that read what a tools server offers (ListMcpResourcesTool, ReadMcpResourceTool) are not here:
 * they reach loom's own server and nothing else. scripts/check-claude-floor.mjs checks the floor against
 * the real program. */
export const claudeBuiltInTools: readonly string[] = Object.freeze([
  'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EnterPlanMode', 'EnterWorktree',
  'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'KillBash', 'KillShell', 'LS', 'LSP', 'ListAgents', 'Monitor', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'SlashCommand', 'Task', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
]);
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
    // With the named tools a denied generic tool takes with it, and old server names read as the present one.
    const denied = bodyDeniedTools(deniedTools(job.run?.policy));
    // The reach this job's body really has: loom's tools only on anybody else's word, whatever the machine gives (bodyReach).
    const reach = bodyReach(input.reach ?? 'loom', job.run?.policy);
    // The agent's own denials first, as written; then every built-in tool not among them.
    const withheld = reach === 'all' ? denied : [...new Set([...denied, ...claudeBuiltInTools])];
    if (denied.some(pattern => !pattern.trim() || pattern.trim().startsWith('-') || /[\0\r\n]/.test(pattern))){control?.fill(0);throw harnessUnavailable();}
    // Asked to keep a session, Claude Code writes its transcript under its own directory (sessionFiles below)
    // and can continue one by id. Otherwise nothing is written, as before. A continued session keeps its id
    // unless the program gives it another; either way the id every event carries is the one reported.
    const resume = keep?.resume;
    if (resume !== undefined && !SESSION_ID.test(resume)) { control?.fill(0); throw harnessUnavailable(); }
    let session: string | undefined = resume ? undefined : randomUUID(), spoke = false, tail = '';
    const args = ['-p', '--model', job.model, ...(resume ? ['--resume', resume] : ['--session-id', session!]),
      '--output-format', 'stream-json', '--verbose', ...(keep ? [] : ['--no-session-persistence']),
      // With full reach nothing asks and nothing is listed: everything is allowed except what is denied below.
      // Held to loom's tools, nothing is allowed that is not listed: no shell, no files, no web, no helpers.
      // `dontAsk` with an allow list does not do that alone: the real program still runs read-only shell
      // commands, reads files and starts subagents. So it is given no built-in tool at all (`--tools ""`),
      // and each is denied by name below as well.
      '--permission-mode', reach==='all'?'bypassPermissions':'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', control?'/dev/fd/3':'{"mcpServers":{}}',
      ...(reach!=='all'?['--tools','']:[]),
      ...(control&&reach!=='all'?['--allowedTools',...allowed]:[]),
      ...(withheld.length ? ['--disallowedTools', ...withheld] : [])];
    let output: Buffer;
    try { output = await runHarnessChild({ command: input.command, args, cwd: input.cwd, env, words, signal, spawn: input.spawn, control,
      // Looked for across the join of two pieces of output too: a marker cut in half is still the model speaking.
      onOutput: chunk => { const seen = tail + chunk.toString('latin1'); if (seen.includes(SPOKE)) spoke = true; tail = seen.slice(-SPOKE.length); } }); }
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
      return { ...last, actions, usage: claudeUsage(rows), ...(keep && session ? { session } : {}) };
    } catch { throw harnessUnavailable(); }
    finally { output.fill(0); }
  };
};
/** Where Claude Code keeps a session, said here and nowhere else: under its own directory
 * (`CLAUDE_CONFIG_DIR`, or `.claude` in the home), `projects/<the working directory, slugged>/<session>.jsonl`
 * is the transcript, and a directory of the same name beside it holds the larger tool results. */
const SESSION_FILES_FOUND = 256;
const claudeSessions: NonNullable<Harness['sessions']> = {
  root: env => env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'),
  owns(relative, session) {
    if (!SESSION_ID.test(session) || normalize(relative) !== relative || relative.includes('\0')) return false;
    const parts = relative.split(sep);
    return parts.length >= 3 && parts[0] === 'projects' && !parts.includes('..') && !parts.includes('.') && !parts.includes('')
      && (parts.length === 3 ? parts[2] === `${session}.jsonl` : parts[2] === session);
  },
  files(root, session) {
    if (!SESSION_ID.test(session)) return [];
    // Every step is looked at as it is: a `projects`, a project directory or anything below that is a link is passed over.
    return listUnfollowed(root, 'projects').flatMap(project => [`${session}.jsonl`, session].flatMap(name => filesUnfollowed(root, join('projects', project, name), SESSION_FILES_FOUND)));
  },
};
export const claude: Harness = { needsFullReach: false, honoursDeniedTools: true, run: claudeBody, sessions: claudeSessions,
  // Claude Code on a cloud provider signs in with that provider's own variables.
  reservesEnv: (name, env) => /^(?:CLAUDE_|ANTHROPIC_)/.test(name) || Object.hasOwn(claudeToolSettings, name)
    || !!env.CLAUDE_CODE_USE_BEDROCK && /^AWS_/.test(name)
    || !!env.CLAUDE_CODE_USE_VERTEX && /^(?:GOOGLE_|GCLOUD_)/.test(name)
    || !!env.CLAUDE_CODE_USE_FOUNDRY && /^AZURE_/.test(name) };
