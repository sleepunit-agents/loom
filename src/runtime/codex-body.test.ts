import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { codexBody } from './codex-body.js';
import { bodyHarness } from './body-harnesses.js';
import { HarnessResumeUnavailable, type HarnessSpawn } from './body-harness.js';
import type { WorkerAssignment } from './worker.js';
import { bodyNamedToolNames } from './body-named-tools.js';
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'gpt-fictional', account: 'sub', harness: 'codex', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
  run: { nestedContainers: false, gpu: false, ports: [], policy: { word: 'owners', people: [], deniedTools: [] } } };
const bearer = 'Bearer local_secret_' + 'ab'.repeat(32);
const toolsFile = () => Buffer.from(JSON.stringify({ mcpServers: { loom: { type: 'http', url: 'http://127.0.0.1:4242', headers: { Authorization: bearer }, timeout: 1 } } }));
const good = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I will look.' } },
  { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking' } },
  { type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'loom', tool: 'recall', status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Answer é' } },
  { type: 'turn.completed', usage: { input_tokens: 1 } }];
function fixture(input: Partial<Parameters<typeof codexBody>[0]> = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  let words = ''; child.stdin.on('data', data => { words += data; });
  const launch = vi.fn<HarnessSpawn>(() => child as unknown as ChildProcessWithoutNullStreams), abort = new AbortController();
  const config = toolsFile();
  const run = bodyHarness('codex', { command: '/native/codex', cwd: '/house', env: { PATH: '/usr/bin', HOME: '/home/fictional' }, spawn: launch, reach: 'all', mcpConfig: config, mcpTools: ['mcp__loom__recall', 'mcp__loom__reply'], ...input });
  config.fill(0);
  const finish = (rows: unknown[] | string, code = 0) => { child.stdout.end(typeof rows === 'string' ? rows : rows.map(row => JSON.stringify(row)).join('\n') + '\n'); child.stderr.end('PRIVATE DIAGNOSTIC'); setImmediate(() => { child.emit('exit', code); child.emit('close', code); }); };
  return { run, launch, abort, finish, words: () => words, child };
}

it('runs Codex isolated from the machine\'s own settings, with the tools bearer in one variable and the words only on stdin', async () => {
  const f = fixture(), result = f.run(job, 'PRIVATE ACCEPTED MAIL', f.abort.signal);
  const [command, args, options] = f.launch.mock.calls[0];
  expect(command).toBe('/native/codex');
  expect(args.slice(0, 7)).toEqual(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
  expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 4)).toEqual(['-m', 'gpt-fictional', '-C', '/house']);
  expect(args).toContain('mcp_servers.loom.url="http://127.0.0.1:4242"');
  expect(args).toContain('mcp_servers.loom.bearer_token_env_var="LOOM_BODY_TOOLS_TOKEN"');
  // Codex itself holds the bearer for its tools server; the commands its shell runs are not handed it.
  expect(args).toContain('shell_environment_policy.exclude=["LOOM_BODY_TOOLS_TOKEN"]');
  expect(args).toContain('mcp_servers.loom.enabled_tools=["recall","reply"]');
  expect(args).toContain('mcp_servers.loom.default_tools_approval_mode="approve"');
  expect(args.at(-1)).toBe('-');
  expect(JSON.stringify(args)).not.toContain('local_secret_'); expect(JSON.stringify(f.launch.mock.calls)).not.toContain('PRIVATE ACCEPTED MAIL');
  expect(options).toEqual({ cwd: '/house', env: { PATH: '/usr/bin', HOME: '/home/fictional', LOOM_BODY_TOOLS_TOKEN: 'local_secret_' + 'ab'.repeat(32) }, shell: false, detached: false, stdio: 'pipe' });
  f.finish(good);
  // The last words are the reply; the model is the one asked for, since Codex names none; one tool call is one action.
  expect(await result).toMatchObject({ text: 'Answer é', model: 'gpt-fictional', actions: [{ model: 'gpt-fictional' }] });
  expect(f.words()).toBe('PRIVATE ACCEPTED MAIL');
  await expect(f.run(job, 'again', f.abort.signal)).rejects.toThrow('Native execution unavailable');
});
it.each(['failed turn', 'error event', 'no final turn', 'two threads', 'no words', 'words before the turn ended only', 'invalid json', 'non-zero exit'] as const)('refuses %s without a guessed reply', async mode => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal), rows: unknown[] = structuredClone(good);
  if (mode === 'failed turn') rows.splice(-1, 1, { type: 'turn.failed', error: { message: 'PRIVATE' } });
  if (mode === 'error event') rows.splice(2, 0, { type: 'error', message: 'PRIVATE' });
  if (mode === 'no final turn') rows.pop();
  if (mode === 'two threads') rows.unshift({ type: 'thread.started', thread_id: 'other' });
  if (mode === 'no words') { rows.splice(5, 1); rows.splice(2, 1); }
  if (mode === 'words before the turn ended only') rows.push({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'late' } });
  f.finish(mode === 'invalid json' ? '{not json\n' : rows, mode === 'non-zero exit' ? 1 : 0);
  await expect(result).rejects.toThrow(/^Native execution unavailable$/);
});
it('does not start without full reach, with tools it cannot deny, for another harness, or with a malformed tools file', async () => {
  for (const [input, changed] of [[{ reach: 'loom' as const }, job], [{ reach: undefined }, job], [{}, { ...job, harness: 'claude' }],
    [{}, { ...job, run: { ...job.run!, policy: { word: 'owners', people: [], deniedTools: [{ pattern: 'Bash(*)', guestsOnly: false }] } } }]] as const) {
    const f = fixture(input); await expect(f.run(changed, 'mail', f.abort.signal)).rejects.toThrow('Native execution unavailable'); expect(f.launch).not.toHaveBeenCalled();
  }
  // A denial that only applies to guests does not stop a body with no guests in the room.
  const f = fixture(), result = f.run({ ...job, run: { ...job.run!, policy: { word: 'owners', people: [], deniedTools: [{ pattern: 'Bash(*)', guestsOnly: true }] } } }, 'mail', f.abort.signal); f.finish(good); await result;
  expect(() => fixture({ mcpConfig: Buffer.from('{"mcpServers":{"loom":{"url":"https://elsewhere.example","headers":{"Authorization":"' + bearer + '"}}}}') })).toThrow('Native execution unavailable');
  expect(() => fixture({ mcpTools: ['Bash'] })).toThrow('Native execution unavailable');
  expect(() => fixture({ mcpConfig: undefined })).toThrow('Native execution unavailable');
});
it('stops the child and answers nothing when the body is told to stop', async () => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal); f.abort.abort();
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL'); setImmediate(() => f.child.emit('close', null));
  await expect(result).rejects.toThrow('Native execution unavailable');
});

it('is given every tool a body serves, the named ones too, by Codex\'s own list of enabled tools', async () => {
  const served = ['request_secret', 'use_secret', 'loom_commands', 'loom_command', 'loom_query', ...bodyNamedToolNames()];
  const f = fixture({ mcpTools: served.map(name => 'mcp__loom__' + name) }), result = f.run(job, 'mail', f.abort.signal);
  const args = f.launch.mock.calls[0][1];
  expect(args).toContain('mcp_servers.loom.enabled_tools=[' + served.map(name => JSON.stringify(name)).join(',') + ']');
  expect(served).toEqual(expect.arrayContaining(['remember', 'task_claim', 'note_read']));
  f.finish(good); await result;
});

it('keeps bounded usage from an unsuccessful process without accepting its reply',async()=>{
 const failedUsage=vi.fn(),f=fixture({failedUsage});
 const answer=f.run(job,'mail',f.abort.signal);
 f.finish(good,1);
 await expect(answer).rejects.toThrow('Native execution unavailable');
 expect(failedUsage).toHaveBeenCalledWith(expect.objectContaining({source:'report',tokensIn:1,tools:{recall:1}}));
 expect(JSON.stringify(failedUsage.mock.calls)).not.toContain('Answer é');
});

it('keeps a completed command in a failed turn without inventing token totals',async()=>{
 const failedUsage=vi.fn(),f=fixture({failedUsage});
 const answer=f.run(job,'mail',f.abort.signal);
 f.finish([{type:'thread.started'},{type:'turn.started'},
  {type:'item.completed',item:{type:'command_execution',id:'i',command:'private command'}},
  {type:'turn.failed',error:{message:'private error'}}],1);
 await expect(answer).rejects.toThrow('Native execution unavailable');
 expect(failedUsage).toHaveBeenCalledWith(expect.objectContaining({source:'transcript',tokensIn:null,toolCalls:1,tools:{command_execution:1}}));
 expect(JSON.stringify(failedUsage.mock.calls)).not.toContain('private');
});

it('leaves tool counts unknown when a failed stream contains only an assistant message',async()=>{
 const failedUsage=vi.fn(),f=fixture({failedUsage});
 const answer=f.run(job,'mail',f.abort.signal);
 f.finish([{type:'item.completed',item:{type:'agent_message',text:'Hello'}},{type:'turn.failed',usage:{output_tokens:1}}],1);
 await expect(answer).rejects.toThrow('Native execution unavailable');
 expect(failedUsage).toHaveBeenCalledWith(expect.objectContaining({source:'report',tokensOut:1,toolCalls:null,tools:null}));
});

it.each(['abort', 'signal'])('keeps observed usage once on %s even with an interrupted final record', async mode => {
  const failedUsage = vi.fn(), f = fixture({ failedUsage });
  const answer = f.run(job, 'mail', f.abort.signal);
  const chunk = Buffer.from(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'c', command: 'private' } }) + '\n{"partial":"');
  f.child.stdout.write(chunk);
  f.child.stdout.write(Buffer.from([0xc3]));
  if (mode === 'abort') f.abort.abort();
  f.child.emit('close', null, 'SIGTERM');
  await expect(answer).rejects.toThrow('Native execution unavailable');
  expect(chunk.every(byte => byte === 0)).toBe(true);
  expect(failedUsage).toHaveBeenCalledTimes(1);
  expect(failedUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'transcript', toolCalls: 1, tools: { command_execution: 1 } }));
  expect(JSON.stringify(failedUsage.mock.calls)).not.toContain('private');
});

it('starts a kept Codex thread and resumes its exact UUID in the body working directory', async () => {
  const id = '019a9bdd-4e2e-7ade-91ec-4dafbbc44202';
  const rows = [{type:'thread.started',thread_id:id}, ...good.slice(1)];
  for (const session of [{}, {resume:id}]) {
    const f = fixture();
    const result = f.run(job, 'Continue the inspection', f.abort.signal, session);
    const [, args, options] = f.launch.mock.calls[0];
    expect(args).not.toContain('--ephemeral');
    expect(options.cwd).toBe('/house');
    if (session.resume) {
      expect(args.slice(0,2)).toEqual(['exec','resume']);
      expect(args.slice(-2)).toEqual([id,'-']);
      expect(args).not.toContain('-C');
    }
    f.finish(rows);
    expect(await result).toMatchObject({session:id,text:'Answer é'});
  }
});

it('rejects a resumed run that reports a different thread', async () => {
  const f = fixture();
  const result = f.run(job,'Continue',f.abort.signal,{resume:'019a9bdd-4e2e-7ade-91ec-4dafbbc44202'});
  f.finish([{type:'thread.started',thread_id:'019a9bdd-4e2e-7ade-91ec-4dafbbc44203'},...good.slice(1)]);
  await expect(result).rejects.toThrow('Native execution unavailable');
});

it('allows a fresh attempt only when a failed resume emitted no events', async () => {
  const id = '019a9bdd-4e2e-7ade-91ec-4dafbbc44202';
  for (const started of [false,true]) {
    const f = fixture();
    const result = f.run(job,'Continue',f.abort.signal,{resume:id});
    f.finish(started ? [{type:'thread.started',thread_id:id}] : '',1);
    if (started) await expect(result).rejects.not.toBeInstanceOf(HarnessResumeUnavailable);
    else await expect(result).rejects.toBeInstanceOf(HarnessResumeUnavailable);
  }
});
