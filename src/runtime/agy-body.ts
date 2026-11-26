/** Gemini as a body's harness, through the Antigravity CLI: `agy -p` with stream-json in and out.
 *
 * What differs from the others, and why:
 * - agy reads its tool servers only from a file in its workspace. Each body therefore gets its own private
 *   temporary workspace holding `.agents/mcp_config.json`, and the directory the machine names for bodies is
 *   added to it with --add-dir. The file holds the short-lived bearer of this body's own loopback tools
 *   server. It is mode 0600 in a 0700 directory, so only this user's processes can read it: that includes
 *   whatever the model's own shell runs, which could call the same tools anyway, for as long as the body
 *   lives (docs/accepted-tradeoffs.md, "The body-tools bearer is readable by the body's own user"). The
 *   workspace is made inside the body's scratch directory and nowhere else. The worker removes that
 *   directory after the body's process group is gone, and a worker that starts removes the ones a killed
 *   worker left (worker-left.ts), so the file outlives neither a killed body nor a killed worker. A
 *   container body's scratch directory is the container's own and goes with the container.
 * - The words go in on stdin as one stream-json line, so they are in no argument.
 * - agy has no switch to leave a conversation unsaved. What it wrote for this conversation is removed
 *   afterwards, as far as its files are known; that is best effort, not a promise. The conversation's id is
 *   noted in the scratch directory as soon as agy prints it, so the worker can do the same for a killed body.
 * - Like Codex it always has its shell, so it runs only where the machine gives bodies full reach, and not
 *   for a body with denied tools. (agy has allow and deny rules of its own; honouring loom's with them is
 *   not done yet.)
 * - The model is the one agy reports it started with, which must be the one the job asked for.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyUsage, failedReport } from './harness-usage.js';
import { z } from 'zod';
import { BODY_INPUT_BYTES } from './body-input-limit.js';
import { BODY_SCRATCH, BODY_TOOLS_SERVER, harnessModel, harnessToolNames, harnessTools, harnessUnavailable, runHarnessChild, type BodyHarness, type Harness } from './body-harness.js';

const conversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const row = z.object({ event: z.string() }).passthrough();
const init = z.object({ conversation_id: z.string(), init: z.object({ model: z.string().optional() }).passthrough() }).passthrough();
const step = z.object({ step_update: z.object({ state: z.string(), step_type: z.string() }).passthrough() }).passthrough();
const result = z.object({ result: z.object({ status: z.string(), response: z.string().optional() }).passthrough() }).passthrough();
const noteFile = 'agy-conversation';

/** Remove what agy saved for one conversation under the account's home, as far as its files are known. */
function forget(home: string | undefined, conversation: string) {
  if (!home || !conversationId.test(conversation)) return;
  for (const left of [join('brain', conversation), join('conversations', conversation + '.db')])
    try { rmSync(join(home, '.gemini', 'antigravity-cli', left), { recursive: true, force: true }); } catch { /* best effort */ }
}
/** For the worker, after a body's process group is gone: forget the conversation a killed body had noted. */
export function agyLeftovers(scratch: string, env: Readonly<Record<string, string | undefined>>): void {
  let noted: string;
  try { noted = readFileSync(join(scratch, noteFile), 'utf8').trim(); } catch { return; }
  forget(env.HOME, noted);
}

export const agyBody: BodyHarness = input => {
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(input.env), ...Object.values(input.env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw harnessUnavailable();
  const tools = harnessTools(input.mcpConfig);
  if (input.mcpTools && !tools) throw harnessUnavailable();
  const names = harnessToolNames(input.mcpTools ?? []);
  let used = false;
  const onFailedOutput=failedReport(agyUsage,input.failedUsage);
  return async (job, words, signal) => {
    if (tools && used) throw harnessUnavailable(); used = true;
    if (signal.aborted || !harnessModel.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES) throw harnessUnavailable();
    let workspace: string | undefined, conversation: string | undefined;
    const scratch = input.env[BODY_SCRATCH];
    // The first line agy prints names its conversation. Note it at once: if this body is killed, the worker reads the note.
    let head = '', noted = false;
    const note = (chunk: Buffer) => {
      if (noted || !scratch) return;
      head += chunk.toString('latin1');
      const id = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/.exec(head)?.[1];
      if (id && conversationId.test(id)) try { writeFileSync(join(scratch, noteFile), id, { mode: 0o600 }); } catch { /* then only a body that ends by itself is tidied */ }
      if (id || head.length > 65_536) { noted = true; head = ''; }
    };
    try {
      // The tools file holds a bearer, so it is only ever written inside the scratch directory the worker
      // named: that is what the worker removes after the body, also for a body or a worker that was killed.
      if (tools && !scratch) throw harnessUnavailable();
      workspace = mkdtempSync(join(scratch || tmpdir(), 'loom-body-'));
      if (tools) {
        mkdirSync(join(workspace, '.agents'), { mode: 0o700 });
        writeFileSync(join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { [BODY_TOOLS_SERVER]: {
          serverUrl: tools.url, headers: { Authorization: tools.authorization }, enabledTools: names } } }), { mode: 0o600 });
      }
      const args = ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', job.model,
        '--dangerously-skip-permissions', '--add-dir', input.cwd];
      const line = JSON.stringify({ event: 'user', message: { content: words } }) + '\n';
      const output = await runHarnessChild({ command: input.command, args, cwd: workspace, env: input.env, words: line, signal, spawn: input.spawn, onFailedOutput, onOutput: chunk=>{note(chunk);input.pairOutput?.(chunk);} });
      try {
        const rows = new TextDecoder('utf-8', { fatal: true }).decode(output).split(/\r?\n/).filter(text => text.trim()).map(text => row.parse(JSON.parse(text)));
        let started = 0, finished = 0, model: string | undefined, text: string | undefined;
        const actions: { model: string }[] = [];
        for (const value of rows) {
          if (value.event === 'init') { started++; const first = init.parse(value); model = first.init.model; if (conversationId.test(first.conversation_id)) conversation = first.conversation_id; }
          else if (value.event === 'step_update') { const done = step.parse(value).step_update; if (done.state === 'DONE' && done.step_type === 'tool') actions.push({ model: job.model }); }
          else if (value.event === 'result') { finished++; const last = result.parse(value).result; if (last.status !== 'SUCCESS') throw harnessUnavailable(); text = last.response?.trim(); }
        }
        // One start on the model asked for, one successful result last, and words in it: anything else is not a reply.
        if (started !== 1 || finished !== 1 || rows.at(-1)?.event !== 'result' || model !== job.model || !text) throw harnessUnavailable();
        return { text, model, actions, usage:agyUsage(rows) };
      } catch(error){onFailedOutput?.(output);throw error;} finally { output.fill(0); }
    } catch { throw harnessUnavailable(); }
    finally {
      head = '';
      if (workspace) try { rmSync(workspace, { recursive: true, force: true }); } catch { /* the worker removes the scratch directory around it */ }
      if (conversation) forget(input.env.HOME, conversation);
      // A run that ended before its output could be read may still have named its conversation.
      else if (scratch) agyLeftovers(scratch, input.env);
    }
  };
};
export const agy: Harness = { needsFullReach: true, honoursDeniedTools: false, reservesEnv: name => /^(?:GEMINI_|GOOGLE_|GCLOUD_|ANTIGRAVITY_)/.test(name),
  run: agyBody, leftovers: agyLeftovers };
