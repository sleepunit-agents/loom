import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { HarnessFailed, HarnessResumeUnavailable, type HarnessEnd, type HarnessSpawn } from './body-harness.js';
import { bodyHarness } from './body-harnesses.js';
import { claudeFailure, codexFailure, exitFailure, FAILURE_SAID_MAX, streamRows } from './harness-failure.js';
import { jobFailure } from './job-failure.js';
import {nativeClaudeFixture} from '../../test/fixtures/native-claude.js';
import type { WorkerAssignment } from './worker.js';

const PRIVATE = 'PRIVATE WORDS OF THE CONVERSATION';
const exit = (over: Partial<HarnessEnd> = {}): HarnessEnd => ({ exitCode: 1, signal: null, aborted: false, stderr: '', ...over });
const why = (error: Error) => { expect(error).toBeInstanceOf(HarnessFailed); expect(error.message).toBe('Native execution unavailable'); return (error as HarnessFailed).why; };
const assistant = (over: Record<string, unknown>) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: PRIVATE }] }, ...over });
const result = (over: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: true, result: PRIVATE, ...over });
const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_795_914_000, rateLimitType: 'five_hour' } };

it.each([
  ['a used-up window, with when it resets', [rejected, assistant({ error: 'rate_limit', api_error_status: 429 }), result({ api_error_status: 429 })], exit(), { reason: 'usage-limit', resetsAt: '2026-11-29T01:00:00.000Z' }],
  ['a used-up window the API named', [assistant({ error: 'invalid_request', api_error: 'usage_limit_reached' })], exit(), { reason: 'usage-limit' }],
  ['a window that was rejected and then allowed again', [rejected, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, assistant({ error: 'rate_limit', api_error_status: 429 })], exit(), { reason: 'rate-limited', status: 429 }],
  ['too many requests', [result({ api_error_status: 429 })], exit(), { reason: 'rate-limited', status: 429 }],
  ['an overloaded provider', [assistant({ error: 'overloaded', api_error_status: 529 }), result({ api_error_status: 529 })], exit(), { reason: 'overloaded', status: 529 }],
  ['a server error', [assistant({ error: 'server_error', api_error_status: 500 })], exit(), { reason: 'api-error', status: 500 }],
  ['an API error with no status', [assistant({ error: 'unknown' })], exit(), { reason: 'api-error' }],
  ['a conversation too large for the context', [assistant({ error: 'invalid_request', api_error_status: 400, api_error: 'message_over_context_limit' })], exit(), { reason: 'context-too-large' }],
  ['a prompt too long, said by the result', [result({ terminal_reason: 'prompt_too_long' })], exit(), { reason: 'context-too-large' }],
  ['the limit of turns', [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (40)'] }], exit(), { reason: 'max-turns' }],
  ['a sign-in that is gone', [assistant({ error: 'authentication_failed', api_error_status: 401 })], exit(), { reason: 'sign-in-needed', status: 401 }],
  ['an account on hold', [assistant({ error: 'account_on_hold' })], exit(), { reason: 'sign-in-needed' }],
  ['an answer that stopped arriving', [assistant({ error: 'unknown', api_error: 'stream_idle_timeout' })], exit(), { reason: 'timed-out', limit: 'stream-idle' }],
  ['retries that ran out', [{ type: 'system', subtype: 'api_retry', attempt: 9, error_status: 529, error: 'overloaded' }], exit(), { reason: 'overloaded', status: 529 }],
  ['more output than the body reads', [], exit({ exitCode: null, cut: 'output' }), { reason: 'output-limit' }],
  ['output left open after it ended', [], exit({ exitCode: 0, cut: 'pipes' }), { reason: 'timed-out', limit: 'output-close' }],
  ['a signal', [], exit({ exitCode: null, signal: 'SIGKILL' }), { reason: 'killed', signal: 'SIGKILL' }],
  ['a signal with no name loom says', [], exit({ exitCode: null, signal: 'SIGUSR2' }), { reason: 'killed' }],
  ['a signal as a shell reports it', [], exit({ exitCode: 143 }), { reason: 'killed', signal: 'SIGTERM' }],
  ['an error of its own', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [PRIVATE] }], exit({ exitCode: 1 }), { reason: 'harness-crashed', exitCode: 1 }],
  ['nothing readable', [{ type: 'system', subtype: 'init' }], exit({ exitCode: 0 }), { reason: 'unknown' }],
] as const)('reads a Claude Code failure as %s', (_name, rows, end, expected) => {
  const error = claudeFailure(rows, end), found = why(error);
  expect(found).toEqual(expected);
  // A reason is one of the fixed set with bounded detail, and holds nothing the harness printed.
  expect(jobFailure.safeParse(found).success).toBe(true);
  expect(JSON.stringify(found)).not.toContain('PRIVATE');
});

it('keeps what the harness last said apart from the reason, cut to a bounded length', () => {
  const error = claudeFailure([assistant({ error: 'overloaded', api_error_status: 529 }), result({ result: 'API Error: 529 ' + PRIVATE, api_error_status: 529 })], exit({ stderr: 'last diagnostic line' })) as HarnessFailed;
  expect(error.said).toBe('API Error: 529 ' + PRIVATE + '\nlast diagnostic line');
  expect(error.message).not.toContain('PRIVATE'); expect(JSON.stringify(error.why)).not.toContain('PRIVATE');
  const long = claudeFailure([result({ result: 'x'.repeat(FAILURE_SAID_MAX * 2) })], exit()) as HarnessFailed;
  expect(long.said).toHaveLength(FAILURE_SAID_MAX + '\n[Cut]'.length);
  expect((claudeFailure([], exit({ exitCode: 3 })) as HarnessFailed).said).toBeUndefined();
});
it('says nothing of a run the body itself was told to stop', () => {
  for (const error of [claudeFailure([result({ api_error_status: 529 })], exit({ aborted: true })), codexFailure([], exit({ aborted: true })), exitFailure(exit({ aborted: true }))]) {
    expect(error).not.toBeInstanceOf(HarnessFailed); expect(error.message).toBe('Native execution unavailable');
  }
});
it('reads only whole events out of a stream cut anywhere', () => {
  expect(streamRows(Buffer.from('{"type":"a"}\nnot json\n\n{"type":"b"}\n{"type":"c"'))).toEqual([{ type: 'a' }, { type: 'b' }]);
});

it.each([
  ['a used-up window', { type: 'error', message: `You've hit your usage limit. ${PRIVATE}` }, 1, { reason: 'usage-limit' }],
  ['a context that is full', { type: 'turn.failed', error: { message: 'Your input exceeds the context window of this model.' } }, 1, { reason: 'context-too-large' }],
  ['too many requests', { type: 'error', message: 'exceeded retry limit, last status: 429 Too Many Requests' }, 1, { reason: 'rate-limited', status: 429 }],
  ['a refused sign-in', { type: 'error', message: 'unexpected status 401 Unauthorized: ' + PRIVATE }, 1, { reason: 'sign-in-needed', status: 401 }],
  ['a server error', { type: 'turn.failed', error: { message: 'unexpected status 503 Service Unavailable' } }, 1, { reason: 'api-error', status: 503 }],
  ['a stream that broke', { type: 'error', message: 'stream disconnected before completion' }, 1, { reason: 'timed-out', limit: 'stream-idle' }],
  ['an error it gave no reason for', { type: 'error', message: PRIVATE }, 1, { reason: 'harness-crashed', exitCode: 1 }],
  ['an error it gave no reason for, having ended well', { type: 'turn.failed', error: { message: PRIVATE } }, 0, { reason: 'unknown' }],
] as const)('reads a Codex failure as %s', (_name, row, exitCode, expected) => {
  const error = codexFailure([{ type: 'thread.started' }, row], exit({ exitCode })), found = why(error);
  expect(found).toEqual(expected);
  expect(jobFailure.safeParse(found).success).toBe(true); expect(JSON.stringify(found)).not.toContain('PRIVATE');
  expect((error as HarnessFailed).said).toContain('message' in row ? row.message : row.error.message);
});

const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'requested-model', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
  run: { nestedContainers: false, gpu: false, ports: [], policy: { word: 'owners', people: [], deniedTools: [] } } };
it('gives a failed Claude Code run its reason from the recorded stream, the process and its diagnostics', async () => {
  const f = nativeClaudeFixture(), run = f.run(job, 'mail', f.abort.signal), id = f.launch.mock.calls[0][1][f.launch.mock.calls[0][1].indexOf('--session-id') + 1];
  const rows = [{ type: 'system', subtype: 'init', session_id: id }, { session_id: id, ...rejected },
    { session_id: id, ...assistant({ error: 'rate_limit', api_error_status: 429 }) }, { session_id: id, ...result({ api_error_status: 429 }) }];
  (f.child.stdout as PassThrough).write(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); (f.child.stderr as PassThrough).write('diagnostic ' + PRIVATE);
  await new Promise(resolve => setImmediate(resolve)); f.child.emit('close', 1, null);
  const error = await run.then(() => undefined, (caught: unknown) => caught) as HarnessFailed;
  expect(why(error)).toEqual({ reason: 'usage-limit', resetsAt: '2026-11-29T01:00:00.000Z' });
  expect(error.said).toBe(PRIVATE + '\ndiagnostic ' + PRIVATE);
});
it('gives a Claude Code run that ended well with an error of its own a reason too', async () => {
  const f = nativeClaudeFixture(), run = f.run(job, 'mail', f.abort.signal), id = f.launch.mock.calls[0][1][f.launch.mock.calls[0][1].indexOf('--session-id') + 1];
  f.finish([{ type: 'system', subtype: 'init', session_id: id }, { session_id: id, ...assistant({ error: 'overloaded', api_error_status: 529 }) }, { session_id: id, ...result({ api_error_status: 529 }) }]);
  expect(why(await run.then(() => new Error('answered'), (caught: Error) => caught))).toEqual({ reason: 'overloaded', status: 529 });
});
it('ends a run that prints more than the body reads and says that is why', async () => {
  const f = nativeClaudeFixture(), run = f.run(job, 'mail', f.abort.signal);
  (f.child.stdout as PassThrough).write(Buffer.alloc(1_048_577, 0x20));
  const error = await run.then(() => new Error('answered'), (caught: Error) => caught);
  expect(why(error)).toEqual({ reason: 'output-limit' }); expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('says a signal ended a run, and still says a session could not be continued when that is what happened', async () => {
  const f = nativeClaudeFixture(), run = f.run(job, 'mail', f.abort.signal);
  f.child.emit('close', null, 'SIGKILL');
  expect(why(await run.then(() => new Error('answered'), (caught: Error) => caught))).toEqual({ reason: 'killed', signal: 'SIGKILL' });
  const resumed = nativeClaudeFixture(), again = resumed.run(job, 'mail', resumed.abort.signal, { resume: 'earlier-session-1' });
  resumed.child.emit('close', 1, null);
  await expect(again).rejects.toBeInstanceOf(HarnessResumeUnavailable);
});
it('gives a failed Codex run its reason from its error event', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const launch = vi.fn<HarnessSpawn>(() => child as unknown as ChildProcessWithoutNullStreams);
  const run = bodyHarness('codex', { command: '/native/codex', cwd: '/house', env: { PATH: '/usr/bin' }, spawn: launch, reach: 'all' })({ ...job, harness: 'codex' }, 'mail', new AbortController().signal);
  child.stdout.end([{ type: 'thread.started', thread_id: 't' }, { type: 'error', message: `You've hit your usage limit. ${PRIVATE}` }].map(row => JSON.stringify(row)).join('\n') + '\n');
  child.stderr.end('diagnostic'); setImmediate(() => { child.emit('exit', 1, null); child.emit('close', 1, null); });
  const error = await run.then(() => new Error('answered'), (caught: Error) => caught) as HarnessFailed;
  expect(why(error)).toEqual({ reason: 'usage-limit' }); expect(error.said).toContain(PRIVATE);
});
