/** Codex as a body's harness: `codex exec --json`, isolated from the machine's own Codex settings.
 *
 * What differs from Claude, and why:
 * - The tools endpoint's bearer goes to Codex in one environment variable of the child, because Codex takes
 *   a server's bearer only by variable name. It is the short-lived token of this body's own tools server on
 *   loopback, never a loom credential, and it is in no argument. Codex is told to leave the variable out of
 *   the environment of the commands its shell runs. A process of this user can still read it from the
 *   Codex process itself while the body lives; it opens nothing the model's own tools do not
 *   (docs/accepted-tradeoffs.md, "The body-tools bearer is readable by the body's own user").
 * - Codex always has its shell. There is no "loom's tools only", so a machine that has not given bodies full
 *   reach cannot run a Codex body, and a body with denied tools cannot either: Codex has no way to honour them.
 * - Codex's events do not name the model that answered. The reply carries the model the job asked for.
 */
import { z } from 'zod';
import { BODY_INPUT_BYTES } from './body-input-limit.js';
import { BODY_TOOLS_SERVER, harnessModel, harnessToolNames, harnessTools, harnessUnavailable, runHarnessChild, type BodyHarness, type Harness } from './body-harness.js';

const tokenVariable = 'LOOM_BODY_TOOLS_TOKEN';
const event = z.object({ type: z.string() }).passthrough();
const item = z.object({ type: z.string(), text: z.string().optional(), status: z.string().optional() }).passthrough();
const quote = (value: string) => JSON.stringify(value);

export const codexBody: BodyHarness = input => {
  if (!input.command || !input.cwd || [input.command, input.cwd, ...Object.keys(input.env), ...Object.values(input.env).filter((v): v is string => v !== undefined)].some(v => v.includes('\0'))) throw harnessUnavailable();
  const tools = harnessTools(input.mcpConfig);
  if (input.mcpTools && !tools) throw harnessUnavailable();
  const names = harnessToolNames(input.mcpTools ?? []);
  let used = false;
  return async (job, words, signal) => {
    if (tools && used) throw harnessUnavailable(); used = true;
    if (signal.aborted || !harnessModel.test(job.model)
      || !words.trim() || words.includes('\0') || Buffer.byteLength(words) > BODY_INPUT_BYTES) throw harnessUnavailable();
    const server = `mcp_servers.${BODY_TOOLS_SERVER}.`;
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', '-m', job.model, '-C', input.cwd,
      ...(tools ? ['-c', `${server}url=${quote(tools.url)}`, '-c', `${server}bearer_token_env_var=${quote(tokenVariable)}`,
        '-c', `${server}default_tools_approval_mode="approve"`, '-c', `${server}enabled_tools=[${names.map(name => quote(name)).join(',')}]`,
        '-c', `${server}tool_timeout_sec=86400`, '-c', `shell_environment_policy.exclude=[${quote(tokenVariable)}]`] : []),
      '-'];
    const env = { ...input.env, ...(tools ? { [tokenVariable]: tools.authorization.slice('Bearer '.length) } : {}) };
    const output = await runHarnessChild({ command: input.command, args, cwd: input.cwd, env, words, signal, spawn: input.spawn });
    try {
      const rows = new TextDecoder('utf-8', { fatal: true }).decode(output).split(/\r?\n/).filter(line => line.trim()).map(line => event.parse(JSON.parse(line)));
      let started = 0, completed = 0, last: string | undefined;
      const actions: { model: string }[] = [];
      for (const row of rows) {
        if (row.type === 'thread.started') started++;
        else if (row.type === 'turn.completed') completed++;
        else if (row.type === 'turn.failed' || row.type === 'error') throw harnessUnavailable();
        else if (row.type === 'item.completed') {
          const done = item.parse(row.item);
          if (done.type === 'agent_message') { if (done.text) last = done.text; }
          else if (done.type !== 'reasoning') actions.push({ model: job.model });
        }
      }
      // One thread, one finished turn, and words after it: anything else is not a reply.
      if (started !== 1 || completed !== 1 || rows.at(-1)?.type !== 'turn.completed' || !last) throw harnessUnavailable();
      return { text: last, model: job.model, actions };
    } catch { throw harnessUnavailable(); }
    finally { output.fill(0); }
  };
};
export const codex: Harness = { needsFullReach: true, honoursDeniedTools: false, reservesEnv: name => /^(?:CODEX_|OPENAI_)/.test(name), run: codexBody };
