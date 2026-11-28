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
import { claudeUsage, failedReport } from './harness-usage.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { filesUnfollowed, listUnfollowed } from './unfollowed.js';
import { HarnessExit, HarnessResumeUnavailable, SILENT_ENDING, SILENT_ENDING_LAST, harnessModel, harnessToolNames, harnessToolPrefix, harnessUnavailable, runHarnessChild, type BodyHarness, type Harness, type HarnessEnd, type HarnessSpawn } from './body-harness.js';
import { SESSION_ID } from '../core/conversations/session-limit.js';
import { bodyReach, deniedTools } from './harness-traits.js';
import { bodyDeniedTools } from './body-named-tools.js';
import { claudeEnding, claudeFailure, streamRows } from './harness-failure.js';
import type { FailureEnding } from './job-failure.js';

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
  const onFailedOutput=failedReport(claudeUsage,input.failedUsage);
  return async (job, words, signal, keep) => {
    if(control&&used)throw harnessUnavailable();used=true;
    if (signal.aborted || !harnessModel.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES){control?.fill(0);throw harnessUnavailable();}
    // With the named tools a denied generic tool takes with it, and old server names read as the present one.
    const denied = bodyDeniedTools(deniedTools(job.run?.policy));
    // The reach this job's body really has: loom's tools only on anybody else's word, whatever the machine gives (bodyReach).
    const reach = bodyReach(input.reach ?? 'loom', job.run?.policy);
    // The agent's own denials first, as written; then every built-in tool not among them.
    const withheld = [...new Set([...denied, ...(reach === 'all' ? input.omitClaudeTools ?? [] : claudeBuiltInTools)])];
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
    // What a failed run had printed, for reading why it failed (harness-failure.ts). Nothing when it printed too much.
    let printed: unknown[] = [], ending: FailureEnding | undefined, end: HarnessEnd = { exitCode: 0, signal: null, aborted: false, stderr: '' };
    try { output = await runHarnessChild({ command: input.command, args, cwd: input.cwd, env, words, signal, spawn: input.spawn, control,
      onFailedOutput: bytes => { printed = streamRows(bytes); ending = claudeEnding(bytes); onFailedOutput?.(bytes); }, onEnd: how => { end = how; },
      // Looked for across the join of two pieces of output too: a marker cut in half is still the model speaking.
      onOutput: chunk => { input.pairOutput?.(chunk); const seen = tail + chunk.toString('latin1'); if (seen.includes(SPOKE)) spoke = true; tail = seen.slice(-SPOKE.length); } }); }
    // A session that cannot be continued ends the program before the model is asked anything.
    catch (error) { throw resume && !spoke && !signal.aborted ? new HarnessResumeUnavailable() : error instanceof HarnessExit ? claudeFailure(printed, error.end, ending ?? claudeEnding(new Uint8Array(0))) : harnessUnavailable(); }
    // The step at which what it printed is refused, as one of a fixed list (job-failure.ts, ENDING_REFUSALS).
    let refusal: NonNullable<FailureEnding['refusal']> = 'decode';
    const refuse = (at: typeof refusal) => { refusal = at; return harnessUnavailable(); };
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
      refusal = 'line';
      const rows: unknown[] = decoded.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      // `last` is the model's last words of its own; `ended` is its last message of its own, with words or with none.
      let result: string | undefined, last: { text: string; model: string } | undefined, ended: { text: string; model: string } | undefined;
      const actions: { model: string }[] = [];
      for (const raw of rows) {
        refusal = 'event';
        if (!raw || typeof raw !== 'object') throw harnessUnavailable();
        const row = z.object({type:z.string(),session_id:z.string()}).passthrough().parse(raw);
        session ??= row.session_id;
        if (row.session_id !== session || !SESSION_ID.test(session)) throw refuse('session');
        if (row.type === 'assistant' && row.parent_tool_use_id === null && !row.error && !row.aborted && !row.agent_id) {
          refusal = 'message';
          const message = z.object({model:z.string().regex(harnessModel),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough())}).parse(row.message);
          const text = message.content.filter(part => part.type === 'text').map(part => {
            if (typeof part.text !== 'string') throw harnessUnavailable(); return part.text;
          }).join('');
          if (message.content.some(part => part.type === 'tool_use')) actions.push({ model: message.model });
          ended = { text, model: message.model };
          if (text) last = ended;
        }
        if (row.type === 'result') {
          // Claude Code prints a result each time it comes to rest, and goes on if something it left running in the
          // background reports back (seen 2026-11-28: three results in one run, the work continuing between them).
          // Each must be a success; the last is the run's.
          refusal = 'result';
          result = z.object({is_error:z.literal(false),subtype:z.literal('success'),result:z.string()}).parse(row).result;
        }
      }
      if (result === undefined) throw refuse('no-result');
      // A configured/requested/init model is never evidence of a response.
      if (!ended) throw refuse('no-message');
      const usage = claudeUsage(rows), kept = keep && session ? { session } : {};
      // The harness ended well and its result is empty: Claude Code takes the result from the last block of the
      // model's last message, so a last turn of no words (the model had said what it had to say before its final
      // tool calls, or only thought) is reported so. Having called tools, the work is done and is not failed for
      // that: the answer is loom's fixed line, then the model's last words of its own, if it said any.
      if (result === '') {
        if (ended.text) throw refuse('mismatch');
        if (!actions.length) throw refuse('empty');
        return { text: SILENT_ENDING + (last ? '\n\n' + SILENT_ENDING_LAST + '\n\n' + last.text : ''), model: ended.model, actions, usage, ...kept };
      }
      if (!last || result !== last.text) throw refuse('mismatch');
      return { ...last, actions, usage, ...kept };
    // It ended well and what it printed is no answer loom can vouch for: an error it reported, or nothing readable.
    } catch { onFailedOutput?.(output);throw signal.aborted ? harnessUnavailable() : claudeFailure(streamRows(output), end, { ...claudeEnding(output), refusal }); }
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
