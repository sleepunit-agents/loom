import {EventEmitter} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { agyBody, agyLeftovers } from './agy-body.js';
import { bodyHarness } from './body-harnesses.js';
import type { HarnessSpawn } from './body-harness.js';
import type { WorkerAssignment } from './worker.js';
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'gemini-fictional', account: 'sub', harness: 'agy', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
  run: { nestedContainers: false, gpu: false, ports: [], policy: { word: 'owners', people: [], deniedTools: [] } } };
const bearer = 'Bearer local_secret_' + 'cd'.repeat(32), id = '11111111-2222-4333-8444-555555555555';
const good = () => [{ event: 'init', conversation_id: id, init: { cwd: '/x', tools: [], permission_mode: 'always-proceed', model: 'gemini-fictional' } },
  { event: 'step_update', step_update: { state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool' } },
  { event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool' } },
  { event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: '\n' } },
  { event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Answer é\n', usage: { input_tokens: 1 } } }];
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(input: Partial<Parameters<typeof agyBody>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-test-home-')); homes.push(home);
  const data = join(home, '.gemini', 'antigravity-cli'); mkdirSync(join(data, 'brain', id), { recursive: true }); mkdirSync(join(data, 'conversations'));
  writeFileSync(join(data, 'brain', id, 'transcript.jsonl'), 'PRIVATE'); writeFileSync(join(data, 'conversations', id + '.db'), 'PRIVATE'); writeFileSync(join(data, 'antigravity-oauth-token'), 'KEEP');
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  let words = ''; child.stdin.on('data', data => { words += data; });
  const seen: { workspace?: string; config?: string; mode?: number } = {};
  const launch = vi.fn<HarnessSpawn>((_command, _args, options) => {
    seen.workspace = options.cwd; const file = join(options.cwd, '.agents', 'mcp_config.json');
    if (existsSync(file)) { seen.config = readFileSync(file, 'utf8'); seen.mode = statSync(file).mode & 0o777; }
    return child as unknown as ChildProcessWithoutNullStreams;
  }), abort = new AbortController();
  const config = Buffer.from(JSON.stringify({ mcpServers: { loom: { type: 'http', url: 'http://127.0.0.1:4242', headers: { Authorization: bearer } } } }));
  const scratch = mkdtempSync(join(tmpdir(), 'agy-test-scratch-')); homes.push(scratch);
  const run = bodyHarness('agy', { command: '/native/agy', cwd: '/house', env: { PATH: '/usr/bin', HOME: home, LOOM_BODY_SCRATCH: scratch }, spawn: launch, reach: 'all', mcpConfig: config, mcpTools: ['mcp__loom__recall', 'mcp__loom__reply'], ...input });
  config.fill(0);
  const finish = (rows: unknown[] | string, code = 0) => { child.stdout.end(typeof rows === 'string' ? rows : rows.map(value => JSON.stringify(value)).join('\n') + '\n'); child.stderr.end('PRIVATE DIAGNOSTIC'); setImmediate(() => { child.emit('exit', code); child.emit('close', code); }); };
  return { run, launch, abort, finish, words: () => words, child, seen, data, home, scratch };
}

it('runs agy in a private workspace that holds the tools file, with the words only on stdin, and leaves nothing behind', async () => {
  const f = fixture(), result = f.run(job, 'PRIVATE ACCEPTED MAIL', f.abort.signal);
  const [command, args, options] = f.launch.mock.calls[0];
  expect(command).toBe('/native/agy');
  expect(args).toEqual(['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-fictional', '--dangerously-skip-permissions', '--add-dir', '/house']);
  expect(options.cwd.startsWith(f.scratch + '/')).toBe(true); expect(options.env).toEqual({ PATH: '/usr/bin', HOME: f.home, LOOM_BODY_SCRATCH: f.scratch });
  expect(JSON.parse(f.seen.config!)).toEqual({ mcpServers: { loom: { serverUrl: 'http://127.0.0.1:4242', headers: { Authorization: bearer }, enabledTools: ['recall', 'reply'] } } });
  expect(f.seen.mode).toBe(0o600); expect(statSync(f.seen.workspace!).mode & 0o777).toBe(0o700);
  expect(JSON.stringify(f.launch.mock.calls)).not.toContain('PRIVATE ACCEPTED MAIL'); expect(JSON.stringify(f.launch.mock.calls)).not.toContain('local_secret_');
  f.finish(good());
  expect(await result).toMatchObject({ text: 'Answer é', model: 'gemini-fictional', actions: [{ model: 'gemini-fictional' }] });
  expect(JSON.parse(f.words())).toEqual({ event: 'user', message: { content: 'PRIVATE ACCEPTED MAIL' } });
  // The workspace with the bearer is gone, and so is what agy saved for this conversation; its sign-in is untouched.
  expect(existsSync(f.seen.workspace!)).toBe(false); expect(existsSync(join(f.data, 'brain', id))).toBe(false); expect(existsSync(join(f.data, 'conversations', id + '.db'))).toBe(false);
  expect(readFileSync(join(f.data, 'antigravity-oauth-token'), 'utf8')).toBe('KEEP');
});
it.each(['failed result', 'another model', 'no model named', 'no result', 'two results', 'no words', 'steps after the result', 'invalid json', 'non-zero exit'] as const)('refuses %s without a guessed reply, and still removes the workspace', async mode => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal), rows: any[] = good();
  if (mode === 'failed result') Object.assign(rows.at(-1).result, { status: 'ERROR', error: 'PRIVATE' });
  if (mode === 'another model') rows[0].init.model = 'gemini-other';
  if (mode === 'no model named') delete rows[0].init.model;
  if (mode === 'no result') rows.pop();
  if (mode === 'two results') rows.push(structuredClone(rows.at(-1)));
  if (mode === 'no words') rows.at(-1).result.response = ' \n';
  if (mode === 'steps after the result') rows.push({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response' } });
  f.finish(mode === 'invalid json' ? '{not json\n' : rows, mode === 'non-zero exit' ? 1 : 0);
  await expect(result).rejects.toThrow(/^Native execution unavailable$/); expect(existsSync(f.seen.workspace!)).toBe(false);
});
it('does not start without full reach, with tools it cannot deny, or for another harness', async () => {
  for (const [input, changed] of [[{ reach: 'loom' as const }, job], [{}, { ...job, harness: 'codex' }],
    [{}, { ...job, run: { ...job.run!, policy: { word: 'owners', people: [], deniedTools: [{ pattern: 'Bash(*)', guestsOnly: false }] } } }]] as const) {
    const f = fixture(input); await expect(f.run(changed, 'mail', f.abort.signal)).rejects.toThrow('Native execution unavailable'); expect(f.launch).not.toHaveBeenCalled();
  }
  expect(() => fixture({ mcpTools: ['Bash'] })).toThrow('Native execution unavailable');
});

it('keeps the tools file inside the scratch directory the worker gave the body, and notes the conversation there for a body that is killed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agy-test-scratch-')); homes.push(scratch);
  const f = fixture(); const run = agyBody({ command: '/native/agy', cwd: '/house', env: { PATH: '/usr/bin', HOME: f.home, LOOM_BODY_SCRATCH: scratch }, spawn: f.launch, reach: 'all' });
  const result = run(job, 'mail', f.abort.signal);
  expect(f.seen.workspace!.startsWith(scratch + '/')).toBe(true);
  // agy has named its conversation and is still working when the worker kills the whole group: nothing of the body's own cleanup runs.
  f.child.stdout.write(JSON.stringify(good()[0]) + '\n'); await new Promise(resolve => setImmediate(resolve));
  expect(readFileSync(join(scratch, 'agy-conversation'), 'utf8')).toBe(id);
  expect(existsSync(join(f.data, 'brain', id))).toBe(true);
  // What the worker then does with the scratch directory, before removing it.
  agyLeftovers(scratch, { HOME: f.home });
  expect(existsSync(join(f.data, 'brain', id))).toBe(false); expect(existsSync(join(f.data, 'conversations', id + '.db'))).toBe(false);
  expect(readFileSync(join(f.data, 'antigravity-oauth-token'), 'utf8')).toBe('KEEP');
  f.abort.abort(); f.child.emit('close', null); await expect(result).rejects.toThrow('Native execution unavailable');
});
it('never writes the tools file outside a scratch directory the worker named', async () => {
  const f = fixture({ env: { PATH: '/usr/bin', HOME: '/home/fictional' } });
  await expect(f.run(job, 'mail', f.abort.signal)).rejects.toThrow('Native execution unavailable');
  expect(f.launch).not.toHaveBeenCalled();
});
it('forgets only a well-formed conversation id from the note, never a path', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agy-test-scratch-')); homes.push(scratch);
  const f = fixture();
  writeFileSync(join(scratch, 'agy-conversation'), '../../antigravity-oauth-token');
  agyLeftovers(scratch, { HOME: f.home });
  expect(readFileSync(join(f.data, 'antigravity-oauth-token'), 'utf8')).toBe('KEEP'); expect(existsSync(join(f.data, 'brain', id))).toBe(true);
  agyLeftovers(join(scratch, 'missing'), { HOME: f.home });
});

it('reports the end counters and the names of completed tool steps',async()=>{
 const f=fixture(),answer=f.run(job,'mail',f.abort.signal);
 f.finish(good());
 expect(await answer).toMatchObject({usage:{source:'report',tokensIn:1,tokensOut:null,toolCalls:1,tools:{call_mcp_tool:1}}});
});

it('retains explicit zero counters from the authentication error seen on agy 1.5.11',async()=>{
 const failedUsage=vi.fn(), f=fixture({failedUsage});
 const answer=f.run(job,'mail',f.abort.signal);
 f.finish([JSON.parse(readFileSync(new URL('../../test/fixtures/usage/agy-error.json',import.meta.url),'utf8'))],1);
 await expect(answer).rejects.toThrow('Native execution unavailable');
 expect(failedUsage).toHaveBeenCalledWith(expect.objectContaining({source:'report',tokensIn:0,tokensOut:0,cacheRead:0,cacheWritten:null,modelCalls:null}));
});
