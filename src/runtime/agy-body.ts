/** Gemini as a body's harness, through the Antigravity CLI: `agy -p` with stream-json in and out.
 *
 * What differs from the others, and why:
 * - agy reads its tool servers only from a file in its workspace. Each body therefore gets its own private
 *   temporary workspace holding `.agents/mcp_config.json`, and the directory the machine names for bodies is
 *   added to it with --add-dir. The file holds the short-lived bearer of this body's own loopback tools
 *   server; the workspace is private to this user and removed when the body ends.
 * - The words go in on stdin as one stream-json line, so they are in no argument.
 * - agy has no switch to leave a conversation unsaved. What it wrote for this conversation is removed
 *   afterwards, as far as its files are known; that is best effort, not a promise.
 * - Like Codex it always has its shell, so it runs only where the machine gives bodies full reach, and not
 *   for a body with denied tools. (agy has allow and deny rules of its own; honouring loom's with them is
 *   not done yet.)
 * - The model is the one agy reports it started with, which must be the one the job asked for.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BODY_INPUT_BYTES } from './body-input-limit.js';
import { harnessModel, harnessTools, harnessUnavailable, runHarnessChild, type BodyHarness } from './body-harness.js';

const toolName = /^mcp__loom_secrets__([a-zA-Z][a-zA-Z0-9_-]{0,63})$/;
const conversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const row = z.object({ event: z.string() }).passthrough();
const init = z.object({ conversation_id: z.string(), init: z.object({ model: z.string().optional() }).passthrough() }).passthrough();
const step = z.object({ step_update: z.object({ state: z.string(), step_type: z.string() }).passthrough() }).passthrough();
const result = z.object({ result: z.object({ status: z.string(), response: z.string().optional() }).passthrough() }).passthrough();

export const agyBody: BodyHarness = input => {
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(input.env), ...Object.values(input.env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw harnessUnavailable();
  const tools = harnessTools(input.mcpConfig);
  const names = (input.mcpTools ?? []).map(name => toolName.exec(name)?.[1]);
  if (input.mcpTools && !tools || names.length > 34 || new Set(names).size !== names.length || names.some(name => !name)) throw harnessUnavailable();
  let used = false;
  return async (job, words, signal) => {
    if (tools && used) throw harnessUnavailable(); used = true;
    if (signal.aborted || job.harness !== 'agy' || !harnessModel.test(job.model) || input.reach !== 'all'
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES) throw harnessUnavailable();
    const guest = job.run?.policy?.people.some(person => person.kind !== 'person' && person.tier !== 3) ?? false;
    if ((job.run?.policy?.deniedTools ?? []).some(rule => !rule.guestsOnly || guest)) throw harnessUnavailable();
    let workspace: string | undefined, conversation: string | undefined;
    try {
      workspace = mkdtempSync(join(tmpdir(), 'loom-body-'));
      if (tools) {
        mkdirSync(join(workspace, '.agents'), { mode: 0o700 });
        writeFileSync(join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { loom_secrets: {
          serverUrl: tools.url, headers: { Authorization: tools.authorization }, enabledTools: names } } }), { mode: 0o600 });
      }
      const args = ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', job.model,
        '--dangerously-skip-permissions', '--add-dir', input.cwd];
      const line = JSON.stringify({ event: 'user', message: { content: words } }) + '\n';
      const output = await runHarnessChild({ command: input.command, args, cwd: workspace, env: input.env, words: line, signal, spawn: input.spawn });
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
        return { text, model, actions };
      } finally { output.fill(0); }
    } catch { throw harnessUnavailable(); }
    finally {
      if (workspace) try { rmSync(workspace, { recursive: true, force: true }); } catch { /* the bearer in it is already dead */ }
      const home = input.env.HOME;
      if (conversation && home) for (const left of [join('brain', conversation), join('conversations', conversation + '.db')])
        try { rmSync(join(home, '.gemini', 'antigravity-cli', left), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
};
